import os
from pathlib import Path

import numpy as np
import pytest

from scenecast_py.align import AlignmentError, align_phrases, align_text, finish_alignment, refine_onset, words_from_tokens

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


def _pieces(*spec):
    return [{"word": w, "start": a, "end": b, "probability": 1.0} for w, a, b in spec]


def test_the_first_word_starts_at_the_onset_but_never_after_the_second_word():
    # The path pins "To" to the clip's first frame (0.0). The onset says 0.30, but "sign" starts at 0.24: the first word
    # is capped one frame before it, so the times still increase.
    out = finish_alignment("To sign it", _pieces((" To", 0.0, 0.2), (" sign", 0.24, 0.5), (" it", 0.5, 0.7)), 0.30, 10.0)
    assert [w["start"] for w in out] == pytest.approx([10.22, 10.24, 10.5])
    assert [w["from"] for w in out] == ["onset", "forced", "forced"]
    # An onset before the second word is used as it is.
    out = finish_alignment("To sign it", _pieces((" To", 0.0, 0.2), (" sign", 0.32, 0.5), (" it", 0.5, 0.7)), 0.20, 10.0)
    assert [w["start"] for w in out] == pytest.approx([10.20, 10.32, 10.5])
    # One word: the onset stands.
    assert finish_alignment("Done.", _pieces((" Done", 0.0, 0.4), (".", 0.4, 0.4)), 0.3, 1.0)[0]["start"] == pytest.approx(1.3)


def test_the_first_word_is_labelled_onset_only_when_the_onset_was_used():
    # The aligner's own start (0.25) is later than the onset (0.10): it stands, and says so.
    out = finish_alignment("To sign it", _pieces((" To", 0.25, 0.3), (" sign", 0.32, 0.5), (" it", 0.5, 0.7)), 0.10, 0.0)
    assert out[0]["start"] == pytest.approx(0.25) and out[0]["from"] == "forced"


def test_a_silent_punctuation_word_may_share_a_start_with_its_neighbour():
    # " — " gets no frames of its own: it starts where "then" does. That is not a sign of a bad alignment.
    text = "Press Save — then wait."
    pieces = _pieces((" Press", 0.0, 0.3), (" Save", 0.3, 0.7), (" —", 0.9, 0.9), (" then", 0.9, 1.1), (" wait", 1.1, 1.4),
                     (".", 1.4, 1.4))
    out = finish_alignment(text, pieces, 0.05, 0.0)
    assert [w["w"] for w in out] == text.split()
    assert [w["start"] for w in out] == pytest.approx([0.05, 0.3, 0.9, 0.9, 1.1])
    # A start going backwards is still rejected.
    from scenecast_py.align import check_times

    assert "starts before" in check_times([{"w": "a", "start": 1.0}, {"w": "—", "start": 0.9}, {"w": "b", "start": 1.2}])


def test_two_spoken_words_on_one_start_are_split_by_a_frame_not_dropped():
    """v1.2: the aligner gave "documents" no frames, so it starts where "to" does. The phrase is kept (the later word
    moves one alignment frame later) instead of falling back to the free transcript."""
    text = "Open documents to upload, or wait."
    pieces = _pieces((" Open", 0.0, 0.3), (" documents", 0.9, 0.9), (" to", 0.9, 1.1), (" upload", 1.1, 1.5),
                     (",", 1.5, 1.5), (" or", 1.6, 1.7), (" wait", 1.7, 2.0), (".", 2.0, 2.0))
    out = finish_alignment(text, pieces, 0.05, 10.0)
    assert [w["w"] for w in out] == text.split()
    assert [w["start"] for w in out] == pytest.approx([10.05, 10.9, 10.92, 11.1, 11.6, 11.7])
    assert all(w["end"] >= w["start"] for w in out)
    assert [w["from"] for w in out] == ["onset"] + ["forced"] * 5


def test_a_tie_with_little_room_before_the_next_word_takes_half_the_gap():
    text = "Save it now"
    out = finish_alignment(text, _pieces((" Save", 0.5, 0.5), (" it", 0.5, 0.51), (" now", 0.51, 0.8)), 0.0, 0.0)
    assert [w["start"] for w in out] == pytest.approx([0.5, 0.505, 0.51])
    # A tie on the phrase's last word moves it one frame on.
    out = finish_alignment("Then save it", _pieces((" Then", 0.0, 0.3), (" save", 0.6, 0.6), (" it", 0.6, 0.6)), 0.1, 0.0)
    assert [w["start"] for w in out] == pytest.approx([0.1, 0.6, 0.62])
    assert out[-1]["end"] == pytest.approx(0.62)


def test_a_punctuation_word_after_a_moved_word_moves_with_it():
    text = "Press Save — then wait."
    pieces = _pieces((" Press", 0.0, 0.3), (" Save", 0.9, 0.9), (" then", 0.9, 0.9), (" —", 0.9, 0.9), (" wait", 1.1, 1.4),
                     (".", 1.4, 1.4))
    out = finish_alignment("Press Save then — wait.", pieces, 0.05, 0.0)
    assert [w["start"] for w in out] == pytest.approx([0.05, 0.9, 0.92, 0.92, 1.1])


def test_three_spoken_words_on_one_start_are_still_rejected():
    with pytest.raises(AlignmentError, match='"menu" does not start after "the"'):
        finish_alignment("Open the menu now", _pieces((" Open", 0.0, 0.3), (" the", 0.5, 0.5), (" menu", 0.5, 0.5),
                                                      (" now", 0.5, 0.9)), 0.0, 0.0)


def test_finish_alignment_rejects_an_empty_result():
    with pytest.raises(AlignmentError, match="no words"):
        finish_alignment("Open the menu", [], 0.1, 0.0)


def test_finish_alignment_rejects_pieces_that_do_not_spell_the_text():
    with pytest.raises(AlignmentError, match="spell"):
        finish_alignment("Open the menu", _pieces((" Opne", 0.1, 0.3), (" the", 0.3, 0.4), (" menu", 0.4, 0.7)), 0.1, 0.0)


def test_finish_alignment_rejects_degenerate_times():
    # The aligner had nothing to go on: every piece on frame 0.
    with pytest.raises(AlignmentError, match="does not start after"):
        finish_alignment("Open the menu", _pieces((" Open", 0.0, 0.0), (" the", 0.0, 0.0), (" menu", 0.0, 0.0)), 0.0, 0.0)


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
    assert out[2]["from"] is None


def test_align_phrases_logs_each_phrase_it_leaves_untimed(monkeypatch, capsys):
    import scenecast_py.align as align

    def boom(model, pcm, text, offset=0.0):
        raise KeyError("anything at all")

    monkeypatch.setattr(align, "align_text", boom)
    out = align_phrases(np.zeros(16000 * 3, dtype=np.float32), [{"start": 0.5, "end": 1.5, "text": "Open it."}], model=None)
    assert [w["start"] for w in out] == [None, None]
    assert 'phrase at 0.500 s ("Open it.") left untimed' in capsys.readouterr().err


def test_align_phrases_never_reaches_into_the_neighbouring_scenes(monkeypatch):
    import scenecast_py.align as align

    fake = FakeAligner()
    monkeypatch.setattr(align, "align_text", fake)
    phrases = [{"start": 1.0, "end": 2.0, "text": "Open it,"}, {"start": 2.2, "end": 3.0, "text": "then go."}]
    align_phrases(np.zeros(16000 * 5, dtype=np.float32), phrases, model=None, bounds=(0.8, 3.1))
    # The previous scene's speech ends at 0.8 s and the next one's starts at 3.1 s.
    assert [c[2] for c in fake.calls] == pytest.approx([0.8, 2.0])
    assert [c[0] for c in fake.calls] == [round(1.4 * 16000), round(1.1 * 16000)]


def test_align_text_installs_the_pyav_stub_before_faster_whisper():
    import subprocess
    import sys
    import textwrap

    r = subprocess.run([sys.executable, "-c", textwrap.dedent(
        """
        import sys
        import numpy as np
        from scenecast_py import align
        try:
            align.align_text(object(), np.zeros(16000, dtype=np.float32), "Hello there.")
        except AttributeError:
            pass  # the stand-in model has no feature extractor; the imports already happened
        assert "faster_whisper" in sys.modules
        assert getattr(sys.modules["av"], "SCENECAST_STUB", False), "real PyAV loaded"
        print("ok")
        """)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "ok"


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


@E2E
def test_a_phrase_with_an_em_dash_is_forced_not_a_fallback(capsys):
    """The punctuation-only word " — " may tie with the next word; the phrase must still be aligned, not fall back."""
    from scenecast_py.kokoro import Kokoro
    from scenecast_py.voice import build_scene, forced_words

    tts = Kokoro(str(CACHE / "kokoro-v1.0.onnx"), str(CACHE / "voices-v1.0.bin"))
    text = "Press Save — then wait for the check."
    audio, tl = build_scene([text], tts, 0.2, speed=0.9)
    words = forced_words(whisper(), audio, tl["phrases"], heard=lambda: pytest.fail("fell back to the free transcript"))
    with capsys.disabled():
        print("em dash words:", [(w["w"], round(w["start"], 3), w["from"]) for w in words])
    assert [w["w"] for w in words] == text.split()
    assert {w["from"] for w in words} <= {"onset", "forced"}
    assert "onset" in tl["phrases"][0]
    assert "falls back" not in capsys.readouterr().err
