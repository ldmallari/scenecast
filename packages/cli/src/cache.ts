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
