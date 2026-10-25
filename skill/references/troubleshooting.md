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

The demo (about 44 s of video) took about 2.5 minutes cold on a 12-core Linux PC and 4 to 5 minutes on an Apple
silicon Mac. A busy machine is slower.
`scenecast render` prints the time of each stage that ran at the end.

The cache is keyed on the scene file, the saved session, the login hook and the seed script, not on the app itself.
When the **app** has changed, render with `--fresh` so every scene is recorded again. `--only <sceneId>` re-renders a single scene (without the intro and outro
cards) while you work on it.

## One render per process

Revideo, which draws the video, changes process-wide state (environment variables and patched modules). A process
therefore renders, or previews, only once. The CLI runs one command per process, so this only matters when you call
`render()` from your own code: start a new process for each video.

## Sync FAILs

**The gap is large and positive (the action is late).** The page was slow before the action: a request was still in
flight, or a loading indicator was up. Seed the data with `app.seed`, open slow routes in `prewarm`, or put a cue-less
`wait` step earlier in the scene so the page is ready.

<a id="the-cue-word-was-not-heard"></a>**The cue word was not heard (`(plan)` in the word time column).** A word recognition merely
misheard is already matched by its position, so this means nothing was heard where the cue should be. The narration diff
at the bottom of `audit-table.md` shows what was heard around it. Then:

- **A name or product word** (recognition often drops or merges these): add it to `audit.allowList`. An allow-listed cue
  that is left out is placed by position, in the gap the heard words around it leave.
- **An ordinary word**: choose a more distinct cue word for the step, one that is clearly spoken and not swallowed by
  its neighbours (for example "press **Sign** in the corner" rather than a short word at the end of a fast phrase).
- **Check how the voice says it.** Listen to the scene's voice in `work/<id>/voice/<scene>/voice.wav`. If Kokoro
  mispronounces or rushes the word, respell it in the narration (for example spell out an abbreviation).

**The cue is ambiguous.** A cue matches whole words, case-insensitively. When the cue appears more than once, set
`occ`. In "To sign in, type your email, and press Sign in", the button is `{ cue: Sign in, occ: 2 }`.

## Caption FAILs

**A caption covers the target.** Captions move to the top when the action is in the bottom quarter. When both sides
are blocked (a tall zoom, or a panel across the screen), zoom to a smaller element, or move the step to a phrase when
less is on screen.

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
frames in each take and holds the last good frame over them. A blank-frame FAIL means a near-uniform frame is left in an app scene. The times in the audit say where to look.

- **The screen really is near-uniform.** A zoom on a plain area, or a page that is mostly one colour, measures as
  blank (a false FAIL for what the viewer sees, but a dull shot). Zoom to a region with content (text, controls), or
  make the step show something.
- **Anything else** is unexpected: blank runs in a take are frozen over, including where the video holds a frame while
  it waits for the next action. Re-render with `--fresh`, and report it if it persists.

## Loading FAILs

A spinner or skeleton was visible just before the action. scenecast treats `[aria-busy=true]`, a
`[role=progressbar]` without a value, `.is-loading`, `.skeleton` and `[data-scenecast-loading]` as loading. Seed the
data, prewarm the route, or wait. A spinner that the action itself brings up is its result and does not fail.

## Sign-in

`login` steps run once per render. For SSO or two-factor sign-in, use `scenecast login video.yaml` to sign in by hand
and save `app.storageState`, or write an `app.loginHook`. The saved session holds credentials: keep it out of version
control.

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
