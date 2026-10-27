import json
import os
import subprocess
from pathlib import Path

import pytest

from scenecast_py.audit import normalise_words, number_to_words, run

E2E = pytest.mark.skipif(not os.environ.get("SCENECAST_E2E"), reason="set SCENECAST_E2E=1 for real models")

RULES = {
    "width": 1920,
    "height": 1080,
    "syncMaxSec": 0.3,
    "zoomPadPx": 24,
    "voiceLufs": -16,
    "toleranceLu": 1,
    "truePeakDb": -1.5,
    "zoomEaseSec": 0.7,
    "fullFrameShare": 0.9,
}

TARGET = {"x": 800, "y": 300, "w": 200, "h": 60}
WORDS = [
    {"w": " Open", "start": 1.00, "end": 1.30},
    {"w": " two", "start": 1.40, "end": 1.60},
    {"w": " documents", "start": 1.65, "end": 2.20},
    {"w": " for", "start": 2.30, "end": 2.45},
    {"w": " Meera", "start": 2.50, "end": 2.80},
    {"w": " Solana.", "start": 2.85, "end": 3.30},
]


def moment(**kw):
    m = {
        "index": 0,
        "cue": "Open",
        "occ": 1,
        "offset": 0,
        "kind": "click",
        "label": "#open",
        "actionTime": 1.0,
        "planWordTime": 1.0,
        "target": TARGET,
        "loading": False,
        "settleTimedOut": False,
        "ring": None,
        "zoom": None,
    }
    m.update(kw)
    return m


def event(**kw):
    e = {"index": 0, "time": 1.0, "boxes": [{"kind": "target", "box": TARGET}]}
    e.update(kw)
    return e


def fixture(tmp_path, moments=None, events=None, cues=None, zooms=None, **kw):
    data = {
        "video": None,
        "ffmpeg": None,
        "whisperModel": None,
        "words": WORDS,
        "outDir": str(tmp_path / "audit"),
        "rules": RULES,
        "loudness": {"lufs": -16.1, "truePeak": -2.0},
        "music": None,
        "allowList": ["Mira Solano"],
        "scenes": [
            {
                "id": "s1",
                "start": 0.0,
                "end": 6.0,
                "narration": "Open 2 documents for Mira Solano.",
                "cues": cues or [],
                "zooms": zooms or [],
                "navBox": None,
                "events": events if events is not None else [event()],
                "moments": moments or [moment()],
            }
        ],
    }
    data.update(kw)
    return data


def only_row(verdict):
    assert len(verdict["moments"]) == 1
    return verdict["moments"][0]


def test_gap_031_fails_030_passes(tmp_path):
    ok = run(fixture(tmp_path, moments=[moment(actionTime=1.30)]))
    assert only_row(ok)["gap"] == pytest.approx(0.30)
    assert only_row(ok)["verdict"] == "PASS"
    assert ok["pass"] is True

    late = run(fixture(tmp_path, moments=[moment(actionTime=1.31)]))
    row = only_row(late)
    assert row["verdict"] == "FAIL"
    assert any(c["name"] == "sync" and c["verdict"] == "FAIL" for c in row["checks"])
    assert late["pass"] is False
    assert late["counts"]["fail"] >= 1

    early = run(fixture(tmp_path, moments=[moment(actionTime=0.69)]))
    assert only_row(early)["verdict"] == "FAIL"


def test_word_time_comes_from_the_transcript_not_the_plan(tmp_path):
    # Plan said 0.5 s; whisper heard "Open" at 1.0 s; the action at 1.0 s is in sync.
    v = run(fixture(tmp_path, moments=[moment(planWordTime=0.5, actionTime=1.0)]))
    row = only_row(v)
    assert row["wordTime"] == pytest.approx(1.0)
    assert row["wordSource"] == "transcript"
    assert row["verdict"] == "PASS"


def test_cue_not_heard_falls_back_to_plan_time_with_warn(tmp_path):
    words = [w for w in WORDS if w["w"].strip() != "Open"]
    v = run(fixture(tmp_path, words=words, moments=[moment(planWordTime=0.9, actionTime=1.0)]))
    row = only_row(v)
    assert row["wordSource"] == "plan"
    assert row["wordTime"] == pytest.approx(0.9)
    assert row["verdict"] == "WARN"
    assert v["pass"] is True


def test_ring_box_not_containing_target_fails(tmp_path):
    inside = {"x": 790, "y": 290, "w": 220, "h": 80}
    off = {"x": 820, "y": 290, "w": 220, "h": 80}  # misses the target's left 20 px
    ring = lambda box: {"box": box, "peak": 1.15, "by": "composer"}  # noqa: E731
    good = run(fixture(tmp_path, moments=[moment(ring=ring(inside))]))
    assert only_row(good)["verdict"] == "PASS"
    bad = run(fixture(tmp_path, moments=[moment(ring=ring(off))]))
    row = only_row(bad)
    assert row["verdict"] == "FAIL"
    assert any(c["name"] == "target" and c["verdict"] == "FAIL" for c in row["checks"])


def test_zoom_not_containing_target_fails_and_crop_rules(tmp_path):
    def run_zoom(box, nav=None):
        zoom = {"box": box, "start": 1.0, "end": 3.0, "hold": 1.7}
        data = fixture(
            tmp_path,
            moments=[moment(kind="zoom", actionTime=1.0, zoom=zoom)],
            events=[event(boxes=[{"kind": "target", "box": TARGET}])],
            zooms=[{"start": 1.0, "end": 3.0, "box": box}],
        )
        data["scenes"][0]["navBox"] = nav
        return only_row(run(data))

    centred = {"x": 420, "y": 52.5, "w": 960, "h": 540}  # target 380 px clear on each side
    assert run_zoom(centred)["verdict"] == "PASS"
    missed = run_zoom({"x": 0, "y": 0, "w": 768, "h": 432})
    assert any(c["name"] == "target" and c["verdict"] == "FAIL" for c in missed["checks"])
    tight = run_zoom({"x": 790, "y": 290, "w": 384, "h": 216})  # target 10 px from the zoom's left edge
    assert any(c["name"] == "crop" and c["verdict"] == "FAIL" for c in tight["checks"])
    outside = run_zoom({"x": 1500, "y": 0, "w": 960, "h": 540})
    assert any(c["name"] == "crop" and c["verdict"] == "FAIL" for c in outside["checks"])
    nav = {"x": 0, "y": 0, "w": 240, "h": 1080}
    cut = run_zoom({"x": 120, "y": 52.5, "w": 960, "h": 540}, nav)
    assert any(c["name"] == "crop" and "nav" in c["detail"] for c in cut["checks"])
    assert run_zoom({"x": 0, "y": 52.5, "w": 1120, "h": 630}, nav)["verdict"] == "PASS"


def test_declared_top_nav_cut_fails_whole_or_out_passes(tmp_path):
    topbar = {"edge": "top", "box": {"x": 0, "y": 0, "w": 1920, "h": 64}}

    def run_zoom(box):
        zoom = {"box": box, "start": 1.0, "end": 3.0, "hold": 1.7}
        data = fixture(
            tmp_path,
            moments=[moment(kind="zoom", actionTime=1.0, zoom=zoom)],
            events=[event(boxes=[{"kind": "target", "box": TARGET}])],
            zooms=[{"start": 1.0, "end": 3.0, "box": box}],
        )
        data["scenes"][0]["navs"] = [topbar]
        return only_row(run(data))

    # Overlaps the bar but is narrower than it: the bar shows cut off at the sides.
    cut = run_zoom({"x": 420, "y": 0, "w": 960, "h": 540})
    assert cut["verdict"] == "FAIL"
    assert any(c["name"] == "crop" and "top nav" in c["detail"] for c in cut["checks"])
    # Starts below the bar: the bar is fully out.
    assert run_zoom({"x": 420, "y": 64, "w": 960, "h": 540})["verdict"] == "PASS"
    # The whole frame holds the bar: fully in.
    assert run_zoom({"x": 0, "y": 0, "w": 1920, "h": 1080})["verdict"] == "PASS"


def test_heard_word_before_its_phrase_is_clamped_to_the_phrase_start(tmp_path):
    # Demo run 1 (account-menu): the voice put "Open" at 28.00 s, the first word of the second phrase
    # (27.94-31.48 s; 27.74-27.94 s is the phrase gap). Whisper on the final mix put it at 27.52 s, inside
    # "right." of the first phrase, which made a +0.547 s sync FAIL for an action at 28.067 s.
    narration = "Your account menu sits at the top right. Open it to find your profile, your settings, and sign out."
    heard = [{"w": f" {w}", "start": 25.5 + 0.2 * i, "end": 25.6 + 0.2 * i} for i, w in enumerate("Your account menu sits at the top".split())]
    heard += [{"w": " right.", "start": 26.9, "end": 27.5}, {"w": " Open", "start": 27.52, "end": 28.3}]
    heard += [{"w": f" {w}", "start": 28.4 + 0.3 * i, "end": 28.6 + 0.3 * i} for i, w in enumerate("it to find your profile, your settings, and sign out.".split())]
    m = moment(cue="Open", actionTime=28.067, planWordTime=28.06, cueWord=8, target=None)
    data = fixture(tmp_path, words=heard, moments=[m], events=[event(time=28.067, boxes=[])])
    data["allowList"] = []
    sc = data["scenes"][0]
    sc.update({"start": 25.5, "end": 31.933, "narration": narration})
    without = only_row(run(json.loads(json.dumps(data))))
    assert without["verdict"] == "FAIL"  # no phrase windows: the transcript time stands
    sc["phrases"] = [{"start": 25.5, "end": 27.74, "words": 8}, {"start": 27.94, "end": 31.481, "words": 11}]
    row = only_row(run(data))
    assert row["wordTime"] == pytest.approx(27.94)
    assert row["gap"] == pytest.approx(0.127)
    assert row["verdict"] == "PASS"


def test_heard_word_inside_its_phrase_is_untouched(tmp_path):
    data = fixture(tmp_path, moments=[moment(planWordTime=1.0, actionTime=1.0)])
    data["scenes"][0]["phrases"] = [{"start": 0.5, "end": 3.4, "words": 6}]
    assert only_row(run(data))["wordTime"] == pytest.approx(1.0)


def test_caption_overlapping_open_panel_fails(tmp_path):
    panel = {"x": 700, "y": 820, "w": 500, "h": 200}
    bottom = {"x": 600, "y": 900, "w": 720, "h": 100}
    top = {"x": 600, "y": 72, "w": 720, "h": 100}
    ev = [event(boxes=[{"kind": "target", "box": TARGET}, {"kind": "panel", "box": panel}])]
    clear = run(fixture(tmp_path, events=ev, cues=[{"start": 0.5, "end": 2.5, "side": "top", "box": top, "text": "Open it"}]))
    assert only_row(clear)["verdict"] == "PASS"
    assert only_row(clear)["captionSide"] == "top"
    hit = run(fixture(tmp_path, events=ev, cues=[{"start": 0.5, "end": 2.5, "side": "bottom", "box": bottom, "text": "Open it"}]))
    row = only_row(hit)
    assert row["verdict"] == "FAIL"
    cap = next(c for c in row["checks"] if c["name"] == "captions")
    assert cap["verdict"] == "FAIL" and "panel" in cap["detail"]
    # The panel opens later (next event at 3.0 s): a cue that ends before it is clear.
    later = [event(boxes=[{"kind": "target", "box": TARGET}]), event(index=1, time=3.0, boxes=[{"kind": "panel", "box": panel}])]
    early_cue = [{"start": 0.5, "end": 2.9, "side": "bottom", "box": bottom, "text": "Open it"}]
    assert only_row(run(fixture(tmp_path, events=later, cues=early_cue)))["verdict"] == "PASS"


def test_corner_caption_is_checked_by_its_box_and_named_in_the_table(tmp_path):
    panel = {"x": 600, "y": 820, "w": 700, "h": 200}
    ev = [event(boxes=[{"kind": "target", "box": TARGET}, {"kind": "panel", "box": panel}])]
    left = {"x": 72, "y": 915, "w": 322, "h": 93}  # bottom-left: the bottom box's size, 72 px from the left
    clear = run(fixture(tmp_path, events=ev, cues=[{"start": 0.5, "end": 2.5, "side": "bottom-left", "box": left, "text": "Press Save."}]))
    assert only_row(clear)["verdict"] == "PASS"
    assert only_row(clear)["captionSide"] == "bottom-left"
    assert "| bottom-left |" in (tmp_path / "audit" / "audit-table.md").read_text()
    right = {"x": 1920 - 72 - 960, "y": 915, "w": 960, "h": 93}  # a wide bottom-right box reaches the panel
    hit = only_row(run(fixture(tmp_path, events=ev, cues=[{"start": 0.5, "end": 2.5, "side": "bottom-right", "box": right, "text": "x"}])))
    cap = next(c for c in hit["checks"] if c["name"] == "captions")
    assert cap["verdict"] == "FAIL" and "(bottom-right) covers the panel" in cap["detail"]


def test_caption_with_layout_reason_fails_and_zoom_moves_the_target(tmp_path):
    bottom = {"x": 600, "y": 900, "w": 720, "h": 100}
    reason = [{"start": 0.5, "end": 2.5, "side": "bottom", "box": bottom, "text": "x", "reason": "no free position; bottom overlaps least"}]
    row = only_row(run(fixture(tmp_path, cues=reason)))
    assert row["verdict"] == "FAIL"
    assert any("no free position" in c["detail"] for c in row["checks"])
    # Unzoomed the target (y 300-360) is clear of a bottom caption; zoomed 2x on the lower half it lands under it.
    zbox = {"x": 480, "y": 0, "w": 960, "h": 540}
    cue = [{"start": 0.5, "end": 2.5, "side": "bottom", "box": {"x": 600, "y": 600, "w": 720, "h": 100}, "text": "x"}]
    plain = run(fixture(tmp_path, cues=cue))
    assert only_row(plain)["verdict"] == "PASS"
    zoomed = run(fixture(tmp_path, cues=cue, zooms=[{"start": 0.0, "end": 5.0, "box": zbox}]))
    assert only_row(zoomed)["verdict"] == "FAIL"


def test_caption_over_the_zoomed_target_fails_while_held_and_while_easing(tmp_path):
    # Target x 800-1000, y 300-360; a 2x zoom on the top-left quarter shows it at x 1600-2000, y 600-720.
    zbox = {"x": 0, "y": 0, "w": 960, "h": 540}
    cap = {"x": 1400, "y": 650, "w": 400, "h": 100}  # clear of the target unzoomed, over it zoomed (x 1600-2000)
    zooms = [{"start": 1.0, "end": 4.0, "box": zbox}]
    held = run(fixture(tmp_path, cues=[{"start": 2.0, "end": 3.0, "side": "bottom", "box": cap, "text": "x"}], zooms=zooms))
    row = only_row(held)
    assert row["verdict"] == "FAIL"
    assert any(c["name"] == "captions" and "zoomed" in c["detail"] for c in row["checks"])
    easing = run(fixture(tmp_path, cues=[{"start": 1.1, "end": 1.5, "side": "bottom", "box": cap, "text": "x"}], zooms=zooms))
    assert only_row(easing)["verdict"] == "FAIL"
    before = run(fixture(tmp_path, cues=[{"start": 0.0, "end": 0.9, "side": "bottom", "box": cap, "text": "x"}], zooms=zooms))
    assert only_row(before)["verdict"] == "PASS"


def test_spinner_visible_at_cue_fails(tmp_path):
    row = only_row(run(fixture(tmp_path, moments=[moment(loading=True)])))
    assert row["verdict"] == "FAIL"
    assert any(c["name"] == "loading" and c["verdict"] == "FAIL" for c in row["checks"])
    slow = only_row(run(fixture(tmp_path, moments=[moment(settleTimedOut=True)])))
    assert slow["verdict"] == "WARN"


def test_numbers_and_allow_listed_names_do_not_fail(tmp_path):
    # Script says "2 documents" and "Mira Solano"; whisper heard "two documents" and "Meera Solana".
    v = run(fixture(tmp_path))
    nar = v["narration"][0]
    assert nar["verdict"] == "PASS", nar
    assert v["pass"] is True and v["counts"]["warn"] == 0
    # Without the allow-list the name is a WARN with a diff, never a FAIL.
    w = run(fixture(tmp_path, allowList=[]))
    nar = w["narration"][0]
    assert nar["verdict"] == "WARN"
    assert "mira solano" in nar["diff"] and "meera solana" in nar["diff"]
    assert w["pass"] is True and w["counts"]["fail"] == 0


def test_number_words():
    assert number_to_words(0) == ["zero"]
    assert number_to_words(42) == ["forty", "two"]
    assert number_to_words(1200) == ["one", "thousand", "two", "hundred"]
    assert number_to_words(2_000_005) == ["two", "million", "five"]
    assert normalise_words("2 documents") == normalise_words("Two documents.")
    assert normalise_words("The 3rd of 12") == ["the", "third", "of", "twelve"]
    assert normalise_words("1,500 items, 3.5% off!") == "one thousand five hundred items three point five percent off".split()
    assert normalise_words("forty-two $5") == ["forty", "two", "five", "dollars"]


def test_loudness_out_of_range_fails(tmp_path):
    v = run(fixture(tmp_path, loudness={"lufs": -17.2, "truePeak": -2.0}))
    assert v["loudness"]["verdict"] == "FAIL"
    assert v["pass"] is False
    assert run(fixture(tmp_path, loudness={"lufs": -15.0, "truePeak": -2.0}))["loudness"]["verdict"] == "PASS"
    peak = run(fixture(tmp_path, loudness={"lufs": -16.0, "truePeak": -1.2}))
    assert peak["loudness"]["verdict"] == "FAIL"


def test_outputs_and_music_licence(tmp_path):
    v = run(fixture(tmp_path, music={"licence": "CC BY 4.0, Example Artist"}))
    out = tmp_path / "audit"
    saved = json.loads((out / "audit.json").read_text())
    assert saved["pass"] == v["pass"] is True
    assert saved["counts"] == {"pass": 3, "warn": 0, "fail": 0}  # 1 moment + narration + loudness
    assert saved["music"] == {"licence": "CC BY 4.0, Example Artist"}
    table = (out / "audit-table.md").read_text()
    assert "CC BY 4.0, Example Artist" in table.split("| scene |")[0]
    assert "| scene | cue | word time | action time | gap | target label | caption side | checks | verdict |" in table
    assert "| s1 | Open | 1.000 (free) | 1.000 | +0.000 | #open |" in table


def test_plan_problem_fails(tmp_path):
    row = only_row(run(fixture(tmp_path, moments=[moment(kind="zoom", problems=["no zoom in the plan within 0.5 s of the action"])])))
    assert row["verdict"] == "FAIL"
    assert any(c["name"] == "plan" for c in row["checks"])


def test_action_cut_from_video_fails(tmp_path):
    row = only_row(run(fixture(tmp_path, moments=[moment(actionTime=None)])))
    assert row["verdict"] == "FAIL"


@pytest.fixture
def tiny_video(tmp_path):
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    video = tmp_path / "final.mp4"
    subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "testsrc2=s=480x270:r=30:d=6", "-pix_fmt", "yuv420p", str(video)],
        check=True,
    )
    return ffmpeg, video


def test_frames_and_contact_sheet(tmp_path, tiny_video):
    from PIL import Image

    ffmpeg, video = tiny_video
    ring = {"box": {"x": 790, "y": 290, "w": 220, "h": 80}, "peak": 1.15, "by": "recorder"}
    moments = [moment(index=i, cue=c, ring=ring) for i, c in enumerate(["Open"] * 7)]
    moments[1]["cue"] = "documents"
    moments[1]["actionTime"] = 1.65
    zoom = {"box": {"x": 420, "y": 52.5, "w": 960, "h": 540}, "start": 1.0, "end": 3.0, "hold": 1.7}
    moments.append(moment(index=7, kind="zoom", zoom=zoom))
    data = fixture(tmp_path, moments=moments, video=str(video), ffmpeg=ffmpeg, zooms=[{"start": 1.0, "end": 3.0, "box": zoom["box"]}])
    v = run(data)
    frames = sorted((tmp_path / "audit" / "frames").glob("*.png"))
    names = [f.name for f in frames]
    assert len(frames) == 8
    assert "s1-Open.png" in names and "s1-Open-2.png" in names and "s1-documents.png" in names
    assert [f["file"] for f in v["frames"]][0] == "frames/s1-Open.png"
    with Image.open(frames[0]) as im:
        assert im.size == (480, 270)
    sheet = tmp_path / "audit" / "contact-sheet.png"
    with Image.open(sheet) as im:
        w, h = im.size
    assert w >= 6 * 200 and h > 0
    rows = v["contactSheet"]["rows"]
    assert v["contactSheet"]["columns"] == 6 and rows == 2


def test_cli_writes_outputs(tmp_path):
    data = fixture(tmp_path)
    inp = tmp_path / "audit-input.json"
    inp.write_text(json.dumps(data))
    import sys

    subprocess.run([sys.executable, "-m", "scenecast_py.audit", "--input", str(inp)], check=True)
    assert json.loads((tmp_path / "audit" / "audit.json").read_text())["pass"] is True


@E2E
def test_real_whisper_hears_the_cue(tmp_path):
    """Kokoro speaks a line into a video; faster-whisper (from the toolchain cache) finds the cue word."""
    import imageio_ffmpeg
    import soundfile as sf

    from scenecast_py.audit import transcribe
    from scenecast_py.kokoro import Kokoro

    cache = Path(os.environ.get("SCENECAST_CACHE") or Path.home() / ".cache" / "scenecast") / "models"
    whisper_dir = next((p.parent for p in (cache / "whisper").rglob("model.bin")), None)
    assert whisper_dir is not None, "run ensureToolchain() first"
    tts = Kokoro(str(cache / "kokoro-v1.0.onnx"), str(cache / "voices-v1.0.bin"))
    audio = tts.create("Open two documents for the team.", voice="af_heart", speed=0.9, lang="en-us")
    wav = tmp_path / "v.wav"
    sf.write(str(wav), audio, 24000)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    video = tmp_path / "final.mp4"
    subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30",
         "-i", str(wav), "-shortest", "-c:v", "libx264", "-c:a", "aac", str(video)],
        check=True,
    )
    words = transcribe(str(video), str(whisper_dir), ffmpeg)
    assert "documents" in [w["w"].strip(" .,").lower() for w in words]
    data = fixture(tmp_path, words=None, video=str(video), ffmpeg=ffmpeg, whisperModel=str(whisper_dir))
    data["scenes"][0]["narration"] = "Open two documents for the team."
    open_at = next(w["start"] for w in words if w["w"].strip(" .,").lower() == "open")
    data["scenes"][0]["moments"] = [moment(actionTime=open_at)]
    v = run(data)
    assert v["narration"][0]["verdict"] == "PASS", v["narration"][0]
    assert only_row(v)["wordSource"] == "transcript"


# ---------------------------------------------------------------- fix round 1


def test_cue_on_allow_listed_misheard_name_uses_the_transcript(tmp_path):
    # Script "Mira Solano", heard "Meera Solana": the cue "Mira" maps to "Meera" by position, not to the plan time.
    row = only_row(run(fixture(tmp_path, moments=[moment(cue="Mira", planWordTime=0.5, actionTime=2.5)])))
    assert row["wordSource"] == "transcript"
    assert row["wordTime"] == pytest.approx(2.5)
    assert row["verdict"] == "PASS"


def test_plain_mishearing_of_the_cue_uses_the_transcript(tmp_path):
    words = [dict(w) for w in WORDS]
    words[0]["w"] = " Hope"  # "Open" misheard
    v = run(fixture(tmp_path, words=words, moments=[moment(planWordTime=0.4, actionTime=1.0)]))
    row = only_row(v)
    assert row["wordSource"] == "transcript" and row["wordTime"] == pytest.approx(1.0)
    assert row["verdict"] == "PASS"
    assert v["narration"][0]["verdict"] == "WARN" and '"hope"' in v["narration"][0]["diff"]


def test_cue_word_index_picks_the_scheduled_occurrence(tmp_path):
    # "1" and "one" normalise alike; the scheduler means the literal word "one" (word 5), not "1".
    narration = "Add 1 item, then add one more."
    words = [{"w": f" {w}", "start": t, "end": t + 0.2} for w, t in
             [("Add", 0.5), ("one", 0.8), ("item,", 1.0), ("then", 1.4), ("add", 1.6), ("one", 1.9), ("more.", 2.1)]]
    data = fixture(tmp_path, words=words, moments=[moment(cue="one", cueWord=5, planWordTime=1.9, actionTime=1.9)])
    data["scenes"][0]["narration"] = narration
    row = only_row(run(data))
    assert row["wordTime"] == pytest.approx(1.9) and row["verdict"] == "PASS"


def test_allow_list_does_not_hide_extra_words(tmp_path):
    words = WORDS[:4] + [{"w": f" {w}", "start": 2.5 + 0.3 * i, "end": 2.7 + 0.3 * i} for i, w in
                         enumerate(["Meera", "Solana", "and", "delete", "everything."])]
    nar = run(fixture(tmp_path, words=words))["narration"][0]
    assert nar["verdict"] == "WARN"
    assert "delete everything" in nar["diff"]


def test_contact_sheet_written_without_ring_or_zoom(tmp_path, tiny_video):
    ffmpeg, video = tiny_video
    v = run(fixture(tmp_path, video=str(video), ffmpeg=ffmpeg))
    assert v["frames"] == []
    assert (tmp_path / "audit" / "contact-sheet.png").exists()
    assert v["contactSheet"]["rows"] == 0


def test_captions_checked_in_scenes_without_cued_steps(tmp_path):
    panel = {"x": 700, "y": 820, "w": 500, "h": 200}
    bottom = {"x": 600, "y": 900, "w": 720, "h": 100}
    data = fixture(tmp_path, events=[event(boxes=[{"kind": "panel", "box": panel}])],
                   cues=[{"start": 0.5, "end": 2.5, "side": "bottom", "box": bottom, "text": "Open it"}])
    data["scenes"][0]["moments"] = []
    v = run(data)
    assert v["moments"] == []
    assert v["scenes"][0]["verdict"] == "FAIL"
    assert v["pass"] is False


def test_caption_reason_before_the_first_event_fails(tmp_path):
    bottom = {"x": 600, "y": 900, "w": 720, "h": 100}
    cue = [{"start": 0.1, "end": 0.6, "side": "bottom", "box": bottom, "text": "x", "reason": "no free position; bottom overlaps least"}]
    row = only_row(run(fixture(tmp_path, cues=cue)))  # the only event is at 1.0 s
    assert row["verdict"] == "FAIL"


def test_more_number_forms():
    assert normalise_words("at 10:30") == normalise_words("at ten thirty")
    assert normalise_words("9:05") == ["nine", "oh", "five"]
    assert normalise_words("$1,500.00") == normalise_words("$1,500")


# ---------------------------------------------------------------- blank frames

BLANK_RULES = {**RULES, "blank": {"gridW": 128, "gridH": 72, "lumaStdMax": 2}, "dissolveSec": 0.35}


def _scene(sid, kind, start, end, cues=(), screen=None):
    return {"id": sid, "kind": kind, "start": start, "end": end, "cues": list(cues), **({"screen": screen} if screen else {})}


def test_blank_frames_fails_a_uniform_frame_in_an_app_scene_only():
    import numpy as np

    from scenecast_py.audit import blank_frames

    rng = np.random.default_rng(0)
    busy = rng.integers(0, 255, size=(72, 128)).astype(np.uint8)
    white = np.full((72, 128), 244, dtype=np.uint8)
    # A caption box drawn over the white frame must not hide it: captions are left out of the check.
    captioned = white.copy()
    captioned[56:68, 30:98] = 40
    cue = {"start": 0.0, "end": 10.0, "box": {"x": 30 * 15, "y": 56 * 15, "w": 68 * 15, "h": 12 * 15}}
    scenes = [_scene("card", "title", 0, 1), _scene("app", "app", 1, 3, [cue])]
    times = [0.5, 1.5, 2.0, 2.5]
    frames = [white, busy, captioned, busy]
    r = blank_frames(times, frames, scenes, BLANK_RULES)
    assert r["verdict"] == "FAIL"
    assert [f["time"] for f in r["frames"]] == [2.0]  # the white card frame at 0.5 s is not an app scene
    assert "2.00 s (app)" in r["detail"]

    ok = blank_frames([0.5, 1.5, 2.5], [white, busy, busy], scenes, BLANK_RULES)
    assert ok["verdict"] == "PASS" and ok["frames"] == []


def test_blank_frames_looks_only_at_the_phone_screen():
    import numpy as np

    from scenecast_py.audit import blank_frames

    frame = np.full((72, 128), 30, dtype=np.uint8)  # dark backdrop
    frame[10:62, 54:74] = 250  # a white, empty phone screen inside it
    frame[8:64, 52:54] = 120  # the drawn outline
    screen = {"x": 54 * 15, "y": 10 * 15, "w": 20 * 15, "h": 52 * 15}
    r = blank_frames([1.0], [frame], [_scene("phone", "app", 0, 2, screen=screen)], BLANK_RULES)
    assert r["verdict"] == "FAIL"
    assert blank_frames([1.0], [frame], [_scene("phone", "app", 0, 2)], BLANK_RULES)["verdict"] == "PASS"


def test_grey_frames_and_blank_check_on_a_video_fixture(tmp_path):
    import imageio_ffmpeg

    from scenecast_py.audit import blank_frames, grey_frames

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    video = tmp_path / "v.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=2",
         "-f", "lavfi", "-i", "color=c=0xF4F6F8:s=1920x1080:r=30:d=2",
         "-filter_complex", "[0:v][1:v]overlay=enable=between(t\\,1.0\\,1.1)",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "2", str(video)],
        check=True,
    )
    times, frames = grey_frames(str(video), ffmpeg, BLANK_RULES)
    assert len(times) == 60 and frames.shape == (60, 72, 128)
    r = blank_frames(times, frames, [_scene("app", "app", 0, 2)], BLANK_RULES)
    assert r["verdict"] == "FAIL"
    assert all(0.99 <= f["time"] <= 1.11 for f in r["frames"]) and len(r["frames"]) >= 3


def test_blank_frames_skip_the_dissolve_to_a_card_but_not_between_app_scenes():
    import numpy as np

    from scenecast_py.audit import blank_frames

    navy = np.full((72, 128), 50, dtype=np.uint8)  # a card colour before its title fades in
    rules = {**BLANK_RULES, "dissolveSec": 0.35}
    to_card = [_scene("a", "app", 0, 4), _scene("card", "title", 4, 6)]
    assert blank_frames([3.9], [navy], to_card, rules)["verdict"] == "PASS"
    assert blank_frames([3.0], [navy], to_card, rules)["verdict"] == "FAIL"
    two_apps = [_scene("a", "app", 0, 4), _scene("b", "app", 4, 8), _scene("c", "title", 8, 9)]
    assert blank_frames([3.9], [navy], two_apps, rules)["verdict"] == "FAIL"


def test_allow_listed_cue_the_recogniser_dropped_is_placed_by_position():
    """Narration "Open Kwiksign now"; the recogniser hears only "Open ... now". An allow-listed cue maps into the
    gap it leaves (after "Open" ends); without the allow-list it is "not heard"."""
    from scenecast_py.narration import SceneSpeech

    scene = {"narration": "Open Kwiksign now.", "start": 0.0, "end": 5.0,
             "phrases": [{"start": 0.5, "end": 3.0, "words": 3}]}
    heard = [{"w": " Open", "start": 0.6, "end": 0.9}, {"w": " now.", "start": 1.8, "end": 2.1}]
    assert SceneSpeech(scene, heard, []).cue_time("Kwiksign", 1, 1) is None
    assert SceneSpeech(scene, heard, ["Kwiksign"]).cue_time("Kwiksign", 1, 1) == pytest.approx(0.9)
    # A word that was heard still maps to its own transcript time.
    assert SceneSpeech(scene, heard, ["Kwiksign"]).cue_time("now", 1, 2) == pytest.approx(1.8)


# ---------------------------------------------------------------- v1.1: frame-edge crops, unzoom rows,
# full-frame targets, scenes that start zoomed


def _zoom_row(tmp_path, zbox, target, screen=None):
    zoom = {"box": zbox, "start": 1.0, "end": 3.0, "hold": 1.7}
    data = fixture(tmp_path, moments=[moment(kind="zoom", target=target, zoom=zoom)],
                   events=[event(boxes=[{"kind": "target", "box": target}])],
                   zooms=[{"start": 1.0, "end": 3.0, "box": zbox}])
    if screen is not None:
        data["scenes"][0]["screen"] = screen
    return only_row(run(data))


def _crop_check(row):
    return next(c for c in row["checks"] if c["name"] == "crop")


def test_crop_exempts_sides_on_the_frame_edge(tmp_path):
    target = {"x": 12, "y": 400, "w": 200, "h": 60}
    on_edge = _zoom_row(tmp_path, {"x": 0, "y": 270, "w": 960, "h": 540}, target)
    assert _crop_check(on_edge)["verdict"] == "PASS"
    off_edge = _zoom_row(tmp_path, {"x": 4, "y": 270, "w": 960, "h": 540}, target)
    crop = _crop_check(off_edge)
    assert crop["verdict"] == "FAIL"
    assert crop["detail"] == "target is 8 px from the zoom edge (needs 24)"
    # Within 0.5 px of the frame edge still counts as on it; the far sides are checked as before.
    assert _crop_check(_zoom_row(tmp_path, {"x": 0.4, "y": 270, "w": 960, "h": 540}, target))["verdict"] == "PASS"
    bottom_right = {"x": 1700, "y": 1010, "w": 210, "h": 60}
    assert _crop_check(_zoom_row(tmp_path, {"x": 960, "y": 540, "w": 960, "h": 540}, bottom_right))["verdict"] == "PASS"
    assert _crop_check(_zoom_row(tmp_path, {"x": 950, "y": 530, "w": 960, "h": 540}, bottom_right))["verdict"] == "FAIL"


def test_crop_exempts_sides_at_or_beyond_the_phone_screen_edge(tmp_path):
    screen = {"x": 760.4, "y": 108, "w": 399.2, "h": 864}  # a phone screen in the frame
    target = {"x": 770, "y": 500, "w": 200, "h": 60}  # 9.6 px inside the screen's left edge
    beyond = _zoom_row(tmp_path, {"x": 700, "y": 300, "w": 768, "h": 432}, target, screen)
    assert _crop_check(beyond)["verdict"] == "PASS"
    at = _zoom_row(tmp_path, {"x": 760.4, "y": 300, "w": 768, "h": 432}, target, screen)
    assert _crop_check(at)["verdict"] == "PASS"
    inside = _zoom_row(tmp_path, {"x": 765, "y": 300, "w": 768, "h": 432}, target, screen)
    assert _crop_check(inside)["verdict"] == "FAIL"


def _unzoom(**kw):
    m = moment(index=1, cue="Open", kind="unzoom", label="", target=None, unzoom={"end": 4.31})
    m.update(kw)
    return m


def test_unzoom_is_checked_for_sync(tmp_path):
    words = [{"w": " Open", "start": 4.0, "end": 4.3}]
    late = only_row(run(fixture(tmp_path, words=words, moments=[_unzoom(actionTime=4.31)])))
    sync = next(c for c in late["checks"] if c["name"] == "sync")
    assert sync["verdict"] == "FAIL"
    assert sync["detail"] == "gap +0.310 s is over 0.30 s"
    ok = only_row(run(fixture(tmp_path, words=words, moments=[_unzoom(actionTime=4.30, unzoom={"end": 4.30})])))
    assert ok["verdict"] == "PASS"
    assert ok["kind"] == "unzoom"
    names = [c["name"] for c in ok["checks"]]
    assert "target" not in names and "crop" not in names
    assert "sync" in names and "captions" in names
    # Even with a target and a zoom in the input, an unzoom row checks neither.
    odd = only_row(run(fixture(tmp_path, words=words, moments=[
        _unzoom(actionTime=4.30, target=TARGET, zoom={"box": {"x": 0, "y": 0, "w": 100, "h": 100}, "start": 1, "end": 4.3, "hold": 1.7})])))
    assert [c["name"] for c in odd["checks"] if c["name"] in ("target", "crop")] == []


def test_full_frame_target_does_not_fail_captions(tmp_path):
    full = {"x": 0, "y": 0, "w": 1920, "h": 1000}
    bottom = {"x": 600, "y": 900, "w": 720, "h": 100}
    cue = [{"start": 0.5, "end": 2.5, "side": "bottom", "box": bottom, "text": "Open it"}]
    row = only_row(run(fixture(tmp_path, cues=cue, events=[event(boxes=[{"kind": "target", "box": full}])])))
    assert next(c for c in row["checks"] if c["name"] == "captions")["verdict"] == "PASS"
    # A box just under 90% of the screen is still protected.
    big = {"x": 0, "y": 0, "w": 1920, "h": 971}
    row = only_row(run(fixture(tmp_path, cues=[{**cue[0], "box": {"x": 600, "y": 900, "w": 720, "h": 100}}],
                               events=[event(boxes=[{"kind": "target", "box": big}])])))
    assert next(c for c in row["checks"] if c["name"] == "captions")["verdict"] == "FAIL"


def test_full_frame_target_on_a_phone_screen_does_not_fail_captions(tmp_path):
    screen = {"x": 760.4, "y": 108, "w": 399.2, "h": 864}
    cue = [{"start": 0.5, "end": 2.5, "side": "bottom", "box": {"x": 600, "y": 900, "w": 720, "h": 100}, "text": "Open it"}]
    data = fixture(tmp_path, cues=cue, events=[event(boxes=[{"kind": "target", "box": dict(screen)}])])
    data["scenes"][0]["screen"] = screen
    assert only_row(run(data))["verdict"] == "PASS"


def test_initial_zoom_gets_a_target_and_crop_row(tmp_path):
    head = {"x": 100, "y": 80, "w": 400, "h": 60}

    def scene_row(initial, moments=None):
        data = fixture(tmp_path, moments=moments)
        if moments == []:
            data["scenes"][0]["moments"] = []
        data["scenes"][0]["initialZoom"] = initial
        v = run(data)
        rows = [r for r in v["scenes"] if r["scene"] == "s1"]
        assert len(rows) == 1
        return rows[0], v

    good, _ = scene_row({"box": {"x": 0, "y": 0, "w": 768, "h": 432}, "target": head})
    assert good["verdict"] == "PASS"
    assert [c["name"] for c in good["checks"]] == ["target", "crop"]
    missed, v = scene_row({"box": {"x": 600, "y": 0, "w": 768, "h": 432}, "target": head})
    target = next(c for c in missed["checks"] if c["name"] == "target")
    assert target["verdict"] == "FAIL"
    assert "does not contain target" in target["detail"]
    assert v["pass"] is False
    tight, _ = scene_row({"box": {"x": 90, "y": 0, "w": 768, "h": 432}, "target": head})
    assert next(c for c in tight["checks"] if c["name"] == "crop")["verdict"] == "FAIL"
    no_box, _ = scene_row({"box": None, "target": head})
    assert no_box["verdict"] == "FAIL"
    assert any(c["name"] == "plan" and "no initial zoom in the plan" in c["detail"] for c in no_box["checks"])
    # A scene with no cued steps keeps its captions check in the same scene row.
    both, _ = scene_row({"box": {"x": 0, "y": 0, "w": 768, "h": 432}, "target": head}, moments=[])
    assert [c["name"] for c in both["checks"]] == ["target", "crop", "captions"]
    # No initial zoom, cued steps: no scene row.
    v = run(fixture(tmp_path))
    assert v["scenes"] == []


def test_a_left_phone_screen_and_a_beside_caption(tmp_path):
    # The phone placed left (centre at 30% of 1920): the input carries its screen, as buildAuditInput writes it.
    screen = {"x": 376.379, "y": 108, "w": 399.242, "h": 864}
    target = {"x": 386, "y": 500, "w": 200, "h": 60}  # 9.6 px inside the screen's left edge
    # The crop rule exempts the zoom side at that screen's edge, wherever the phone sits.
    assert _crop_check(_zoom_row(tmp_path, {"x": 376.379, "y": 300, "w": 768, "h": 432}, target, screen))["verdict"] == "PASS"
    assert _crop_check(_zoom_row(tmp_path, {"x": 381, "y": 300, "w": 768, "h": 432}, target, screen))["verdict"] == "FAIL"
    # A cue beside the phone covers nothing on its screen; the row reports its side.
    beside = {"x": 895.6, "y": 482.8, "w": 750, "h": 114.4}
    cue = [{"start": 0.5, "end": 2.5, "side": "beside", "box": beside, "text": "Tap Requests"}]
    data = fixture(tmp_path, cues=cue, events=[event(boxes=[{"kind": "target", "box": target}])])
    data["scenes"][0]["screen"] = screen
    row = only_row(run(data))
    assert next(c for c in row["checks"] if c["name"] == "captions")["verdict"] == "PASS"
    assert row["captionSide"] == "beside"


# ---------------------------------------------------------------- forced alignment (Task 10)


def _forced(times, narration):
    """What align_phrases returns: one entry per narration word (start None: that phrase could not be aligned)."""
    return [{"w": w, "start": t, "end": None if t is None else t + 0.2, "p": 1.0, "from": None if t is None else "forced"}
            for w, t in zip(narration.split(), times)]


class FakeAligner:
    def __init__(self, times):
        self.times, self.calls = times, []

    def __call__(self, pcm, phrases, model, pad=0.4, bounds=None):
        self.calls.append(phrases)
        self.bounds = bounds
        return _forced(self.times, " ".join(p["text"] for p in phrases))


def _with_media(monkeypatch, tmp_path, tiny_video, data):
    """A video and a model are present (so the aligner runs); decoding and loading are stood in for."""
    import numpy as np

    import scenecast_py.audit as audit

    ffmpeg, video = tiny_video
    monkeypatch.setattr(audit, "_media", lambda video, model_dir, ffmpeg: (np.zeros(16000 * 6, dtype=np.float32), "model"))
    data.update(video=str(video), ffmpeg=ffmpeg, whisperModel=str(tmp_path / "model"))
    return data


NARRATION = "Open 2 documents for Mira Solano."
PHRASES = [{"start": 0.5, "end": 2.2, "words": 3, "text": "Open 2 documents"}, {"start": 2.4, "end": 3.4, "words": 3, "text": "for Mira Solano."}]


def test_cue_time_comes_from_forced_alignment(tmp_path, tiny_video, monkeypatch):
    # The transcript hears "documents" at 2.40 (after its phrase ends); the aligner puts it at 2.05.
    words = [dict(w) for w in WORDS]
    words[2].update(start=2.40, end=2.60)
    m = moment(cue="documents", cueWord=2, planWordTime=1.9, actionTime=2.05)
    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path, words=words, moments=[m]))
    data["scenes"][0]["phrases"] = PHRASES
    aligner = FakeAligner([1.0, 1.4, 2.05, 2.5, 2.8, 3.0])
    row = only_row(run(data, aligner=aligner))
    assert row["wordTime"] == pytest.approx(2.05)
    assert row["wordSource"] == "transcript"
    assert row["verdict"] == "PASS"
    assert [p["text"] for p in aligner.calls[0]] == ["Open 2 documents", "for Mira Solano."]


def test_unheard_cue_still_warns_with_the_plan_time(tmp_path, tiny_video, monkeypatch):
    words = [w for w in WORDS if w["w"].strip() != "documents"]
    m = moment(cue="documents", cueWord=2, planWordTime=1.9, actionTime=2.0)
    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path, words=words, moments=[m]))
    data["scenes"][0]["phrases"] = PHRASES
    row = only_row(run(data, aligner=FakeAligner([1.0, 1.4, 2.05, 2.5, 2.8, 3.0])))
    assert row["wordSource"] == "plan"
    assert row["wordTime"] == pytest.approx(1.9)
    assert any(c["name"] == "word" and c["verdict"] == "WARN" for c in row["checks"])


def test_forced_time_is_clamped_to_its_phrase_and_untimed_phrases_use_the_transcript(tmp_path, tiny_video, monkeypatch):
    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path, moments=[
        moment(index=0, cue="Open", cueWord=0, planWordTime=0.5, actionTime=0.5),
        moment(index=1, cue="Mira", cueWord=4, planWordTime=2.5, actionTime=2.5, target=None)]))
    data["scenes"][0]["phrases"] = PHRASES
    rows = run(data, aligner=FakeAligner([0.2, 1.4, 1.9, None, None, None]))["moments"]
    assert rows[0]["wordTime"] == pytest.approx(0.5)  # 0.2 is before its phrase starts at 0.5
    assert rows[1]["wordTime"] == pytest.approx(2.5)  # no forced time: the transcript's "Meera" at 2.50


def test_adjacent_words_sharing_a_start_are_separated_by_alignment(tmp_path, tiny_video, monkeypatch):
    """v1 evidence: free Whisper gave a room name and the word after it the same start (2.1 s), so one of two actions
    cued on them had to be out of sync. The aligned times (1.75 and 2.45) put both in sync."""
    narration = "Book the Garden Room, then invite the team."
    heard = [{"w": " Book", "start": 0.6, "end": 0.9}, {"w": " the", "start": 0.95, "end": 1.05},
             {"w": " Garden", "start": 1.1, "end": 1.6}, {"w": " Room,", "start": 2.1, "end": 2.3},
             {"w": " then", "start": 2.1, "end": 2.6}, {"w": " invite", "start": 2.8, "end": 3.1},
             {"w": " the", "start": 3.15, "end": 3.25}, {"w": " team.", "start": 3.3, "end": 3.6}]
    moments = [moment(index=0, cue="Room", cueWord=3, planWordTime=1.7, actionTime=1.75),
               moment(index=1, cue="then", cueWord=4, planWordTime=2.4, actionTime=2.45, target=None)]

    def data_for(tmp):
        d = fixture(tmp, words=heard, moments=[dict(m) for m in moments], events=[event(time=1.75)])
        d["allowList"] = []
        d["scenes"][0].update(narration=narration, phrases=[{"start": 0.5, "end": 3.7, "words": 8, "text": narration}])
        return d

    free = run(data_for(tmp_path / "free"))["moments"]
    assert free[0]["wordTime"] == free[1]["wordTime"] == pytest.approx(2.1)
    assert [r["verdict"] for r in free] == ["FAIL", "FAIL"]

    data = _with_media(monkeypatch, tmp_path, tiny_video, data_for(tmp_path / "forced"))
    rows = run(data, aligner=FakeAligner([0.6, 0.95, 1.1, 1.75, 2.45, 2.8, 3.15, 3.3]))["moments"]
    assert [r["wordTime"] for r in rows] == pytest.approx([1.75, 2.45])
    assert [r["verdict"] for r in rows] == ["PASS", "PASS"]


def test_transcription_runs_per_scene_from_half_a_second_before_it(tmp_path, tiny_video, monkeypatch):
    calls = []

    def transcriber(video, model, ffmpeg, start=None, end=None):
        calls.append((start, end))
        return [w for w in WORDS if start <= w["start"] < end]

    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path, words=None))
    second = {**data["scenes"][0], "id": "s2", "start": 6.0, "end": 9.0, "moments": [], "events": [], "narration": "Done."}
    data["scenes"].append(second)
    v = run(data, transcriber=transcriber, aligner=FakeAligner([]))
    assert calls == [(0.0, 6.0), (5.5, 9.0)]
    assert only_row(v)["wordSource"] == "transcript"


def test_no_aligner_without_a_model_or_matching_phrases(tmp_path, tiny_video, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the aligner must not run")

    # A video but no model (the v1 inputs): no alignment.
    ffmpeg, video = tiny_video
    data = fixture(tmp_path, video=str(video), ffmpeg=ffmpeg)
    data["scenes"][0]["phrases"] = PHRASES
    assert only_row(run(data, aligner=boom))["wordTime"] == pytest.approx(1.0)
    # Phrases without text, or whose words don't add up to the narration: no alignment either.
    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path))
    data["scenes"][0]["phrases"] = [{k: v for k, v in p.items() if k != "text"} for p in PHRASES]
    assert only_row(run(data, aligner=boom))["wordTime"] == pytest.approx(1.0)
    data["scenes"][0]["phrases"] = [PHRASES[0]]
    assert only_row(run(data, aligner=boom))["wordTime"] == pytest.approx(1.0)


def test_first_word_stamped_before_the_scene_still_counts_as_heard(tmp_path):
    # Free decoding of a window that starts 0.5 s early stamps the first word with the window start (2.5 s for a scene
    # at 3.0 s); the word runs on into the scene, so it is heard, and the narration matches.
    heard = [{"w": " Welcome", "start": 2.5, "end": 3.44}, {"w": " to", "start": 3.44, "end": 3.7},
             {"w": " Demo", "start": 3.7, "end": 3.95}, {"w": " Co.", "start": 3.95, "end": 4.2}]
    tail = [{"w": " done.", "start": 2.2, "end": 2.6}]  # the previous scene's last word: ends before the scene starts
    m = moment(cue="Welcome", cueWord=0, planWordTime=3.0, actionTime=3.0)
    data = fixture(tmp_path, words=tail + heard, moments=[m], events=[event(time=3.0)])
    data["allowList"] = []
    data["scenes"][0].update(start=3.0, end=6.0, narration="Welcome to Demo Co.",
                             phrases=[{"start": 3.0, "end": 4.3, "words": 4, "text": "Welcome to Demo Co."}])
    v = run(data)
    assert v["narration"][0]["verdict"] == "PASS", v["narration"]
    row = only_row(v)
    assert row["wordSource"] == "transcript" and row["wordTime"] == pytest.approx(3.0)


# ---------------------------------------------------------------- fix round 1: onsets, sources, diagnostics


def test_phrase_first_word_uses_the_voice_onset_and_the_mix_onset_is_a_cross_check(tmp_path, tiny_video, monkeypatch, capsys):
    """Under a music bed the aligner can only find the first word's voiced part in the mix (here 0.18 s late, as Silero
    is on a fricative); the voice stage measured the onset on the clean clip (0.05 s into the phrase), and the mix
    places the clip unchanged, so that is the time used. The disagreement is logged and kept in audit.json."""
    m = moment(cue="Open", cueWord=0, planWordTime=0.55, actionTime=0.56)
    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path, moments=[m]))
    data["scenes"][0]["phrases"] = [dict(PHRASES[0], onset=0.05), dict(PHRASES[1], onset=0.04)]
    v = run(data, aligner=FakeAligner([0.73, 1.4, 1.9, 2.45, 2.8, 3.0]))
    row = only_row(v)
    assert row["wordTime"] == pytest.approx(0.55) and row["wordTimeFrom"] == "onset"
    assert row["verdict"] == "PASS"  # with the mix onset (0.73) the gap would be -0.17 s
    err = capsys.readouterr().err
    assert "first word at 0.550 s by the voice, 0.730 s in the mix (+0.180 s)" in err
    assert "phrase at 2.400" not in err  # 2.44 vs 2.45: within 0.1 s, not logged
    report = v["alignment"][0]
    assert report["scene"] == "s1"
    assert [(p["voiceOnset"], p["mixOnset"], p["timed"]) for p in report["phrases"]] == [(0.05, 0.23, True), (0.04, 0.05, True)]
    assert "| s1 | Open | 0.550 (onset) |" in (tmp_path / "audit" / "audit-table.md").read_text()


def test_word_time_sources_are_recorded(tmp_path, tiny_video, monkeypatch):
    moments = [moment(index=0, cue="Open", cueWord=0, planWordTime=0.5, actionTime=1.0),
               moment(index=1, cue="documents", cueWord=2, planWordTime=2.0, actionTime=2.05, target=None),
               moment(index=2, cue="Mira", cueWord=4, planWordTime=2.5, actionTime=2.5, target=None)]
    words = [w for w in WORDS if w["w"].strip() != "Open"]
    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path, words=words, moments=moments))
    data["scenes"][0]["phrases"] = PHRASES  # no voice onsets (an old timeline): the mix times stand
    rows = run(data, aligner=FakeAligner([1.0, 1.4, 2.05, None, None, None]))["moments"]
    assert [r["wordTimeFrom"] for r in rows] == ["plan", "forced", "free"]
    assert [r["wordSource"] for r in rows] == ["plan", "transcript", "transcript"]


def test_aligner_gets_the_neighbouring_scenes_speech_as_bounds(tmp_path, tiny_video, monkeypatch):
    data = _with_media(monkeypatch, tmp_path, tiny_video, fixture(tmp_path))
    data["scenes"][0]["phrases"] = PHRASES
    before = {**data["scenes"][0], "id": "s0", "start": -1.0, "end": 0.0, "moments": [], "events": [], "narration": "Hi.",
              "phrases": [{"start": -0.9, "end": 0.2, "words": 1, "text": "Hi."}]}
    after = {**before, "id": "s2", "start": 6.0, "end": 8.0, "phrases": [{"start": 3.6, "end": 7.0, "words": 1, "text": "Hi."}]}
    data["scenes"] = [after, data["scenes"][0], before]  # any order
    aligner_calls = []

    def spy(pcm, phrases, model, pad=0.4, bounds=None):
        aligner_calls.append((phrases[0]["text"], bounds))
        return _forced([0.1] * len(" ".join(p["text"] for p in phrases).split()), " ".join(p["text"] for p in phrases))

    run(data, aligner=spy)
    assert ("Open 2 documents", (0.2, 3.6)) in aligner_calls


def test_a_stretched_word_from_before_the_scene_is_not_counted(tmp_path):
    # The previous scene's last word, stretched by Whisper to just past the scene start (0.1 s in): not this scene's.
    tail = [{"w": " done.", "start": 2.6, "end": 3.1}]
    heard = [{"w": f" {w}", "start": 3.2 + 0.2 * i, "end": 3.35 + 0.2 * i} for i, w in enumerate("Welcome to Demo Co.".split())]
    data = fixture(tmp_path, words=tail + heard, moments=[moment(cue="Welcome", cueWord=0, planWordTime=3.2, actionTime=3.2)],
                   events=[event(time=3.2)])
    data["allowList"] = []
    data["scenes"][0].update(start=3.0, end=6.0, narration="Welcome to Demo Co.")
    assert run(data)["narration"][0]["verdict"] == "PASS"


@E2E
def test_real_bed_does_not_move_the_phrase_first_word(tmp_path, monkeypatch, capsys):
    """Kokoro phrases that open with a stop or a fricative, voiced and aligned clean (the voice stage), then mixed under
    the synthesised pad about 13 dB below the voice (as -16 vs -29 LUFS), past its fade-in. The audit's first-word
    times are the voice onsets placed in the mix: within 0.05 s of the onset measured on the clean clip."""
    import numpy as np
    import soundfile as sf

    import scenecast_py.audit as audit
    from scenecast_py import music
    from scenecast_py.kokoro import Kokoro
    from scenecast_py.voice import build_scene, forced_words, resample_16k
    from scenecast_py.whisper import whisper_model

    cache = Path(os.environ.get("SCENECAST_CACHE") or Path.home() / ".cache" / "scenecast") / "models"
    model = whisper_model(str(next(p.parent for p in (cache / "whisper").rglob("model.bin"))))
    tts = Kokoro(str(cache / "kokoro-v1.0.onnx"), str(cache / "voices-v1.0.bin"))
    texts = ["Tap the menu button.", "Select a file to share.", "Fine, then press Save."]
    voice, tl = build_scene(texts, tts, 0.2, speed=0.9)
    forced_words(model, voice, tl["phrases"])  # sets each phrase's clean onset, as the voice stage does
    clean = resample_16k(voice)
    lead = 6.0
    music.generate(lead + len(clean) / 16000 + 6, tmp_path / "bed.wav")
    bed, rate = sf.read(str(tmp_path / "bed.wav"))
    bed = resample_16k(np.interp(np.arange(0, len(bed), rate / 24000), np.arange(len(bed)), bed.mean(axis=1)).astype(np.float32))
    rms = lambda x: float(np.sqrt(np.mean(np.square(x[np.abs(x) > 1e-4])))) if np.any(np.abs(x) > 1e-4) else 0.0  # noqa: E731
    bed = bed * (rms(clean) / rms(bed) * 10 ** (-13 / 20))
    mix = bed[: round(lead * 16000) + len(clean)].copy()
    mix[round(lead * 16000):] += clean
    phrases = [{"text": p["text"], "start": lead + p["start"], "end": lead + p["end"], "words": len(p["text"].split()),
                "onset": p["onset"]} for p in tl["phrases"]]
    narration = " ".join(texts)
    scene = {"id": "s", "start": lead, "end": lead + tl["duration"], "narration": narration, "phrases": phrases}
    monkeypatch.setattr(audit, "_media", lambda *a: (mix, model))
    forced, report = audit._forced_times({"video": "v", "whisperModel": "m", "ffmpeg": "f", "scenes": [scene]}, scene,
                                          audit.align_phrases)
    firsts = [0, 4, 9]
    for k, p in zip(firsts, phrases):
        lo = round(p["start"] * 16000)
        onset = (lo + int(np.argmax(np.abs(clean[lo - round(lead * 16000):]) > 0.02))) / 16000
        assert forced[k]["from"] == "onset"
        assert abs(forced[k]["start"] - onset) <= 0.05, (p["text"], forced[k]["start"], onset)
    print("mix onsets vs voice onsets:", [(r["mixOnset"], r["voiceOnset"]) for r in report])
