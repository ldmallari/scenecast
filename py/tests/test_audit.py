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
}

TARGET = {"x": 800, "y": 300, "w": 200, "h": 60}
WORDS = [
    {"w": " Open", "start": 1.00, "end": 1.30},
    {"w": " two", "start": 1.40, "end": 1.60},
    {"w": " documents", "start": 1.65, "end": 2.20},
    {"w": " for", "start": 2.30, "end": 2.45},
    {"w": " Anna", "start": 2.50, "end": 2.80},
    {"w": " Rayes.", "start": 2.85, "end": 3.30},
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
        "allowList": ["Ana Reyes"],
        "scenes": [
            {
                "id": "s1",
                "start": 0.0,
                "end": 6.0,
                "narration": "Open 2 documents for Ana Reyes.",
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


def test_caption_with_layout_reason_fails_and_zoom_moves_the_target(tmp_path):
    bottom = {"x": 600, "y": 900, "w": 720, "h": 100}
    reason = [{"start": 0.5, "end": 2.5, "side": "bottom", "box": bottom, "text": "x", "reason": "both sides overlap the target; bottom overlaps less"}]
    row = only_row(run(fixture(tmp_path, cues=reason)))
    assert row["verdict"] == "FAIL"
    assert any("both sides overlap" in c["detail"] for c in row["checks"])
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
    # Script says "2 documents" and "Ana Reyes"; whisper heard "two documents" and "Anna Rayes".
    v = run(fixture(tmp_path))
    nar = v["narration"][0]
    assert nar["verdict"] == "PASS", nar
    assert v["pass"] is True and v["counts"]["warn"] == 0
    # Without the allow-list the name is a WARN with a diff, never a FAIL.
    w = run(fixture(tmp_path, allowList=[]))
    nar = w["narration"][0]
    assert nar["verdict"] == "WARN"
    assert "ana reyes" in nar["diff"] and "anna rayes" in nar["diff"]
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
    assert "| s1 | Open | 1.000 | 1.000 | +0.000 | #open |" in table


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
    # Script "Ana Reyes", heard "Anna Rayes": the cue "Ana" maps to "Anna" by position, not to the plan time.
    row = only_row(run(fixture(tmp_path, moments=[moment(cue="Ana", planWordTime=0.5, actionTime=2.5)])))
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
                         enumerate(["Anna", "Rayes", "and", "delete", "everything."])]
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
    cue = [{"start": 0.1, "end": 0.6, "side": "bottom", "box": bottom, "text": "x", "reason": "both sides overlap the target; bottom overlaps less"}]
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
