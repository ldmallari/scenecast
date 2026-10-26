"""Per-moment audit of a finished video: sync, target, captions, crop, loading, narration and loudness.

Usage: python -m scenecast_py.audit --input <audit-input.json>

audit-input.json (written by packages/core/src/audit.ts; all times are seconds on the final video's
clock, all boxes are {x, y, w, h} in 1920x1080 frame pixels):
  {"video": str | null, "ffmpeg": str | null, "whisperModel": str | null,
   "words": [{"w", "start", "end"}] | null,   # a precomputed transcript; null runs faster-whisper on `video`
   "outDir": str, "rules": {...}, "loudness": {"lufs", "truePeak"}, "music": {"licence"} | null,
   "allowList": [str],
   "scenes": [{"id", "start", "end", "narration",
               "screen": box?,                               # the app's screen: the frame, or the phone screen
               "cues": [{"start", "end", "side", "box", "text", "reason"?}],
               "zooms": [{"start", "end", "box", "instant"?}],  # the region the composer shows; instant: no ease-in
               "initialZoom": {"box": box | null, "target"} | null,  # the zoom the scene starts with
               "navBox": box | null,
               "navs": [{"edge": "left" | "top", "box"}],     # declared navs: shown whole or not at all
               "phrases": [{"start", "end", "words"}],        # phrase windows; a heard word is clamped into its own
               "events": [{"index", "time" | null, "boxes": [{"kind", "box"}]}],
               "moments": [{"index", "cue", "occ", "offset", "kind", "label", "actionTime" | null,
                            "planWordTime", "target" | null, "loading", "settleTimedOut",
                            "ring": {"box", "peak", "by"} | null,
                            "zoom": {"box", "start", "end", "hold"} | null,
                            "unzoom": {"end"} | null,         # kind "unzoom": the plan zoom end it cues
                            "cueWord": int | null,           # the cue's first word in the narration (scheduler's count)
                            "problems": [str]}]}]}           # each one is a FAIL (e.g. no zoom in the plan)

Writes <outDir>/audit.json, audit-table.md, frames/<scene>-<cue>.png and contact-sheet.png (whenever there is a
video; it says so when there are no ring or zoom moments). Narration normalising and alignment live in narration.py.
Exits 0 when the audit ran (the verdict is in audit.json); a crash exits non-zero.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

from scenecast_py.narration import SceneSpeech, normalise_words, number_to_words  # noqa: F401 (re-exported)

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"
_RANK = {PASS: 0, WARN: 1, FAIL: 2}
EPS = 1e-6
PX_TOL = 0.5  # boxes come from rounded CSS px and float scaling
SHEET_COLUMNS = 6
THUMB_W = 320
LABEL_H = 44

# ---------------------------------------------------------------- geometry


def _overlap(a, b):
    w = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    h = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return w * h if w > 0 and h > 0 else 0.0


def _contains(outer, inner):
    return (
        inner["x"] >= outer["x"] - PX_TOL
        and inner["y"] >= outer["y"] - PX_TOL
        and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + PX_TOL
        and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + PX_TOL
    )


def _to_screen(box, zoom, width):
    """Where `box` (frame px) appears on screen while the composer shows the region `zoom`."""
    if zoom is None:
        return box
    s = width / zoom["w"]
    return {"x": (box["x"] - zoom["x"]) * s, "y": (box["y"] - zoom["y"]) * s, "w": box["w"] * s, "h": box["h"] * s}


def _views(lo, hi, zooms, ease):
    """The regions on screen during [lo, hi): None (the whole frame) and/or each zoom's held region.

    While a zoom eases in or out the view lies between the two, so both ends are checked.
    """
    views = []
    rest = [(lo, hi)]
    for z in zooms:
        held_lo, held_hi = z["start"] + (0 if z.get("instant") else ease), z["end"]
        nxt = []
        for a, b in rest:
            if held_hi <= a or held_lo >= b or held_lo >= held_hi:
                nxt.append((a, b))
                continue
            if held_lo > a:
                nxt.append((a, held_lo))
            if held_hi < b:
                nxt.append((held_hi, b))
        rest = nxt
    if any(b - a > EPS for a, b in rest):
        views.append(None)
    for z in zooms:
        if lo < z["end"] + ease and hi > z["start"]:
            views.append(z["box"])
    return views


# ---------------------------------------------------------------- checks


def _intersect(a, b):
    x, y = max(a["x"], b["x"]), max(a["y"], b["y"])
    return {"x": x, "y": y, "w": max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - x),
            "h": max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - y)}


def _fills_screen(box, screen, share):
    """The box covers at least `share` (90%) of the screen; mirrors captions.ts fillsScreen."""
    area = screen["w"] * screen["h"]
    if not area > 0:
        return False
    i = _intersect(box, screen)
    return i["w"] * i["h"] >= share * area - EPS


def _frame(rules):
    return {"x": 0.0, "y": 0.0, "w": rules["width"], "h": rules["height"]}


def _check(name, verdict, detail=""):
    return {"name": name, "verdict": verdict, "detail": detail}


def _fmt_box(b):
    return f'{b["x"]:.0f},{b["y"]:.0f} {b["w"]:.0f}x{b["h"]:.0f}'


def _sync(m, word_time, rules):
    if m["actionTime"] is None:
        return _check("sync", FAIL, "the action is not in the video (cut by retime)"), None
    # Rounded to ms on purpose: inputs are on the ms grid, and float noise must not turn 0.300 into a FAIL.
    gap = round(m["actionTime"] - (word_time + (m.get("offset") or 0)), 3)
    limit = rules["syncMaxSec"]
    if abs(gap) > limit + EPS:
        return _check("sync", FAIL, f"gap {gap:+.3f} s is over {limit:.2f} s"), gap
    return _check("sync", PASS), gap


def _target(m):
    shape = m["ring"] or m["zoom"]
    if shape is None:
        return None
    what = "ring" if m["ring"] else "zoom"
    if m["target"] is None:
        return _check("target", FAIL, f"no target box was logged for the {what}")
    if not _contains(shape["box"], m["target"]):
        return _check("target", FAIL, f'{what} {_fmt_box(shape["box"])} does not contain target {_fmt_box(m["target"])}')
    return _check("target", PASS)


def _cuts_declared(b, nav):
    """A left nav is cut when either side of the zoom falls inside its x-span; a top nav when the zoom
    overlaps it without holding all of it."""
    n = nav["box"]
    if nav["edge"] == "left":
        return any(n["x"] + PX_TOL < e < n["x"] + n["w"] - PX_TOL for e in (b["x"], b["x"] + b["w"]))
    overlap = _overlap(b, n) > PX_TOL
    return overlap and not _contains(b, n)


def _crop(m, nav, rules, navs=(), screen=None):
    """A zoom side within 0.5 px of the frame edge, or at or beyond the app screen's edge (the phone screen),
    shows everything there is on that side, so it is exempt from the inset rule."""
    z = m["zoom"]
    if z is None:
        return None
    W, H, pad = rules["width"], rules["height"], rules["zoomPadPx"]
    b = z["box"]
    sc = screen or _frame(rules)
    problems = []
    if b["x"] < -PX_TOL or b["y"] < -PX_TOL or b["x"] + b["w"] > W + PX_TOL or b["y"] + b["h"] > H + PX_TOL:
        problems.append(f"zoom {_fmt_box(b)} is outside the frame")
    full = b["w"] >= W - PX_TOL and b["h"] >= H - PX_TOL
    t = m["target"]
    if t is not None and not full:
        right, bottom = b["x"] + b["w"], b["y"] + b["h"]
        sides = [  # (inset, the side shows all there is)
            (t["x"] - b["x"], b["x"] <= PX_TOL or b["x"] <= sc["x"] + PX_TOL),
            (t["y"] - b["y"], b["y"] <= PX_TOL or b["y"] <= sc["y"] + PX_TOL),
            (right - t["x"] - t["w"], right >= W - PX_TOL or right >= sc["x"] + sc["w"] - PX_TOL),
            (bottom - t["y"] - t["h"], bottom >= H - PX_TOL or bottom >= sc["y"] + sc["h"] - PX_TOL),
        ]
        insets = [inset for inset, exempt in sides if not exempt]
        inset = min(insets) if insets else None
        if inset is not None and inset < pad - PX_TOL:
            problems.append(f"target is {inset:.0f} px from the zoom edge (needs {pad})")
    if nav is not None:
        nl, nr = max(nav["x"], 0.0), nav["x"] + nav["w"]  # only the on-screen part of the nav counts
        cut = any(nl + PX_TOL < edge < nr - PX_TOL for edge in (b["x"], b["x"] + b["w"]))
        if cut:
            problems.append("zoom cuts the nav partly in")
    for n in navs:
        if _cuts_declared(b, n):
            problems.append(f'zoom cuts the {n["edge"]} nav {_fmt_box(n["box"])} partly in')
    return _check("crop", FAIL, "; ".join(problems)) if problems else _check("crop", PASS)


def _loading(m):
    if m["loading"]:
        return _check("loading", FAIL, "a spinner or skeleton is visible at the cue")
    if m.get("settleTimedOut"):
        return _check("loading", WARN, "the page had not settled before this step (settle timed out)")
    return _check("loading", PASS)


def _captions(windows, cues, zooms, rules, screen=None):
    """Each window is (lo, hi, boxes): no cue shown in it may overlap those boxes on screen. A box that fills
    the app's screen as shown in a view (the screen seen through the view, clipped to the frame) is not
    protected there: no caption could clear it."""
    frame = _frame(rules)
    sc = screen or frame
    share = rules.get("fullFrameShare", 0.9)
    problems = []
    for cue in cues:
        hit = False
        for lo, hi, boxes in windows:
            a, b = max(lo, cue["start"]), min(hi, cue["end"])
            if b - a <= EPS:
                continue
            hit = True
            for view in _views(a, b, zooms, rules["zoomEaseSec"]):
                visible = _intersect(_to_screen(sc, view, rules["width"]), frame)
                for item in boxes:
                    shown = _to_screen(item["box"], view, rules["width"])
                    if _fills_screen(shown, visible, share):
                        continue
                    area = _overlap(cue["box"], shown)
                    if area > 0:
                        where = "zoomed" if view is not None else "unzoomed"
                        problems.append(
                            f'"{cue.get("text", "")}" ({cue["side"]}) covers the {item["kind"]} by {area:.0f} px² ({where}, {a:.2f}-{b:.2f} s)'
                        )
        if hit and cue.get("reason"):
            problems.append(f'"{cue.get("text", "")}": {cue["reason"]}')
    seen = []
    for p in problems:
        if p not in seen:
            seen.append(p)
    return _check("captions", FAIL, "; ".join(seen)) if seen else _check("captions", PASS)


def _worst(checks):
    return max((c["verdict"] for c in checks), key=_RANK.__getitem__, default=PASS)


def _event_windows(scene):
    """Every timed event's boxes, active from its time until the next event (or the scene end), after a
    box-less window from the scene start to the first event (so a cue there is still seen)."""
    timed = sorted((e for e in scene["events"] if e["time"] is not None), key=lambda e: e["time"])
    out = [(-1, scene["start"], timed[0]["time"] if timed else scene["end"], [])]
    for i, e in enumerate(timed):
        end = timed[i + 1]["time"] if i + 1 < len(timed) else scene["end"]
        out.append((e["index"], e["time"], end, e["boxes"]))
    return out


def audit_scene(scene, speech, rules):
    moments = sorted(scene["moments"], key=lambda m: m["index"])
    windows = _event_windows(scene)
    rows = []
    for k, m in enumerate(moments):
        heard = speech.cue_time(m["cue"], m.get("occ") or 1, m.get("cueWord"))
        word_time, source = (heard, "transcript") if heard is not None else (m["planWordTime"], "plan")
        checks = []
        if source == "plan":
            checks.append(_check("word", WARN, f'cue "{m["cue"]}" was not heard; using the planned word time'))
        checks += [_check("plan", FAIL, p) for p in m.get("problems") or []]
        sync, gap = _sync(m, word_time, rules)
        checks.append(sync)
        # An unzoom has nothing to aim at: its row checks sync and captions only.
        shape_checks = () if m["kind"] == "unzoom" else (
            _target(m), _crop(m, scene.get("navBox"), rules, scene.get("navs") or [], scene.get("screen")))
        for c in shape_checks:
            if c is not None:
                checks.append(c)
        # This row owns the events from its step up to the next cued step (the first row also owns earlier ones).
        nxt = moments[k + 1]["index"] if k + 1 < len(moments) else float("inf")
        mine = [(lo, hi, boxes) for idx, lo, hi, boxes in windows if (k == 0 or idx >= m["index"]) and idx < nxt]
        checks.append(_captions(mine, scene["cues"], scene["zooms"], rules, scene.get("screen")))
        checks.append(_loading(m))
        t = m["actionTime"]
        side = next((c["side"] for c in scene["cues"] if t is not None and c["start"] <= t < c["end"]), "none")
        rows.append({
            "scene": scene["id"],
            "index": m["index"],
            "cue": m["cue"],
            "kind": m["kind"],
            "label": m.get("label") or "",
            "wordTime": None if word_time is None else round(float(word_time), 3),
            "wordSource": source,
            "actionTime": None if t is None else round(float(t), 3),
            "gap": gap,
            "captionSide": side,
            "checks": checks,
            "verdict": _worst(checks),
        })
    return rows


def audit_initial_zoom(scene, rules):
    """Target and crop checks for the zoom a scene starts with (none when it starts unzoomed)."""
    iz = scene.get("initialZoom")
    if not iz:
        return []
    if iz.get("box") is None:
        return [_check("plan", FAIL, "no initial zoom in the plan for a scene that starts zoomed")]
    m = {"zoom": {"box": iz["box"]}, "ring": None, "target": iz["target"]}
    return [_target(m), _crop(m, scene.get("navBox"), rules, scene.get("navs") or [], scene.get("screen"))]


def audit_scene_row(scene, rules):
    """The scene row: the initial zoom's target and crop, and the captions of a scene with no cued step (no
    row owns its events, so they are checked here). None when there is nothing to check."""
    checks = audit_initial_zoom(scene, rules)
    if not scene["moments"]:
        windows = [(lo, hi, boxes) for _idx, lo, hi, boxes in _event_windows(scene)]
        checks.append(_captions(windows, scene["cues"], scene["zooms"], rules, scene.get("screen")))
    if not checks:
        return None
    return {"scene": scene["id"], "checks": checks, "verdict": _worst(checks)}


def audit_loudness(loud, rules):
    lufs, tp = loud["lufs"], loud["truePeak"]
    target, tol, tp_max = rules["voiceLufs"], rules["toleranceLu"], rules["truePeakDb"]
    problems = []
    if not abs(lufs - target) <= tol + EPS:
        problems.append(f"{lufs:.1f} LUFS is outside {target} ±{tol}")
    if not tp <= tp_max + EPS:
        problems.append(f"true peak {tp:.1f} dBTP is above {tp_max}")
    return {"lufs": lufs, "truePeak": tp, "verdict": FAIL if problems else PASS, "detail": "; ".join(problems)}


# ---------------------------------------------------------------- blank frames

CAPTION_MARGIN_PX = 6  # a caption box's shadow and anti-aliasing reach a little past its box


def blank_frames(times, frames, scenes, rules):
    """A whole-video check: FAIL when any frame inside an app scene is near-uniform (a blank page mid-navigation,
    say). Each frame is a gridW x gridH grey array covering the whole 1920x1080 frame; only the app's screen
    (the phone screen on phone scenes) counts, and captions shown at that moment are left out. Intro, outro and
    chapter cards are not app scenes, so they never count, and neither does the dissolve between an app scene and
    a card (a plain card colour before its title fades in); a dissolve between two app scenes is still checked."""
    import numpy as np

    b = rules["blank"]
    gw, gh, limit = b["gridW"], b["gridH"], b["lumaStdMax"]
    sx, sy = gw / rules["width"], gh / rules["height"]

    def cells(box, margin=0.0):
        x0 = max(0, int(np.floor((box["x"] - margin) * sx)))
        y0 = max(0, int(np.floor((box["y"] - margin) * sy)))
        x1 = min(gw, int(np.ceil((box["x"] + box["w"] + margin) * sx)))
        y1 = min(gh, int(np.ceil((box["y"] + box["h"] + margin) * sy)))
        return slice(y0, y1), slice(x0, x1)

    ordered = sorted(scenes, key=lambda sc: sc["start"])
    d = rules["dissolveSec"]
    apps, exempt = [], []
    for i, sc in enumerate(ordered):
        if sc.get("kind") != "app":
            continue
        apps.append(sc)
        before = ordered[i - 1] if i > 0 else None  # None: the intro card (or nothing) comes first
        after = ordered[i + 1] if i + 1 < len(ordered) else None  # None: the outro card (or nothing)
        if before is None or before.get("kind") != "app":
            exempt.append((sc["start"] - d, sc["start"] + d))
        if after is None or after.get("kind") != "app":
            exempt.append((sc["end"] - d, sc["end"] + d))
    hits = []
    for t, f in zip(times, frames):
        scene = next((sc for sc in apps if sc["start"] - EPS <= t < sc["end"] - EPS), None)
        if scene is None or any(lo - EPS <= t <= hi + EPS for lo, hi in exempt):
            continue
        mask = np.zeros((gh, gw), dtype=bool)
        mask[cells(scene.get("screen") or {"x": 0, "y": 0, "w": rules["width"], "h": rules["height"]})] = True
        for cue in scene["cues"]:
            if cue["start"] - EPS <= t < cue["end"] + EPS:
                mask[cells(cue["box"], CAPTION_MARGIN_PX)] = False
        if mask.sum() < 16:
            continue
        std = float(np.asarray(f, dtype=np.float64)[mask].std())
        if std <= limit + EPS:
            hits.append({"scene": scene["id"], "time": round(float(t), 3), "std": round(std, 2)})
    if not hits:
        return {"verdict": PASS, "detail": "", "frames": []}
    shown = ", ".join(f'{h["time"]:.2f} s ({h["scene"]})' for h in hits[:10])
    more = f" and {len(hits) - 10} more" if len(hits) > 10 else ""
    return {"verdict": FAIL, "detail": f"{len(hits)} near-uniform frame(s) in app scenes: {shown}{more}", "frames": hits}


def grey_frames(video, ffmpeg, rules):
    """Every frame of the video as a small grey array (area-averaged), with its presentation time."""
    import numpy as np

    b = rules["blank"]
    gw, gh = b["gridW"], b["gridH"]
    p = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-i", video, "-vf", f"scale={gw}:{gh}:flags=area,format=gray,showinfo",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
        check=True, capture_output=True,
    )
    times = [float(m) for m in re.findall(r"pts_time:\s*(-?[\d.]+)", p.stderr.decode("utf-8", "replace"))]
    n = min(len(times), len(p.stdout) // (gw * gh))
    frames = np.frombuffer(p.stdout[: n * gw * gh], dtype=np.uint8).reshape(n, gh, gw)
    return times[:n], frames


# ---------------------------------------------------------------- media


def transcribe(video, model_dir, ffmpeg):
    """faster-whisper word timestamps for the video's audio. The audio is decoded by the toolchain's ffmpeg
    to 16 kHz mono float, and PyAV is never loaded (see scenecast_py.whisper)."""
    from scenecast_py.whisper import decode_audio, whisper_model

    pcm = decode_audio(video, ffmpeg)
    model = whisper_model(model_dir)
    segments, _ = model.transcribe(pcm, language="en", word_timestamps=True, beam_size=5)
    return [{"w": w.word, "start": float(w.start), "end": float(w.end)} for s in segments for w in (s.words or [])]


def _slug(text):
    return re.sub(r"[^A-Za-z0-9_-]+", "-", text).strip("-") or "cue"


def _frame_moments(scenes, rows):
    """(row, time, kind, box-on-screen) for every ring peak and zoom hold."""
    by_key = {(r["scene"], r["index"]): r for r in rows}
    out = []
    for scene in scenes:
        for m in sorted(scene["moments"], key=lambda m: m["index"]):
            row = by_key[(scene["id"], m["index"])]
            if m["ring"] is not None:
                at = m["ring"]["peak"]
                held = [z for z in scene["zooms"] if z["start"] <= at <= z["end"]]
                out.append((row, at, "ring", m["ring"]["box"], held[0]["box"] if held else None))
            if m["zoom"] is not None:
                out.append((row, m["zoom"]["hold"], "zoom", m["target"], m["zoom"]["box"]))
    return out


def extract_frames(video, ffmpeg, scenes, rows, out_dir, rules):
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    used = {}
    frames = []
    for row, at, kind, box, view in _frame_moments(scenes, rows):
        base = f'{_slug(row["scene"])}-{_slug(row["cue"])}'
        used[base] = used.get(base, 0) + 1
        name = base if used[base] == 1 else f"{base}-{used[base]}"
        rel = f"frames/{name}.png"
        subprocess.run(
            [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{max(0.0, at):.3f}",
             "-i", video, "-frames:v", "1", str(out_dir / rel)],
            check=True,
        )
        frames.append({"file": rel, "scene": row["scene"], "cue": row["cue"], "index": row["index"], "kind": kind,
                       "time": round(at, 3), "verdict": row["verdict"],
                       "screenBox": None if box is None else _to_screen(box, view, rules["width"])})
    return frames


def contact_sheet(out_dir, frames, rules):
    """A 6-column grid of the frames, each with a label (scene, cue, kind, time, verdict) and the target outline."""
    from PIL import Image, ImageDraw, ImageFont

    cols = SHEET_COLUMNS
    rows = (len(frames) + cols - 1) // cols
    thumb_h = round(THUMB_W * rules["height"] / rules["width"])
    sheet = Image.new("RGB", (cols * THUMB_W, max(1, rows) * (thumb_h + LABEL_H)), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=14)
    if not frames:
        draw.text((12, 12), "No ring or zoom moments in this video.", fill=(235, 235, 240), font=font)
    colour = {PASS: (90, 200, 120), WARN: (240, 190, 60), FAIL: (235, 80, 80)}
    for i, f in enumerate(frames):
        x, y = (i % cols) * THUMB_W, (i // cols) * (thumb_h + LABEL_H)
        with Image.open(out_dir / f["file"]) as im:
            sheet.paste(im.convert("RGB").resize((THUMB_W, thumb_h)), (x, y))
        if f["screenBox"] is not None:
            k = THUMB_W / rules["width"]
            b = f["screenBox"]
            draw.rectangle([x + b["x"] * k, y + b["y"] * k, x + (b["x"] + b["w"]) * k, y + (b["y"] + b["h"]) * k],
                           outline=colour[f["verdict"]], width=2)
        draw.text((x + 6, y + thumb_h + 4), f'{f["scene"]} · {f["cue"]}'[:40], fill=(235, 235, 240), font=font)
        draw.text((x + 6, y + thumb_h + 23), f'{f["kind"]} @ {f["time"]:.2f}s  {f["verdict"]}', fill=colour[f["verdict"]], font=font)
    sheet.save(out_dir / "contact-sheet.png")
    return {"file": "contact-sheet.png", "columns": cols, "rows": rows}


# ---------------------------------------------------------------- report


def _cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ")


def _t(v):
    return "—" if v is None else f"{v:.3f}"


def _checks_cell(checks):
    return "; ".join(c["name"] + (" ok" if c["verdict"] == PASS else f' {c["verdict"]}: {c["detail"]}') for c in checks)


def write_table(path, verdict):
    c = verdict["counts"]
    loud = verdict["loudness"]
    music = verdict["music"]
    lines = [
        "# Audit",
        "",
        f'**Result: {"PASS" if verdict["pass"] else "FAIL"}** — {c["pass"]} pass, {c["warn"]} warn, {c["fail"]} fail',
        "",
        f'- Loudness: {loud["lufs"]:.1f} LUFS, true peak {loud["truePeak"]:.1f} dBTP — {loud["verdict"]}'
        + (f' ({loud["detail"]})' if loud["detail"] else ""),
        "- Blank frames: " + (
            f'{verdict["blankFrames"]["detail"] or "none in app scenes"} — {verdict["blankFrames"]["verdict"]}'
            if verdict.get("blankFrames") else "not checked (no video)"
        ),
        "- Music: " + (f'user track, licence: {music["licence"]}' if music else "synthesised bed (no licence needed)"),
        "",
        "| scene | cue | word time | action time | gap | target label | caption side | checks | verdict |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in verdict["moments"]:
        gap = "—" if r["gap"] is None else f'{r["gap"]:+.3f}'
        word = _t(r["wordTime"]) + (" (plan)" if r["wordSource"] == "plan" else "")
        lines.append(
            f'| {_cell(r["scene"])} | {_cell(r["cue"])} | {word} | {_t(r["actionTime"])} | {gap} | {_cell(r["label"])} '
            f'| {r["captionSide"]} | {_cell(_checks_cell(r["checks"]))} | {r["verdict"]} |'
        )
    if verdict["scenes"]:
        lines += ["", "## Scene checks", "", "Initial zooms, and the captions of scenes without cued steps.", "",
                  "| scene | checks | verdict |", "|---|---|---|"]
        lines += [f'| {_cell(r["scene"])} | {_cell(_checks_cell(r["checks"]))} | {r["verdict"]} |' for r in verdict["scenes"]]
    lines += ["", "## Narration", "", "| scene | verdict | diff |", "|---|---|---|"]
    for n in verdict["narration"]:
        lines.append(f'| {_cell(n["scene"])} | {n["verdict"]} | {_cell(n["diff"] or "matches the script")} |')
    if verdict["contactSheet"]:
        lines += ["", "## Frames", "", "Contact sheet: `contact-sheet.png`", ""]
        lines += [f'- `{f["file"]}` — {f["kind"]} at {f["time"]:.2f} s ({f["verdict"]})' for f in verdict["frames"]]
    path.write_text("\n".join(lines) + "\n")


def run(data, transcriber=transcribe):
    out_dir = Path(data["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    rules = data["rules"]
    words = data.get("words")
    if words is None:
        if not data.get("video") or not data.get("whisperModel") or not data.get("ffmpeg"):
            raise SystemExit("audit: no transcript given and no video/whisperModel/ffmpeg to make one")
        words = transcriber(data["video"], data["whisperModel"], data["ffmpeg"])

    rows, narration, scene_rows = [], [], []
    for scene in data["scenes"]:
        speech = SceneSpeech(scene, words, data.get("allowList") or [])
        rows += audit_scene(scene, speech, rules)
        scene_row = audit_scene_row(scene, rules)
        if scene_row is not None:
            scene_rows.append(scene_row)
        diff = speech.diff()
        narration.append({"scene": scene["id"], "verdict": WARN if diff else PASS, "diff": "; ".join(diff)})
    loudness = audit_loudness(data["loudness"], rules)

    frames, sheet = [], None
    blank = None  # checked only when there is a video to read
    if data.get("video"):
        frames = extract_frames(data["video"], data["ffmpeg"], data["scenes"], rows, out_dir, rules)
        sheet = contact_sheet(out_dir, frames, rules)
        if "blank" in rules:
            blank = blank_frames(*grey_frames(data["video"], data["ffmpeg"], rules), data["scenes"], rules)

    verdicts = [r["verdict"] for r in rows + scene_rows + narration] + [loudness["verdict"]] + ([blank["verdict"]] if blank else [])
    counts = {"pass": verdicts.count(PASS), "warn": verdicts.count(WARN), "fail": verdicts.count(FAIL)}
    verdict = {
        "pass": counts["fail"] == 0,
        "counts": counts,
        "loudness": loudness,
        "blankFrames": blank,
        "music": data.get("music"),
        "moments": rows,
        "scenes": scene_rows,
        "narration": narration,
        "frames": frames,
        "contactSheet": sheet,
    }
    (out_dir / "audit.json").write_text(json.dumps(verdict, indent=2, ensure_ascii=False) + "\n")
    write_table(out_dir / "audit-table.md", verdict)
    return verdict


def main():
    ap = argparse.ArgumentParser(prog="scenecast_py.audit")
    ap.add_argument("--input", required=True)
    a = ap.parse_args()
    run(json.loads(Path(a.input).read_text()))


if __name__ == "__main__":
    main()
