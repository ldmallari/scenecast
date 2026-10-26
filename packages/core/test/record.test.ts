import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findUv, uvEnv } from '../src/toolchain.js';
import { DEFAULT_TRAVEL_SEC, recordScene, travelSecFor, type TakeEvent } from '../src/record/record.js';
import { DEFAULTS, type AppConn, type Scene, type Step } from '../src/scene/schema.js';
import type { ScheduledStep } from '../src/schedule.js';

const APP_DIR = fileURLToPath(new URL('../../../examples/demo-app/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Tiny static server: real files by path, everything else falls back to index.html (client-side
 * routes). `/events` (server-sent events) and `/stream` (a streamed response) stay open forever.
 */
function serveDemoApp(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (urlPath === '/events' || urlPath === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: 2 new updates\n\n');
      return;
    }
    let file = path.join(APP_DIR, path.normalize(urlPath));
    if (!file.startsWith(APP_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(APP_DIR, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server: http.Server;
let app: AppConn;
let work: string;

beforeAll(async () => {
  server = await serveDemoApp();
  const { port } = server.address() as AddressInfo;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-rec-'));
  app = {
    baseUrl: `http://127.0.0.1:${port}`,
    login: [
      { do: 'goto', text: '/login' },
      { do: 'type', sel: '#email', text: 'sam@example.com' },
      { do: 'type', sel: '#password', text: 'demo' },
      { do: 'click', sel: '#signin' },
    ],
  };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(work, { recursive: true, force: true });
});

function scene(id: string, route: string, steps: Step[]): Scene {
  return { id, kind: 'app', route, viewport: 'desktop', narration: 'x', steps } as Scene;
}
function sched(steps: Step[], startAts: number[]): ScheduledStep[] {
  return steps.map((step, index) => ({ index, step, cueTime: null, startAt: startAts[index]! }));
}
/** The ffmpeg that ships with the toolchain (imageio-ffmpeg), else one on PATH. */
function ffmpegBin(): string {
  const uv = findUv();
  if (uv) {
    try {
      const py = path.resolve(import.meta.dirname, '../../../py');
      const cmd = 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())';
      return execFileSync(uv, ['run', '--project', py, 'python', '-c', cmd], { encoding: 'utf8', env: uvEnv() }).trim();
    } catch {
      // fall through
    }
  }
  return 'ffmpeg';
}

const VIDEO_FPS = 25; // Playwright's webm frame rate
/** RGB at (x, y) (a 2×2 crop: yuv420 needs even sizes) in every frame of `file`, resampled to a constant 25 fps. */
function pixelTrack(file: string, x: number, y: number): [number, number, number][] {
  const raw = execFileSync(
    ffmpegBin(),
    ['-v', 'error', '-i', file, '-vf', `fps=${VIDEO_FPS},crop=2:2:${2 * Math.floor(x / 2)}:${2 * Math.floor(y / 2)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const px: [number, number, number][] = [];
  for (let i = 0; i + 11 < raw.length; i += 12) px.push([raw[i]!, raw[i + 1]!, raw[i + 2]!]);
  return px;
}

const inFrame = (b: { x: number; y: number; w: number; h: number }) =>
  b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= DEFAULTS.video.width && b.y + b.h <= DEFAULTS.video.height;

describe('recordScene', () => {
  it('records a scene and logs target box', async () => {
    const steps: Step[] = [
      { do: 'click', sel: '#agree' },
      { do: 'type', sel: '#name', text: 'Sam Rivera' },
      { do: 'click', sel: 'button:has-text("Sign")' },
      { do: 'ring', sel: '#signed', pad: 8, ms: 600 },
    ];
    const s = scene('sign', '/form', steps);
    const plan = sched(steps, [1.0, 2.0, 3.2, 4.0]);
    const out = path.join(work, 'takes');
    const take = await recordScene(s, plan, app, out);

    expect(take.file).toBe(path.join(out, 'sign.webm'));
    expect(fs.statSync(take.file).size).toBeGreaterThan(1000);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'sign.boxes.json'), 'utf8'))).toEqual(take);
    expect(take.flashAt).toBeGreaterThanOrEqual(0);
    expect(take.viewport).toBeUndefined();

    expect(take.events.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(take.events.map((e) => e.kind)).toEqual(['click', 'type', 'click', 'ring']);
    expect(travelSecFor(steps[0]!)).toBe(DEFAULT_TRAVEL_SEC);
    for (const i of [0, 1, 2]) {
      const e = take.events[i]!;
      expect(inFrame(e.target!)).toBe(true);
      expect(e.cursorTo).toBeDefined();
      expect(Math.abs(e.at - (plan[i]!.startAt + DEFAULT_TRAVEL_SEC))).toBeLessThanOrEqual(0.15);
    }
    // ring fires on its own time (no travel); it logs the box it drew (padded) and the element at its peak
    const ringEv = take.events[3]!;
    expect(Math.abs(ringEv.at - 4.0)).toBeLessThanOrEqual(0.15);
    expect(inFrame(ringEv.target!)).toBe(true);
    const el = ringEv.target!;
    for (const [k, v] of Object.entries({ x: el.x - 8, y: el.y - 8, w: el.w + 16, h: el.h + 16 }))
      expect(Math.abs(ringEv.ringBox![k as keyof typeof el] - v)).toBeLessThanOrEqual(1); // #signed did not move
    expect(take.events.every((e) => e.panels.length === 0 && e.loading === false && e.loadingBefore === false)).toBe(true);
    // How long each action lasts: typing ends after its 10 characters, the ring after its hold and fades, clicks are instant.
    const typed = take.events[1]!;
    expect(typed.busyUntil! - typed.at).toBeGreaterThanOrEqual(10 * 0.035 - 0.02);
    expect(ringEv.busyUntil! - ringEv.at).toBeCloseTo((600 + 2 * 150) / 1000, 6);
    expect(take.events[0]!.busyUntil).toBeUndefined();

    // Real sync check against the video: the gap from the first magenta frame to the first frame
    // showing the green "Signed by" line must equal the logged gap from the flash to the Sign click.
    const magenta = pixelTrack(take.file, DEFAULTS.video.width / 2, DEFAULTS.video.height / 2).findIndex(
      ([r, g, b]) => r > 200 && g < 80 && b > 200,
    );
    const ring = take.events[3]!.ringBox!; // #signed padded by 8 px
    const signedAt = pixelTrack(take.file, ring.x + 8 + 4, ring.y + ring.h / 2).findIndex(
      ([r, g, b], i) => i > magenta && g - r > 8 && r < 245 && b < 250,
    );
    expect(magenta).toBeGreaterThanOrEqual(0);
    expect(signedAt).toBeGreaterThan(magenta);
    const videoGap = (signedAt - magenta) / VIDEO_FPS;
    expect(Math.abs(videoGap - take.events[2]!.at)).toBeLessThanOrEqual(2 / VIDEO_FPS);
  }, 60_000);

  it('slow route still lands on cue', async () => {
    const steps: Step[] = [
      { do: 'goto', text: '/slow' },
      { do: 'click', sel: '#slow-action' },
    ];
    const take = await recordScene(scene('slow', '/dashboard', steps), sched(steps, [0.5, 1.0]), app, path.join(work, 'takes'));
    const [nav, click] = take.events as [TakeEvent, TakeEvent];
    // The goto itself brings up the "Loading reports" placeholder: after it, not before it.
    expect(nav.loadingBefore).toBe(false);
    expect(nav.loading).toBe(true);
    // The click waits for the settle, so nothing is loading at its cue.
    expect(click.loadingBefore).toBe(false);
    expect(click.loading).toBe(false);
    expect(inFrame(click.target!)).toBe(true);
    // the content only appears 2.5 s after the goto, so the click is late, not skipped
    expect(click.at).toBeGreaterThan(0.5 + 2.5);
  }, 60_000);

  it('missing selector fails with scene and step', async () => {
    const steps: Step[] = [
      { do: 'wait', ms: 200 },
      { do: 'click', sel: '#nope' },
    ];
    await expect(recordScene(scene('s1', '/dashboard', steps), sched(steps, [0, 0.2]), app, path.join(work, 'takes'))).rejects.toThrow(
      'scene "s1" step 1 selector "#nope" not found',
    );
  }, 60_000);

  it('open event streams and a determinate progress bar do not stall a step', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#live-action' }];
    const take = await recordScene(scene('live', '/live', steps), sched(steps, [0.8]), app, path.join(work, 'takes'));
    const e = take.events[0]!;
    expect(e.settleTimedOut).toBeUndefined();
    expect(e.loading).toBe(false);
    expect(Math.abs(e.at - (0.8 + DEFAULT_TRAVEL_SEC))).toBeLessThanOrEqual(0.15);
  }, 60_000);

  it('pointer step without sel fails like ring and zoom', async () => {
    const steps: Step[] = [{ do: 'click' }];
    await expect(recordScene(scene('s2', '/dashboard', steps), sched(steps, [0]), app, path.join(work, 'takes'))).rejects.toThrow(
      'scene "s2" step 0: click needs sel',
    );
  });

  it('open panel boxes logged', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#menu-button' }];
    const take = await recordScene(scene('menu', '/dashboard', steps), sched(steps, [0.8]), app, path.join(work, 'takes'));
    const e = take.events[0]!;
    expect(e.panels).toHaveLength(1);
    expect(inFrame(e.panels[0]!)).toBe(true);
  }, 60_000);

  it('a ring is gone from the take before the next event', async () => {
    const steps: Step[] = [
      { do: 'ring', sel: '.worklist', pad: 8, ms: 300 },
      { do: 'click', sel: '#menu-button' },
    ];
    const take = await recordScene(scene('ringgone', '/dashboard', steps), sched(steps, [0.5, 2.0]), app, path.join(work, 'takes'));
    const [ring, next] = take.events;
    const rb = ring!.ringBox!;
    // A point on the ring's left border (3 px wide), halfway down.
    const track = pixelTrack(take.file, rb.x + 1, rb.y + rb.h / 2);
    const magenta = track.findIndex(([r, g, b]) => r > 200 && g < 80 && b > 200);
    expect(magenta).toBeGreaterThanOrEqual(0);
    const frameAt = (t: number) => magenta + Math.round(t * VIDEO_FPS);
    const isRing = ([r, g, b]: [number, number, number]) => r > 200 && g > 150 && b < 120; // #F5C518
    // Positive control: the ring shows while it holds.
    const during = track.slice(frameAt(ring!.at + 0.25), frameAt(ring!.at + 0.45));
    expect(during.some(isRing)).toBe(true);
    // Removed 0.65 s after it fired (150 fade + 300 hold + 150 fade + 50); none of it from then until the next event.
    const after = track.slice(frameAt(ring!.at + 0.8), frameAt(next!.at));
    expect(after.length).toBeGreaterThan(5);
    expect(after.filter(isRing)).toEqual([]);
  }, 60_000);

  it('declared navs are logged with their boxes; missing ones are skipped', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#menu-button' }];
    const withNav = { ...app, nav: [{ selector: 'header.topbar', edge: 'top' as const }, { selector: '#no-such-nav', edge: 'left' as const }] };
    const take = await recordScene(scene('navs', '/dashboard', steps), sched(steps, [0.6]), withNav, path.join(work, 'takes'));
    expect(take.navs).toHaveLength(1);
    const n = take.navs![0]!;
    expect(n.edge).toBe('top');
    expect(n.box.x).toBe(0);
    expect(n.box.y).toBe(0);
    expect(n.box.w).toBe(DEFAULTS.video.width);
    expect(n.box.h).toBeGreaterThan(30);
  }, 60_000);

  it('phone scene marks the take and keeps boxes in its own pixel space', async () => {
    const steps: Step[] = [{ do: 'zoom', sel: '.worklist', pad: 4 }];
    const s = { ...scene('phone', '/dashboard', steps), viewport: 'phone' } as Scene;
    const take = await recordScene(s, sched(steps, [0.3]), app, path.join(work, 'takes'));
    expect(take.viewport).toBe('phone');
    const b = take.events[0]!.target!;
    expect(b.w).toBeGreaterThan(0);
    expect(b.x + b.w).toBeLessThanOrEqual(DEFAULTS.phone.width + 4);
  }, 60_000);

  it('a sign-in kept in sessionStorage survives into the recorded scene', async () => {
    const sessionApp: AppConn = { ...app, routes: [{ url: '**/api/flags', json: { sso: false, sessionToken: true } }] };
    const steps: Step[] = [{ do: 'ring', sel: '.worklist', ms: 300 }];
    const out = path.join(work, 'takes-session');
    const take = await recordScene(scene('session', '/dashboard', steps), sched(steps, [0.5]), sessionApp, out);
    expect(take.events[0]!.target).toBeDefined();
    // The token lived only in sessionStorage, so it is in the sibling file and not in the storageState.
    const saved = JSON.parse(fs.readFileSync(path.join(out, '.session.session-storage.json'), 'utf8'));
    expect(Object.values(saved[app.baseUrl]).some((v) => String(v).startsWith('demo-'))).toBe(true);
    expect(fs.readFileSync(path.join(out, '.session.json'), 'utf8')).not.toContain('demo-');
  }, 60_000);

  it('app.panels adds a role-less popover to the panels', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#filters' }];
    const plan = sched(steps, [0.5]);
    const without = await recordScene(scene('filters0', '/dashboard', steps), plan, app, path.join(work, 'takes'));
    expect(without.events[0]!.panels).toEqual([]);
    const take = await recordScene(scene('filters', '/dashboard', steps), plan, { ...app, panels: ['.filters-pop'] }, path.join(work, 'takes'));
    expect(take.events[0]!.panels.length).toBe(1);
  }, 60_000);
});
