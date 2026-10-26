import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './scene/schema.js';
import { ensureToolchain } from './toolchain.js';

export interface FlashScan {
  /** Presentation time of the first magenta frame. */
  start: number;
  /** Presentation time of the first non-magenta frame after the flash. */
  end: number;
}

const NEAR = 40;
const isMagenta = (px: Uint8Array, o: number) =>
  Math.abs(px[o]! - 255) <= NEAR && px[o + 1]! <= NEAR && Math.abs(px[o + 2]! - 255) <= NEAR;

export function runFfmpeg(ffmpeg: string, args: string[]): Promise<{ out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve({ out: Buffer.concat(out), err }) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`)),
    );
  });
}

/** Scans every frame (sampled on a 3x3 grid) for the #FF00FF flash marker. */
export async function scanFlash(file: string): Promise<FlashScan> {
  const { ffmpeg } = await ensureToolchain({ offline: true }).catch(() => ensureToolchain());
  const { out, err } = await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-i', file,
    '-vf', 'scale=3:3:flags=neighbor,showinfo',
    '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ]);
  const times = [...err.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const frames = Math.floor(out.length / 27);
  let start = -1;
  for (let i = 0; i < frames; i++) {
    const base = i * 27;
    let all = true;
    for (let p = 0; p < 9 && all; p++) all = isMagenta(out, base + p * 3);
    if (all && start < 0) start = i;
    if (!all && start >= 0) return { start: times[start]!, end: times[i]! };
  }
  if (start < 0) throw new Error(`no flash marker found in ${file}`);
  throw new Error(`flash marker never ends in ${file}`);
}

/** Presentation time (seconds) of the first magenta frame. */
export async function detectFlash(file: string): Promise<number> {
  return (await scanFlash(file)).start;
}

/** A run of near-uniform frames in a take, in source seconds (see `DEFAULTS.blank`). */
export interface BlankRange {
  /** Presentation time of the first blank frame. */
  start: number;
  /** Presentation time of the first good frame after the run (the file's end when none follows). */
  end: number;
  /** Presentation time of the last good frame before the run: the frame to freeze over it. */
  holdAt: number;
  /** Decode-order frame numbers in the file: the run's first and last blank frame, and the held frame. */
  frames?: { first: number; last: number; hold: number };
}

/** Luma standard deviation of one grey frame (one byte per cell). */
export function lumaStd(px: Uint8Array): number {
  let s = 0;
  let s2 = 0;
  for (const v of px) {
    s += v;
    s2 += v * v;
  }
  const m = s / px.length;
  return Math.sqrt(Math.max(0, s2 / px.length - m * m));
}

/**
 * Runs of blank frames at or after `from` (the first frame after the flash), from each frame's time and
 * luma standard deviation. A run with no good frame before it holds the first good frame after it.
 */
export function blankRanges(times: number[], stds: number[], from: number, max: number = DEFAULTS.blank.lumaStdMax): BlankRange[] {
  const out: BlankRange[] = [];
  let lastGood: number | undefined;
  let runStart: number | undefined;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (t < from - 1e-6) continue;
    const blank = stds[i]! <= max;
    if (blank && runStart === undefined) runStart = i;
    if (!blank) {
      if (runStart !== undefined) {
        const hold = lastGood ?? i;
        out.push({ start: times[runStart]!, end: t, holdAt: times[hold]!, frames: { first: runStart, last: i - 1, hold } });
      }
      runStart = undefined;
      lastGood = i;
    }
  }
  if (runStart !== undefined) {
    const last = times.at(-1)!;
    const end = last + (times.length > 1 ? last - times.at(-2)! : 1 / 25);
    const hold = lastGood ?? runStart;
    out.push({ start: times[runStart]!, end, holdAt: times[hold]!, frames: { first: runStart, last: times.length - 1, hold } });
  }
  return out;
}

/** Finds the runs of near-uniform frames (a blank page mid-navigation, say) at or after `from` seconds. */
export async function scanBlank(file: string, from: number): Promise<BlankRange[]> {
  const { ffmpeg } = await ensureToolchain({ offline: true }).catch(() => ensureToolchain());
  const { gridW: w, gridH: h } = DEFAULTS.blank;
  const { out, err } = await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-i', file,
    '-vf', `scale=${w}:${h}:flags=area,format=gray,showinfo`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-',
  ]);
  const times = [...err.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const size = w * h;
  const frames = Math.min(times.length, Math.floor(out.length / size));
  const stds: number[] = [];
  for (let i = 0; i < frames; i++) stds.push(lumaStd(out.subarray(i * size, (i + 1) * size)));
  return blankRanges(times.slice(0, frames), stds, from);
}

/**
 * Rewrites the take so each blank run shows its held frame instead (the last good frame before it, which is the frame
 * on screen at an action that started a navigation). Frame times are kept, so every logged time still applies. The
 * composer's decoder can show a frame up to a few output frames early, so retime alone cannot keep blank frames that
 * start right after an action out of the video; with them gone from the take, nothing can show them. Runs with no
 * good frame to hold are left (the audit fails them). Returns how many runs were frozen.
 */
export async function freezeBlankFrames(file: string, blanks: BlankRange[]): Promise<number> {
  const runs = blanks.filter((b) => b.frames && (b.frames.hold < b.frames.first || b.frames.hold > b.frames.last));
  if (!runs.length) return 0;
  const { ffmpeg } = await ensureToolchain({ offline: true }).catch(() => ensureToolchain());
  // freezeframes takes the replacement frame from its second input: a copy of the same stream.
  const graph = runs
    .map((b, i) => `[${i ? `v${i}` : '0:v:0'}]split[a${i}][b${i}];[a${i}][b${i}]freezeframes=first=${b.frames!.first}:last=${b.frames!.last}:replace=${b.frames!.hold}[v${i + 1}]`)
    .join(';');
  const tmp = `${file}.frozen${path.extname(file)}`;
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file,
    '-filter_complex', graph, '-map', `[v${runs.length}]`, '-fps_mode', 'passthrough',
    // Near-lossless VP8, like the recorder's own output (the composer re-encodes it anyway).
    '-c:v', 'libvpx', '-crf', '4', '-b:v', '40M', '-qmin', '0', '-qmax', '10', '-deadline', 'good', '-cpu-used', '4',
    tmp,
  ]);
  fs.renameSync(tmp, file);
  return runs.length;
}

/** Presentation time of every decodable video frame of `file`, in order (the showinfo filter, no frame-rate change). */
export async function frameTimes(file: string): Promise<number[]> {
  const { ffmpeg } = await ensureToolchain({ offline: true }).catch(() => ensureToolchain());
  const { err } = await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0',
    // Scaled to 2×2 first: showinfo checksums every frame, and only its time is wanted.
    '-vf', 'scale=2:2,showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-',
  ]);
  return [...err.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
}

/**
 * Presentation time of the last decodable video frame of `file`: the last moment a take can show. Measured by
 * decoding the frames, not read from the container's duration (which runs a frame or more past it).
 */
export async function lastFrameTime(file: string): Promise<number> {
  const times = await frameTimes(file);
  if (!times.length) throw new Error(`no video frames in ${file}`);
  return times.reduce((a, b) => Math.max(a, b));
}
