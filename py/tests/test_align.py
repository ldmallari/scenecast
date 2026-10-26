import os
from pathlib import Path

import numpy as np
import pytest

from scenecast_py.align import align_phrases, align_text, refine_onset, words_from_tokens

E2E = pytest.mark.skipif(not os.environ.get("SCENECAST_E2E"), reason="set SCENECAST_E2E=1 for real models")
CACHE = Path(os.environ.get("SCENECAST_CACHE") or Path.home() / ".cache" / "scenecast") / "models"


def test_words_from_tokens_maps_back_to_whitespace_words():
    pieces = [{"word": " Sign", "start": 0.0, "end": 0.2}, {"word": "-", "start": 0.2, "end": 0.25},
              {"word": "in", "start": 0.25, "end": 0.4}, {"word": " $1,500", "start": 0.5, "end": 0.9},
              {"word": " at", "start": 1.0, "end": 1.1}, {"word": " 9:30.", "start": 1.1, "end": 1.6}]
    out = words_from_tokens("Sign-in $1,500 at 9:30.", pieces)
    assert [w["w"] for w in out] == ["Sign-in", "$1,500", "at", "9:30."]
    assert [(w["start"], w["end"]) for w in out] == [(0.0, 0.4), (0.5, 0.9), (1.0, 1.1), (1.1, 1.6)]


def test_words_from_tokens_handles_split_punctuation_and_symbols():
    # Whisper splits trailing punctuation and symbols into pieces of their own; each still belongs to its word.
    text = "Email, then “Save” — done!"
    pieces = [{"word": " Email", "start": 0.1, "end": 0.4, "probability": 0.9}, {"word": ",", "start": 0.4, "end": 0.4, "probability": 0.5},
              {"word": " then", "start": 0.5, "end": 0.7, "probability": 1.0}, {"word": " “", "start": 0.7, "end": 0.7, "probability": 1.0},
              {"word": "Save", "start": 0.7, "end": 1.0, "probability": 1.0}, {"word": "”", "start": 1.0, "end": 1.0, "probability": 1.0},
              {"word": " —", "start": 1.0, "end": 1.1, "probability": 1.0}, {"word": " done", "start": 1.2, "end": 1.5, "probability": 1.0},
              {"word": "!", "start": 1.5, "end": 1.5, "probability": 1.0}]
    out = words_from_tokens(text, pieces)
    assert [w["w"] for w in out] == text.split()
    assert [(w["start"], w["end"]) for w in out] == [(0.1, 0.4), (0.5, 0.7), (0.7, 1.0), (1.0, 1.1), (1.2, 1.5)]
    assert out[0]["p"] == pytest.approx(0.7)


def test_words_from_tokens_always_gives_one_time_per_word_in_order():
    # Pieces that don't spell the text (a decode mismatch), and pieces missing at the end: still one entry per word,
    # never going backwards.
    text = "Open the menu now"
    out = words_from_tokens(text, [{"word": " Opne", "start": 0.2, "end": 0.5}, {"word": " th", "start": 0.6, "end": 0.7}])
    assert [w["w"] for w in out] == text.split()
    starts = [w["start"] for w in out]
    assert starts == sorted(starts)
    assert all(w["end"] >= w["start"] for w in out)
    assert words_from_tokens("Hello there", []) == [
        {"w": "Hello", "start": 0.0, "end": 0.0, "p": None}, {"w": "there", "start": 0.0, "end": 0.0, "p": None}]


def _tone(sec, db, rate=16000):
    t = np.arange(round(sec * rate))
    return (10 ** (db / 20) * np.sqrt(2) * np.sin(2 * np.pi * 300 * t / rate)).astype(np.float32)


def test_refine_onset_walks_back_to_a_quiet_first_sound_across_a_stop():
    # "speed": a quiet "s" (-30 dB) at 0.30 s, a 50 ms closure, then the voiced part where the VAD fires (0.45 s).
    pcm = np.concatenate([np.zeros(4800, np.float32), _tone(0.10, -30), np.zeros(800, np.float32), _tone(0.5, -15)])
    assert refine_onset(pcm, round(0.45 * 16000)) == pytest.approx(0.30, abs=0.011)


def test_refine_onset_keeps_the_vad_start_when_nothing_louder_comes_before_it():
    rng = np.random.default_rng(0)
    bed = (0.016 * rng.standard_normal(16000)).astype(np.float32)  # a bed at about -36 dB
    pcm = bed.copy()
    pcm[4800:6400] += _tone(0.10, -38)  # a consonant under the bed: hidden
    pcm[7200:] += _tone(0.55, -15)
    assert refine_onset(pcm, 7200) == pytest.approx(0.45, abs=0.011)
    # Silence well before the voice (more than the 80 ms bridge) is never crossed.
    far = np.concatenate([_tone(0.05, -30), np.zeros(3200, np.float32), _tone(0.5, -15)])
    assert refine_onset(far, 4000) == pytest.approx(0.25, abs=0.011)
    assert refine_onset(far, 0) == 0.0


class FakeAligner:
    """Stands in for faster-whisper: records the windows it is given and returns evenly spread word pieces."""

    def __init__(self):
        self.calls = []

    def __call__(self, model, pcm, text, offset=0.0):
        self.calls.append((len(pcm), text, offset))
        words = text.split()
        step = len(pcm) / 16000 / (len(words) + 1)
        return [{"w": w, "start": offset + step * (i + 1), "end": offset + step * (i + 1.5), "p": 1.0} for i, w in enumerate(words)]


def test_align_phrases_widens_each_window_and_returns_video_clock_times(monkeypatch):
    import scenecast_py.align as align

    fake = FakeAligner()
    monkeypatch.setattr(align, "align_text", fake)
    pcm = np.zeros(16000 * 10, dtype=np.float32)
    phrases = [{"start": 1.0, "end": 2.0, "text": "Open the menu,"}, {"start": 2.2, "end": 3.5, "text": "then press Save."},
               {"start": 4.5, "end": 5.0, "text": "Done."}]
    out = align_phrases(pcm, phrases, model=None)
    assert [w["w"] for w in out] == "Open the menu, then press Save. Done.".split()
    # 0.4 s each side, but never into the phrase before or after: [0.6, 2.2], [2.0, 3.9], [4.1, 5.4].
    assert [c[2] for c in fake.calls] == pytest.approx([0.6, 2.0, 4.1])
    assert [c[0] for c in fake.calls] == [round(1.6 * 16000), round(1.9 * 16000), round(1.3 * 16000)]
    # Each word is kept inside its own phrase.
    assert all(1.0 <= w["start"] <= 2.0 for w in out[:3]) and all(2.2 <= w["start"] <= 3.5 for w in out[3:6])


def test_align_phrases_leaves_a_phrase_it_cannot_align_untimed(monkeypatch):
    import scenecast_py.align as align

    def broken(model, pcm, text, offset=0.0):
        if text.startswith("then"):
            raise ValueError("no alignment")
        return FakeAligner()(model, pcm, text, offset)

    monkeypatch.setattr(align, "align_text", broken)
    pcm = np.zeros(16000 * 5, dtype=np.float32)
    out = align_phrases(pcm, [{"start": 0.5, "end": 1.5, "text": "Open it,"}, {"start": 1.7, "end": 2.5, "text": "then go."}], model=None)
    assert [w["w"] for w in out] == ["Open", "it,", "then", "go."]
    assert out[0]["start"] is not None and out[2]["start"] is None and out[3]["start"] is None


# ---------------------------------------------------------------- real models


def whisper():
    from scenecast_py.whisper import whisper_model

    model_dir = next((p.parent for p in (CACHE / "whisper").rglob("model.bin")), None)
    assert model_dir is not None, "run ensureToolchain() first"
    return whisper_model(str(model_dir))


def kokoro_16k(text, lead_sec=0.0):
    from scenecast_py.kokoro import Kokoro
    from scenecast_py.voice import SAMPLE_RATE, resample_16k

    tts = Kokoro(str(CACHE / "kokoro-v1.0.onnx"), str(CACHE / "voices-v1.0.bin"))
    audio = tts.create(text, voice="af_heart", speed=0.9, lang="en-us")
    audio = np.concatenate([np.zeros(round(lead_sec * SAMPLE_RATE), dtype=np.float32), audio])
    return resample_16k(audio)


def first_sample_over(pcm, level):
    return int(np.argmax(np.abs(pcm) > level))


@E2E
def test_align_text_gives_one_increasing_time_per_word():
    text = "Open the menu, then choose Settings and press Save."
    pcm = kokoro_16k(text, lead_sec=0.3)
    words = align_text(whisper(), pcm, text)
    assert [w["w"] for w in words] == text.split()
    assert all(b["start"] > a["start"] for a, b in zip(words, words[1:]))


@E2E
def test_align_text_finds_the_first_word_after_silence():
    pcm = kokoro_16k("Welcome to the dashboard.", lead_sec=3.0)
    onset = first_sample_over(pcm, 0.02) / 16000
    assert abs(align_text(whisper(), pcm, "Welcome to the dashboard.")[0]["start"] - onset) <= 0.15


@E2E
def test_align_text_separates_adjacent_words_free_whisper_gives_one_start():
    """v1 evidence: free-running Whisper gave two adjacent words (a room name and the word after it) the same start.
    Forced alignment of the known script gives each its own, in order, with punctuation and numbers kept whole."""
    text = "Book the Garden Room, then invite the Design Team at 9:30 for $1,500."
    pcm = kokoro_16k(text, lead_sec=0.3)
    words = align_text(whisper(), pcm, text, offset=10.0)
    assert [w["w"] for w in words] == text.split()
    assert all(b["start"] > a["start"] for a, b in zip(words, words[1:]))
    assert words[0]["start"] >= 10.0


@E2E
def test_align_phrases_times_each_phrase_start_on_a_joined_voice_track():
    """The audit's case: phrases joined with clause and phrase gaps, aligned on the video clock with 0.4 s windows."""
    from scenecast_py.kokoro import Kokoro
    from scenecast_py.voice import build_scene, resample_16k

    tts = Kokoro(str(CACHE / "kokoro-v1.0.onnx"), str(CACHE / "voices-v1.0.bin"))
    texts = ["Two things matter here:", "speed and care;", "then you ship it."]
    audio, tl = build_scene(texts, tts, 0.2, speed=0.9, gaps=[0, 0.15, 0.15])
    lead = 2.0  # the scene starts 2 s into the video
    pcm = np.concatenate([np.zeros(round(lead * 16000), dtype=np.float32), resample_16k(audio)])
    phrases = [{"text": p["text"], "start": lead + p["start"], "end": lead + p["end"]} for p in tl["phrases"]]
    words = align_phrases(pcm, phrases, whisper())
    assert [w["w"] for w in words] == " ".join(texts).split()
    assert all(b["start"] > a["start"] for a, b in zip(words, words[1:]))
    firsts = [words[0], words[4], words[7]]
    for w, p in zip(firsts, phrases):
        lo = round(p["start"] * 16000)
        onset = (lo + first_sample_over(pcm[lo:], 0.02)) / 16000
        assert abs(w["start"] - onset) <= 0.15, (w, p, onset)
