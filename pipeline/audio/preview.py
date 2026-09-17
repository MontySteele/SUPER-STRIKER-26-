#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render spliced commentary lines to standalone files you can actually play.

This is the ear-check for the bake, and it is also the end-to-end test of the
sprite offsets: it decodes the shipped Opus sprites, slices them with the
manifest's own numbers, and glues the pieces with the runtime's splice gap. If
a preview sounds right, the game will sound right.

    pipeline/audio/.venv/bin/python pipeline/audio/preview.py
    ... --group goal.generic --home bra --away mex --n 3
    ... --list                      # every group and its variants

Output lands in pipeline/audio/samples/ as 24 kHz mono Opus.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
AUDIO = os.path.join(ROOT, "public", "audio")
MANIFEST = os.path.join(AUDIO, "commentary.json")
SAMPLES = os.path.join(HERE, "samples")

SR = 24000
SPLICE_GAP = 0.045   # must match SPLICE_GAP in src/audio/commentaryBank.ts

_decoded: dict[str, np.ndarray] = {}


def sprite_audio(man: dict, key: str) -> np.ndarray:
    if key in _decoded:
        return _decoded[key]
    src = os.path.join(AUDIO, man["sprites"][key]["file"])
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "s.wav")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", src, "-ar", str(SR), "-ac", "1", wav], check=True)
        x, _ = sf.read(wav, dtype="float32")
    _decoded[key] = x
    return x


def slice_clip(man: dict, cid: str) -> np.ndarray:
    key, off_ms, dur_ms = man["clips"][cid]
    x = sprite_audio(man, key)
    a = int(off_ms / 1000 * SR)
    b = a + int(dur_ms / 1000 * SR)
    return x[a:b]


def squad(man: dict, team_id: str) -> dict:
    s = man["names"].get(team_id)
    if not s:
        sys.exit(f"no baked names for team '{team_id}'")
    return s


def build(man: dict, group: str, vi: int, home: str, away: str,
          player: str | None) -> tuple[np.ndarray, str]:
    g = man["groups"][group]
    v = g["variants"][vi % len(g["variants"])]
    hs, aws = squad(man, home), squad(man, away)
    who = player or sorted(hs["players"])[0]
    pieces: list[np.ndarray] = []
    gap = np.zeros(int(SPLICE_GAP * SR), dtype=np.float32)
    text = v["text"]
    for part in v["parts"]:
        if "c" in part:
            cid = part["c"]
        else:
            slot = part["s"]
            if slot in ("scorer", "keeper", "shooter", "player", "taker"):
                cid = hs["players"][who]
                text = text.replace("{%s}" % slot, who)
            elif slot in ("team", "winner", "home"):
                cid = hs["team"]
                text = text.replace("{%s}" % slot, home.upper())
            elif slot == "away":
                cid = aws["team"]
                text = text.replace("{away}", away.upper())
            elif slot.startswith("num"):
                n = "2" if slot.endswith("home") else "1"
                cid = man["numbers"][n]
                text = text.replace("{%s}" % slot, n)
            else:
                return np.zeros(0, dtype=np.float32), text
        pieces.append(slice_clip(man, cid))
        pieces.append(gap)
    return np.concatenate(pieces[:-1]) if pieces else np.zeros(0, dtype=np.float32), text


def write(name: str, x: np.ndarray) -> str:
    os.makedirs(SAMPLES, exist_ok=True)
    wav = os.path.join(SAMPLES, name + ".wav")
    ogg = os.path.join(SAMPLES, name + ".ogg")
    sf.write(wav, x, SR, subtype="PCM_16")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
                    "-c:a", "libopus", "-b:a", "32k", "-ac", "1", ogg], check=True)
    os.remove(wav)
    return ogg


DEFAULTS = [
    ("goal.generic", 0, None),
    ("goal.equaliser", 1, None),
    ("goal.own", 0, None),
    ("save.big", 0, None),
    ("card.red", 1, None),
    ("kickoff.match", 3, None),
    ("fulltime.win", 0, None),
    ("score.report", 0, None),
    ("colour.general", 1, None),
    ("pen.awarded", 2, None),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--group")
    ap.add_argument("--variant", type=int, default=0)
    ap.add_argument("--home", default="bra")
    ap.add_argument("--away", default="mex")
    ap.add_argument("--player", default=None, help="surname, must be in the home squad")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(MANIFEST):
        sys.exit("no public/audio/commentary.json — run bake_commentary.py first")
    with open(MANIFEST, encoding="utf-8") as fh:
        man = json.load(fh)

    if args.list:
        for gname, g in sorted(man["groups"].items()):
            print(f"{gname}  [{g['voice']}, pri {g['pri']}]")
            for i, v in enumerate(g["variants"]):
                print(f"    {i}: {v['text']}")
        return 0

    jobs = ([(args.group, args.variant, args.player)] if args.group
            else [(g, v, p or args.player) for g, v, p in DEFAULTS])
    print(f"engine: {man['engine']}")
    for group, vi, player in jobs:
        if group not in man["groups"]:
            print(f"  ! unknown group {group}")
            continue
        x, text = build(man, group, vi, args.home, args.away, player)
        if not x.size:
            print(f"  ! {group} has a slot the preview can't fill")
            continue
        name = re.sub(r"[^a-z0-9.]+", "_", f"{group}.{vi}".lower())
        path = write(name, x)
        print(f"  {len(x)/SR:5.2f}s  {os.path.relpath(path, ROOT)}\n           \"{text}\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
