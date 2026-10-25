import { describe, expect, it } from 'vitest';
import { eventsForCaptions, layoutCaptions, parseSrt, toSrt, type CaptionEvent } from '../src/captions.js';
import { phoneToFrame } from '../src/frame.js';
import type { Take } from '../src/record/record.js';
import type { ScheduledStep } from '../src/schedule.js';
import type { SceneVoice } from '../src/voice.js';

const scene = { id: 's' };
const voice = (text: string, start = 1, end = 5): SceneVoice => ({ duration: end + 1, phrases: [{ text, start, end }], words: [] });
const LONG = 'Open the settings page and you will see every option that controls your account';
const box = (x: number, y: number, w = 200, h = 60) => ({ x, y, w, h });

describe('captions', () => {
  it('wraps to two balanced lines', () => {
    const [cue] = layoutCaptions(scene, voice(LONG), []);
    expect(cue!.lines).toHaveLength(2);
    expect(Math.abs(cue!.lines[0]!.length - cue!.lines[1]!.length)).toBeLessThanOrEqual(12);
    expect(Math.max(...cue!.lines.map((l) => l.length))).toBeLessThanOrEqual(42);
    expect(cue!.start).toBe(1);
    expect(cue!.end).toBe(5);
  });

  it('splits a very long phrase into timed cues without a one-word line', () => {
    const cues = layoutCaptions(scene, voice(`${LONG} ${LONG}`), []);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.start).toBe(1);
    expect(cues.at(-1)!.end).toBe(5);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeCloseTo(cues[i - 1]!.end, 9);
    for (const c of cues) for (const l of c.lines) expect(l.split(' ').length).toBeGreaterThan(1);
  });

  it('no orphan word', () => {
    // greedy wrapping at 42 would leave "now" alone on line two
    const text = 'Open the settings page and you will see it now';
    const [cue] = layoutCaptions(scene, voice(text), []);
    expect(cue!.lines).toHaveLength(2);
    for (const l of cue!.lines) expect(l.split(' ').length).toBeGreaterThanOrEqual(2);
    expect(cue!.lines.join(' ')).toBe(text);
  });

  it('every cue of a 4+ word phrase has at least two words', () => {
    for (const text of [`${LONG} ${LONG} one`, `${LONG} ${LONG} ${LONG} x y`]) {
      const cues = layoutCaptions(scene, voice(text), []);
      for (const c of cues) {
        expect(c.lines.join(' ').split(' ').length).toBeGreaterThanOrEqual(2);
        for (const l of c.lines) expect(l.split(' ').length).toBeGreaterThanOrEqual(2);
      }
      expect(cues.flatMap((c) => c.lines).join(' ')).toBe(text);
    }
  });

  it('hard-breaks words longer than a line and keeps boxes in the frame', () => {
    for (const len of [50, 90, 200]) {
      const word = 'x'.repeat(len);
      for (const text of [word, `a ${word} b`, `${word} ${word}`]) {
        const cues = layoutCaptions(scene, voice(text), []);
        expect(cues.length).toBeGreaterThan(0);
        for (const c of cues) {
          expect(c.lines.length).toBeGreaterThan(0);
          for (const l of c.lines) {
            expect(l.length).toBeGreaterThan(0);
            expect(l.length).toBeLessThanOrEqual(42);
          }
          expect(c.box.x).toBeGreaterThanOrEqual(0);
          expect(c.box.x + c.box.w).toBeLessThanOrEqual(1920);
        }
        expect(cues.flatMap((c) => c.lines).join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''));
      }
    }
  });

  it('gives no cues for an empty phrase', () => {
    expect(layoutCaptions(scene, voice(''), [])).toEqual([]);
    expect(layoutCaptions(scene, voice('   '), [])).toEqual([]);
  });

  it('cue times are contiguous within a phrase, exactly', () => {
    const cues = layoutCaptions(scene, voice(`${LONG} ${LONG} ${LONG}`, 1.1, 7.3), []);
    expect(cues.length).toBeGreaterThan(2);
    expect(cues[0]!.start).toBe(1.1);
    expect(cues.at(-1)!.end).toBe(7.3);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBe(cues[i - 1]!.end);
  });

  it('moves to top when target in bottom quarter', () => {
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(800, 900)] }];
    const [cue] = layoutCaptions(scene, voice('Click save'), ev);
    expect(cue!.side).toBe('top');
    expect(cue!.box.y).toBe(72);
    expect(cue!.reason).toBeUndefined();
  });

  it('stays at the bottom when the box is only active outside the cue', () => {
    const ev: CaptionEvent[] = [{ start: 6, end: 10, boxes: [box(800, 900)] }];
    expect(layoutCaptions(scene, voice('Click save'), ev)[0]!.side).toBe('bottom');
  });

  it('avoids open panel', () => {
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 850, 1920, 200)] }];
    expect(layoutCaptions(scene, voice('Pick one'), ev)[0]!.side).toBe('top');
  });

  it('target in the bottom zone but clear of the caption box stays at the bottom', () => {
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(100, 820, 50, 30)] }];
    const [cue] = layoutCaptions(scene, voice('Click save'), ev);
    expect(cue!.side).toBe('bottom');
    expect(cue!.reason).toBeUndefined();
  });

  it('no free side → least real overlap + reason', () => {
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 0, 1920, 1080)] }];
    const [cue] = layoutCaptions(scene, voice('Everything is covered'), ev);
    expect(cue!.reason).toMatch(/both sides overlap the target/);
    // top fully covered, bottom only grazed -> bottom, with a reason
    const [c0] = layoutCaptions(scene, voice('Everything is covered'), []);
    const grazed: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 0, 1920, 300), box(c0!.box.x, c0!.box.y, 20, 20)] }];
    const [c1] = layoutCaptions(scene, voice('Everything is covered'), grazed);
    expect(c1!.side).toBe('bottom');
    expect(c1!.reason).toBeDefined();
    // bottom fully covered, top grazed -> top, with a reason
    const top = { x: c0!.box.x, y: 72, w: 20, h: 20 };
    const ev2: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 700, 1920, 380), top] }];
    const [c2] = layoutCaptions(scene, voice('Everything is covered'), ev2);
    expect(c2!.side).toBe('top');
    expect(c2!.reason).toBe('both sides overlap the target; top overlaps less');
  });

  it('counts overlapping boxes once (union, not sum)', () => {
    const [c0] = layoutCaptions(scene, voice('Hi there'), []);
    const { x, w, h } = c0!.box;
    const topFull = { x, y: 72, w, h };
    const half = { x, y: c0!.box.y, w: w * 0.6, h };
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [topFull, half, { ...half }] }];
    const [cue] = layoutCaptions(scene, voice('Hi there'), ev);
    expect(cue!.side).toBe('bottom'); // union 0.6 < 1.0 (a sum would say 1.2 and pick top)
    expect(cue!.reason).toBeDefined();
  });

  it('srt round-trips times', () => {
    const cues = layoutCaptions(scene, voice(LONG, 3661.25, 3665.5), []);
    const back = parseSrt(toSrt(cues));
    expect(toSrt(cues)).toContain('01:01:01,250 -->');
    expect(back).toHaveLength(cues.length);
    back.forEach((b, i) => {
      expect(b.start).toBeCloseTo(cues[i]!.start, 3);
      expect(b.end).toBeCloseTo(cues[i]!.end, 3);
      expect(b.lines).toEqual(cues[i]!.lines);
    });
  });

  it('builds events on the output clock, mapping phone boxes into the frame', () => {
    const take: Take = {
      file: 't.webm',
      flashAt: 1,
      viewport: 'phone',
      events: [
        { index: 0, kind: 'click', at: 1, target: box(10, 20), panels: [], loading: false },
        { index: 1, kind: 'click', at: 2, cursorTo: box(0, 0), panels: [box(5, 5)], loading: false },
      ],
    };
    const sched: ScheduledStep[] = [0, 1].map((i) => ({ index: i, step: { do: 'click' } as never, cueTime: null, startAt: 1 + i * 2 }));
    const ev = eventsForCaptions(take, sched, { sceneEnd: 9 });
    expect(ev[0]!.end).toBe(ev[1]!.start);
    expect(ev[1]!.end).toBe(9);
    expect(ev[0]!.boxes[0]).toEqual(phoneToFrame(box(10, 20)));
    expect(ev[1]!.boxes).toHaveLength(2);
    const f = phoneToFrame({ x: 0, y: 0, w: 390, h: 844 });
    expect(f.h).toBeCloseTo(864, 6);
    expect(f.x + f.w / 2).toBeCloseTo(960, 6);
    expect(f.y + f.h / 2).toBeCloseTo(540, 6);
  });

  it('keeps clear of the ring the recorder drew as well as the element', () => {
    const take: Take = {
      file: 't.webm',
      flashAt: 0,
      events: [{ index: 0, kind: 'ring', at: 1, target: box(100, 100), ringBox: box(90, 90, 220, 80), panels: [], loading: false }],
    };
    const sched: ScheduledStep[] = [{ index: 0, step: { do: 'ring' } as never, cueTime: null, startAt: 1 }];
    expect(eventsForCaptions(take, sched, { sceneEnd: 5 })[0]!.boxes).toEqual([box(100, 100), box(90, 90, 220, 80)]);
  });

  it('sorts take events by output time before computing windows', () => {
    const take: Take = {
      file: 't.webm',
      flashAt: 1,
      events: [
        { index: 1, kind: 'click', at: 2, target: box(300, 300), panels: [], loading: false },
        { index: 0, kind: 'click', at: 1, target: box(10, 10), panels: [], loading: false },
      ],
    };
    const sched: ScheduledStep[] = [0, 1].map((i) => ({ index: i, step: { do: 'click' } as never, cueTime: null, startAt: 1 + i * 2 }));
    const ev = eventsForCaptions(take, sched, { sceneEnd: 9 });
    expect(ev.map((e) => e.boxes[0]!.x)).toEqual([10, 300]);
    expect(ev[0]!.end).toBe(ev[1]!.start);
    expect(ev[0]!.end).toBeGreaterThan(ev[0]!.start);
    expect(ev[1]!.end).toBe(9);
  });
});
