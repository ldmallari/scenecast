# Before publishing

GitHub Pages: after making the repository public, enable Pages with source GitHub Actions; the pages workflow publishes site/.

A checklist for the maintainer. Work through it before the repository is made public. Each item is open until it is
ticked.

- [x] **Clean history.** Every commit was searched for employer, product or person names and for absolute local paths
      (2026-10-27). Search again before making the repository public.
- [x] **kokoro-onnx copyright line.** `THIRD_PARTY.md` quotes the exact line from the kokoro-onnx LICENSE.
- [x] **NLTK tagger data licence.** MIT, per the NLTK data index; recorded in `THIRD_PARTY.md`.
- [x] **num2words licence.** LGPL-2.1, per the project's COPYING file; recorded in `THIRD_PARTY.md`.
- [x] **Linux review.** `node scripts/check-licences.mjs` passes on macOS arm64 and on Linux x86_64 (WSL, 2026-10-27),
      and runs in CI on Linux after `scenecast doctor` (`.github/workflows/e2e.yml`). What the metadata check cannot
      see was reviewed by hand (2026-10-27): every native library bundled in the Linux x86_64 wheels, the linux-arm64
      npm platform builds (rolldown, lightningcss, ffprobe) and the ffmpeg/ffprobe builds. Results are in
      `THIRD_PARTY.md` ("Native libraries inside Python wheels", "Tools run as separate programs"). Nothing GPL-only is
      installed: the `av` wheel (GPL x264/x265) is kept out by a uv override, and scenecast stubs its import. Review again when a wheel or
      platform package version changes.
