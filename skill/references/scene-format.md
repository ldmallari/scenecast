# Scene file reference

A scene file (`video.yaml`; `.yml` and `.json` work too) describes one video: the app to record, the brand, the
voice, and an ordered list of scenes. Each scene has its narration and the steps to perform while it is spoken. Every
step names a **cue**, a word or phrase in the narration, and scenecast times the step so that it lands on that word.

Relative paths (`brand.logo`, `brand.music.file`, `brand.background.image`, `app.storageState`, `app.loginHook`,
`app.initScript` and `app.routes[].module` files, card pages, and `app.seed` when it is a script path) are resolved
against the scene file's folder.

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
  cardFont: Inter
  background: { from: "#1F3A5F", to: "#0F1E33" }
  introTitle: A quick tour of Demo Co
  introSubtitle: Sign in, check your worklist and sign a form
cards:
  introSec: 3.5
  outroSec: 4
  outroNext: "Next: approving requests"
  entrance: reveal
app:
  baseUrl: http://127.0.0.1:4310
  seed: ./seed.mjs
  routes:
    - { url: "**/api/flags", json: { sso: true, sessionToken: true } }
  initScript: "document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.demo = 'video'; });"
  panels: [".filters-pop"]
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
      - { cue: due, do: zoom, sel: ".worklist", pad: 16 }
      - { cue: first, do: unzoom }

  - id: account-menu
    kind: app
    title: The account menu
    route: /dashboard
    cursor: right
    narration: >-
      Your account menu sits at the top right. Open it to find your profile, your settings, and sign out.
    steps:
      - { cue: Open, do: click, sel: "#menu-button" }
      - { cue: profile, do: ring, sel: "#account-menu", pad: 6 }
      - { do: park }

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
| `cursor` | no | Where the cursor starts and parks. See [cursor](#cursor). |
| `phone` | no | `align`: where a phone scene's phone sits, `left` (default), `center` or `right`. See [phone scenes](#phone-scenes). |
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
- Everything the page loads must be local (fonts, images, styles): the network is blocked, so it renders the same
  offline. The cache notices a
  change to the HTML file itself; after changing only a file it loads, render with `--fresh`.
- Routes, init scripts and the signed-in session do not apply to card pages.
- A card page draws with the fonts installed on the machine that renders (and any font files the page loads
  itself). The fonts bundled with scenecast (Inter) are loaded only into the composer, for captions and drawn cards,
  not into card pages: ship the font file next to the page and load it with `@font-face` to be sure.
- The page replaces the whole drawn card: the logo, `introTitle`/`introSubtitle`, `outroTitle` and `outroNext` are
  not drawn on it.
- A title scene's narration captions are drawn over its page.
- Requests to anything but local files are blocked, and each blocked URL is named in a warning.

## brand

| Field | Required | Meaning |
|---|---|---|
| `primary` | yes | Background colour of the intro, outro and chapter cards, unless `background` is set. The card text is light or dark to suit the background. |
| `accent` | yes | The accent bar on the cards, and the touch indicator on phone scenes. Any CSS colour works (`#F5C518`, `gold`, `rgb(245 197 24)`); the touch indicator uses it as computed by the browser, without alpha. A value that is not a colour prints a warning and the indicator falls back to `#F5C518`. |
| `font` | yes | Font family for captions (and cards, unless `cardFont` is set), for example `Inter`. Inter is bundled with scenecast (OFL-1.1) and always works, offline. Any other family must be installed on the machine that renders: a font that is missing fails the render and names the font, rather than falling back to another typeface. The check runs when the video is composed (after the voice and the recordings), and a name the system resolves as an alias of an installed font counts as installed. |
| `cardFont` | no | Font family of the card text. Defaults to `font`. The same rule applies: Inter, or a font installed where the render runs (use a free one; OFL is fine). |
| `background` | no | Background of the cards and of the stage behind the phone on phone scenes: a colour (`"#1F3A5F"`), a gradient `{ from, to, angle }` (`angle` in CSS degrees, default 135: from the top-left to the bottom-right), or an image `{ image, dim }` (a path; it covers the frame, under a black overlay of `dim`, 0 to 1, default 0.35). Default: `primary`. |
| `logo` | no | An image file shown on the intro and outro cards (not on chapter cards). |
| `introTitle` | yes | Title of the intro card. |
| `introSubtitle` | no | Subtitle of the intro card. |
| `music` | no | `{ file, licence }`: your own music track instead of the synthesised bed. `licence` is required and is copied into the audit. |

Without `brand.music`, scenecast synthesises a quiet music bed, so there is nothing to license.

## app

| Field | Required | Meaning |
|---|---|---|
| `baseUrl` | yes | Where the app runs, for example `http://127.0.0.1:4310`. Routes and `goto` paths are relative to it. The app must already be running when you render. |
| `login` | no | Steps that sign in, run before each signed-in scene is recorded (scenes reused from the cache don't sign in), untimed and not recorded. They use the same step format as scenes (`goto`, `type`, `click`, `upload`, `press`, `hover`, `wait`). |
| `storageState` | no | A saved Playwright session file. When set, it is used instead of `login`. `scenecast login <video.yaml>` opens a browser, lets you sign in by hand, and saves the session to this path (useful for SSO or two-factor sign-in). |
| `loginHook` | no | A JavaScript module whose default export is `async (page, context) => {}` and signs in. It is used when there are no `login` steps and no `storageState`. |
| `seed` | no | Runs once before the first recording, in the scene file's folder, with `SCENECAST_BASE_URL` set. A single word naming a file that exists (relative to the scene file), such as `./seed.mjs`, is a script: `.js`, `.mjs`, `.cjs` and `.ts` run with `node`, `.sh` with `sh`, anything else directly. Anything else, such as `node scripts/seed.mjs` or `python db/seed.py`, runs as a shell command. A single word that looks like a path but names no file (`./nope.mjs`) is an error when the scene file loads. Seeding is skipped when every recording is reused from the cache. |
| `nav` | no | The app's navigation bars: a list of `{ selector, edge }` with `edge` `left` (a sidebar) or `top` (a bar along the top). A zoom shows a declared nav whole or leaves it out, never cut partway. |
| `initScript` | no | JavaScript run in every page before the app's own scripts: a `.js`, `.mjs` or `.cjs` file (relative to the scene file), inline code, or a list of them. A single word with a script extension that names no file is a load error (`app.initScript: no such file: <path>`). See [init scripts and routes](#init-scripts-and-routes). |
| `routes` | no | Network responses to fake: a list of `{ url, status, json, body, headers, module }`. See [init scripts and routes](#init-scripts-and-routes). |
| `panels` | no | Extra CSS selectors for the app's open panels (pop-overs, drawers), added to the built-in list. Captions keep clear of them, and the audit checks that they do. |

A scene with `signedOut: true` is recorded without the session.

When the app keeps its sign-in in **sessionStorage** (not only in cookies), the unattended sign-in and
`scenecast login` save it in a second file next to the session (`<session>.session-storage.json`), and every
recording restores it once per tab, before the app's scripts run. An app that clears it (by signing out, say) is not
signed back in on its next navigation. The session files the unattended sign-in (`app.login` or `app.loginHook`)
writes for a recording are deleted when that recording ends, even when it fails. The files `scenecast login` writes
next to `app.storageState` (the session and its `.session-storage.json`) are kept, since later renders use them: keep
both out of version control.

### Init scripts and routes

Both apply to every browser context scenecast opens on the app: the recording, the unattended sign-in, the prewarm and
`scenecast login`. They do not apply to card pages.

- **`initScript`** runs as each document is created, **before `<html>` exists**: `document.documentElement` and
  `document.body` are still `null`. Code that touches the page must wait for it:

  ```yaml
  initScript: "document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.demo = 'video'; });"
  ```

  Setting globals, `localStorage` values or feature switches the app reads at start-up works at once.
- **`routes`** answer matching requests instead of the network. `url` is a Playwright glob and may match any origin
  (`**/api/flags` also matches `https://api.example.invalid/api/flags`). Give at most one of:
  - `json`: a value sent as JSON (`content-type: application/json`);
  - `body`: a string sent as is;
  - `module`: a JavaScript file whose default export is `async (route, request) => {}` and answers the request
    itself (with `route.fulfill`, `route.continue` or `route.abort`).

  `status` defaults to 200 and `headers` are added to the response. Use more than one of `json`, `body` and `module`
  and the file fails to load (`app.routes[<k>]: use one of json, body, module`). A `json` or `body` answer gets CORS
  headers for the requesting page (unless `headers` sets `access-control-allow-origin`), and CORS preflights are
  answered for every route. A `module` route builds its own response, so a module that answers an API on another
  origin must set the CORS headers itself (`access-control-allow-origin`, plus `access-control-allow-credentials:
  true` when the app sends cookies), or the browser drops the answer.

  Routes suit feature flags, a third-party widget that would otherwise load slowly, or an API that is not running
  where the video is made.

## voice

| Field | Default | Meaning |
|---|---|---|
| `name` | `af_heart` | A Kokoro voice. |
| `lang` | `en-us` | Language code. |
| `speed` | `0.9` | Speaking rate (1.0 is Kokoro's normal speed). |
| `phraseGapSec` | `0.2` | Silence between phrases, in seconds. |
| `clauseGapSec` | `0.15` | Silence after a phrase that ends at `:` or `;`. `0` gives the v1 rhythm. |

The narration is split into phrases at sentence ends (`.`, `!`, `?`, `…`), and after `:` or `;` when both sides have
at least 3 words (so "To sign the work agreement: tick the box, …" is two phrases, but a short list such as "speed;
care" stays whole). A sentence longer than about 140 characters is split again at commas, with `phraseGapSec` between
the parts.

Each word's time comes from forced alignment of the known script against the voice, so every narration word has
exactly one time, whatever its punctuation, hyphens or numbers ("sign-in", "$1,500", "9:30").

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
| `setup` | no | App scenes: steps run after `route` opens and before recording starts, untimed and not filmed, so the scene starts part-way through a flow (an open drawer, step 2 of a wizard). See [setup](#setup). |
| `seconds` | title scenes: yes | The card's minimum length. It runs longer if the narration needs it. |
| `zoom` | no | App scenes: `{ sel, pad }`. The scene starts zoomed on this element (measured before recording starts, after `setup`), until its first `zoom` or `unzoom` step, or the scene end. A selector that matches nothing fails the recording (`scene "<id>" zoom selector "<sel>" not found`). A zoom that grows to hold a declared nav and so becomes the full frame prints a warning (`scene "<id>": zoom on <sel> became the full frame because it holds nav <nav>`). |
| `cursor` | no | App scenes: where the cursor starts in this scene (a [spot](#cursor)). Overrides `cursor.start`. |
| `page` | no | Title scenes: an HTML file shown as the card instead of the drawn one (see [card pages](#card-pages)). On an app scene it is ignored, with a warning. |

### setup

Some places in an app have no URL: a drawer opened by a button, step 3 of a wizard, a form half filled in. `setup`
gets the page there before the take starts, the way `app.login` signs in: its steps run as fast as possible after
`route` has opened and settled, the page settles after each one, and none of it is in the video. The scene's first
frame shows the result.

```yaml
- id: attach
  kind: app
  route: /requests
  setup:
    - { do: click, sel: "#new-request" }
    - { do: type, sel: "#request-title", text: A new monitor }
    - { do: click, sel: "#wizard-next" }
  narration: Attach a quote, and send the request.
  steps:
    - { cue: Attach, do: upload, sel: ".dropzone", file: ./quote.pdf }
    - { cue: send, do: click, sel: "#wizard-submit" }
```

Setup steps use the step format without `cue`, `occ` or `offset`: `click`, `type` (fills the field at once),
`hover`, `check`, `upload`, `press`, `scroll`, `wait` and `goto`. What only matters on camera (`zoom`, `ring`,
`unzoom`, `park`) is a load error; make it a scene step. The scene's `zoom` and the declared navs are measured after
setup, so a scene can start zoomed on the drawer setup opened. A setup selector that matches nothing fails the
recording with `scene "<id>" setup step <i> selector "<sel>" not found`. Prefer `setup` to an `app.initScript`
that fakes the state: it drives the app as a person would, so it keeps working when the app's internals change.

The video is an intro card (3 s by default, music only), then every scene in order, then an outro card (3 s) with
`title`. See [cards](#cards).
A render with `--only <id>` leaves out the intro and outro cards and writes `<output>-<id>.mp4` and `<output>-<id>.srt`.

## steps

```yaml
- { cue: Sign in, occ: 2, do: click, sel: "#signin" }
```

| Field | Meaning |
|---|---|
| `do` | `click`, `type`, `hover`, `check`, `upload`, `scroll`, `press`, `zoom`, `unzoom`, `ring`, `park`, `wait` or `goto`. |
| `cue` | A word or phrase from the narration (case-insensitive, whole words). The step lands on its first word. |
| `occ` | Which occurrence of the cue, counting from 1 (default 1). Use it when the cue appears more than once: in "To sign in, … and press Sign in", the button is `occ: 2`. |
| `offset` | Seconds added to the cue time (negative is earlier). |
| `sel` | A CSS selector, or a list of them. `click`, `type`, `hover`, `check`, `upload`, `zoom` and `ring` need one. With a list, the box is the union of all matches and the pointer aims at the first. |
| `text` | What `type` types, the key `press` presses (default `Enter`), or the path `goto` opens. |
| `file` | `upload`: the file to choose, or a list of files, relative to the scene file. A file that does not exist is a load error (`scene "<id>" step <i>: upload file not found: <path>`). |
| `ms` | `zoom`: how long it holds after easing in (default 2000). `ring`: how long it holds (default 1200). `wait`: how long to wait. Any step: the minimum time before the next uncued step. |
| `pad` | Pixels added around the box of a `zoom` or `ring`. |
| `ring` | `true` on another step (for example a `click`) draws a ring around its target as well. |
| `ringSel` | `click`, `type`, `hover`, `check` and `upload`: ring this element instead of the step's target (a selector or a list). Implies `ring: true`. |
| `ringMs` | The same steps: how long that ring holds (default 1200). |
| `glideMs` | `click`, `type`, `hover`, `check`, `upload` and `park`: how long the cursor takes to get there (default 520). |
| `by` | `scroll`: scroll the window by this many px (positive is down). |
| `to` | `scroll`: scroll the window to this `scrollY`. A scroll step takes one of `sel`, `by` and `to`. |
| `at` | `park`: where the cursor goes (a [spot](#cursor)). Default `cursor.park`, or `right` when that is `off`. |
| `settle` | `false` skips the wait for the page to settle before this step. |

What each action does:

- **click, type, hover.** The cursor glides to the element and the action happens on the cue word. `type` clicks
  the field, then types `text` one character at a time.
  A `hover` cannot ring an element that the hover itself reveals (a tooltip, a menu that opens on hover): the ring is
  measured as the cursor arrives, before it appears. Ring it from the next step instead, for example
  `{ cue: …, do: ring, sel: ".tooltip" }`. A hover that moves what it rings (a row that lifts or grows on hover) is
  fine: a hover's `ringSel` ring waits for the transitions and animations on those elements and their ancestors to
  finish (at most 0.4 s after the cue) and is drawn round them where they come to rest.
- **check.** Ticks a checkbox or switch: the cursor glides to it, and it is clicked only when it is not already
  checked, so a re-render over seeded data that already has it ticked stays the same. The recording fails when it
  is still unchecked afterwards (`scene "<id>" step <i>: <sel> is not checked after the click`). `sel` must be the
  element that carries the state: the `<input type=checkbox>` itself, or the element with `role="switch"` (or
  `role="checkbox"`) and `aria-checked`, not a label or a wrapper around it.
- **upload.** Chooses a file the way a viewer would: the cursor glides to `sel` (the button, label or drop zone that
  opens the file chooser) and clicks it on the cue, and the file chooser that opens is answered with `file` (no
  dialog shows in the video). `sel` must be something visible that opens the chooser when clicked, not a hidden
  `<input type=file>`; a click that opens no chooser within 2 s fails the recording (`clicking "<sel>" opened no file
  chooser; point sel at the button, label or drop zone that opens it`). The files' contents are part of the cache
  key, so changing a file records the scene again. `upload` works in `app.login` too.

  ```yaml
  - { cue: attach, do: upload, sel: ".dropzone", file: ./files/quote.pdf }
  ```
- **press.** Presses a key (`text`, default `Enter`).
- **scroll.** With `sel`, scrolls the element into the middle of the view (in whatever container scrolls it). With
  `by` or `to`, scrolls the **window**; with none of them, it scrolls the window down by most of a screen. `by` and
  `to` do not move a scroller nested inside the page (a scrolling panel or table): use `sel` on an element inside it.
  A `by` or `to` scroll that leaves the window where it was fails the recording, naming the likely nested scroller.
- **zoom.** Eases the view in to the element (0.7 s), holds it for `ms` (default 2 s) or until the `unzoom` that
  closes it, then eases out. A zoom ended by an `unzoom` may not also set `ms`. The zoomed region keeps the
  frame's 16:9 shape, magnifies at most 2.5×, keeps 24 px of space around the target, stays inside the frame, and
  shows a declared nav whole or not at all. A target too big to need a zoom gets the full frame. When holding a
  declared nav whole is what makes the region the full frame (a large `pad` reaching a top bar, say), render and
  preview print a warning: `scene "<id>" step <i>: zoom on <sel> became the full frame because it holds nav <nav>`
  (see [troubleshooting](troubleshooting.md#crop-fails)).
- **unzoom.** Eases the zoom out, starting on its cue (it needs a `zoom` step before it in the scene, or the scene's
  own `zoom`, which it then ends). It has no `sel`.
  Use it to end a zoom on a word ("…comes **first**") instead of after a fixed `ms`.
- **ring.** Draws a highlight ring around the element.
- **park.** Glides the cursor to a [spot](#cursor) out of the way (`at`, default `cursor.park`). Not allowed on phone
  scenes, which have no cursor (use `wait` to hold). Parking also happens by itself; see [cursor](#cursor).
- **goto.** Opens a path in the app.
- **wait.** Pauses.

The first pointer step of a scene that comes too soon after the scene starts for a glide is **pre-positioned**: the
cursor is already on its target from the first frame, and the action fires on its cue. On a phone scene, a
pre-positioned first tap's touch indicator appears at the tap without fading in.

A step without a `cue` runs right after the step before it (plus that step's `ms`). Only steps with a cue are checked
for sync by the audit, so give a cue to every step a viewer should see happen on a word.

Before each step the recorder waits for the page to settle: no document, XHR or fetch requests in flight, a stable
layout, and no visible loading indicator (`[aria-busy=true]`, `[role=progressbar]` without a value, `.is-loading`,
`.skeleton` or `[data-scenecast-loading]`). Open panels (`[role=dialog]`, `[role=menu]`, `[role=listbox]`,
`[aria-modal=true]`, `[data-scenecast-panel]`, or a selector in `app.panels`) are measured so captions keep clear of them.

## cursor

| Field | Default | Meaning |
|---|---|---|
| `start` | `center` | Where the cursor is when a scene starts. A scene's own `cursor` overrides it. |
| `park` | `right` | Where the cursor parks between distant pointer steps, or `off`. |
| `parkAfterSec` | `2.5` | Park when the next pointer step, or the scene end, is more than this many seconds after a pointer action. |

A **spot** is `center`, `left`, `right` (96 px in from that edge, at 45% of the height, clear of the caption bands) or
`{ x, y }` in viewport CSS pixels. The park glide starts 0.6 s after the action, or when it ends (typing done), whichever is
later, and never runs into the next glide. Only the drawn cursor parks: the real mouse stays where it was, so a menu
that opens on hover stays open. Set `park: off` for the v1 behaviour.

## phone scenes

A scene with `viewport: phone` is recorded at 390×844 with touch input, and drawn in a phone outline on the brand
stage (`brand.background`). With `phone.align: left` (the default) the phone's centre is at 30% of the frame width,
with captions in a column beside it; `right` puts it at 70%; `center` is the v1 layout, with captions below.

- A tap has no glide: a 34 px touch indicator in `brand.accent` fades in 0.25 s before the tap, taps on the cue, and
  fades out. `brand.accent` may be any CSS colour; one that is not a colour warns and falls back to `#F5C518`.
- `park` steps are not allowed (there is no cursor).

## Captions

Captions come from the narration, shown as a sequence of rounded boxes of at most 2 lines of about 42 characters.
A phrase is cut at clause punctuation (`, : ; — .`) first, never right after a function word ("the", "to", "your",
…), and never between a possessive and its noun. The same holds for the line break inside a caption: rather than end a
line on "your", the caption moves the word down, rebalancing its lines, or adds a caption when its lines would
otherwise run past 42 characters. Only a phrase that cannot be cut any other way ends a line on a function word.

Each caption takes the first position that covers nothing it must keep clear (the target, the cursor's destination, a
ring, an open panel), trying bottom, top, bottom-left, bottom-right, top-left and top-right in that order. During a
zoom they are placed against what is on screen at that moment. A box that covers 90% or more of the screen as shown
(a whole-page container, say) is not kept clear, since nothing could avoid it. On a phone scene with the phone at the
side, captions go in the column **beside** the phone (up to 30 characters a line, 3 lines), and fall back to the bottom
or top when that column is blocked. The same text is written to `<output>.srt`.

## Output

`scenecast render video.yaml` writes, in `out/` (or `--out <dir>`):

- `<output>.mp4`: 1920×1080, 30 fps, H.264 with AAC audio, loudness-normalised to −16 LUFS.
- `<output>.srt`: the captions.
- `chapters.txt`: `HH:MM:SS Title` for each scene.
- `audit/`: `audit-table.md`, `audit.json`, `contact-sheet.png` and `frames/`. See [audit.md](audit.md).

Intermediate files go to `work/<id>/` (or `--work <dir>`). Each stage there is reused when its inputs have not
changed. A render (or preview) locks that folder while it runs (`work/<id>/.lock`, holding its pid): a second render
of the same video into the same folder stops at once with `work dir <dir> is in use by another render (pid <pid>)`.
The lock is removed when the render ends, fails or is stopped; one left by a process that is gone is taken over.
