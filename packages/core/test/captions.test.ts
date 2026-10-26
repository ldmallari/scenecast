import { describe, expect, it } from 'vitest';
import {
  DESKTOP_CAPTIONS,
  eventsForCaptions,
  fillsScreen,
  FUNCTION_WORDS,
  layoutCaptions,
  parseSrt,
  phoneCaptions,
  splitCaption,
  toSrt,
  zoomedCaptionEvents,
  type CaptionEvent,
} from '../src/captions.js';
import { phoneFrame, phoneScreen, phoneToFrame } from '../src/frame.js';
import type { Take } from '../src/record/record.js';
import { travelSecFor, type ScheduledStep } from '../src/schedule.js';
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

  // Boxes over all four corner positions of a short caption, so only bottom and top are in play.
  const corners = (h = 160) => [box(0, 0, 700, h), box(1220, 0, 700, h), box(0, 1080 - h, 700, h), box(1220, 1080 - h, 700, h)];

  it('no free side → least real overlap + reason', () => {
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 0, 1920, 1080)] }];
    const [cue] = layoutCaptions(scene, voice('Everything is covered'), ev);
    expect(cue!.reason).toMatch(/^no free position; /);
    // top and the corners fully covered, bottom only grazed -> bottom, with a reason
    const [c0] = layoutCaptions(scene, voice('Everything is covered'), []);
    const grazed: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 0, 1920, 300), ...corners(), box(c0!.box.x, c0!.box.y, 20, 20)] }];
    const [c1] = layoutCaptions(scene, voice('Everything is covered'), grazed);
    expect(c1!.side).toBe('bottom');
    expect(c1!.reason).toBeDefined();
    // bottom and the corners fully covered, top grazed -> top, with a reason
    const top = { x: c0!.box.x, y: 72, w: 20, h: 20 };
    const ev2: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(0, 700, 1920, 380), ...corners(), top] }];
    const [c2] = layoutCaptions(scene, voice('Everything is covered'), ev2);
    expect(c2!.side).toBe('top');
    expect(c2!.reason).toBe('no free position; top overlaps least');
  });

  it('counts overlapping boxes once (union, not sum)', () => {
    const [c0] = layoutCaptions(scene, voice('Hi there'), []);
    const { x, w, h } = c0!.box;
    const topFull = { x, y: 72, w, h };
    const half = { x, y: c0!.box.y, w: w * 0.6, h };
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [topFull, half, { ...half }, ...corners()] }];
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
    const sched: ScheduledStep[] = [0, 1].map((i) => ({ index: i, step: { do: 'click' } as never, cueTime: null, startAt: 1 + i * 2, travel: travelSecFor({ do: 'click' }) }));
    const ev = eventsForCaptions(take, sched, { sceneEnd: 9, align: 'center' });
    expect(ev[0]!.end).toBe(ev[1]!.start);
    expect(ev[1]!.end).toBe(9);
    expect(ev[0]!.boxes[0]).toEqual(phoneToFrame(box(10, 20), 'center'));
    expect(ev[1]!.boxes).toHaveLength(2);
    const f = phoneToFrame({ x: 0, y: 0, w: 390, h: 844 }, 'center');
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
    const sched: ScheduledStep[] = [{ index: 0, step: { do: 'ring' } as never, cueTime: null, startAt: 1, travel: travelSecFor({ do: 'ring' }) }];
    expect(eventsForCaptions(take, sched, { sceneEnd: 5, align: 'center' })[0]!.boxes).toEqual([box(100, 100), box(90, 90, 220, 80)]);
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
    const sched: ScheduledStep[] = [0, 1].map((i) => ({ index: i, step: { do: 'click' } as never, cueTime: null, startAt: 1 + i * 2, travel: travelSecFor({ do: 'click' }) }));
    const ev = eventsForCaptions(take, sched, { sceneEnd: 9, align: 'center' });
    expect(ev.map((e) => e.boxes[0]!.x)).toEqual([10, 300]);
    expect(ev[0]!.end).toBe(ev[1]!.start);
    expect(ev[0]!.end).toBeGreaterThan(ev[0]!.start);
    expect(ev[1]!.end).toBe(9);
  });
});

describe('captions during a zoom (on-screen geometry)', () => {
  const zoomTake = (target: { x: number; y: number; w: number; h: number }): Take => ({
    file: 'z.webm',
    flashAt: 0,
    events: [{ index: 0, kind: 'zoom', at: 1, target, panels: [], loading: false }],
  });
  const times = new Map([[0, 1]]);

  it('a held zoom that brings the target into the bottom moves the caption to the top', () => {
    // Unzoomed, the target (y 1010-1040) sits under a bottom caption (y 915-1008), not in it.
    const target = box(900, 1010, 120, 30);
    const v = voice('Look at this.', 0.2, 4.5);
    const plain = layoutCaptions(scene, v, zoomedCaptionEvents(zoomTake(target), times, [], 5, 'center'));
    expect(plain.map((c) => c.side)).toEqual(['bottom']);
    // The zoom clamps at the frame bottom (region y 648-1080, 2.5x): on screen the target is y 905-980.
    const zooms = [{ start: 1, end: 4, box: target }];
    const events = zoomedCaptionEvents(zoomTake(target), times, zooms, 5, 'center');
    const held = events.find((e) => e.start >= 1.7 - 1e-6 && e.end <= 4 + 1e-6)!;
    expect(held.boxes[0]!.y).toBeCloseTo((1010 - 648) * 2.5, 6);
    const [cue] = layoutCaptions(scene, v, events);
    expect(cue!.side).toBe('top');
    expect(cue!.reason).toBeUndefined();
  });

  it('no free side during a zoom keeps the least-overlap side with a reason', () => {
    // A wide, tall target zoomed 1.09x covers both caption bands, corners included, on screen (y 160-920).
    const target = box(100, 200, 1720, 700);
    const v = voice('Look at this.', 0.2, 4.5);
    const [cue] = layoutCaptions(scene, v, zoomedCaptionEvents(zoomTake(target), times, [{ start: 1, end: 4, box: target }], 5, 'center'));
    expect(cue!.reason).toMatch(/^no free position; /);
  });

  it('while the zoom eases in, both the unzoomed and the zoomed boxes count', () => {
    const target = box(900, 1010, 120, 30);
    const events = zoomedCaptionEvents(zoomTake(target), times, [{ start: 1, end: 4, box: target }], 5, 'center');
    const easing = events.find((e) => e.start >= 1 - 1e-6 && e.end <= 1.7 + 1e-6)!;
    expect(easing.boxes).toHaveLength(2);
    expect(easing.boxes[0]).toEqual(target);
  });
});

describe('targets that fill the screen', () => {
  const FULL = { x: 0, y: 0, w: 1920, h: 1080 };
  const take = (target: { x: number; y: number; w: number; h: number }, phone = false): Take => ({
    file: 'f.webm',
    flashAt: 0,
    ...(phone ? { viewport: 'phone' as const } : {}),
    events: [{ index: 0, kind: 'click', at: 0, target, panels: [], loading: false }],
  });
  const times = new Map([[0, 0]]);

  it('fillsScreen is true from 90% of the screen area', () => {
    expect(fillsScreen({ x: 0, y: 0, w: 1920, h: 972 }, FULL)).toBe(true); // exactly 90%
    expect(fillsScreen({ x: 0, y: 0, w: 1920, h: 971 }, FULL)).toBe(false);
    expect(fillsScreen({ x: -500, y: -500, w: 5000, h: 5000 }, FULL)).toBe(true); // only the part on the screen counts
    expect(fillsScreen(FULL, { x: 0, y: 0, w: 0, h: 0 })).toBe(false);
  });

  it('a box covering 90% of the screen is not protected', () => {
    const voice = { duration: 9, phrases: [{ text: 'Here is the whole page.', start: 0, end: 9 }], words: [] };
    const events = zoomedCaptionEvents(take({ x: 0, y: 0, w: 1920, h: 1000 }), times, [], 9, 'center');
    const [cue] = layoutCaptions({ id: 's' }, voice, events);
    expect(cue).toMatchObject({ side: 'bottom' });
    expect(cue!.reason).toBeUndefined();
  });

  it('on a phone scene the screen is the phone screen', () => {
    // The whole 390x844 take fills the phone screen: not protected. Half of it is.
    const whole = zoomedCaptionEvents(take({ x: 0, y: 0, w: 390, h: 844 }, true), times, [], 5, 'center');
    expect(whole[0]!.boxes).toEqual([]);
    const half = zoomedCaptionEvents(take({ x: 0, y: 0, w: 390, h: 422 }, true), times, [], 5, 'center');
    expect(half[0]!.boxes).toEqual([phoneToFrame({ x: 0, y: 0, w: 390, h: 422 }, 'center')]);
    const pf = phoneFrame('center');
    expect(fillsScreen(phoneToFrame({ x: 0, y: 0, w: 390, h: 844 }, 'center'), { x: pf.x, y: pf.y, w: pf.w, h: pf.h })).toBe(true);
  });

  it('a box that fills the zoomed view is dropped only while the zoom shows it that way', () => {
    // Unzoomed the 1700x956 target covers 78% of the frame; zoomed on it (region 1785x1004), 91%.
    const target = { x: 100, y: 60, w: 1700, h: 956 };
    const events = zoomedCaptionEvents(take(target), times, [{ start: 1, end: 4, box: target }], 5, 'center');
    const before = events.find((e) => e.end <= 1 + 1e-6)!;
    expect(before.boxes).toEqual([target]);
    const held = events.find((e) => e.start >= 1.7 - 1e-6 && e.end <= 4 + 1e-6)!;
    expect(held.boxes).toEqual([]);
    const easing = events.find((e) => e.start >= 1 - 1e-6 && e.end <= 1.7 + 1e-6)!;
    expect(easing.boxes).toEqual([target]); // the unzoomed end of the ease still counts
  });

  it('an instant zoom is held from its start: no unzoomed view while it would ease in', () => {
    const target = box(900, 1010, 120, 30);
    const events = zoomedCaptionEvents(take(target), new Map([[0, 0.2]]), [{ start: 0, end: 4, box: target, instant: true }], 5, 'center');
    const first = events.find((e) => e.start >= 0.2 - 1e-6 && e.end <= 0.7 + 1e-6)!;
    expect(first.boxes).toHaveLength(1);
    expect(first.boxes[0]).not.toEqual(target);
  });
});

describe('clause-first captions', () => {
  const lastWord = (line: string) => line.split(' ').at(-1)!.toLowerCase().replace(/[^a-z]/g, '');

  it('exports the desktop layout from the global constraints', () => {
    expect(DESKTOP_CAPTIONS).toEqual({ charsPerLine: 42, maxLines: 2, sides: ['bottom', 'top', 'bottom-left', 'bottom-right', 'top-left', 'top-right'] });
  });

  it('breaks at clause punctuation before balancing', () => {
    const cues = splitCaption('When the request is approved, a green note appears beside it and the owner gets an email straight away.');
    expect(cues[0]!.join(' ')).toBe('When the request is approved,');
  });

  it('never ends a cue or a line on a function word', () => {
    const text = 'Open the account menu at the top of the page and choose your profile to change the name on your account.';
    const cues = splitCaption(text);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.flat().join(' ')).toBe(text);
    for (const cue of cues) for (const line of cue) expect(FUNCTION_WORDS.has(lastWord(line))).toBe(false);
  });

  it('a phrase whose only breaks end on function words still splits', () => {
    const text = 'the the the the the the the the the the the the the the the the the the the the the the the end';
    const cues = splitCaption(text);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.flat().join(' ')).toBe(text);
    for (const cue of cues) {
      expect(cue.length).toBeLessThanOrEqual(2);
      for (const line of cue) expect(line.length).toBeLessThanOrEqual(42);
    }
  });

  it('a long phrase with no punctuation splits within the limits', () => {
    const text = 'open the settings page then scroll down past the team list and pick the billing tab then change the plan and save it';
    const cues = splitCaption(text);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.flat().join(' ')).toBe(text);
    for (const cue of cues) {
      expect(cue.length).toBeLessThanOrEqual(2);
      for (const line of cue) {
        expect(line.length).toBeLessThanOrEqual(42);
        expect(FUNCTION_WORDS.has(lastWord(line))).toBe(false);
      }
    }
  });

  it('uses the fewest cues that fit', () => {
    // 80 characters fit one two-line cue even though a clause break would make two cues.
    expect(splitCaption('Open the settings page, and you will see every option that controls your account')).toHaveLength(1);
  });

  it('follows the layout it is given', () => {
    const cues = splitCaption('Open the settings page and you will see every option that controls your account', { ...DESKTOP_CAPTIONS, charsPerLine: 30, maxLines: 3 });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.length).toBe(3);
    for (const line of cues[0]!) expect(line.length).toBeLessThanOrEqual(30);
  });
});

describe('corner positions', () => {
  const shortVoice = (text: string) => voice(text, 1, 3);
  const blocks = [{ x: 600, y: 900, w: 700, h: 120 }, { x: 600, y: 60, w: 700, h: 120 }];

  it('moves to a corner when bottom and top are both blocked', () => {
    const [cue] = layoutCaptions({ id: 's' }, shortVoice('Press Save.'), [{ start: 0, end: 9, boxes: blocks }]);
    expect(cue!.side).toBe('bottom-left');
    expect(cue!.box.x).toBe(72);
    expect(cue!.reason).toBeUndefined();
  });

  it('a corner box is the bottom box moved: same size, 72 px from its sides', () => {
    const [free] = layoutCaptions(scene, shortVoice('Press Save.'), []);
    const bl = box(0, 880, 500, 200);
    const tries: [string, { x: number; y: number; w: number; h: number }[]][] = [
      ['bottom-right', [...blocks, bl]],
      ['top-left', [...blocks, bl, box(1420, 880, 500, 200)]],
      ['top-right', [...blocks, bl, box(1420, 880, 500, 200), box(0, 0, 500, 200)]],
    ];
    for (const [side, boxes] of tries) {
      const [cue] = layoutCaptions(scene, shortVoice('Press Save.'), [{ start: 0, end: 9, boxes }]);
      expect(cue!.side).toBe(side);
      expect(cue!.reason).toBeUndefined();
      expect([cue!.box.w, cue!.box.h]).toEqual([free!.box.w, free!.box.h]);
      expect(cue!.box.x).toBeCloseTo(side.endsWith('right') ? 1920 - 72 - free!.box.w : 72, 9);
      expect(cue!.box.y).toBe(side.startsWith('top') ? 72 : free!.box.y);
    }
  });

  it('a cue keeps its lines wherever it lands', () => {
    const text = 'When the request is approved, a green note appears.';
    const [free] = layoutCaptions(scene, voice(text), []);
    const [cornered] = layoutCaptions(scene, voice(text), [{ start: 0, end: 9, boxes: [box(860, 0, 200, 1080)] }]);
    expect(free!.lines).toEqual(['When the request is approved,', 'a green note appears.']);
    expect(cornered!.side).toBe('bottom-left');
    expect(cornered!.lines).toEqual(free!.lines);
  });

  it('keeps the bottom when nothing is in the way', () => {
    // Regression guard (v1 also keeps the bottom here): with the top and all four corners blocked but
    // the centred bottom box clear, the longer side search must still stop at the first side, bottom.
    const [cue] = layoutCaptions(scene, shortVoice('Press Save.'), [
      { start: 0, end: 9, boxes: [box(0, 0, 1920, 200), box(0, 880, 500, 200), box(1420, 880, 500, 200)] },
    ]);
    expect(cue!.side).toBe('bottom');
    expect(cue!.reason).toBeUndefined();
    expect(cue!.box.x).toBeCloseTo((1920 - cue!.box.w) / 2, 9);
    expect(cue!.box.y).toBeCloseTo(1080 - 72 - cue!.box.h, 9);
  });
});

describe('phone captions beside the phone', () => {
  const shortVoice = (text: string) => voice(text, 1, 3);

  it("phoneFrame('left') centres the phone at 30% of the width", () => {
    const f = phoneFrame('left');
    expect(f.x + f.w / 2).toBeCloseTo(576, 1);
    expect(f.h).toBeCloseTo(864, 6);
    expect(f.y + f.h / 2).toBeCloseTo(540, 6);
    expect(phoneFrame('right').x + phoneFrame('right').w / 2).toBeCloseTo(1344, 1);
    expect(phoneFrame('center').x + phoneFrame('center').w / 2).toBeCloseTo(960, 1);
    const whole = phoneToFrame({ x: 0, y: 0, w: 390, h: 844 }, 'left');
    const screen = phoneScreen('left');
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(whole[k]).toBeCloseTo(screen[k], 9);
  });

  it('phone captions sit beside the phone', () => {
    const f = phoneFrame('left');
    const [cue] = layoutCaptions({ id: 's' }, shortVoice('Tap Requests to see everything you asked for.'), [], phoneCaptions('left'));
    expect(cue!.side).toBe('beside');
    expect(cue!.box.x).toBeGreaterThanOrEqual(f.x + f.w + 120);
    expect(cue!.box.x + cue!.box.w).toBeLessThanOrEqual(1920 - 120);
    // Against the column's edge facing the phone, centred on the phone vertically, in lines of at most 30 characters.
    expect(cue!.box.x).toBeCloseTo(f.x + f.w + 120, 6);
    expect(cue!.box.y + cue!.box.h / 2).toBeCloseTo(540, 6);
    expect(Math.max(...cue!.lines.map((l) => l.length))).toBeLessThanOrEqual(30);
    expect(cue!.reason).toBeUndefined();
  });

  it('a right phone has its captions on the left, against the phone', () => {
    const f = phoneFrame('right');
    const [cue] = layoutCaptions({ id: 's' }, shortVoice('Tap Requests to see everything you asked for.'), [], phoneCaptions('right'));
    expect(cue!.side).toBe('beside');
    expect(cue!.box.x).toBeGreaterThanOrEqual(120);
    expect(cue!.box.x + cue!.box.w).toBeCloseTo(f.x - 120, 6);
  });

  it('phone layouts: 30 characters, 3 lines, beside then bottom then top; a centred phone uses the desktop layout', () => {
    const left = phoneCaptions('left');
    expect(left).toMatchObject({ charsPerLine: 30, maxLines: 3, sides: ['beside', 'bottom', 'top'] });
    const f = phoneScreen('left');
    expect(left.beside).toEqual({ x: f.x + f.w + 120, y: f.y, w: 1920 - 120 - (f.x + f.w + 120), h: f.h });
    expect(phoneCaptions('center')).toBe(DESKTOP_CAPTIONS);
    // Up to 3 lines of 30: a long phrase uses the column's height before it splits into more cues.
    const text = 'Every request you send lands here, with its status and the date it is due back.';
    const cues = layoutCaptions({ id: 's' }, voice(text), [], left);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(3);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(30);
    }
    expect(cues).toHaveLength(1);
    expect(cues[0]!.lines).toHaveLength(3);
    expect(cues.flatMap((c) => c.lines).join(' ')).toBe(text);
  });

  it('a covered column falls back to the bottom', () => {
    const left = phoneCaptions('left');
    const [free] = layoutCaptions({ id: 's' }, shortVoice('Tap Requests.'), [], left);
    const [cue] = layoutCaptions({ id: 's' }, shortVoice('Tap Requests.'), [{ start: 0, end: 9, boxes: [free!.box] }], left);
    expect(cue!.side).toBe('bottom');
    expect(cue!.reason).toBeUndefined();
  });

  it('a phone take maps its boxes with the alignment it is given', () => {
    const take: Take = { file: 't.webm', flashAt: 0, viewport: 'phone', events: [{ index: 0, kind: 'click', at: 1, target: box(10, 20), panels: [], loading: false }] };
    const [ev] = zoomedCaptionEvents(take, new Map([[0, 1]]), [], 5, 'left');
    expect(ev!.boxes[0]).toEqual(phoneToFrame(box(10, 20), 'left'));
    expect(ev!.boxes[0]!.x).toBeCloseTo(phoneToFrame(box(10, 20), 'center').x - 384, 6);
    // The whole phone screen fills the screen as shown, wherever the phone sits: it is not protected.
    const whole: Take = { ...take, events: [{ ...take.events[0]!, target: box(0, 0, 390, 844) }] };
    expect(zoomedCaptionEvents(whole, new Map([[0, 1]]), [], 5, 'left')[0]!.boxes).toEqual([]);
  });
});

describe('caption breaks: possessives, abbreviations and the fallback reason', () => {
  it("never ends a line on a possessive: \"Demo Co's\" stays with its noun", () => {
    const text = "Every invoice from Demo Co's own billing team shows up here, with the amount, the due date and the status.";
    const lines = splitCaption(text).flat();
    for (const l of lines) expect(l).not.toMatch(/(?:'s|s')$/);
    expect(lines.join(' ')).toBe(text);
    expect(lines.some((l) => l.includes("Co's own"))).toBe(true);
    // Plural possessives too.
    for (const l of splitCaption("Here you can open all of the other users' saved settings and the shared folders they own.").flat())
      expect(l).not.toMatch(/s'$/);
  });

  it('an abbreviation is not a clause break', () => {
    // Without the rule, "e.g." reads as a sentence end and the line breaks after it.
    const text = 'Add any extra details here, e.g. the cost centre or the project code for this order.';
    const lines = splitCaption(text).flat();
    for (const l of lines) expect(l).not.toMatch(/(?:e\.g\.|i\.e\.|etc\.)$/);
    expect(lines.join(' ')).toBe(text);
    for (const t of ['Pick a source for the report, i.e. a saved list or a team that you manage today.', 'Drop in the receipts, invoices, notes etc. and they are filed for you in the right place.'])
      for (const l of splitCaption(t).flat()) expect(l).not.toMatch(/(?:i\.e\.|etc\.)$/);
  });

  it('the fallback reason names the side, not "both sides"', () => {
    // Everything but the bottom-left corner fully covered, that corner grazed: it is chosen, with a side-neutral reason.
    const [c0] = layoutCaptions({ id: 's' }, voice('Everything is covered'), []);
    const { h } = c0!.box;
    const bl = { x: 72, y: 1080 - 72 - h };
    const ev: CaptionEvent[] = [{ start: 0, end: 10, boxes: [box(700, 0, 1220, 1080), box(0, 0, 700, 600), box(bl.x, bl.y, 10, 10)] }];
    const [cue] = layoutCaptions({ id: 's' }, voice('Everything is covered'), ev);
    expect(cue!.side).toBe('bottom-left');
    expect(cue!.reason).toBe('no free position; bottom-left overlaps least');
    // Every side equally covered: the first is kept.
    const [all] = layoutCaptions({ id: 's' }, voice('Everything is covered'), [{ start: 0, end: 10, boxes: [box(0, 0, 1920, 1080)] }]);
    expect(all!.reason).toBe('no free position; all equal, bottom kept');
  });
});
