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
| `audit-table.md` | The verdict, the loudness and blank frames, one row per cued step, the "Scene checks" table, and the narration diff. Read this first. |
| `audit.json` | The same data, for scripts: `moments` are the table's rows, `scenes` the scene checks. |
| `contact-sheet.png` | One thumbnail per zoom and ring moment, framed in green (PASS), amber (WARN) or red (FAIL). |
| `frames/` | Those frames at full size, named `<scene>-<cue>.png`. |

## The table

Each cued step is one row:

| Column | Meaning |
|---|---|
| scene, cue | The step. |
| word time | When the cue word is heard in the final video (seconds), and where that time came from: `forced` (forced alignment of the script against the mix), `onset` (the phrase's first word, from where the voice starts on its clean clip), `free` (the free transcript, when alignment fell back for that phrase) or `plan` (not heard: the planned time was used). |
| action time | When the action happens in the final video. |
| gap | action time minus (word time + the step's `offset`). |
| target label | The step's selector. |
| caption side | Where the caption was at the action: `bottom`, `top`, `bottom-left`, `bottom-right`, `top-left`, `top-right`, `beside` (next to the phone) or `none`. |
| checks | Every check and its result. |
| verdict | The worst check: PASS, WARN or FAIL. |

## Checks

| Check | FAIL when | Typical fix |
|---|---|---|
| **sync** | The action is more than 0.30 s from its cue word, or retiming cut it out. | Move the cue to the word that names the action; use `offset` for a deliberate lead or lag. A large gap usually means a slow page: see [troubleshooting](troubleshooting.md). |
| **target** | The ring or zoom box does not contain the element's box (measured at the ring's peak), or no target was logged. | Point `sel` at the element the narration names; add `pad`; make sure the element is still on screen when the ring peaks. |
| **captions** | A caption overlaps the target, the cursor's destination, a ring or an open panel by more than 0 px, judged on screen, including during a zoom. A box that covers 90% or more of the screen as shown (a full-frame target, such as a page-wide container) is not protected: no caption could avoid it. | Usually automatic. If both the top and the bottom are blocked, zoom less, move the target, or split the step across a shorter phrase. |
| **crop** | The zoom leaves the frame, the target is closer than 24 px to a side of the zoom that is not on the frame edge, or the zoom cuts a nav partway. A side within 0.5 px of the frame edge is exempt (nothing lies beyond it), and on phone scenes so is a side at or past the phone screen's edge. | Zoom a slightly larger element; declare the app's nav bars in `app.nav`. |
| **loading** | A spinner or skeleton was visible just before the action. WARN when the page had not settled before the step (the settle wait timed out). | Seed the data first, add `prewarm` routes, or add a cue-less `wait` step before it. |
| **plan** | The plan has no zoom where a zoom step expected one, no ring box was logged for a ring step, an `unzoom` has no zoom ending within 0.5 s of it, or a scene that starts zoomed has no matching zoom. | Re-render with `--fresh`; if it persists, report it. |
| **word** | (WARN) The cue word was not found in the transcript, so the planned time was used. (A misheard word is already matched by its position; this means nothing was heard there.) | See [troubleshooting](troubleshooting.md#the-cue-word-was-not-heard): for a name, add it to `audit.allowList`; otherwise choose a more distinct cue word, or listen to how the voice says it. |

Three checks cover the whole video:

| Check | FAIL when |
|---|---|
| **loudness** | The mix is outside −16 ±1 LUFS, or its true peak is above −1.5 dBTP. |
| **blank frames** | Any frame inside an app scene is near-uniform, such as a blank page between two navigations. Only the app's screen counts (the phone screen on phone scenes), captions are left out, and cards and the dissolves into and out of them are skipped. The times are listed. |
| **narration** | Never FAILs. A WARN shows a diff (`-"expected" +"heard"`) when the transcript differs from the script after normalising numbers, case and punctuation. A word or name in `audit.allowList` may be heard differently, including as one more word (for example "worklist" heard as "work list"), without a WARN. An allow-listed cue that recognition leaves out entirely is placed by position: at the gap the heard words around it leave. |

### Unzoom rows

An `unzoom` step gets a row like any cued step. Its action time is the end of the zoom it closes (the nearest zoom
end within 0.5 s of it); its target label is empty, and it has sync, captions and loading checks, but no target or
crop check (there is nothing to aim at).

### Scene checks

The "Scene checks" table under the rows has one row per scene that needs checks of its own:

- **A scene that starts zoomed** (`zoom` on the scene): a target check and a crop check for that initial zoom.
- **A scene without cued steps** (a chapter card, for example): a captions check.

### Word times

The free transcript decides whether a cue word was heard at all, and gives the narration diff. A heard cue takes its
time from forced alignment of the known script against the final mix, which returns one time for every script word
(none missed or merged). The first word of a phrase after a silence takes the voice's own onset instead. When the
aligner gives two adjacent spoken words the same start (a short word that got no frames of its own), the later one
starts one alignment frame (0.02 s) on, and the phrase stays forced. A phrase the aligner cannot time sensibly
(three or more words on one start, or times going backwards) falls back to the transcript for that phrase only, and
its words show `free`. A cue that
was not heard WARNs with the plan time, as before.

## Read every moment

Read every row of `audit-table.md` and every tile of `contact-sheet.png`, not a sample. A video can pass on most
moments and still show a caption over a button, or a ring around the wrong element, on one. The audit is there so that
nobody has to watch the whole video frame by frame, but only if all of it is read.

The demo video in `examples/demo-app` passes with every cued moment at PASS: over five cold renders, the median gap
between word and action was 0.007 to 0.011 s and the largest 0.030 s.

## What the audit does not check

- A caption over the target of an **earlier** step that is still on screen. Each row protects its own step's target
  and its open panels; the previous step's element is not protected once a new step has started. Keep the zoom pointed
  at what the narration names. See [troubleshooting](troubleshooting.md).
- Whether the narration is a good script. It checks that the words were spoken, not that they make sense.
