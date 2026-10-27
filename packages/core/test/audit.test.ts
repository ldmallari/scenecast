import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, buildAuditInput, type AuditOpts, type AuditPlan, type HeardWord } from '../src/audit.js';
import { clampZoom, phoneFrame, phoneScreen, phoneToFrame } from '../src/frame.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import { ringPeakSec, type Box, type Take } from '../src/record/record.js';
import { VideoSpecSchema, type Scene } from '../src/scene/schema.js';
import { travelSecFor, type ScheduledStep } from '../src/schedule.js';
import { ensureToolchain, findUv } from '../src/toolchain.js';

const FRAME = { x: 0, y: 0, w: 1920, h: 1080 };
const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

const spec = VideoSpecSchema.parse({
  id: 'demo',
  title: 'Demo',
  output: 'out/demo.mp4',
  brand: { primary: '#123456', accent: '#abcdef', font: 'Inter', introTitle: 'Demo', music: { file: 'm.wav', licence: 'CC0, Example' } },
  app: { baseUrl: 'http://localhost:3000' },
  scenes: [
    {
      id: 'desk', kind: 'app', narration: 'Open the report, then look at the totals.',
      steps: [{ do: 'click', sel: '#open', cue: 'Open' }, { do: 'zoom', sel: '#totals', cue: 'totals' }],
    },
    {
      id: 'mob', kind: 'app', viewport: 'phone', narration: 'Tap the menu.',
      steps: [{ do: 'click', sel: '.menu', cue: 'Tap' }, { do: 'ring', sel: '.menu', cue: 'menu', pad: 5 }],
    },
  ],
});
const [desk, mob] = spec.scenes as [(typeof spec.scenes)[0], (typeof spec.scenes)[0]];

const sched = (scene: typeof desk, cueTimes: number[], startAts: number[]): ScheduledStep[] =>
  scene.steps.map((step, index) => ({ index, step, cueTime: cueTimes[index]!, startAt: startAts[index]!, travel: travelSecFor(step) }));

const TOTALS = box(1200, 600, 300, 80);
const MENU = box(10, 100, 100, 40); // phone take px
const deskTake: Take = {
  file: 'desk.webm',
  flashAt: 0.1,
  events: [
    { index: 0, kind: 'click', at: 1.0, target: box(100, 200, 120, 40), cursorTo: box(157, 218, 28, 28), panels: [], loading: false },
    { index: 1, kind: 'zoom', at: 3.4, target: TOTALS, panels: [], loading: false },
  ],
};
const mobTake: Take = {
  file: 'mob.webm',
  flashAt: 0,
  viewport: 'phone',
  events: [
    { index: 0, kind: 'click', at: 1.0, target: MENU, cursorTo: box(57, 118, 28, 28), panels: [box(0, 400, 390, 444)], loading: false },
    // The ring drawn at the cue (padded by 5) and the element's own box re-measured at the ring's peak.
    { index: 1, kind: 'ring', at: 2.0, target: MENU, ringBox: box(5, 95, 110, 50), panels: [], loading: false },
  ],
};

// Intro card 3 s, then desk (6 s; source 2.2-3.0 s cut out), then the phone scene (4 s).
const plan: AuditPlan = {
  brand: spec.brand,
  scenes: [
    { kind: 'card', duration: 3 },
    {
      kind: 'app', duration: 6,
      segments: [
        { src: 'desk.webm', srcIn: 0.2, srcOut: 2.2, outStart: 0 },
        { src: 'desk.webm', srcIn: 3.0, srcOut: 7.0, outStart: 2.0 },
      ],
      zooms: [{ start: 2.5, end: 4.5, box: TOTALS }],
    },
    {
      kind: 'app', duration: 4, phone: true,
      segments: [{ src: 'mob.webm', srcIn: 0.1, srcOut: 4.1, outStart: 0 }],
      zooms: [{ start: 1.0, end: 1.6, box: MENU }],
    },
  ],
};

const opts = (over: Partial<AuditOpts> = {}): AuditOpts => ({
  video: 'final.mp4',
  plan,
  scenes: [
    { scene: desk, planIndex: 1, scheduled: sched(desk, [1.42, 2.5], [0.9, 2.5]), take: deskTake, flashTime: 0.1 },
    { scene: mob, planIndex: 2, scheduled: sched(mob, [1.42, 1.9], [0.9, 1.9]), take: mobTake, flashTime: 0.0 },
  ],
  loudness: { lufs: -16, truePeak: -2 },
  workDir: '/tmp/x',
  ...over,
});

type Input = { scenes: { id: string; start: number; end: number; zooms: { box: Box }[]; events: { time: number | null; boxes: { kind: string; box: Box }[] }[]; moments: Record<string, any>[] }[]; music: unknown };
const build = (o = opts()) => buildAuditInput(o, { outDir: '/tmp/x/audit', ffmpeg: null, whisperModel: null }) as unknown as Input;

describe('buildAuditInput', () => {
  it('a title scene on a card gets the narration and phrase windows, with no moments', () => {
    const title = { id: 'ch', kind: 'title', narration: 'Next up. The phone view.', steps: [], seconds: 2, page: '/p', viewport: 'desktop' } as unknown as Scene;
    const voice = { duration: 2.4, phrases: [{ text: 'Next up.', start: 0, end: 0.8, onset: 0.04 }, { text: 'The phone view.', start: 1.0, end: 2.4 }], words: [] };
    const cue = { start: 0, end: 0.8, lines: ['Next up.'], side: 'bottom' as const, box: box(800, 900, 300, 100) };
    const p: AuditPlan = { ...plan, scenes: [{ kind: 'card', duration: 3, cues: [cue] }, ...plan.scenes.slice(1)] };
    const s = build(opts({ plan: p, scenes: [{ scene: title, planIndex: 0, voice }] })).scenes[0] as unknown as Record<string, unknown>;
    expect(s.moments).toEqual([]);
    expect(s.events).toEqual([]);
    expect(s.narration).toBe('Next up. The phone view.');
    expect(s.phrases).toEqual([
      { start: 0, end: 0.8, words: 2, text: 'Next up.', onset: 0.04 }, // the clean clip's first-word onset
      { start: 1, end: 2.4, words: 3, text: 'The phone view.' },
    ]);
    expect((s.cues as unknown[]).length).toBe(1);
  });

  it('declared navs reach the audit in frame px and the zoom region clears them', () => {
    const top = { edge: 'top' as const, box: box(0, 0, 1920, 64) };
    const p: AuditPlan = { ...plan, scenes: plan.scenes.map((s, i) => (i === 1 ? { ...s, navs: [top] } : s)) };
    const d = build(opts({ plan: p })).scenes[0] as unknown as { navs: unknown; zooms: { box: Box }[] };
    expect(d.navs).toEqual([top]);
    expect(d.zooms[0]!.box).toEqual(clampZoom(TOTALS, FRAME, 24, undefined, 0, [top]));
  });


  it('maps take events through the retimed segments onto the video clock', () => {
    const [d] = build().scenes;
    expect(d!.start).toBe(3);
    expect(d!.end).toBe(9);
    // flash 0.1 + at 1.0 = source 1.1 s, in the first clip (source 0.2 = scene 0): scene 0.9, video 3.9.
    expect(d!.moments[0]!.actionTime).toBeCloseTo(3.9, 9);
    expect(d!.moments[0]!.planWordTime).toBeCloseTo(4.42, 9);
    expect(d!.moments[0]!.label).toBe('#open');
  });

  it('a zoom step takes its time and shown region from the plan, clamped like the composer', () => {
    const z = build().scenes[0]!.moments[1]!;
    expect(z.actionTime).toBeCloseTo(5.5, 9);
    expect(z.zoom.hold).toBeCloseTo(6.2, 9);
    expect(z.zoom.box).toEqual(clampZoom(TOTALS, FRAME, 24));
    expect(z.problems).toEqual([]);
  });

  it("a zoom's padded target is clipped to the frame: a pad that runs off the frame edge is not part of the target", () => {
    // v1.2: a button at the top edge with pad 250 logged 1497,-240 651x544, which no zoom inside the frame contains.
    const padded = box(1497, -240, 651, 544);
    const take = { ...deskTake, events: [deskTake.events[0]!, { ...deskTake.events[1]!, target: padded }] };
    const z = build(opts({ scenes: [{ ...opts().scenes[0]!, take }] })).scenes[0]!.moments[1]!;
    expect(z.target).toEqual(box(1497, 0, 423, 304));
    // The initial zoom too.
    const zt = build(opts({ scenes: [{ ...opts().scenes[0]!, take: { ...deskTake, initialZoom: padded } }] })).scenes[0] as unknown as Record<string, any>;
    expect(zt.initialZoom.target).toEqual(box(1497, 0, 423, 304));
  });

  it('an action inside a cut has no time on the video', () => {
    const take = { ...deskTake, events: [{ ...deskTake.events[0]!, at: 2.5 }, deskTake.events[1]!] }; // source 2.6: cut
    const o = opts();
    o.scenes[0] = { ...o.scenes[0]!, take };
    expect(build(o).scenes[0]!.moments[0]!.actionTime).toBeNull();
  });

  it('phone scene boxes are mapped into the frame exactly once', () => {
    const m = build().scenes[1]!;
    const tap = m.moments[0]!;
    expect(tap.target).toEqual(phoneToFrame(MENU, 'center'));
    const pf = phoneFrame('center');
    expect(tap.target.x).toBeGreaterThanOrEqual(pf.x);
    expect(tap.target.y).toBeGreaterThanOrEqual(pf.y);
    expect(m.events[0]!.boxes.map((b) => b.kind)).toEqual(['target', 'cursor', 'panel']);
    expect(m.events[0]!.boxes[2]!.box).toEqual(phoneToFrame(box(0, 400, 390, 444), 'center'));
    expect(m.zooms[0]!.box).toEqual(clampZoom(phoneToFrame(MENU, 'center'), FRAME, 24, undefined, pf.x));
    // The recorder's ring is the padded box it drew; the target is the element at the peak (150 ms fade + 0.1 s).
    const ring = m.moments[1]!.ring;
    expect(ring.by).toBe('recorder');
    expect(ring.box).toEqual(phoneToFrame(box(5, 95, 110, 50), 'center'));
    expect(m.moments[1]!.target).toEqual(phoneToFrame(MENU, 'center'));
    expect(m.moments[1]!.actionTime).toBeCloseTo(9 + 1.9, 9);
    expect(ring.peak).toBeCloseTo(9 + 1.9 + 0.25, 9);
  });

  it('carries the music licence and rejects a viewport mismatch', () => {
    expect(build().music).toEqual({ licence: 'CC0, Example' });
    const o = opts();
    o.scenes[1] = { ...o.scenes[1]!, take: { ...mobTake, viewport: undefined } };
    expect(() => build(o)).toThrow(/phone viewport/);
  });

  it('a ring step without a logged ring box is a problem', () => {
    const o = opts();
    const events = mobTake.events.map((e) => (e.kind === 'ring' ? { ...e, ringBox: undefined } : e));
    o.scenes[1] = { ...o.scenes[1]!, take: { ...mobTake, events } };
    const ringMoment = build(o).scenes[1]!.moments[1]!;
    expect(ringMoment.ring).toBeNull();
    expect(ringMoment.problems).toEqual(['no ring box was logged for this ring step']);
  });

  it('a ringSel ring is checked as the recorder\'s ring, against the ringed element at its peak', () => {
    const TOTALS_AT_PEAK = box(1200, 600, 300, 80);
    const withRingSel = (ev: Partial<Take['events'][number]>) => {
      const o = opts();
      const scheduled = o.scenes[0]!.scheduled!.map((s, i) =>
        i === 0 ? { ...s, step: { ...s.step, ringSel: '#totals', ringMs: 600, pad: 8 } } : s,
      );
      const events = deskTake.events.map((e, i) => (i === 0 ? { ...e, ...ev } : e));
      // A composer ring near the action must not be picked up: the recorder owns ringSel rings.
      const p: AuditPlan = { ...plan, scenes: plan.scenes.map((s, i) => (i === 1 ? { ...s, rings: [{ start: 0.9, end: 2.4, box: box(0, 0, 10, 10) }] } : s)) };
      o.scenes[0] = { ...o.scenes[0]!, scheduled, take: { ...deskTake, events } };
      return build({ ...o, plan: p }).scenes[0]!.moments[0]!;
    };
    const m = withRingSel({ ringBox: box(1192, 592, 316, 96), ringTarget: TOTALS_AT_PEAK });
    expect(m.ring).toEqual({ box: box(1192, 592, 316, 96), peak: expect.closeTo(3.9 + ringPeakSec(600), 9), by: 'recorder' });
    expect(m.target).toEqual(TOTALS_AT_PEAK); // not the click's own target
    expect(m.problems).toEqual([]);
    // A hover's ring drawn once the hover settled (`ringAt`, 0.2 s after the action) peaks that much later.
    const late = withRingSel({ ringBox: box(1192, 592, 316, 96), ringTarget: TOTALS_AT_PEAK, ringAt: deskTake.events[0]!.at + 0.2 });
    expect(late.ring!.peak).toBeCloseTo(3.9 + 0.2 + ringPeakSec(600), 9);
    expect(late.actionTime).toBeCloseTo(m.actionTime!, 9);
    const gone = withRingSel({ ringBox: box(1192, 592, 316, 96) }); // the element was gone by the peak
    expect(gone.target).toBeNull();
    const none = withRingSel({});
    expect(none.ring).toBeNull();
    expect(none.problems).toEqual(['no ring box was logged for this ringSel ring']);
  });

  it('loading is judged on the sample taken just before the action', () => {
    const withLoading = (loadingBefore: boolean | undefined, loading: boolean) => {
      const o = opts();
      const events = deskTake.events.map((e, i) => (i === 0 ? { ...e, loading, loadingBefore } : e));
      o.scenes[0] = { ...o.scenes[0]!, take: { ...deskTake, events } };
      return build(o).scenes[0]!.moments[0]!.loading;
    };
    expect(withLoading(false, true)).toBe(false); // the click started a spinner: its result, not a half-loaded page
    expect(withLoading(true, false)).toBe(true); // a spinner was up when the cue came
    expect(withLoading(undefined, true)).toBe(true); // older takes without the sample
  });

  it('the allow-list comes from the scene file; the option overrides it', () => {
    const spec2 = { audit: { allowList: ['Mira Solano'] } };
    const read = (o: AuditOpts) => (buildAuditInput(o, { outDir: '/x', ffmpeg: null, whisperModel: null }) as { allowList: string[] }).allowList;
    expect(read(opts({ spec: spec2 }))).toEqual(['Mira Solano']);
    expect(read(opts({ spec: spec2, allowList: ['Sam'] }))).toEqual(['Sam']);
    expect(read(opts())).toEqual([]);
  });

  it('passes the cue word index the scheduler counted', () => {
    const [d] = build().scenes;
    expect(d!.moments.map((m) => m.cueWord)).toEqual([0, 7]);
  });

  it('the zoom-hold frame is never after the zoom ends', () => {
    const p: AuditPlan = { ...plan, scenes: plan.scenes.map((s, i) => (i === 1 ? { ...s, zooms: [{ start: 2.5, end: 2.9, box: TOTALS }] } : s)) };
    expect(build(opts({ plan: p })).scenes[0]!.moments[1]!.zoom.hold).toBeCloseTo(5.9, 9);
  });

  it('a zoom step with no zoom in the plan is a problem', () => {
    const p: AuditPlan = { ...plan, scenes: plan.scenes.map((s, i) => (i === 1 ? { ...s, zooms: [] } : s)) };
    expect(build(opts({ plan: p })).scenes[0]!.moments[1]!.problems).toHaveLength(1);
  });
});

describe('buildAuditInput: unzoom steps and scenes that start zoomed', () => {
  const zspec = VideoSpecSchema.parse({
    ...spec,
    scenes: [{
      id: 'zz', kind: 'app', narration: 'Here are the totals, and now back out.', zoom: { sel: '#head' },
      steps: [{ do: 'zoom', sel: '#totals', cue: 'totals' }, { do: 'unzoom', cue: 'back' }],
    }],
  });
  const zz = zspec.scenes[0]!;
  const HEAD = box(100, 80, 400, 60);
  // The unzoom is logged at 4.05 s after the flash (scene 3.95): the plan zoom it closes ends at 4.0.
  const take = (over: Partial<Take> = {}): Take => ({
    file: 'zz.webm',
    flashAt: 0,
    initialZoom: HEAD,
    events: [
      { index: 0, kind: 'zoom', at: 2.1, target: TOTALS, panels: [], loading: false },
      { index: 1, kind: 'unzoom', at: 4.05, panels: [], loading: false },
    ],
    ...over,
  });
  const zplan = (zooms: AuditPlan['scenes'][number]['zooms'], rings?: AuditPlan['scenes'][number]['rings']): AuditPlan => ({
    brand: spec.brand,
    scenes: [
      { kind: 'card', duration: 3 },
      { kind: 'app', duration: 6, segments: [{ src: 'zz.webm', srcIn: 0.1, srcOut: 6.1, outStart: 0 }], zooms, ...(rings ? { rings } : {}) },
    ],
  });
  const PLAN_ZOOMS = [{ start: 0, end: 2.0, box: HEAD, instant: true }, { start: 2.0, end: 4.0, box: TOTALS }];
  const zbuild = (p: AuditPlan, t: Take = take()) =>
    build(opts({ plan: p, scenes: [{ scene: zz, planIndex: 1, scheduled: sched(zz, [2.0, 4.0], [2.0, 4.0]), take: t, flashTime: 0.1 }] }))
      .scenes[0] as unknown as Record<string, any>;

  it('an unzoom step takes its time from the zoom end in the plan', () => {
    const s = zbuild(zplan(PLAN_ZOOMS, [{ start: 3.9, end: 4.5, box: box(0, 0, 10, 10) }]));
    const m = s.moments[1]!;
    expect(m.kind).toBe('unzoom');
    expect(m.actionTime).toBe(3 + 4.0);
    expect(m.unzoom).toEqual({ end: 7.0 });
    expect(m.problems).toEqual([]);
    // No target, ring or zoom: the row checks sync and captions only.
    expect(m.target).toBeNull();
    expect(m.zoom).toBeNull();
    expect(m.ring).toBeNull();
    // Other moments say they are no unzoom.
    expect(s.moments[0]!.unzoom).toBeNull();
  });

  it('an unzoom with no zoom ending near it is a problem', () => {
    const m = zbuild(zplan([{ start: 0, end: 2.0, box: HEAD, instant: true }, { start: 2.0, end: 3.2, box: TOTALS }])).moments[1]!;
    expect(m.unzoom).toBeNull();
    expect(m.problems).toEqual(['no zoom ends within 0.5 s of the unzoom']);
  });

  it('a scene that starts zoomed gets its initial zoom: the take box as target, the clamped plan zoom as box', () => {
    const s = zbuild(zplan(PLAN_ZOOMS));
    expect(s.initialZoom).toEqual({ box: clampZoom(HEAD, FRAME, 24), target: HEAD });
    // The instant zoom reaches the Python audit marked as such; a zoom step never takes it as its own.
    expect(s.zooms[0]).toMatchObject({ start: 3, end: 5, instant: true });
    expect(s.zooms[1]!.instant).toBeUndefined();
    expect(s.moments[0]!.zoom.start).toBe(5);
    // No instant zoom in the plan for a take that starts zoomed: the scene row has no box to check.
    expect(zbuild(zplan([PLAN_ZOOMS[1]!])).initialZoom).toEqual({ box: null, target: HEAD });
    // A scene that does not start zoomed has none.
    expect(zbuild(zplan([PLAN_ZOOMS[1]!]), take({ initialZoom: undefined })).initialZoom).toBeNull();
    expect(build().scenes[0] as unknown as Record<string, unknown>).toMatchObject({ initialZoom: null });
  });

  it('phone boxes are mapped with the plan alignment', () => {
    // The plan places the phone left (30% of the width): every phone box, zoom and the screen follow it.
    const left = build(opts({ plan: { ...plan, phoneAlign: 'left' } })).scenes[1]! as unknown as Record<string, any>;
    const tap = left.moments[0]!;
    expect(tap.target).toEqual(phoneToFrame(MENU, 'left'));
    expect(tap.target.x).toBeCloseTo(phoneToFrame(MENU, 'center').x - 384, 6);
    expect(left.events[0]!.boxes[0]!.box).toEqual(phoneToFrame(MENU, 'left'));
    expect(left.screen).toEqual(phoneScreen('left'));
    expect(left.zooms[0]!.box).toEqual(clampZoom(phoneToFrame(MENU, 'left'), FRAME, 24, undefined, phoneFrame('left').x));
    // Without phoneAlign the plan is the v1 centred phone.
    expect((build().scenes[1]! as unknown as Record<string, any>).screen).toEqual(phoneScreen('center'));
  });

  it('phone scenes map the initial zoom into the frame', () => {
    const s = build(opts({
      plan: { ...zplan([{ start: 0, end: 2.0, box: HEAD, instant: true }]), scenes: [{ kind: 'card', duration: 3 }, { ...zplan([{ start: 0, end: 2.0, box: HEAD, instant: true }]).scenes[1]!, phone: true }] },
      scenes: [{ scene: zz, planIndex: 1, scheduled: sched(zz, [2.0, 4.0], [2.0, 4.0]), take: take({ viewport: 'phone' }), flashTime: 0.1 }],
    })).scenes[0] as unknown as Record<string, any>;
    // HEAD (100..500 px across) runs past the 390 px phone screen: only its on-screen part is the target.
    const onScreen = phoneToFrame(box(100, 80, 290, 60), 'center');
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(s.initialZoom.target[k]).toBeCloseTo(onScreen[k], 6);
    expect(s.initialZoom.box).toEqual(clampZoom(phoneToFrame(HEAD, 'center'), FRAME, 24, undefined, phoneFrame('center').x));
  });

  it('the rules carry the full-frame share', () => {
    expect((buildAuditInput(opts(), { outDir: '/x', ffmpeg: null, whisperModel: null }) as { rules: Record<string, unknown> }).rules.fullFrameShare).toBe(0.9);
  });
});

const word = (w: string, start: number): HeardWord => ({ w: ` ${w}`, start, end: start + 0.25 });
const HEARD = [
  word('Open', 3.9), word('the', 4.2), word('report,', 4.4), word('then', 4.8), word('look', 5.0), word('at', 5.2), word('the', 5.3), word('totals.', 5.45),
  word('Tap', 9.9), word('the', 10.2), word('menu.', 10.85),
];

describe.skipIf(!findUv())('audit', () => {
  let dir: string;
  let video: string;
  beforeAll(async () => {
    const { ffmpeg } = await ensureToolchain({ offline: true }).catch(() => ensureToolchain());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-audit-'));
    video = path.join(dir, 'final.mp4');
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=30:d=13', '-pix_fmt', 'yuv420p', video,
    ]);
  }, 120_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the audit folder and passes when every moment is right', async () => {
    const res = await audit(opts({ video, workDir: dir, words: HEARD }));
    expect(res).toMatchObject({ pass: true, exitCode: 0, dir: path.join(dir, 'audit') });
    expect(res.counts.fail).toBe(0);
    for (const f of ['audit-input.json', 'audit.json', 'audit-table.md', 'contact-sheet.png']) expect(fs.existsSync(path.join(res.dir, f))).toBe(true);
    expect(fs.readdirSync(path.join(res.dir, 'frames')).sort()).toEqual(['desk-totals.png', 'mob-menu.png']);
    expect(fs.readFileSync(path.join(res.dir, 'audit-table.md'), 'utf8')).toContain('CC0, Example');
  }, 120_000);

  it('fails a ring when the element moved or grew between the cue and the peak', async () => {
    const o = opts({ video, workDir: dir, words: HEARD });
    // At the peak the menu had grown to the right, out of the ring drawn at the cue.
    const events = mobTake.events.map((e) => (e.kind === 'ring' ? { ...e, target: box(10, 100, 160, 40) } : e));
    o.scenes[1] = { ...o.scenes[1]!, take: { ...mobTake, events } };
    const res = await audit(o);
    expect(res.exitCode).not.toBe(0);
    const json = JSON.parse(fs.readFileSync(path.join(res.dir, 'audit.json'), 'utf8')) as {
      moments: { scene: string; cue: string; checks: { name: string; verdict: string }[] }[];
    };
    const row = json.moments.find((r) => r.scene === 'mob' && r.cue === 'menu')!;
    expect(row.checks.find((c) => c.name === 'target')!.verdict).toBe('FAIL');
  }, 120_000);

  it('returns a non-zero exit code when a check fails', async () => {
    const res = await audit(opts({ video, workDir: dir, words: HEARD, loudness: { lufs: -17.2, truePeak: -2 } }));
    expect(res.pass).toBe(false);
    expect(res.exitCode).not.toBe(0);
    expect(res.counts.fail).toBe(1);
  }, 120_000);
});
