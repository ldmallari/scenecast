# Before publishing

A checklist for the maintainer. Work through it before the repository is made public. Each item is open until it is
ticked.

- [ ] **Employer sign-off.** Get the employer's sign-off to publish this personal project.
- [ ] **Fresh history.** Publish from a fresh root commit (squash the branch into one commit), because earlier history
      contains internal design docs. Before pushing, search the
      new history once more for employer, product or person names and for absolute local paths.
- [ ] **kokoro-onnx copyright line.** `THIRD_PARTY.md` quotes the MIT licence for the code that follows kokoro-onnx
      as "Copyright (c) the kokoro-onnx authors". Replace that line with the exact copyright line from
      https://github.com/thewh1teagle/kokoro-onnx/blob/main/LICENSE.
- [ ] **NLTK tagger data licence.** `scenecast doctor` downloads `averaged_perceptron_tagger` and
      `averaged_perceptron_tagger_eng` from the NLTK data project, and the download states no licence. Find the
      licence (https://github.com/nltk/nltk_data) and record it in `THIRD_PARTY.md`, or replace the data.
- [ ] **num2words LGPL version.** The installed metadata says only "LGPL" and the wheel carries no licence file.
      Confirm the exact version from the project (https://github.com/savoirfairelinux/num2words) and update
      `THIRD_PARTY.md`.
- [ ] **Linux review.** `node scripts/check-licences.mjs` passed on macOS arm64 and on Linux x86_64 (WSL, 2026-10-26).
      Run it in CI on Linux too (after `scenecast doctor`), and review what the metadata check cannot see: the
      native libraries bundled inside Linux wheels (`ctranslate2`, `onnxruntime`, `soundfile`, `av`), and the
      linux-arm64 platform builds (rolldown, lightningcss, ffprobe). Add reviewed overrides or `THIRD_PARTY.md` rows
      as needed.
