import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './scene/schema.js';
import { runFfmpeg } from './ffmpeg.js';
import { ensureToolchain } from './toolchain.js';

const L = DEFAULTS.loudness;
const SAMPLE_RATE = 48000;
/** Sidechain: speech at the voice target sits ~DUCK_HEADROOM_DB above the threshold; with this ratio that is a `duckDb` cut. */
const DUCK_RATIO = 4;
const DUCK_HEADROOM_DB = (L.duckDb * DUCK_RATIO) / (DUCK_RATIO - 1);
const DUCK_SPEECH_LEVEL_DB = L.voiceLufs - 8; // short-term level of speech peaks-to-body in the sidechain, dBFS
const DUCK_THRESHOLD = 10 ** ((DUCK_SPEECH_LEVEL_DB - DUCK_HEADROOM_DB) / 20);
const STEREO = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

async function ffmpegPath(): Promise<string> {
  return (await ensureToolchain({ offline: true }).catch(() => ensureToolchain())).ffmpeg;
}

/** Integrated loudness (LUFS) of a file's audio, from a separate ebur128 pass. */
export async function measureLufs(file: string, ffmpeg?: string): Promise<number> {
  const bin = ffmpeg ?? (await ffmpegPath());
  const { err } = await runFfmpeg(bin, ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-']);
  const hits = [...err.matchAll(/^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS/gm)];
  const last = hits.at(-1);
  if (!last) throw new Error(`could not read integrated loudness of ${file}`);
  return Number(last[1]);
}

async function durationOf(ffmpeg: string, file: string): Promise<number> {
  const { err } = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-f', 'null', '-']);
  const times = [...err.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  if (!last) throw new Error(`could not read duration of ${file}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

interface LoudnormStats {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

async function measureLoudnorm(ffmpeg: string, file: string): Promise<LoudnormStats> {
  const { err } = await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-i', file, '-vn',
    '-af', `loudnorm=I=${L.voiceLufs}:TP=${L.truePeakDb}:LRA=11:print_format=json`, '-f', 'null', '-',
  ]);
  const json = err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1);
  return JSON.parse(json) as LoudnormStats;
}

/** Linear loudnorm (second pass) filter that lands on `target` LUFS. */
function loudnormFilter(s: LoudnormStats, target: number): string {
  return (
    `loudnorm=I=${target}:TP=${L.truePeakDb}:LRA=11:measured_I=${s.input_i}:measured_TP=${s.input_tp}` +
    `:measured_LRA=${s.input_lra}:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true`
  );
}

/**
 * Adds the only audio the video gets: voice (one WAV covering the whole timeline) plus an optional music bed
 * at -29 LUFS that ducks 6 dB under the voice, normalised to -16 LUFS / TP -1.5. The video stream is copied.
 * Returns the measured integrated loudness of the written file.
 */
export async function mix(
  videoIn: string,
  voiceWav: string,
  musicWav: string | null,
  out: string,
): Promise<{ lufs: number }> {
  const ffmpeg = await ffmpegPath();
  const dur = await durationOf(ffmpeg, videoIn);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-mix-'));
  try {
    const premix = path.join(work, 'premix.wav');
    const common = ['-hide_banner', '-nostdin', '-y'];
    const t = dur.toFixed(3);

    if (musicWav === null) {
      await runFfmpeg(ffmpeg, [
        ...common, '-i', voiceWav,
        '-af', `${STEREO},apad,atrim=0:${t}`, '-c:a', 'pcm_f32le', premix,
      ]);
    } else {
      // Bring the voice to its target and the music to the bed level first, so the duck depth is predictable.
      const voiceGain = L.voiceLufs - (await measureLufs(voiceWav, ffmpeg));
      const musicGain = L.musicLufs - (await measureLufs(musicWav, ffmpeg));
      if (!Number.isFinite(voiceGain)) throw new Error(`voice track ${voiceWav} is silent`);
      if (!Number.isFinite(musicGain)) throw new Error(`music track ${musicWav} is silent`);
      const fade = Math.min(L.musicFadeSec, dur / 2);
      const graph = [
        `[0:a]${STEREO},apad,atrim=0:${t},volume=${voiceGain.toFixed(3)}dB,asplit=2[v][sc]`,
        `[1:a]${STEREO},atrim=0:${t},asetpts=N/SR/TB,volume=${musicGain.toFixed(3)}dB,` +
          `afade=t=in:st=0:d=${fade},afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade}[m]`,
        `[m][sc]sidechaincompress=threshold=${DUCK_THRESHOLD.toFixed(5)}:ratio=${DUCK_RATIO}:attack=40:release=400:makeup=1[ducked]`,
        `[v][ducked]amix=inputs=2:duration=longest:normalize=0[mixed]`,
      ].join(';');
      await runFfmpeg(ffmpeg, [
        ...common, '-i', voiceWav, '-stream_loop', '-1', '-i', musicWav,
        '-filter_complex', graph, '-map', '[mixed]', '-t', t, '-c:a', 'pcm_f32le', premix,
      ]);
    }

    const stats = await measureLoudnorm(ffmpeg, premix);
    await runFfmpeg(ffmpeg, [
      ...common, '-i', videoIn, '-i', premix,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
      '-af', `${loudnormFilter(stats, L.voiceLufs)},aresample=${SAMPLE_RATE}`,
      '-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE), '-ac', '2',
      '-t', t, '-movflags', '+faststart', out,
    ]);
    return { lufs: await measureLufs(out, ffmpeg) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
