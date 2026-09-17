#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bake SUPER STRIKER '26 commentary to local audio.

Renders every scripted line from lines.py plus every team name and every player
surname in src/data/teams.json, packs them into a handful of Opus sprite files
and writes public/audio/commentary.json for the runtime to load.

Why sprites and not one file per clip: there are ~1700 clips. 1700 HTTP
requests is silly, and 1700 decoded AudioBuffers is worse. Instead each sprite
is one Opus stream and the manifest records (offset, duration) per clip;
AudioBufferSourceNode.start(when, offset, duration) slices it for free. The
runtime only ever loads the line sprites plus the two teams playing, so a match
pulls about 200 KB of speech.

Usage:
    pipeline/audio/.venv/bin/python pipeline/audio/bake_commentary.py
    ... --backend say        # skip Kokoro, use macOS `say`
    ... --jobs 6             # render workers (default: cpu_count - 2)
    ... --teams bra,mex      # only bake these teams' names (fast iteration)
    ... --force              # ignore the render cache

The bake is idempotent: every (voice, text) pair is cached as a WAV under
pipeline/audio/.cache/, so a re-run after editing one line only re-renders that
line. Deleting .cache/ forces a full re-render (~12 min on an M3).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Iterable

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lines as L  # noqa: E402
import tts  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CACHE = os.path.join(HERE, ".cache")
OUT_DIR = os.path.join(ROOT, "public", "audio")
VO_DIR = os.path.join(OUT_DIR, "vo")
TEAMS_JSON = os.path.join(ROOT, "src", "data", "teams.json")
MANIFEST = os.path.join(OUT_DIR, "commentary.json")

SR = tts.SAMPLE_RATE
GAP = 0.12          # silence between clips inside a sprite (codec bleed guard)
LEAD = 0.05         # silence at the head of every sprite
OPUS_KBPS = 28

SLOT_RE = re.compile(r"\{(\w+)\}")
PUNCT_ONLY = re.compile(r"^[\s\.,!\?;:—–\-…\"']*$")

# ---------------------------------------------------------------- job model


class Job:
    """One unique (voice, text) pair to render."""
    __slots__ = ("cid", "voice", "text", "cat", "key")

    def __init__(self, cid: str, voice: str, text: str, cat: str) -> None:
        self.cid = cid
        self.voice = voice
        self.text = text
        self.cat = cat
        self.key = ""   # filled in once the backend is known


def cache_key(backend_name: str, voice: str, text: str) -> str:
    spec = tts.VOICES[voice]
    h = hashlib.sha1(
        f"{backend_name}|{voice}|{spec.kokoro}|{spec.say}|{spec.speed}|{text}".encode("utf-8")
    ).hexdigest()
    return h


def split_template(tpl: str) -> list[dict]:
    """"a {x} b" -> [{'t':'a'}, {'s':'x'}, {'t':'b'}] with dead runs dropped."""
    parts: list[dict] = []
    pos = 0
    for m in SLOT_RE.finditer(tpl):
        run = tpl[pos:m.start()]
        if not PUNCT_ONLY.match(run):
            parts.append({"t": clean_run(run)})
        parts.append({"s": m.group(1)})
        pos = m.end()
    run = tpl[pos:]
    if not PUNCT_ONLY.match(run):
        parts.append({"t": clean_run(run)})
    return parts


def clean_run(run: str) -> str:
    """Tidy a text run so the TTS gives it an open (splice-friendly) contour."""
    run = run.strip()
    # a run that ends mid-sentence should not carry a dangling connector
    run = re.sub(r"[\s,;:—–\-]+$", "", run)
    # a run that starts after a slot should not start with the slot's punctuation
    run = re.sub(r"^[\s,;:!\?\.—–]+", "", run)
    return run


# ------------------------------------------------------------- job building


def build_jobs(team_filter: set[str] | None) -> tuple[list[Job], dict]:
    """Returns (jobs, partial manifest with clip ids but no offsets yet)."""
    jobs: list[Job] = []
    groups: dict[str, dict] = {}

    for gname, g in L.GROUPS.items():
        voice, cat = g["voice"], g["cat"]
        variants = []
        for vi, tpl in enumerate(g["lines"]):
            parts = split_template(tpl)
            out_parts = []
            for pi, p in enumerate(parts):
                if "s" in p:
                    out_parts.append({"s": p["s"]})
                    continue
                cid = f"{gname}#{vi}.{pi}"
                jobs.append(Job(cid, voice, p["t"], cat))
                out_parts.append({"c": cid})
            variants.append({"parts": out_parts, "text": tpl})
        groups[gname] = {"voice": voice, "pri": g["pri"], "variants": variants}

    # scoreline numbers
    numbers: dict[str, str] = {}
    for n, word in enumerate(L.NUMBERS):
        cid = f"num#{n}"
        jobs.append(Job(cid, "pbp", word + ",", "verdict"))
        numbers[str(n)] = cid

    # names, one sprite per team
    with open(TEAMS_JSON, encoding="utf-8") as fh:
        teams = json.load(fh)["teams"]
    names: dict[str, dict] = {}
    for t in teams:
        tid = t["id"]
        if team_filter and tid not in team_filter:
            continue
        cat = f"name.{tid}"
        team_cid = f"team#{tid}"
        jobs.append(Job(team_cid, "pbp", L.TEAM_TEMPLATE.format(name=t["name"]), cat))
        players: dict[str, str] = {}
        seen: dict[str, str] = {}
        for p in t["players"]:
            surname = p["name"].split()[-1]
            if surname in seen:
                players[surname] = seen[surname]
                continue
            cid = f"name#{tid}.{len(seen)}"
            jobs.append(Job(cid, "pbp", L.NAME_TEMPLATE.format(name=surname), cat))
            seen[surname] = cid
            players[surname] = cid
        names[tid] = {"team": team_cid, "players": players}

    manifest = {"groups": groups, "numbers": numbers, "names": names,
                "fallback": L.FALLBACK}
    return jobs, manifest


# ------------------------------------------------------------- render phase

_BACKEND = None


def _worker_init(kind: str) -> None:
    global _BACKEND
    # one ONNX thread per worker: we get our parallelism from the pool
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    _BACKEND = tts.make_backend(kind)


def _render_one(args: tuple[str, str, str]) -> tuple[str, float]:
    key, voice, text = args
    path = os.path.join(CACHE, key + ".wav")
    if os.path.exists(path):
        info = sf.info(path)
        return key, info.frames / info.samplerate
    x = _BACKEND.synth(text, voice)          # type: ignore[union-attr]
    x = tts.normalise(tts.trim_silence(x))
    tmp = f"{path[:-4]}.{os.getpid()}.tmp.wav"
    sf.write(tmp, x, SR, subtype="PCM_16")
    os.replace(tmp, path)
    return key, x.size / SR


def render_all(jobs: list[Job], kind: str, workers: int, force: bool) -> str:
    os.makedirs(CACHE, exist_ok=True)
    probe = tts.make_backend(kind)
    backend_name = probe.name
    del probe

    for j in jobs:
        j.key = cache_key(backend_name, j.voice, j.text)
    if force:
        for j in jobs:
            p = os.path.join(CACHE, j.key + ".wav")
            if os.path.exists(p):
                os.remove(p)

    todo: dict[str, tuple[str, str, str]] = {}
    for j in jobs:
        if j.key in todo:
            continue
        if os.path.exists(os.path.join(CACHE, j.key + ".wav")):
            continue
        todo[j.key] = (j.key, j.voice, j.text)

    print(f"  backend: {backend_name}")
    print(f"  clips: {len(jobs)} ({len({j.key for j in jobs})} unique), "
          f"{len(todo)} to render, {len({j.key for j in jobs}) - len(todo)} cached")
    if not todo:
        return backend_name

    t0 = time.time()
    done = 0
    items = list(todo.values())
    if workers <= 1:
        _worker_init(kind)
        for it in items:
            _render_one(it)
            done += 1
            if done % 100 == 0:
                print(f"    {done}/{len(items)}  ({time.time() - t0:.0f}s)", flush=True)
    else:
        ctx = mp.get_context("spawn")
        with ctx.Pool(workers, initializer=_worker_init, initargs=(kind,)) as pool:
            for _ in pool.imap_unordered(_render_one, items, chunksize=8):
                done += 1
                if done % 100 == 0:
                    print(f"    {done}/{len(items)}  ({time.time() - t0:.0f}s)", flush=True)
    print(f"  rendered {done} clips in {time.time() - t0:.0f}s")
    return backend_name


# ------------------------------------------------------------ sprite phase


def encode_opus(wav: str, ogg: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
         "-c:a", "libopus", "-b:a", f"{OPUS_KBPS}k", "-ac", "1",
         "-vbr", "on", "-compression_level", "10", ogg],
        check=True)


def pack_sprites(jobs: list[Job]) -> tuple[dict, dict]:
    """Concatenate cached clips into per-category Opus sprites."""
    os.makedirs(VO_DIR, exist_ok=True)
    by_sprite: dict[str, list[Job]] = {}
    for j in jobs:
        sprite = j.cat if j.cat.startswith("name.") else f"{j.voice}.{j.cat}"
        by_sprite.setdefault(sprite, []).append(j)

    sprites: dict[str, dict] = {}
    clips: dict[str, list] = {}
    gap = np.zeros(int(GAP * SR), dtype=np.float32)
    for sprite, group in sorted(by_sprite.items()):
        buf: list[np.ndarray] = [np.zeros(int(LEAD * SR), dtype=np.float32)]
        cursor = LEAD
        emitted: set[str] = set()
        for j in group:
            if j.cid in emitted:
                continue
            emitted.add(j.cid)
            x, _ = sf.read(os.path.join(CACHE, j.key + ".wav"), dtype="float32")
            if x.ndim > 1:
                x = x.mean(axis=1)
            clips[j.cid] = [sprite, round(cursor * 1000), round(len(x) / SR * 1000)]
            buf.append(x)
            buf.append(gap)
            cursor += len(x) / SR + GAP
        audio = np.concatenate(buf)
        wav = os.path.join(VO_DIR, sprite + ".wav")
        ogg = os.path.join(VO_DIR, sprite + ".ogg")
        sf.write(wav, audio, SR, subtype="PCM_16")
        encode_opus(wav, ogg)
        os.remove(wav)
        sprites[sprite] = {
            "file": f"vo/{sprite}.ogg",
            "dur": round(len(audio) / SR, 3),
            "bytes": os.path.getsize(ogg),
        }
    return sprites, clips


# --------------------------------------------------------------------- main


def human(n: int) -> str:
    return f"{n / 1024 / 1024:.2f} MB" if n > 1024 * 1024 else f"{n / 1024:.0f} KB"


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", default="auto", choices=["auto", "kokoro", "say"])
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    ap.add_argument("--teams", default="", help="comma-separated team ids (default: all)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--clean", action="store_true", help="wipe public/audio/vo first")
    args = ap.parse_args(list(argv) if argv is not None else None)

    if not shutil.which("ffmpeg"):
        print("ffmpeg not found (brew install ffmpeg)", file=sys.stderr)
        return 1

    team_filter = {t.strip() for t in args.teams.split(",") if t.strip()} or None
    if args.clean and os.path.isdir(VO_DIR):
        shutil.rmtree(VO_DIR)

    print("SUPER STRIKER '26 — commentary bake")
    jobs, partial = build_jobs(team_filter)
    backend_name = render_all(jobs, args.backend, args.jobs, args.force)
    print("  packing sprites ...")
    sprites, clips = pack_sprites(jobs)

    total = sum(s["bytes"] for s in sprites.values())
    manifest = {
        "version": 1,
        "engine": backend_name,
        "voices": {k: v.kokoro if "kokoro" in backend_name else v.say
                   for k, v in tts.VOICES.items()},
        "sampleRate": SR,
        "base": "audio/",
        "gap": GAP,
        "sprites": sprites,
        "clips": clips,
        **partial,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, separators=(",", ":"), sort_keys=True)

    line_sprites = {k: v for k, v in sprites.items() if not k.startswith("name.")}
    name_sprites = {k: v for k, v in sprites.items() if k.startswith("name.")}
    print(f"  sprites: {len(sprites)} files, {human(total)} total")
    print(f"    lines: {len(line_sprites)} files, {human(sum(s['bytes'] for s in line_sprites.values()))}")
    print(f"    names: {len(name_sprites)} files, {human(sum(s['bytes'] for s in name_sprites.values()))} "
          f"(a match loads 2)")
    print(f"  manifest: {MANIFEST} ({human(os.path.getsize(MANIFEST))})")
    print(f"  clips: {len(clips)}  groups: {len(partial['groups'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
