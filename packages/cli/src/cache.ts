// Stage cache: each stage keeps its outputs and a manifest in work/<id>/<stage>/. A stage is skipped
// when the sha256 of its input JSON plus the hashes of its input files matches the manifest and every
// output it recorded is still there, unchanged.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Bump to invalidate every cached stage after a change in how stages work. */
const CACHE_VERSION = 1;
const MANIFEST = '.stage.json';

export interface StageDef<T> {
  /** Folder under the work dir, e.g. `voice/intro` or `compose`. */
  name: string;
  /** Everything the stage depends on, as JSON. */
  input: unknown;
  /** Files the stage reads; their contents are part of the key. */
  files?: string[];
  /** Does the work, writing into `dir` (emptied first). The result must be JSON. */
  run: (dir: string) => Promise<T>;
  /** Files the result points at; a cache hit needs them unchanged. */
  outputs?: (result: T) => string[];
}

interface Manifest {
  key: string;
  result: unknown;
  outputs: Record<string, string>;
}

/** sha256 of a file's contents, streamed. */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** A held work dir lock (see `lockWorkDir`). */
export interface WorkLock {
  file: string;
  /** Frees the lock (once every holder in this process has released it). Calling it again does nothing. */
  release(): void;
}

const LOCK_FILE = '.lock';
/** Work dirs this process holds, with how many holders each has. */
const held = new Map<string, { count: number; free: () => void }>();

/** Whether a process with this pid is running (EPERM: it is, under another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Locks a video's work dir for this process: two renders writing the same stages at once corrupt them (the voice
 * stage fails with a libsndfile error). The lock is `<dir>/.lock` holding the pid, created atomically. A lock held by
 * a live process fails at once with a message naming the dir and that pid; a stale one (its process is gone) is
 * taken over. It is released by `release()`, and on exit, an uncaught error or SIGINT/SIGTERM/SIGHUP. Re-entrant
 * within a process.
 */
export function lockWorkDir(dir: string): WorkLock {
  const file = path.join(dir, LOCK_FILE);
  const mine = held.get(file);
  if (mine) {
    mine.count++;
    return onceRelease(file);
  }
  fs.mkdirSync(dir, { recursive: true });
  // Written whole to a file of our own, then linked into place: a reader never sees a lock without its pid.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${process.pid}\n`);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.linkSync(tmp, file);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
        const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        if (pid === process.pid) break; // ours, from a holder that has been released without cleaning up
        if (Number.isInteger(pid) && pid > 0 && alive(pid))
          throw new Error(`work dir ${dir} is in use by another render (pid ${pid}); wait for it to finish, or render into another dir with --work <dir>`);
        fs.rmSync(file, { force: true }); // stale: its process is gone
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onExit = () => free();
  // Releases, then lets the signal do what it would have done: other handlers (Playwright's, the preview's) decide;
  // with none, the signal is raised again with no handler, so the process ends as it would have.
  const onSignal = (sig: NodeJS.Signals) => {
    free();
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  };
  const free = () => {
    if (!held.has(file)) return;
    held.delete(file);
    process.removeListener('exit', onExit);
    for (const sig of signals) process.removeListener(sig, onSignal);
    try {
      if (Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  process.on('exit', onExit);
  for (const sig of signals) process.once(sig, onSignal);
  held.set(file, { count: 1, free });
  return onceRelease(file);
}

/** A holder's release: frees the lock when the last holder in this process lets go. */
function onceRelease(file: string): WorkLock {
  let done = false;
  return {
    file,
    release() {
      if (done) return;
      done = true;
      const h = held.get(file);
      if (h && --h.count === 0) h.free();
    },
  };
}

export class StageCache {
  readonly root: string;
  /** Wall-clock seconds of each stage that ran in this process (cached stages are absent). */
  readonly timings: Record<string, number> = {};
  private readonly fresh: boolean;
  private readonly log: (msg: string) => void;

  constructor(root: string, opts: { fresh?: boolean; log?: (msg: string) => void } = {}) {
    this.root = root;
    this.fresh = !!opts.fresh;
    this.log = opts.log ?? (() => {});
  }

  dir(name: string): string {
    return path.join(this.root, name);
  }

  /** The cache key: the stage name, its input JSON and the contents of its input files. */
  async key(name: string, input: unknown, files: string[] = []): Promise<string> {
    const h = createHash('sha256');
    h.update(JSON.stringify({ v: CACHE_VERSION, name, input }));
    for (const f of files) {
      h.update('\0file\0');
      h.update(fs.existsSync(f) ? await hashFile(f) : 'missing');
    }
    return h.digest('hex');
  }

  /** The cached result for `name` if its key matches and its outputs are unchanged. */
  async lookup<T>(name: string, key: string): Promise<T | undefined> {
    if (this.fresh) return undefined;
    let m: Manifest;
    try {
      m = JSON.parse(fs.readFileSync(path.join(this.dir(name), MANIFEST), 'utf8')) as Manifest;
    } catch {
      return undefined;
    }
    if (m.key !== key) return undefined;
    for (const [file, sha] of Object.entries(m.outputs)) {
      if (!fs.existsSync(file) || (await hashFile(file)) !== sha) return undefined;
    }
    return m.result as T;
  }

  /** Records a finished stage. */
  async save(name: string, key: string, result: unknown, outputs: string[] = []): Promise<void> {
    const hashes: Record<string, string> = {};
    for (const f of outputs) hashes[path.resolve(f)] = await hashFile(f);
    fs.mkdirSync(this.dir(name), { recursive: true });
    const m: Manifest = { key, result, outputs: hashes };
    fs.writeFileSync(path.join(this.dir(name), MANIFEST), JSON.stringify(m, null, 2) + '\n');
  }

  /** Runs the stage unless an identical earlier run is cached. */
  async run<T>(def: StageDef<T>): Promise<{ result: T; cached: boolean }> {
    const key = await this.key(def.name, def.input, def.files);
    const hit = await this.lookup<T>(def.name, key);
    if (hit !== undefined) {
      this.log(`${def.name}: cached`);
      return { result: hit, cached: true };
    }
    const dir = this.dir(def.name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const started = performance.now();
    const result = await def.run(dir);
    await this.save(def.name, key, result, def.outputs?.(result) ?? []);
    this.timings[def.name] = (performance.now() - started) / 1000;
    this.log(`${def.name}: done in ${this.timings[def.name]!.toFixed(1)} s`);
    return { result, cached: false };
  }
}
