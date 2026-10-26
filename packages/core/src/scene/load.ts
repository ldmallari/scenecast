import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { VideoSpecSchema, type VideoSpec } from './schema.js';

/** Validate an already-parsed scene object. Throws one Error listing every problem. */
export function parseScene(raw: unknown): VideoSpec {
  const result = VideoSpecSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) =>
      i.code === 'custom' ? i.message : `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`invalid scene file:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Load, validate, and resolve relative paths against the scene file's directory. */
export async function loadScene(file: string): Promise<VideoSpec> {
  const abs = path.resolve(file);
  const text = await readFile(abs, 'utf8');
  const ext = path.extname(abs).toLowerCase();
  let raw: unknown;
  if (ext === '.yaml' || ext === '.yml') raw = parseYaml(text);
  else if (ext === '.json') raw = JSON.parse(text);
  else throw new Error(`unsupported scene file extension "${ext}" (use .yaml, .yml or .json)`);

  const spec = parseScene(raw);
  const dir = path.dirname(abs);
  const rel = (p: string | undefined) => (p === undefined || path.isAbsolute(p) ? p : path.resolve(dir, p));

  if (spec.brand.logo) spec.brand.logo = rel(spec.brand.logo);
  if (spec.brand.music) {
    spec.brand.music.file = rel(spec.brand.music.file)!;
    if (!existsSync(spec.brand.music.file)) throw new Error(`brand.music.file not found: ${spec.brand.music.file}`);
  }
  if (spec.app.storageState) spec.app.storageState = rel(spec.app.storageState);
  if (spec.app.loginHook) spec.app.loginHook = rel(spec.app.loginHook);
  if (spec.app.seed) spec.app.seed = resolveSeed(spec.app.seed, dir);
  const init = spec.app.initScript;
  if (init !== undefined)
    spec.app.initScript = (Array.isArray(init) ? init : [init]).map((i) => resolveInitScript(i, dir));
  if (spec.app.routes)
    for (const r of spec.app.routes) if (r.module) r.module = rel(r.module);
  const bg = spec.brand.background;
  if (bg && typeof bg === 'object' && 'image' in bg) bg.image = rel(bg.image)!;
  if (spec.cards.introPage) spec.cards.introPage = rel(spec.cards.introPage);
  if (spec.cards.outroPage) spec.cards.outroPage = rel(spec.cards.outroPage);
  for (const scene of spec.scenes) if (scene.page) scene.page = rel(scene.page);
  return spec;
}

/**
 * `app.seed` is a script path only when it is a single token (no whitespace) naming a file that exists,
 * relative to the scene file's folder; that path is made absolute. Anything else is kept verbatim and runs as a
 * shell command in the scene folder (`node scripts/seed.mjs`, `python db/seed.py`, `make seed`). A single token
 * that looks like a path (it has a slash or a script extension) but names no file is an error now, before any
 * voice is synthesised.
 */
export function resolveSeed(seed: string, sceneDir: string): string {
  const s = seed.trim();
  if (/\s/.test(s)) return seed;
  const abs = path.isAbsolute(s) ? s : path.resolve(sceneDir, s);
  if (existsSync(abs)) return abs;
  if (/[\\/]/.test(s) || /\.(m?js|cjs|ts|sh|py|rb)$/i.test(s))
    throw new Error(`app.seed: no such file: ${abs} (a seed is a script path relative to the scene file, or a shell command)`);
  return seed;
}

/**
 * An `app.initScript` item is a file path only when it is a single token naming a file that exists, relative to
 * the scene file's folder (made absolute). Anything with whitespace is inline code and kept verbatim. A single
 * token that looks like a path (slash or script extension) but names no file is an error.
 */
export function resolveInitScript(item: string, sceneDir: string): string {
  const s = item.trim();
  if (/\s/.test(s)) return item;
  const abs = path.isAbsolute(s) ? s : path.resolve(sceneDir, s);
  if (existsSync(abs)) return abs;
  if (/[\\/]/.test(s) || /\.(m?js|cjs)$/i.test(s)) throw new Error(`app.initScript: no such file: ${abs}`);
  return item;
}
