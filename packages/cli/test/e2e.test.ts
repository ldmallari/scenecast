// The whole pipeline on the demo app: real Kokoro, recorder, Revideo, mix and whisper audit.
// Slow (minutes). Runs only with SCENECAST_E2E=1, like the other E2E tests:
//   SCENECAST_E2E=1 pnpm -C packages/cli exec vitest run -t e2e
// SCENECAST_E2E_DIR keeps the outputs (out/ and work/) in that folder instead of a temp folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureToolchain, runFfmpeg } from '@scenecast/core';
import { prepare } from '../src/render.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = path.join(REPO, 'packages/cli/bin/scenecast.js');
const SCENE_FILE = path.join(REPO, 'examples/demo-app/video.yaml');
const PORT = 4310; // video.yaml's app.baseUrl

/** CLI runs still going (killed in afterAll, so a timed-out test leaves no render behind). */
const running = new Set<ReturnType<typeof spawn>>();

function cli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    child.on('close', () => running.delete(child));
    let out = '';
    const take = (d: Buffer) => {
      out += d.toString();
      process.stdout.write(d);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

async function durationOf(file: string): Promise<number> {
  const { ffmpeg } = await ensureToolchain({ offline: true });
  const { err } = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0', '-c', 'copy', '-t', '0', '-f', 'null', '-']);
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err)!;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

describe.skipIf(!process.env.SCENECAST_E2E)('e2e', () => {
  let server: Server;
  let dir: string;
  beforeAll(async () => {
    const mod = (await import(path.join(REPO, 'examples/demo-app/server.mjs'))) as {
      serveDemoApp: (o: { port: number }) => Promise<Server>;
    };
    server = await mod.serveDemoApp({ port: PORT });
    dir = process.env.SCENECAST_E2E_DIR ? path.resolve(process.env.SCENECAST_E2E_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-e2e-'));
    fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'work'), { recursive: true, force: true });
  });
  afterAll(async () => {
    for (const child of running) child.kill('SIGTERM');
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    if (!process.env.SCENECAST_E2E_DIR) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('demo video renders and audit passes (e2e)', async () => {
    const args = ['render', SCENE_FILE, '--out', path.join(dir, 'out'), '--work', path.join(dir, 'work')];
    const first = await cli(args);
    expect(first.code).toBe(0);

    const out = path.join(dir, 'out');
    // audit.json is the audit; its moments are the table's rows.
    const audit = JSON.parse(fs.readFileSync(path.join(out, 'audit', 'audit.json'), 'utf8')) as {
      pass: boolean;
      counts: { fail: number };
      moments: { scene: string; kind: string; verdict: string; captionSide: string; gap: number | null }[];
    };
    const rows = audit.moments;
    expect(audit.pass).toBe(true);
    expect(audit.counts.fail).toBe(0);
    expect(rows.find((r) => r.kind === 'unzoom')!.verdict).toBe('PASS');
    expect(rows.filter((r) => r.scene === 'phone').some((r) => r.captionSide === 'beside')).toBe(true);
    expect(Math.max(...rows.filter((r) => r.gap !== null).map((r) => Math.abs(r.gap!)))).toBeLessThanOrEqual(0.3);
    // The signed-in session (cookies, and the sessionStorage sign-in the flags route turns on) is never left behind.
    const recordDir = path.join(dir, 'work', 'demo', 'record');
    const leftovers = fs.readdirSync(recordDir, { recursive: true }).map(String).filter((f) => /session/.test(path.basename(f)));
    expect(leftovers).toEqual([]);
    const srt = fs.readFileSync(path.join(out, 'demo.srt'), 'utf8');
    expect(srt).toContain('To sign the work agreement:');
    const duration = await durationOf(path.join(out, 'demo.mp4'));
    expect(duration).toBeGreaterThan(30);
    expect(duration).toBeLessThan(120);
    for (const f of ['demo.srt', 'chapters.txt', 'audit/audit-table.md', 'audit/contact-sheet.png']) expect(fs.existsSync(path.join(out, f))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'chapters.txt'), 'utf8').trim().split('\n')).toHaveLength(6);
    // The narrated chapter card is captioned too.
    expect(fs.readFileSync(path.join(out, 'demo.srt'), 'utf8')).toContain('Next, the same app on a phone.');

    // Nothing changed, so the second run reuses every stage.
    const second = await cli(args);
    expect(second.code).toBe(0);
    for (const stage of ['voice', 'record/sign-in', 'record/phone', 'compose', 'music', 'voicetrack', 'mix', 'audit'])
      expect(second.out).toContain(`${stage}: cached`);

    // The plan the render composed: every stage is cached now, so preparing it again is cheap.
    const { video } = await prepare(SCENE_FILE, { workRoot: path.join(dir, 'work'), log: () => {} });
    const plan = video.plan;
    expect(plan.scenes[0]).toMatchObject({ kind: 'card', duration: 3.5 });
    expect(plan.scenes.at(-1)!.card).toMatchObject({ variant: 'outro', next: 'Next: approving requests' });
  }, 45 * 60_000);
});
