# -*- coding: utf-8 -*-
"""TTS backends for the commentary bake.

Primary backend is Kokoro-82M through `kokoro-onnx` (Apache-2.0 model, MIT
wrapper): a small neural TTS that runs comfortably on an M3 CPU and ships two
distinct British male voices, which is exactly what a play-by-play / colour
pairing needs. It is preferred because `pip install kokoro` (the PyTorch build)
pulls misaki[en] -> spacy, and spacy has no wheel for Python 3.13 (it tries to
build 4.0.0.dev3 from source and fails). `kokoro-onnx` phonemises with
espeak-ng instead and installs in under a minute.

Fallback is macOS `say`. It is markedly worse (formant-synth "Daniel") but it
is always present, so the bake never hard-fails on a fresh machine.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

import numpy as np
import soundfile as sf

SAMPLE_RATE = 24000

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
MODEL_ONNX = os.path.join(MODEL_DIR, "kokoro-v1.0.onnx")
MODEL_VOICES = os.path.join(MODEL_DIR, "voices-v1.0.bin")

MODEL_URLS = {
    MODEL_ONNX: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    MODEL_VOICES: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}


@dataclass(frozen=True)
class VoiceSpec:
    """One commentator: a backend voice id plus a delivery speed."""
    kokoro: str
    say: str
    speed: float


# pbp is the excitable one; colour sits a touch slower and lower-energy.
VOICES: dict[str, VoiceSpec] = {
    "pbp": VoiceSpec(kokoro="bm_george", say="Daniel", speed=1.08),
    "colour": VoiceSpec(kokoro="bm_lewis", say="Moira", speed=0.98),
}


def models_present() -> bool:
    return all(os.path.exists(p) and os.path.getsize(p) > 1_000_000 for p in MODEL_URLS)


def fetch_models() -> None:
    """Idempotent: download the Kokoro weights if they are not already here."""
    os.makedirs(MODEL_DIR, exist_ok=True)
    for path, url in MODEL_URLS.items():
        if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
            continue
        print(f"  downloading {os.path.basename(path)} ...", flush=True)
        subprocess.run(["curl", "-sSL", "-o", path, url], check=True)


class KokoroBackend:
    name = "kokoro-onnx (Kokoro-82M v1.0)"

    def __init__(self) -> None:
        from kokoro_onnx import Kokoro  # imported lazily: heavy
        self._k = Kokoro(MODEL_ONNX, MODEL_VOICES)

    def synth(self, text: str, voice: str) -> np.ndarray:
        spec = VOICES[voice]
        samples, sr = self._k.create(text, voice=spec.kokoro, speed=spec.speed, lang="en-gb")
        assert sr == SAMPLE_RATE, f"unexpected kokoro sample rate {sr}"
        return np.asarray(samples, dtype=np.float32)


class SayBackend:
    name = "macOS say"

    def __init__(self) -> None:
        if not shutil.which("say"):
            raise RuntimeError("macOS `say` not available")

    def synth(self, text: str, voice: str) -> np.ndarray:
        spec = VOICES[voice]
        # `say` speaks in words-per-minute; 180 is its neutral-ish rate.
        rate = int(180 * spec.speed)
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "o.wav")
            subprocess.run(
                ["say", "-v", spec.say, "-r", str(rate), "-o", out,
                 "--data-format=LEF32@24000", text],
                check=True, capture_output=True)
            data, sr = sf.read(out, dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        assert sr == SAMPLE_RATE
        return np.asarray(data, dtype=np.float32)


def make_backend(kind: str = "auto"):
    """kind: auto | kokoro | say."""
    if kind in ("auto", "kokoro"):
        try:
            if not models_present():
                fetch_models()
            return KokoroBackend()
        except Exception as exc:  # noqa: BLE001
            if kind == "kokoro":
                raise
            print(f"  kokoro unavailable ({exc}); falling back to macOS say", flush=True)
    return SayBackend()


# --------------------------------------------------------------------- DSP

def trim_silence(x: np.ndarray, thresh_db: float = -45.0, pad_ms: int = 20) -> np.ndarray:
    """Strip the dead air the model leaves on both ends, keeping a little pad.

    Splicing lives or dies on this: a 300 ms tail of silence inside a name clip
    turns "from ... Okafor" into "from ...... Okafor".
    """
    if x.size == 0:
        return x
    thresh = 10.0 ** (thresh_db / 20.0) * float(np.max(np.abs(x)) or 1.0)
    loud = np.flatnonzero(np.abs(x) > thresh)
    if loud.size == 0:
        return x[:1]
    pad = int(SAMPLE_RATE * pad_ms / 1000)
    a = max(0, int(loud[0]) - pad)
    b = min(x.size, int(loud[-1]) + pad)
    return x[a:b]


def normalise(x: np.ndarray, target_rms_db: float = -20.0, peak_db: float = -1.5) -> np.ndarray:
    """RMS-match every clip so spliced fragments sit at the same level."""
    if x.size == 0:
        return x
    rms = float(np.sqrt(np.mean(np.square(x))))
    if rms < 1e-6:
        return x
    gain = (10.0 ** (target_rms_db / 20.0)) / rms
    y = x * gain
    peak = float(np.max(np.abs(y)))
    ceil = 10.0 ** (peak_db / 20.0)
    if peak > ceil:
        y *= ceil / peak
    return y.astype(np.float32)
