#!/usr/bin/env python3
"""Original ambient music for wellness videos, synthesized offline with numpy.

Slow chord pads (detuned, softly filtered by their own harmonic roll-off), sparse pentatonic
plucks and a gentle amplitude "breathing". Nothing is sampled, so the result is original and
license-free. Long tracks are written block by block, so memory stays flat.

Prints one JSON line: duration, key, mood, chord schedule and the number of plucks.
"""
import argparse
import json
import math
import sys

import numpy as np
import soundfile as sf

SR = 44100
NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
QUALITY = {
    "maj7": [0, 4, 7, 11], "min7": [0, 3, 7, 10], "add9": [0, 4, 7, 14], "sus2": [0, 2, 7, 12],
    "min9": [0, 3, 7, 10, 14], "maj9": [0, 4, 7, 11, 14], "six": [0, 4, 7, 9],
}
# (semitones above the key, quality) per chord, chord length in seconds, pluck density, pad level
MOODS = {
    "sleep": {"key": "A", "chords": [(0, "min9"), (8, "maj7"), (3, "maj9"), (10, "six")], "chord_s": 26, "pluck_s": 15, "pad": 0.9, "octave": 3},
    "calm": {"key": "C", "chords": [(0, "maj9"), (7, "add9"), (9, "min7"), (5, "maj7")], "chord_s": 18, "pluck_s": 8, "pad": 0.85, "octave": 3},
    "focus": {"key": "D", "chords": [(0, "maj7"), (9, "min7"), (5, "maj7"), (7, "six")], "chord_s": 22, "pluck_s": 11, "pad": 0.8, "octave": 3},
    "meditation": {"key": "F", "chords": [(0, "maj7"), (7, "add9"), (2, "min9"), (10, "maj7")], "chord_s": 30, "pluck_s": 18, "pad": 0.95, "octave": 3},
    "morning": {"key": "G", "chords": [(0, "add9"), (5, "maj7"), (9, "min7"), (7, "six")], "chord_s": 16, "pluck_s": 7, "pad": 0.8, "octave": 3},
}
PENTATONIC = [0, 2, 4, 7, 9]  # major pentatonic: no note clashes with any chord of the mood


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def smooth(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def chord_schedule(mood, total):
    """[(start, end, midi_notes, name)] covering the whole track."""
    cfg = MOODS[mood]
    key = NOTE[cfg["key"]]
    schedule, cursor, index = [], 0.0, 0
    while cursor < total:
        offset, quality = cfg["chords"][index % len(cfg["chords"])]
        root = 12 * (cfg["octave"] + 1) + key + offset
        if root > 12 * (cfg["octave"] + 1) + key + 7:
            root -= 12
        notes = [root - 12] + [root + step for step in QUALITY[quality]]
        schedule.append((cursor, cursor + cfg["chord_s"], notes, f"{cfg['key']}+{offset}:{quality}"))
        cursor += cfg["chord_s"]
        index += 1
    return schedule


def pad_block(t, schedule, level, rng_phase):
    """Sum of the chords that are audible in the block; returns (left, right)."""
    left = np.zeros_like(t)
    right = np.zeros_like(t)
    fade = 6.0
    for ci, (start, end, notes, _name) in enumerate(schedule):
        lo, hi = start - fade, end + fade
        if t[-1] < lo or t[0] > hi:
            continue
        env = smooth((t - lo) / fade) * (1 - smooth((t - end) / fade))
        for ni, midi in enumerate(notes):
            f = hz(midi)
            gain = (0.55 if ni == 0 else 1.0) / (1 + 0.12 * ni)
            phase = rng_phase[(ci * 16 + ni) % len(rng_phase)]
            # breathing: a slow, note-specific amplitude swell
            breath = 1 + 0.18 * np.sin(2 * math.pi * (0.05 + 0.011 * ni) * t + phase)
            for detune, pan in ((-3.0, 0.3), (3.4, 0.7)):
                ff = f * 2 ** (detune / 1200)
                tone = np.zeros_like(t)
                for harmonic, amp in enumerate((1.0, 0.42, 0.2, 0.09, 0.04), start=1):
                    tone += amp * np.sin(2 * math.pi * ff * harmonic * t + phase * harmonic)
                tone *= gain * env * breath
                left += tone * (1 - pan)
                right += tone * pan
    return left * level, right * level


def pluck_events(total, mood, rng):
    cfg = MOODS[mood]
    key = NOTE[cfg["key"]]
    events, cursor = [], 6.0
    while cursor < total - 6:
        degree = rng.choice(PENTATONIC)
        octave = rng.choice([5, 5, 6])
        events.append((cursor, 12 * (octave + 1) + key + degree, rng.uniform(0.35, 1.0), rng.uniform(0.15, 0.85)))
        cursor += rng.exponential(cfg["pluck_s"]) + 2.5
    return events


def pluck_block(t, events):
    left = np.zeros_like(t)
    right = np.zeros_like(t)
    for start, midi, velocity, pan in events:
        if t[-1] < start or t[0] > start + 12:
            continue
        local = t - start
        active = local >= 0
        env = np.where(active, np.minimum(local / 0.02, 1.0) * np.exp(-np.maximum(local, 0) / 2.1), 0.0)
        f = hz(midi)
        tone = (np.sin(2 * math.pi * f * local) + 0.18 * np.sin(2 * math.pi * 2 * f * local) + 0.06 * np.sin(2 * math.pi * 3 * f * local)) * env * velocity * 0.22
        left += tone * (1 - pan)
        right += tone * pan
    return left, right


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mood", default="calm", choices=sorted(MOODS))
    parser.add_argument("--minutes", type=float, default=4.0)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    total = max(10.0, args.minutes * 60.0)
    rng = np.random.default_rng(args.seed)
    phases = rng.uniform(0, 2 * math.pi, 64)
    schedule = chord_schedule(args.mood, total)
    plucks = pluck_events(total, args.mood, rng)
    level = 0.05 * MOODS[args.mood]["pad"]
    block = int(SR * 20)
    done = 0
    peak = 1e-9
    with sf.SoundFile(args.out, "w", samplerate=SR, channels=2, subtype="PCM_16") as out:
        while done < int(total * SR):
            n = min(block, int(total * SR) - done)
            t = (done + np.arange(n)) / SR
            pl, pr = pad_block(t, schedule, level, phases)
            bl, br = pluck_block(t, plucks)
            left, right = pl + bl, pr + br
            # fade the whole track in and out so loops and cuts never click
            gain = smooth(t / 8.0) * smooth((total - t) / 10.0)
            stereo = np.stack([np.tanh(left * 1.6) * gain, np.tanh(right * 1.6) * gain], axis=1)
            peak = max(peak, float(np.abs(stereo).max()))
            out.write((stereo * 0.8).astype(np.float32))
            done += n
    print(json.dumps({
        "seconds": round(total, 2), "key": MOODS[args.mood]["key"], "mood": args.mood, "plucks": len(plucks),
        "chords": [{"start": round(s, 2), "name": name} for s, _e, _n, name in schedule[:64]], "peak": round(peak * 0.8, 3)
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
