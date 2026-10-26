import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lastFrameTime } from '../src/ffmpeg.js';
import { findUv, uvEnv } from '../src/toolchain.js';
import { DEFAULT_TRAVEL_SEC, recordScene, travelSecFor, type TakeEvent } from '../src/record/record.js';
import { DEFAULTS, type AppConn, type Scene, type Step } from '../src/scene/schema.js';
import { actionAt, schedule, spotPoint, type ScheduledStep } from '../src/schedule.js';

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
  return steps.map((step, index) => ({ index, step, cueTime: null, startAt: startAts[index]!, travel: travelSecFor(step) }));
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

/** When the action fired on the recorder's own clock: its logged (video-clock) time less any wall-clock step. */
const fired = (e: TakeEvent) => e.at - (e.clockShift ?? 0);

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
    // Each pointer step needs its prep (settle, find and measure the target) done before its glide sets off, or
    // it sets off late by the overrun. The click after the typing gets 0.65 s for that: typing 10 characters
    // ends about 0.45 s after the type action (2.52 s), and the click's glide starts at 3.6 s.
    const plan = sched(steps, [1.0, 2.0, 3.6, 4.4]);
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
      // Never early. Late only by the final checks (aim, loading snapshot, pointer move), which start 40 ms before
      // arrival and measured 13-28 ms on the loaded test PC. The bound is the glide lead (0.15 s): a late action
      // at most doubles the designed rest of the cursor on the target, and retime anchors on the logged time.
      const late = fired(e) - (plan[i]!.startAt + DEFAULT_TRAVEL_SEC);
      expect(late, `event ${i} late by ${late.toFixed(3)} s`).toBeGreaterThanOrEqual(-0.005);
      expect(late, `event ${i} late by ${late.toFixed(3)} s`).toBeLessThanOrEqual(0.15);
    }
    // ring fires on its own time (no travel); it logs the box it drew (padded) and the element at its peak
    const ringEv = take.events[3]!;
    expect(Math.abs(fired(ringEv) - 4.4)).toBeLessThanOrEqual(0.15);
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
    // Up to 3 frames: the click's paint can land 1-2 frames after the logged arrival (screencast and render lag), and
    // both ends are whole 25 fps frames. The audit's sync rule (0.30 s) catches anything worse in a real video.
    expect(Math.abs(videoGap - take.events[2]!.at)).toBeLessThanOrEqual(3 / VIDEO_FPS);
  }, 60_000);

  it('records at least minTakeSec after the flash', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#agree' }];
    const take = await recordScene(scene('long', '/form', steps), sched(steps, [0.5]), app, path.join(work, 'long'), { minTakeSec: 4 });
    expect((await lastFrameTime(take.file)) - take.flashAt).toBeGreaterThanOrEqual(4 - 0.05);
  }, 60_000);

  it('a wall-clock step mid-take moves the logged times with the video, not the steps themselves', async () => {
    // The browser stamps frames with the wall clock; a step of it (WSL2 does this every ~30 s) stretches the video
    // from then on. Here the recorder's view of the wall clock jumps 2 s ahead 1.5 s after the flash. It is built on
    // the monotonic clock, so a real step of the system clock during the test cannot add to it.
    let since: number | undefined;
    const wallClock = () => {
      since ??= performance.now();
      return performance.timeOrigin + performance.now() + (performance.now() - since > 1500 ? 2000 : 0);
    };
    const steps: Step[] = [{ do: 'click', sel: '#agree' }, { do: 'click', sel: '#name' }];
    const plan = sched(steps, [0.5, 2.0]);
    const take = await recordScene(scene('stepped', '/form', steps), plan, app, path.join(work, 'stepped'), { wallClock });
    const [first, second] = take.events as [TakeEvent, TakeEvent];
    // Before the step: logged as it happened. After it: logged 2 s later, where the video shows it.
    expect(first.clockShift).toBeUndefined();
    expect(second.clockShift).toBe(2);
    // Both still fired on their cues: the steps keep the recorder's own clock.
    for (const [i, e] of [first, second].entries()) {
      const late = fired(e) - (plan[i]!.startAt + DEFAULT_TRAVEL_SEC);
      expect(late).toBeGreaterThanOrEqual(-0.005);
      expect(late).toBeLessThanOrEqual(0.15);
    }
  }, 60_000);

  it('pre-positioned click on the first word lands within 0.10 s of its cue', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#menu-button', cue: 'Open' }];
    const voice = { duration: 3, phrases: [], words: [{ w: 'Open', start: 0.15, end: 0.4 }, { w: 'it.', start: 0.45, end: 0.7 }] };
    const plan = schedule({ ...scene('prepos', '/dashboard', steps), narration: 'Open it.' } as Scene, voice, { travelSec: travelSecFor });
    expect(plan[0]).toMatchObject({ startAt: 0.15, travel: 0, prePosition: true });
    const take = await recordScene(scene('prepos', '/dashboard', steps), plan, app, path.join(work, 'takes'));
    const e = take.events[0]!;
    expect(Math.abs(fired(e) - 0.15)).toBeLessThanOrEqual(0.1);
    expect(e.cursorTo).toBeDefined();
  }, 60_000);

  it('two early pointer cues: the second glides (shortened) from the first and lands on its cue', async () => {
    const steps: Step[] = [
      { do: 'hover', sel: '#menu-button', cue: 'Open' },
      { do: 'hover', sel: '#filters', cue: 'filters' },
    ];
    const voice = { duration: 3, phrases: [], words: [{ w: 'Open', start: 0.15, end: 0.4 }, { w: 'filters.', start: 0.55, end: 0.9 }] };
    const plan = schedule({ ...scene('twoearly', '/dashboard', steps), narration: 'Open filters.' } as Scene, voice, { travelSec: travelSecFor });
    expect(plan[1]).toMatchObject({ startAt: 0.15, travel: expect.closeTo(0.4, 6) });
    expect(plan[1]!.prePosition).toBeUndefined();
    const take = await recordScene(scene('twoearly', '/dashboard', steps), plan, app, path.join(work, 'takes'));
    for (const [i, cue] of [0.15, 0.55].entries()) {
      const late = fired(take.events[i]!) - cue;
      expect(late, `event ${i} late by ${late.toFixed(3)} s`).toBeGreaterThanOrEqual(-0.005);
      expect(late, `event ${i} late by ${late.toFixed(3)} s`).toBeLessThanOrEqual(0.15);
    }
  }, 60_000);

  it('a click with glideMs 900 arrives after its own travel', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#menu-button', glideMs: 900 }];
    const plan = sched(steps, [0.6]);
    expect(plan[0]!.travel).toBe(0.9);
    const take = await recordScene(scene('glide900', '/dashboard', steps), plan, app, path.join(work, 'takes'));
    const late = fired(take.events[0]!) - (0.6 + 0.9);
    expect(late, `late by ${late.toFixed(3)} s`).toBeGreaterThanOrEqual(-0.005);
    expect(late, `late by ${late.toFixed(3)} s`).toBeLessThanOrEqual(0.15);
  }, 60_000);

  it('parks the cursor after a lone click', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#menu-button', cue: 'menu' }];
    const voice = { duration: 5, phrases: [], words: [{ w: 'The', start: 0.6, end: 0.8 }, { w: 'menu.', start: 1.0, end: 1.4 }] };
    const to = spotPoint('right', { width: DEFAULTS.video.width, height: DEFAULTS.video.height });
    const plan = schedule({ ...scene('park', '/dashboard', steps), narration: 'The menu.' } as Scene, voice, {
      travelSec: travelSecFor,
      park: { to, afterSec: DEFAULTS.cursor.parkAfterSec },
      sceneEnd: voice.duration,
    });
    expect(plan[0]!.park).toEqual({ at: expect.closeTo(1.6, 6), to });
    const take = await recordScene(scene('park', '/dashboard', steps), plan, app, path.join(work, 'takes'));
    const e = take.events[0]!;
    expect(e.parkedAt!).toBeGreaterThan(e.at + 0.5);
    // parkTo is the drawn cursor box, like cursorTo: its tip sits at (3, 2) inside it.
    expect(Math.abs(e.parkTo!.x + 3 - 1824)).toBeLessThanOrEqual(2);
    expect(Math.abs(e.parkTo!.y + 2 - 486)).toBeLessThanOrEqual(2);
    // The park glide counts as part of the action, so retime never cuts it.
    expect(e.busyUntil!).toBeCloseTo(e.parkedAt! + DEFAULT_TRAVEL_SEC, 3);
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
    expect(fired(click)).toBeGreaterThan(0.5 + 2.5);
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
    expect(Math.abs(fired(e) - (0.8 + DEFAULT_TRAVEL_SEC))).toBeLessThanOrEqual(0.15);
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

  it('phone takes tap with a touch indicator', async () => {
    const steps: Step[] = [
      { do: 'click', sel: ".nav a[href='/requests']" },
      { do: 'ring', sel: 'table', ms: 300 },
    ];
    const s = { ...scene('tap', '/dashboard', steps), viewport: 'phone' } as Scene;
    const plan = steps.map((step, index) => ({ index, step, cueTime: null, startAt: [0.5, 2.0][index]!, travel: travelSecFor(step, { touch: true }) }));
    expect(plan[0]!.travel).toBe(0.25);
    const take = await recordScene(s, plan, app, path.join(work, 'takes'));
    const tap = take.events[0]!;
    expect(tap.cursorTo!.w).toBe(34);
    expect(tap.cursorTo!.h).toBe(34);
    const c = { x: tap.cursorTo!.x + 17, y: tap.cursorTo!.y + 17 };
    const t = { x: tap.target!.x + tap.target!.w / 2, y: tap.target!.y + tap.target!.h / 2 };
    expect(Math.abs(c.x - t.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(c.y - t.y)).toBeLessThanOrEqual(1);
    // The tap lands after its touch lead, like a glide's arrival.
    const late = fired(tap) - (0.5 + 0.25);
    expect(late, `tap late by ${late.toFixed(3)} s`).toBeGreaterThanOrEqual(-0.005);
    expect(late, `tap late by ${late.toFixed(3)} s`).toBeLessThanOrEqual(0.15);
    // The tap navigated: the ring finds the requests table.
    expect(take.events[1]!.target!.w).toBeGreaterThan(0);
  }, 60_000);

  it('a phone check taps the box', async () => {
    const steps: Step[] = [{ do: 'check', sel: '#agree' }];
    const s = { ...scene('tapcheck', '/form', steps), viewport: 'phone' } as Scene;
    const plan = steps.map((step, index) => ({ index, step, cueTime: null, startAt: 0.5, travel: travelSecFor(step, { touch: true }) }));
    const take = await recordScene(s, plan, app, path.join(work, 'takes'));
    expect(take.events[0]!.clicked).toBe(true);
    expect(take.events[0]!.cursorTo!.w).toBe(34);
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

  it('ringSel rings another element than the pointer target', async () => {
    // Zoom steps (pad 0) later in the same take measure #agree and #name on their own.
    const steps: Step[] = [
      { do: 'click', sel: '#agree', ringSel: '#name', pad: 6 },
      { do: 'zoom', sel: '#agree' },
      { do: 'zoom', sel: '#name' },
    ];
    const take = await recordScene(scene('ringsel', '/form', steps), sched(steps, [0.5, 2.8, 3.0]), app, path.join(work, 'takes'));
    const ev = take.events[0]!;
    const [agree, name] = [take.events[1]!.target!, take.events[2]!.target!];
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    // The pointer target is #agree; the ring is #name grown by 6, and ringTarget is #name at the ring's peak.
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      near(ev.target![k], agree[k]);
      near(ev.ringTarget![k], name[k]);
    }
    for (const [k, v] of Object.entries({ x: name.x - 6, y: name.y - 6, w: name.w + 12, h: name.h + 12 }))
      near(ev.ringBox![k as keyof typeof name], v);
    expect(ev.busyUntil! - ev.at).toBeCloseTo((1200 + 300) / 1000, 6);
  }, 60_000);

  it('ringMs sets the ring hold', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#agree', ringSel: '#name', ringMs: 600 }];
    const take = await recordScene(scene('ringms', '/form', steps), sched(steps, [0.5]), app, path.join(work, 'takes'));
    const ev = take.events[0]!;
    expect(Math.abs(ev.busyUntil! - ev.at - (600 + 300) / 1000)).toBeLessThanOrEqual(0.05);
  }, 60_000);

  it('check ticks a box once and leaves a ticked box alone', async () => {
    const steps: Step[] = [
      { do: 'check', sel: '#agree' },
      { do: 'check', sel: '#agree' },
      { do: 'ring', sel: '#agree:checked', ms: 300 },
    ];
    const plan = sched(steps, [0.5, 1.6, 2.6]);
    const take = await recordScene(scene('check', '/form', steps), plan, app, path.join(work, 'takes'));
    expect(take.events.map((e) => e.kind)).toEqual(['check', 'check', 'ring']);
    expect(take.events[0]!.clicked).toBe(true);
    expect(take.events[1]!.clicked).toBe(false);
    expect(take.events[2]!.clicked).toBeUndefined();
    // A check glides like a click and lands on its time.
    for (const i of [0, 1]) {
      const late = fired(take.events[i]!) - (plan[i]!.startAt + DEFAULT_TRAVEL_SEC);
      expect(late, `event ${i} late by ${late.toFixed(3)} s`).toBeGreaterThanOrEqual(-0.005);
      expect(late, `event ${i} late by ${late.toFixed(3)} s`).toBeLessThanOrEqual(0.15);
    }
  }, 60_000);

  it('a check that does not tick fails the take', async () => {
    const steps: Step[] = [{ do: 'check', sel: '#name' }];
    await expect(recordScene(scene('nocheck', '/form', steps), sched(steps, [0.5]), app, path.join(work, 'takes'))).rejects.toThrow(
      'scene "nocheck" step 0: #name is not checked after the click',
    );
  }, 60_000);

  it('scroll by pixels and to a position', async () => {
    // The init script runs before the page has its <html> element, so it makes the page tall once the DOM is in.
    const tall: AppConn = {
      ...app,
      initScript: "document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.minHeight = '4000px'; })",
    };
    const steps: Step[] = [
      { do: 'scroll', by: 400 },
      { do: 'scroll', to: 0 },
    ];
    const take = await recordScene(scene('scrollby', '/dashboard', steps), sched(steps, [0.3, 2.0]), tall, path.join(work, 'takes'));
    expect(take.events[0]!.scrollY).toBeCloseTo(400, 0);
    expect(take.events[1]!.scrollY).toBeCloseTo(0, 0);
  }, 60_000);

  it('scroll by on a page that scrolls inside a container fails the take', async () => {
    // The window can't scroll; the body is the scroller (as in many apps with a 100vh shell).
    const nested: AppConn = {
      ...app,
      initScript:
        "document.addEventListener('DOMContentLoaded', () => { const h = document.documentElement; h.style.overflow = 'hidden'; h.style.height = '100%';" +
        " document.body.style.height = '100%'; document.body.style.overflow = 'auto';" +
        " const tall = document.createElement('div'); tall.style.height = '4000px'; document.body.appendChild(tall); })",
    };
    const steps: Step[] = [{ do: 'scroll', by: 400 }];
    await expect(recordScene(scene('nested', '/dashboard', steps), sched(steps, [0.3]), nested, path.join(work, 'takes'))).rejects.toThrow(
      'scene "nested" step 0: the page did not scroll (the window is not scrollable here; the app probably scrolls inside a container: use a scroll step with sel instead)',
    );
  }, 60_000);

  it('a zoom hold is not busy; an unzoom logs its time only', async () => {
    const steps: Step[] = [
      { do: 'zoom', sel: '.worklist', ms: 3000 },
      { do: 'unzoom' },
    ];
    const take = await recordScene(scene('zoomhold', '/dashboard', steps), sched(steps, [0.3, 1.2]), app, path.join(work, 'takes'));
    const [zoom, unzoom] = take.events as [TakeEvent, TakeEvent];
    expect(zoom.busyUntil).toBeUndefined();
    expect(unzoom.kind).toBe('unzoom');
    expect(Math.abs(fired(unzoom) - 1.2)).toBeLessThanOrEqual(0.15);
    expect(unzoom.target).toBeUndefined();
    expect(unzoom.busyUntil).toBeUndefined();
  }, 60_000);

  it('scene zoom is measured before the flash', async () => {
    // A later zoom step on the same element logs the same padded box (nothing on the page moves in between).
    const steps: Step[] = [{ do: 'zoom', sel: '.worklist', pad: 16 }];
    const zoomed = { ...scene('initzoom', '/dashboard', steps), zoom: { sel: '.worklist', pad: 16 } } as Scene;
    const take = await recordScene(zoomed, sched(steps, [0.3]), app, path.join(work, 'takes'));
    const ref = take.events[0]!.target!;
    expect(ref.w).toBeGreaterThan(32);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(take.initialZoom![k] - ref[k])).toBeLessThanOrEqual(1);
    expect(JSON.parse(fs.readFileSync(path.join(work, 'takes', 'initzoom.boxes.json'), 'utf8')).initialZoom).toEqual(take.initialZoom);
  }, 60_000);

  it('an initial zoom pushed out of view by the pre-positioned first step fails the take', async () => {
    // A button far below the fold: pre-positioning the first click scrolls the page down to it.
    const far: AppConn = {
      ...app,
      initScript:
        "document.addEventListener('DOMContentLoaded', () => { const b = document.createElement('button'); b.id = 'far'; b.textContent = 'Far';" +
        " b.style.cssText = 'display:block;margin:3000px 0 40px'; document.body.appendChild(b); })",
    };
    const steps: Step[] = [{ do: 'click', sel: '#far', cue: 'Far' }];
    const voice = { duration: 2, phrases: [], words: [{ w: 'Far', start: 0.15, end: 0.4 }] };
    const s = { ...scene('farzoom', '/dashboard', steps), narration: 'Far', zoom: { sel: '.worklist', pad: 16 } } as Scene;
    const plan = schedule(s, voice, { travelSec: travelSecFor });
    expect(plan[0]!.prePosition).toBe(true);
    await expect(recordScene(s, plan, far, path.join(work, 'takes'))).rejects.toThrow(
      'scene "farzoom" zoom selector ".worklist" is out of view at the start (the first step\'s target "#far" scrolled the page)',
    );
  }, 60_000);

  it('a missing initial-zoom selector fails with the scene name', async () => {
    const steps: Step[] = [{ do: 'wait', ms: 200 }];
    const zoomed = { ...scene('s1', '/dashboard', steps), zoom: { sel: '.nope' } } as Scene;
    await expect(recordScene(zoomed, sched(steps, [0.3]), app, path.join(work, 'takes'))).rejects.toThrow(
      'scene "s1" zoom selector ".nope" not found',
    );
  }, 60_000);

  it('a park step glides to its spot and lands on its cue', async () => {
    const steps: Step[] = [
      { do: 'click', sel: '#menu-button', cue: 'menu' },
      { do: 'park', at: 'left', cue: 'aside' },
      { do: 'park', cue: 'again' },
    ];
    const voice = {
      duration: 5,
      phrases: [],
      words: [
        { w: 'The', start: 0.6, end: 0.8 },
        { w: 'menu,', start: 1.0, end: 1.4 },
        { w: 'aside,', start: 2.2, end: 2.6 },
        { w: 'again.', start: 3.4, end: 3.8 },
      ],
    };
    const s = { ...scene('parkstep', '/dashboard', steps), narration: 'The menu, aside, again.' } as Scene;
    const plan = schedule(s, voice, { travelSec: travelSecFor });
    expect(plan[1]).toMatchObject({ startAt: expect.closeTo(2.2 - DEFAULT_TRAVEL_SEC, 6), travel: DEFAULT_TRAVEL_SEC });
    // cursor.park 'off': an explicit park with no `at` still goes to the right spot.
    const take = await recordScene(s, plan, app, path.join(work, 'takes'), { cursor: { start: 'center', park: 'off', parkAfterSec: 2.5 } });
    const vp = { width: DEFAULTS.video.width, height: DEFAULTS.video.height };
    for (const [i, spot] of [[1, 'left'], [2, 'right']] as const) {
      const e = take.events[i]!;
      expect(e.kind).toBe('park');
      const late = fired(e) - actionAt(plan[i]!);
      expect(late, `park ${i} late by ${late.toFixed(3)} s`).toBeGreaterThanOrEqual(-0.005);
      expect(late, `park ${i} late by ${late.toFixed(3)} s`).toBeLessThanOrEqual(0.15);
      const p = spotPoint(spot, vp);
      expect(Math.abs(e.cursorTo!.x + 3 - p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(e.cursorTo!.y + 2 - p.y)).toBeLessThanOrEqual(1);
      expect(e.target).toBeUndefined();
    }
  }, 60_000);

  it('a park cued before its glide fits waits on cursor.park from the start', async () => {
    const steps: Step[] = [{ do: 'park', cue: 'Aside' }];
    const voice = { duration: 2, phrases: [], words: [{ w: 'Aside.', start: 0.15, end: 0.5 }] };
    const s = { ...scene('parkpre', '/dashboard', steps), narration: 'Aside.' } as Scene;
    const plan = schedule(s, voice, { travelSec: travelSecFor });
    expect(plan[0]).toMatchObject({ startAt: 0.15, travel: 0, prePosition: true });
    const take = await recordScene(s, plan, app, path.join(work, 'takes'), { cursor: { start: 'center', park: 'left', parkAfterSec: 2.5 } });
    const e = take.events[0]!;
    expect(Math.abs(fired(e) - 0.15)).toBeLessThanOrEqual(0.1);
    const p = spotPoint('left', { width: DEFAULTS.video.width, height: DEFAULTS.video.height });
    expect(Math.abs(e.cursorTo!.x + 3 - p.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.cursorTo!.y + 2 - p.y)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('an invalid app.panels selector is named, not logged as a spinner', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#filters' }];
    await expect(
      recordScene(scene('badpanel', '/dashboard', steps), sched(steps, [0.5]), { ...app, panels: ['.ok', '.pop['] }, path.join(work, 'takes')),
    ).rejects.toThrow('app.panels: invalid selector ".pop["');
  }, 60_000);
});
