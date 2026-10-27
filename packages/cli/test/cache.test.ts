import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockWorkDir, StageCache } from '../src/cache.js';
import { RECORD_STAGE_VERSION, recordStageFiles, recordStageInput, seedFiles } from '../src/render.js';

let work: string;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-cache-'));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

/**
 * Three stub stages: `a` writes a file from its input, `b` reads a's file (an input file), `c` only
 * has JSON input. Returns which stages actually ran.
 */
async function pipeline(cache: StageCache, inputs: { a: string; c: number }): Promise<string[]> {
  const ran: string[] = [];
  const a = await cache.run({
    name: 'a',
    input: { text: inputs.a },
    run: async (dir) => {
      ran.push('a');
      const file = path.join(dir, 'a.txt');
      fs.writeFileSync(file, inputs.a);
      return { file };
    },
    outputs: (r) => [r.file],
  });
  await cache.run({
    name: 'b',
    input: { from: 'a' },
    files: [a.result.file],
    run: async (dir) => {
      ran.push('b');
      const file = path.join(dir, 'b.txt');
      fs.writeFileSync(file, fs.readFileSync(a.result.file, 'utf8').toUpperCase());
      return { file };
    },
    outputs: (r) => [r.file],
  });
  await cache.run({
    name: 'scene/c',
    input: { n: inputs.c },
    run: async () => {
      ran.push('c');
      return { n: inputs.c * 2 };
    },
  });
  return ran;
}

describe('stage cache', () => {
  it('a second run skips unchanged stages', async () => {
    expect(await pipeline(new StageCache(work), { a: 'hello', c: 1 })).toEqual(['a', 'b', 'c']);
    expect(await pipeline(new StageCache(work), { a: 'hello', c: 1 })).toEqual([]);
  });

  it('re-runs only the stage whose JSON input changed', async () => {
    await pipeline(new StageCache(work), { a: 'hello', c: 1 });
    expect(await pipeline(new StageCache(work), { a: 'hello', c: 2 })).toEqual(['c']);
  });

  it('re-runs a stage whose input file changed', async () => {
    await pipeline(new StageCache(work), { a: 'hello', c: 1 });
    // a's input changes, so a writes a different file, and b (which hashes that file) runs again.
    expect(await pipeline(new StageCache(work), { a: 'world', c: 1 })).toEqual(['a', 'b']);
    expect(fs.readFileSync(path.join(work, 'b', 'b.txt'), 'utf8')).toBe('WORLD');
  });

  it('re-runs a stage whose output went missing or changed', async () => {
    await pipeline(new StageCache(work), { a: 'hello', c: 1 });
    fs.rmSync(path.join(work, 'b', 'b.txt'));
    expect(await pipeline(new StageCache(work), { a: 'hello', c: 1 })).toEqual(['b']);
    fs.writeFileSync(path.join(work, 'b', 'b.txt'), 'tampered');
    expect(await pipeline(new StageCache(work), { a: 'hello', c: 1 })).toEqual(['b']);
  });

  it('returns the cached result and says it was cached', async () => {
    const cache = new StageCache(work);
    const first = await cache.run({ name: 'x', input: 1, run: async () => ({ v: 42 }) });
    const second = await new StageCache(work).run({ name: 'x', input: 1, run: async () => ({ v: 0 }) });
    expect(first).toEqual({ result: { v: 42 }, cached: false });
    expect(second).toEqual({ result: { v: 42 }, cached: true });
  });

  it('fresh ignores the cache', async () => {
    await pipeline(new StageCache(work), { a: 'hello', c: 1 });
    expect(await pipeline(new StageCache(work, { fresh: true }), { a: 'hello', c: 1 })).toEqual(['a', 'b', 'c']);
  });

  it('a failed stage leaves no manifest, so it runs again', async () => {
    const cache = new StageCache(work);
    await expect(cache.run({ name: 'f', input: 1, run: async () => Promise.reject(new Error('boom')) })).rejects.toThrow('boom');
    let runs = 0;
    await cache.run({ name: 'f', input: 1, run: async () => ++runs });
    expect(runs).toBe(1);
  });
});

describe('the record stage version', () => {
  const scene = { id: 'sign-in', kind: 'app', narration: 'Hello.', steps: [] } as never;
  const app = { baseUrl: 'http://127.0.0.1:4310' } as never;
  const cursor = { start: 'center', park: 'right', parkAfterSec: 2.5 } as never;

  it('a take cached without it (before blank frames were frozen in the take) is recorded again', async () => {
    const cache = new StageCache(work);
    const name = 'record/sign-in';
    const now = recordStageInput(scene, [], app, cursor, 6, '#F5C518');
    expect(now.rec).toBe(RECORD_STAGE_VERSION);
    const { rec: _rec, ...before } = now;
    await cache.save(name, await cache.key(name, before), { take: 'old' });
    expect(await cache.lookup(name, await cache.key(name, before))).toEqual({ take: 'old' });
    expect(await cache.lookup(name, await cache.key(name, now))).toBeUndefined();
  });

  it('leaves every other stage key as it was, so voice and music clips are still reused', async () => {
    // Keys computed before the record stage version was added (same global cache version).
    const cache = new StageCache(work);
    expect(await cache.key('music', { seconds: 10, seed: 0 })).toBe('9f37274d5c2edab8549b58e30d9a6a69b586d7a7d014a8202d4a381463ff2ee0');
    expect(await cache.key('voice', { text: 'Hello there.', voice: 'af_heart' })).toBe('26a107f0522c4d5e7ecff3dc00cd32d3e95c304da06cac1db107291d389df46f');
    await cache.save('music', await cache.key('music', { seconds: 10, seed: 0 }), { wav: 'bed.wav' });
    expect(await cache.lookup('music', '9f37274d5c2edab8549b58e30d9a6a69b586d7a7d014a8202d4a381463ff2ee0')).toEqual({ wav: 'bed.wav' });
  });
});

describe('the record stage files', () => {
  it("include the files a scene's upload steps choose, so a changed file records the scene again", () => {
    const a = path.join(work, 'a.pdf');
    const b = path.join(work, 'b.png');
    for (const f of [a, b]) fs.writeFileSync(f, 'x');
    const scene = { id: 's', kind: 'app', narration: 'Hi.', steps: [{ do: 'upload', sel: '.d', file: [a, b] }, { do: 'click', sel: '.x' }] } as never;
    expect(recordStageFiles({ baseUrl: 'http://x' } as never, scene)).toEqual([a, b]);
    const withSetup = { id: 's', kind: 'app', narration: 'Hi.', setup: [{ do: 'upload', sel: '.d', file: [b] }], steps: [{ do: 'upload', sel: '.d', file: [a] }] } as never;
    expect(recordStageFiles({ baseUrl: 'http://x' } as never, withSetup)).toEqual([b, a]);
  });
});

describe('the seed files in the record key', () => {
  it('a seed script, the files a seed command names, and app.seedInputs; not words that are no file', () => {
    fs.mkdirSync(path.join(work, 'scripts'));
    const script = path.join(work, 'scripts', 'seed.mjs');
    const data = path.join(work, 'data.json');
    fs.writeFileSync(script, '');
    fs.writeFileSync(data, '{}');
    expect(seedFiles({ baseUrl: 'x', seed: script } as never, work)).toEqual([script]);
    expect(seedFiles({ baseUrl: 'x', seed: 'node scripts/seed.mjs --reset data.json' } as never, work)).toEqual([script, data]);
    // `scripts` is a folder and `make`/`seed` name nothing: only files count.
    expect(seedFiles({ baseUrl: 'x', seed: 'make seed scripts' } as never, work)).toEqual([]);
    expect(seedFiles({ baseUrl: 'x', seed: 'make seed', seedInputs: [data] } as never, work)).toEqual([data]);
    expect(seedFiles({ baseUrl: 'x' } as never, work)).toEqual([]);
  });
});

describe('work dir lock', () => {
  const CACHE_TS = fileURLToPath(new URL('../src/cache.ts', import.meta.url));
  const lockFile = (dir: string) => path.join(dir, '.lock');
  /** The pid of a process that has exited. */
  const deadPid = () => Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());

  it('takes the lock with its pid and releases it', () => {
    const dir = path.join(work, 'v');
    const lock = lockWorkDir(dir);
    expect(fs.readFileSync(lockFile(dir), 'utf8').trim()).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(lockFile(dir))).toBe(false);
    lock.release(); // twice is harmless
  });

  it('refuses a dir another live process holds, naming the dir and its pid', () => {
    const dir = path.join(work, 'v');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFile(dir), `${process.ppid}\n`);
    expect(() => lockWorkDir(dir)).toThrow(
      `work dir ${dir} is in use by another render (pid ${process.ppid}); wait for it to finish, or render into another dir with --work <dir>`,
    );
    expect(fs.readFileSync(lockFile(dir), 'utf8').trim()).toBe(String(process.ppid));
  });

  it('takes over a stale lock whose process is gone', () => {
    const dir = path.join(work, 'v');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFile(dir), `${deadPid()}\n`);
    const lock = lockWorkDir(dir);
    expect(fs.readFileSync(lockFile(dir), 'utf8').trim()).toBe(String(process.pid));
    lock.release();
  });

  it('is re-entrant in the same process: the last release frees it', () => {
    const dir = path.join(work, 'v');
    const [a, b] = [lockWorkDir(dir), lockWorkDir(dir)];
    a.release();
    expect(fs.existsSync(lockFile(dir))).toBe(true);
    b.release();
    expect(fs.existsSync(lockFile(dir))).toBe(false);
  });

  /** Runs a child that takes the lock, prints "locked", then does `then`; resolves with its exit once it is gone. */
  const child = (dir: string, then: string) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null; sawLock: boolean }>((resolve, reject) => {
      const code = `import { lockWorkDir } from ${JSON.stringify(CACHE_TS)}; lockWorkDir(${JSON.stringify(dir)}); console.log('locked'); ${then}`;
      const p = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let sawLock = false;
      p.stdout.on('data', (d: Buffer) => {
        if (!sawLock && d.toString().includes('locked')) {
          sawLock = fs.existsSync(lockFile(dir));
          p.emit('locked');
        }
      });
      p.on('locked', () => {
        if (then.includes('setInterval')) p.kill('SIGTERM');
      });
      p.on('error', reject);
      p.on('exit', (code, signal) => resolve({ code, signal, sawLock }));
    });

  it('a process that throws or is stopped by a signal leaves no lock behind', async () => {
    // The throw waits a moment, so the parent sees the lock before the child's exit handler removes it.
    for (const then of ["setTimeout(() => { throw new Error('boom'); }, 300);", 'setInterval(() => {}, 1000);']) {
      const dir = path.join(work, `v-${then.length}`);
      const r = await child(dir, then);
      expect(r.sawLock, then).toBe(true);
      expect(r.code !== 0 || r.signal !== null, then).toBe(true);
      expect(fs.existsSync(lockFile(dir)), then).toBe(false);
    }
  }, 30_000);
});
