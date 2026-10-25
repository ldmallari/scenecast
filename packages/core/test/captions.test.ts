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
    const [cue] = layoutCaptions(scene, voice('Everything you need is right here in one place, ready'), []);
    expect(cue!.lines).toHaveLength(2);
    for (const l of cue!.lines) expect(l.split(' ').length).toBeGreaterThanOrEqual(2);
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

  it('no free side → least overlap + reason', () => {
    const big = box(0, 0, 1920, 1080);
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [big] }];
    const [cue] = layoutCaptions(scene, voice('Everything is covered'), ev);
    expect(cue!.reason).toMatch(/both sides overlap the target/);
    const ev2: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 0, 1920, 400), box(0, 700, 1920, 380)] }];
    const [c2] = layoutCaptions(scene, voice('Everything is covered'), ev2);
    expect(c2!.side).toBe('top');
    expect(c2!.reason).toBe('both sides overlap the target; top overlaps less');
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
});
