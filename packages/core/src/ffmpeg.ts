import { spawn } from 'node:child_process';
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

function runFfmpeg(ffmpeg: string, args: string[]): Promise<{ out: Buffer; err: string }> {
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
