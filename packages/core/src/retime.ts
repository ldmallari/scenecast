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
/** Source seconds kept before an action when a hold is inserted, so the action itself is not shown early. */
const PRE_ACTION = 0.04;

/**
 * Maps the take onto the voice clock at 1:1 speed: between consecutive events, late idle time is trimmed
 * from the start of the interval and early arrivals are covered by holding the frame just before the action.
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

  for (const a of anchors) {
    const d = a.out - outT;
    const s = Math.max(0, a.src - srcT);
    if (s >= d) {
      play(srcT + (s - d), d);
    } else {
      const pre = Math.min(PRE_ACTION, s);
      play(srcT, s - pre);
      hold(Math.min(a.src - pre, srcEnd), d - s + pre);
    }
    outT = a.out;
    srcT = Math.max(srcT, a.src);
  }
  play(srcT, total - outT);
  return segs;
}
