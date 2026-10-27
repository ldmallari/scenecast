// The render pipeline: load → seed → voice → schedule → record → retime → captions → compose → mix →
// audit, every expensive stage behind the stage cache (work/<id>/<stage>/).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  appFiles,
  audit,
  buildVoice,
  checkSchedule,
  DEFAULTS,
  ensureToolchain,
  lastFrameTime,
  loadScene,
  mix,
  recordScene,
  renderCardPage,
  runFfmpeg,
  runPy,
  freezeBlankFrames,
  scanBlank,
  scanFlash,
  schedule,
  scheduleWarnings,
  sceneWarnings,
  sessionStoragePath,
  splitPhrases,
  stepFiles,
  phraseGaps,
  VOICE_ALIGN_VERSION,
  type AuditCounts,
  type Scene,
  type SceneVoice,
  type ScheduledStep,
  type VideoSpec,
} from '@scenecast/core';
import { renderVideo } from '@scenecast/compose';
import { buildVoiceTrack } from './audio.js';
import { buildVideo, chaptersTxt, finalSrt, scheduleOptsFor, type BuiltVideo, type Recorded, type SceneInput } from './build.js';
import { lockWorkDir, StageCache, type WorkLock } from './cache.js';

export interface RenderOptions {
  /** Render just this scene (no intro or outro card); the files get a `-<sceneId>` suffix. */
  only?: string;
  /** Run the audit (default true). */
  audit?: boolean;
  /** Keep every intermediate file (Revideo's work folder, the recorder's session file). */
  keepWork?: boolean;
  /** Ignore the cache and redo every stage (for example after the app itself changed). */
  fresh?: boolean;
  /** Where the outputs go. Default `out`. */
  outDir?: string;
  /** Where the work folders go (work/<id>). Default `work`. */
  workRoot?: string;
  log?: (msg: string) => void;
}

export interface RenderResult {
  /** The audit verdict: 0 on PASS (or with the audit off), 1 on any FAIL. */
  exitCode: number;
  video: string;
  /** Seconds. */
  duration: number;
  /** Wall-clock seconds of the whole render, and of each stage that ran (cached ones are absent). */
  wallSec: number;
  stageSec: Record<string, number>;
  audit?: { pass: boolean; counts: AuditCounts; dir: string };
}

/** Everything up to (not including) compose: the plan and what it was built from. */
export interface Prepared {
  spec: VideoSpec;
  video: BuiltVideo;
  cache: StageCache;
  workDir: string;
  /** Output base name (`<output>` or `<output>-<only>`). */
  name: string;
  /**
   * The lock on `workDir`, taken before any stage runs (a second render into the same dir fails at once). `render`
   * releases it when done; otherwise it is released when the process exits.
   */
  lock: WorkLock;
}

const secs = (since: number) => (performance.now() - since) / 1000;

/** Per-stage and total wall time, each also as a multiple of the video's length. */
export function timingSummary(stageSec: Record<string, number>, wallSec: number, videoSec: number): string {
  const x = (s: number) => `${s.toFixed(1)} s (${(s / videoSec).toFixed(2)}x)`;
  const width = Math.max(5, ...Object.keys(stageSec).map((k) => k.length));
  const rows = Object.entries(stageSec).map(([k, s]) => `  ${k.padEnd(width)}  ${x(s)}`);
  if (!rows.length) rows.push('  (every stage was cached)');
  return [`timings for a ${videoSec.toFixed(1)} s video:`, ...rows, `  ${'total'.padEnd(width)}  ${x(wallSec)}`].join('\n');
}

/** Seconds of video in a media file, from a stream copy (the recorder's webm has no duration header). */
async function mediaDuration(file: string): Promise<number> {
  const { ffmpeg } = await ensureToolchain({ offline: true }).catch(() => ensureToolchain());
  const { err } = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-stats', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']);
  const times = [...err.matchAll(/time=\s*(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  if (!last) throw new Error(`could not read the length of ${file}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/**
 * Runs `app.seed` once before recording. A script path runs with node (.js/.mjs/.cjs/.ts) or sh (.sh);
 * anything else is a shell command. It runs in the scene file's folder with SCENECAST_BASE_URL set.
 */
export function runSeed(seed: string, cwd: string, baseUrl: string): Promise<void> {
  const ext = path.extname(seed).toLowerCase();
  const file = path.isAbsolute(seed) && fs.existsSync(seed);
  const [cmd, args] = !file
    ? ['sh', ['-c', seed]]
    : ['.js', '.mjs', '.cjs', '.ts'].includes(ext)
      ? [process.execPath, [seed]]
      : ext === '.sh'
        ? ['sh', [seed]]
        : [seed, []];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { cwd, stdio: 'inherit', env: { ...process.env, SCENECAST_BASE_URL: baseUrl } });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`seed "${seed}" exited with code ${code}`))));
  });
}

/** Whether anything answers at `url` (any HTTP status counts) within a few seconds. */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

/** Voices every scene, one cache entry per scene; the scenes that changed are synthesised in one batch. */
async function voiceStage(spec: VideoSpec, scenes: Scene[], cache: StageCache, log: (m: string) => void): Promise<Map<string, { wav: string; voice: SceneVoice }>> {
  const out = new Map<string, { wav: string; voice: SceneVoice }>();
  const misses: { scene: Scene; key: string }[] = [];
  for (const scene of scenes) {
    // The gaps are in the key on their own (not only through spec.voice), so a change in how phrases split re-voices.
    const input = {
      voice: spec.voice,
      phrases: splitPhrases(scene.narration),
      gaps: phraseGaps(scene.narration, spec.voice),
      align: VOICE_ALIGN_VERSION,
      fake: process.env.SCENECAST_FAKE_TTS === '1',
    };
    const key = await cache.key(`voice/${scene.id}`, input);
    const hit = await cache.lookup<{ wav: string; voice: SceneVoice }>(`voice/${scene.id}`, key);
    if (hit) out.set(scene.id, hit);
    else misses.push({ scene, key });
  }
  if (!misses.length) {
    log('voice: cached');
    return out;
  }
  const started = performance.now();
  const batch = cache.dir('voice/.batch');
  fs.rmSync(batch, { recursive: true, force: true });
  try {
    const timeline = await buildVoice({ ...spec, scenes: misses.map((m) => m.scene) }, batch);
    for (const { scene, key } of misses) {
      const dir = cache.dir(`voice/${scene.id}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const wav = path.join(dir, 'voice.wav');
      fs.copyFileSync(path.join(batch, 'voice', `${scene.id}.wav`), wav);
      const result = { wav, voice: timeline.scenes[scene.id]! };
      await cache.save(`voice/${scene.id}`, key, result, [wav]);
      out.set(scene.id, result);
    }
  } finally {
    fs.rmSync(batch, { recursive: true, force: true });
  }
  cache.timings['voice'] = secs(started);
  log(`voice: ${misses.map((m) => m.scene.id).join(', ')} done in ${secs(started).toFixed(1)} s`);
  return out;
}

/**
 * Renders a card page (`cards.introPage`, `cards.outroPage` or a title scene's `page`) to a PNG once, cached as
 * `cards/<name>`. The key covers the HTML file and the brand values it receives, not files the page loads.
 */
async function cardPageStage(spec: VideoSpec, name: string, page: string, cache: StageCache, log: (m: string) => void): Promise<string> {
  const vars = { primary: spec.brand.primary, accent: spec.brand.accent, font: spec.brand.font, cardFont: spec.brand.cardFont ?? spec.brand.font };
  const { result } = await cache.run({
    name: `cards/${name}`,
    input: { page, vars },
    files: [page],
    run: async (dir) => ({ png: await renderCardPage(page, path.join(dir, 'card.png'), vars, { log }) }),
    outputs: (r) => [r.png],
  });
  return result.png;
}

/** Load, seed, voice, schedule, record, retime and captions: the plan, ready to compose. */
export async function prepare(file: string, opts: RenderOptions = {}): Promise<Prepared> {
  const log = opts.log ?? ((m: string) => console.log(`scenecast: ${m}`));
  const spec = await loadScene(file);
  for (const w of sceneWarnings(spec)) log(`warning: ${w}`);
  const sceneDir = path.dirname(path.resolve(file));
  const scenes = opts.only ? spec.scenes.filter((s) => s.id === opts.only) : spec.scenes;
  if (!scenes.length) throw new Error(`no scene "${opts.only}" in ${file} (scenes: ${spec.scenes.map((s) => s.id).join(', ')})`);
  const workDir = path.resolve(opts.workRoot ?? 'work', spec.id);
  // Two renders into the same work dir would write the same stages at once: the second stops here.
  const lock = lockWorkDir(workDir);
  try {
    const cache = new StageCache(workDir, { fresh: opts.fresh, log });

    // Problems with the app are reported before the (slow) voice stage.
    const signedIn = scenes.some((s) => s.kind === 'app' && !s.signedOut);
    if (signedIn && spec.app.storageState && !fs.existsSync(spec.app.storageState))
      throw new Error(`app.storageState ${spec.app.storageState} does not exist yet: run \`scenecast login ${file}\` first`);
    if (scenes.some((s) => s.kind === 'app') && !(await reachable(spec.app.baseUrl)))
      log(`the app at ${spec.app.baseUrl} is not responding; start it first (recording will fail unless every scene is cached)`);

    const voices = await voiceStage(spec, scenes, cache, log);
    const cards = !opts.only;
    const cardImage = (name: string, page: string | undefined) => (page ? cardPageStage(spec, name, page, cache, log) : Promise.resolve(undefined));
    const introImage = cards && spec.cards.introSec > 0 ? await cardImage('intro', spec.cards.introPage) : undefined;
    const outroImage = cards && spec.cards.outroSec > 0 ? await cardImage('outro', spec.cards.outroPage) : undefined;

    // Every app scene's schedule, checked before anything is recorded: a step that could only fail once its take
    // is recorded (on the first word, out of order, past the scene end) is named now, with what to change.
    const schedules = new Map<string, ScheduledStep[]>();
    const problems: string[] = [];
    for (const scene of scenes) {
      if (scene.kind !== 'app') continue;
      const { voice } = voices.get(scene.id)!;
      const scheduled = schedule(scene, voice, scheduleOptsFor(scene, spec.cursor, voice.duration));
      problems.push(...checkSchedule(scene, scheduled, voice.duration + DEFAULTS.video.breathSec));
      for (const w of scheduleWarnings(scene, scheduled)) log(`warning: ${w}`);
      schedules.set(scene.id, scheduled);
    }
    if (problems.length) throw new Error(`the steps cannot be recorded as scheduled:\n${problems.join('\n')}`);

    let seeded = false;
    const inputs: SceneInput[] = [];
    for (const scene of scenes) {
      const { voice } = voices.get(scene.id)!;
      if (scene.kind === 'title') {
        const image = await cardImage(`scene-${scene.id}`, scene.page);
        inputs.push({ scene, voice, ...(image ? { cardImage: image } : {}) });
        continue;
      }
      const scheduled = schedules.get(scene.id)!;
      const app = spec.app;
      // The take runs at least as long as the scene it fills (voice, breath) plus a tail, so retime never runs out of frames.
      const minTakeSec = voice.duration + DEFAULTS.video.breathSec + DEFAULTS.video.takeTailSec;
      const { result: recorded } = await cache.run<Recorded>({
        name: `record/${scene.id}`,
        input: recordStageInput(scene, scheduled, app, spec.cursor, minTakeSec, spec.brand.accent),
        files: [...recordStageFiles(app, scene), ...seedFiles(app, sceneDir)],
        run: async (dir) => {
          if (app.seed && !seeded) {
            log(`seed: ${app.seed}`);
            await runSeed(app.seed, sceneDir, app.baseUrl);
            seeded = true;
          }
          // The signed-in session the recorder saves holds credentials: never leave it behind, even on failure or
          // when the process is stopped mid-recording (Ctrl-C exits through Playwright's signal handler).
          const session = path.join(dir, '.session.json');
          const removeSession = () => {
            if (opts.keepWork) return;
            fs.rmSync(session, { force: true });
            fs.rmSync(sessionStoragePath(session), { force: true });
          };
          process.once('exit', removeSession);
          let recorded;
          try {
            recorded = await recordTake(
              scene.id,
              () => recordScene(scene, scheduled, app, dir, { minTakeSec, cursor: spec.cursor, touchColour: spec.brand.accent }),
              scanFlash,
              log,
            );
          } finally {
            removeSession();
            process.removeListener('exit', removeSession);
          }
          const { take, flash } = recorded;
          let blanks = await scanBlank(take.file, flash.end);
          if (blanks.length) {
            // Blank frames (a page between navigations) become the last good frame before them, in the take itself.
            const frozen = await freezeBlankFrames(take.file, blanks);
            log(`record/${scene.id}: ${blanks.length} blank frame run(s) in the take; froze ${frozen} on the last good frame`);
            blanks = await scanBlank(take.file, flash.end);
          }
          return {
            take,
            flashTime: flash.start,
            flashEnd: flash.end,
            srcDuration: await mediaDuration(take.file),
            lastFrameSec: await lastFrameTime(take.file),
            blanks,
          };
        },
        outputs: (r) => [r.take.file],
      });
      // A take recorded before blank-frame scanning existed: scan it now.
      recorded.blanks ??= await scanBlank(recorded.take.file, recorded.flashEnd);
      // A take recorded before the last frame was measured: measure it now.
      recorded.lastFrameSec ??= await lastFrameTime(recorded.take.file);
      inputs.push({ scene, voice, scheduled, recorded });
    }

    const video = buildVideo(spec, inputs, {
      cards,
      ...(introImage ? { introImage } : {}),
      ...(outroImage ? { outroImage } : {}),
    });
    for (const w of video.warnings) log(`warning: ${w}`);
    const name = opts.only ? `${spec.output}-${opts.only}` : spec.output;
    return { spec, video, cache, workDir, name, lock };
  } catch (e) {
    lock.release();
    throw e;
  }
}

/**
 * The record stage's own version, part of its cache key: bump it when takes recorded before a change must be
 * recorded again (2: blank frames are frozen in the take; 3: a hover's ringSel ring waits for the hover to settle,
 * and declared navs are logged with their selectors; 4: every ringSel ring is drawn after its action has had its
 * effect, rings fade with their elements, a busy page no longer makes a step late, tall ring targets are not
 * scrolled). The global cache version stays, so voice and music clips are kept.
 */
export const RECORD_STAGE_VERSION = 4;

/**
 * Records a take and finds its flash marker. The marker is very rarely missing from an otherwise good take (seen once
 * in many renders, the same scene passing before and after): then the scene is recorded once more. A second miss, or
 * any other problem with the marker, fails.
 */
export async function recordTake<T extends { file: string }>(
  sceneId: string,
  record: () => Promise<T>,
  scan: (file: string) => Promise<{ start: number; end: number }>,
  log: (m: string) => void,
): Promise<{ take: T; flash: { start: number; end: number } }> {
  const missing = (e: unknown) => e instanceof Error && e.message.startsWith('no flash marker found');
  const take = await record();
  try {
    return { take, flash: await scan(take.file) };
  } catch (e) {
    if (!missing(e)) throw e;
    log(`record/${sceneId}: no flash marker found in the take; recording it again`);
  }
  const again = await record();
  try {
    return { take: again, flash: await scan(again.file) };
  } catch (e) {
    if (!missing(e)) throw e;
    throw new Error(`${(e as Error).message} (twice in a row; re-run the render, and report it if it keeps happening)`);
  }
}

/**
 * The seed's files, whose contents join every recording's cache key, so a changed seed records every scene again:
 * the seed script, or the files a seed command names (each word that is a file, relative to the scene folder, such as
 * `scripts/seed.mjs` in `node scripts/seed.mjs`), and `app.seedInputs`.
 */
export function seedFiles(app: VideoSpec['app'], sceneDir: string): string[] {
  const seed = app.seed?.trim();
  const named = !seed
    ? []
    : path.isAbsolute(seed) && fs.existsSync(seed)
      ? [seed]
      : seed.split(/\s+/).map((w) => path.resolve(sceneDir, w)).filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  return [...new Set([...named, ...(app.seedInputs ?? [])])];
}

/** The files a scene's take depends on (their contents join the record stage's key): the app's, and the scene's uploads (setup's too). */
export function recordStageFiles(app: VideoSpec['app'], scene: Scene): string[] {
  return [...new Set([...appFiles(app), ...stepFiles(scene.setup), ...stepFiles(scene.steps)])];
}

/** Everything a scene's take depends on: the record stage's cache input. */
export function recordStageInput(
  scene: Scene,
  scheduled: ScheduledStep[],
  app: VideoSpec['app'],
  cursor: VideoSpec['cursor'],
  minTakeSec: number,
  accent: string,
): Record<string, unknown> {
  return {
    rec: RECORD_STAGE_VERSION,
    scene,
    scheduled,
    app,
    cursor,
    minTakeSec,
    ...(scene.viewport === 'phone' ? { touchColour: accent } : {}),
  };
}

/**
 * Renders the video. Revideo keeps process-wide state (environment, patched modules), so a process
 * renders (or previews) at most once: the CLI runs one command per process.
 */
export async function render(file: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const started = performance.now();
  const log = opts.log ?? ((m: string) => console.log(`scenecast: ${m}`));
  const prepared = await prepare(file, { ...opts, log });
  try {
    return await composeAndAudit(prepared, opts, log, started);
  } finally {
    prepared.lock.release();
  }
}

/** The rest of `render` once the plan is ready: compose, mux, write the outputs and audit. */
async function composeAndAudit(
  { spec, video, cache, workDir, name }: Prepared,
  opts: RenderOptions,
  log: (m: string) => void,
  started: number,
): Promise<RenderResult> {
  const outDir = path.resolve(opts.outDir ?? 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const { plan, total } = video;

  const sources = [...new Set(plan.scenes.flatMap((s) => (s.segments ?? []).map((g) => g.src)))];
  // Every image the composer draws is part of the key: a changed logo, background or card page re-composes.
  const bg = spec.brand.background;
  const images = [
    ...(spec.brand.logo ? [spec.brand.logo] : []),
    ...(bg && typeof bg === 'object' && 'image' in bg ? [bg.image] : []),
    ...new Set(plan.scenes.flatMap((s) => (s.card?.image ? [s.card.image] : []))),
  ];
  const { result: composed } = await cache.run({
    name: 'compose',
    input: { plan },
    files: [...sources, ...images],
    run: async (dir) =>
      renderVideo(plan, path.join(dir, 'video.mp4'), opts.keepWork ? { workDir: path.join(dir, 'render') } : {}),
    outputs: (r) => [r.file],
  });

  const music = spec.brand.music?.file ?? (
    await cache.run({
      name: 'music',
      input: { seconds: total, seed: 0 },
      run: async (dir) => {
        const wav = path.join(dir, 'music.wav');
        await runPy('scenecast_py.music', ['--seconds', total.toFixed(3), '--out', wav, '--seed', '0']);
        return { wav };
      },
      outputs: (r) => [r.wav],
    })
  ).result.wav;

  const clips = video.scenes.map((s) => ({ file: path.join(cache.dir(`voice/${s.scene.id}`), 'voice.wav'), start: s.start }));
  const { result: track } = await cache.run({
    name: 'voicetrack',
    input: { clips: clips.map((c) => ({ start: c.start })), total },
    files: clips.map((c) => c.file),
    run: async (dir) => {
      const wav = path.join(dir, 'voice.wav');
      buildVoiceTrack(clips, total, wav);
      return { wav };
    },
    outputs: (r) => [r.wav],
  });

  const { result: mixed } = await cache.run({
    name: 'mix',
    input: { music: spec.brand.music ? 'user' : 'synth' },
    files: [composed.file, track.wav, music],
    run: async (dir) => {
      const file = path.join(dir, `${name}.mp4`);
      return { file, ...(await mix(composed.file, track.wav, music, file)) };
    },
    outputs: (r) => [r.file],
  });

  const mp4 = path.join(outDir, `${name}.mp4`);
  fs.copyFileSync(mixed.file, mp4);
  fs.writeFileSync(path.join(outDir, `${name}.srt`), finalSrt(video));
  fs.writeFileSync(path.join(outDir, 'chapters.txt'), chaptersTxt(video.scenes));
  log(`wrote ${mp4} (${total.toFixed(2)} s, ${mixed.lufs.toFixed(1)} LUFS)`);

  let verdict: RenderResult['audit'];
  const auditOut = path.join(outDir, 'audit');
  if (opts.audit === false) {
    // An older audit next to a new video would vouch for a video it never saw.
    fs.rmSync(auditOut, { recursive: true, force: true });
    log('audit: skipped (--no-audit)');
  } else {
    // App scenes get every check; title cards (no take) get the narration and caption checks.
    const scenes = video.scenes.map((s) => ({
      scene: s.scene,
      planIndex: s.planIndex,
      voice: s.voice,
      ...(s.recorded ? { scheduled: s.scheduled!, take: s.recorded.take, flashTime: s.recorded.flashTime } : {}),
    }));
    const loudness = { lufs: mixed.lufs, truePeak: mixed.truePeak };
    const { result } = await cache.run({
      name: 'audit',
      input: { plan, scenes, loudness, allowList: spec.audit?.allowList ?? [] },
      files: [mixed.file],
      run: async () => {
        const r = await audit({ video: mixed.file, plan, scenes, loudness, workDir, spec });
        return { pass: r.pass, counts: r.counts, dir: r.dir };
      },
      outputs: (r) => ['audit.json', 'audit-table.md', 'contact-sheet.png'].map((f) => path.join(r.dir, f)),
    });
    fs.rmSync(auditOut, { recursive: true, force: true });
    fs.cpSync(result.dir, auditOut, { recursive: true, filter: (src) => path.basename(src) !== '.stage.json' });
    verdict = { ...result, dir: auditOut };
    const c = result.counts;
    log(`audit: ${result.pass ? 'PASS' : 'FAIL'} (${c.pass} pass, ${c.warn} warn, ${c.fail} fail); see ${path.join(auditOut, 'audit-table.md')}`);
  }

  const wallSec = secs(started);
  log(timingSummary(cache.timings, wallSec, total));
  return {
    exitCode: verdict && !verdict.pass ? 1 : 0,
    video: mp4,
    duration: total,
    wallSec,
    stageSec: { ...cache.timings },
    audit: verdict,
  };
}
