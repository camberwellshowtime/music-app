#!/usr/bin/env python3
"""
Extract fundamental frequency (pitch) curve from a vocals MP3 using CREPE.
Outputs a compact JSON file: [{t, hz, conf}, ...] at ~10ms intervals.
Entries where confidence < threshold have hz set to null (silence/noise).
"""

import sys
import json
import argparse
import math
import numpy as np
import soundfile as sf
import torchcrepe
import torch
import tempfile
import subprocess
from pathlib import Path

CONFIDENCE_THRESHOLD = 0.5
HOP_LENGTH_MS = 10  # 10ms = 100 samples/sec

# Note segmentation parameters (mirrors segmentMelody in SingAlong.jsx)
MAX_JUMP_ST = 1.5   # semitones — larger jump starts a new segment
MAX_GAP_S   = 0.05  # seconds  — unvoiced gap smaller than this is bridged
MIN_DUR_S   = 0.06  # seconds  — segments shorter than this are discarded

def segment_melody(frames):
    """Collapse raw CREPE frames into discrete note segments [{t, end, hz}].
    Port of segmentMelody() from SingAlong.jsx."""
    notes = []
    seg = None
    gap_lookahead = math.ceil(MAX_GAP_S / (HOP_LENGTH_MS / 1000)) + 2

    def flush():
        nonlocal seg
        if not seg:
            return
        if seg['t_end'] - seg['t_start'] >= MIN_DUR_S:
            hz_sorted = sorted(seg['hz_values'])
            median = hz_sorted[len(hz_sorted) // 2]
            notes.append({'t': round(seg['t_start'], 3), 'end': round(seg['t_end'], 3), 'hz': round(median, 2)})
        seg = None

    for i, d in enumerate(frames):
        if d['hz'] is None:
            if seg:
                next_voiced = next((f for f in frames[i+1:i+gap_lookahead+1] if f['hz']), None)
                if not next_voiced:
                    flush()
            continue
        if seg is None:
            seg = {'hz_values': [d['hz']], 't_start': d['t'], 't_end': d['t']}
            continue
        jump = abs(12 * math.log2(d['hz'] / seg['hz_values'][-1]))
        if jump > MAX_JUMP_ST:
            flush()
            seg = {'hz_values': [d['hz']], 't_start': d['t'], 't_end': d['t']}
        else:
            seg['hz_values'].append(d['hz'])
            seg['t_end'] = d['t']

    flush()
    return notes

def decode_mp3(mp3_path: Path) -> tuple[np.ndarray, int]:
    """Use ffmpeg to decode MP3 to a temporary WAV, then read with soundfile."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(mp3_path), "-ac", "1", "-ar", "16000",
         "-sample_fmt", "s16", tmp_path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"ffmpeg failed for {mp3_path}")

    audio, sr = sf.read(tmp_path, dtype="float32")
    Path(tmp_path).unlink()
    return audio, sr

def extract_pitch(mp3_path: Path, out_path: Path):
    print(f"Decoding {mp3_path.name}...", flush=True)
    audio, sr = decode_mp3(mp3_path)

    hop_samples = int(sr * HOP_LENGTH_MS / 1000)

    print(f"  {len(audio)/sr:.1f}s audio at {sr}Hz, hop={hop_samples} samples ({HOP_LENGTH_MS}ms)", flush=True)
    print("Running CREPE pitch tracker...", flush=True)

    audio_tensor = torch.from_numpy(audio).unsqueeze(0)  # [1, samples]

    # torchcrepe returns frequency and periodicity (confidence) tensors
    frequency, periodicity = torchcrepe.predict(
        audio_tensor,
        sr,
        hop_length=hop_samples,
        fmin=32.7,   # C1 ~32 Hz
        fmax=1975.5, # B6 ~1975 Hz
        model="full",
        return_periodicity=True,
        device="cuda" if torch.cuda.is_available() else "cpu",
        batch_size=512,
        decoder=torchcrepe.decode.weighted_argmax,
    )

    freq_np = frequency.squeeze().numpy()
    conf_np = periodicity.squeeze().numpy()

    n = len(freq_np)
    frames = []
    for i in range(n):
        t = round(i * HOP_LENGTH_MS / 1000, 3)
        conf = float(conf_np[i])
        hz = float(round(float(freq_np[i]), 2)) if conf >= CONFIDENCE_THRESHOLD else None
        frames.append({"t": t, "hz": hz})

    notes = segment_melody(frames)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(notes, f, separators=(",", ":"))

    voiced = sum(1 for fr in frames if fr["hz"] is not None)
    print(f"  {n} frames → {len(notes)} note segments, {voiced} voiced frames ({100*voiced//n}%), saved to {out_path}", flush=True)
    print(f"  File size: {out_path.stat().st_size / 1024:.1f} KB")

def main():
    parser = argparse.ArgumentParser(description="Extract melody curve from vocal MP3")
    parser.add_argument("inputs", nargs="+", help="Vocal MP3 file(s)")
    parser.add_argument("--out-dir", default="src/data/melody",
                        help="Output directory (default: src/data/melody)")
    parser.add_argument("--id", dest="song_id", default=None,
                        help="Override song ID (only valid with a single input file)")
    args = parser.parse_args()

    if args.song_id and len(args.inputs) > 1:
        parser.error("--id can only be used with a single input file")

    out_dir = Path(args.out_dir)
    for mp3 in args.inputs:
        mp3_path = Path(mp3)
        if args.song_id:
            song_id = args.song_id
        else:
            # Derive from filename: "1.1 Song Name.mp3" → "1.1"
            song_id = mp3_path.stem.split(" ")[0]
        out_path = out_dir / f"{song_id}.json"
        extract_pitch(mp3_path, out_path)

if __name__ == "__main__":
    main()
