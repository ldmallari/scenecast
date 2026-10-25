import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TRAVEL_SEC, recordScene, travelSecFor } from '../src/record/record.js';
import { DEFAULTS, type AppConn, type Scene, type Step } from '../src/scene/schema.js';
import type { ScheduledStep } from '../src/schedule.js';

const APP_DIR = fileURLToPath(new URL('../../../examples/demo-app/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Tiny static server: real files by path, everything else falls back to index.html (client-side routes). */
function serveDemoApp(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
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
  await new Promise((r) => server.close(r));
  fs.rmSync(work, { recursive: true, force: true });
});

function scene(id: string, route: string, steps: Step[]): Scene {
  return { id, kind: 'app', route, viewport: 'desktop', narration: 'x', steps } as Scene;
}
function sched(steps: Step[], startAts: number[]): ScheduledStep[] {
  return steps.map((step, index) => ({ index, step, cueTime: null, startAt: startAts[index]! }));
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
    // ring fires on its own time (no travel) and logs the padded box
    expect(Math.abs(take.events[3]!.at - 4.0)).toBeLessThanOrEqual(0.15);
    expect(inFrame(take.events[3]!.target!)).toBe(true);
    expect(take.events.every((e) => e.panels.length === 0 && e.loading === false)).toBe(true);
  }, 60_000);

  it('slow route still lands on cue', async () => {
    const steps: Step[] = [
      { do: 'goto', text: '/slow' },
      { do: 'click', sel: '#slow-action' },
    ];
    const take = await recordScene(scene('slow', '/dashboard', steps), sched(steps, [0.5, 1.0]), app, path.join(work, 'takes'));
    const click = take.events[1]!;
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

  it('open panel boxes logged', async () => {
    const steps: Step[] = [{ do: 'click', sel: '#menu-button' }];
    const take = await recordScene(scene('menu', '/dashboard', steps), sched(steps, [0.8]), app, path.join(work, 'takes'));
    const e = take.events[0]!;
    expect(e.panels).toHaveLength(1);
    expect(inFrame(e.panels[0]!)).toBe(true);
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
});
