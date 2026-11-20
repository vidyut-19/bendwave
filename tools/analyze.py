#!/usr/bin/env python3
"""vibedeck crate-ingestion sidecar.

Usage:
  python3 tools/analyze.py <audio-file> [--stems] [--stems-dir DIR] [--duration SEC]

Prints a single JSON object to stdout, e.g.:
  {"bpm": 128.0, "offset": 0.42, "key": "A minor", "camelot": "8A",
   "stems": {"drums": "...", "bass": "...", "other": "...", "vocals": "..."}}

Partial failures are reported per-section ("bpm_error", "stems_error") so the
app can use whatever succeeded. If nothing succeeded, prints {"error": ...}
and exits 2.

Deps:
  pip install librosa soundfile    # bpm + key
  pip install demucs               # stems (optional, pulls torch)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

MIN_BPM, MAX_BPM = 70.0, 180.0

KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CAMELOT = {
    "B major": "1B", "F# major": "2B", "C# major": "3B", "G# major": "4B",
    "D# major": "5B", "A# major": "6B", "F major": "7B", "C major": "8B",
    "G major": "9B", "D major": "10B", "A major": "11B", "E major": "12B",
    "A# minor": "1A", "D# minor": "2A", "G# minor": "3A", "C# minor": "4A",
    "F# minor": "5A", "B minor": "6A", "E minor": "7A", "A minor": "8A",
    "D minor": "9A", "G minor": "10A", "C minor": "11A", "F minor": "12A",
}


def pearson(a: list[float], b: list[float]) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = sum((x - ma) ** 2 for x in a) ** 0.5
    db = sum((y - mb) ** 2 for y in b) ** 0.5
    return num / (da * db) if da and db else 0.0


def detect_key(chroma_mean: list[float]) -> tuple[str, str]:
    best = (-2.0, "C", "major")
    for rot in range(12):
        rotated = [chroma_mean[(i + rot) % 12] for i in range(12)]
        for profile, mode in ((KRUMHANSL_MAJOR, "major"), (KRUMHANSL_MINOR, "minor")):
            r = pearson(rotated, profile)
            if r > best[0]:
                best = (r, NOTE_NAMES[rot], mode)
    return best[1], best[2]


def fold_bpm(tempo: float) -> float:
    while tempo < MIN_BPM:
        tempo *= 2
    while tempo > MAX_BPM:
        tempo /= 2
    return tempo


def analyze_rhythm(path: str, duration: float) -> dict:
    import librosa
    import numpy as np

    y, sr = librosa.load(path, mono=True, duration=duration)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    tempo = fold_bpm(float(np.atleast_1d(tempo)[0]))
    offset = float(librosa.frames_to_time(beats[0], sr=sr)) if len(beats) else 0.0
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    root, mode = detect_key([float(c) for c in chroma])
    key = f"{root} {mode}"
    return {
        "bpm": round(tempo, 2),
        "offset": round(offset, 4),
        "key": key,
        "camelot": CAMELOT.get(key, ""),
    }


def separate_stems(path: str, out_root: Path) -> dict[str, str]:
    cmd = [sys.executable, "-m", "demucs", "-n", "htdemucs", "-o", str(out_root), str(path)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "demucs failed").strip()[-500:])
    # demucs writes <model>/<track>/<stem>.wav under out_root; locate robustly
    hits = sorted(out_root.glob("**/drums.wav"), key=lambda p: p.stat().st_mtime)
    if not hits:
        raise RuntimeError("demucs produced no drums.wav (unexpected output layout)")
    stem_dir = hits[-1].parent
    return {s: str(stem_dir / f"{s}.wav") for s in ("drums", "bass", "other", "vocals")}


def main() -> None:
    ap = argparse.ArgumentParser(description="vibedeck analysis sidecar")
    ap.add_argument("path")
    ap.add_argument("--stems", action="store_true", help="run demucs stem separation")
    ap.add_argument("--stems-dir", default=None, help="where to write stems (default: ./stems)")
    ap.add_argument("--duration", type=float, default=120.0, help="seconds of audio to analyze")
    args = ap.parse_args()

    out: dict = {}

    try:
        out.update(analyze_rhythm(args.path, args.duration))
    except Exception as e:  # noqa: BLE001
        out["bpm_error"] = f"{type(e).__name__}: {e}"

    if args.stems:
        try:
            out["stems"] = separate_stems(args.path, Path(args.stems_dir or "stems"))
        except Exception as e:  # noqa: BLE001
            out["stems_error"] = f"{type(e).__name__}: {e}"

    if "bpm" not in out and "stems" not in out:
        json.dump(
            {"error": "; ".join(filter(None, [out.get("bpm_error"), out.get("stems_error")])) or "analysis failed"},
            sys.stdout,
        )
        sys.exit(2)

    json.dump(out, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
