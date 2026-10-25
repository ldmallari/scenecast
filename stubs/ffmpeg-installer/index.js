// scenecast stand-in for @ffmpeg-installer/ffmpeg (wired in by the pnpm override in pnpm-workspace.yaml).
//
// Revideo's @revideo/ffmpeg requires @ffmpeg-installer/ffmpeg for a default ffmpeg path. The real package
// downloads a prebuilt ffmpeg for each platform (GPL, and on macOS arm64 also non-free, builds). scenecast
// never runs that binary: it always gives Revideo the toolchain ffmpeg. This stand-in exports the same
// `{ path, version, url }` shape, pointing at the toolchain ffmpeg, and downloads nothing.
//
// `path` is looked up when read, in this order: FFMPEG_PATH (set by scenecast's render worker and preview),
// IMAGEIO_FFMPEG_EXE, the ffmpeg bundled with imageio-ffmpeg in the repository's Python environment
// (py/.venv), then plain `ffmpeg` on PATH.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

function venvFfmpeg() {
  const lib = path.join(REPO, 'py', '.venv', 'lib');
  let pythons = [];
  try {
    pythons = fs.readdirSync(lib).filter((d) => d.startsWith('python'));
  } catch {
    return undefined;
  }
  for (const py of pythons) {
    const dir = path.join(lib, py, 'site-packages', 'imageio_ffmpeg', 'binaries');
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const exe = names.find((n) => n.startsWith('ffmpeg-'));
    if (exe) return path.join(dir, exe);
  }
  return undefined;
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || process.env.IMAGEIO_FFMPEG_EXE || venvFfmpeg() || 'ffmpeg';
}

module.exports = {
  get path() {
    return ffmpegPath();
  },
  get version() {
    try {
      const first = execFileSync(ffmpegPath(), ['-hide_banner', '-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0];
      return (/version (\S+)/.exec(first) || [])[1] || 'unknown';
    } catch {
      return 'unknown';
    }
  },
  url: 'https://ffmpeg.org/',
};
