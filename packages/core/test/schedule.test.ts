import { describe, expect, it } from 'vitest';
import { schedule } from '../src/schedule.js';
import type { Scene, Step } from '../src/scene/schema.js';
import type { SceneVoice } from '../src/voice.js';

const NARRATION = 'Open the menu. Then press Save, and save again.';
const times = [0, 0.5, 1.0, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5];
const voice: SceneVoice = {
  duration: 4.5,
  phrases: [],
  words: NARRATION.split(/\s+/).map((w, i) => ({ w, start: times[i]!, end: (times[i] ?? 4) + 0.4 })),
};
const scene = (steps: Step[]): Scene =>
  ({ id: 's', kind: 'app', viewport: 'desktop', narration: NARRATION, steps }) as Scene;
const opts = { leadSec: 0.3, travelSec: () => 0.4 };

describe('schedule', () => {
  it('click arrives on cue', () => {
    const [s] = schedule(scene([{ do: 'click', sel: '#a', cue: 'then' }]), voice, opts);
    expect(s!.cueTime).toBe(2.0);
    expect(s!.startAt).toBeCloseTo(1.6);
    expect(s!.prePosition).toBeFalsy();
  });

  it('offset applied, occ picks the nth match, punctuation ignored', () => {
    const [a, b] = schedule(
      scene([
        { do: 'zoom', cue: 'Save', offset: 0.25 },
        { do: 'zoom', cue: 'save', occ: 2 },
      ]),
      voice,
      opts,
    );
    expect(a!.startAt).toBeCloseTo(3.0 + 0.25);
    expect(b!.cueTime).toBe(4.0);
  });

  it('uncued step follows previous', () => {
    const r = schedule(
      scene([{ do: 'wait', ms: 1500, cue: 'then' }, { do: 'click', sel: '#b' }, { do: 'press' }]),
      voice,
      opts,
    );
    expect(r[1]!.cueTime).toBeNull();
    expect(r[1]!.startAt).toBeCloseTo(2.0 + 1.5);
    expect(r[2]!.startAt).toBeCloseTo(r[1]!.startAt);
  });

  it('first uncued step starts at 0', () => {
    expect(schedule(scene([{ do: 'goto' }]), voice, opts)[0]!.startAt).toBe(0);
  });

  it('first-word cue clamps to 0 and flags preposition', () => {
    const [s] = schedule(scene([{ do: 'click', sel: '#a', cue: 'open' }]), voice, opts);
    expect(s!.startAt).toBe(0);
    expect(s!.prePosition).toBe(true);
  });
});
