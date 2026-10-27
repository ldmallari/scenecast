# Third-party software

scenecast itself is MIT-licensed (see [LICENSE](LICENSE)). It is built on the open-source projects, models and
tools listed here. Every one is free to use; none needs an account, a key or a paid plan.

## How this list is checked

`node scripts/check-licences.mjs` reads every production dependency, npm packages from
`pnpm licenses list --prod --json` and Python packages from `uv pip list` of the `py/` environment (narrowed to the
production set in `py/uv.lock`), and fails when one of them:

- carries a licence that is not on the allow-list: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, LGPL (any
  version), MPL-2.0, Python-2.0, 0BSD, CC0-1.0. In an SPDX expression an `OR` passes when any branch is allowed and
  an `AND` only when every part is;
- states no licence its metadata can be read from (empty, `UNKNOWN`, a URL, an ambiguous "BSD"), unless
  `scripts/licence-overrides.json` holds a reviewed entry naming the licence, a source, the reason and the metadata
  text it reviewed (when the package's metadata later changes, the entry stops applying and the check fails);
- is missing from the tables below.

Bundled fonts (see below) are checked the same way, against the font licence OFL-1.1, which is accepted for fonts
only.

A few permissive licences outside the allow-list (MIT-0, MIT-CMU, Zlib, PSF-2.0, CNRI-Python) pass only through a
reviewed override, never on metadata alone. A tool binary that scenecast runs as a separate program passes only through
an override marked `tool`. The test suite runs the check on fixtures and, once `scenecast doctor`
has set up the Python environment, on the real tree.

## Models and data

Downloaded by `scenecast doctor` into `~/.cache/scenecast/` (never committed, never bundled).

| Item | Licence | Source |
|---|---|---|
| Kokoro-82M text-to-speech model (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) | Apache-2.0 | https://huggingface.co/hexgrad/Kokoro-82M (ONNX export and voice pack from the kokoro-onnx `model-files-v1.0` release: https://github.com/thewh1teagle/kokoro-onnx) |
| Whisper `small.en` speech recognition model | MIT | https://github.com/openai/whisper |
| faster-whisper conversion of it (`Systran/faster-whisper-small.en`) | MIT | https://huggingface.co/Systran/faster-whisper-small.en |
| Silero VAD model (`silero_vad_v6.onnx`, shipped inside the faster-whisper package, not downloaded); finds where speech starts before forced alignment | MIT | https://github.com/snakers4/silero-vad |
| spaCy `en_core_web_sm` 3.8.0 (installed as a Python package) | MIT | https://github.com/explosion/spacy-models |
| CMU Pronouncing Dictionary (NLTK data `cmudict`) | BSD-2-Clause-style (the licence is in its README) | https://github.com/cmusphinx/cmudict |
| NLTK averaged perceptron tagger (NLTK data `averaged_perceptron_tagger`, `averaged_perceptron_tagger_eng`) | MIT (per the NLTK data index; trained by the textblob-aptagger project) | https://github.com/nltk/nltk_data, https://github.com/sloria/textblob-aptagger |

## Bundled fonts

Shipped in `packages/compose/fonts/` (listed in its `fonts.json`, with each file's SHA-256) so captions and cards
render in the same typeface on every machine, offline. The check above reads `fonts.json`: each font must carry a
font licence (SIL OFL 1.1) and ship with its licence text.

| Font | Licence | Source |
|---|---|---|
| `Inter` 4.1 (`InterVariable.woff2`, licence in `Inter-OFL.txt`) | OFL-1.1 | https://github.com/rsms/inter/releases/tag/v4.1 |

## Code derived from other projects

`py/scenecast_py/kokoro.py` is a small Kokoro inference wrapper written for scenecast (the kokoro-onnx package itself
is not used, because it depends on GPL packages). It contains:

- the phoneme vocabulary, copied from the `vocab` table of hexgrad/Kokoro-82M `config.json`
  (Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M);
- token padding and per-length style selection that follow thewh1teagle/kokoro-onnx
  (MIT, https://github.com/thewh1teagle/kokoro-onnx).

The kokoro-onnx part is used under the MIT licence:

> Copyright (c) 2025 github.com/thewh1teagle
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Tools run as separate programs

scenecast starts these as separate processes. It never links them into its own code, so their licences, including
the GPL of the ffmpeg builds, apply to those binaries only.

| Tool | Licence | Source | How scenecast uses it |
|---|---|---|---|
| ffmpeg bundled with `imageio-ffmpeg` | macOS arm64: a GPL-2.0-or-later build (`--enable-gpl`, with libx264). Linux x86_64 and arm64: a GPL-3.0-or-later static build of ffmpeg 7.0.2 from johnvansickle.com (`--enable-gpl --enable-version3`, with libx264; checked 2026-10-27) | https://ffmpeg.org/legal.html, https://github.com/imageio/imageio-ffmpeg | The toolchain ffmpeg: encoding, mixing, loudness, frame extraction. Run as a subprocess. |
| ffprobe from `@ffprobe-installer/*` (one build per platform) | darwin-arm64: LGPL-2.1 (an LGPL build, checked). darwin-x64 and the Linux builds: GPL-3.0 (static builds; npm registry metadata, 2026-10-25; the linux-x64 and linux-arm64 binaries are johnvansickle.com builds configured `--enable-gpl --enable-version3`, checked 2026-10-27) | https://github.com/SavageCore/node-ffprobe-installer | Run by Revideo to read media (`FFPROBE_PATH`). |
| `@ffmpeg-installer/ffmpeg` | not installed | https://github.com/kribblo/node-ffmpeg-installer | `@revideo/ffmpeg` asks for it. A pnpm override replaces it with `stubs/ffmpeg-installer`, a small stand-in (MIT, part of this repository) that points at the toolchain ffmpeg, so no ffmpeg binary is downloaded with the npm packages. |
| Chromium (Playwright's build) | BSD-3-Clause, with third-party parts under their own licences | https://playwright.dev, https://www.chromium.org | Records the app and renders the composition. Installed with `pnpm -C packages/cli exec playwright install chromium`. |
| uv | MIT OR Apache-2.0 | https://github.com/astral-sh/uv | Manages the Python environment. `scenecast doctor` installs it into your home folder if it is missing. |

## Native libraries inside Python wheels

`check-licences.mjs` reads package metadata only, so the native libraries that wheels bundle (in `<package>.libs/`,
or next to the package's own code) were reviewed by hand on Linux x86_64 (WSL, Python 3.12, 2026-10-27): every
shared library in `site-packages` was listed, its links read with `ldd`, its version read from the library, and its
licence taken from the wheel's licence files, SBOM or upstream build script. scenecast never redistributes these
wheels: `scenecast doctor` has uv install them from PyPI into `py/.venv`.

None of the libraries scenecast loads is GPL-only. The GCC runtime libraries carry the GCC Runtime Library Exception,
which allows linking them into code under any licence. The `av` (PyAV) wheel, which bundles GPL x264 and x265, is not
installed at all; see the note below the table.

| Wheel | Bundled library | Licence | Verdict |
|---|---|---|---|
| soundfile 0.14.0 | libsndfile 1.2.2 (`_soundfile_data/libsndfile_x86_64.so`, loaded with cffi; built by bastibe/libsndfile-binaries) | LGPL-2.1-or-later | OK: LGPL, loaded as a separate shared library |
| soundfile | linked statically into that libsndfile: libogg, libvorbis 1.3.7, libFLAC 1.4.3, libopus 1.4 | BSD-3-Clause | OK |
| soundfile | linked statically into that libsndfile: mpg123 (MP3 decoding), LAME 3.100 (MP3 encoding) | LGPL-2.1 (mpg123), LGPL-2.0-or-later (LAME) | OK: LGPL, inside the LGPL library |
| ctranslate2 4.8.3 | libctranslate2 (`ctranslate2.libs/`) | MIT | OK |
| ctranslate2 | linked statically into libctranslate2: Intel oneMKL 2025.3 (the int16 compute type is present) | Intel Simplified Software License (permissive, binary redistribution allowed; not open source) | OK under the rules (not GPL); recorded because it is not an open-source licence |
| ctranslate2 | linked statically into libctranslate2: oneDNN 3.1.1 | Apache-2.0 | OK |
| ctranslate2 | libgomp (GCC OpenMP runtime, `ctranslate2.libs/`) | GPL-3.0-or-later WITH GCC-exception-3.1 | OK: the runtime exception permits linking |
| ctranslate2 | CUDA libraries | not bundled: loaded from the system only when a GPU is used, which scenecast does not do | n/a |
| onnxruntime 1.31.0 | libonnxruntime, libonnxruntime_providers_shared (`onnxruntime/capi/`), with Eigen, protobuf, abseil, re2, flatbuffers, onnx, cpuinfo and others linked in | MIT; parts under MIT, BSD, Apache-2.0, MPL-2.0 (Eigen) and similar, listed in the wheel's `onnxruntime/ThirdPartyNotices.txt`. Its one dual-licensed part (Mbed TLS, Apache-2.0 OR GPL-2.0-or-later) is used under Apache-2.0 | OK |
| numpy 2.5.4 | OpenBLAS 0.3.34 (`numpy.libs/libscipy_openblas64_*.so`), with LAPACK | BSD-3-Clause; LAPACK BSD-3-Clause-Open-MPI | OK (listed in the wheel's `LICENSE.txt`) |
| numpy | libgfortran (`numpy.libs/`) | GPL-3.0-or-later WITH GCC-exception-3.1 | OK: the runtime exception permits linking |
| numpy | libquadmath (`numpy.libs/`) | LGPL-2.1-or-later | OK: LGPL |
| pillow 13.0.0 | `pillow.libs/`: libjpeg-turbo, libpng, libtiff 4.7.2, libwebp 1.6.0, libavif 1.4.2, OpenJPEG 2.5.4, FreeType 2.14.3, HarfBuzz 14.5.0, Little CMS 2.19, brotli, liblzma, zstd, libxcb, libXau | IJG and BSD-3-Clause (libjpeg-turbo), libpng, libtiff, BSD-2/3-Clause, FTL (FreeType), MIT, X11 | OK (per the wheel's SBOM in `pillow-*.dist-info/sboms/`) |
| pillow | FriBiDi (for complex text layout) | LGPL-2.1-or-later | OK: not bundled; loaded from the system if present |
| pillow | libimagequant | GPL-3.0-or-later | Not included: Pillow's SBOM names it, but the wheel is built without it (`PIL.features.check("libimagequant")` is False) |
| av (PyAV) | FFmpeg libraries, libx264 and libx265 (GPL-2.0-or-later) and others in `av.libs/` | mixed, including GPL | **Not installed** (see below) |
| tokenizers 0.23.3, hf-xet 1.7.0, pydantic-core 2.50.1 | Rust extension modules with their crates linked statically; no bundled shared libraries | the package licence (Apache-2.0, Apache-2.0, MIT) | OK; the statically linked crates were not reviewed one by one |
| blis, PyYAML, regex, spacy, thinc and the other compiled packages | their own extension modules only (BLIS and libyaml compiled in) | the package licence | OK |
| imageio-ffmpeg 0.6.0 | the ffmpeg 7.0.2 static executable (johnvansickle.com) | GPL-3.0-or-later (`--enable-gpl --enable-version3`) | OK: run as a separate program, never linked (see "Tools") |

**`av` (PyAV) is not installed.** faster-whisper declares it as a dependency, but `py/pyproject.toml` overrides that
requirement away (`[tool.uv] override-dependencies`, the same way `distance` is kept out), so the wheel and the GPL
x264/x265 it bundles never land in `py/.venv`. faster-whisper imports `av` when it loads, only to decode audio files.
scenecast decodes audio with the ffmpeg tool above into a 16 kHz array, and puts a stub in place of `av` before
importing faster-whisper (`py/scenecast_py/whisper.py`), so the import is satisfied without PyAV.
`py/tests/test_whisper.py` checks both: the stub is in place, and `av` is not installed.

**Other platforms.** The macOS arm64 wheels bundle the same kinds of libraries (the `av` wheel there, not installed, would
also carry x264 and x265; ctranslate2 uses Apple Accelerate instead of oneMKL). On Linux arm64, ctranslate2 4.8.3 bundles libgomp
and is built with OpenBLAS and Ruy (BSD-3-Clause, Apache-2.0) instead of oneMKL and oneDNN, and imageio-ffmpeg 0.6.0
ships the same GPL-3.0 static ffmpeg 7.0.2 build for aarch64 (wheel contents checked, 2026-10-27).

## Deprecated packages

These come in through Revideo 0.11.0 (pinned exactly, because scenecast's composer depends on its internals) and are
marked deprecated on npm. `fluent-ffmpeg` is how Revideo starts ffmpeg; `mathjax-full` and `@xmldom/xmldom` serve
Revideo's LaTeX support, which scenecast does not use.

| Package | Comes from | npm notice |
|---|---|---|
| `@xmldom/xmldom` 0.9.10 | `@revideo/2d` → `mathjax-full` → `speech-rule-engine` | "this version has critical issues, please update to the latest version" |
| `fluent-ffmpeg` 2.1.3 | `@revideo/ffmpeg` | "Package no longer supported" |
| `mathjax-full` 3.2.2 | `@revideo/2d` | "Version 4 replaces this package with the scoped package @mathjax/src" |

## Development-only packages

Development tools (TypeScript, vitest, pytest and their dependencies) are not shipped and are not in the tables below.
One of them is worth naming: `@napi-rs/lzma-linux-x64-gnu` 1.5.1 is an optional dependency of `rollup` 4.65.0, which
comes from `vite` 5 under `vitest`. It installs only on Linux x64 (glibc); its licence is MIT (npm registry metadata,
2026-10-27).

## npm production packages

| Package | Licence | Source |
|---|---|---|
| `@codemirror/language` | MIT | https://code.haverbeke.berlin/codemirror/language |
| `@codemirror/state` | MIT | https://code.haverbeke.berlin/codemirror/state |
| `@codemirror/streamparser` | MIT | https://code.haverbeke.berlin/codemirror/streamparser |
| `@codemirror/view` | MIT | https://code.haverbeke.berlin/codemirror/view |
| `@ffprobe-installer/darwin-arm64` | LGPL-2.1 | https://formulae.brew.sh/formula/ffmpeg |
| `@ffprobe-installer/ffprobe` | LGPL-2.1 | https://github.com/SavageCore/node-ffprobe-installer |
| `@lezer/common` | MIT | https://code.haverbeke.berlin/lezer/common |
| `@lezer/highlight` | MIT | https://code.haverbeke.berlin/lezer/highlight |
| `@lezer/lr` | MIT | https://code.haverbeke.berlin/lezer/lr |
| `@marijn/find-cluster-break` | MIT | https://code.haverbeke.berlin/marijn/find-cluster-break |
| `@noble/hashes` | MIT | https://paulmillr.com/noble/ |
| `@nodelib/fs.scandir` | MIT | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.scandir |
| `@nodelib/fs.stat` | MIT | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.stat |
| `@nodelib/fs.walk` | MIT | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.walk |
| `@oxc-project/types` | MIT | https://oxc.rs |
| `@paralleldrive/cuid2` | MIT | https://github.com/ericelliott/cuid2 |
| `@posthog/core` | MIT | https://github.com/PostHog/posthog-js |
| `@posthog/types` | MIT | https://github.com/PostHog/posthog-js |
| `@preact/signals` | MIT | https://preactjs.com |
| `@preact/signals-core` | MIT | https://preactjs.com |
| `@puppeteer/browsers` | Apache-2.0 | https://github.com/puppeteer/puppeteer/tree/main/packages/browsers |
| `@revideo/2d` | MIT | https://re.video/ |
| `@revideo/core` | MIT | https://re.video/ |
| `@revideo/ffmpeg` | MIT | https://re.video/ |
| `@revideo/renderer` | MIT | https://re.video/ |
| `@revideo/telemetry` | MIT | https://re.video/ |
| `@revideo/ui` | MIT | https://re.video/ |
| `@revideo/vite-plugin` | MIT | https://re.video/ |
| `@rive-app/canvas-advanced` | MIT | https://rive.app |
| `@rolldown/binding-darwin-arm64` | MIT | https://rolldown.rs/ |
| `@rolldown/pluginutils` | MIT | https://github.com/rolldown/plugins/tree/main/packages/pluginutils |
| `@types/hast` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/hast |
| `@types/node` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node |
| `@types/unist` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/unist |
| `@wooorm/starry-night` | MIT | https://github.com/wooorm/starry-night |
| `@xmldom/xmldom` | MIT | https://github.com/xmldom/xmldom (deprecated: see "Deprecated packages") |
| `ansi-regex` | MIT | https://github.com/chalk/ansi-regex |
| `ansi-styles` | MIT | https://github.com/chalk/ansi-styles |
| `asap` | MIT | https://github.com/kriskowal/asap |
| `async` | MIT | https://github.com/caolan/async |
| `braces` | MIT | https://github.com/micromatch/braces |
| `chromium-bidi` | Apache-2.0 | https://github.com/GoogleChromeLabs/chromium-bidi |
| `cliui` | ISC | https://github.com/yargs/cliui |
| `code-fns` | MIT | https://github.com/Ross-Esmond/code-fns |
| `commander` | MIT | https://github.com/tj/commander.js |
| `crelt` | MIT | https://code.haverbeke.berlin/marijn/crelt |
| `culori` | MIT | https://github.com/Evercoder/culori |
| `detect-libc` | Apache-2.0 | https://github.com/lovell/detect-libc |
| `devtools-protocol` | BSD-3-Clause | https://github.com/ChromeDevTools/devtools-protocol |
| `dezalgo` | ISC | https://github.com/npm/dezalgo |
| `emoji-regex` | MIT | https://mths.be/emoji-regex |
| `escalade` | MIT | https://github.com/lukeed/escalade |
| `esm` | MIT | https://github.com/standard-things/esm |
| `fast-glob` | MIT | https://github.com/mrmlnc/fast-glob |
| `fastq` | ISC | https://github.com/mcollina/fastq |
| `fdir` | MIT | https://github.com/thecodrr/fdir |
| `fill-range` | MIT | https://github.com/jonschlinkert/fill-range |
| `fluent-ffmpeg` | MIT | https://github.com/fluent-ffmpeg/node-fluent-ffmpeg (deprecated: see "Deprecated packages") |
| `follow-redirects` | MIT | https://github.com/follow-redirects/follow-redirects |
| `formidable` | MIT | https://github.com/node-formidable/formidable |
| `fsevents` | MIT | https://github.com/fsevents/fsevents |
| `get-caller-file` | ISC | https://github.com/stefanpenner/get-caller-file |
| `get-east-asian-width` | MIT | https://github.com/sindresorhus/get-east-asian-width |
| `glob-parent` | ISC | https://github.com/gulpjs/glob-parent |
| `hls.js` | Apache-2.0 | https://github.com/video-dev/hls.js |
| `import-meta-resolve` | MIT | https://github.com/wooorm/import-meta-resolve |
| `is-extglob` | MIT | https://github.com/jonschlinkert/is-extglob |
| `is-glob` | MIT | https://github.com/micromatch/is-glob |
| `is-number` | MIT | https://github.com/jonschlinkert/is-number |
| `isexe` | ISC | https://github.com/isaacs/isexe |
| `lightningcss` | MPL-2.0 | https://github.com/parcel-bundler/lightningcss |
| `lightningcss-darwin-arm64` | MPL-2.0 | https://github.com/parcel-bundler/lightningcss |
| `lilconfig` | MIT | https://github.com/antonk52/lilconfig |
| `mathjax-full` | Apache-2.0 | https://github.com/mathjax/Mathjax-src/ (deprecated: see "Deprecated packages") |
| `merge2` | MIT | https://github.com/teambition/merge2 |
| `mhchemparser` | Apache-2.0 | https://github.com/mhchem/mhchemParser |
| `micromatch` | MIT | https://github.com/micromatch/micromatch |
| `mime-db` | MIT | https://github.com/jshttp/mime-db |
| `mime-types` | MIT | https://github.com/jshttp/mime-types |
| `mitt` | MIT | https://github.com/developit/mitt |
| `mj-context-menu` | Apache-2.0 | https://github.com/zorkow/context-menu |
| `modern-tar` | MIT | https://github.com/ayuhito/modern-tar |
| `mp4-wasm` | MIT | https://github.com/mattdesl/mp4-wasm |
| `mp4box` | BSD-3-Clause | https://github.com/gpac/mp4box.js |
| `nanoid` | MIT | https://github.com/ai/nanoid |
| `once` | ISC | https://github.com/isaacs/once |
| `parse-svg-path` | MIT | https://github.com/jkroso/parse-svg-path |
| `picocolors` | ISC | https://github.com/alexeyraspopov/picocolors |
| `picomatch` | MIT | https://github.com/micromatch/picomatch |
| `playwright` | Apache-2.0 | https://playwright.dev |
| `playwright-core` | Apache-2.0 | https://playwright.dev |
| `postcss` | MIT | https://postcss.org/ |
| `posthog-node` | MIT | https://github.com/PostHog/posthog-js |
| `preact` | MIT | https://preactjs.com |
| `puppeteer` | Apache-2.0 | https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer |
| `puppeteer-core` | Apache-2.0 | https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core |
| `queue-microtask` | MIT | https://github.com/feross/queue-microtask |
| `reusify` | MIT | https://github.com/mcollina/reusify |
| `rolldown` | MIT | https://rolldown.rs/ |
| `run-parallel` | MIT | https://github.com/feross/run-parallel |
| `source-map` | BSD-3-Clause | https://github.com/mozilla/source-map |
| `source-map-js` | BSD-3-Clause | https://github.com/7rulnik/source-map-js |
| `speech-rule-engine` | Apache-2.0 | https://github.com/zorkow/speech-rule-engine |
| `string-width` | MIT | https://github.com/sindresorhus/string-width |
| `strip-ansi` | MIT | https://github.com/chalk/strip-ansi |
| `style-mod` | MIT | https://code.haverbeke.berlin/marijn/style-mod |
| `tinyglobby` | MIT | https://superchupu.dev/tinyglobby |
| `to-regex-range` | MIT | https://github.com/micromatch/to-regex-range |
| `typed-query-selector` | MIT | https://github.com/g-plane/typed-query-selector |
| `undici-types` | MIT | https://undici.nodejs.org |
| `uuid` | MIT | https://github.com/uuidjs/uuid |
| `vite` | MIT | https://vite.dev |
| `vscode-oniguruma` | MIT | https://github.com/microsoft/vscode-oniguruma |
| `vscode-textmate` | MIT | https://github.com/microsoft/vscode-textmate |
| `w3c-keyname` | MIT | https://github.com/marijnh/w3c-keyname |
| `webdriver-bidi-protocol` | Apache-2.0 | https://github.com/GoogleChromeLabs/webdriver-bidi-protocol |
| `which` | ISC | https://github.com/isaacs/node-which |
| `wicked-good-xpath` | MIT | https://github.com/google/wicked-good-xpath |
| `wrap-ansi` | MIT | https://github.com/chalk/wrap-ansi |
| `wrappy` | ISC | https://github.com/npm/wrappy |
| `ws` | MIT | https://github.com/websockets/ws |
| `y18n` | ISC | https://github.com/yargs/y18n |
| `yaml` | ISC | https://eemeli.org/yaml/ |
| `yargs` | MIT | https://yargs.js.org/ |
| `yargs-parser` | ISC | https://github.com/yargs/yargs-parser |
| `zod` | MIT | https://zod.dev |
| `@rolldown/binding-*` | MIT | https://rolldown.rs/ (the build for your platform; every build in `pnpm-lock.yaml`, linux-arm64-gnu included, is MIT per npm registry metadata, 2026-10-27) |
| `lightningcss-*` | MPL-2.0 | https://github.com/parcel-bundler/lightningcss (the build for your platform; every build in `pnpm-lock.yaml` is MPL-2.0 per npm registry metadata, and the linux-arm64-gnu tarball ships the MPL-2.0 text, 2026-10-27) |
| `@ffprobe-installer/*` | darwin-arm64: LGPL-2.1; darwin-x64, linux-x64, linux-arm64, linux-arm, linux-ia32: GPL-3.0 (run as a separate program, see "Tools") | https://github.com/SavageCore/node-ffprobe-installer (the build for your platform) |

## Python production packages

| Package | Licence | Source |
|---|---|---|
| `addict` | MIT | https://github.com/mewwts/addict |
| `annotated-doc` | MIT | https://github.com/fastapi/annotated-doc |
| `annotated-types` | MIT | https://github.com/annotated-types/annotated-types |
| `anyio` | MIT | https://github.com/agronholm/anyio |
| `blis` | BSD-3-Clause | https://github.com/explosion/cython-blis |
| `catalogue` | MIT | https://github.com/explosion/catalogue |
| `certifi` | MPL-2.0 | https://github.com/certifi/python-certifi |
| `cffi` | MIT-0 | https://github.com/python-cffi/cffi |
| `charset-normalizer` | MIT | https://github.com/jawah/charset_normalizer |
| `click` | BSD-3-Clause | https://github.com/pallets/click/ |
| `cloudpathlib` | MIT | https://github.com/drivendataorg/cloudpathlib |
| `cloudpickle` | BSD-3-Clause | https://github.com/cloudpipe/cloudpickle |
| `confection` | MIT | https://github.com/explosion/confection |
| `ctranslate2` | MIT | https://github.com/OpenNMT/CTranslate2 |
| `cymem` | MIT | https://github.com/explosion/cymem |
| `defusedxml` | PSF-2.0 | https://github.com/tiran/defusedxml |
| `docopt` | MIT | http://docopt.org |
| `en_core_web_sm` | MIT | https://explosion.ai |
| `faster-whisper` | MIT | https://github.com/SYSTRAN/faster-whisper |
| `filelock` | MIT | https://github.com/tox-dev/py-filelock |
| `flatbuffers` | Apache-2.0 | https://github.com/google/flatbuffers |
| `fsspec` | BSD-3-Clause | https://github.com/fsspec/filesystem_spec |
| `g2p-en` | Apache-2.0 | https://github.com/Kyubyong/g2p |
| `h11` | MIT | https://github.com/python-hyper/h11 |
| `hf-xet` | Apache-2.0 | https://github.com/huggingface/xet-core |
| `httpcore` | BSD-3-Clause | https://www.encode.io/httpcore/ |
| `httpcore2` | BSD-3-Clause | https://github.com/pydantic/httpx2 |
| `httpx` | BSD-3-Clause | https://github.com/encode/httpx |
| `httpx2` | BSD-3-Clause | https://github.com/pydantic/httpx2 |
| `huggingface_hub` | Apache-2.0 | https://github.com/huggingface/huggingface_hub |
| `idna` | BSD-3-Clause | https://github.com/kjd/idna |
| `imageio-ffmpeg` | BSD-2-Clause | https://github.com/imageio/imageio-ffmpeg |
| `inflect` | MIT | https://github.com/jaraco/inflect |
| `jaraco.functools` | MIT | https://github.com/jaraco/jaraco.functools |
| `Jinja2` | BSD-3-Clause | https://github.com/pallets/jinja/ |
| `joblib` | BSD-3-Clause | https://joblib.readthedocs.io |
| `markdown-it-py` | MIT | https://github.com/executablebooks/markdown-it-py |
| `MarkupSafe` | BSD-3-Clause | https://github.com/pallets/markupsafe/ |
| `mdurl` | MIT | https://github.com/executablebooks/mdurl |
| `misaki` | Apache-2.0 | https://github.com/hexgrad/misaki |
| `more-itertools` | MIT | https://github.com/more-itertools/more-itertools |
| `murmurhash` | MIT | https://github.com/explosion/murmurhash |
| `nltk` | Apache-2.0 | https://github.com/nltk/nltk |
| `num2words` | LGPL-2.1 (upstream COPYING; the wheel metadata says only "LGPL") | https://github.com/savoirfairelinux/num2words |
| `numpy` | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | https://numpy.org |
| `onnxruntime` | MIT | https://onnxruntime.ai |
| `packaging` | Apache-2.0 OR BSD-2-Clause | https://github.com/pypa/packaging |
| `pillow` | MIT-CMU | https://python-pillow.org |
| `preshed` | MIT | https://github.com/explosion/preshed |
| `protobuf` | BSD-3-Clause | https://developers.google.com/protocol-buffers/ |
| `pycparser` | BSD-3-Clause | https://github.com/eliben/pycparser |
| `pydantic` | MIT | https://github.com/pydantic/pydantic |
| `pydantic_core` | MIT | https://github.com/pydantic |
| `Pygments` | BSD-2-Clause | https://pygments.org |
| `PyYAML` | MIT | https://github.com/yaml/pyyaml |
| `regex` | Apache-2.0 AND CNRI-Python | https://github.com/mrabarnett/mrab-regex |
| `requests` | Apache-2.0 | https://github.com/psf/requests |
| `rich` | MIT | https://github.com/Textualize/rich |
| `scenecast-py` | MIT | this repository (`py/`) |
| `setuptools` | MIT | https://github.com/pypa/setuptools |
| `shellingham` | ISC | https://github.com/sarugaku/shellingham |
| `smart_open` | MIT | https://github.com/piskvorky/smart_open |
| `soundfile` | BSD-3-Clause | https://github.com/bastibe/python-soundfile |
| `spacy` | MIT | https://github.com/explosion/spaCy |
| `spacy-legacy` | MIT | https://spacy.io |
| `spacy-loggers` | MIT | https://github.com/explosion/spacy-loggers |
| `srsly` | MIT | https://github.com/explosion/srsly |
| `thinc` | MIT | https://github.com/explosion/thinc |
| `tokenizers` | Apache-2.0 | https://github.com/huggingface/tokenizers |
| `tqdm` | MPL-2.0 AND MIT | https://tqdm.github.io |
| `truststore` | MIT | https://github.com/sethmlarson/truststore |
| `typeguard` | MIT | https://github.com/agronholm/typeguard |
| `typer` | MIT | https://github.com/fastapi/typer |
| `typing-inspection` | MIT | https://github.com/pydantic/typing-inspection |
| `typing_extensions` | Python-2.0 | https://github.com/python/typing_extensions |
| `urllib3` | MIT | https://github.com/urllib3/urllib3 |
| `wasabi` | MIT | https://github.com/explosion/wasabi |
| `weasel` | MIT | https://github.com/explosion/weasel/ |
| `wrapt` | BSD-2-Clause | https://github.com/GrahamDumpleton/wrapt |
