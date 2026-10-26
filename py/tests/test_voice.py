import os

import numpy as np
import pytest

from scenecast_py.voice import SAMPLE_RATE, FakeTTS, align_words, build_scene, fallback_word_times, forced_words

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


def test_clause_gaps_follow_the_plan():
    audio, tl = build_scene(["a:", "b;", "c."], FakeTTS(), 0.2, gaps=[0, 0.15, 0.2])
    assert tl["duration"] == pytest.approx(3.35)
    assert [p["start"] for p in tl["phrases"]] == pytest.approx([0, 1.15, 2.35])
    assert len(audio) == round(3.35 * SAMPLE_RATE)


def test_gaps_must_match_the_phrases():
    with pytest.raises(ValueError, match="gaps"):
        build_scene(["a.", "b."], FakeTTS(), 0.2, gaps=[0])


def test_run_reads_the_gaps_from_the_input(tmp_path):
    from scenecast_py.voice import run

    spec = {"voice": {"name": "af_heart", "lang": "en-us", "speed": 0.9, "phraseGapSec": 0.2},
            "models": None,
            "scenes": [{"id": "s1", "phrases": ["Two things matter here:", "speed and care."], "gaps": [0, 0.15]},
                       {"id": "s2", "phrases": ["One.", "Two."]}]}  # a v1 input with no gaps: phraseGapSec
    tl = run(spec, tmp_path, fake=True)
    assert [p["start"] for p in tl["scenes"]["s1"]["phrases"]] == [0, 1.15]
    assert [p["start"] for p in tl["scenes"]["s2"]["phrases"]] == [0, 1.2]


class _Clip:
    """A 24 kHz scene with two 1 s phrases at 0-1 s and 1.2-2.2 s."""

    phrases = [{"text": "Open the menu,", "start": 0.0, "end": 1.0}, {"text": "then press Save.", "start": 1.2, "end": 2.2}]
    audio = np.zeros(round(2.2 * SAMPLE_RATE), dtype=np.float32)


def test_forced_words_align_each_phrase_clip_with_padding(monkeypatch):
    import scenecast_py.align as align

    calls = []

    def fake(model, pcm, text, offset=0.0):
        calls.append((len(pcm), offset))
        # Times inside the padded clip: speech starts after the 0.3 s pad.
        return [{"w": w, "start": offset + 0.3 + 0.25 * i, "end": offset + 0.5 + 0.25 * i, "p": 1.0}
                for i, w in enumerate(text.split())]

    monkeypatch.setattr(align, "align_text", fake)
    words = forced_words("model", _Clip.audio, _Clip.phrases)
    # Each clip is 1 s of speech with 0.3 s of silence on each side, at 16 kHz; offsets put the pad before the phrase.
    assert calls == [(round(1.6 * 16000), pytest.approx(-0.3)), (round(1.6 * 16000), pytest.approx(0.9))]
    assert [w["w"] for w in words] == "Open the menu, then press Save.".split()
    assert [w["start"] for w in words] == pytest.approx([0.0, 0.25, 0.5, 1.2, 1.45, 1.7])
    assert set(words[0]) == {"w", "start", "end"}


def test_forced_words_reject_a_wrong_count_or_times_going_back(monkeypatch):
    import scenecast_py.align as align

    monkeypatch.setattr(align, "align_text", lambda m, pcm, text, offset=0.0: [{"w": "Open", "start": offset, "end": offset, "p": 1}])
    assert forced_words("model", _Clip.audio, _Clip.phrases) is None

    def backwards(m, pcm, text, offset=0.0):
        n = len(text.split())
        return [{"w": w, "start": offset + 0.3 + 0.1 * (n - i), "end": offset + 0.4 + 0.1 * (n - i), "p": 1} for i, w in enumerate(text.split())]

    monkeypatch.setattr(align, "align_text", backwards)
    assert forced_words("model", _Clip.audio, _Clip.phrases) is None


def test_run_falls_back_to_the_free_transcript_when_alignment_fails(monkeypatch, tmp_path):
    import scenecast_py.voice as voice

    heard = [{"w": " Open", "start": 0.1, "end": 0.3}]
    monkeypatch.setattr(voice, "forced_words", lambda model, audio, phrases: None)
    monkeypatch.setattr(voice, "_heard_words", lambda model, audio: heard)
    words = voice.scene_words("model", _Clip.audio, _Clip.phrases)
    assert words[0]["start"] == pytest.approx(0.1)
    assert [w["w"] for w in words] == "Open the menu, then press Save.".split()
