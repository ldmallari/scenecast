import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, buildAuditInput, type AuditOpts, type AuditPlan, type HeardWord } from '../src/audit.js';
import { clampZoom, phoneFrame, phoneToFrame } from '../src/frame.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import type { Box, Take } from '../src/record/record.js';
import { VideoSpecSchema } from '../src/scene/schema.js';
import type { ScheduledStep } from '../src/schedule.js';
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
  scene.steps.map((step, index) => ({ index, step, cueTime: cueTimes[index]!, startAt: startAts[index]! }));

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
    { index: 1, kind: 'ring', at: 2.0, target: box(5, 95, 110, 50), panels: [], loading: false },
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

  it('an action inside a cut has no time on the video', () => {
    const take = { ...deskTake, events: [{ ...deskTake.events[0]!, at: 2.5 }, deskTake.events[1]!] }; // source 2.6: cut
    const o = opts();
    o.scenes[0] = { ...o.scenes[0]!, take };
    expect(build(o).scenes[0]!.moments[0]!.actionTime).toBeNull();
  });

  it('phone scene boxes are mapped into the frame exactly once', () => {
    const m = build().scenes[1]!;
    const tap = m.moments[0]!;
    expect(tap.target).toEqual(phoneToFrame(MENU));
    const pf = phoneFrame();
    expect(tap.target.x).toBeGreaterThanOrEqual(pf.x);
    expect(tap.target.y).toBeGreaterThanOrEqual(pf.y);
    expect(m.events[0]!.boxes.map((b) => b.kind)).toEqual(['target', 'cursor', 'panel']);
    expect(m.events[0]!.boxes[2]!.box).toEqual(phoneToFrame(box(0, 400, 390, 444)));
    expect(m.zooms[0]!.box).toEqual(clampZoom(phoneToFrame(MENU), FRAME, 24, undefined, pf.x));
    // The recorder's ring is the padded target it drew; it peaks after the 150 ms fade (+0.1 s settle).
    const ring = m.moments[1]!.ring;
    expect(ring.by).toBe('recorder');
    expect(ring.box).toEqual(phoneToFrame(box(5, 95, 110, 50)));
    expect(m.moments[1]!.actionTime).toBeCloseTo(9 + 1.9, 9);
    expect(ring.peak).toBeCloseTo(9 + 1.9 + 0.25, 9);
  });

  it('carries the music licence and rejects a viewport mismatch', () => {
    expect(build().music).toEqual({ licence: 'CC0, Example' });
    const o = opts();
    o.scenes[1] = { ...o.scenes[1]!, take: { ...mobTake, viewport: undefined } };
    expect(() => build(o)).toThrow(/phone viewport/);
  });

  it('a zoom step with no zoom in the plan is a problem', () => {
    const p: AuditPlan = { ...plan, scenes: plan.scenes.map((s, i) => (i === 1 ? { ...s, zooms: [] } : s)) };
    expect(build(opts({ plan: p })).scenes[0]!.moments[1]!.problems).toHaveLength(1);
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

  it('returns a non-zero exit code when a check fails', async () => {
    const res = await audit(opts({ video, workDir: dir, words: HEARD, loudness: { lufs: -17.2, truePeak: -2 } }));
    expect(res.pass).toBe(false);
    expect(res.exitCode).not.toBe(0);
    expect(res.counts.fail).toBe(1);
  }, 120_000);
});
