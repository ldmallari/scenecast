import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureToolchain, findUv, runPy, uvEnv } from '../src/toolchain.js';

function tmpCache(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-cache-'));
}

describe('toolchain', () => {
  it('doctor reports missing models', async () => {
    const prev = process.env.SCENECAST_CACHE;
    process.env.SCENECAST_CACHE = tmpCache();
    try {
      await expect(ensureToolchain({ offline: true })).rejects.toThrow(
        /3 missing[\s\S]*kokoro-v1\.0\.onnx[\s\S]*voices-v1\.0\.bin[\s\S]*whisper/,
      );
    } finally {
      if (prev === undefined) delete process.env.SCENECAST_CACHE;
      else process.env.SCENECAST_CACHE = prev;
    }
  });

  it('runPy rejects invalid module names', async () => {
    await expect(runPy('os; rm -rf /', [])).rejects.toThrow('invalid python module name "os; rm -rf /"');
    await expect(runPy('--help', [])).rejects.toThrow('invalid python module name "--help"');
  });

  it.skipIf(!findUv())('runPy failure names the module', async () => {
    await expect(runPy('scenecast_py._selftest_fail', [])).rejects.toThrow(/scenecast_py\._selftest_fail/);
  }, 300_000);

  it.skipIf(!findUv())('resolves ffmpeg path', () => {
    const uv = findUv()!;
    const py = path.resolve(import.meta.dirname, '../../../py');
    const out = execFileSync(
      uv,
      ['run', '--project', py, 'python', '-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8', env: uvEnv() },
    ).trim();
    expect(fs.existsSync(out)).toBe(true);
  }, 300_000);
});

describe.skipIf(!process.env.SCENECAST_E2E)('toolchain e2e (real download)', () => {
  it('ensureToolchain resolves everything', async () => {
    const tc = await ensureToolchain();
    console.log(JSON.stringify(tc, null, 2));
    const code =
      'import sys, onnxruntime as ort; ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"]); print("session ok")';
    const out = execFileSync(
      findUv()!,
      ['run', '--project', path.resolve(import.meta.dirname, '../../../py'), 'python', '-c', code, tc.models.kokoro],
      { encoding: 'utf8', env: uvEnv() },
    );
    expect(out).toContain('session ok');
    for (const p of [tc.python, tc.ffmpeg, tc.models.kokoro, tc.models.voices, tc.models.whisper]) {
      expect(fs.existsSync(p)).toBe(true);
    }
  }, 1_800_000);
});
