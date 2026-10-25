# The audit

After every render, scenecast audits the finished video moment by moment and writes the result to `out/audit/`.
`scenecast render` exits with code 1 when any check FAILs, so a script or CI job can stop on a bad video. A WARN never
fails the render. `--no-audit` skips the audit and removes any older `out/audit/`, so a stale audit is never left next
to a new video.

The audit does not trust the plan. It transcribes the final mix with faster-whisper to find when each cue word is
really heard, and it reads the boxes the recorder measured in the live page.

## Files

| File | What it is |
|---|---|
| `audit-table.md` | The verdict, the loudness, one row per cued step, the scenes without cued steps, and the narration diff. Read this first. |
| `audit.json` | The same data, for scripts. |
| `contact-sheet.png` | One thumbnail per zoom and ring moment, framed in green (PASS), amber (WARN) or red (FAIL). |
| `frames/` | Those frames at full size, named `<scene>-<cue>.png`. |

## The table

Each cued step is one row:

| Column | Meaning |
|---|---|
| scene, cue | The step. |
| word time | When the cue word is heard in the final video (seconds). `(plan)` means it was not heard, and the planned time was used instead. |
| action time | When the action happens in the final video. |
| gap | action time minus (word time + the step's `offset`). |
| target label | The step's selector. |
| caption side | Where the caption was at the action: `bottom`, `top` or `none`. |
| checks | Every check and its result. |
| verdict | The worst check: PASS, WARN or FAIL. |

## Checks

| Check | FAIL when | Typical fix |
|---|---|---|
| **sync** | The action is more than 0.30 s from its cue word, or retiming cut it out. | Move the cue to the word that names the action; use `offset` for a deliberate lead or lag. A large gap usually means a slow page: see [troubleshooting](troubleshooting.md). |
| **target** | The ring or zoom box does not contain the element's box (measured at the ring's peak), or no target was logged. | Point `sel` at the element the narration names; add `pad`; make sure the element is still on screen when the ring peaks. |
| **captions** | A caption overlaps the target, the cursor's destination, a ring or an open panel by more than 0 px, judged on screen, including during a zoom. | Usually automatic. If both the top and the bottom are blocked, zoom less, move the target, or split the step across a shorter phrase. |
| **crop** | The zoom leaves the frame, the target is closer than 24 px to the zoom's edge, or the zoom cuts a nav partway. | Zoom a slightly larger element; declare the app's nav bars in `app.nav`. |
| **loading** | A spinner or skeleton was visible just before the action. WARN when the page had not settled before the step (the settle wait timed out). | Seed the data first, add `prewarm` routes, or add a cue-less `wait` step before it. |
| **plan** | The plan has no zoom where a zoom step expected one, or no ring box was logged for a ring step. | Re-render with `--fresh`; if it persists, report it. |
| **word** | (WARN) The cue word was not found in the transcript, so the planned time was used. (A misheard word is already matched by its position; this means nothing was heard there.) | See [troubleshooting](troubleshooting.md#the-cue-word-was-not-heard): for a name, add it to `audit.allowList`; otherwise choose a more distinct cue word, or listen to how the voice says it. |

Three checks cover the whole video:

| Check | FAIL when |
|---|---|
| **loudness** | The mix is outside −16 ±1 LUFS, or its true peak is above −1.5 dBTP. |
| **blank frames** | Any frame inside an app scene is near-uniform, such as a blank page between two navigations. Only the app's screen counts (the phone screen on phone scenes), captions are left out, and cards and the dissolves into and out of them are skipped. The times are listed. |
| **narration** | Never FAILs. A WARN shows a diff (`-"expected" +"heard"`) when the transcript differs from the script after normalising numbers, case and punctuation. A word or name in `audit.allowList` may be heard differently, including as one more word (for example "worklist" heard as "work list"), without a WARN. An allow-listed cue that recognition leaves out entirely is placed by position: at the gap the heard words around it leave. |

Scenes without cued steps (chapter cards, for example) get a captions check of their own.

## Read every moment

Read every row of `audit-table.md` and every tile of `contact-sheet.png`, not a sample. A video can pass on most
moments and still show a caption over a button, or a ring around the wrong element, on one. The audit is there so that
nobody has to watch the whole video frame by frame, but only if all of it is read.

The demo video in `examples/demo-app` passes with every cued moment at PASS: the median gap between word and action is
0.013 s and the largest is 0.127 s.

## What the audit does not check

- A caption over the target of an **earlier** step that is still on screen. Each row protects its own step's target
  and its open panels; the previous step's element is not protected once a new step has started. Keep the zoom pointed
  at what the narration names. See [troubleshooting](troubleshooting.md).
- Whether the narration is a good script. It checks that the words were spoken, not that they make sense.
