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
  leadSec: number;
  travelSec: (step: Step) => number;
}

const POINTER = new Set<Step['do']>(['click', 'hover', 'type']);

function norm(w: string): string {
  return w.toLowerCase().replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
}

/** Start time of the first word of the nth occurrence of `cue` in the word list, or null. */
function cueStart(voice: SceneVoice, cue: string, occ: number): number | null {
  const target = cue.trim().split(/\s+/).map(norm);
  const words = voice.words.map((x) => norm(x.w));
  let seen = 0;
  for (let i = 0; i + target.length <= words.length; i++) {
    if (target.every((t, j) => words[i + j] === t) && ++seen === occ) return voice.words[i]!.start;
    // non-overlapping, like countCue: after a match, continue past it
    if (seen > 0 && target.every((t, j) => words[i + j] === t)) i += target.length - 1;
  }
  return null;
}

/** Pure scheduler: decides when each step starts so it lands on the word that names it. `leadSec` is not applied here (edit stage). */
export function schedule(scene: Scene, voice: SceneVoice, opts: ScheduleOpts): ScheduledStep[] {
  const out: ScheduledStep[] = [];
  scene.steps.forEach((step, index) => {
    const cue = step.cue === undefined ? null : cueStart(voice, step.cue, step.occ ?? 1);
    const prev = out[index - 1];
    if (cue === null) {
      out.push({ index, step, cueTime: null, startAt: prev ? prev.startAt + (prev.step.ms ?? 0) / 1000 : 0 });
      return;
    }
    const target = cue + (step.offset ?? 0);
    const raw = POINTER.has(step.do) ? target - opts.travelSec(step) : target;
    const item: ScheduledStep = { index, step, cueTime: cue, startAt: Math.max(0, raw) };
    if (raw < 0 && POINTER.has(step.do)) item.prePosition = true;
    out.push(item);
  });
  return out;
}
