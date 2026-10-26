import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampZoom, DEFAULTS, parseSrt, schedule, phoneScreen, phoneToFrame, travelSecFor, type Box, type Scene, type SceneVoice, type ScheduledStep, type Take, type VideoSpec } from '@scenecast/core';
import { buildVoiceTrack, readWav, writeWav } from '../src/audio.js';
import { appPlanScene, buildVideo, scheduleOptsFor, captionEvents, chaptersTxt, eventTimes, finalSrt, INTRO_SEC, OUTRO_SEC, onScreen, planZooms, toFrames, type Recorded } from '../src/build.js';

const brand = { primary: '#1F3A5F', accent: '#F5C518', font: 'Inter', introTitle: 'Intro' };
const spec = { id: 'v', title: 'The video', output: 'v', brand, app: { baseUrl: 'http://x' }, voice: DEFAULTS.voice, scenes: [] } as unknown as VideoSpec;
const FRAME: Box = { x: 0, y: 0, w: 1920, h: 1080 };

function voice(duration: number, text = 'Click the button now.'): SceneVoice {
  const words = text.split(' ').map((w, i) => ({ w, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }));
  return { duration, phrases: [{ text, start: 0.2, end: duration - 0.1 }], words };
}

/** One click on "button" (word 2 at 1.5 s): scheduled to arrive at 1.5 s, recorded 0.4 s late. */
function appInput(id: string, opts: { late?: number; zoom?: boolean; phone?: boolean } = {}) {
  const scene = { id, kind: 'app', title: `Title ${id}`, viewport: opts.phone ? 'phone' : 'desktop', narration: 'Click the button now.', steps: [] } as unknown as Scene;
  const steps: ScheduledStep[] = [
    { index: 0, step: { do: 'click', sel: '#b', cue: 'button' }, cueTime: 1.5, startAt: 1.5 - 0.52, travel: travelSecFor({ do: 'click' }) },
  ];
  const at = 1.5 + (opts.late ?? 0.4);
  const take: Take = {
    file: `/takes/${id}.webm`,
    flashAt: 0.5,
    ...(opts.phone ? { viewport: 'phone' as const } : {}),
    events: [{ index: 0, kind: 'click', at, target: { x: 100, y: 500, w: 200, h: 40 }, cursorTo: { x: 197, y: 518, w: 28, h: 28 }, panels: [], loading: false }],
  };
  if (opts.zoom) {
    steps.push({ index: 1, step: { do: 'zoom', sel: '#z', cue: 'now', ms: 1000 }, cueTime: 2.0, startAt: 2.0, travel: travelSecFor({ do: 'zoom' }) });
    take.events.push({ index: 1, kind: 'zoom', at: 2.0 + (opts.late ?? 0.4), target: { x: 860, y: 780, w: 200, h: 60 }, panels: [], loading: false });
  }
  const recorded: Recorded = { take, flashTime: 0.5, flashEnd: 0.6, srcDuration: 20 };
  return { scene, voice: voice(4), scheduled: steps, recorded };
}

describe('buildVideo', () => {
  it('lays out intro, app scene, title card and outro on the frame grid', () => {
    const title = { scene: { id: 'ch', kind: 'title', title: 'Chapter two', narration: 'Next.', steps: [], seconds: 2, page: '/p' } as unknown as Scene, voice: voice(3.01, 'Next.') };
    const app = appInput('a');
    const v = buildVideo(spec, [app, title], { cards: true });
    const appDur = toFrames(4 + DEFAULTS.video.breathSec);
    const titleDur = toFrames(3.01 + DEFAULTS.video.breathSec);
    expect(v.plan.scenes.map((s) => s.kind)).toEqual(['card', 'app', 'card', 'card']);
    expect(v.plan.scenes.map((s) => s.duration)).toEqual([INTRO_SEC, appDur, titleDur, OUTRO_SEC]);
    expect(v.plan.scenes[2]!.card).toEqual({ variant: 'chapter', title: 'Chapter two' });
    expect(v.plan.scenes[3]!.card).toEqual({ variant: 'outro', title: 'The video' });
    expect(v.scenes.map((s) => [s.scene.id, s.planIndex, s.start])).toEqual([['a', 1, INTRO_SEC], ['ch', 2, INTRO_SEC + appDur]]);
    expect(v.total).toBeCloseTo(INTRO_SEC + appDur + titleDur + OUTRO_SEC, 9);
    // retime's segments fill the scene exactly
    const segs = v.plan.scenes[1]!.segments!;
    const last = segs.at(-1)!;
    expect(last.outStart + (last.hold ?? last.srcOut - last.srcIn)).toBeCloseTo(appDur, 6);
  });

  it('a take shorter than its voice composes', () => {
    // 14.5: the container says 14.84 s but the frames stop well before (the last frame comes from the frames).
    for (const lastFrameSec of [14.8, 14.5]) {
      const app = appInput('a');
      const recorded: Recorded = { ...app.recorded, srcDuration: 14.84, lastFrameSec };
      const { plan, segments } = appPlanScene(app.scene, voice(14.6), app.scheduled, recorded, 'center');
      expect(segments.length).toBeGreaterThan(0);
      for (const g of segments) expect(g.srcOut).toBeLessThanOrEqual(lastFrameSec + 1e-9);
      // The last frame is held to the end of the scene.
      const last = segments.at(-1)!;
      expect(last.hold).toBeGreaterThan(0);
      expect(last.outStart + last.hold!).toBeCloseTo(plan.duration, 6);
    }
  });

  it('a title card lasts at least its seconds', () => {
    const title = { scene: { id: 'ch', kind: 'title', narration: 'Hi.', steps: [], seconds: 5, page: '/p' } as unknown as Scene, voice: voice(1, 'Hi.') };
    const v = buildVideo(spec, [title], { cards: false });
    expect(v.plan.scenes).toHaveLength(1);
    expect(v.plan.scenes[0]!.duration).toBe(5);
    expect(v.plan.scenes[0]!.card!.title).toBe('ch');
  });

  it('ring: true gets a composer ring; a ringSel ring is the recorder\'s, so the composer draws none', () => {
    const rings = (extra: Record<string, unknown>) => {
      const app = appInput('a');
      app.scheduled[0] = { ...app.scheduled[0]!, step: { ...app.scheduled[0]!.step, ...extra } };
      return buildVideo(spec, [app], { cards: false }).plan.scenes[0]!.rings;
    };
    expect(rings({ ring: true, pad: 4 })).toEqual([
      { start: expect.closeTo(1.5, 1), end: expect.any(Number), box: { x: 96, y: 496, w: 208, h: 48 } },
    ]);
    expect(rings({ ring: true, ringSel: '#other' })).toBeUndefined();
    // ringMs sets the composer ring's hold: 150 ms fade in, the hold, 150 ms fade out.
    const [held] = rings({ ring: true, ringMs: 2000 })!;
    expect(held!.end - held!.start).toBeCloseTo(2.3, 6);
    expect(rings({ ringSel: '#other' })).toBeUndefined();
  });

  it('a late action lands on its scheduled output time', () => {
    const app = appInput('a', { late: 0.4 });
    const v = buildVideo(spec, [app], { cards: false });
    const times = eventTimes(app.recorded, app.scheduled, v.scenes[0]!.segments!);
    expect(times.get(0)).toBeCloseTo(1.5, 1);
  });

  it('zoom steps become plan zooms held for ms after the ease', () => {
    const app = appInput('a', { zoom: true });
    const v = buildVideo(spec, [app], { cards: false });
    const z = v.plan.scenes[0]!.zooms!;
    expect(z).toHaveLength(1);
    expect(z[0]!.start).toBeCloseTo(2.0, 1);
    expect(z[0]!.end - z[0]!.start).toBeCloseTo(DEFAULTS.video.zoomEaseSec + 1, 6);
    expect(z[0]!.box).toEqual({ x: 860, y: 780, w: 200, h: 60 });
  });
});

describe('planZooms', () => {
  const B: Box = { x: 860, y: 780, w: 200, h: 60 };
  const B0: Box = { x: 400, y: 200, w: 300, h: 100 };
  const EASE = DEFAULTS.video.zoomEaseSec;
  type Act = { do: 'zoom' | 'unzoom'; at: number; ms?: number; box?: Box };
  /** A take of zoom/unzoom steps at the given output times (times map straight to `at`). */
  const zoomArgs = (acts: Act[], opts: { initial?: Box; duration?: number } = {}): Parameters<typeof planZooms> => {
    const scheduled: ScheduledStep[] = acts.map((a, index) => ({
      index,
      step: { do: a.do, ...(a.do === 'zoom' ? { sel: '#z' } : {}), cue: `w${index}`, ...(a.ms !== undefined ? { ms: a.ms } : {}) },
      cueTime: a.at,
      startAt: a.at,
      travel: 0,
    }));
    const take: Take = {
      file: 't.webm',
      flashAt: 0,
      ...(opts.initial ? { initialZoom: opts.initial } : {}),
      events: acts.map((a, index) => ({ index, kind: a.do, at: a.at, ...(a.do === 'zoom' ? { target: a.box ?? B } : {}), panels: [], loading: false })),
    };
    return [take, scheduled, new Map(acts.map((a, i) => [i, a.at])), opts.duration ?? 10];
  };
  const zoomThenUnzoom = (zoomAt: number, unzoomAt: number) => zoomArgs([{ do: 'zoom', at: zoomAt }, { do: 'unzoom', at: unzoomAt }]);
  const initialThenUnzoom = (unzoomAt: number) => zoomArgs([{ do: 'unzoom', at: unzoomAt }], { initial: B0 });
  const zoomAt = (at: number, opts: { duration?: number } = {}) => zoomArgs([{ do: 'zoom', at }], opts);

  it('an unzoom step ends the zoom on its cue', () => {
    expect(planZooms(...zoomThenUnzoom(1.0, 4.0))).toEqual([{ start: 1.0, end: 4.0, box: B }]);
  });

  it('a scene zoom starts zoomed and holds until the first unzoom', () => {
    expect(planZooms(...initialThenUnzoom(3.0))[0]).toEqual({ start: 0, end: 3.0, box: B0, instant: true });
  });

  it('a scene zoom with no unzoom holds until the first zoom step, or else the scene end', () => {
    expect(planZooms(...zoomArgs([], { initial: B0, duration: 6.0 }))).toEqual([{ start: 0, end: 6.0, box: B0, instant: true }]);
    expect(planZooms(...zoomArgs([{ do: 'zoom', at: 2.5 }], { initial: B0 }))).toEqual([
      { start: 0, end: 2.5, box: B0, instant: true },
      { start: 2.5, end: 2.5 + EASE + 2, box: B },
    ]);
  });

  it('a zoom still held at the scene end ends with the scene', () => {
    const zooms = planZooms(...zoomAt(5.5, { duration: 6.0 }));
    expect(zooms).toHaveLength(1);
    expect(zooms[0]!.end).toBe(6.0);
    // An unzoom cued past the scene end (in the breath) still ends the zoom with the scene.
    expect(planZooms(...zoomArgs([{ do: 'zoom', at: 4.0 }, { do: 'unzoom', at: 6.2 }], { duration: 6.0 }))).toEqual([{ start: 4.0, end: 6.0, box: B }]);
  });

  it('a zoom without an unzoom holds for ms after the ease, and never past the next zoom', () => {
    expect(planZooms(...zoomArgs([{ do: 'zoom', at: 1.0, ms: 500 }]))).toEqual([{ start: 1.0, end: 1.0 + EASE + 0.5, box: B }]);
    const B2: Box = { x: 100, y: 100, w: 300, h: 80 };
    // Zoom, zoom, unzoom: the unzoom closes the second zoom only; the first ends where the second starts.
    expect(planZooms(...zoomArgs([{ do: 'zoom', at: 1.0 }, { do: 'zoom', at: 2.0, box: B2 }, { do: 'unzoom', at: 5.0 }]))).toEqual([
      { start: 1.0, end: 2.0, box: B },
      { start: 2.0, end: 5.0, box: B2 },
    ]);
  });

  it('appPlanScene starts a scene zoomed on its initial zoom', () => {
    const app = appInput('a');
    app.recorded.take.initialZoom = B0;
    const z = buildVideo(spec, [app], { cards: false }).plan.scenes[0]!.zooms!;
    expect(z).toEqual([{ start: 0, end: toFrames(4 + DEFAULTS.video.breathSec), box: B0, instant: true }]);
  });
});

describe('captionEvents', () => {
  it('carries the boxes as they look on screen while a zoom is held', () => {
    const app = appInput('a', { zoom: true });
    const v = buildVideo(spec, [app], { cards: false });
    const times = eventTimes(app.recorded, app.scheduled, v.scenes[0]!.segments!);
    const zooms = v.plan.scenes[0]!.zooms!;
    const events = captionEvents(app.recorded.take, times, zooms, v.plan.scenes[0]!.duration, 'center');
    const z = zooms[0]!;
    const region = clampZoom(z.box, FRAME, DEFAULTS.audit.zoomPadPx);
    const held = events.find((e) => e.start >= z.start + DEFAULTS.video.zoomEaseSec - 1e-6 && e.end <= z.end + 1e-6)!;
    const target = app.recorded.take.events[1]!.target!;
    expect(held.boxes).toEqual([onScreen(target, region)]); // only the zoomed view while held
    const easing = events.find((e) => e.start >= z.start - 1e-6 && e.end <= z.start + DEFAULTS.video.zoomEaseSec + 1e-6)!;
    expect(easing.boxes).toEqual([target, onScreen(target, region)]); // both ends while it eases in
    const before = events.find((e) => e.end <= z.start + 1e-6)!;
    expect(before.boxes).toHaveLength(2); // the click's target and cursor, unzoomed
  });

  it('maps phone take boxes into the frame once', () => {
    const app = appInput('p', { phone: true });
    const v = buildVideo(spec, [app], { cards: false });
    expect(v.plan.scenes[0]!.phone).toBe(true);
    const times = eventTimes(app.recorded, app.scheduled, v.scenes[0]!.segments!);
    // The scene file sets no phone.align: the default (left) places the phone, and the plan says so.
    expect(v.plan.phoneAlign).toBe('left');
    const [e] = captionEvents(app.recorded.take, times, [], v.plan.scenes[0]!.duration, 'left');
    expect(e!.boxes[0]).toEqual(phoneToFrame(app.recorded.take.events[0]!.target!, 'left'));
  });

  it('phone scenes get captions beside the phone, placed by phone.align', () => {
    for (const align of ['left', 'right'] as const) {
      const v = buildVideo({ ...spec, phone: { align } }, [appInput('p', { phone: true })], { cards: false });
      expect(v.plan.phoneAlign).toBe(align);
      const cues = v.plan.scenes[0]!.cues!;
      expect(cues.length).toBeGreaterThan(0);
      for (const c of cues) {
        expect(c.side).toBe('beside');
        const screen = phoneScreen(align);
        if (align === 'left') expect(c.box.x).toBeGreaterThanOrEqual(screen.x + screen.w + 120 - 1e-6);
        else expect(c.box.x + c.box.w).toBeLessThanOrEqual(screen.x - 120 + 1e-6);
      }
    }
    // A centred phone keeps the desktop captions; desktop scenes never go beside.
    const centred = buildVideo({ ...spec, phone: { align: 'center' } }, [appInput('p', { phone: true }), appInput('d')], { cards: false });
    for (const sc of centred.plan.scenes) for (const c of sc.cues!) expect(c.side).not.toBe('beside');
  });
});

describe('scheduleOptsFor', () => {
  const cursor = { start: 'center' as const, park: 'right' as const, parkAfterSec: 2.5 };
  const steps = [{ cue: 'Open', do: 'click' as const, sel: '#a' }];
  const v: SceneVoice = { duration: 8, phrases: [{ text: 'Open it now.', start: 0, end: 1.5 }], words: [{ w: 'Open', start: 1, end: 1.3 }, { w: 'it', start: 1.3, end: 1.4 }, { w: 'now.', start: 1.4, end: 1.5 }] };
  const sceneOf = (viewport: 'phone' | 'desktop') => ({ id: 's', kind: 'app', viewport, narration: 'Open it now.', steps } as unknown as Scene);

  it('a phone scene never parks and taps with the touch lead', () => {
    const [s] = schedule(sceneOf('phone'), v, scheduleOptsFor(sceneOf('phone'), cursor, v.duration));
    expect(s!.park).toBeUndefined();
    expect(s!.travel).toBe(DEFAULTS.phone.touchLeadSec);
    expect(scheduleOptsFor(sceneOf('phone'), cursor, v.duration).park).toBeUndefined();
  });

  it('a desktop scene parks after a lone click (unless parking is off)', () => {
    const [s] = schedule(sceneOf('desktop'), v, scheduleOptsFor(sceneOf('desktop'), cursor, v.duration));
    expect(s!.park).toBeDefined();
    expect(s!.travel).toBeCloseTo(0.52, 9);
    const [off] = schedule(sceneOf('desktop'), v, scheduleOptsFor(sceneOf('desktop'), { ...cursor, park: 'off' }, v.duration));
    expect(off!.park).toBeUndefined();
  });
});

describe('outputs', () => {
  it('chapters start at 00:00:00 and then at each scene start', () => {
    const v = buildVideo(spec, [appInput('a'), appInput('b'), appInput('c')], { cards: true });
    const lines = chaptersTxt(v.scenes).trim().split('\n');
    expect(lines[0]).toBe('00:00:00 Title a');
    expect(lines[1]).toBe(`00:00:0${Math.floor(v.scenes[1]!.start)} Title b`);
    expect(lines).toHaveLength(3);
  });

  it('srt captions are on the final clock', () => {
    const v = buildVideo(spec, [appInput('a'), appInput('b')], { cards: true });
    const cues = parseSrt(finalSrt(v));
    const own = v.plan.scenes[v.scenes[1]!.planIndex]!.cues!;
    expect(cues).toHaveLength(2 * own.length);
    expect(cues[own.length]!.start).toBeCloseTo(v.scenes[1]!.start + own[0]!.start, 3);
  });
});

describe('title cards', () => {
  it('a narrated title card gets bottom captions, in the .srt at the card start', () => {
    const title = { scene: { id: 'ch', kind: 'title', title: 'Next up', narration: 'Next, the phone view.', steps: [], seconds: 2, page: '/p' } as unknown as Scene, voice: voice(2.5, 'Next, the phone view.') };
    const v = buildVideo(spec, [appInput('a'), title], { cards: true });
    const card = v.plan.scenes[v.scenes[1]!.planIndex]!;
    expect(card.kind).toBe('card');
    expect(card.cues!.map((c) => c.lines.join(' '))).toEqual(['Next, the phone view.']);
    expect(card.cues!.every((c) => c.side === 'bottom' && !c.reason)).toBe(true);
    const srt = parseSrt(finalSrt(v));
    const line = srt.find((c) => c.lines.join(' ') === 'Next, the phone view.')!;
    expect(line.start).toBeCloseTo(v.scenes[1]!.start + 0.2, 3); // the phrase starts 0.2 s into the card
  });
});

describe('cards', () => {
  it('intro and outro last cards.introSec and outroSec; 0 leaves the card out', () => {
    const v = buildVideo({ ...spec, cards: { introSec: 2, outroSec: 0, entrance: 'reveal' } }, [appInput('a')], { cards: true });
    expect(v.plan.scenes[0]).toMatchObject({ kind: 'card', duration: 2, card: { variant: 'intro' } });
    expect(v.plan.scenes.at(-1)!.kind).toBe('app');
    expect(v.plan.scenes).toHaveLength(2);
    expect(v.scenes[0]!.start).toBe(2);
    const noIntro = buildVideo({ ...spec, cards: { introSec: 0, outroSec: 4, entrance: 'reveal' } }, [appInput('a')], { cards: true });
    expect(noIntro.plan.scenes.map((s) => s.kind)).toEqual(['app', 'card']);
    expect(noIntro.plan.scenes[1]!.duration).toBe(4);
    expect(noIntro.scenes[0]!.start).toBe(0);
  });

  it('a spec without cards uses the defaults', () => {
    const v = buildVideo(spec, [appInput('a')], { cards: true });
    expect(v.plan.scenes.map((s) => s.duration)).toEqual([DEFAULTS.cards.introSec, expect.any(Number), DEFAULTS.cards.outroSec]);
    expect(INTRO_SEC).toBe(DEFAULTS.cards.introSec);
    expect(OUTRO_SEC).toBe(DEFAULTS.cards.outroSec);
    expect(v.plan.cards).toEqual({ entrance: DEFAULTS.cards.entrance });
  });

  it('the plan carries the entrance', () => {
    const v = buildVideo({ ...spec, cards: { introSec: 3, outroSec: 3, entrance: 'rise' } }, [appInput('a')], { cards: true });
    expect(v.plan.cards).toEqual({ entrance: 'rise' });
  });

  it('the outro carries outroTitle and the next line', () => {
    const cards = { introSec: 3, outroSec: 3, entrance: 'reveal' as const, outroTitle: 'Thanks for watching', outroNext: 'Next: approving requests' };
    const v = buildVideo({ ...spec, cards }, [appInput('a')], { cards: true });
    expect(v.plan.scenes.at(-1)!.card).toEqual({ variant: 'outro', title: 'Thanks for watching', next: 'Next: approving requests' });
    // Without outroTitle the outro shows the video title, and no next line.
    const plain = buildVideo({ ...spec, cards: { introSec: 3, outroSec: 3, entrance: 'reveal' } }, [appInput('a')], { cards: true });
    expect(plain.plan.scenes.at(-1)!.card).toEqual({ variant: 'outro', title: 'The video' });
  });

  it('a title scene with page shows the rendered image', () => {
    const title = { scene: { id: 'ch', kind: 'title', title: 'Chapter', narration: 'Hi.', steps: [], seconds: 2, page: '/w/p.html' } as unknown as Scene, voice: voice(1, 'Hi.'), cardImage: '/w/cards/p.png' };
    const v = buildVideo(spec, [title], { cards: false });
    expect(v.plan.scenes[0]!.card).toEqual({ variant: 'chapter', title: 'Chapter', image: '/w/cards/p.png' });
  });

  it('the intro and outro pages show their rendered images', () => {
    const v = buildVideo(spec, [appInput('a')], { cards: true, introImage: '/w/cards/intro.png', outroImage: '/w/cards/outro.png' });
    expect(v.plan.scenes[0]!.card).toEqual({ variant: 'intro', image: '/w/cards/intro.png' });
    expect(v.plan.scenes.at(-1)!.card).toEqual({ variant: 'outro', title: 'The video', image: '/w/cards/outro.png' });
  });
});

describe('declared navs', () => {
  it('the plan carries the take navs, and caption zoom views clear them like the composer', () => {
    const app = appInput('a', { zoom: true });
    const top = { edge: 'top' as const, box: { x: 0, y: 0, w: 1920, h: 64 } };
    app.recorded.take.navs = [top];
    app.recorded.take.events[1]!.target = { x: 300, y: 150, w: 900, h: 50 };
    const v = buildVideo(spec, [app], { cards: false });
    expect(v.plan.scenes[0]!.navs).toEqual([top]);
    const times = eventTimes(app.recorded, app.scheduled, v.scenes[0]!.segments!);
    const events = captionEvents(app.recorded.take, times, v.plan.scenes[0]!.zooms!, v.plan.scenes[0]!.duration, 'center');
    const region = clampZoom(app.recorded.take.events[1]!.target!, FRAME, DEFAULTS.audit.zoomPadPx, undefined, 0, [top]);
    expect(region.y).toBeCloseTo(64, 6);
    expect(events.some((e) => e.boxes.some((b) => JSON.stringify(b) === JSON.stringify(onScreen(app.recorded.take.events[1]!.target!, region))))).toBe(true);
  });
});

describe('voice track', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-vt-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('places each clip at its scene start, silence elsewhere', () => {
    const a = path.join(dir, 'a.wav');
    const b = path.join(dir, 'b.wav');
    writeWav(a, { sampleRate: 1000, samples: Int16Array.from([1, 2, 3]) });
    writeWav(b, { sampleRate: 1000, samples: Int16Array.from([7, 8]) });
    const out = path.join(dir, 'track.wav');
    buildVoiceTrack([{ file: a, start: 0.002 }, { file: b, start: 0.008 }], 0.01, out);
    expect(Array.from(readWav(out).samples)).toEqual([0, 0, 1, 2, 3, 0, 0, 0, 7, 8]);
  });

  it('refuses a clip that runs past the track', () => {
    const a = path.join(dir, 'a.wav');
    writeWav(a, { sampleRate: 1000, samples: Int16Array.from([1, 2, 3]) });
    expect(() => buildVoiceTrack([{ file: a, start: 0.009 }], 0.01, path.join(dir, 't.wav'))).toThrow(/runs past/);
  });
});
