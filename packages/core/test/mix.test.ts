import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mix, measureLufs } from '../src/mix.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import { ensureToolchain, findUv, runPy } from '../src/toolchain.js';
import { parseScene } from '../src/scene/load.js';

const base = {
  id: 'v', title: 'v', output: 'o.mp4',
  brand: { primary: '#000', accent: '#fff', font: 'F', introTitle: 'v' },
  app: { baseUrl: 'http://x' },
  scenes: [{ id: 's1', kind: 'title', page: 'p.html', seconds: 1, narration: 'Hi.' }],
};

let dir: string;
let ffmpeg: string;
let video: string;
let voice: string;
let pad: string;

const stream = async (file: string) =>
  (await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-f', 'null', '-']).catch((e) => ({ err: String(e) }))).err;

beforeAll(async () => {
  ffmpeg = (await ensureToolchain({ offline: true }).catch(() => ensureToolchain())).ffmpeg;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-mixtest-'));
  video = path.join(dir, 'in.mp4');
  voice = path.join(dir, 'voice.wav');
  pad = path.join(dir, 'pad.wav');
  // Silent 10 s video carrying BT.709 tags in a colr box, like the composer writes.
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180:r=30:d=10',
    '-vf', 'format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
    '-c:v', 'libx264', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-color_range', 'tv', '-movflags', '+faststart+write_colr', video,
  ]);
  // Voice-like: a 140 Hz buzz with harmonics, gated into 0.5 s "syllables", quiet on purpose.
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-t', '10', '-i',
    "aevalsrc='0.05*(sin(2*PI*140*t)+0.5*sin(2*PI*280*t)+0.3*sin(2*PI*420*t))*(0.5+0.5*sin(2*PI*2*t))*lt(mod(t,2.5),1.9)':s=24000:c=mono",
    voice,
  ]);
  // A 4 s pad: shorter than the video, so the mix must loop it.
  await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-t', '4', '-i', 'sine=f=196:r=48000', '-ac', '2', pad]);
}, 120_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('mix', () => {
  it('final mix measures -16 +-1 LUFS', async () => {
    const out = path.join(dir, 'out.mp4');
    const { lufs } = await mix(video, voice, pad, out);
    expect(lufs).toBeGreaterThanOrEqual(-17);
    expect(lufs).toBeLessThanOrEqual(-15);
    // The returned figure matches an independent ebur128 pass on the file.
    expect(await measureLufs(out, ffmpeg)).toBeCloseTo(lufs, 5);
    const info = await stream(out);
    expect(info).toMatch(/Duration: 00:00:10\.0/);
    expect(info).toMatch(/Audio: aac.*48000 Hz, stereo/);
  }, 120_000);

  it('copies the video stream and keeps its colour tags', async () => {
    const out = path.join(dir, 'out-colour.mp4');
    await mix(video, voice, null, out);
    const info = await stream(out);
    const tags = (text: string) => /Video: h264[^\n]*?(yuv420p\([^)]*\))/.exec(text)?.[1];
    expect(tags(info)).toBe('yuv420p(tv, bt709, progressive)'); // ffmpeg prints one name when space, primaries and trc all match
    expect(tags(info)).toBe(tags(await stream(video)));
    expect(info).toMatch(/320x180/);
    const colr = fs.readFileSync(out).indexOf('colr');
    expect(colr).toBeGreaterThan(0);
    expect(fs.readFileSync(out).subarray(colr + 4, colr + 8).toString()).toBe('nclx');
  }, 120_000);

  it('voice-only mix (no music) also lands on -16 +-1 LUFS', async () => {
    const { lufs } = await mix(video, voice, null, path.join(dir, 'voice-only.mp4'));
    expect(Math.abs(lufs + 16)).toBeLessThanOrEqual(1);
  }, 120_000);

  it('ducks the music under the voice', async () => {
    // Voice is silent in 1.9-2.5 s of each 2.5 s cycle; music alone there is louder than under speech.
    const out = path.join(dir, 'duck.mp4');
    await mix(video, voice, pad, out);
    const win = async (from: number, len: number) => {
      const wav = path.join(dir, `win-${from}.wav`);
      await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', String(from), '-t', String(len), '-i', out, '-vn', wav]);
      return measureLufs(wav, ffmpeg);
    };
    const music = await win(2.1, 0.3);
    expect(music).toBeLessThan(-18); // the bed alone, well under the voice
    expect(await win(0.3, 1.4)).toBeGreaterThan(music + 6);
  }, 120_000);

  it.skipIf(!findUv())('mixes the synthesised pad, longer than the video (trimmed)', async () => {
    const long = path.join(dir, 'long.wav');
    await runPy('scenecast_py.music', ['--seconds', '20', '--out', long, '--seed', '3']);
    const { lufs } = await mix(video, voice, long, path.join(dir, 'long.mp4'));
    expect(Math.abs(lufs + 16)).toBeLessThanOrEqual(1);
    expect(await stream(path.join(dir, 'long.mp4'))).toMatch(/Duration: 00:00:10\.0/);
  }, 300_000);
});

describe('brand.music', () => {
  it('user track without licence is rejected', () => {
    const brand = (music: unknown) => ({ ...base, brand: { ...base.brand, music } });
    expect(() => parseScene(brand({ file: 'a.wav' }))).toThrow(/licence/);
    expect(() => parseScene(brand({ file: 'a.wav', licence: '   ' }))).toThrow(/licence is required/);
    expect(parseScene(brand({ file: 'a.wav', licence: 'CC0' })).brand.music?.licence).toBe('CC0');
  });
});
