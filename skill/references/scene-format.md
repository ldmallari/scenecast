# Scene file reference

A scene file (`video.yaml`; `.yml` and `.json` work too) describes one video: the app to record, the brand, the
voice, and an ordered list of scenes. Each scene has its narration and the steps to perform while it is spoken. Every
step names a **cue**, a word or phrase in the narration, and scenecast times the step so that it lands on that word.

Relative paths (`brand.logo`, `brand.music.file`, `app.storageState`, `app.loginHook`, and `app.seed` when it is a
script path) are resolved against the scene file's folder.

The scene file is checked when it loads. Every problem is listed at once, for example
`scene "worklist" step 1: cue "due" not in narration`.

## A complete example

This is the demo in `examples/demo-app/video.yaml`, shortened:

```yaml
id: demo
title: A quick tour of Demo Co
output: demo
brand:
  primary: "#1F3A5F"
  accent: "#F5C518"
  font: Inter
  introTitle: A quick tour of Demo Co
  introSubtitle: Sign in, check your worklist and sign a form
app:
  baseUrl: http://127.0.0.1:4310
  seed: ./seed.mjs
  login:
    - { do: goto, text: /login }
    - { do: type, sel: "#email", text: sam@example.com }
    - { do: type, sel: "#password", text: demo-password }
    - { do: click, sel: "#signin" }
  nav:
    - { selector: header.topbar, edge: top }
audit:
  allowList: [Demo Co]

scenes:
  - id: worklist
    kind: app
    title: Your worklist
    route: /dashboard
    narration: >-
      Your dashboard opens on the worklist, with everything that needs you today.
      Each item shows when it is due, so the most urgent work comes first.
    steps:
      - { cue: worklist, do: ring, sel: ".worklist", pad: 10 }
      - { cue: due, do: zoom, sel: ".worklist", pad: 16, ms: 2500 }

  - id: on-the-go
    kind: title
    title: On the go
    seconds: 3
    narration: Next, the same app on a phone.

  - id: phone
    kind: app
    title: On your phone
    route: /dashboard
    viewport: phone
    narration: >-
      On a phone, the same worklist fits the narrow screen.
      Tap Requests to see everything you have asked for.
    steps:
      - { cue: Requests, do: click, sel: ".nav a[href='/requests']" }
```

## Top level

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Short name. The work folder is `<work>/<id>/`. |
| `title` | yes | The video's title. It is shown on the outro card unless `cards.outroTitle` is set. |
| `output` | yes | Base name of the output files: `<out>/<output>.mp4` and `.srt`. |
| `brand` | yes | Colours, font and card text. See [brand](#brand). |
| `app` | yes | How to reach and sign in to the app. See [app](#app). |
| `voice` | no | The narrator. See [voice](#voice). |
| `scenes` | yes | At least one scene. See [scenes](#scenes). |
| `cards` | no | The intro and outro cards. See [cards](#cards). |
| `audit` | no | `allowList`: names and words that speech recognition may spell differently, or leave out, without a narration WARN (for example `[Demo Co]`). An allow-listed cue word that is left out is placed by position, in the gap the heard words around it leave. |

## cards

| Field | Default | Meaning |
|---|---|---|
| `introSec` | `3` | Intro card length: 0 (no intro card) or at least 1 s. |
| `outroSec` | `3` | Outro card length: 0 (no outro card) or at least 1 s. |
| `outroTitle` | `title` | The outro card's title. |
| `outroNext` | none | A smaller line under the outro title, for example `Next: approving requests`. |
| `entrance` | `reveal` | How the logo, bar and text come in. `reveal`: the logo scales up slightly and fades in, the accent bar grows, then the title, subtitle and next line rise in one after another (about 1 s in all). `rise` is the v1 look (everything rises and fades in over 0.5 s). `none` shows the card at once. |
| `introPage` | none | An HTML file shown as the intro card instead of the drawn one (see [card pages](#card-pages)). |
| `outroPage` | none | The same for the outro card. |

### Card pages

A card page (`cards.introPage`, `cards.outroPage`, or `page` on a title scene) is an HTML file that Chromium renders
**once**, at 1920×1080, into the image the card shows. Paths are relative to the scene file. The page gets the brand
as CSS variables on `:root`: `--sc-primary`, `--sc-accent`, `--sc-font` and `--sc-card-font` (font names come
quoted, so `font-family: var(--sc-card-font), sans-serif` works). The capture waits for the page's fonts to load.

- The card is a still. CSS animations and transitions do not play in the video: finite ones are captured at their
  end state. The card entrance does not apply to a page; the page fades in and out with the dissolve like any scene.
- Keep everything the page loads local (fonts, images, styles), so it renders the same offline. The cache notices a
  change to the HTML file itself; after changing only a file it loads, render with `--fresh`.
- Routes, init scripts and the signed-in session do not apply to card pages.
- A title scene's narration captions are drawn over its page.

## brand

| Field | Required | Meaning |
|---|---|---|
| `primary` | yes | Background colour of the intro, outro and chapter cards, unless `background` is set. The card text is light or dark to suit the background. |
| `accent` | yes | The accent bar on the cards. |
| `font` | yes | Font family for captions (and cards, unless `cardFont` is set), for example `Inter`. If it is not installed, the system sans-serif is used. |
| `cardFont` | no | Font family of the card text. Defaults to `font`. It must be installed on the machine that renders; use a free font (OFL is fine). |
| `background` | no | Background of the cards: a colour (`"#1F3A5F"`), a gradient `{ from, to, angle }` (`angle` in CSS degrees, default 135: from the top-left to the bottom-right), or an image `{ image, dim }` (a path; it covers the frame, under a black overlay of `dim`, 0 to 1, default 0.35). Default: `primary`. |
| `logo` | no | An image file shown on the intro and outro cards (not on chapter cards). |
| `introTitle` | yes | Title of the intro card. |
| `introSubtitle` | no | Subtitle of the intro card. |
| `music` | no | `{ file, licence }`: your own music track instead of the synthesised bed. `licence` is required and is copied into the audit. |

Without `brand.music`, scenecast synthesises a quiet music bed, so there is nothing to license.

## app

| Field | Required | Meaning |
|---|---|---|
| `baseUrl` | yes | Where the app runs, for example `http://127.0.0.1:4310`. Routes and `goto` paths are relative to it. The app must already be running when you render. |
| `login` | no | Steps that sign in, run before each signed-in scene is recorded (scenes reused from the cache don't sign in), untimed and not recorded. They use the same step format as scenes (`goto`, `type`, `click`, `press`, `hover`, `wait`). |
| `storageState` | no | A saved Playwright session file. When set, it is used instead of `login`. `scenecast login <video.yaml>` opens a browser, lets you sign in by hand, and saves the session to this path (useful for SSO or two-factor sign-in). |
| `loginHook` | no | A JavaScript module whose default export is `async (page, context) => {}` and signs in. It is used when there are no `login` steps and no `storageState`. |
| `seed` | no | Runs once before the first recording, in the scene file's folder, with `SCENECAST_BASE_URL` set. A single word naming a file that exists (relative to the scene file), such as `./seed.mjs`, is a script: `.js`, `.mjs`, `.cjs` and `.ts` run with `node`, `.sh` with `sh`, anything else directly. Anything else, such as `node scripts/seed.mjs` or `python db/seed.py`, runs as a shell command. A single word that looks like a path but names no file (`./nope.mjs`) is an error when the scene file loads. Seeding is skipped when every recording is reused from the cache. |
| `nav` | no | The app's navigation bars: a list of `{ selector, edge }` with `edge` `left` (a sidebar) or `top` (a bar along the top). A zoom shows a declared nav whole or leaves it out, never cut partway. |

A scene with `signedOut: true` is recorded without the session.

## voice

| Field | Default | Meaning |
|---|---|---|
| `name` | `af_heart` | A Kokoro voice. |
| `lang` | `en-us` | Language code. |
| `speed` | `0.9` | Speaking rate (1.0 is Kokoro's normal speed). |
| `phraseGapSec` | `0.2` | Silence between phrases, in seconds. |

The narration is split into phrases at sentence ends (`.`, `!`, `?`, `…`). A sentence longer than about 140 characters
is split again at commas.

## scenes

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the file. Used in file names, errors, the audit, and `--only <id>`. |
| `kind` | yes | `app` (a recording of the app) or `title` (a narrated chapter card). |
| `title` | no | The chapter name in `chapters.txt`. On a `title` scene, it is the card's text. Defaults to `id`. |
| `narration` | yes | What the narrator says. Every cue must appear in it. |
| `steps` | no | What happens on screen. See [steps](#steps). |
| `route` | no | The path opened before recording (default `/`). |
| `viewport` | no | `desktop` (1920×1080, the default) or `phone` (390×844 in a drawn phone outline). |
| `signedOut` | no | `true` records this scene without signing in. |
| `prewarm` | no | Paths to open, and wait on, before `route`, so caches are warm when recording starts. |
| `seconds` | title scenes: yes | The card's minimum length. It runs longer if the narration needs it. |
| `page` | no | Title scenes: an HTML file shown as the card instead of the drawn one (see [card pages](#card-pages)). On an app scene it is ignored, with a warning. |

The video is an intro card (3 s by default, music only), then every scene in order, then an outro card (3 s) with
`title`. See [cards](#cards).
A render with `--only <id>` leaves out the intro and outro cards and writes `<output>-<id>.mp4` and `<output>-<id>.srt`.

## steps

```yaml
- { cue: Sign in, occ: 2, do: click, sel: "#signin" }
```

| Field | Meaning |
|---|---|
| `do` | `click`, `type`, `hover`, `scroll`, `press`, `zoom`, `ring`, `wait` or `goto`. |
| `cue` | A word or phrase from the narration (case-insensitive, whole words). The step lands on its first word. |
| `occ` | Which occurrence of the cue, counting from 1 (default 1). Use it when the cue appears more than once: in "To sign in, … and press Sign in", the button is `occ: 2`. |
| `offset` | Seconds added to the cue time (negative is earlier). |
| `sel` | A CSS selector, or a list of them. `click`, `type`, `hover`, `zoom` and `ring` need one. With a list, the box is the union of all matches and the pointer aims at the first. |
| `text` | What `type` types, the key `press` presses (default `Enter`), or the path `goto` opens. |
| `ms` | `zoom`: how long it holds after easing in (default 2000). `ring`: how long it holds (default 1200). `wait`: how long to wait. Any step: the minimum time before the next uncued step. |
| `pad` | Pixels added around the box of a `zoom` or `ring`. |
| `ring` | `true` on another step (for example a `click`) draws a ring around its target as well. |
| `settle` | `false` skips the wait for the page to settle before this step. |

What each action does:

- **click, type, hover.** The cursor glides to the element and the action happens on the cue word. `type` clicks
  the field, then types `text` one character at a time.
- **press.** Presses a key (`text`, default `Enter`).
- **scroll.** Scrolls the element into the middle of the view, or scrolls the page down by most of a screen when
  there is no `sel`.
- **zoom.** Eases the view in to the element (0.7 s), holds it for `ms`, then eases out. The zoomed region keeps the
  frame's 16:9 shape, magnifies at most 2.5×, keeps 24 px of space around the target, stays inside the frame, and
  shows a declared nav whole or not at all. A target too big to need a zoom gets the full frame.
- **ring.** Draws a highlight ring around the element.
- **goto.** Opens a path in the app.
- **wait.** Pauses.

A step without a `cue` runs right after the step before it (plus that step's `ms`). Only steps with a cue are checked
for sync by the audit, so give a cue to every step a viewer should see happen on a word.

Before each step the recorder waits for the page to settle: no document, XHR or fetch requests in flight, a stable
layout, and no visible loading indicator (`[aria-busy=true]`, `[role=progressbar]` without a value, `.is-loading`,
`.skeleton` or `[data-scenecast-loading]`). Open panels (`[role=dialog]`, `[role=menu]`, `[role=listbox]`,
`[aria-modal=true]` or `[data-scenecast-panel]`) are measured so captions keep clear of them.

## Captions

Captions come from the narration, shown as a sequence of rounded boxes of at most 2 lines of about 42 characters. They sit
at the bottom, and move to the top when the target, the cursor or an open panel is in the bottom quarter of the frame.
During a zoom, they are placed against what is on screen at that moment. The same text is written to `<output>.srt`.

## Output

`scenecast render video.yaml` writes, in `out/` (or `--out <dir>`):

- `<output>.mp4`: 1920×1080, 30 fps, H.264 with AAC audio, loudness-normalised to −16 LUFS.
- `<output>.srt`: the captions.
- `chapters.txt`: `HH:MM:SS Title` for each scene.
- `audit/`: `audit-table.md`, `audit.json`, `contact-sheet.png` and `frames/`. See [audit.md](audit.md).

Intermediate files go to `work/<id>/` (or `--work <dir>`). Each stage there is reused when its inputs have not
changed.
