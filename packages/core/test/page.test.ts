import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureToolchain } from '../src/toolchain.js';
import { renderCardPage } from '../src/record/page.js';

const run = promisify(execFile);
const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('renderCardPage', () => {
  let dir: string;
  let ffmpeg: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-page-'));
    ffmpeg = (await ensureToolchain({ offline: true }).catch(() => ensureToolchain())).ffmpeg;
  }, 120_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pixel = async (file: string, x: number, y: number) => {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    return [...stdout.subarray(0, 3)];
  };
  const near = (got: number[], want: number[], tol: number) => got.every((c, i) => Math.abs(c - want[i]!) <= tol);

  it('renderCardPage draws the page with the brand variables', async () => {
    const out = path.join(dir, 'card.png');
    const got = await renderCardPage(fx('card-page.html'), out, { primary: '#1F3A5F', accent: '#F5C518', font: 'Inter', cardFont: 'Lora' });
    expect(got).toBe(out);
    const probe = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', out]).catch((e: { stderr: string }) => ({ stderr: e.stderr }));
    expect(probe.stderr).toMatch(/1920x1080/);
    // The brand primary wins over the page's own :root fallback.
    const centre = await pixel(out, 960, 540);
    expect(near(centre, [31, 58, 95], 1), `centre ${centre}`).toBe(true);
    const accent = await pixel(out, 20, 20);
    expect(near(accent, [0xf5, 0xc5, 0x18], 1), `accent ${accent}`).toBe(true);
    // The page's own script already saw the (quoted) font variables.
    const seen = await pixel(out, 1900, 20);
    expect(near(seen, [0, 255, 0], 1), `script saw the variables: ${seen}`).toBe(true);
  }, 60_000);

  it('a missing page fails clearly', async () => {
    await expect(renderCardPage(path.join(dir, 'nope.html'), path.join(dir, 'x.png'), { primary: '#000', accent: '#fff', font: 'A', cardFont: 'B' }))
      .rejects.toThrow(/card page not found/);
  });
});
