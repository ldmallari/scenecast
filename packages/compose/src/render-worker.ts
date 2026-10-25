// Child process that runs Revideo's headless renderer for one job (see `runRevideo` in render.ts).
// Running it out of process lets the parent's watchdog stop a stalled render completely: Revideo
// keeps no handle to its browser or Vite server that a caller could close.
// Self-contained (no relative imports, erasable types only) so plain `node` can run it.
// Protocol on stdout: `@@scenecast progress <0..1>`, `@@scenecast done <file>`, `@@scenecast error <message>`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export interface RevideoJob {
  projectFile: string;
  outDir: string;
  publicDir: string;
  root: string;
  ffmpeg: string;
  ffprobe: string;
  chrome: string;
  /** Extra Chromium switches (e.g. a marker the tests look for). */
  chromeArgs?: string[];
  width: number;
  height: number;
  /** Values for Vite's `define` (already JSON-encoded). */
  define: Record<string, string>;
}

const say = (kind: string, value: string) => process.stdout.write(`@@scenecast ${kind} ${value.replace(/\n/g, ' ')}\n`);

/**
 * fluent-ffmpeg 2.1.3 (used by Revideo) parses `ffmpeg -formats` with a two-column pattern;
 * ffmpeg ≥ 6 prints a third (device) column, so formats such as `lavfi` look unavailable and
 * Revideo's silent-audio step fails. Teach it the current layout.
 */
function patchFluentFfmpeg(ffmpegRequire: NodeJS.Require, ffmpeg: string): void {
  const Fluent = ffmpegRequire('fluent-ffmpeg') as { prototype: Record<string, unknown> };
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
}

async function main(jobFile: string): Promise<void> {
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8')) as RevideoJob;
  // Revideo phones home by default; scenecast never sends telemetry.
  process.env.DISABLE_TELEMETRY = 'true';
  process.env.VITE_CJS_IGNORE_WARNING = 'true';
  process.env.FFMPEG_PATH = job.ffmpeg;
  process.env.FFPROBE_PATH = job.ffprobe;
  // On SIGTERM exit at once: puppeteer's exit hook then kills the browser's process group.
  process.on('SIGTERM', () => process.exit(143));
  // Writes to a dead parent's pipes must not crash us at some random point; stdin EOF below is
  // the one, deterministic way we notice the parent is gone.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  // The parent holds our stdin open; EOF means it is gone (even after SIGKILL), so stop too.
  process.stdin.on('end', () => process.exit(129));
  process.stdin.on('close', () => process.exit(129));
  process.stdin.resume();

  const require = createRequire(import.meta.url);
  const rendererPath = require.resolve('@revideo/renderer');
  patchFluentFfmpeg(createRequire(createRequire(rendererPath).resolve('@revideo/ffmpeg')), job.ffmpeg);
  const { renderVideo } = require(rendererPath) as typeof import('@revideo/renderer');

  const file = await renderVideo({
    // Imported verbatim by Revideo's virtual entry; an absolute path resolves from any cwd.
    projectFile: job.projectFile,
    settings: {
      outFile: 'scenecast.mp4',
      outDir: job.outDir,
      logProgress: false,
      progressCallback: (_worker: number, p: number) => say('progress', String(p)),
      ffmpeg: { ffmpegPath: job.ffmpeg, ffprobePath: job.ffprobe, ffmpegLogLevel: 'error' },
      puppeteer: { executablePath: job.chrome, args: [...(job.chromeArgs ?? [])] },
      projectSettings: {
        size: { x: job.width, y: job.height },
        background: '#000000',
        exporter: { name: '@revideo/core/ffmpeg', options: { format: 'mp4' } },
      },
      viteConfig: { root: job.root, publicDir: job.publicDir, logLevel: 'error', define: job.define },
    },
  });
  say('done', file);
}

main(process.argv[2]!).then(
  () => process.exit(0),
  (e: unknown) => {
    say('error', e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
