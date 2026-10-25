import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, ensureToolchain, phoneFrame, phoneToFrame, type AuditPlan, type Brand } from '@scenecast/core';
import { chromium } from 'playwright';
import { clampZoom, inFramePixels, ringAlpha, sceneOpacity, srcTimeAt, timeline, zoomBoxAt, type ComposePlan } from '../src/plan.js';
import { ffprobePath, finish, preview, renderVideo, runRevideo } from '../src/render.js';

const run = promisify(execFile);

/** The `colr` box of the first video sample entry, parsed from the MP4's bytes (moov/trak/mdia/minf/stbl/stsd/avc1/colr). */
function readColr(file: string): { type: string; primaries?: number; transfer?: number; matrix?: number; fullRange?: boolean } | undefined {
  const b = fs.readFileSync(file);
  const boxes = (start: number, end: number) => {
    const out: { type: string; body: number; end: number }[] = [];
    for (let o = start; o + 8 <= end; ) {
      let size = b.readUInt32BE(o);
      const type = b.toString('latin1', o + 4, o + 8);
      let header = 8;
      if (size === 1) {
        size = Number(b.readBigUInt64BE(o + 8));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header) break;
      out.push({ type, body: o + header, end: o + size });
      o += size;
    }
    return out;
  };
  const find = (list: ReturnType<typeof boxes>, type: string) => list.find((x) => x.type === type);
  const moov = find(boxes(0, b.length), 'moov');
  if (!moov) return undefined;
  for (const trak of boxes(moov.body, moov.end).filter((x) => x.type === 'trak')) {
    let node: { body: number; end: number } | undefined = trak;
    for (const t of ['mdia', 'minf', 'stbl', 'stsd']) node = node && find(boxes(node.body, node.end), t);
    if (!node) continue;
    // stsd: version/flags (4) + entry count (4), then sample entries
    const entry = boxes(node.body + 8, node.end)[0];
    if (!entry || !['avc1', 'avc3'].includes(entry.type)) continue;
    // VisualSampleEntry: 78 bytes of fields before its child boxes
    const colr = find(boxes(entry.body + 78, entry.end), 'colr');
    if (!colr) return undefined;
    const type = b.toString('latin1', colr.body, colr.body + 4);
    if (type !== 'nclx') return { type };
    return {
      type,
      primaries: b.readUInt16BE(colr.body + 4),
      transfer: b.readUInt16BE(colr.body + 6),
      matrix: b.readUInt16BE(colr.body + 8),
      fullRange: (b.readUInt8(colr.body + 10) & 0x80) !== 0,
    };
  }
  return undefined;
}

const NCLX_601_ON_709 = { type: 'nclx', primaries: 1, transfer: 1, matrix: 6, fullRange: false };
const FRAME = { x: 0, y: 0, w: 1920, h: 1080 };
const PAD = DEFAULTS.audit.zoomPadPx;
const ASPECT = 1920 / 1080;

const brand: Brand = { primary: '#1F3A5F', accent: '#F2A93B', font: 'Inter', introTitle: 'Getting started', introSubtitle: 'A short tour' };

const contains = (outer: { x: number; y: number; w: number; h: number }, inner: typeof outer) =>
  inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-6 && inner.y + inner.h <= outer.y + outer.h + 1e-6;

describe('clampZoom', () => {
  it('a ComposePlan is what the audit reads', () => {
    const asAudit = (p: ComposePlan): AuditPlan => p; // compile-time: the audit reads the composer's plan as is
    expect(asAudit({ brand: {} as Brand, scenes: [] }).scenes).toEqual([]);
  });

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

describe('phone scenes', () => {
  it('maps ring, zoom and nav boxes from take px into frame px', () => {
    const ring = { x: 20, y: 700, w: 350, h: 60 };
    const zoom = { x: 40, y: 100, w: 200, h: 80 };
    const nav = { x: 0, y: 0, w: 60, h: 844 };
    const scene = inFramePixels({ kind: 'app', duration: 2, phone: true, segments: [],
      rings: [{ start: 0, end: 1, box: ring }], zooms: [{ start: 0, end: 1, box: zoom }], navBox: nav });
    const f = phoneFrame();
    expect(scene.rings![0]!.box).toEqual(phoneToFrame(ring));
    expect(scene.zooms![0]!.box).toEqual(phoneToFrame(zoom));
    expect(scene.navBox).toEqual(phoneToFrame(nav));
    expect(scene.rings![0]!.box.x).toBeCloseTo(f.x + 20 * f.scale, 6);
    expect(scene.rings![0]!.box.y).toBeCloseTo(f.y + 700 * f.scale, 6);
    expect(scene.rings![0]!.box.w).toBeCloseTo(350 * f.scale, 6);
  });

  it('leaves desktop boxes alone', () => {
    const scene = { kind: 'app' as const, duration: 2, rings: [{ start: 0, end: 1, box: { x: 1, y: 2, w: 3, h: 4 } }] };
    expect(inFramePixels(scene)).toBe(scene);
  });

  it('honours a phone nav at the phone screen edge', () => {
    const f = phoneFrame();
    const nav = phoneToFrame({ x: 0, y: 0, w: 60, h: 844 });
    const z = clampZoom(phoneToFrame({ x: 50, y: 400, w: 40, h: 30 }), FRAME, PAD, nav, f.x);
    expect(z.x > nav.x + 1e-6 && z.x < nav.x + nav.w - 1e-6).toBe(false);
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
      'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,nb_frames,color_space,color_primaries:format=duration', '-of', 'json', out]);
    const info = JSON.parse(stdout) as { streams: Record<string, string | number>[]; format: { duration: string } };
    expect(info.streams).toHaveLength(1); // silent: no audio track
    const v = info.streams[0]!;
    expect(v).toMatchObject({ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', pix_fmt: 'yuv420p', color_space: 'smpte170m', color_primaries: 'bt709' });
    expect(Number(v.nb_frames)).toBe(90);
    expect(readColr(out)).toEqual(NCLX_601_ON_709); // QuickTime/Safari read this box, not the SPS
    expect(Number(info.format.duration)).toBeCloseTo(3, 1);

    // intro card in the brand colour at 0.3 s (top-left corner, clear of the text)
    const card = await pixel(out, 0.3, 40, 40);
    expect(card.map((c, i) => Math.abs(c - [0x1f, 0x3a, 0x5f][i]!)).every((d) => d <= 6)).toBe(true);
    // caption box (dark, translucent) at 2.0 s near its left padding
    const cap = await pixel(out, 2.0, 668, 924);
    expect(Math.max(...cap)).toBeLessThan(90);
  }, 180_000);

  it('shows the recording on frame 0 of an app scene (not a blank frame)', async () => {
    const plan: ComposePlan = {
      brand,
      scenes: [{ kind: 'app', duration: 1, segments: [{ src: fixture, srcIn: 0.6, srcOut: 1.6, outStart: 0 }] }],
    };
    const out = path.join(dir, 'frame0.mp4');
    const logs: string[] = [];
    await renderVideo(plan, out, { onLog: (l) => logs.push(l) });
    expect(logs.filter((l) => /asynchronous property/.test(l))).toEqual([]);
    const ref = path.join(dir, 'ref.png');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.6', '-i', fixture, '-frames:v', '1', ref]);
    // testsrc2's static colour bars; the background would be black (diff ≥ 250)
    for (const [x, y] of [[100, 300], [500, 300], [900, 300], [1300, 300], [1700, 300], [300, 900]] as const) {
      const got = await pixel(out, 0, x, y);
      const want = await pixel(ref, 0, x, y);
      const diff = Math.max(...got.map((c, i) => Math.abs(c - want[i]!)));
      expect(diff, `patch at ${x},${y}: got ${got} want ${want}`).toBeLessThanOrEqual(8);
    }
  }, 180_000);

  it('stops a stalled render and its browser', async () => {
    const marker = `--scenecast-test-marker=${process.pid}-${Date.now()}`;
    const work = fs.mkdtempSync(path.join(dir, 'stall-'));
    // A project that cannot be imported makes Revideo wait forever for a page that never renders.
    const job = {
      projectFile: path.join(work, 'missing-project.ts'),
      outDir: path.join(work, 'out'),
      publicDir: path.join(work, 'public'),
      root: path.resolve(__dirname, '..'),
      ffmpeg,
      ffprobe: ffprobePath(),
      chrome: chromium.executablePath(),
      chromeArgs: [marker],
      width: 320,
      height: 180,
      define: {},
    };
    const browserProcs = async () =>
      (await run('ps', ['-axo', 'pid=,command='])).stdout.split('\n').filter((l) => l.includes(marker));
    const t0 = Date.now();
    let settled = false;
    const rendering = runRevideo(job, path.join(work, 'job.json'), { stallSec: 4 }).finally(() => (settled = true));
    let browserSeen = false;
    while (!settled && !browserSeen) {
      browserSeen = (await browserProcs()).length > 0;
      await new Promise((r) => setTimeout(r, 200));
    }
    await expect(rendering).rejects.toThrow(/no progress for 4 s/);
    expect(browserSeen).toBe(true); // the browser really was running when the watchdog fired
    expect(Date.now() - t0).toBeLessThan(30_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(await browserProcs()).toEqual([]);
  }, 60_000);

  it('preview removes its temp folder when it fails', async () => {
    const mine = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('scenecast-preview-'));
    const before = new Set(mine());
    const bad: ComposePlan = { brand, scenes: [{ kind: 'app', duration: 1, segments: [{ src: path.join(dir, 'nope.webm'), srcIn: 0, srcOut: 1, outStart: 0 }] }] };
    await expect(preview(bad, { open: false })).rejects.toThrow(/not found/);
    expect(mine().filter((d) => !before.has(d))).toEqual([]);
  });

  it('tags colour in the MP4 colr box when finish() has to re-encode', async () => {
    const src = path.join(dir, 'mpeg4.mp4');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'mpeg4', src]);
    const out = path.join(dir, 'reencoded.mp4');
    await finish(ffmpeg, 'libx264', src, out, 30);
    const { stdout } = await run(ffprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_name,nb_frames', '-of', 'json', out]);
    expect(JSON.parse(stdout).streams[0]).toMatchObject({ codec_name: 'h264', nb_frames: '30' });
    expect(readColr(out)).toEqual(NCLX_601_ON_709);
  });

  for (const sig of ['SIGKILL', 'SIGINT'] as const) {
    it(`leaves no worker or browser behind when the parent dies (${sig})`, async () => {
      const marker = `--scenecast-orphan-marker=${process.pid}-${sig}-${Date.now()}`;
      const work = fs.mkdtempSync(path.join(dir, 'orphan-'));
      const jobFile = path.join(work, 'job.json');
      const job = {
        projectFile: path.join(work, 'missing-project.ts'), // never renders: the worker would run forever
        outDir: path.join(work, 'out'),
        publicDir: path.join(work, 'public'),
        root: path.resolve(__dirname, '..'),
        ffmpeg,
        ffprobe: ffprobePath(),
        chrome: chromium.executablePath(),
        chromeArgs: [marker],
        width: 320,
        height: 180,
        define: {},
      };
      // A separate parent process (plain node can import supervise.ts) that we can kill.
      const parentScript = path.join(work, 'parent.mjs');
      const supervise = path.resolve(__dirname, '../src/supervise.ts');
      fs.writeFileSync(parentScript, `import { runRevideo } from ${JSON.stringify(supervise)};
runRevideo(${JSON.stringify(job)}, ${JSON.stringify(jobFile)}, { stallSec: 300 }).catch(() => {});
console.log('started');
`);
      // CI=true turns off Vite's own exit-on-stdin-EOF, so only scenecast's handling is tested.
      const parent = spawn(process.execPath, ['--no-warnings', parentScript], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' } });
      const procs = async () =>
        (await run('ps', ['-axo', 'pid=,command='])).stdout.split('\n').filter((l) => l.includes(marker) || l.includes(jobFile));
      const deadline = Date.now() + 30_000;
      let browserUp = false;
      while (!browserUp && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        browserUp = (await procs()).some((l) => l.includes(marker));
      }
      expect(browserUp).toBe(true);
      expect((await procs()).some((l) => l.includes('render-worker.ts'))).toBe(true);
      parent.kill(sig);
      let left = await procs();
      const until = Date.now() + 8_000;
      while (left.length && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 250));
        left = await procs();
      }
      expect(left).toEqual([]);
    }, 60_000);
  }
});
