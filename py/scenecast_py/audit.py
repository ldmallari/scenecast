"""Per-moment audit of a finished video: sync, target, captions, crop, loading, narration and loudness.

Usage: python -m scenecast_py.audit --input <audit-input.json>

audit-input.json (written by packages/core/src/audit.ts; all times are seconds on the final video's
clock, all boxes are {x, y, w, h} in 1920x1080 frame pixels):
  {"video": str | null, "ffmpeg": str | null, "whisperModel": str | null,
   "words": [{"w", "start", "end"}] | null,   # a precomputed transcript; null runs faster-whisper on `video`
   "outDir": str, "rules": {...}, "loudness": {"lufs", "truePeak"}, "music": {"licence"} | null,
   "allowList": [str],
   "scenes": [{"id", "start", "end", "narration",
               "cues": [{"start", "end", "side", "box", "text", "reason"?}],
               "zooms": [{"start", "end", "box"}],          # the region the composer shows
               "navBox": box | null,
               "events": [{"index", "time" | null, "boxes": [{"kind", "box"}]}],
               "moments": [{"index", "cue", "occ", "offset", "kind", "label", "actionTime" | null,
                            "planWordTime", "target" | null, "loading", "settleTimedOut",
                            "ring": {"box", "peak", "by"} | null,
                            "zoom": {"box", "start", "end", "hold"} | null,
                            "problems": [str]}]}]}           # each one is a FAIL (e.g. no zoom in the plan)

Writes <outDir>/audit.json, audit-table.md, frames/<scene>-<cue>.png and contact-sheet.png.
Exits 0 when the audit ran (the verdict is in audit.json); a crash exits non-zero.
"""
import argparse
import difflib
import json
import re
import subprocess
from pathlib import Path

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"
_RANK = {PASS: 0, WARN: 1, FAIL: 2}
EPS = 1e-6
PX_TOL = 0.5  # boxes come from rounded CSS px and float scaling
WHISPER_RATE = 16000
SHEET_COLUMNS = 6
THUMB_W = 320
LABEL_H = 44

# ---------------------------------------------------------------- narration normalisation

_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen"
).split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_SCALES = ((10**12, "trillion"), (10**9, "billion"), (10**6, "million"), (1000, "thousand"))
_ORDINAL = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
            "nine": "ninth", "twelve": "twelfth"}


def _under_thousand(n):
    out = []
    if n >= 100:
        out += [_ONES[n // 100], "hundred"]
        n %= 100
    if n >= 20:
        out.append(_TENS[n // 10])
        n %= 10
        if n:
            out.append(_ONES[n])
    elif n or not out:
        out.append(_ONES[n])
    return out


def number_to_words(n):
    """English words for a non-negative integer, e.g. 1200 -> ["one", "thousand", "two", "hundred"]."""
    if n >= 10**15:
        return [_ONES[int(d)] for d in str(n)]
    if n == 0:
        return ["zero"]
    out = []
    for value, name in _SCALES:
        if n >= value:
            out += _under_thousand(n // value) + [name]
            n %= value
    if n:
        out += _under_thousand(n)
    return out


def _ordinal(words):
    last = words[-1]
    if last in _ORDINAL:
        last = _ORDINAL[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last += "th"
    return words[:-1] + [last]


_NUMBER = re.compile(r"^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(st|nd|rd|th)?$")
_STRIP = ".,;:!?\"'()[]{}“”‘’…"


def _token_words(piece):
    w = piece.strip(_STRIP)
    if not w:
        return []
    if w == "&":
        return ["and"]
    pre, post = [], []
    if w.startswith("$"):
        w, post = w[1:], ["dollars"]
    if w.endswith("%"):
        w, post = w[:-1], ["percent"] + post
    m = _NUMBER.match(w)
    if m:
        whole, frac, suffix = m.groups()
        words = number_to_words(int(whole.replace(",", "")))
        if suffix and not frac:
            words = _ordinal(words)
        if frac:
            words += ["point"] + [_ONES[int(d)] for d in frac]
        return pre + words + post
    w = re.sub(r"[^a-z0-9]", "", w.replace("’", "").replace("'", ""))
    return pre + ([w] if w else []) + post


def normalise_words(text):
    """Lowercase comparable tokens: punctuation dropped, hyphens split, numbers spelled out."""
    out = []
    for piece in re.split(r"[\s\-–—/]+", text.lower()):
        out += _token_words(piece)
    return out


def _heard_tokens(words):
    """Tokens of the recognised words, and for each token the index of the word it came from."""
    tokens, owner = [], []
    for i, w in enumerate(words):
        for t in normalise_words(w["w"]):
            tokens.append(t)
            owner.append(i)
    return tokens, owner


def _find(tokens, needle, occ):
    """Index of the `occ`-th non-overlapping occurrence of `needle` in `tokens`, or None."""
    if not needle:
        return None
    seen, i = 0, 0
    while i + len(needle) <= len(tokens):
        if tokens[i:i + len(needle)] == needle:
            seen += 1
            if seen == occ:
                return i
            i += len(needle)
        else:
            i += 1
    return None


def _allowed_positions(script, allow_list):
    allowed = set()
    for name in allow_list:
        needle = normalise_words(name)
        if not needle:
            continue
        for i in range(len(script) - len(needle) + 1):
            if script[i:i + len(needle)] == needle:
                allowed.update(range(i, i + len(needle)))
    return allowed


class SceneSpeech:
    """The scene's script aligned to what was heard in its time window."""

    def __init__(self, scene, words, allow_list):
        self.script = normalise_words(scene["narration"])
        self.words = [w for w in words if scene["start"] - 0.05 <= w["start"] < scene["end"]]
        self.heard, self.owner = _heard_tokens(self.words)
        self.matcher = difflib.SequenceMatcher(None, self.script, self.heard, autojunk=False)
        self.pairs = {}
        for a, b, size in self.matcher.get_matching_blocks():
            for k in range(size):
                self.pairs[a + k] = b + k
        self.allowed = _allowed_positions(self.script, allow_list)

    def cue_time(self, cue, occ):
        """Start time of the recognised first word of the cue's occ-th occurrence, or None."""
        i = _find(self.script, normalise_words(cue), occ)
        if i is None or i not in self.pairs:
            return None
        return float(self.words[self.owner[self.pairs[i]]]["start"])

    def diff(self):
        """Differences outside the allow-list, as '-"script" +"heard"' strings."""
        out = []
        for tag, i1, i2, j1, j2 in self.matcher.get_opcodes():
            if tag == "equal":
                continue
            span = range(i1, i2)
            if tag in ("replace", "delete") and all(i in self.allowed for i in span):
                continue
            if tag == "insert" and (i1 - 1 in self.allowed or i1 in self.allowed):
                continue
            said = " ".join(self.script[i1:i2])
            heard = " ".join(self.heard[j1:j2])
            out.append(f'-"{said}" +"{heard}"' if said and heard else (f'-"{said}"' if said else f'+"{heard}"'))
        return out


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
        held_lo, held_hi = z["start"] + ease, z["end"]
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


def _check(name, verdict, detail=""):
    return {"name": name, "verdict": verdict, "detail": detail}


def _fmt_box(b):
    return f'{b["x"]:.0f},{b["y"]:.0f} {b["w"]:.0f}x{b["h"]:.0f}'


def _sync(m, word_time, rules):
    if m["actionTime"] is None:
        return _check("sync", FAIL, "the action is not in the video (cut by retime)"), None
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


def _crop(m, nav, rules):
    z = m["zoom"]
    if z is None:
        return None
    W, H, pad = rules["width"], rules["height"], rules["zoomPadPx"]
    b = z["box"]
    problems = []
    if b["x"] < -PX_TOL or b["y"] < -PX_TOL or b["x"] + b["w"] > W + PX_TOL or b["y"] + b["h"] > H + PX_TOL:
        problems.append(f"zoom {_fmt_box(b)} is outside the frame")
    full = b["w"] >= W - PX_TOL and b["h"] >= H - PX_TOL
    t = m["target"]
    if t is not None and not full:
        inset = min(t["x"] - b["x"], t["y"] - b["y"], b["x"] + b["w"] - t["x"] - t["w"], b["y"] + b["h"] - t["y"] - t["h"])
        if inset < pad - PX_TOL:
            problems.append(f"target is {inset:.0f} px from the zoom edge (needs {pad})")
    if nav is not None:
        nl, nr = max(nav["x"], 0.0), nav["x"] + nav["w"]  # only the on-screen part of the nav counts
        cut = any(nl + PX_TOL < edge < nr - PX_TOL for edge in (b["x"], b["x"] + b["w"]))
        if cut:
            problems.append("zoom cuts the nav partly in")
    return _check("crop", FAIL, "; ".join(problems)) if problems else _check("crop", PASS)


def _loading(m):
    if m["loading"]:
        return _check("loading", FAIL, "a spinner or skeleton is visible at the cue")
    if m.get("settleTimedOut"):
        return _check("loading", WARN, "the page had not settled before this step (settle timed out)")
    return _check("loading", PASS)


def _captions(windows, cues, zooms, rules):
    """Each window is (lo, hi, boxes): no cue shown in it may overlap those boxes on screen."""
    problems = []
    for cue in cues:
        hit = False
        for lo, hi, boxes in windows:
            a, b = max(lo, cue["start"]), min(hi, cue["end"])
            if b - a <= EPS:
                continue
            hit = True
            for view in _views(a, b, zooms, rules["zoomEaseSec"]):
                for item in boxes:
                    area = _overlap(cue["box"], _to_screen(item["box"], view, rules["width"]))
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
    """Every timed event's boxes, active from its time until the next event (or the scene end)."""
    timed = sorted((e for e in scene["events"] if e["time"] is not None), key=lambda e: e["time"])
    out = []
    for i, e in enumerate(timed):
        end = timed[i + 1]["time"] if i + 1 < len(timed) else scene["end"]
        out.append((e["index"], e["time"], end, e["boxes"]))
    return out


def audit_scene(scene, speech, rules):
    moments = sorted(scene["moments"], key=lambda m: m["index"])
    windows = _event_windows(scene)
    rows = []
    for k, m in enumerate(moments):
        heard = speech.cue_time(m["cue"], m.get("occ") or 1)
        word_time, source = (heard, "transcript") if heard is not None else (m["planWordTime"], "plan")
        checks = []
        if source == "plan":
            checks.append(_check("word", WARN, f'cue "{m["cue"]}" was not heard; using the planned word time'))
        checks += [_check("plan", FAIL, p) for p in m.get("problems") or []]
        sync, gap = _sync(m, word_time, rules)
        checks.append(sync)
        for c in (_target(m), _crop(m, scene.get("navBox"), rules)):
            if c is not None:
                checks.append(c)
        # This row owns the events from its step up to the next cued step (the first row also owns earlier ones).
        nxt = moments[k + 1]["index"] if k + 1 < len(moments) else float("inf")
        mine = [(lo, hi, boxes) for idx, lo, hi, boxes in windows if (k == 0 or idx >= m["index"]) and idx < nxt]
        checks.append(_captions(mine, scene["cues"], scene["zooms"], rules))
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


def audit_loudness(loud, rules):
    lufs, tp = loud["lufs"], loud["truePeak"]
    target, tol, tp_max = rules["voiceLufs"], rules["toleranceLu"], rules["truePeakDb"]
    problems = []
    if not abs(lufs - target) <= tol + EPS:
        problems.append(f"{lufs:.1f} LUFS is outside {target} ±{tol}")
    if not tp <= tp_max + EPS:
        problems.append(f"true peak {tp:.1f} dBTP is above {tp_max}")
    return {"lufs": lufs, "truePeak": tp, "verdict": FAIL if problems else PASS, "detail": "; ".join(problems)}


# ---------------------------------------------------------------- media


def transcribe(video, model_dir, ffmpeg):
    """faster-whisper word timestamps for the video's audio. The audio is decoded by the toolchain's ffmpeg
    to 16 kHz mono float (skipping PyAV's decoder)."""
    import numpy as np
    from faster_whisper import WhisperModel

    raw = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", video, "-vn", "-ac", "1",
         "-ar", str(WHISPER_RATE), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    pcm = np.frombuffer(raw, dtype=np.float32)
    model = WhisperModel(model_dir, device="cpu", compute_type="int8")
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
    lines += ["", "## Narration", "", "| scene | verdict | diff |", "|---|---|---|"]
    for n in verdict["narration"]:
        lines.append(f'| {_cell(n["scene"])} | {n["verdict"]} | {_cell(n["diff"] or "matches the script")} |')
    if verdict["frames"]:
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

    rows, narration = [], []
    for scene in data["scenes"]:
        speech = SceneSpeech(scene, words, data.get("allowList") or [])
        rows += audit_scene(scene, speech, rules)
        diff = speech.diff()
        narration.append({"scene": scene["id"], "verdict": WARN if diff else PASS, "diff": "; ".join(diff)})
    loudness = audit_loudness(data["loudness"], rules)

    frames, sheet = [], None
    if data.get("video"):
        frames = extract_frames(data["video"], data["ffmpeg"], data["scenes"], rows, out_dir, rules)
        if frames:
            sheet = contact_sheet(out_dir, frames, rules)

    verdicts = [r["verdict"] for r in rows] + [n["verdict"] for n in narration] + [loudness["verdict"]]
    counts = {"pass": verdicts.count(PASS), "warn": verdicts.count(WARN), "fail": verdicts.count(FAIL)}
    verdict = {
        "pass": counts["fail"] == 0,
        "counts": counts,
        "loudness": loudness,
        "music": data.get("music"),
        "moments": rows,
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
