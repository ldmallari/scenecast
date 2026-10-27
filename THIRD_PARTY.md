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
| ffmpeg bundled with `imageio-ffmpeg` | macOS arm64: a GPL-2.0-or-later build (`--enable-gpl`, with libx264). Linux x86_64: a GPL-3.0-or-later static build (`--enable-gpl --enable-version3`, with libx264) | https://ffmpeg.org/legal.html, https://github.com/imageio/imageio-ffmpeg | The toolchain ffmpeg: encoding, mixing, loudness, frame extraction. Run as a subprocess. |
| ffprobe from `@ffprobe-installer/*` (one build per platform) | darwin-arm64: LGPL-2.1 (an LGPL build, checked). darwin-x64 and the Linux builds: GPL-3.0 (static builds; npm registry metadata, 2026-10-25) | https://github.com/SavageCore/node-ffprobe-installer | Run by Revideo to read media (`FFPROBE_PATH`). |
| `@ffmpeg-installer/ffmpeg` | not installed | https://github.com/kribblo/node-ffmpeg-installer | `@revideo/ffmpeg` asks for it. A pnpm override replaces it with `stubs/ffmpeg-installer`, a small stand-in (MIT, part of this repository) that points at the toolchain ffmpeg, so no ffmpeg binary is downloaded with the npm packages. |
| Chromium (Playwright's build) | BSD-3-Clause, with third-party parts under their own licences | https://playwright.dev, https://www.chromium.org | Records the app and renders the composition. Installed with `pnpm -C packages/cli exec playwright install chromium`. |
| uv | MIT OR Apache-2.0 | https://github.com/astral-sh/uv | Manages the Python environment. `scenecast doctor` installs it into your home folder if it is missing. |

## Native libraries inside Python wheels

Some Python wheels ship native libraries:

- **`av` (PyAV)** is installed because faster-whisper depends on it, but scenecast **never loads it**. Its wheel bundles
  the FFmpeg libraries (built as LGPL-3.0-or-later) and also libx264 and libx265, which are GPL-2.0-or-later.
  faster-whisper imports `av` when it loads, only to decode audio files. scenecast decodes audio with the ffmpeg tool
  above into a 16 kHz array, and puts a stub in place of `av` before importing faster-whisper
  (`py/scenecast_py/whisper.py`), so PyAV and its libraries never load. `py/tests/test_whisper.py` checks this, and a
  real transcription was checked by hand on macOS (`DYLD_PRINT_LIBRARIES`) and Linux (`LD_DEBUG=libs`): neither x264
  nor x265 loaded.
- **`soundfile`** bundles libsndfile (LGPL-2.1).
- **`pillow`** bundles image codecs (libjpeg, libpng, libtiff, libwebp, FreeType, HarfBuzz and others) under their own
  permissive licences.
- **`ctranslate2`**, **`onnxruntime`**, **`numpy`** ship their own compiled code under the licences in the table.

Wheels differ per platform. These notes describe the macOS arm64 wheels; the Linux x86_64 `av` wheel bundles x264 and
x265 too (in `av.libs/`). Other Linux wheels may bundle different libraries.

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
comes from `vite` 5 under `vitest`. It installs only on Linux x64 (glibc), so it is not on a Mac and was not checked
here, and its licence was not verified.

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
| `@rolldown/binding-*` | MIT | https://rolldown.rs/ (the build for your platform; darwin-arm64 checked) |
| `lightningcss-*` | MPL-2.0 | https://github.com/parcel-bundler/lightningcss (the build for your platform; darwin-arm64 checked) |
| `@ffprobe-installer/*` | darwin-arm64: LGPL-2.1; darwin-x64, linux-x64, linux-arm64, linux-arm, linux-ia32: GPL-3.0 (run as a separate program, see "Tools") | https://github.com/SavageCore/node-ffprobe-installer (the build for your platform) |

## Python production packages

| Package | Licence | Source |
|---|---|---|
| `addict` | MIT | https://github.com/mewwts/addict |
| `annotated-doc` | MIT | https://github.com/fastapi/annotated-doc |
| `annotated-types` | MIT | https://github.com/annotated-types/annotated-types |
| `anyio` | MIT | https://github.com/agronholm/anyio |
| `av` | BSD-3-Clause (installed for faster-whisper, never loaded: see "Native libraries inside Python wheels") | https://github.com/PyAV-Org/PyAV |
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
