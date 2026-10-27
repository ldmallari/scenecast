import { describe, expect, it } from 'vitest';
import { actionAt, checkSchedule, cueWordIndex, FIRST_ACTION_SEC, POINTER, schedule, scheduleWarnings, spotPoint, travelSecFor } from '../src/schedule.js';
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
const opts = { travelSec: () => 0.4 };

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
    // After the previous action (the click's arrival), not when its glide set off.
    expect(r[2]!.startAt).toBeCloseTo(actionAt(r[1]!));
  });

  it('an uncued step after a cued pointer step never acts before it, whatever its glide', () => {
    // v1.2: the uncued click (glide 0.3 s) started with the cued click's 0.52 s glide and acted 0.22 s before it.
    const r = schedule(
      scene([{ do: 'click', sel: '#a', cue: 'then' }, { do: 'click', sel: '#b', glideMs: 300 }, { do: 'ring', sel: '#c' }]),
      voice,
      { travelSec: (st) => travelSecFor(st) },
    );
    expect(actionAt(r[0]!)).toBeCloseTo(2.0);
    expect(r[1]!.startAt).toBeCloseTo(2.0);
    expect(actionAt(r[1]!)).toBeCloseTo(2.3);
    expect(actionAt(r[2]!)).toBeCloseTo(2.3);
    expect(checkSchedule(scene([]), r, 10)).toEqual([]);
  });

  it('a first uncued step acts once the take has started', () => {
    expect(actionAt(schedule(scene([{ do: 'goto' }]), voice, opts)[0]!)).toBe(FIRST_ACTION_SEC);
    // A pointer step's glide already takes it past the flash.
    expect(schedule(scene([{ do: 'click', sel: '#a' }]), voice, opts)[0]!.startAt).toBe(0);
  });

  it('first-word cue clamps to 0 and flags preposition', () => {
    const [s] = schedule(scene([{ do: 'click', sel: '#a', cue: 'open' }]), voice, opts);
    expect(s!.startAt).toBe(0);
    expect(s!.prePosition).toBe(true);
  });

  it('throws when a cue is not in the voice timeline', () => {
    expect(() => schedule(scene([{ do: 'click', cue: 'banana' }]), voice, opts)).toThrow(
      'scene "s" step 0: cue "banana" not found in the voice timeline (occurrence 1)',
    );
  });

  it('throws when occ exceeds the matches, and for an empty-normalising cue', () => {
    expect(() => schedule(scene([{ do: 'zoom', cue: 'save', occ: 3 }]), voice, opts)).toThrow(
      'cue "save" not found in the voice timeline (occurrence 3)',
    );
    expect(() => schedule(scene([{ do: 'zoom', cue: '...' }]), voice, opts)).toThrow(/not found/);
  });

  it('multi-word cue lands on its first word', () => {
    const n = 'Please tick the box now.';
    const v: SceneVoice = {
      duration: 3,
      phrases: [],
      words: n.split(' ').map((w, k) => ({ w, start: k * 0.5, end: k * 0.5 + 0.4 })),
    };
    const sc = { ...scene([{ do: 'zoom', cue: 'tick the box' }]), narration: n } as Scene;
    expect(schedule(sc, v, opts)[0]!.cueTime).toBe(0.5);
  });

  it('treats NaN or negative travel as 0', () => {
    for (const t of [NaN, -1]) {
      const [s] = schedule(scene([{ do: 'click', cue: 'then' }]), voice, { travelSec: () => t });
      expect(s!.startAt).toBe(2.0);
    }
  });
});

describe('pointer timing', () => {
  const v = (cues: Record<string, number>): SceneVoice => {
    const entries = Object.entries(cues).sort((a, b) => a[1] - b[1]);
    return { duration: 6, phrases: [], words: entries.map(([w, start]) => ({ w, start, end: start + 0.3 })) };
  };

  it('a pre-positioned step has no travel and lands on its cue', () => {
    const [s] = schedule(scene([{ cue: 'Open', do: 'click', sel: '#a' }]), v({ Open: 0.2 }), { travelSec: () => 0.52 });
    expect(s).toMatchObject({ startAt: 0.2, travel: 0, prePosition: true });
    expect(actionAt(s!)).toBeCloseTo(0.2, 6);
  });

  it('a pre-positioned step keeps its offset', () => {
    const [s] = schedule(scene([{ cue: 'Open', do: 'click', sel: '#a', offset: 0.1 }]), v({ Open: 0.2 }), { travelSec: () => 0.52 });
    expect(s).toMatchObject({ startAt: expect.closeTo(0.3, 6), travel: 0, prePosition: true });
  });

  it('glideMs sets the travel', () => {
    const [s] = schedule(scene([{ cue: 'menu', do: 'click', sel: '#a', glideMs: 800 }]), v({ menu: 2.0 }), { travelSec: (st) => travelSecFor(st) });
    expect(s).toMatchObject({ startAt: 1.2, travel: 0.8 });
    expect(actionAt(s!)).toBeCloseTo(2.0, 6);
  });

  it('check and park are pointer steps; every other step has no travel', () => {
    expect([...POINTER].sort()).toEqual(['check', 'click', 'hover', 'park', 'type', 'upload']);
    const out = schedule(
      scene([
        { cue: 'one', do: 'check', sel: '#c' },
        { cue: 'two', do: 'park' },
        { cue: 'three', do: 'ring', sel: '#r' },
      ]),
      v({ one: 1.0, two: 2.0, three: 3.0 }),
      { travelSec: () => 0.52 }, // the scheduler ignores travel for a ring, whatever this returns
    );
    expect(out.map((s) => s.travel)).toEqual([0.52, 0.52, 0]);
    expect(out.map(actionAt)).toEqual([1.0, 2.0, 3.0].map((t) => expect.closeTo(t, 6)));
  });

  it('an uncued pointer step keeps its travel', () => {
    const [, s] = schedule(scene([{ cue: 'one', do: 'wait', ms: 500 }, { do: 'click', sel: '#a' }]), v({ one: 1.0 }), {
      travelSec: () => 0.52,
    });
    expect(s).toMatchObject({ startAt: 1.5, travel: 0.52 });
  });

  /** Every pointer glide starts at or after the previous pointer action, and only the first pointer step is pre-positioned. */
  const glidesInOrder = (out: ReturnType<typeof schedule>) => {
    const ptr = out.filter((s) => POINTER.has(s.step.do));
    ptr.forEach((s, k) => {
      if (k > 0) {
        expect(s.prePosition).toBeFalsy();
        expect(s.startAt).toBeGreaterThanOrEqual(actionAt(ptr[k - 1]!) - 1e-9);
      }
    });
  };

  it('two pointer cues in the first 0.52 s: only the first is pre-positioned, the second glides from it', () => {
    const out = schedule(
      scene([{ cue: 'Open', do: 'click', sel: '#a' }, { cue: 'Settings', do: 'hover', sel: '#b' }]),
      v({ Open: 0.15, Settings: 0.45 }),
      { travelSec: () => 0.52 },
    );
    expect(out[0]).toMatchObject({ startAt: 0.15, travel: 0, prePosition: true });
    expect(out[1]).toMatchObject({ startAt: 0.15, travel: expect.closeTo(0.3, 6) });
    expect(out[1]!.prePosition).toBeUndefined();
    expect(actionAt(out[1]!)).toBeCloseTo(0.45, 6);
    glidesInOrder(out);
  });

  it('a long glideMs after a short gap is shortened to start at the previous action', () => {
    const out = schedule(
      scene([{ cue: 'one', do: 'click', sel: '#a' }, { cue: 'two', do: 'hover', sel: '#b', glideMs: 1500 }]),
      v({ one: 0.6, two: 1.0 }),
      { travelSec: (st) => travelSecFor(st) },
    );
    expect(out[0]).toMatchObject({ startAt: expect.closeTo(0.08, 6), travel: 0.52 });
    expect(out[0]!.prePosition).toBeUndefined();
    expect(out[1]).toMatchObject({ startAt: expect.closeTo(0.6, 6), travel: expect.closeTo(0.4, 6) });
    expect(actionAt(out[1]!)).toBeCloseTo(1.0, 6);
    glidesInOrder(out);
  });

  it('a glide with room keeps its full travel', () => {
    const out = schedule(
      scene([{ cue: 'one', do: 'click', sel: '#a' }, { cue: 'two', do: 'click', sel: '#b', glideMs: 800 }]),
      v({ one: 0.6, two: 2.0 }),
      { travelSec: (st) => travelSecFor(st) },
    );
    expect(out[1]).toMatchObject({ startAt: expect.closeTo(1.2, 6), travel: 0.8 });
    glidesInOrder(out);
  });

  it('parks after a pointer step when the next pointer step is over parkAfterSec away', () => {
    const out = schedule(scene([{ cue: 'one', do: 'click', sel: '#a' }, { cue: 'two', do: 'click', sel: '#b' }]),
      v({ one: 1.0, two: 5.0 }), { travelSec: () => 0.52, park: { to: { x: 1824, y: 486 }, afterSec: 2.5 }, sceneEnd: 6.0 });
    expect(out[0]!.park).toEqual({ at: 1.6, to: { x: 1824, y: 486 } });
    expect(out[1]!.park).toBeUndefined(); // the scene ends 1.0 s after it
  });

  it('does not park when the next pointer step is near, only counting pointer steps', () => {
    const park = { to: { x: 1824, y: 486 }, afterSec: 2.5 };
    const out = schedule(
      scene([
        { cue: 'one', do: 'click', sel: '#a' },
        { cue: 'two', do: 'ring', sel: '#r' },
        { cue: 'three', do: 'hover', sel: '#b' },
        { cue: 'four', do: 'park' },
      ]),
      v({ one: 1.0, two: 1.5, three: 3.0, four: 9.0 }),
      { travelSec: () => 0.52, park, sceneEnd: 20 },
    );
    expect(out[0]!.park).toBeUndefined(); // the hover is 2.0 s later; the ring in between does not count
    expect(out[1]!.park).toBeUndefined(); // not a pointer step
    expect(out[2]!.park).toEqual({ at: 3.6, to: park.to }); // the park step is 6 s later
    expect(out[3]!.park).toBeUndefined(); // a park step never auto-parks
  });

  it('without sceneEnd the last pointer step does not park, and without park nothing does', () => {
    const steps = scene([{ cue: 'one', do: 'click', sel: '#a' }]);
    expect(schedule(steps, v({ one: 1.0 }), { travelSec: () => 0.52, park: { to: { x: 1, y: 1 }, afterSec: 2.5 } })[0]!.park).toBeUndefined();
    expect(schedule(steps, v({ one: 1.0 }), { travelSec: () => 0.52, sceneEnd: 60 })[0]!.park).toBeUndefined();
  });

  it('spotPoint places the margin spots', () => {
    expect(spotPoint('right', { width: 1920, height: 1080 })).toEqual({ x: 1824, y: 486 });
    expect(spotPoint('left', { width: 1920, height: 1080 })).toEqual({ x: 96, y: 486 });
    expect(spotPoint('center', { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540 });
    expect(spotPoint({ x: 10, y: 20 }, { width: 1920, height: 1080 })).toEqual({ x: 10, y: 20 });
  });

  it('travelSecFor: glideMs or 0.52 s for pointer steps and park, 0.25 s on touch, 0 for the rest', () => {
    expect(travelSecFor({ do: 'click', sel: '#a' })).toBe(0.52);
    expect(travelSecFor({ do: 'park', glideMs: 900 })).toBe(0.9);
    expect(travelSecFor({ do: 'check', sel: '#a' }, { touch: true })).toBe(0.25);
    for (const d of ['zoom', 'ring', 'wait', 'scroll', 'press', 'goto', 'unzoom'] as const) expect(travelSecFor({ do: d })).toBe(0);
  });
});

describe('checkSchedule: problems found before anything is recorded', () => {
  const v = (cues: Record<string, number>, duration = 6): SceneVoice => {
    const entries = Object.entries(cues).sort((a, b) => a[1] - b[1]);
    return { duration, phrases: [], words: entries.map(([w, start]) => ({ w, start, end: start + 0.3 })) };
  };
  const sc = (narration: string, steps: Step[]) => ({ id: 's2', kind: 'app', viewport: 'desktop', narration, steps }) as Scene;
  const o = { travelSec: (st: Step) => travelSecFor(st) };

  it('a step on the scene\'s first word: says to cue a later word or add an offset', () => {
    const scn = sc('Start here, then approve it.', [{ cue: 'Start here', do: 'click', sel: '#a' }]);
    const r = schedule(scn, v({ Start: 0, 'here,': 0.3, then: 0.6, approve: 0.9, 'it.': 1.2 }), o);
    expect(checkSchedule(scn, r, 6.45)).toEqual([
      'scene "s2" step 0: click on "Start here" would act at 0.00 s, before the take has started (the flash marker ' +
        `takes the scene's first ${FIRST_ACTION_SEC} s); cue a later word, or add offset: ${FIRST_ACTION_SEC}`,
    ]);
    // On a later word it is fine.
    const later = sc('Start here, then approve it.', [{ cue: 'approve', do: 'click', sel: '#a' }]);
    expect(checkSchedule(later, schedule(later, v({ Start: 0, 'here,': 0.3, then: 0.6, approve: 0.9, 'it.': 1.2 }), o), 6.45)).toEqual([]);
  });

  it('a cued step that acts before the step above it: names both and says what to change', () => {
    const scn = sc('Open the menu and then pick one.', [
      { cue: 'pick', do: 'click', sel: '#a' },
      { cue: 'menu', do: 'ring', sel: '#m' },
    ]);
    const r = schedule(scn, v({ Open: 0.4, the: 0.7, menu: 1.0, and: 1.4, then: 1.6, pick: 2.0, 'one.': 2.3 }), o);
    expect(checkSchedule(scn, r, 6.45)).toEqual([
      'scene "s2" step 1: ring on "menu" would act at 1.00 s, before step 0 (click on "pick") at 2.00 s; steps run in ' +
        'the order they are listed: cue it on a later word, or move it above step 0',
    ]);
  });

  it('an uncued step that runs past the end of the scene: says how much to take off', () => {
    const scn = sc('Type the name of the laptop.', [
      { cue: 'laptop', do: 'type', sel: '#t', text: 'x' },
      { do: 'wait', ms: 2000 },
      { do: 'ring', sel: '#r' },
    ]);
    const r = schedule(scn, v({ Type: 0.3, the: 0.6, name: 0.8, of: 1.1, 'laptop.': 1.4 }, 2.0), o);
    expect(checkSchedule(scn, r, 2.45)).toEqual([
      'scene "s2" step 2: ring (no cue) would act at 3.40 s, after the scene ends at 2.45 s (its narration plus a short ' +
        'breath); give it a cue, or take 0.95 s off the ms of the steps before it',
    ]);
  });
});

describe('scheduleWarnings', () => {
  it('warns when typing is still going as the next step sets off, saying by how much', () => {
    const n = 'Give it a short subject, then pick a category.';
    const words = n.split(' ');
    const v: SceneVoice = { duration: 5, phrases: [], words: words.map((w, k) => ({ w, start: 0.4 + k * 0.3, end: 0.6 + k * 0.3 })) };
    const sc = (cue: string) =>
      ({ id: 's3', kind: 'app', viewport: 'desktop', narration: n, steps: [
        { cue, do: 'type', sel: '#subject', text: 'Screen flickers at start' },
        { cue: 'pick', do: 'click', sel: '#category' },
      ] }) as Scene;
    // "short" at 1.30 s: 24 characters type until 2.14 s; the click on "pick" (2.20 s) sets off at 1.68 s.
    const late = sc('short');
    expect(scheduleWarnings(late, schedule(late, v, { travelSec: (st) => travelSecFor(st) }))).toEqual([
      'scene "s3" step 0: typing "Screen flickers at start" (24 characters, 0.84 s) runs until 2.14 s, after step 1 ' +
        '(click on "pick") is due to start at 1.68 s, so that step will be about 0.46 s late; start typing on an earlier ' +
        'word, or shorten the text',
    ]);
    // Typing from "Give" ends at 1.24 s, before the click sets off.
    const early = sc('Give');
    expect(scheduleWarnings(early, schedule(early, v, { travelSec: (st) => travelSecFor(st) }))).toEqual([]);
  });
});

describe('cueWordIndex', () => {
  it('counts whole words with punctuation trimmed, non-overlapping', () => {
    const words = 'Add 1 item, then add one more, and one again.'.split(' ');
    expect(cueWordIndex(words, 'one', 1)).toBe(5);
    expect(cueWordIndex(words, 'one', 2)).toBe(8);
    expect(cueWordIndex(words, 'item then', 1)).toBe(2);
    expect(cueWordIndex(words, 'one', 3)).toBeNull();
  });

  it('a symbol such as & counts on neither side, so a cue with it matches the narration', () => {
    const words = 'Choose "Save & close". Then print & send.'.split(' ');
    expect(cueWordIndex(words, 'Save & close', 1)).toBe(1);
    expect(cueWordIndex(words, 'Save close', 1)).toBe(1);
    expect(cueWordIndex(words, 'print & send', 1)).toBe(5);
    expect(cueWordIndex(words, '&', 1)).toBeNull();
  });
});
