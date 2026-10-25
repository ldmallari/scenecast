"""Voice timeline: phrase-by-phrase TTS joined with fixed gaps, plus per-word times.

Usage: python -m scenecast_py.voice --spec <input.json> --out <dir>

input.json: {"voice": {"name", "lang", "speed", "phraseGapSec"},
             "models": {"kokoro", "voices", "whisper"} | null,
             "scenes": [{"id": str, "phrases": [str, ...]}]}
Writes <dir>/<scene>.wav (24 kHz mono) and <dir>/timeline.json. Times are seconds from scene start.

SCENECAST_FAKE_TTS=1 swaps Kokoro for 1.0 s of silence per phrase and skips whisper
(word times then come from the character-position fallback only).
"""
import argparse
import difflib
import json
import os
import re
from pathlib import Path

import numpy as np

SAMPLE_RATE = 24000


class FakeTTS:
    """Test backend: 1.0 s of silence per phrase."""

    def create(self, text, voice=None, speed=1.0, lang="en-us"):
        return np.zeros(SAMPLE_RATE, dtype=np.float32)


def build_scene(phrases, tts, gap_sec, voice="af_heart", speed=1.0, lang="en-us"):
    """Synthesise each phrase and join them with `gap_sec` of silence. Returns (audio, timeline)."""
    gap = np.zeros(round(gap_sec * SAMPLE_RATE), dtype=np.float32)
    parts, spans, cursor = [], [], 0
    for i, text in enumerate(phrases):
        if i:
            parts.append(gap)
            cursor += len(gap)
        clip = np.asarray(tts.create(text, voice=voice, speed=speed, lang=lang), dtype=np.float32)
        spans.append({"text": text, "start": cursor / SAMPLE_RATE, "end": (cursor + len(clip)) / SAMPLE_RATE})
        parts.append(clip)
        cursor += len(clip)
    audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    return audio, {"duration": cursor / SAMPLE_RATE, "phrases": spans}


def fallback_word_times(text, start, end):
    """Spread a phrase's words over [start, end] by character position."""
    total = max(len(text), 1)
    span = end - start
    return [
        {"w": m.group(), "start": start + span * m.start() / total, "end": start + span * m.end() / total}
        for m in re.finditer(r"\S+", text)
    ]


def normalise(word):
    """Comparable form of a word: lowercase letters/digits only, numbers spelled out."""
    from num2words import num2words

    w = word.strip().lower().strip(".,;:!?\"'()[]“”‘’…—-")
    try:
        if re.fullmatch(r"\d+(st|nd|rd|th)", w):
            w = num2words(int(w[:-2]), to="ordinal")
        elif re.fullmatch(r"\d[\d,]*(\.\d+)?", w):
            w = num2words(float(w.replace(",", "")) if "." in w else int(w.replace(",", "")))
    except (ValueError, OverflowError):
        pass
    return re.sub(r"[^a-z0-9]", "", w)


def _similarity(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if min(len(a), len(b)) >= 4 and difflib.SequenceMatcher(None, a, b).ratio() >= 0.8:
        return 0.5
    return 0.0


def _align(script, heard):
    """Dynamic-programming alignment (weighted LCS). Returns {script_index: heard_index}."""
    n, m = len(script), len(heard)
    score = np.zeros((n + 1, m + 1))
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            sim = _similarity(script[i], heard[j])
            best = max(score[i + 1, j], score[i, j + 1])
            score[i, j] = max(best, score[i + 1, j + 1] + sim) if sim else best
    pairs, i, j = {}, 0, 0
    while i < n and j < m:
        sim = _similarity(script[i], heard[j])
        if sim and score[i, j] == score[i + 1, j + 1] + sim:
            pairs[i] = j
            i, j = i + 1, j + 1
        elif score[i + 1, j] >= score[i, j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def align_words(phrases, heard):
    """Map recognised words (with times) onto the script words of `phrases`.

    Unmatched script words fall back to their character position within their phrase,
    clamped between their neighbours so times stay in order.
    """
    words = [w for p in phrases for w in fallback_word_times(p["text"], p["start"], p["end"])]
    pairs = _align([normalise(w["w"]) for w in words], [normalise(h["w"]) for h in heard])
    matched = [i in pairs for i in range(len(words))]
    for i, j in pairs.items():
        words[i]["start"], words[i]["end"] = heard[j]["start"], heard[j]["end"]
    prev_end = 0.0
    for i, w in enumerate(words):
        if not matched[i]:
            nxt = next((words[k]["start"] for k in range(i + 1, len(words)) if matched[k]), None)
            w["start"] = max(w["start"], prev_end)
            if nxt is not None:
                w["start"] = min(w["start"], nxt)
                w["end"] = min(w["end"], nxt)
            w["end"] = max(w["end"], w["start"])
        prev_end = max(prev_end, w["end"])
    return words


def _round(scene):
    r = lambda t: round(float(t), 3)  # noqa: E731
    return {
        "duration": r(scene["duration"]),
        "phrases": [{**p, "start": r(p["start"]), "end": r(p["end"])} for p in scene["phrases"]],
        "words": [{**w, "start": r(w["start"]), "end": r(w["end"])} for w in scene["words"]],
    }


WHISPER_RATE = 16000


def _heard_words(model, audio):
    """Recognised words with times. Audio goes in as a 16 kHz array (skips PyAV file decoding)."""
    n = round(len(audio) * WHISPER_RATE / SAMPLE_RATE)
    x = np.arange(n) * (SAMPLE_RATE / WHISPER_RATE)
    pcm = np.interp(x, np.arange(len(audio)), audio).astype(np.float32)
    segments, _ = model.transcribe(pcm, language="en", word_timestamps=True, beam_size=5)
    return [{"w": w.word, "start": w.start, "end": w.end} for s in segments for w in (s.words or [])]


def run(spec, out_dir, fake=False):
    import soundfile as sf

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    v = spec["voice"]
    if fake:
        tts, whisper = FakeTTS(), None
    else:
        from scenecast_py.kokoro import Kokoro
        from scenecast_py.whisper import whisper_model

        models = spec["models"]
        tts = Kokoro(models["kokoro"], models["voices"])
        whisper = whisper_model(models["whisper"])

    scenes = {}
    for scene in spec["scenes"]:
        audio, tl = build_scene(scene["phrases"], tts, v["phraseGapSec"], v["name"], v["speed"], v["lang"])
        wav = out_dir / f"{scene['id']}.wav"
        sf.write(str(wav), audio, SAMPLE_RATE, subtype="PCM_16")
        heard = _heard_words(whisper, audio) if whisper and len(audio) else []
        tl["words"] = align_words(tl["phrases"], heard)
        scenes[scene["id"]] = _round(tl)

    timeline = {"scenes": scenes}
    (out_dir / "timeline.json").write_text(json.dumps(timeline, indent=2, ensure_ascii=False))
    return timeline


def main():
    ap = argparse.ArgumentParser(prog="scenecast_py.voice")
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    spec = json.loads(Path(a.spec).read_text())
    run(spec, a.out, fake=os.environ.get("SCENECAST_FAKE_TTS") == "1")


if __name__ == "__main__":
    main()
