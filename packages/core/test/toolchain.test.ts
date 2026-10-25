import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureToolchain, findUv, runPy, uvEnv, whisperDownloadArgs } from '../src/toolchain.js';

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

describe.skipIf(!findUv())('whisper model download (doctor)', () => {
  it('puts the PyAV stub in place before faster_whisper loads', () => {
    // A stand-in faster_whisper, first on the path, records what `av` is when it is imported and constructed.
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-fakefw-'));
    const out = path.join(fake, 'seen.txt');
    fs.mkdirSync(path.join(fake, 'faster_whisper'));
    fs.writeFileSync(
      path.join(fake, 'faster_whisper', '__init__.py'),
      [
        'import sys, av',
        'class WhisperModel:',
        '    def __init__(self, name, download_root=None, **kw):',
        `        open(${JSON.stringify(out)}, "w").write("%s %s %s" % (name, download_root, getattr(sys.modules["av"], "SCENECAST_STUB", False)))`,
        '',
      ].join('\n'),
    );
    const py = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../py');
    execFileSync(findUv()!, whisperDownloadArgs(py, 'small.en', '/models/whisper'), { env: { ...uvEnv(), PYTHONPATH: fake }, stdio: 'pipe' });
    expect(fs.readFileSync(out, 'utf8')).toBe('small.en /models/whisper True');
  }, 120_000);
});
