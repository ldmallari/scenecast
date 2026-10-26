"""Voice timeline: phrase-by-phrase TTS joined with fixed gaps, plus per-word times.

Usage: python -m scenecast_py.voice --spec <input.json> --out <dir>

input.json: {"voice": {"name", "lang", "speed", "phraseGapSec"},
             "models": {"kokoro", "voices", "whisper"} | null,
             "scenes": [{"id": str, "phrases": [str, ...], "gaps": [float, ...]?}]}
`gaps[i]` is the silence before phrase i (gaps[0] is 0); without `gaps`, phraseGapSec goes between every phrase.
Writes <dir>/<scene>.wav (24 kHz mono) and <dir>/timeline.json. Times are seconds from scene start.

Word times come from forced alignment of each phrase clip against its known text (scenecast_py.align). A phrase
that can't be aligned falls back on its own to the free transcript mapped onto it (`align_words`), with a log line.
Each word records where its time came from (`from`), and each aligned phrase its first word's `onset`.

SCENECAST_FAKE_TTS=1 swaps Kokoro for 1.0 s of silence per phrase and skips whisper
(word times then come from the character-position fallback only).
"""
import argparse
import difflib
import json
import os
import re
import sys
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
        "phrases": [{**p, "start": r(p["start"]), "end": r(p["end"]), **({"onset": r(p["onset"])} if "onset" in p else {})}
                    for p in scene["phrases"]],
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


def _log(message):
    print(f"scenecast: voice: {message}", file=sys.stderr, flush=True)


def _forced_phrase(model, audio, p, pad):
    """Forced word times for one phrase clip (padded with `pad` of silence each side), kept inside the phrase, or
    raises AlignmentError (or anything the aligner raised)."""
    from scenecast_py import align

    silence = np.zeros(round(pad * SAMPLE_RATE), dtype=np.float32)
    clip = audio[round(p["start"] * SAMPLE_RATE):round(p["end"] * SAMPLE_RATE)]
    got = align.align_text(model, resample_16k(np.concatenate([silence, clip, silence])), p["text"], offset=p["start"] - pad)
    if [w["w"] for w in got] != p["text"].split():
        raise align.AlignmentError("the word count differs")
    words = []
    for w in got:
        start = min(max(w["start"], p["start"]), p["end"])
        if words and not start > words[-1]["start"]:
            raise align.AlignmentError(f'"{w["w"]}" does not start after "{words[-1]["w"]}" inside the phrase')
        words.append({"w": w["w"], "start": start, "end": min(max(w["end"], start), p["end"]), "from": w["from"]})
    return words


def _fallback_phrase(p, heard):
    """One phrase's words from the free transcript (the heard words inside the phrase), else by character position."""
    near = [h for h in heard if h["end"] > p["start"] and h["start"] < p["end"]]
    words = align_words([p], near)
    matched = _align([normalise(w["w"]) for w in fallback_word_times(p["text"], 0, 1)], [normalise(h["w"]) for h in near])
    for i, w in enumerate(words):
        w["start"] = min(max(w["start"], p["start"]), p["end"])
        w["end"] = min(max(w["end"], w["start"]), p["end"])
        w["from"] = "free" if i in matched else "position"
    return words


def forced_words(model, audio, phrases, pad=ALIGN_PAD_SEC, heard=None):
    """Word times by forced alignment of each phrase clip (with `pad` of silence on each side) against its text.

    A phrase whose alignment fails or can't be trusted (wrong word count, starts not strictly increasing) falls back
    on its own, to the free transcript of the scene (`heard()`, called at most once) mapped onto that phrase, and the
    fallback is logged. Returns [{w, start, end, from}] for every script word, each inside its phrase; `from` is
    "onset", "forced", "free" or "position". Each phrase also gets `onset`: its first word's start from the phrase
    start, when that comes from the clean clip ("onset"); the audit times the phrase's first word with it.
    """
    words, cache = [], {}

    def transcript():
        if "heard" not in cache:
            cache["heard"] = heard() if heard else []
        return cache["heard"]

    for p in phrases:
        try:
            got = _forced_phrase(model, audio, p, pad)
        except Exception as e:  # noqa: BLE001 (any aligner failure falls back for this phrase only)
            _log(f'phrase at {p["start"]:.3f} s ("{p["text"][:40]}") falls back to the free transcript: {e}')
            got = _fallback_phrase(p, transcript())
        if words and got and got[0]["start"] < words[-1]["start"]:
            got[0]["start"] = words[-1]["start"]
            got[0]["end"] = max(got[0]["end"], got[0]["start"])
        if got and got[0]["from"] == "onset":
            p["onset"] = got[0]["start"] - p["start"]
        words += got
    return words


def scene_words(model, audio, phrases):
    """Per-word times for a voiced scene: forced alignment phrase by phrase (falling back per phrase), or, with no
    model or no audio, each phrase's words spread by character position."""
    if model is None or not len(audio):
        words = align_words(phrases, [])
        for w in words:
            w["from"] = "position"
        return words
    return forced_words(model, audio, phrases, heard=lambda: _heard_words(model, audio))


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
