import { DEFAULTS } from './scene/schema.js';
import { DEFAULT_TRAVEL_SEC, type Take } from './record/record.js';
import type { ScheduledStep } from './schedule.js';
import type { SceneVoice } from './voice.js';

/** One piece of the retimed scene. A hold has `srcIn === srcOut` (the held frame time) and `hold` seconds. */
export interface Segment {
  src: string;
  srcIn: number;
  srcOut: number;
  outStart: number;
  hold?: number;
}

export interface RetimeOpts {
  /** First magenta frame time (from detectFlash). Defaults to `take.flashAt`, which is only an estimate. */
  flashTime?: number;
  /** First non-magenta frame time after the flash. Defaults to flashTime + 0.1 (the flash is held at least 100 ms). */
  flashEnd?: number;
  /** Length of the source file in seconds; past it the last frame is held. Default: unbounded. */
  srcDuration?: number;
  breathSec?: number;
}

const EPS = 1e-6;
const POINTER = new Set(['click', 'hover', 'type']);
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

/**
 * Maps the take onto the voice clock at 1:1 speed: between consecutive events, late idle time is trimmed
 * from a quiet window (after the previous result, before the cursor glide); early arrivals hold the frame before the glide.
 */
export function retime(take: Take, scheduled: ScheduledStep[], voice: SceneVoice, opts: RetimeOpts = {}): Segment[] {
  const flash = opts.flashTime ?? take.flashAt;
  const srcStart = opts.flashEnd ?? flash + 0.1;
  const total = voice.duration + (opts.breathSec ?? DEFAULTS.video.breathSec);
  const srcEnd = opts.srcDuration ?? Infinity;
  const byIndex = new Map(scheduled.map((s) => [s.index, s]));

  const anchors = take.events.map((e) => {
    const sch = byIndex.get(e.index);
    if (!sch) throw new Error(`retime: take event ${e.index} has no scheduled step`);
    const out = sch.startAt + (POINTER.has(e.kind) ? DEFAULT_TRAVEL_SEC : 0);
    return { out, src: flash + e.at };
  });
  for (let i = 1; i < anchors.length; i++)
    if (anchors[i]!.out < anchors[i - 1]!.out - EPS)
      throw new Error(`retime: event ${take.events[i]!.index} is scheduled before the previous event`);

  const segs: Segment[] = [];
  let outT = 0;
  let srcT = srcStart;
  const play = (from: number, len: number) => {
    if (len <= EPS) return;
    const end = Math.min(from + len, srcEnd);
    const got = Math.max(0, end - from);
    if (got > EPS) segs.push({ src: take.file, srcIn: from, srcOut: from + got, outStart: outT });
    outT += got;
    if (len - got > EPS) hold(srcEnd, len - got);
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
  return segs;
}
