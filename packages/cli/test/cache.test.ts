import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StageCache } from '../src/cache.js';
import { RECORD_STAGE_VERSION, recordStageInput } from '../src/render.js';

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
