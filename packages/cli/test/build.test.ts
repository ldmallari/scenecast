import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampZoom, DEFAULTS, parseSrt, phoneToFrame, type Box, type Scene, type SceneVoice, type ScheduledStep, type Take, type VideoSpec } from '@scenecast/core';
import { buildVoiceTrack, readWav, writeWav } from '../src/audio.js';
import { buildVideo, captionEvents, chaptersTxt, eventTimes, finalSrt, INTRO_SEC, OUTRO_SEC, onScreen, toFrames, type Recorded } from '../src/build.js';

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
    { index: 0, step: { do: 'click', sel: '#b', cue: 'button' }, cueTime: 1.5, startAt: 1.5 - 0.52 },
  ];
  const at = 1.5 + (opts.late ?? 0.4);
  const take: Take = {
    file: `/takes/${id}.webm`,
    flashAt: 0.5,
    ...(opts.phone ? { viewport: 'phone' as const } : {}),
    events: [{ index: 0, kind: 'click', at, target: { x: 100, y: 500, w: 200, h: 40 }, cursorTo: { x: 197, y: 518, w: 28, h: 28 }, panels: [], loading: false }],
  };
  if (opts.zoom) {
    steps.push({ index: 1, step: { do: 'zoom', sel: '#z', cue: 'now', ms: 1000 }, cueTime: 2.0, startAt: 2.0 });
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

  it('a title card lasts at least its seconds', () => {
    const title = { scene: { id: 'ch', kind: 'title', narration: 'Hi.', steps: [], seconds: 5, page: '/p' } as unknown as Scene, voice: voice(1, 'Hi.') };
    const v = buildVideo(spec, [title], { cards: false });
    expect(v.plan.scenes).toHaveLength(1);
    expect(v.plan.scenes[0]!.duration).toBe(5);
    expect(v.plan.scenes[0]!.card!.title).toBe('ch');
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

describe('captionEvents', () => {
  it('carries the boxes as they look on screen while a zoom is held', () => {
    const app = appInput('a', { zoom: true });
    const v = buildVideo(spec, [app], { cards: false });
    const times = eventTimes(app.recorded, app.scheduled, v.scenes[0]!.segments!);
    const zooms = v.plan.scenes[0]!.zooms!;
    const events = captionEvents(app.recorded.take, times, zooms, v.plan.scenes[0]!.duration);
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
    const [e] = captionEvents(app.recorded.take, times, [], v.plan.scenes[0]!.duration);
    expect(e!.boxes[0]).toEqual(phoneToFrame(app.recorded.take.events[0]!.target!));
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

describe('declared navs', () => {
  it('the plan carries the take navs, and caption zoom views clear them like the composer', () => {
    const app = appInput('a', { zoom: true });
    const top = { edge: 'top' as const, box: { x: 0, y: 0, w: 1920, h: 64 } };
    app.recorded.take.navs = [top];
    app.recorded.take.events[1]!.target = { x: 300, y: 150, w: 900, h: 50 };
    const v = buildVideo(spec, [app], { cards: false });
    expect(v.plan.scenes[0]!.navs).toEqual([top]);
    const times = eventTimes(app.recorded, app.scheduled, v.scenes[0]!.segments!);
    const events = captionEvents(app.recorded.take, times, v.plan.scenes[0]!.zooms!, v.plan.scenes[0]!.duration);
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
