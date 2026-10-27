---
name: scenecast
description: Turn a scene file for a real, running web app into a narrated walkthrough video with scenecast, then audit every moment and fix what fails. Use when asked to make a product demo, walkthrough, tutorial or feature video of a web app from a script, or to fix a scenecast render whose audit FAILed.
---

# scenecast

scenecast records a real web app in Chromium, voices a script with Kokoro, times every action to land on the word
that names it, adds zoom, highlight rings, captions, cards and music, and then audits the finished video moment by
moment. The render fails when any moment is off.

In the commands below, `scenecast` means `node <scenecast checkout>/packages/cli/bin/scenecast.js` (an alias helps).

## When to use it

- Someone wants a narrated video of a web app: a feature tour, an onboarding walkthrough, a how-to, a release demo.
- A scenecast render failed its audit and needs fixing.

Not for: apps that cannot run where the render runs (scenecast drives a live app at `app.baseUrl`), native desktop or
mobile apps, or Windows without WSL.

## Steps

1. **Check the toolchain once.** `scenecast doctor` sets up uv, the Python environment and the models, and reports
   each part. If it reports Chromium missing, run `pnpm -C packages/cli exec playwright install chromium` in the
   scenecast checkout.

2. **Write the script first.** Write the narration scene by scene, in plain spoken sentences. In each sentence, name
   the thing that happens on screen with a word the viewer will hear at that moment: "press **Sign in**", "tick the
   **box**", "open the **account menu**". Those words become cues. Keep one idea per scene.

3. **Write `video.yaml`.** Use [references/scene-format.md](references/scene-format.md). For each action, add a step
   with `cue` (the word from the narration), `do` (click, type, check, upload, zoom, unzoom, ring, park, …) and `sel`
   (a CSS selector). Also:
   - declare the app's sidebar and top bar in `app.nav`, and its own pop-overs or drawers in `app.panels`;
   - make sign-in unattended (`app.login`, `app.storageState` or `app.loginHook`); a sign-in kept in sessionStorage
     is saved and restored too;
   - seed the data the video shows with `app.seed`, so every render shows the same thing;
   - start a scene part-way through a flow (an open drawer, step 2 of a wizard) with the scene's `setup` steps: they
     run before recording starts and are not filmed;
   - switch features on, or answer slow third-party calls, with `app.routes`; set things up before the app's own
     scripts with `app.initScript` (it runs before `<html>` exists: wrap page access in `DOMContentLoaded`);
   - point a zoom or ring at exactly what the narration names, and end a zoom on a word with `{ cue: …, do: unzoom }`
     rather than a fixed `ms`;
   - the cursor parks out of the way by itself between distant steps; add `{ do: park }` (or a scene's `cursor:
     right`) when it would sit on what the viewer should read. Phone scenes have no cursor (touch only) and no park.
   The file is validated on load: a cue missing from the narration is an error that names the scene and step.

4. **Render.** Start the app, then `scenecast render video.yaml`. It writes `out/<output>.mp4`, `.srt`,
   `chapters.txt` and `out/audit/`, and exits 1 when the audit FAILs. A cold render takes about 3.5 to 7 times the
   video's length, so tell the user before starting a long one. Use `--only <sceneId>` while working on a single
   scene (it writes `out/<output>-<sceneId>.mp4`).

5. **Read `out/audit/audit-table.md`, all of it.** Check every row and every tile of `contact-sheet.png`, never a
   sample. A video with one caption over a button is a broken video, even if every other moment passes. See
   [references/audit.md](references/audit.md) for what each check means.

6. **Fix every FAIL, then look at every WARN.** Common fixes:

   | Audit says | Fix |
   |---|---|
   | sync: gap over 0.30 s | Put the cue on the word that names the action. A late action means a slow page: seed the data, `prewarm` the route, or add a `wait` earlier. |
   | word: cue not heard (WARN) | Nothing was heard where the cue is (a misheard word is already matched). For a name, add it to `audit.allowList`; otherwise choose a more distinct cue word, or listen to `work/<id>/voice/<scene>/voice.wav` and respell what the voice gets wrong. |
   | target: box does not contain target | Fix `sel` so it matches the element named, add `pad`, make sure the element is still there when the ring peaks. |
   | captions: covers the target / cursor / panel (`no free position; … overlaps least`) | Zoom to a smaller element, close a panel the step does not need, or move the step to a phrase where less is on screen. |
   | blank frames | Rare: blank runs are frozen in the take. Zoom to a region with content, or re-render with `--fresh`. |
   | crop: zoom cuts the nav | Declare the nav in `app.nav`. |
   | warning: zoom on … became the full frame because it holds nav … | Use a smaller `pad`, or zoom on an element clear of the nav. |
   | warning: zoom on … leaves no caption position free | Zoom on a smaller element, use a smaller `pad`, or end the zoom sooner with an `unzoom`. |
   | work dir … is in use by another render (pid …) | Another render of the same video is running: wait for it, or use `--work <dir>`. |
   | crop: target too close to the zoom edge | Zoom the element's card or section instead (a side on the frame edge never fails). |
   | plan: unzoom has no zoom end near it | Put a `zoom` before the `unzoom` in the same scene, and drop the zoom's `ms`. |
   | loading: spinner visible | Seed, prewarm, or wait before the step. |
   | narration WARN, e.g. `-"worklist" +"work list"` | If the voice is right, add the word to `audit.allowList`. If a word was really dropped, rewrite the sentence. |

   More in [references/troubleshooting.md](references/troubleshooting.md).

7. **Re-render** with the same command. Unchanged stages are reused, so a re-run after a scene-file fix is fast. After
   a change to the app itself, add `--fresh`.

8. **Report.** Give the user the video path, the audit result line (pass, warn and fail counts), and every WARN you
   decided to accept, with the reason.

## Rules

- Check every moment in the audit, never spot-check.
- Never call a video done while the audit FAILs, and never use `--no-audit` to get past a FAIL.
- One render per process: the CLI already does this; if you call `render()` from code, start a new process for each
  video.
- Keep the zoom on what the narration names. The audit protects each step's own target, not an earlier step's
  element that is still on screen.
- Scene files and seed data are re-recordable: keep them in version control next to the app, and re-render when the
  app changes instead of editing the video.
