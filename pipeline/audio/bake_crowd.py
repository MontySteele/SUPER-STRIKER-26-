#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bake the stadium atmosphere from CC0 recordings.

Two public-domain recordings do all the work (see CREDITS.md):

  crowd_shouting.ogg   StarNinjas, CC0 — a handful of people shouting
  applause_hall.wav    eXpl0it3r,  CC0 — real applause in a big reverberant hall

Neither is a stadium. A stadium is made here, by the trick that actually builds
crowds in film sound: take the small crowd, copy it many times at slightly
different rates and offsets so the copies decorrelate, drop the pitch so the
voices read as adult and distant, and let the sum be the roar. Sixteen copies
of six people is a hundred people; filtered, layered and ducked under its own
low end it reads as a full end.

Outputs mono 24 kHz Opus loops/one-shots into public/audio/crowd/ plus
public/audio/crowd.json. Idempotent: re-running overwrites the same files from
the same sources, and skips entirely if the sources are missing (the runtime
falls back to pure synthesis).

    pipeline/audio/.venv/bin/python pipeline/audio/bake_crowd.py --fetch
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "sources")
OUT_DIR = os.path.join(ROOT, "public", "audio")
CROWD_DIR = os.path.join(OUT_DIR, "crowd")
MANIFEST = os.path.join(OUT_DIR, "crowd.json")

SR = 24000
OPUS_KBPS = 48   # noise beds smear badly below ~40k

SOURCES = {
    "shout": ("crowd_shouting.ogg",
              "https://opengameart.org/sites/default/files/crowd_shouting_0.ogg"),
    "applause": ("applause_hall.wav",
                 "https://opengameart.org/sites/default/files/"
                 "applause-clapping-church-crowd-immersive.wav"),
}

rng = np.random.default_rng(2026)


# ------------------------------------------------------------------ helpers

def load(name: str) -> np.ndarray:
    path = os.path.join(SRC, SOURCES[name][0])
    x, sr = sf.read(path, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != SR:
        x = resample(x, sr / SR)
    return x.astype(np.float32)


def resample(x: np.ndarray, factor: float) -> np.ndarray:
    """factor > 1 stretches (and lowers pitch); linear interp is plenty for noise."""
    n = int(len(x) * factor)
    idx = np.linspace(0, len(x) - 1, n)
    return np.interp(idx, np.arange(len(x)), x).astype(np.float32)


def thicken(x: np.ndarray, copies: int, spread: float, out_len: int) -> np.ndarray:
    """Sum decorrelated copies of a small crowd into a big one."""
    acc = np.zeros(out_len, dtype=np.float32)
    for _ in range(copies):
        rate = 1.0 + rng.uniform(-spread, spread)
        y = resample(x, rate)
        start = int(rng.uniform(0, len(y)))
        y = np.roll(y, start)
        reps = int(np.ceil(out_len / len(y)))
        y = np.tile(y, reps)[:out_len]
        acc += y * rng.uniform(0.7, 1.0)
    return acc / np.sqrt(copies)


def biquad(x: np.ndarray, kind: str, f0: float, q: float = 0.707) -> np.ndarray:
    """One RBJ biquad, applied forward then backward (zero phase, 4th order)."""
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    if kind == "lp":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
    elif kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    elif kind == "bp":
        b = [alpha, 0.0, -alpha]
    else:
        raise ValueError(kind)
    a = [1 + alpha, -2 * cw, 1 - alpha]
    b = [c / a[0] for c in b]
    a = [c / a[0] for c in a]

    def run(sig: np.ndarray) -> np.ndarray:
        y = np.zeros_like(sig)
        x1 = x2 = y1 = y2 = 0.0
        for i, s in enumerate(sig):
            o = b[0] * s + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
            x2, x1 = x1, s
            y2, y1 = y1, o
            y[i] = o
        return y

    return run(run(x)[::-1])[::-1].astype(np.float32)


def loopify(x: np.ndarray, xfade: float = 1.5) -> np.ndarray:
    """Crossfade the tail into the head so the loop point is inaudible."""
    n = int(xfade * SR)
    if len(x) < 3 * n:
        return x
    head, tail = x[:n], x[-n:]
    ramp = np.linspace(0, 1, n, dtype=np.float32)
    mixed = tail * (1 - ramp) + head * ramp
    return np.concatenate([mixed, x[n:-n]]).astype(np.float32)


def env(n: int, attack: float, hold: float, release: float, curve: float = 2.0) -> np.ndarray:
    a, h = int(attack * SR), int(hold * SR)
    r = max(1, n - a - h)
    return np.concatenate([
        np.linspace(0, 1, max(1, a)) ** (1 / curve),
        np.ones(max(0, h)),
        np.linspace(1, 0, r) ** curve,
    ])[:n].astype(np.float32)


def norm(x: np.ndarray, peak_db: float = -3.0) -> np.ndarray:
    p = float(np.max(np.abs(x))) or 1.0
    return (x * (10 ** (peak_db / 20) / p)).astype(np.float32)


def write(name: str, x: np.ndarray, loop: bool, gain: float,
          manifest: dict, note: str) -> None:
    os.makedirs(CROWD_DIR, exist_ok=True)
    wav = os.path.join(CROWD_DIR, name + ".wav")
    ogg = os.path.join(CROWD_DIR, name + ".ogg")
    sf.write(wav, x, SR, subtype="PCM_16")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
         "-c:a", "libopus", "-b:a", f"{OPUS_KBPS}k", "-ac", "1",
         "-vbr", "on", "-compression_level", "10", ogg], check=True)
    os.remove(wav)
    manifest[name] = {
        "file": f"crowd/{name}.ogg",
        "dur": round(len(x) / SR, 3),
        "loop": loop,
        "gain": gain,
        "bytes": os.path.getsize(ogg),
        "note": note,
    }
    print(f"  {name:14s} {len(x)/SR:5.1f}s  {os.path.getsize(ogg)/1024:6.0f} KB  {note}")


# --------------------------------------------------------------------- bake

def fetch_sources() -> None:
    """Pull the CC0 originals. They are gitignored (7 MB, regenerable)."""
    os.makedirs(SRC, exist_ok=True)
    for f, url in SOURCES.values():
        path = os.path.join(SRC, f)
        if os.path.exists(path) and os.path.getsize(path) > 1000:
            continue
        print(f"  downloading {f} ...", flush=True)
        subprocess.run(["curl", "-sSL", "-o", path, url], check=True)


def main() -> int:
    if "--fetch" in sys.argv:
        fetch_sources()
    if not shutil.which("ffmpeg"):
        print("ffmpeg not found (brew install ffmpeg)", file=sys.stderr)
        return 1
    missing = [f for f, url in SOURCES.values() if not os.path.exists(os.path.join(SRC, f))]
    if missing:
        print("missing CC0 sources — re-run with --fetch, or:")
        for f, url in SOURCES.values():
            print(f"  curl -L -o pipeline/audio/sources/{f} '{url}'")
        return 1

    print("SUPER STRIKER '26 — crowd bake (CC0 sources)")
    shout = load("shout")
    applause = load("applause")
    m: dict = {}

    # --- murmur: the between-plays hum of a full stadium. Dropped a fifth,
    #     heavily thickened, and rolled off hard so no individual voice reads.
    deep = resample(shout, 1.45)
    murmur = thicken(deep, 18, 0.06, int(16 * SR))
    murmur = biquad(murmur, "lp", 900)
    murmur = biquad(murmur, "hp", 90)
    write("murmur", norm(loopify(murmur), -12.0), True, 0.55, m,
          "idle bed, -5 semitones, 18 layers")

    # --- anticipation: same crowd leaning forward. Less pitch drop, more
    #     presence in the vowel band, so it sits ON TOP of the murmur.
    ant = thicken(resample(shout, 1.18), 14, 0.08, int(14 * SR))
    ant = biquad(ant, "bp", 700, 0.55)
    ant += 0.35 * biquad(thicken(shout, 8, 0.1, int(14 * SR)), "bp", 1500, 0.7)
    write("anticipation", norm(loopify(ant), -8.0), True, 0.5, m,
          "reactive layer, rides attackBuildup")

    # --- roar: a chance, a save, a tackle in the last minute.
    n = int(4.5 * SR)
    roar = thicken(resample(shout, 1.1), 16, 0.09, n)
    roar = biquad(roar, "bp", 900, 0.5) + 0.5 * biquad(roar, "hp", 1800)
    write("roar", norm(roar * env(n, 0.18, 0.5, 3.8), -4.0), False, 0.8, m,
          "chance / save reaction")

    # --- eruption: a goal. Longer, brighter, with applause growing into it.
    n = int(9.0 * SR)
    erupt = thicken(resample(shout, 1.05), 22, 0.1, n)
    erupt = biquad(erupt, "bp", 1000, 0.45) + 0.6 * biquad(erupt, "hp", 2200)
    clap = thicken(applause, 3, 0.05, n)
    swell = np.clip(np.linspace(-0.4, 1.0, n), 0, 1) ** 1.5
    erupt = erupt * env(n, 0.12, 2.2, 6.4) + clap * swell * 0.55
    write("eruption", norm(erupt, -2.0), False, 1.0, m,
          "goal — home crowd goes up")

    # --- groan: the away goal, the missed sitter. Pitch falls as it dies.
    n = int(3.0 * SR)
    fall = np.linspace(1.0, 1.9, n)                      # rate ramp = sagging pitch
    idx = np.clip(np.cumsum(1.0 / fall), 0, len(shout) - 2)
    base = np.interp(idx, np.arange(len(shout)), shout).astype(np.float32)
    groan = thicken(base, 12, 0.05, n)
    groan = biquad(groan, "lp", 700)
    write("groan", norm(groan * env(n, 0.22, 0.25, 2.5), -6.0), False, 0.75, m,
          "away goal / bad miss")

    # --- applause bed: real hands, looped, for celebrations and the walk-out.
    ap = applause[int(4 * SR):int(20 * SR)]
    write("applause", norm(loopify(thicken(ap, 3, 0.04, int(12 * SR)), 1.2), -10.0),
          True, 0.5, m, "celebration / ceremony bed")

    # --- clap burst: one wave of applause, for a HUD sting or a sub.
    burst = applause[int(6 * SR):int(9 * SR)]
    n = len(burst)
    write("clap_burst", norm(burst * env(n, 0.05, 1.2, 1.6), -6.0), False, 0.6, m,
          "one-shot applause")

    # --- terrace chant: gate the crowd with a 2-bar clap pattern and stack the
    #     real applause transients on the beats. This is the universal
    #     clap-clap, clap-clap-clap, and it is what makes a stand sound owned.
    beat = 0.36
    bars, pattern = 4, [0.0, 1.0, 2.0, 2.5, 3.0]
    n = int(bars * 4 * beat * SR)
    gate = np.full(n, 0.22, dtype=np.float32)
    chant = thicken(resample(shout, 1.25), 12, 0.07, n)
    hit = applause[int(6.5 * SR):int(6.5 * SR + 0.22 * SR)]
    hit = hit * env(len(hit), 0.004, 0.02, 0.19)
    for bar in range(bars):
        for step in pattern:
            t = int((bar * 4 + step) * beat * SR)
            if t + len(hit) >= n:
                continue
            gate[t:t + int(0.2 * SR)] = np.linspace(1.0, 0.3, int(0.2 * SR))
            # a few hundred hands never land together
            for _ in range(4):
                o = t + int(rng.uniform(0, 0.05) * SR)
                if o + len(hit) < n:
                    chant[o:o + len(hit)] += hit * rng.uniform(0.35, 0.7)
    chant *= gate
    write("chant", norm(loopify(chant, 0.5), -7.0), True, 0.45, m,
          "terrace clap, 2 bars x 2")

    os.makedirs(OUT_DIR, exist_ok=True)
    out = {
        "version": 1,
        "base": "audio/",
        "sampleRate": SR,
        "sources": [
            {"file": SOURCES["shout"][0], "url": SOURCES["shout"][1],
             "author": "StarNinjas", "licence": "CC0"},
            {"file": SOURCES["applause"][0], "url": SOURCES["applause"][1],
             "author": "eXpl0it3r", "licence": "CC0"},
        ],
        "layers": m,
    }
    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), sort_keys=True)
    total = sum(v["bytes"] for v in m.values())
    print(f"  {len(m)} layers, {total/1024:.0f} KB total -> {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
