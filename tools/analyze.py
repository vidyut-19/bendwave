#!/usr/bin/env python3
"""vibedeck crate-ingestion sidecar.

Usage:
  python3 tools/analyze.py <audio-file> [--stems] [--stems-dir DIR] [--duration SEC]

Reads embedded ID3v2 / Serato BeatGrid / TBPM / TKEY tags first (exact when
present), falls back to librosa for BPM/offset/key, and optionally separates
4 stems via demucs (htdemucs).

Prints a single JSON object to stdout, e.g.:
  {"bpm": 127.0, "offset": 0.046, "key": "E minor", "camelot": "9A",
   "stems": {"drums": "...", "bass": "...", "other": "...", "vocals": "..."}}
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import subprocess
import sys
from pathlib import Path

MIN_BPM, MAX_BPM = 70.0, 180.0

KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Verified Circle-of-Fifths Camelot Wheel (major = B, relative minor = A)
CAMELOT = {
    "B major": "1B", "F# major": "2B", "C# major": "3B", "G# major": "4B",
    "D# major": "5B", "A# major": "6B", "F major": "7B", "C major": "8B",
    "G major": "9B", "D major": "10B", "A major": "11B", "E major": "12B",
    "G# minor": "1A", "D# minor": "2A", "A# minor": "3A", "F minor": "4A",
    "C minor": "5A", "G minor": "6A", "D minor": "7A", "A minor": "8A",
    "E minor": "9A", "B minor": "10A", "F# minor": "11A", "C# minor": "12A",
}

CAMELOT_TO_KEY = {v: k for k, v in CAMELOT.items()}

ENHARMONIC = {
    "Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#",
    "Cb": "B", "Fb": "E", "E#": "F", "B#": "C",
}


def normalize_key(raw: str) -> tuple[str, str] | None:
    s = raw.strip()
    if not s:
        return None
    m_cam = re.fullmatch(r"(\d{1,2})([ABab])", s)
    if m_cam:
        code = f"{int(m_cam.group(1))}{m_cam.group(2).upper()}"
        if code in CAMELOT_TO_KEY:
            return CAMELOT_TO_KEY[code], code
    m = re.fullmatch(r"([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?", s)
    if not m:
        return None
    root = m.group(1).upper() + (m.group(2) or "")
    root = ENHARMONIC.get(root, root)
    qual = (m.group(3) or "").lower()
    mode = "minor" if qual in ("m", "min", "minor") else "major"
    key = f"{root} {mode}"
    cam = CAMELOT.get(key)
    return (key, cam) if cam else None


def read_id3_tags(path: str) -> dict:
    """Zero-dep ID3v2.3/2.4 reader for TBPM, TKEY, and Serato BeatGrid."""
    out: dict = {}
    try:
        with open(path, "rb") as f:
            data = f.read(131072)
    except OSError:
        return out
    if len(data) < 10 or data[:3] != b"ID3":
        return out
    ver = data[3]
    sz = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F)
    pos, end = 10, min(len(data), 10 + sz)
    while pos + 10 <= end:
        fid = data[pos : pos + 4]
        if fid == b"\x00\x00\x00\x00":
            break
        if ver == 4:
            fsz = ((data[pos + 4] & 0x7F) << 21) | ((data[pos + 5] & 0x7F) << 14) | ((data[pos + 6] & 0x7F) << 7) | (data[pos + 7] & 0x7F)
        else:
            fsz = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        if fsz <= 0 or pos + 10 + fsz > end:
            break
        body = data[pos + 10 : pos + 10 + fsz]
        if fid == b"TBPM" and "bpm" not in out:
            try:
                txt = body[1:].decode("latin1", errors="ignore").strip("\x00 ")
                v = float(txt)
                if 30.0 <= v <= 260.0:
                    out["bpm"] = round(v, 2)
            except ValueError:
                pass
        elif fid == b"TKEY":
            txt = body[1:].decode("latin1", errors="ignore").strip("\x00 ")
            nk = normalize_key(txt)
            if nk:
                out["key"], out["camelot"] = nk
        elif fid == b"GEOB" and b"Serato BeatGrid\x00" in body:
            idx = body.find(b"Serato BeatGrid\x00") + 16
            bg = body[idx:]
            if len(bg) >= 14:
                _, _, nmk = struct.unpack(">BBI", bg[:6])
                if nmk >= 1 and len(bg) >= 6 + nmk * 8:
                    first_pos = struct.unpack(">f", bg[6:10])[0]
                    _, bpm = struct.unpack(">ff", bg[6 + (nmk - 1) * 8 : 14 + (nmk - 1) * 8])
                    if 30.0 <= bpm <= 260.0:
                        out["bpm"] = round(float(bpm), 2)
                        out["offset"] = round(max(0.0, float(first_pos)), 4)
        pos += 10 + fsz
    return out


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
    tags = read_id3_tags(path)
    if "bpm" in tags and "key" in tags and "offset" in tags:
        return tags

    import librosa
    import numpy as np

    y, sr = librosa.load(path, mono=True, duration=duration)
    res = dict(tags)
    if "bpm" not in res or "offset" not in res:
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
        tempo = fold_bpm(float(np.atleast_1d(tempo)[0]))
        offset = float(librosa.frames_to_time(beats[0], sr=sr)) if len(beats) else 0.0
        res.setdefault("bpm", round(tempo, 2))
        res.setdefault("offset", round(offset, 4))
    if "key" not in res:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
        root, mode = detect_key([float(c) for c in chroma])
        key = f"{root} {mode}"
        res["key"] = key
        res["camelot"] = CAMELOT.get(key, "")
    return res


def separate_stems(path: str, out_root: Path) -> dict[str, str]:
    cmd = [sys.executable, "-m", "demucs", "-n", "htdemucs", "-o", str(out_root), str(path)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "demucs failed").strip()[-500:])
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
