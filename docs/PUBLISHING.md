# Before publishing

A checklist for the maintainer. Work through it before the repository is made public. Each item is open until it is
ticked.

- [x] **Clean history.** Every commit was searched for employer, product or person names and for absolute local paths
      (2026-10-27). Search again before making the repository public.
- [x] **kokoro-onnx copyright line.** `THIRD_PARTY.md` quotes the exact line from the kokoro-onnx LICENSE.
- [x] **NLTK tagger data licence.** MIT, per the NLTK data index; recorded in `THIRD_PARTY.md`.
- [x] **num2words licence.** LGPL-2.1, per the project's COPYING file; recorded in `THIRD_PARTY.md`.
- [ ] **Linux review.** `node scripts/check-licences.mjs` passed on macOS arm64 and on Linux x86_64 (WSL, 2026-10-26).
      Run it in CI on Linux too (after `scenecast doctor`), and review what the metadata check cannot see: the
      native libraries bundled inside Linux wheels (`ctranslate2`, `onnxruntime`, `soundfile`, `av`), and the
      linux-arm64 platform builds (rolldown, lightningcss, ffprobe). Add reviewed overrides or `THIRD_PARTY.md` rows
      as needed.
