# Changelog

All notable changes to scenecast are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and scenecast uses
[semantic versioning](https://semver.org/): a scene file that renders on 1.x keeps rendering on later 1.x releases.
`scenecast --version` prints the version you have.

## [Unreleased]

### Added

- A warning before composing when a zoom leaves no caption position free, with how much of the zoomed height its
  target fills.

- `app.seedInputs`: data files the seed reads; their contents join the recordings' cache key.

- An `upload` step: `{ cue: attach, do: upload, sel: ".dropzone", file: ./quote.pdf }` clicks the button, label or
  drop zone on its cue and answers the file chooser with the file (or files). Files are checked when the scene file
  loads, and their contents are part of the recording's cache key. The demo app has a New request drawer with a drop
  zone to try it on.
- Scene `setup` steps: untimed, unfilmed steps that run after `route` opens and before recording starts, so a scene
  can start part-way through a flow (an open drawer, step 2 of a wizard) without an init script that fakes the state.

### Fixed

- Captions no longer break between a hyphenated word and its noun ("your to-do / list"), or leave a clause's last
  function word alone at the start of a line ("the team asked / for, Open"); a function word that ends a clause may end a
  line.

- The audit's zoom target check leaves out the part of a zoom's `pad` that runs off the frame, so a large pad on an
  element near the edge no longer FAILs with "zoom does not contain target".

- A take whose flash marker is missing (rare, and gone on the next try) is recorded once more by itself instead of
  failing the render.

- A changed seed records every scene again: the files a seed command names (`scripts/seed.mjs` in
  `node scripts/seed.mjs`) are part of the recordings' cache key, as a seed script path already was.

- A cue with a symbol in it, such as `Save & close`, matches the narration: words with no letter or digit
  count on neither side.

- A step is no longer late because the page was busy: from just before the step is due, only a document still
  loading or a visible loading indicator holds it up; data requests and a layout still moving no longer do.
- A `ringSel` ring on a click (and on type, check and upload) is measured after the click has had its effect, so an
  element that moves when clicked (a dialog that grows and re-centres) stays inside its ring.
- A ring fades out early when its element is removed or hidden, instead of floating over what comes next.
- A ring on an element taller than the screen, or one that would scroll the page while an earlier ring is showing,
  no longer scrolls the page; the render warns and suggests ringing a smaller part.
- The render warns when a `type` step's typing would still be going as the next step sets off.
- Takes recorded by 1.1.0 are recorded again (the record stage's cache version is 4); voice and music are kept.

- A step without a cue now starts after the step before it has acted, not while that step's cursor is still gliding,
  so it can no longer act first (which failed the render with "action is scheduled before the previous action").
- Steps that could only fail once recorded are reported after the voice is made and before anything is recorded, all
  at once, each with what to change: a step on a scene's first word, a step that would act before the step above it,
  and a step that would run past the end of its scene. A first step without a cue now acts 0.2 s into the scene,
  once the take has started.

- Forced alignment no longer drops a whole phrase to the free transcript when two adjacent words get the same start:
  the later word starts one alignment frame on, so the phrase keeps its forced word times.

## [1.1.0] - 2026-10-28

### Added

- `scenecast --version` (and `-v`) prints the version.
- Scene file fields for real apps: `app.routes` answers network requests (feature flags, slow third parties, an API
  that is not running), `app.initScript` runs before the app's own scripts, `app.panels` names the app's own pop-overs
  and drawers, and a sign-in kept in sessionStorage is saved and restored.
- New steps and step options: `check` (ticks a checkbox or switch only when it is not ticked), `park` (moves the
  cursor out of the way), `unzoom` (ends a zoom on a cue word), `scroll` by or to a position, `ringSel` and `ringMs`
  (ring another element during a click, type, hover or check), and `glideMs` per step.
- A scene can start zoomed (`zoom` on the scene), and its cursor can start at a chosen spot (`cursor`).
- The cursor parks by itself between distant steps (`cursor.park`, `cursor.parkAfterSec`).
- The first pointer step of a scene that comes too soon for a glide is pre-positioned: the cursor is on its target
  from the first frame and the action still fires on its cue.
- Phone scenes (`viewport: phone`): touch input with a touch indicator in the brand accent, a phone outline on the
  brand stage, the phone on the left, centre or right, and captions beside it.
- Configurable cards: a gradient or image background, a card font, an entrance animation, an outro "next" line, and
  your own HTML page as a card.
- Captions break at the narration's clauses, never end a line on a function word, and can use the frame's corners.
  The voice pauses briefly at `:` and `;` (`voice.clauseGapSec`).
- Word times come from forced alignment of the known script against the voice, so every narration word gets exactly
  one time. The audit shows where each word time came from.
- A warning when a zoom becomes the full frame because it holds a declared nav.
- A render locks its work dir, so a second render of the same video stops at once and names the render that holds it.
- A website (GitHub Pages), a logo, and a section on using scenecast with an AI coding agent.

### Changed

- PyAV is no longer installed; nothing GPL-only is installed or loaded.
- The README demo is a smoother 25 fps render, and the README shows current render times.

### Fixed

- The final render's Chromium runs without its sandbox on Linux, as the recording already did. This fixes
  "No usable sandbox!" on Ubuntu 23.10 and later, and on CI runners.
- Blank frames that start right after an action (a page painting blank after a click) no longer reach the video.
- A phone scene's `brand.accent` may be any CSS colour; one that is not a colour warns and uses the default.
- Hover rings wait for the hovered element to stop moving before they are drawn.
- The CLI loads again on Node's type stripping.
- Recorder timing: the video clock, page offsets after a navigation, and the take margin after a late last action.
- Takes always cover the whole narration, and retime never reads past the last frame.
- An initial zoom is re-measured after the first step's scroll, and a `scroll` by or to a position fails when the
  window does not move.
- Image cards keep text readable (4.5:1) with a scrim, and card pages never reach the network.
- Takes recorded before a fix to the record stage are recorded again, while the voice and music are kept.

## [1.0.0] - 2026-10-26

The first release.

### Added

- Scene files in YAML (or JSON): narration, steps with cue words, selectors, seed data and sign-in, checked when they
  load.
- A toolchain that sets itself up without admin rights (`scenecast doctor`): uv, the Python environment, ffmpeg and
  the Kokoro and Whisper models.
- A narrated voice from Kokoro, phrase by phrase, with word times.
- A scheduler that times each step to land on its cue word, and a per-scene recorder that drives Chromium with
  Playwright.
- Retime: each take is fitted to the voice clock by holding or trimming quiet frames, so slow pages do not make
  actions late.
- Captions placed clear of what is being clicked, typed into or highlighted.
- A Revideo composer with zoom, highlight rings, captions, and intro, outro and chapter cards.
- A synthesised music bed (or your own track) and a loudness pass to −16 LUFS.
- An audit of every cued moment in the finished video (sync, target, captions, crop, loading, loudness, blank frames,
  narration), with a table, frames, a contact sheet and an exit code.
- The `render`, `preview`, `login` and `doctor` commands, and a demo app with its video.
- A Claude Code skill with scene format, audit and troubleshooting references, and a licence check for every
  dependency.

### Fixed

- Fixes made before the first release: no GPL dependencies, the scheduler's handling of missing cues, recorder clock
  sync, retime cuts, caption overlaps, the composer's render worker, audit target checks, seed commands that run as
  written, and strict scene files that reject unknown keys.

[Unreleased]: https://github.com/ldmallari/scenecast/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ldmallari/scenecast/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ldmallari/scenecast/releases/tag/v1.0.0
