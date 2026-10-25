import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export interface Toolchain {
  python: string;
  ffmpeg: string;
  models: { kokoro: string; voices: string; whisper: string };
}

const KOKORO_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/';
const KOKORO_FILE = 'kokoro-v1.0.onnx';
const VOICES_FILE = 'voices-v1.0.bin';
const WHISPER_MODEL = 'small.en';

const PY_PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../py');

export function cacheDir(): string {
  return process.env.SCENECAST_CACHE ?? path.join(os.homedir(), '.cache', 'scenecast');
}

function nonEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** Finds model.bin of the faster-whisper download under the whisper cache dir. */
function findWhisperModel(root: string): string | undefined {
  const walk = (dir: string): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (e.name === 'model.bin' && nonEmpty(full)) return full;
    }
    return undefined;
  };
  return walk(root);
}

export function findUv(): string | undefined {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'uv'), path.join(fallbackUvDir(), 'uv')];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) candidates.push(path.join(dir, 'uv'));
  return candidates.find((c) => c && nonEmpty(c));
}

function fallbackUvDir(): string {
  return path.join(cacheDir(), 'bin');
}

/** ~/.local/bin when we can create/write it, otherwise a folder in the scenecast cache (still no admin rights). */
function uvInstallDir(): string {
  const dir = path.join(os.homedir(), '.local', 'bin');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return fallbackUvDir();
  }
}

function installUv(): string {
  const dir = uvInstallDir();
  console.log(
    `scenecast: uv (Python package manager) is missing. Installing it into ${dir} with the official installer (no admin rights): curl -LsSf https://astral.sh/uv/install.sh | sh`,
  );
  try {
    execFileSync('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
      stdio: 'inherit',
      env: { ...process.env, UV_UNMANAGED_INSTALL: dir },
    });
  } catch {
    throw new Error(
      'Could not install uv automatically. Install it yourself, then re-run: curl -LsSf https://astral.sh/uv/install.sh | sh',
    );
  }
  const uv = findUv();
  if (!uv) throw new Error('uv install finished but uv was not found in ~/.local/bin or PATH.');
  return uv;
}

/** uv wants ~/.local/share/uv for managed Pythons; if that is not writable, keep them in the scenecast cache. */
export function uvEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SCENECAST_CACHE: cacheDir() };
  env.NLTK_DATA ??= path.join(cacheDir(), 'nltk');
  if (env.UV_PYTHON_INSTALL_DIR) return env;
  const share = path.join(os.homedir(), '.local', 'share');
  try {
    fs.mkdirSync(path.join(share, 'uv'), { recursive: true });
    fs.accessSync(path.join(share, 'uv'), fs.constants.W_OK);
    return env;
  } catch {
    return { ...env, UV_PYTHON_INSTALL_DIR: path.join(cacheDir(), 'python') };
  }
}

function run(cmd: string, args: string[], capture: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: uvEnv() });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)),
    );
  });
}

async function download(url: string, dest: string): Promise<void> {
  console.log(`scenecast: downloading ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  if (!nonEmpty(dest)) throw new Error(`Downloaded file is empty: ${dest}`);
}

export async function ensureToolchain(opts: { offline?: boolean } = {}): Promise<Toolchain> {
  const models = path.join(cacheDir(), 'models');
  const kokoro = path.join(models, KOKORO_FILE);
  const voices = path.join(models, VOICES_FILE);
  const whisperRoot = path.join(models, 'whisper');

  if (opts.offline) {
    const missing: string[] = [];
    if (!nonEmpty(kokoro)) missing.push(`kokoro: ${kokoro}`);
    if (!nonEmpty(voices)) missing.push(`voices: ${voices}`);
    if (!findWhisperModel(whisperRoot)) missing.push(`whisper: ${whisperRoot} (faster-whisper ${WHISPER_MODEL})`);
    if (missing.length) {
      throw new Error(
        `${missing.length} missing model file(s) and offline mode is on:\n  ${missing.join('\n  ')}\nRun setup without --offline to download them.`,
      );
    }
  }

  const uv = findUv() ?? installUv();
  await run(uv, ['sync', '--project', PY_PROJECT], false);

  if (!nonEmpty(kokoro)) await download(KOKORO_BASE + KOKORO_FILE, kokoro);
  if (!nonEmpty(voices)) await download(KOKORO_BASE + VOICES_FILE, voices);
  if (!findWhisperModel(whisperRoot)) {
    console.log(`scenecast: downloading faster-whisper ${WHISPER_MODEL} (Hugging Face)`);
    await run(
      uv,
      [
        'run', '--project', PY_PROJECT, 'python', '-c',
        'import sys; from faster_whisper import WhisperModel; WhisperModel(sys.argv[1], download_root=sys.argv[2])',
        WHISPER_MODEL, whisperRoot,
      ],
      false,
    );
  }
  const whisperModel = findWhisperModel(whisperRoot);
  if (!whisperModel) throw new Error(`Whisper model not found under ${whisperRoot} after download.`);

  // G2P data (NLTK) is fetched here, never at first synthesis. The spaCy model ships in the uv environment.
  await run(uv, ['run', '--project', PY_PROJECT, 'python', '-m', 'scenecast_py.g2p', '--fetch'], false);

  const py = (code: string) => run(uv, ['run', '--project', PY_PROJECT, 'python', '-c', code], true);
  const python = await py('import sys; print(sys.executable)');
  const ffmpeg = await py('import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())');

  return { python, ffmpeg, models: { kokoro, voices, whisper: path.dirname(whisperModel) } };
}

export async function runPy(module: string, args: string[]): Promise<void> {
  if (!/^[A-Za-z_][\w.]*$/.test(module)) throw new Error(`invalid python module name "${module}"`);
  const uv = findUv() ?? installUv();
  try {
    await run(uv, ['run', '--project', PY_PROJECT, 'python', '-m', module, ...args], false);
  } catch (e) {
    throw new Error(`Python module ${module} failed: ${(e as Error).message}`);
  }
}
