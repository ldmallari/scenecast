// Node side of the composer: prepares media, resolves the plan and drives Revideo's headless
// renderer (or its editor, for `preview`). Writes a SILENT MP4; audio is muxed later (Task 9).
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULTS, ensureToolchain, phoneScreen } from '@scenecast/core';
import { clampZoom, inFramePixels, resolveLook, timeline, type ComposePlan, type ResolvedPlan } from './plan.js';
import { runRevideo } from './supervise.js';
export { runRevideo, STALL_SEC } from './supervise.js';

// Revideo phones home by default; scenecast never sends telemetry (the editor in `preview` runs here).
process.env.DISABLE_TELEMETRY = 'true';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_FILE = path.join(PKG_DIR, 'src', 'project.ts');
/** Requires modules as @revideo/ffmpeg sees them (fluent-ffmpeg, the ffprobe installer). */
const ffmpegRequire = () => createRequire(createRequire(require.resolve('@revideo/renderer')).resolve('@revideo/ffmpeg'));

export interface RenderOpts {
  /** Folder for intermediate files (transcoded media, Revideo output). Default: a temp folder, removed afterwards. */
  workDir?: string;
  /** Receives Revideo's own log lines (browser console, Vite), which are otherwise dropped. */
  onLog?: (line: string) => void;
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

/** Re-encodes a take to constant-30 fps H.264 MP4 so Revideo's WebCodecs decoder can seek it frame by frame. */
async function transcodeSource(ffmpeg: string, src: string, dest: string, fps: number, encoder: string): Promise<void> {
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-an',
    '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '16'] : ['-b:v', '12M']),
    // Playwright's VP8 is BT.601 and untagged; Chromium decodes untagged HD as BT.709, which shifts
    // colours. Convert to BT.709 and say so.
    '-vf', 'scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
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

  // The background image, scaled and cropped to cover the frame (centred), so the page draws it 1:1.
  let backgroundUrl: string | undefined;
  const bg = plan.brand.background;
  if (bg && typeof bg === 'object' && 'image' in bg) {
    if (!fs.existsSync(bg.image)) throw new Error(`brand.background image not found: ${bg.image}`);
    backgroundUrl = '/brand-background.png';
    await coverImage(ffmpeg, bg.image, path.join(publicDir, backgroundUrl), width, height);
  }

  // Rendered card pages (image files) are served next to the media.
  const cardImages = new Map<string, string>();
  for (const scene of plan.scenes) {
    const img = scene.card?.image;
    if (!img || cardImages.has(img)) continue;
    if (!fs.existsSync(img)) throw new Error(`card image not found: ${img}`);
    const url = `/cards/card-${cardImages.size}${path.extname(img) || '.png'}`;
    fs.mkdirSync(path.join(publicDir, 'cards'), { recursive: true });
    fs.copyFileSync(img, path.join(publicDir, url));
    cardImages.set(img, url);
  }

  // The phone where the plan places it; its boxes are mapped with the same alignment (captions and the audit agree).
  const align = plan.phoneAlign ?? 'center';
  const phoneRect = phoneScreen(align);
  return {
    width, height, fps, zoomEaseSec,
    total: tl.total,
    brand: plan.brand,
    logoUrl,
    ...resolveLook(plan, { logoUrl, backgroundUrl }),
    phoneRect,
    scenes: plan.scenes.map((s) => inFramePixels(s, align)).map((s, i) => {
      if (s.kind === 'card' && !s.card) throw new Error(`scene ${i}: card scene needs \`card\``);
      if (s.kind === 'card' && s.card!.variant !== 'intro' && !s.card!.title) throw new Error(`scene ${i}: ${s.card!.variant} card needs a title`);
      return {
        ...s,
        ...tl.scenes[i]!,
        segments: s.segments?.map((g) => ({ ...g, src: media.get(g.src)! })),
        ...(s.card?.image ? { card: { ...s.card, image: cardImages.get(s.card.image)! } } : {}),
        zooms: s.zooms?.map((z) => ({ ...z, box: clampZoom(z.box, frame, DEFAULTS.audit.zoomPadPx, s.navBox, s.phone ? phoneRect.x : 0, s.navs) })),
      };
    }),
  };
}

/** Scales an image to cover `w`×`h` (keeping its aspect, centred crop) and writes it as a PNG. */
async function coverImage(ffmpeg: string, src: string, dest: string, w: number, h: number): Promise<void> {
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-frames:v', '1',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`,
    '-pix_fmt', 'rgb24', dest,
  ]);
}

function chromePath(): string {
  const { chromium } = require('playwright') as typeof import('playwright');
  return chromium.executablePath();
}

/**
 * Renders the plan to a silent 1920×1080, 30 fps, H.264 (yuv420p, +faststart) MP4.
 * Revideo runs in a child process, so renders do not share global state.
 */
export async function renderVideo(plan: ComposePlan, out: string, opts: RenderOpts = {}): Promise<{ file: string; duration: number }> {
  const ffmpeg = await toolFfmpeg();
  const encoder = pickH264Encoder(ffmpeg);
  const work = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-render-'));
  const publicDir = path.join(work, 'public'); // Revideo resolves media as <outDir>/../public
  const outDir = path.join(work, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const resolved = await resolvePlan(plan, publicDir, ffmpeg, encoder);
    const rendered = await runRevideo(
      {
        projectFile: PROJECT_FILE,
        outDir,
        publicDir,
        root: PKG_DIR,
        ffmpeg,
        ffprobe: ffprobePath(),
        chrome: chromePath(),
        width: resolved.width,
        height: resolved.height,
        define: { __SCENECAST_PLAN__: JSON.stringify(resolved) },
      },
      path.join(work, 'job.json'),
      { onLog: opts.onLog },
    );
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
export async function finish(ffmpeg: string, encoder: string, rendered: string, out: string, frames: number): Promise<void> {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const probe = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', rendered]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
  const isH264 = /Video: h264\b/.test(probe.stderr);
  // When re-encoding, the encoder takes primaries/transfer from the frames, so set them there too.
  const codec = isH264 ? ['-c:v', 'copy'] : [
    '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=smpte170m:range=tv',
    '-c:v', encoder, '-pix_fmt', 'yuv420p', '-r', String(DEFAULTS.video.fps), ...(encoder === 'libx264' ? ['-crf', '16'] : ['-b:v', '12M']),
  ];
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', rendered,
    '-map', '0:v:0', '-an', '-frames:v', String(frames), ...codec,
    // Revideo's exporter converts its sRGB frames with ffmpeg's default BT.601 matrix and leaves the
    // stream untagged, which players read as BT.709 for HD. Tag what it is, in both places players
    // look: the SPS (bsf, read by Chrome/VLC) and the MP4 `colr` nclx box (the options below, read
    // by QuickTime/Safari). Transfer is tagged bt709 by ruling.
    '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=6:video_full_range_flag=0',
    '-colorspace', 'smpte170m', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart+write_colr', out,
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
  let server: import('vite').ViteDevServer | undefined;
  let started = false;
  try {
    const resolved = await resolvePlan(plan, publicDir, ffmpeg, encoder);
    // As in the render worker: Revideo's ffmpeg settings read these when @revideo/ffmpeg loads.
    process.env.FFMPEG_PATH = ffmpeg;
    process.env.FFPROBE_PATH = ffprobePath();
    const { createServer } = await import('vite');
    const motionCanvas = (require('@revideo/vite-plugin') as { default: (o: object) => unknown[] }).default;
    server = await createServer({
      configFile: false,
      root: PKG_DIR,
      publicDir,
      logLevel: 'error',
      plugins: motionCanvas({ project: PROJECT_FILE, output: path.join(work, 'out') }) as never,
      define: { __SCENECAST_PLAN__: JSON.stringify(resolved) },
      server: { port: opts.port ?? 9100 },
    });
    await server.listen();
    started = true;
  } finally {
    if (!started) {
      await server?.close().catch(() => {});
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  const live = server!;
  const url = live.resolvedUrls?.local[0] ?? `http://localhost:${opts.port ?? 9100}/`;
  if (opts.open !== false) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
  return {
    url,
    close: async () => {
      await live.close();
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}
