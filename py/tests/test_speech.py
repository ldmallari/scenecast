"""1.3 voice: pronunciation spans, acronyms, stress, timing mapped back to the script, context synthesis, polish."""
import numpy as np
import pytest

from scenecast_py import speech as sp
from scenecast_py.voice import SAMPLE_RATE, FakeTTS, build_scene, context_clips, cut_points


@pytest.fixture(scope="module")
def lexicon():
    from misaki import en

    return en.Lexicon(False)


def phrase(text, spans=(), stress=()):
    return {"text": text, "speed": 0.9, "spans": list(spans), "stress": list(stress)}


# ---------------------------------------------------------------- acronyms


def test_unknown_all_caps_words_are_spelled_letter_by_letter(lexicon):
    assert sp.acronym_phonemes("SKU", lexicon) == lexicon.get_NNP("SKU")[0]
    assert sp.acronym_phonemes("SLAs", lexicon) == lexicon._s(lexicon.get_NNP("SLA")[0])
    assert sp.acronym_phonemes("SLAs", lexicon).endswith("z")


def test_words_misaki_knows_are_left_to_misaki(lexicon):
    for word in ("NASA", "SCUBA", "OK", "ID", "IDs", "ASAP"):
        assert sp.acronym_phonemes(word, lexicon) is None, word
    for word in ("Sku", "SKUX123", "T", "TOOLONGX", "sku"):
        assert sp.acronym_phonemes(word, lexicon) is None, word


def test_acronyms_become_misaki_phoneme_links_in_the_tts_text_only(lexicon):
    us = sp.units(phrase("Ask the SKU team, now."), lexicon)
    assert sp.tts_text(us) == f"Ask the [SKU](/{lexicon.get_NNP('SKU')[0]}/) team, now."
    assert sp.spoken_text(us) == "Ask the SKU team, now."
    # Punctuation stays outside the link.
    us = sp.units(phrase("Open SKU, then go."), lexicon)
    assert "](/" in sp.tts_text(us) and sp.tts_text(us).split()[1].endswith("/),")


def test_acronyms_off_reads_unknown_capitals_as_a_word(lexicon):
    assert sp.tts_text(sp.units(phrase("Ask SKU now."), lexicon, acronyms=False)) == "Ask sku now."
    # A say: entry mapping a word to itself is said as a word even with acronyms on.
    us = sp.units(phrase("Edit the YAML file.", [{"from": 2, "to": 3, "word": True, "before": "", "after": ""}]), lexicon)
    assert sp.tts_text(us) == "Edit the yaml file."


def test_misaki_spells_our_phoneme_links_as_given():
    from scenecast_py.g2p import make_g2p

    g2p = make_g2p()
    ps, _ = g2p("Speak [Sibal](/sˈibɑl/) now")
    assert "sˈibɑl" in ps
    stressed, _ = g2p("Find [your](+2) profile")
    plain, _ = g2p("Find your profile")
    assert "jˈʊɹ" in stressed and "jˈʊɹ" not in plain  # an unstressed word gains primary stress


# ---------------------------------------------------------------- spans and stress


def test_replacement_and_phoneme_spans():
    p = phrase("Ask Mira Solano, the SKU lead.", [
        {"from": 1, "to": 3, "text": "Meera Solarno", "before": "", "after": ","},
        {"from": 4, "to": 5, "ph": "ˌɛskˌAjˈu", "before": "", "after": ""},
    ])
    us = sp.units(p)
    assert sp.tts_text(us) == "Ask Meera Solarno, the [SKU](/ˌɛskˌAjˈu/) lead."
    assert sp.spoken_text(us) == "Ask Meera Solarno, the SKU lead."
    assert [(u["from"], u["to"]) for u in us] == [(0, 1), (1, 3), (3, 4), (4, 5), (5, 6)]


def test_a_suffix_outside_the_span_stays_on_the_word():
    p = phrase("Open Demo Co's list.", [{"from": 1, "to": 3, "text": "Demo Koh", "before": "", "after": "'s"}])
    assert sp.tts_text(sp.units(p)) == "Open Demo Koh's list."
    p = phrase("Open Demo Co's list.", [{"from": 1, "to": 3, "ph": "dˈɛmO kˈO", "before": "", "after": "'s"}])
    assert sp.tts_text(sp.units(p)) == "Open [Demo Co](/dˈɛmO kˈO/)'s list."


def test_stress_uses_misaki_primary_stress():
    us = sp.units(phrase("Find your profile.", stress=[1]))
    assert sp.tts_text(us) == "Find [your](+2) profile."
    assert sp.spoken_text(us) == "Find your profile."


def test_a_plain_string_phrase_is_unchanged():
    us = sp.units(sp.as_phrase("Welcome to the dashboard."))
    assert sp.tts_text(us) == sp.spoken_text(us) == "Welcome to the dashboard."


# ---------------------------------------------------------------- timing back onto the script


def timed(words, start=0.0, step=0.3):
    return [{"w": w, "start": start + k * step, "end": start + k * step + 0.25, "from": "forced"} for k, w in enumerate(words)]


def test_map_times_one_to_one_copies_the_times():
    us = sp.units(phrase("Press save now."))
    got = sp.map_times(us, "Press save now.".split(), timed("Press save now.".split()))
    assert [(w["w"], w["start"]) for w in got] == [("Press", 0.0), ("save", 0.3), ("now.", pytest.approx(0.6))]


def test_map_times_spreads_a_replacement_over_its_script_words():
    text = "Ask SKU now."
    us = sp.units(phrase(text, [{"from": 1, "to": 2, "text": "S K U", "before": "", "after": ""}]))
    spoken = sp.spoken_text(us).split()
    assert spoken == ["Ask", "S", "K", "U", "now."]
    got = sp.map_times(us, text.split(), timed(spoken))
    assert [w["w"] for w in got] == ["Ask", "SKU", "now."]
    # SKU runs from the first letter's start to the last letter's end; "now." keeps its own time.
    assert (got[1]["start"], got[1]["end"]) == pytest.approx((0.3, 1.15))
    assert got[2]["start"] == pytest.approx(1.2)


def test_map_times_a_phrase_replaced_by_fewer_words():
    text = "Meet Demo Co today."
    us = sp.units(phrase(text, [{"from": 1, "to": 3, "text": "Democo", "before": "", "after": ""}]))
    got = sp.map_times(us, text.split(), timed(sp.spoken_text(us).split()))
    assert [w["w"] for w in got] == ["Meet", "Demo", "Co", "today."]
    assert got[1]["start"] == pytest.approx(0.3)
    assert got[1]["start"] < got[2]["start"] < got[2]["end"] == pytest.approx(0.55)
    assert got[3]["start"] == pytest.approx(0.6)


def test_forced_words_time_the_script_words_of_a_replaced_phrase(monkeypatch):
    """The voice stage aligns what was said ("S K U") and reports the script's words ("SKU") with their times."""
    from scenecast_py import align, voice

    seen = {}

    def fake_align(model, pcm, text, offset=0.0):
        seen["text"] = text
        return [{**w, "start": w["start"] + 0.3 + offset, "end": w["end"] + 0.3 + offset}
                for w in timed(text.split(), 0.0, 0.2)]

    monkeypatch.setattr(align, "align_text", fake_align)
    p = {"text": "Ask SKU now.", "start": 1.0, "end": 3.0,
         "say": {"spans": [{"from": 1, "to": 2, "text": "S K U", "before": "", "after": ""}], "stress": []}}
    words = voice.forced_words(object(), np.zeros(4 * SAMPLE_RATE, np.float32), [p], pad=0.3)
    assert seen["text"] == "Ask S K U now."
    assert [w["w"] for w in words] == ["Ask", "SKU", "now."]
    assert words[1]["start"] == pytest.approx(1.2)
    assert words[2]["start"] == pytest.approx(1.8)


def test_build_scene_keeps_script_text_and_spans_in_the_timeline():
    phrases = [phrase("Ask SKU.", [{"from": 1, "to": 2, "text": "S K U", "before": "", "after": "."}]), "Then go."]
    audio, tl = build_scene(phrases, FakeTTS(), gap_sec=0.2, gaps=[0, 0.6])
    assert [p["text"] for p in tl["phrases"]] == ["Ask SKU.", "Then go."]
    assert tl["phrases"][1]["start"] == pytest.approx(1.6)  # a [pause 0.6] is the gap before the phrase
    assert tl["phrases"][0]["say"]["spans"][0]["text"] == "S K U"
    assert "say" not in tl["phrases"][1]


class RecordingTTS:
    """Records what it was asked to say; a 0.4 s tone per word with 0.25 s of silence between sentences."""

    def __init__(self):
        self.calls = []

    def create(self, text, voice=None, speed=1.0, lang="en-us"):
        self.calls.append((text, speed))
        out = []
        for w in text.split():
            t = np.arange(round(0.4 * SAMPLE_RATE)) / SAMPLE_RATE
            out.append((0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32))
            out.append(np.zeros(round((0.25 if w[-1] in ".:;" else 0.02) * SAMPLE_RATE), np.float32))
        return np.concatenate(out[:-1])


def test_build_scene_speaks_each_phrase_at_its_own_speed():
    tts = RecordingTTS()
    build_scene([{**phrase("Save it"), "speed": 0.8}, phrase("now.")], tts, gap_sec=0.2, speed=0.9)
    assert tts.calls == [("Save it", 0.8), ("now.", 0.9)]


# ---------------------------------------------------------------- context synthesis


def test_cut_points_choose_the_quiet_between_phrases():
    tts = RecordingTTS()
    audio = tts.create("One two. Three four.")
    # Words start every 0.42 s; "two." starts at 0.42 s, "Three" at 0.42 + 0.4 + 0.25 = 1.07 s.
    cuts = cut_points(audio, [(0.42, 1.07)])
    assert cuts is not None
    assert 0.82 * SAMPLE_RATE <= cuts[0] <= 1.07 * SAMPLE_RATE
    # No quiet point (a tone straight through): no cut.
    tone = (0.3 * np.sin(2 * np.pi * 220 * np.arange(2 * SAMPLE_RATE) / SAMPLE_RATE)).astype(np.float32)
    assert cut_points(tone, [(0.2, 1.5)]) is None
    # No room between the two words: no cut.
    assert cut_points(audio, [(1.0, 1.02)]) is None


def test_context_clips_voice_a_group_in_one_call_and_cut_it_into_phrases(monkeypatch):
    from scenecast_py import align

    tts = RecordingTTS()

    def fake_align(model, pcm, text, offset=0.0):
        # The tone layout of RecordingTTS (0.3 s of padding comes first; offset removes it).
        t, out = 0.3, []
        for w in text.split():
            out.append({"w": w, "start": t + offset, "end": t + 0.4 + offset, "from": "forced"})
            t += 0.4 + (0.25 if w[-1] in ".:;" else 0.02)
        return out

    monkeypatch.setattr(align, "align_text", fake_align)
    clips = context_clips(tts, object(), [phrase("To sign the form:"), phrase("tick the box.")], "af_heart", 0.9, "en-us")
    assert tts.calls == [("To sign the form: tick the box.", 0.9)]
    assert clips is not None and len(clips) == 2
    # Each clip is its phrase's words (4 and 3 tones), trimmed of the silence at the cut.
    assert len(clips[0]) == pytest.approx((4 * 0.4 + 3 * 0.02) * SAMPLE_RATE, abs=0.1 * SAMPLE_RATE)
    assert len(clips[1]) == pytest.approx((3 * 0.4 + 2 * 0.02) * SAMPLE_RATE, abs=0.1 * SAMPLE_RATE)


def test_context_clips_fall_back_when_alignment_fails(monkeypatch, capsys):
    from scenecast_py import align

    def broken(*a, **k):
        raise align.AlignmentError("nothing to go on")

    monkeypatch.setattr(align, "align_text", broken)
    tts = RecordingTTS()
    assert context_clips(tts, object(), [phrase("One two."), phrase("Three.")], "af_heart", 0.9, "en-us") is None
    assert "voiced phrase by phrase" in capsys.readouterr().err
    # build_scene then voices each phrase on its own.
    tts = RecordingTTS()
    audio, tl = build_scene([phrase("One two."), phrase("Three.")], tts, 0.2, groups=[0, 0], model=object())
    assert [c[0] for c in tts.calls] == ["One two. Three.", "One two.", "Three."]
    assert len(tl["phrases"]) == 2


# ---------------------------------------------------------------- polish


def test_polish_high_passes_rumble_and_keeps_length_and_timing():
    from scenecast_py.polish import polish

    sr = SAMPLE_RATE
    t = np.arange(sr) / sr
    voice = 0.2 * np.sin(2 * np.pi * 300 * t) * (t > 0.5)  # starts at 0.5 s
    rumble = 0.2 * np.sin(2 * np.pi * 30 * t)
    out = polish((voice + rumble).astype(np.float32), sr)
    assert out.dtype == np.float32 and len(out) == sr

    def level(x, f):
        return abs(np.fft.rfft(x)[round(f * len(x) / sr)])

    assert level(out, 30) < 0.25 * level(voice + rumble, 30)  # 30 Hz: down by more than 12 dB
    assert level(out, 300) > 0.6 * level(voice + rumble, 300)  # 300 Hz: kept (compression takes a little)
    # Nothing moves in time: the 300 Hz tone still starts at 0.5 s.
    env = np.abs(out[: sr // 2 - 600])
    assert env.max() < 0.12  # only the attenuated rumble before the tone


def test_polish_de_esses_loud_sibilance_only():
    from scenecast_py.polish import deess

    sr = SAMPLE_RATE
    rng = np.random.default_rng(0)
    t = np.arange(sr) / sr
    vowel = 0.2 * np.sin(2 * np.pi * 200 * t)
    hiss = np.fft.irfft(np.fft.rfft(rng.normal(0, 0.2, sr)) * ((np.fft.rfftfreq(sr, 1 / sr) > 5500) & (np.fft.rfftfreq(sr, 1 / sr) < 9500)), sr)
    vowel = vowel * (t < 0.5)  # a vowel, then an "s"
    s_sound = hiss * (t > 0.5)
    out = deess(vowel + s_sound, sr)
    band = lambda x: np.sqrt(np.mean(x**2))  # noqa: E731
    assert band(out[: sr // 2 - 200]) == pytest.approx(band(vowel[: sr // 2 - 200]), rel=0.02)  # the vowel alone: untouched
    assert band(out[sr // 2 + 2000:] - vowel[sr // 2 + 2000:]) < 0.75 * band(s_sound[sr // 2 + 2000:])  # the hiss: dipped


def test_polish_compresses_loud_parts_more_than_quiet_ones():
    from scenecast_py.polish import compress

    sr = SAMPLE_RATE
    t = np.arange(2 * sr) / sr
    x = np.sin(2 * np.pi * 220 * t) * np.where(t < 1, 0.03, 0.5)  # RMS -33.5 dBFS, then -9 dBFS
    out = compress(x, sr)
    quiet = np.sqrt(np.mean(out[: sr - 2400] ** 2)) / np.sqrt(np.mean(x[: sr - 2400] ** 2))
    loud = np.sqrt(np.mean(out[sr + 4800:] ** 2)) / np.sqrt(np.mean(x[sr + 4800:] ** 2))
    assert quiet == pytest.approx(1.0, abs=0.01)  # under the threshold: unchanged
    assert 20 * np.log10(loud) == pytest.approx(-(-9 + 24) / 2, abs=1.0)  # 15 dB over at 2:1: about -7.5 dB
