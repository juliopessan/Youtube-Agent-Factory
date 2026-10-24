#!/usr/bin/env python3
"""Local neural narration with Kokoro (kokoro-onnx). Free, offline after setup.

Reads the narration text from stdin, synthesizes it sentence by sentence (the model caps each
call at ~510 phonemes), joins the pieces with natural pauses and writes a WAV file.
Prints one JSON line with the result on stdout.
"""
import argparse
import json
import re
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
MAX_CHARS = 380  # keeps every call well below the model's phoneme limit


def split_sentences(paragraph):
    pieces = []
    for sentence in SENTENCE_END.split(paragraph.strip()):
        sentence = sentence.strip()
        while len(sentence) > MAX_CHARS:
            cut = max(sentence.rfind(",", 0, MAX_CHARS), sentence.rfind(" ", 0, MAX_CHARS))
            cut = cut if cut > 40 else MAX_CHARS
            pieces.append(sentence[:cut].strip(" ,"))
            sentence = sentence[cut:].strip(" ,")
        if sentence:
            pieces.append(sentence)
    return pieces


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--lang", default="pt-br")
    parser.add_argument("--voice", default="pf_dora")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    text = sys.stdin.read()
    paragraphs = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        print(json.dumps({"error": "empty narration text"}))
        return 1

    kokoro = Kokoro(args.model, args.voices)
    sample_rate = 24000
    parts = []
    sentences = 0
    for p_index, paragraph in enumerate(paragraphs):
        for sentence in split_sentences(paragraph.replace("\n", " ")):
            samples, sample_rate = kokoro.create(sentence, voice=args.voice, speed=args.speed, lang=args.lang)
            parts.append(samples)
            parts.append(np.zeros(int(sample_rate * 0.22), dtype=samples.dtype))
            sentences += 1
        if p_index < len(paragraphs) - 1:
            parts.append(np.zeros(int(sample_rate * 0.35), dtype=np.float32))

    audio = np.concatenate(parts)
    sf.write(args.out, audio, sample_rate)
    print(json.dumps({"seconds": round(len(audio) / sample_rate, 2), "sampleRate": sample_rate, "sentences": sentences, "voice": args.voice}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
