// Node side of the composer: prepares media, resolves the plan and drives Revideo's headless
// renderer (or its editor, for `preview`). Writes a SILENT MP4; audio is muxed later (Task 9).
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULTS, ensureToolchain, phoneFrame } from '@scenecast/core';
import { clampZoom, timeline, type ComposePlan, type ResolvedPlan } from './plan.js';

// Revideo phones home by default; scenecast never sends telemetry.
process.env.DISABLE_TELEMETRY = 'true';
process.env.VITE_CJS_IGNORE_WARNING = 'true';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_FILE = path.join(PKG_DIR, 'src', 'project.ts');
const STALL_SEC = 90;
/** Requires modules as @revideo/ffmpeg sees them (fluent-ffmpeg, the ffprobe installer). */
const ffmpegRequire = () => createRequire(createRequire(require.resolve('@revideo/renderer')).resolve('@revideo/ffmpeg'));

export interface RenderOpts {
  /** Folder for intermediate files (transcoded media, Revideo output). Default: a temp folder, removed afterwards. */
  workDir?: string;
}

/** The ffprobe binary Revideo uses (from @ffprobe-installer, a dependency of @revideo/ffmpeg). */
export function ffprobePath(): string {
  const p = (ffmpegRequire()('@ffprobe-installer/ffprobe') as { path: string }).path;
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    throw new Error(`ffprobe at ${p} is not executable; run \`pnpm install\` so its postinstall (chmod) runs (see onlyBuiltDependencies in pnpm-workspace.yaml).`);
  }
  return p;
}

async function toolFfmpeg(): Promise<string> {
  return (await ensureToolchain({ offline: true }).catch(() => ensureToolchain())).ffmpeg;
}

/** libx264 when the ffmpeg build has it, else the BSD-licensed OpenH264 encoder. */
export function pickH264Encoder(ffmpeg: string): 'libx264' | 'libopenh264' {
  const list = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (/\blibx264\b/.test(list)) return 'libx264';
  if (/\blibopenh264\b/.test(list)) return 'libopenh264';
  throw new Error(`ffmpeg at ${ffmpeg} has neither libx264 nor libopenh264`);
}

/**
 * fluent-ffmpeg 2.1.3 (used by Revideo) parses `ffmpeg -formats` with a two-column pattern;
 * ffmpeg ≥ 6 prints a third (device) column, so formats such as `lavfi` look unavailable and
 * Revideo's silent-audio step fails. Teach it the current layout, once.
 */
let fluentPatched = false;
function patchFluentFfmpeg(ffmpeg: string): void {
  if (fluentPatched) return;
  const Fluent = ffmpegRequire()('fluent-ffmpeg') as { prototype: Record<string, unknown> };
  const out = execFileSync(ffmpeg, ['-hide_banner', '-formats'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const formats: Record<string, { description: string; canDemux: boolean; canMux: boolean }> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*([D ])([E ])([d ]?)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || m[4] === '--') continue;
    for (const name of m[4]!.split(',')) {
      const f = (formats[name] ??= { description: m[5]!, canDemux: false, canMux: false });
      if (m[1] === 'D') f.canDemux = true;
      if (m[2] === 'E') f.canMux = true;
    }
  }
  const available = (cb: (err: Error | null, f: typeof formats) => void) => cb(null, formats);
  Fluent.prototype.availableFormats = available;
  Fluent.prototype.getAvailableFormats = available;
  fluentPatched = true;
}

/** Re-encodes a take to constant-30 fps H.264 MP4 so Revideo's WebCodecs decoder can seek it frame by frame. */
async function transcodeSource(ffmpeg: string, src: string, dest: string, fps: number, encoder: string): Promise<void> {
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-an',
    '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '16'] : ['-b:v', '12M']),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps), '-movflags', '+faststart', dest,
  ], { maxBuffer: 1 << 24 });
}

async function resolvePlan(plan: ComposePlan, publicDir: string, ffmpeg: string, encoder: string): Promise<ResolvedPlan> {
  const { width, height, fps, zoomEaseSec } = DEFAULTS.video;
  const frame = { x: 0, y: 0, w: width, h: height };
  const tl = timeline(plan);
  const media = new Map<string, string>();
  for (const scene of plan.scenes) {
    for (const seg of scene.segments ?? []) {
      if (media.has(seg.src)) continue;
      if (!fs.existsSync(seg.src)) throw new Error(`segment source not found: ${seg.src}`);
      const name = `media/take-${media.size}.mp4`;
      media.set(seg.src, `/${name}`);
    }
  }
  fs.mkdirSync(path.join(publicDir, 'media'), { recursive: true });
  await Promise.all([...media].map(([src, url]) => transcodeSource(ffmpeg, src, path.join(publicDir, url), fps, encoder)));

  let logoUrl: string | undefined;
  if (plan.brand.logo) {
    if (!fs.existsSync(plan.brand.logo)) throw new Error(`brand logo not found: ${plan.brand.logo}`);
    logoUrl = `/brand-logo${path.extname(plan.brand.logo)}`;
    fs.copyFileSync(plan.brand.logo, path.join(publicDir, logoUrl));
  }

  const pf = phoneFrame();
  return {
    width, height, fps, zoomEaseSec,
    total: tl.total,
    brand: plan.brand,
    logoUrl,
    phoneRect: { x: pf.x, y: pf.y, w: pf.w, h: pf.h },
    scenes: plan.scenes.map((s, i) => {
      if (s.kind === 'card' && !s.card) throw new Error(`scene ${i}: card scene needs \`card\``);
      if (s.kind === 'card' && s.card!.variant !== 'intro' && !s.card!.title) throw new Error(`scene ${i}: ${s.card!.variant} card needs a title`);
      return {
        ...s,
        ...tl.scenes[i]!,
        segments: s.segments?.map((g) => ({ ...g, src: media.get(g.src)! })),
        zooms: s.zooms?.map((z) => ({ ...z, box: clampZoom(z.box, frame, DEFAULTS.audit.zoomPadPx, s.navBox) })),
      };
    }),
  };
}

function chromePath(): string {
  const { chromium } = require('playwright') as typeof import('playwright');
  return chromium.executablePath();
}

/** Renders the plan to a silent 1920×1080, 30 fps, H.264 (yuv420p, +faststart) MP4. */
export async function renderVideo(plan: ComposePlan, out: string, opts: RenderOpts = {}): Promise<{ file: string; duration: number }> {
  const ffmpeg = await toolFfmpeg();
  const encoder = pickH264Encoder(ffmpeg);
  patchFluentFfmpeg(ffmpeg);
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FFPROBE_PATH = ffprobePath();

  const work = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-render-'));
  const publicDir = path.join(work, 'public'); // Revideo resolves media as <outDir>/../public
  const outDir = path.join(work, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const resolved = await resolvePlan(plan, publicDir, ffmpeg, encoder);
    const { renderVideo: revideoRender } = await import('@revideo/renderer');
    // Revideo never settles when its page fails to load (e.g. a bad import), so give up after a stall.
    let stall: NodeJS.Timeout | undefined;
    let fail: (e: Error) => void = () => {};
    const stalled = new Promise<never>((_, reject) => (fail = reject));
    const kick = () => {
      clearTimeout(stall);
      stall = setTimeout(() => fail(new Error(`Revideo render made no progress for ${STALL_SEC} s`)), STALL_SEC * 1000);
    };
    kick();
    const rendering = revideoRender({
      // Imported verbatim by Revideo's virtual entry; an absolute path resolves from any cwd.
      projectFile: PROJECT_FILE,
      settings: {
        outFile: 'scenecast.mp4',
        outDir,
        logProgress: false,
        progressCallback: kick,
        ffmpeg: { ffmpegPath: ffmpeg, ffprobePath: ffprobePath(), ffmpegLogLevel: 'error' },
        puppeteer: { executablePath: chromePath() },
        projectSettings: {
          size: { x: resolved.width, y: resolved.height },
          background: '#000000',
          exporter: { name: '@revideo/core/ffmpeg', options: { format: 'mp4' } },
        },
        viteConfig: {
          root: PKG_DIR,
          publicDir,
          logLevel: 'error',
          define: { __SCENECAST_PLAN__: JSON.stringify(resolved) },
        },
      },
    });
    const rendered = await Promise.race([rendering, stalled]).finally(() => clearTimeout(stall));
    await finish(ffmpeg, encoder, path.resolve(rendered), out, Math.round(resolved.total * resolved.fps));
    return { file: out, duration: resolved.total };
  } finally {
    if (!opts.workDir) fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Drops Revideo's placeholder audio, keeps exactly `frames` frames and moves the index to the
 * front. Revideo's ffmpeg exporter leaves the codec to ffmpeg's MP4 default (libx264 when built
 * in); if that was not H.264 the video is re-encoded with `encoder`.
 */
async function finish(ffmpeg: string, encoder: string, rendered: string, out: string, frames: number): Promise<void> {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const probe = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', rendered]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
  const isH264 = /Video: h264\b/.test(probe.stderr);
  const codec = isH264 ? ['-c:v', 'copy'] : ['-c:v', encoder, '-pix_fmt', 'yuv420p', '-r', '30', ...(encoder === 'libx264' ? ['-crf', '16'] : ['-b:v', '12M'])];
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', rendered,
    '-map', '0:v:0', '-an', '-frames:v', String(frames), ...codec, '-movflags', '+faststart', out,
  ]);
}

/**
 * Opens the Revideo editor on the plan for scrubbing (the `scenecast preview` command).
 * Media is prepared at full quality; the editor previews at half resolution (540p).
 * Resolves once the server is up; call `close()` to stop it.
 */
export async function preview(plan: ComposePlan, opts: { open?: boolean; port?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const ffmpeg = await toolFfmpeg();
  const encoder = pickH264Encoder(ffmpeg);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-preview-'));
  const publicDir = path.join(work, 'public');
  const resolved = await resolvePlan(plan, publicDir, ffmpeg, encoder);
  const { createServer } = await import('vite');
  const motionCanvas = (require('@revideo/vite-plugin') as { default: (o: object) => unknown[] }).default;
  const server = await createServer({
    configFile: false,
    root: PKG_DIR,
    publicDir,
    logLevel: 'error',
    plugins: motionCanvas({ project: PROJECT_FILE, output: path.join(work, 'out') }) as never,
    define: { __SCENECAST_PLAN__: JSON.stringify(resolved) },
    server: { port: opts.port ?? 9100 },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://localhost:${opts.port ?? 9100}/`;
  if (opts.open !== false) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
  return {
    url,
    close: async () => {
      await server.close();
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}
