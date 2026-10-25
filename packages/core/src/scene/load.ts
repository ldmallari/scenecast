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
  if (spec.app.storageState) spec.app.storageState = rel(spec.app.storageState);
  if (spec.app.loginHook) spec.app.loginHook = rel(spec.app.loginHook);
  if (spec.app.seed && isPathLike(spec.app.seed)) spec.app.seed = rel(spec.app.seed);
  for (const scene of spec.scenes) if (scene.page) scene.page = rel(scene.page);
  return spec;
}

function isPathLike(s: string): boolean {
  return /[\\/]/.test(s) || /\.(m?js|cjs|ts|json|sql|ya?ml)$/i.test(s);
}
