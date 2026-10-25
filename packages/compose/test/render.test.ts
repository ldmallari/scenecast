import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, ensureToolchain, type Brand } from '@scenecast/core';
import { clampZoom, ringAlpha, sceneOpacity, srcTimeAt, timeline, zoomBoxAt, type ComposePlan } from '../src/plan.js';
import { ffprobePath, renderVideo } from '../src/render.js';

const run = promisify(execFile);
const FRAME = { x: 0, y: 0, w: 1920, h: 1080 };
const PAD = DEFAULTS.audit.zoomPadPx;
const ASPECT = 1920 / 1080;

const brand: Brand = { primary: '#1F3A5F', accent: '#F2A93B', font: 'Inter', introTitle: 'Getting started', introSubtitle: 'A short tour' };

const contains = (outer: { x: number; y: number; w: number; h: number }, inner: typeof outer) =>
  inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-6 && inner.y + inner.h <= outer.y + outer.h + 1e-6;

describe('clampZoom', () => {
  it('zoom box clamped and padded', () => {
    const target = { x: 800, y: 400, w: 400, h: 200 };
    const z = clampZoom(target, FRAME, PAD);
    expect(contains(z, { x: target.x - PAD, y: target.y - PAD, w: target.w + 2 * PAD, h: target.h + 2 * PAD })).toBe(true);
    expect(z.w / z.h).toBeCloseTo(ASPECT, 6);
    expect(contains(FRAME, z)).toBe(true);
    // centred on the target
    expect(z.x + z.w / 2).toBeCloseTo(1000, 6);
    expect(z.y + z.h / 2).toBeCloseTo(500, 6);
  });

  it('keeps a box at the frame edge inside the frame', () => {
    const target = { x: 1860, y: 1020, w: 60, h: 60 };
    const z = clampZoom(target, FRAME, PAD);
    expect(contains(FRAME, z)).toBe(true);
    expect(z.x + z.w).toBeCloseTo(1920, 6);
    expect(z.y + z.h).toBeCloseTo(1080, 6);
    expect(contains(z, target)).toBe(true);
    expect(z.w / z.h).toBeCloseTo(ASPECT, 6);
  });

  it('never zooms beyond 2.5x on a tiny box', () => {
    const z = clampZoom({ x: 950, y: 530, w: 20, h: 20 }, FRAME, PAD);
    expect(z.w).toBeCloseTo(1920 / 2.5, 6);
    expect(z.h).toBeCloseTo(1080 / 2.5, 6);
    expect(z.x + z.w / 2).toBeCloseTo(960, 6);
    expect(z.y + z.h / 2).toBeCloseTo(540, 6);
  });

  it('falls back to the full frame when the padded box is larger than the frame', () => {
    expect(clampZoom({ x: 10, y: 10, w: 1900, h: 900 }, FRAME, PAD)).toEqual(FRAME);
  });

  it('widens to include a nav the target overlaps', () => {
    const nav = { x: 0, y: 0, w: 240, h: 1080 };
    const z = clampZoom({ x: 200, y: 300, w: 300, h: 80 }, FRAME, PAD, nav);
    expect(z.x).toBe(0);
    expect(z.w / z.h).toBeCloseTo(ASPECT, 6);
    expect(contains(FRAME, z)).toBe(true);
  });

  it('shifts to exclude a nav the padding only just cuts', () => {
    const nav = { x: 0, y: 0, w: 240, h: 1080 };
    const target = { x: 260, y: 300, w: 1000, h: 300 };
    const z = clampZoom(target, FRAME, PAD, nav); // padded left edge 236: shift 4 px beats widening 236 px
    expect(z.x).toBeCloseTo(240, 6);
    expect(contains(z, target)).toBe(true);
    expect(z.w / z.h).toBeCloseTo(ASPECT, 6);
  });

  it('widens to the nav when that is the smaller change', () => {
    const nav = { x: 0, y: 0, w: 240, h: 1080 };
    const target = { x: 250, y: 300, w: 300, h: 80 };
    const z = clampZoom(target, FRAME, PAD, nav); // 2.5x cap puts the left edge at 16: widen 16 px beats shift 224 px
    expect(z.x).toBe(0);
    expect(contains(z, target)).toBe(true);
    expect(z.w / z.h).toBeCloseTo(ASPECT, 6);
  });

  it('never leaves the nav partly in', () => {
    const nav = { x: 0, y: 0, w: 300, h: 1080 };
    for (let x = 0; x < 700; x += 20) {
      const z = clampZoom({ x, y: 500, w: 120, h: 40 }, FRAME, PAD, nav);
      const cutsNav = z.x > nav.x && z.x < nav.x + nav.w;
      expect(cutsNav, `target x=${x} → zoom x=${z.x}`).toBe(false);
      expect(contains(FRAME, z)).toBe(true);
    }
  });

  it('ignores a navBox that is not a left nav', () => {
    const target = { x: 200, y: 300, w: 300, h: 80 };
    expect(clampZoom(target, FRAME, PAD, { x: 40, y: 0, w: 240, h: 1080 })).toEqual(clampZoom(target, FRAME, PAD));
  });
});

describe('timeline', () => {
  const plan: ComposePlan = {
    brand,
    dissolveSec: 0.35,
    scenes: [
      { kind: 'card', duration: 2, card: { variant: 'intro' } },
      { kind: 'app', duration: 5, segments: [] },
      { kind: 'card', duration: 3, card: { variant: 'outro', title: 'Thanks' } },
    ],
  };

  it('dissolve lengthens overlap not total', () => {
    const tl = timeline(plan);
    expect(tl.total).toBeCloseTo(10, 9);
    expect(tl.scenes.map((s) => s.start)).toEqual([0, 2, 7]);
    expect(tl.scenes.map((s) => s.fadeIn)).toEqual([0, 0.35, 0.35]);
    // scene 2 fades in over the last 0.35 s of scene 1; scene 1 stays fully visible beneath it
    const [a, b] = tl.scenes as [typeof tl.scenes[number], typeof tl.scenes[number]];
    expect(sceneOpacity(b, 2 - 0.35 - 0.01)).toBe(0);
    expect(sceneOpacity(b, 2 - 0.175)).toBeCloseTo(0.5, 6);
    expect(sceneOpacity(a, 2 - 0.175)).toBe(1);
    expect(sceneOpacity(b, 2)).toBe(1);
    expect(sceneOpacity(a, 2)).toBe(0);
  });

  it('defaults dissolveSec from DEFAULTS', () => {
    const { dissolveSec: _d, ...rest } = plan;
    expect(timeline(rest).scenes[1]!.fadeIn).toBe(DEFAULTS.video.dissolveSec);
  });

  it('rejects a scene shorter than the dissolve into the next', () => {
    expect(() => timeline({ ...plan, scenes: [{ kind: 'card', duration: 0.2, card: { variant: 'intro' } }, plan.scenes[1]!] })).toThrow(/dissolve/);
  });
});

describe('scene helpers', () => {
  it('maps output time to source time across clips and holds', () => {
    const segs = [
      { src: 'a', srcIn: 1, srcOut: 2, outStart: 0 },
      { src: 'a', srcIn: 2, srcOut: 2, outStart: 1, hold: 0.5 },
      { src: 'a', srcIn: 4, srcOut: 5, outStart: 1.5 },
    ];
    expect(srcTimeAt(segs, 0.5)).toEqual({ src: 'a', time: 1.5 });
    expect(srcTimeAt(segs, 1.2)).toEqual({ src: 'a', time: 2 });
    expect(srcTimeAt(segs, 2)).toEqual({ src: 'a', time: 4.5 });
    expect(srcTimeAt(segs, 9)).toEqual({ src: 'a', time: 5 });
  });

  it('eases the zoom over zoomEaseSec, holds, then eases back', () => {
    const box = { x: 480, y: 270, w: 960, h: 540 };
    const zooms = [{ start: 1, end: 3, box }];
    expect(zoomBoxAt(zooms, 0.5, FRAME, 0.7)).toEqual(FRAME);
    const mid = zoomBoxAt(zooms, 1.35, FRAME, 0.7);
    expect(mid.w).toBeCloseTo((1920 + 960) / 2, 6);
    expect(zoomBoxAt(zooms, 1.7, FRAME, 0.7)).toEqual(box);
    expect(zoomBoxAt(zooms, 2.9, FRAME, 0.7)).toEqual(box);
    expect(zoomBoxAt(zooms, 3.7, FRAME, 0.7)).toEqual(FRAME);
  });

  it('fades rings in and out over 150 ms at 90%', () => {
    const ring = { start: 1, end: 2, box: FRAME };
    expect(ringAlpha(ring, 0.99)).toBe(0);
    expect(ringAlpha(ring, 1.075)).toBeCloseTo(0.45, 6);
    expect(ringAlpha(ring, 1.5)).toBeCloseTo(0.9, 6);
    expect(ringAlpha(ring, 1.925)).toBeCloseTo(0.45, 6);
    expect(ringAlpha(ring, 2.01)).toBe(0);
  });
});

describe('renderVideo', () => {
  let dir: string;
  let ffmpeg: string;
  let fixture: string;

  beforeAll(async () => {
    ffmpeg = (await ensureToolchain({ offline: true }).catch(() => ensureToolchain())).ffmpeg;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-compose-'));
    fixture = path.join(dir, 'take.webm');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=25:d=3',
      '-c:v', 'libvpx', '-b:v', '2M', fixture]);
  }, 120_000);

  const pixel = async (file: string, t: number, x: number, y: number) => {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', `crop=8:8:${x}:${y},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    return [...stdout.subarray(0, 3)];
  };

  it('renders 3 s fixture to 1080p30 h264', async () => {
    const plan: ComposePlan = {
      brand,
      dissolveSec: 0.35,
      scenes: [
        { kind: 'card', duration: 1, card: { variant: 'intro' } },
        {
          kind: 'app',
          duration: 2,
          segments: [
            { src: fixture, srcIn: 0.5, srcOut: 1.7, outStart: 0 },
            { src: fixture, srcIn: 1.7, srcOut: 1.7, outStart: 1.2, hold: 0.8 },
          ],
          cues: [{ start: 0.2, end: 1.9, lines: ['Open the settings page'], side: 'bottom', box: { x: 660, y: 916, w: 600, h: 93 } }],
          zooms: [{ start: 0.6, end: 2, box: { x: 700, y: 300, w: 300, h: 150 } }],
          rings: [{ start: 0.2, end: 1.5, box: { x: 700, y: 300, w: 300, h: 150 } }],
        },
      ],
    };
    const out = path.join(dir, 'out.mp4');
    const t0 = Date.now();
    const res = await renderVideo(plan, out);
    const secs = (Date.now() - t0) / 1000;
    console.info(`scenecast: render of the 3 s fixture took ${secs.toFixed(2)} s`);
    expect(res.file).toBe(out);
    expect(res.duration).toBeCloseTo(3, 6);

    const { stdout } = await run(ffprobePath(), ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,nb_frames:format=duration', '-of', 'json', out]);
    const info = JSON.parse(stdout) as { streams: Record<string, string | number>[]; format: { duration: string } };
    expect(info.streams).toHaveLength(1); // silent: no audio track
    const v = info.streams[0]!;
    expect(v).toMatchObject({ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', pix_fmt: 'yuv420p' });
    expect(Number(v.nb_frames)).toBe(90);
    expect(Number(info.format.duration)).toBeCloseTo(3, 1);

    // intro card in the brand colour at 0.3 s (top-left corner, clear of the text)
    const card = await pixel(out, 0.3, 40, 40);
    expect(card.map((c, i) => Math.abs(c - [0x1f, 0x3a, 0x5f][i]!)).every((d) => d <= 6)).toBe(true);
    // caption box (dark, translucent) at 2.0 s near its left padding
    const cap = await pixel(out, 2.0, 668, 924);
    expect(Math.max(...cap)).toBeLessThan(90);
  }, 180_000);
});
