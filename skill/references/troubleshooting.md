# Troubleshooting

## Setup

**`scenecast doctor` reports MISSING.** Run it again: it sets up what is missing (uv, the Python environment, the
Kokoro and Whisper models) and needs the network the first time. None of it needs admin rights: uv goes to
`~/.local/bin` (or `~/.cache/scenecast/bin` when that folder is not writable) and the models go to
`~/.cache/scenecast/`. `SCENECAST_CACHE` moves that cache.

Chromium is installed separately, in the scenecast checkout: `pnpm -C packages/cli exec playwright install chromium`.
On Linux it may also need system libraries; `playwright install --with-deps chromium` installs them, and that step
needs admin rights.

**Windows.** Not supported. Use macOS, Linux, or WSL on Windows.

## Time

Expect, for each minute of finished video:

| Stage | Time |
|---|---|
| Compose (drawing the video with zoom, rings, captions and cards) | about 2× the video length |
| A whole cold render | about 3.5 to 7× the video length: recording runs in real time, and the voice and speech recognition add to it |
| A re-run with nothing changed | under a second: every stage is reused from `work/<id>/` |

The demo (about 46 s of video) takes about 3 minutes cold on a 12-core Linux PC; an Apple silicon Mac is slower (4 to
5 minutes for the 44-second v1 demo). A busy machine is slower.
`scenecast render` prints the time of each stage that ran at the end.

The cache is keyed on the scene file, the saved session, the login hook and the seed script, not on the app itself.
When the **app** has changed, render with `--fresh` so every scene is recorded again. `--only <sceneId>` re-renders a single scene (without the intro and outro
cards) while you work on it.

## One render per work dir

**`work dir <dir> is in use by another render (pid <pid>); wait for it to finish, or render into another dir with
--work <dir>`.** Each render (and preview) locks the video's work dir, `work/<id>/`, while it runs: two renders writing
the same stages at once would corrupt them (the voice stage failed with a libsndfile error). Wait for the other render
to finish, stop it, or give this one its own `--work <dir>`. The lock (`work/<id>/.lock`) is removed when the render
ends, fails or is stopped with Ctrl-C; one left by a process that is no longer running (after a crash or a kill -9) is
taken over by the next render, so it never needs deleting by hand.

## One render per process

Revideo, which draws the video, changes process-wide state (environment variables and patched modules). A process
therefore renders, or previews, only once. The CLI runs one command per process, so this only matters when you call
`render()` from your own code: start a new process for each video.

## Sync FAILs

Retime places every recorded action on its cue word, so a slow page shows up as trimmed waiting, not as a late
action. A sync FAIL has one of two causes:

**The action time is `—` ("cut by retime").** The action fell inside a stretch retime removed. This happens when the
take is far behind the voice and there is no quiet time to trim. Give the page less to do before the step (seed the
data with `app.seed`, open slow routes in `prewarm`), or give the narration more time before the cue.

**The gap is large but the action time is set.** Speech recognition placed the cue word away from where the voice
says it. Check the word time column against the narration diff; if the word was misheard or dropped, see the next
item.

<a id="the-cue-word-was-not-heard"></a>**The cue word was not heard (`(plan)` in the word time column).** A word recognition merely
misheard is already matched by its position, so this means nothing was heard where the cue should be. The narration diff
at the bottom of `audit-table.md` shows what was heard around it. Then:

- **A name or product word** (recognition often drops or merges these): add it to `audit.allowList`. An allow-listed cue
  that is left out is placed by position, in the gap the heard words around it leave.
- **An ordinary word**: choose a more distinct cue word for the step, one that is clearly spoken and not swallowed by
  its neighbours (for example "press **Sign** in the corner" rather than a short word at the end of a fast phrase).
- **Check how the voice says it.** Listen to the scene's voice in `work/<id>/voice/<scene>/voice.wav`. If Kokoro
  mispronounces or rushes the word, respell it in the narration (for example spell out an abbreviation).

**A cue at the start of a scene.** A pointer step cued on one of the first words has no time to glide from the
scene's start position. The first pointer step of a scene is then pre-positioned: the cursor is on its target from
the first frame and the action fires on the cue, so it is not late. Only the first one is: a second early step glides
faster from the first to still land on its word. If the cursor appearing on the target looks abrupt, put the cue a
few words later, or set the scene's `cursor` near the target.

**The cue is ambiguous.** A cue matches whole words, case-insensitively. When the cue appears more than once, set
`occ`. In "To sign in, type your email, and press Sign in", the button is `{ cue: Sign in, occ: 2 }`.

## Caption FAILs

**A caption covers the target.** Each caption tries bottom, top, then the four corners, and takes the first position
that covers nothing it must keep clear. When every position covers something, it takes the one that covers least, and
the captions check in the table gives the reason, `no free position; <side> overlaps least` (or `all equal, <side> kept`). Then zoom to
a smaller element, close a panel the step does not need, or move the step to a phrase when less is on screen. Point
the zoom at what the narration names: a zoom on a whole page leaves no room anywhere.

**A caption covers a panel the audit does not know.** Built-in panels are dialogs, menus, listboxes and modals. Add
the app's own pop-overs and drawers to `app.panels` (CSS selectors), and captions keep clear of them too.

**A caption covers the previous step's target, and the audit passes.** The audit protects each step's own target,
not an earlier one that is still on screen. Keep the zoom pointed at what the narration names, so the thing being
talked about is the thing being protected. Watch for this on the contact sheet.

## Crop FAILs

**The zoom cuts the nav.** Declare the app's navigation bars in `app.nav`:

```yaml
app:
  nav:
    - { selector: aside.sidebar, edge: left }
    - { selector: header.topbar, edge: top }
```

A zoom then shows each declared nav whole or leaves it out.

**`zoom on <sel> became the full frame because it holds nav <nav>`** (a warning from render or preview), often followed
by a target FAIL such as `zoom 0,0 1920x1080 does not contain target`. The zoom's region (the element plus `pad`)
reached a declared nav, so it grew to show that nav whole, and that made it the whole frame: no zoom at all. Use a
smaller `pad` (on the scene's `zoom` or the step), or zoom on an element that is clear of the nav.

**The target is too close to the zoom's edge.** Zoom a slightly larger element (its card or section), so the zoomed
region has room around it inside the frame.

## Narration WARNs

A WARN such as `-"worklist" +"work list"` means speech recognition heard the word differently. If the voice is fine,
add the word to the scene file:

```yaml
audit:
  allowList: [worklist, Demo Co]
```

A narration WARN never fails the render, but read it: it is also how you catch a word that was mispronounced or
dropped. In the demo, the first word after the silent intro card ("Welcome") is sometimes not heard; that WARN is
known.

## Blank frame FAILs

A page that goes blank while it navigates is frozen over automatically: when recording, scenecast finds near-uniform
frames in each take and replaces them with the last good frame before them, in the take itself. That frame is the one
on screen at the action that started the navigation (a click on Sign in, say), so the action stays visible, and the
blank frames right after it never reach the video. The render log says `record/<scene>: 1 blank frame run(s) in the
take; froze 1 on the last good frame`. A blank-frame FAIL means a near-uniform frame is left in an app scene. The
times in the audit say where to look.

- **The screen really is near-uniform.** A zoom on a plain area, or a page that is mostly one colour, measures as
  blank (a false FAIL for what the viewer sees, but a dull shot). Zoom to a region with content (text, controls), or
  make the step show something.
- **Anything else** is unexpected: blank runs in a take are frozen over, including where the video holds a frame while
  it waits for the next action. Re-render with `--fresh`, and report it if it persists.

## The cursor

**The cursor sits on an input, or over what the narration is about.** After a click or typing, the cursor stays
where it acted. When the next pointer step (or the scene end) is more than `cursor.parkAfterSec` (2.5 s) away, it
parks by itself at `cursor.park` (96 px in from the right edge by default). To move it sooner, or somewhere else, add
a `{ do: park }` step (with `at` for the spot); to start a scene with the cursor out of the way, set the scene's
`cursor` (for example `cursor: right`). `park` is not allowed on phone scenes: there is no cursor, and the touch
indicator fades by itself (use `wait` to hold).

**A hover step cannot ring what it reveals.** The ring is measured as the cursor arrives, before a tooltip or hover
menu appears. Ring the revealed element with a separate `ring` step cued a word or two later. A hover that only moves
what it rings (a row that lifts 2 px on hover) needs nothing: its `ringSel` ring waits up to 0.4 s for the hover's
transitions to finish and is drawn where the element comes to rest. A transition longer than that can still leave
the ring off by the rest of the movement.

## Steps that fail while recording

- **`<sel> is not checked after the click`** (a `check` step). `sel` must be the element that holds the state: the
  `<input type=checkbox>` itself, or the element with `role="switch"` and `aria-checked`, not its label or a wrapper.
- **`the page did not scroll`** (a `scroll` step with `by` or `to`). `by` and `to` scroll the window. Most app
  layouts scroll inside a container (a main panel, a table), so the window does not move. Use `scroll` with `sel` on
  an element inside that container: it is scrolled into the middle of the view, whichever element scrolls.
- **`zoom selector "<sel>" not found`** (a scene's `zoom`). The element is measured before recording starts, on
  `route`: it must be there without any step.
- **`brand.accent "…" is not a CSS colour; the touch indicator uses #F5C518`** (a warning on a phone scene). The
  render goes on with the default yellow; give `brand.accent` a CSS colour (`#rrggbb`, a name, `rgb(…)`) to use yours.

## Loading FAILs

A spinner or skeleton was visible just before the action. scenecast treats `[aria-busy=true]`, a
`[role=progressbar]` without a value, `.is-loading`, `.skeleton` and `[data-scenecast-loading]` as loading. Seed the
data, prewarm the route, or wait. A spinner that the action itself brings up is its result and does not fail.

## Sign-in

`login` steps run before each signed-in scene that is recorded, so a cold render signs in once per scene. If the app
limits sign-ins, or for SSO or two-factor sign-in, use `scenecast login video.yaml` to sign in by hand
and save `app.storageState`, or write an `app.loginHook`. The saved session holds credentials: keep it out of version
control, together with the `<session>.session-storage.json` file saved next to it when the app keeps its sign-in in
sessionStorage.

**The app keeps its sign-in in sessionStorage.** Cookies and localStorage are in the Playwright session; sessionStorage
is not, so scenecast saves it separately (the sessionStorage of `baseUrl`'s origin, next to the session file) and
restores it once per tab before the app's scripts run. An app that clears it mid-video (signing out, rotating a
token) is not signed back in on its next navigation. One exception: the "already restored" mark lives in
`window.name`, which the browser clears on a navigation to another site. If the video signs out through an identity
provider on another site and then comes back, the saved sessionStorage is applied again and the app may show as
signed in. Record the signed-out part as its own scene with `signedOut: true`.

## Feature flags, slow third parties and init scripts

- **Turn a feature on for the video** with `app.routes`: answer the app's flags request with the values you want, for
  example `{ url: "**/api/flags", json: { sso: true } }`. The glob matches any origin, so an API on another host
  works too.
- **A `module` route on another origin answers, but the app never sees it.** A module builds its own response, so it
  must add the CORS headers itself: `access-control-allow-origin` set to the app's origin, and
  `access-control-allow-credentials: true` when the app sends cookies. (`json` and `body` routes get them
  automatically.)
- **An `initScript` that touches the page does nothing**, or throws `Cannot read properties of null`. Init scripts run
  before `<html>` exists. Wrap such code in
  `document.addEventListener('DOMContentLoaded', () => { … })`; setting globals or storage works at once.

## Fonts

Captions and drawn cards use `brand.font` and `brand.cardFont`. Inter is bundled and always available. Any other font
must be installed where the render runs, or the render fails and names it (it never falls back silently). The check
runs when the video is composed, after the voice and the recordings, so try a short `--only` render first after
changing the font; a name the system maps to an installed font (an alias) counts as installed. Card
**pages** (`cards.introPage`, `cards.outroPage`, a title scene's `page`) are rendered by Chromium with the host's
fonts, not the bundled ones: ship the font file next to the page and load it with `@font-face`.

## Tests

`pnpm test` runs the unit tests. The full end-to-end render of the demo is slow and runs only with `SCENECAST_E2E=1`:

```sh
SCENECAST_E2E=1 pnpm -C packages/cli exec vitest run -t e2e
```

The recorder timing test (`packages/core/test/record.test.ts`) can fail on a heavily loaded machine, because it
measures real time. If it is the only failure, run it again on its own:

```sh
pnpm -C packages/core exec vitest run test/record.test.ts
```

## The render stops with "No usable sandbox!" (Linux)

Ubuntu 23.10 and later, and CI runners built on it, block the unprivileged user namespaces Chromium's sandbox needs.
scenecast therefore runs the final render's Chromium without its sandbox on Linux, as Playwright already does for the
recording; the page it loads is scenecast's own, built locally. Set `SCENECAST_CHROME_SANDBOX=1` to keep the sandbox
on a system that allows it.
