import { DEFAULTS } from './scene/schema.js';
import { DEFAULT_TRAVEL_SEC, travelSecFor, type Take } from './record/record.js';
import type { ScheduledStep } from './schedule.js';
import type { SceneVoice } from './voice.js';

/**
 * One piece of the retimed scene. A hold has `srcIn === srcOut` (the held frame time) and `hold` seconds.
 * Renderers place segments at outStart; lengths are whole output frames.
 */
export interface Segment {
  src: string;
  srcIn: number;
  srcOut: number;
  outStart: number;
  hold?: number;
}

export interface RetimeOpts {
  /** Scene id, for error messages. */
  sceneId: string;
  /** First magenta frame time (from scanFlash); `take.flashAt` is only an estimate. */
  flashTime: number;
  /** First non-magenta frame time after the flash (from scanFlash). */
  flashEnd: number;
  /** Length of the source file in seconds; past it the last decodable frame is held. Default: unbounded. */
  srcDuration?: number;
  breathSec?: number;
  fps?: number;
}

/** Frame period of the webm the recorder produces; the last decodable frame is this far before the end. */
const SRC_FRAME = 1 / 25;
const EPS = 1e-6;
/** Never cut or freeze inside this long a stretch before an action: the cursor glide plus a margin. */
const PROTECT_BEFORE = DEFAULT_TRAVEL_SEC + 0.15;
/** Never cut this soon after the previous event, so its visible result plays out. */
const KEEP_AFTER = 0.8;
/** Last-resort cuts start just after this. */
const FALLBACK_AFTER = 0.3;

type Range = [number, number];

/** Source ranges to remove from [p, n] so that `excess` seconds go, quietest places first. */
function cutRanges(p: number, n: number, excess: number, label: string): Range[] {
  const g = Math.max(p, n - PROTECT_BEFORE);
  const winLo = p + KEEP_AFTER;
  const w = g - winLo;
  if (w >= excess) {
    const mid = (winLo + g) / 2;
    return [[mid - excess / 2, mid + excess / 2]];
  }
  console.warn(`scenecast: retime: ${label}: quiet window (${Math.max(0, w).toFixed(2)} s) is shorter than the ${excess.toFixed(2)} s to cut`);
  const cuts: Range[] = [];
  let left = excess;
  const take = (lo: number, hi: number) => {
    const len = Math.min(left, hi - lo);
    if (len <= EPS) return;
    cuts.push([lo, lo + len]);
    left -= len;
  };
  if (w > 0) take(winLo, g);
  take(p + FALLBACK_AFTER, Math.min(winLo, g));
  take(p, Math.min(p + FALLBACK_AFTER, g));
  take(g, n); // only if everything quieter is used up
  return cuts.sort((x, y) => x[0] - y[0]);
}

/** Snaps segment starts to the output frame grid; each length is the gap to the next snapped start. */
function quantise(segs: Segment[], total: number, fps: number): Segment[] {
  const q = (t: number) => Math.round(t * fps) / fps;
  const out: Segment[] = [];
  segs.forEach((g, i) => {
    const start = q(g.outStart);
    const end = i + 1 < segs.length ? q(segs[i + 1]!.outStart) : q(total);
    const len = end - start;
    if (len < 0.5 / fps) return;
    out.push(g.hold !== undefined ? { ...g, outStart: start, hold: len } : { ...g, outStart: start, srcOut: g.srcIn + len });
  });
  return out;
}

/**
 * Maps the take onto the voice clock at 1:1 speed: between consecutive events, late idle time is trimmed
 * from a quiet window (after the previous result, before the cursor glide); early arrivals hold the frame before the glide.
 */
export function retime(take: Take, scheduled: ScheduledStep[], voice: SceneVoice, opts: RetimeOpts): Segment[] {
  const { flashTime: flash, flashEnd: srcStart, sceneId } = opts;
  const fps = opts.fps ?? DEFAULTS.video.fps;
  const total = voice.duration + (opts.breathSec ?? DEFAULTS.video.breathSec);
  const srcEnd = opts.srcDuration ?? Infinity;
  const byIndex = new Map(scheduled.map((s) => [s.index, s]));

  const anchors = take.events.map((e) => {
    const sch = byIndex.get(e.index);
    if (!sch) throw new Error(`scene "${sceneId}": take event ${e.index} has no scheduled step`);
    return { out: sch.startAt + travelSecFor(sch.step), src: flash + e.at };
  });
  anchors.forEach((a, i) => {
    const idx = take.events[i]!.index;
    if (a.src < srcStart - EPS) throw new Error(`scene "${sceneId}": action ${idx} happened before the take started`);
    const prev = anchors[i - 1];
    if (prev && a.src < prev.src - EPS && a.out >= prev.out - EPS)
      throw new Error(`scene "${sceneId}": take events out of order at action ${idx}`);
    if (prev && a.out < prev.out - EPS)
      throw new Error(`scene "${sceneId}": action ${idx} is scheduled before the previous action`);
  });

  const segs: Segment[] = [];
  let outT = 0;
  let srcT = srcStart;
  const play = (from: number, len: number) => {
    if (len <= EPS) return;
    const end = Math.min(from + len, srcEnd);
    const got = Math.max(0, end - from);
    if (got > EPS) segs.push({ src: take.file, srcIn: from, srcOut: from + got, outStart: outT });
    outT += got;
    if (len - got > EPS) hold(srcEnd - SRC_FRAME, len - got);
  };
  const hold = (at: number, len: number) => {
    if (len <= EPS) return;
    segs.push({ src: take.file, srcIn: at, srcOut: at, outStart: outT, hold: len });
    outT += len;
  };

  anchors.forEach((a, k) => {
    const d = a.out - outT;
    const span = Math.max(0, a.src - srcT);
    if (span > d) {
      let from = srcT;
      for (const [lo, hi] of cutRanges(srcT, a.src, span - d, `event ${take.events[k]!.index}`)) {
        play(from, lo - from);
        from = hi;
      }
      play(from, a.src - from);
    } else {
      const h = Math.max(srcT, a.src - PROTECT_BEFORE);
      play(srcT, h - srcT);
      hold(h, d - span);
      play(h, a.src - h);
    }
    outT = a.out;
    srcT = Math.max(srcT, a.src);
  });
  play(srcT, total - outT);
  return quantise(segs, total, fps);
}

/**
 * Where source time `src` of the take shows on the scene's output clock, by the retimed segments: the
 * inverse of `retime`. Null when that moment was cut out. A source time up to one output frame past a
 * clip's end (frame-grid rounding) still maps to that clip.
 */
export function outputTimeOf(segments: Segment[], src: number, fps: number = DEFAULTS.video.fps): number | null {
  const clips = segments.filter((g) => g.hold === undefined);
  const inside = clips.find((g) => src >= g.srcIn - EPS && src < g.srcOut - EPS);
  if (inside) return inside.outStart + (src - inside.srcIn);
  const near = clips.filter((g) => src >= g.srcIn - EPS && src <= g.srcOut + 1 / fps + EPS).at(-1);
  return near ? near.outStart + (near.srcOut - near.srcIn) : null;
}
