"""Voice timeline: phrase-by-phrase TTS joined with fixed gaps, plus per-word times.

Usage: python -m scenecast_py.voice --spec <input.json> --out <dir>

input.json: {"voice": {"name", "lang", "speed", "phraseGapSec"},
             "models": {"kokoro", "voices", "whisper"} | null,
             "scenes": [{"id": str, "phrases": [str, ...], "gaps": [float, ...]?}]}
`gaps[i]` is the silence before phrase i (gaps[0] is 0); without `gaps`, phraseGapSec goes between every phrase.
Writes <dir>/<scene>.wav (24 kHz mono) and <dir>/timeline.json. Times are seconds from scene start.

Word times come from forced alignment of each phrase clip against its known text (scenecast_py.align). When a
phrase can't be aligned, the scene falls back to the free transcript mapped onto the script (`align_words`).

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


def build_scene(phrases, tts, gap_sec, voice="af_heart", speed=1.0, lang="en-us", gaps=None):
    """Synthesise each phrase and join them with silence: `gaps[i]` seconds before phrase i (gaps[0] is ignored), or
    `gap_sec` between every phrase when `gaps` is None. Returns (audio, timeline)."""
    if gaps is not None and len(gaps) != len(phrases):
        raise ValueError(f"{len(gaps)} gaps for {len(phrases)} phrases")
    parts, spans, cursor = [], [], 0
    for i, text in enumerate(phrases):
        if i:
            gap = np.zeros(round((gap_sec if gaps is None else gaps[i]) * SAMPLE_RATE), dtype=np.float32)
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
ALIGN_PAD_SEC = 0.3  # silence around each phrase clip while aligning it, as context for the first and last word


def resample_16k(audio):
    """24 kHz voice audio as the 16 kHz array Whisper takes (linear interpolation; skips PyAV file decoding)."""
    n = round(len(audio) * WHISPER_RATE / SAMPLE_RATE)
    x = np.arange(n) * (SAMPLE_RATE / WHISPER_RATE)
    return np.interp(x, np.arange(len(audio)), audio).astype(np.float32)


def _heard_words(model, audio):
    """Recognised words with times from free decoding (the fallback when forced alignment fails)."""
    segments, _ = model.transcribe(resample_16k(audio), language="en", word_timestamps=True, beam_size=5)
    return [{"w": w.word, "start": w.start, "end": w.end} for s in segments for w in (s.words or [])]


def forced_words(model, audio, phrases, pad=ALIGN_PAD_SEC):
    """Word times by forced alignment of each phrase clip (with `pad` of silence on each side) against its text.

    Returns [{w, start, end}] for every script word, each kept inside its phrase, or None when any phrase gives the
    wrong word count or a start before the previous word's start (the caller then falls back to `align_words`).
    """
    from scenecast_py import align

    silence = np.zeros(round(pad * SAMPLE_RATE), dtype=np.float32)
    words = []
    for p in phrases:
        clip = audio[round(p["start"] * SAMPLE_RATE):round(p["end"] * SAMPLE_RATE)]
        pcm = resample_16k(np.concatenate([silence, clip, silence]))
        try:
            got = align.align_text(model, pcm, p["text"], offset=p["start"] - pad)
        except (ValueError, RuntimeError, IndexError):
            return None
        if [w["w"] for w in got] != p["text"].split():
            return None
        for w in got:
            start = min(max(w["start"], p["start"]), p["end"])
            if words and start < words[-1]["start"]:
                return None
            words.append({"w": w["w"], "start": start, "end": min(max(w["end"], start), p["end"])})
    return words


def scene_words(model, audio, phrases):
    """Per-word times for a voiced scene: forced alignment, else the free transcript mapped onto the script, else
    (no model, or no audio) each phrase's words spread by character position."""
    if model is None or not len(audio):
        return align_words(phrases, [])
    words = forced_words(model, audio, phrases)
    return words if words is not None else align_words(phrases, _heard_words(model, audio))


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
        audio, tl = build_scene(scene["phrases"], tts, v["phraseGapSec"], v["name"], v["speed"], v["lang"],
                                gaps=scene.get("gaps"))
        wav = out_dir / f"{scene['id']}.wav"
        sf.write(str(wav), audio, SAMPLE_RATE, subtype="PCM_16")
        tl["words"] = scene_words(whisper, audio, tl["phrases"])
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
