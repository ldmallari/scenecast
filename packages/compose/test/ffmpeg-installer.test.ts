// @ffmpeg-installer/ffmpeg is replaced by a local stand-in (pnpm override): no ffmpeg binary is downloaded,
// and Revideo's default ffmpeg path is the toolchain's.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
/** Requires modules as @revideo/ffmpeg sees them. */
const revideoFfmpegRequire = () => createRequire(createRequire(require.resolve('@revideo/renderer')).resolve('@revideo/ffmpeg'));

describe('@ffmpeg-installer/ffmpeg stand-in', () => {
  it('is the local stub, not the downloaded package', () => {
    const resolved = fs.realpathSync(revideoFfmpegRequire().resolve('@ffmpeg-installer/ffmpeg'));
    expect(resolved).toBe(path.join(REPO, 'stubs', 'ffmpeg-installer', 'index.js'));
    // The real package (and its per-platform ffmpeg binaries) is not what Revideo gets.
    expect(fs.readFileSync(resolved, 'utf8')).toContain('scenecast stand-in');
  });

  it('points at FFMPEG_PATH when set, else at an ffmpeg that runs', () => {
    const stub = revideoFfmpegRequire()('@ffmpeg-installer/ffmpeg') as { path: string; version: string };
    const prev = process.env.FFMPEG_PATH;
    try {
      process.env.FFMPEG_PATH = '/some/ffmpeg';
      expect(stub.path).toBe('/some/ffmpeg');
      delete process.env.FFMPEG_PATH;
      expect(stub.path).not.toBe('/some/ffmpeg');
      // Once the Python environment exists (scenecast doctor), that is imageio-ffmpeg's binary.
      if (fs.existsSync(path.join(REPO, 'py', '.venv'))) {
        expect(stub.path).toContain(`${path.sep}imageio_ffmpeg${path.sep}`);
        expect(stub.version).not.toBe('unknown');
      }
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  });
});
