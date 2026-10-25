import os

import numpy as np
import pytest

from scenecast_py.voice import SAMPLE_RATE, FakeTTS, align_words, build_scene, fallback_word_times

E2E = pytest.mark.skipif(not os.environ.get("SCENECAST_E2E"), reason="set SCENECAST_E2E=1 for real models")


def test_phrases_joined_with_gap():
    phrases = ["Welcome to the dashboard.", "Tick the box,", "and press Sign."]
    audio, timeline = build_scene(phrases, FakeTTS(), gap_sec=0.20)
    assert timeline["duration"] == pytest.approx(3.4)
    assert len(audio) == round(3.4 * SAMPLE_RATE)
    assert [(p["start"], p["end"]) for p in timeline["phrases"]] == pytest.approx(
        [(0.0, 1.0), (1.2, 2.2), (2.4, 3.4)]
    )
    assert [p["text"] for p in timeline["phrases"]] == phrases


def test_fallback_word_times_follow_characters():
    words = fallback_word_times("Tick the box", 1.0, 2.2)
    assert [w["w"] for w in words] == ["Tick", "the", "box"]
    assert words[0]["start"] == pytest.approx(1.0)
    assert words[-1]["end"] == pytest.approx(2.2)
    for a, b in zip(words, words[1:]):
        assert a["start"] < a["end"] <= b["start"] < b["end"]


def test_align_words_maps_recognised_and_falls_back():
    phrases = [{"text": "Type 42 orders, then press Sign.", "start": 0.0, "end": 3.0}]
    heard = [
        {"w": " Type", "start": 0.10, "end": 0.40},
        {"w": " forty-two", "start": 0.45, "end": 0.90},
        {"w": " orders,", "start": 0.95, "end": 1.30},
        {"w": " then", "start": 1.40, "end": 1.60},
        {"w": " sign.", "start": 2.30, "end": 2.70},
    ]
    words = align_words(phrases, heard)
    assert [w["w"] for w in words] == ["Type", "42", "orders,", "then", "press", "Sign."]
    assert (words[1]["start"], words[1]["end"]) == (0.45, 0.90)
    assert (words[5]["start"], words[5]["end"]) == (2.30, 2.70)
    # "press" was not heard: character-position fallback, kept in order
    assert words[3]["end"] <= words[4]["start"] <= words[5]["start"]
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)


@E2E
def test_kokoro_synthesises_speech():
    from pathlib import Path

    from scenecast_py.kokoro import Kokoro

    models = Path(os.environ.get("SCENECAST_CACHE") or Path.home() / ".cache" / "scenecast") / "models"
    tts = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
    audio = tts.create("Welcome to the dashboard.", voice="af_heart", speed=0.9, lang="en-us")
    assert audio.dtype == np.float32
    seconds = len(audio) / SAMPLE_RATE
    assert 1.0 <= seconds <= 4.0
    assert float(np.sqrt(np.mean(audio**2))) > 0.01


def test_trim_silence_drops_padding_only():
    from scenecast_py.kokoro import trim_silence

    tone = (0.3 * np.sin(np.arange(SAMPLE_RATE) * 2 * np.pi * 220 / SAMPLE_RATE)).astype(np.float32)
    pad = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
    out = trim_silence(np.concatenate([pad, tone, pad]))
    assert SAMPLE_RATE <= len(out) <= SAMPLE_RATE + 2 * 2048  # one frame of slack per side
    assert len(trim_silence(np.zeros(SAMPLE_RATE, dtype=np.float32))) == 0


def test_long_phonemes_split_at_punctuation_within_token_limit():
    from scenecast_py.kokoro import MAX_TOKENS, chunk_phonemes, tokenize

    clause = "ðə kwɪk bɹWn fɑks ʤʌmps, "
    text = clause * 40
    chunks = chunk_phonemes(text)
    assert len(chunks) > 1
    assert all(len(tokenize(c)) <= MAX_TOKENS for c in chunks)
    assert all(c.rstrip().endswith(",") for c in chunks)
    assert "".join(c.replace(" ", "") for c in chunks) == text.replace(" ", "")
    assert all(len(tokenize(c)) <= MAX_TOKENS for c in chunk_phonemes("a" * 1200))
