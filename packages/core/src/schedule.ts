import type { Scene, Step } from './scene/schema.js';
import type { SceneVoice } from './voice.js';

export interface ScheduledStep {
  index: number;
  step: Step;
  /** Seconds into the scene voice where the cue's first word starts (before offset), or null if uncued. */
  cueTime: number | null;
  /** Seconds into the scene when the step begins. Always >= 0. */
  startAt: number;
  /** Pointer step whose travel would start before the take: the recorder parks the cursor on the target first. */
  prePosition?: boolean;
}

export interface ScheduleOpts {
  travelSec: (step: Step) => number;
}

const POINTER = new Set<Step['do']>(['click', 'hover', 'type']);

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
    const prev = out[index - 1];
    if (cue === null) {
      out.push({ index, step, cueTime: null, startAt: prev ? prev.startAt + (prev.step.ms ?? 0) / 1000 : 0 });
      return;
    }
    const target = cue + (step.offset ?? 0);
    const travel = opts.travelSec(step);
    const raw = POINTER.has(step.do) ? target - (Number.isFinite(travel) && travel > 0 ? travel : 0) : target;
    const item: ScheduledStep = { index, step, cueTime: cue, startAt: Math.max(0, raw) };
    if (raw < 0 && POINTER.has(step.do)) item.prePosition = true;
    out.push(item);
  });
  return out;
}
