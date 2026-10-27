import { DEFAULTS, type CursorSpot, type Scene, type Step } from './scene/schema.js';
import type { SceneVoice } from './voice.js';

/** A point in viewport CSS px. */
export type Point = { x: number; y: number };

export interface ScheduledStep {
  index: number;
  step: Step;
  /** Seconds into the scene voice where the cue's first word starts (before offset), or null if uncued. */
  cueTime: number | null;
  /** Seconds into the scene when the step begins (pointer steps: when the cursor sets off). Always >= 0. */
  startAt: number;
  /** Seconds the cursor travels from `startAt` to the action. 0 for non-pointer and pre-positioned steps. */
  travel: number;
  /** Pointer step whose travel would start before the take: the cursor waits on the target from the start, no glide. */
  prePosition?: boolean;
  /** Glide the cursor to `to` at `at` (scene seconds) after this step's action: the next pointer action is far off. */
  park?: { at: number; to: Point };
}

export interface ScheduleOpts {
  travelSec: (step: Step) => number;
  /** Auto-park after a pointer step when the next pointer action (or the scene end) is more than `afterSec` away. */
  park?: { to: Point; afterSec: number };
  /** Scene length in seconds; without it, the last pointer step never parks. */
  sceneEnd?: number;
}

/** Steps that move the cursor to act. Every one gets travel before its action; every other step gets none. */
export const POINTER: ReadonlySet<Step['do']> = new Set<Step['do']>(['click', 'hover', 'type', 'check', 'upload', 'park']);

/** Default cursor travel: every glide takes this long, whatever the distance, so the scheduler's arithmetic holds. */
export const DEFAULT_TRAVEL_SEC = 0.52;

/** Retime never cuts or freezes inside a step's travel plus this margin before its action; a park glide stays clear of it. */
export const PROTECT_MARGIN_SEC = 0.15;

/** Seconds the cursor travels before a step's action: `glideMs` (default 520 ms) for pointer steps, the touch lead on touch. */
export function travelSecFor(step: Step, opts: { touch?: boolean } = {}): number {
  if (!POINTER.has(step.do)) return 0;
  if (opts.touch) return DEFAULTS.phone.touchLeadSec;
  return step.glideMs !== undefined ? step.glideMs / 1000 : DEFAULT_TRAVEL_SEC;
}

/** When a scheduled step's action fires, in scene seconds. */
export function actionAt(s: ScheduledStep): number {
  return s.startAt + s.travel;
}

/** A cursor spot as a viewport point: `center`, or `left`/`right` at the margin and the spot height. */
export function spotPoint(spot: CursorSpot, viewport: { width: number; height: number }): Point {
  const { marginPx, spotY } = DEFAULTS.cursor;
  switch (spot) {
    case 'center':
      return { x: viewport.width / 2, y: viewport.height / 2 };
    case 'left':
      return { x: marginPx, y: viewport.height * spotY };
    case 'right':
      return { x: viewport.width - marginPx, y: viewport.height * spotY };
    default:
      return { x: spot.x, y: spot.y };
  }
}

function norm(w: string): string {
  return w.toLowerCase().replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
}

/** Index of the first word of the nth occurrence of `cue` in `words` (punctuation trimmed, case-insensitive), or null. */
export function cueWordIndex(words: string[], cue: string, occ: number): number | null {
  const target = cue.trim().split(/\s+/).map(norm);
  if (target.some((t) => t === '')) return null;
  const ws = words.map(norm);
  let seen = 0;
  for (let i = 0; i + target.length <= ws.length; i++) {
    if (!target.every((t, j) => ws[i + j] === t)) continue;
    if (++seen === occ) return i;
    i += target.length - 1; // non-overlapping, like countCue
  }
  return null;
}

/** Start time of the first word of the nth occurrence of `cue` in the word list, or null. */
function cueStart(voice: SceneVoice, cue: string, occ: number): number | null {
  const i = cueWordIndex(voice.words.map((x) => x.w), cue, occ);
  return i === null ? null : voice.words[i]!.start;
}

/** Pure scheduler: decides when each step starts so it lands on the word that names it. */
export function schedule(scene: Scene, voice: SceneVoice, opts: ScheduleOpts): ScheduledStep[] {
  const out: ScheduledStep[] = [];
  scene.steps.forEach((step, index) => {
    const occ = step.occ ?? 1;
    const cue = step.cue === undefined ? null : cueStart(voice, step.cue, occ);
    if (step.cue !== undefined && cue === null)
      throw new Error(
        `scene "${scene.id}" step ${index}: cue "${step.cue}" not found in the voice timeline (occurrence ${occ})`,
      );
    const pointer = POINTER.has(step.do);
    const t = pointer ? opts.travelSec(step) : 0;
    const travel = Number.isFinite(t) && t > 0 ? t : 0;
    const prev = out[index - 1];
    if (cue === null) {
      out.push({ index, step, cueTime: null, startAt: prev ? prev.startAt + (prev.step.ms ?? 0) / 1000 : 0, travel });
      return;
    }
    const target = cue + (step.offset ?? 0);
    const raw = target - travel;
    const prevPointer = pointer ? [...out].reverse().find((s) => POINTER.has(s.step.do)) : undefined;
    if (pointer && prevPointer) {
      // Only the first pointer step can wait on its target from the start. A later one never sets off before the
      // previous pointer action: its glide is shortened to fit and still lands on its cue.
      const from = Math.max(0, actionAt(prevPointer));
      if (raw < from) {
        out.push({ index, step, cueTime: cue, startAt: from, travel: Math.max(0, target - from) });
        return;
      }
    } else if (pointer && raw < 0) {
      // No time to glide before the take starts: the cursor waits on the target and the action fires on its cue.
      out.push({ index, step, cueTime: cue, startAt: Math.max(0, target), travel: 0, prePosition: true });
      return;
    }
    out.push({ index, step, cueTime: cue, startAt: Math.max(0, raw), travel });
  });
  if (opts.park) addParks(out, opts.park, opts.sceneEnd);
  return out;
}

/** Parks the cursor after each pointer action whose next pointer action (or the scene end) is more than `afterSec` later. */
function addParks(steps: ScheduledStep[], park: { to: Point; afterSec: number }, sceneEnd: number | undefined): void {
  const pointers = steps.filter((s) => POINTER.has(s.step.do));
  pointers.forEach((s, k) => {
    if (s.step.do === 'park') return; // already parked
    const at = actionAt(s);
    const next = pointers[k + 1];
    const until = next ? actionAt(next) : sceneEnd;
    if (until === undefined || until - at <= park.afterSec) return;
    s.park = { at: at + DEFAULTS.cursor.parkDelaySec, to: { ...park.to } };
  });
}
