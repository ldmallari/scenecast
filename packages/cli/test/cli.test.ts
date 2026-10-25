import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadScene } from '@scenecast/core';
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

describe('app.seed: a path or a command', () => {
  /** A scene file in `dir` with this seed; returns the seed as loadScene resolved it. */
  const loadSeed = async (seed: string) => {
    const file = path.join(dir, 'video.yaml');
    fs.writeFileSync(
      file,
      [
        'id: t', 'title: T', 'output: t',
        'brand: { primary: "#000000", accent: "#ffffff", font: Inter, introTitle: T }',
        `app: { baseUrl: "http://127.0.0.1:9", seed: ${JSON.stringify(seed)} }`,
        'scenes: [{ id: s, kind: app, narration: Hello. }]',
      ].join('\n'),
    );
    return (await loadScene(file)).app.seed!;
  };
  const marker = "import fs from 'node:fs'; fs.writeFileSync('seeded.txt', 'ran');";

  it('runs `node scripts/seed.mjs` as a command, in the scene folder', async () => {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'seed.mjs'), marker);
    const seed = await loadSeed('node scripts/seed.mjs');
    expect(seed).toBe('node scripts/seed.mjs');
    await runSeed(seed, dir, 'http://x');
    expect(fs.readFileSync(path.join(dir, 'seeded.txt'), 'utf8')).toBe('ran');
  });

  it('runs `./seed.mjs` as a path (made absolute)', async () => {
    fs.writeFileSync(path.join(dir, 'seed.mjs'), marker);
    const seed = await loadSeed('./seed.mjs');
    expect(seed).toBe(path.join(dir, 'seed.mjs'));
    await runSeed(seed, dir, 'http://x');
    expect(fs.readFileSync(path.join(dir, 'seeded.txt'), 'utf8')).toBe('ran');
  });

  it('fails at load, with a clear error, when `./nope.mjs` does not exist', async () => {
    await expect(loadSeed('./nope.mjs')).rejects.toThrow(`app.seed: no such file: ${path.join(dir, 'nope.mjs')}`);
  });

  it('runs `python db/seed.py` as a command', async () => {
    // A stand-in `python` first on PATH, so the test needs no Python install.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'python'), '#!/bin/sh\necho "$1" > seeded.txt\n', { mode: 0o755 });
    const seed = await loadSeed('python db/seed.py');
    expect(seed).toBe('python db/seed.py');
    const prev = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prev}`;
    try {
      await runSeed(seed, dir, 'http://x');
    } finally {
      process.env.PATH = prev;
    }
    expect(fs.readFileSync(path.join(dir, 'seeded.txt'), 'utf8').trim()).toBe('db/seed.py');
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
