import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mix, measureLufs } from '../src/mix.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import { ensureToolchain, findUv, runPy } from '../src/toolchain.js';
import { parseScene, loadScene } from '../src/scene/load.js';

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
  // Voice-like: a 140 Hz buzz with a harmonic (all below 300 Hz), speaking 0-2.5 s of every 5 s, quiet on purpose.
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-t', '10', '-i',
    "aevalsrc='0.05*(sin(2*PI*140*t)+0.5*sin(2*PI*280*t))*(0.5+0.5*sin(2*PI*2*t))*lt(mod(t,5),2.5)':s=24000:c=mono",
    voice,
  ]);
  // A 4 s bed tone at 2 kHz (far above the voice, so a high-pass isolates it): shorter than the video, so the mix must loop it.
  await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-t', '4', '-i', 'sine=f=2000:r=48000', '-ac', '2', pad]);
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
    // Isolate the 2 kHz bed with a steep high-pass and measure it while the voice speaks (0.3-2.3 s).
    const bedDuringSpeech = async (file: string) => {
      const wav = path.join(dir, `bed-${path.basename(file)}.wav`);
      await runFfmpeg(ffmpeg, [
        '-hide_banner', '-nostdin', '-y', '-ss', '0.3', '-t', '2', '-i', file, '-vn',
        '-af', 'highpass=f=1500,highpass=f=1500,highpass=f=1500', wav,
      ]);
      return measureLufs(wav, ffmpeg);
    };
    const ducked = path.join(dir, 'ducked.mp4');
    const open = path.join(dir, 'unducked.mp4');
    await mix(video, voice, pad, ducked);
    await mix(video, voice, pad, open, { duck: false });
    const d = await bedDuringSpeech(ducked);
    const u = await bedDuringSpeech(open);
    expect(u).toBeGreaterThan(-60); // the window really holds the bed (ebur128 reads -70 for empty windows)
    expect(u - d).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('keeps the true peak at or under -1.5 dBTP on a peaky voice', async () => {
    const peaky = path.join(dir, 'peaky.wav');
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-t', '10', '-i',
      "aevalsrc='0.1*sin(2*PI*180*t)*lt(mod(t,5),2.5)+0.5*sin(2*PI*3000*t)*lt(mod(t,0.7),0.002)':s=24000:c=mono",
      peaky,
    ]);
    for (const m of [null, pad]) {
      const r = await mix(video, peaky, m, path.join(dir, `peaky-${m ? 'music' : 'none'}.mp4`));
      expect(r.truePeak).toBeLessThanOrEqual(-1.5);
      expect(Math.abs(r.lufs + 16)).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it('voice length: over tolerance throws, within tolerance trims, shorter is padded', async () => {
    const cut = async (name: string, seconds: number) => {
      const f = path.join(dir, name);
      await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', voice, '-af', 'apad', '-t', String(seconds), f]);
      return f;
    };
    await expect(mix(video, await cut('v-long.wav', 10.5), null, path.join(dir, 'l.mp4'))).rejects.toThrow(
      /voice \(10\.5\d? s\) is longer than the video \(10\.0\d? s\)/,
    );
    await mix(video, await cut('v-near.wav', 10.05), null, path.join(dir, 'near.mp4'));
    expect(await stream(path.join(dir, 'near.mp4'))).toMatch(/Duration: 00:00:10\.0/);
    await mix(video, await cut('v-short.wav', 6), pad, path.join(dir, 'short.mp4'));
    expect(await stream(path.join(dir, 'short.mp4'))).toMatch(/Duration: 00:00:10\.0/);
  }, 120_000);

  it('fails early on missing inputs', async () => {
    await expect(mix(video, voice, path.join(dir, 'nope.wav'), path.join(dir, 'x.mp4'))).rejects.toThrow(/music file not found: .*nope\.wav/);
    await expect(mix(video, path.join(dir, 'nope.wav'), null, path.join(dir, 'x.mp4'))).rejects.toThrow(/voice file not found/);
  });

  it.skipIf(!findUv())('mixes the synthesised pad, longer than the video (trimmed)', async () => {
    const long = path.join(dir, 'long.wav');
    await runPy('scenecast_py.music', ['--seconds', '20', '--out', long, '--seed', '3']);
    const { lufs } = await mix(video, voice, long, path.join(dir, 'long.mp4'));
    expect(Math.abs(lufs + 16)).toBeLessThanOrEqual(1);
    expect(await stream(path.join(dir, 'long.mp4'))).toMatch(/Duration: 00:00:10\.0/);
  }, 300_000);
});

describe('brand.music', () => {
  it('loadScene rejects a music file that does not exist, resolved against the scene file', async () => {
    const scene = { ...base, brand: { ...base.brand, music: { file: 'bed.wav', licence: 'CC0' } } };
    const file = path.join(dir, 'scene.json');
    fs.writeFileSync(file, JSON.stringify(scene));
    await expect(loadScene(file)).rejects.toThrow(`brand.music.file not found: ${path.join(dir, 'bed.wav')}`);
    fs.copyFileSync(pad, path.join(dir, 'bed.wav'));
    expect((await loadScene(file)).brand.music?.file).toBe(path.join(dir, 'bed.wav'));
  });

  it('user track without licence is rejected', () => {
    const brand = (music: unknown) => ({ ...base, brand: { ...base.brand, music } });
    expect(() => parseScene(brand({ file: 'a.wav' }))).toThrow(/licence/);
    expect(() => parseScene(brand({ file: 'a.wav', licence: '   ' }))).toThrow(/licence is required/);
    expect(parseScene(brand({ file: 'a.wav', licence: 'CC0' })).brand.music?.licence).toBe('CC0');
  });
});
