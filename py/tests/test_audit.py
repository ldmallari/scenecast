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
