import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BrowserContext, Page } from 'playwright';
import { loadScene, sessionStoragePath } from '@scenecast/core';
import { saveSession } from '../src/index.js';
import { prepare, runSeed, timingSummary } from '../src/render.js';

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

describe('scenecast login: saveSession', () => {
  /** A page on `url` whose frames hold this sessionStorage, as Playwright's Page/Frame expose it. */
  const stubPage = (url: string, frames: { url: string; storage: Record<string, string> }[], closed = false) =>
    ({
      url: () => url,
      isClosed: () => closed,
      frames: () => frames.map((f) => ({ url: () => f.url, evaluate: async () => f.storage, waitForLoadState: async () => {} })),
    }) as unknown as Page;
  const stubContext = (pages: Page[] = []) =>
    ({
      storageState: async ({ path: p }: { path: string }) => fs.writeFileSync(p, '{"cookies":[],"origins":[]}'),
      pages: () => pages,
    }) as unknown as BrowserContext;

  it("saves the storageState and the baseUrl origin's sessionStorage beside it", async () => {
    const target = path.join(dir, 'auth', 'state.json');
    const page = stubPage('http://127.0.0.1:9/dashboard', [
      { url: 'http://127.0.0.1:9/dashboard', storage: { token: 't1' } },
      { url: 'http://other.example.invalid/frame', storage: { theirs: 'x' } },
    ]);
    await saveSession(stubContext(), page, target, 'http://127.0.0.1:9');
    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sessionStoragePath(target), 'utf8'))).toEqual({ 'http://127.0.0.1:9': { token: 't1' } });
  });

  it('reads the last open tab when the first one was closed', async () => {
    const target = path.join(dir, 'state.json');
    const closed = stubPage('about:blank', [], true);
    const last = stubPage('http://127.0.0.1:9/', [{ url: 'http://127.0.0.1:9/', storage: { token: 't2' } }]);
    await saveSession(stubContext([closed, last]), closed, target, 'http://127.0.0.1:9');
    expect(JSON.parse(fs.readFileSync(sessionStoragePath(target), 'utf8'))).toEqual({ 'http://127.0.0.1:9': { token: 't2' } });
  });
});

describe('cards and pages', () => {
  const sceneFile = (lines: string[]) => {
    const file = path.join(dir, 'video.yaml');
    fs.writeFileSync(file, [
      'id: t', 'title: T', 'output: t',
      'brand: { primary: "#1F3A5F", accent: "#F5C518", font: Inter, introTitle: T }',
      'app: { baseUrl: "http://127.0.0.1:9" }',
      ...lines,
    ].join('\n'));
    return file;
  };

  it('prints the scene file warnings, including page on an app scene', async () => {
    const file = sceneFile(['scenes: [{ id: s, kind: app, narration: Hello., page: ./card.html }]']);
    const logs: string[] = [];
    // An unknown --only stops before any voice work, after the warnings are out.
    await expect(prepare(file, { only: 'nope', workRoot: path.join(dir, 'work'), log: (m) => logs.push(m) })).rejects.toThrow(/no scene "nope"/);
    expect(logs).toEqual(['warning: scene "s": page is used only on title scenes; ignored']);
  });

  it('a second render into the same work dir fails at once, naming the dir and the pid that holds it', async () => {
    const file = sceneFile(['scenes: [{ id: s, kind: app, narration: Hello. }]']);
    const workDir = path.join(dir, 'work', 't');
    fs.mkdirSync(workDir, { recursive: true });
    // Another live process (the test runner's parent) holds the lock.
    fs.writeFileSync(path.join(workDir, '.lock'), `${process.ppid}\n`);
    const logs: string[] = [];
    await expect(prepare(file, { workRoot: path.join(dir, 'work'), log: (m) => logs.push(m) })).rejects.toThrow(
      `work dir ${workDir} is in use by another render (pid ${process.ppid})`,
    );
    // Nothing ran: the voice stage never started.
    expect(logs.filter((l) => !l.startsWith('warning:') && !l.includes('not responding'))).toEqual([]);
    expect(fs.readdirSync(workDir)).toEqual(['.lock']);
  });

  it('renders the intro, outro and title scene pages once and passes the images to the plan', async () => {
    const page = (name: string, colour: string) => {
      fs.writeFileSync(path.join(dir, name), `<!doctype html><style>body{margin:0;background:${colour}}</style>`);
      return `./${name}`;
    };
    const file = sceneFile([
      `cards: { introPage: ${page('intro.html', 'var(--sc-primary)')}, outroPage: ${page('outro.html', 'var(--sc-accent)')} }`,
      `scenes: [{ id: ch, kind: title, title: Chapter, seconds: 2, narration: Hello there., page: ${page('ch.html', '#123456')} }]`,
    ]);
    const prevFake = process.env.SCENECAST_FAKE_TTS;
    process.env.SCENECAST_FAKE_TTS = '1';
    try {
      const logs: string[] = [];
      const work = path.join(dir, 'work');
      const { video } = await prepare(file, { workRoot: work, log: (m) => logs.push(m) });
      const cards = video.plan.scenes.map((s) => s.card);
      expect(cards.map((c) => c?.variant)).toEqual(['intro', 'chapter', 'outro']);
      expect(cards.map((c) => c?.image)).toEqual(['intro', 'scene-ch', 'outro'].map((n) => path.join(work, 't', 'cards', n, 'card.png')));
      for (const c of cards) expect(fs.existsSync(c!.image!)).toBe(true);
      expect(logs.filter((l) => /^cards\/.*done/.test(l))).toHaveLength(3);
      // A second prepare reuses the rendered pages.
      const again: string[] = [];
      await prepare(file, { workRoot: work, log: (m) => again.push(m) });
      expect(again.filter((l) => /^cards\/.*cached/.test(l))).toHaveLength(3);
      // --only leaves out the intro and outro, so their pages are not rendered.
      const only: string[] = [];
      const one = await prepare(file, { only: 'ch', workRoot: path.join(dir, 'work-only'), log: (m) => only.push(m) });
      expect(one.video.plan.scenes.map((s) => s.card?.variant)).toEqual(['chapter']);
      expect(only.filter((l) => l.startsWith('cards/'))).toEqual([expect.stringMatching(/^cards\/scene-ch: done/)]);
    } finally {
      if (prevFake === undefined) delete process.env.SCENECAST_FAKE_TTS;
      else process.env.SCENECAST_FAKE_TTS = prevFake;
    }
  }, 120_000);
});

describe('the scenecast binary', () => {
  it('loads and prints its usage (the sources run on Node type stripping)', async () => {
    const bin = fileURLToPath(new URL('../bin/scenecast.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [bin, '--help'], { timeout: 30_000 });
    expect(stdout).toMatch(/^Usage:/);
  }, 40_000);

  it('prints the version from the cli package.json with --version and -v', async () => {
    const bin = fileURLToPath(new URL('../bin/scenecast.js', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version).toBe('1.1.0');
    for (const flag of ['--version', '-v']) {
      const { stdout } = await promisify(execFile)(process.execPath, [bin, flag], { timeout: 30_000 });
      expect(stdout.trim()).toBe(`scenecast ${pkg.version}`);
    }
  }, 60_000);
});
