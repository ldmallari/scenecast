import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSeed, timingSummary } from '../src/render.js';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-cli-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runSeed', () => {
  it('runs a script path with node, in the scene folder, with SCENECAST_BASE_URL', async () => {
    const script = path.join(dir, 'seed.mjs');
    fs.writeFileSync(script, "import fs from 'node:fs'; fs.writeFileSync('seeded.txt', process.env.SCENECAST_BASE_URL);");
    await runSeed(script, dir, 'http://127.0.0.1:9');
    expect(fs.readFileSync(path.join(dir, 'seeded.txt'), 'utf8')).toBe('http://127.0.0.1:9');
  });

  it('runs anything else as a shell command', async () => {
    await runSeed('echo "$SCENECAST_BASE_URL" > shell.txt', dir, 'http://x');
    expect(fs.readFileSync(path.join(dir, 'shell.txt'), 'utf8').trim()).toBe('http://x');
  });

  it('a failing seed stops the render', async () => {
    await expect(runSeed('exit 3', dir, 'http://x')).rejects.toThrow(/exited with code 3/);
  });
});

describe('timingSummary', () => {
  it('lists each stage and the total as a multiple of the video length', () => {
    const s = timingSummary({ voice: 20, compose: 40 }, 80, 40);
    expect(s).toContain('timings for a 40.0 s video:');
    expect(s).toMatch(/voice\s+20\.0 s \(0\.50x\)/);
    expect(s).toMatch(/compose\s+40\.0 s \(1\.00x\)/);
    expect(s).toMatch(/total\s+80\.0 s \(2\.00x\)/);
  });

  it('says when everything was cached', () => {
    expect(timingSummary({}, 0.1, 40)).toContain('every stage was cached');
  });
});
