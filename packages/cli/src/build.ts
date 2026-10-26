// Pure wiring between the stages: retimed takes, zooms, rings and captions become a ComposePlan;
// the plan's scene starts give the voice placements, chapters and the final-time captions.
import {
  actionAt,
  DEFAULTS,
  layoutCaptions,
  onScreen,
  outputTimeOf,
  retime,
  RING_FADE_MS,
  RING_HOLD_MS,
  toSrt,
  type BlankRange,
  type Box,
  type Cue,
  type Scene,
  type SceneVoice,
  type ScheduledStep,
  type Segment,
  type Take,
  type VideoSpec,
  zoomedCaptionEvents as captionEvents,
} from '@scenecast/core';
import type { ComposePlan, PlanScene, Timed } from '@scenecast/compose';

// The zoom-aware caption events live in core (captions.ts); re-exported for the CLI's tests and callers.
export { onScreen, captionEvents };

/** Intro and outro cards: silent, music only. */
export const INTRO_SEC = 3;
export const OUTRO_SEC = 3;
/** A zoom with no `ms` holds this long once it has eased in. */
export const ZOOM_HOLD_MS = 2000;

const EPS = 1e-6;

/** Seconds rounded to the output frame grid (what retime's segments add up to). */
export const toFrames = (t: number) => Math.round(t * DEFAULTS.video.fps) / DEFAULTS.video.fps;

/** What the record stage keeps for a scene: the take and where its flash marker really is. */
export interface Recorded {
  take: Take;
  /** First magenta frame (scanFlash). */
  flashTime: number;
  /** First frame after the flash (scanFlash). */
  flashEnd: number;
  /** Length of the take file in seconds. */
  srcDuration: number;
  /** Runs of near-uniform frames after the flash (scanBlank), frozen over by retime. */
  blanks?: BlankRange[];
}

export interface SceneInput {
  scene: Scene;
  voice: SceneVoice;
  /** App scenes only. */
  scheduled?: ScheduledStep[];
  /** App scenes only. */
  recorded?: Recorded;
}

export interface PlacedScene extends SceneInput {
  planIndex: number;
  /** Global time of the scene's t = 0 (its voice starts here). */
  start: number;
  segments?: Segment[];
}

export interface BuiltVideo {
  plan: ComposePlan;
  scenes: PlacedScene[];
  total: number;
}

const padBox = (b: Box, pad: number): Box => ({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad });

/** Output time of every take event: where retime put it, else where the schedule meant it. */
export function eventTimes(rec: Recorded, scheduled: ScheduledStep[], segments: Segment[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of rec.take.events) {
    const sch = scheduled.find((s) => s.index === e.index);
    if (!sch) throw new Error(`take event ${e.index} has no scheduled step`);
    out.set(e.index, outputTimeOf(segments, rec.flashTime + e.at) ?? actionAt(sch));
  }
  return out;
}

/** One app scene of the plan: the retimed take with its zooms, composer rings and captions. */
export function appPlanScene(scene: Scene, voice: SceneVoice, scheduled: ScheduledStep[], rec: Recorded): { plan: PlanScene; segments: Segment[] } {
  const segments = retime(rec.take, scheduled, voice, {
    sceneId: scene.id,
    flashTime: rec.flashTime,
    flashEnd: rec.flashEnd,
    blanks: rec.blanks ?? [],
    srcDuration: rec.srcDuration,
  });
  const duration = toFrames(voice.duration + DEFAULTS.video.breathSec);
  const times = eventTimes(rec, scheduled, segments);
  const stepOf = (index: number) => scheduled.find((s) => s.index === index)!.step;
  const zooms: Timed[] = [];
  const rings: Timed[] = [];
  for (const e of rec.take.events) {
    const step = stepOf(e.index);
    const t = times.get(e.index)!;
    if (e.kind === 'zoom' && e.target) {
      const hold = (step.ms ?? ZOOM_HOLD_MS) / 1000;
      zooms.push({ start: t, end: Math.min(duration, t + DEFAULTS.video.zoomEaseSec + hold), box: e.target });
    }
    // `ring: true` on a non-ring step: the composer draws it (the recorder draws `do: ring` itself).
    if (step.ring && e.kind !== 'ring' && e.target) {
      const end = t + (RING_HOLD_MS + 2 * RING_FADE_MS) / 1000;
      rings.push({ start: t, end: Math.min(duration, end), box: padBox(e.target, step.pad ?? 0) });
    }
  }
  const cues = layoutCaptions(scene, voice, captionEvents(rec.take, times, zooms, duration));
  const plan: PlanScene = {
    kind: 'app',
    duration,
    segments,
    cues,
    ...(zooms.length ? { zooms } : {}),
    ...(rings.length ? { rings } : {}),
    ...(rec.take.viewport === 'phone' ? { phone: true } : {}),
    ...(rec.take.navs?.length ? { navs: rec.take.navs } : {}),
  };
  return { plan, segments };
}

/**
 * The whole video: an intro card, then every scene (app scenes as retimed takes, title scenes as
 * narrated chapter cards), then an outro card. `cards: false` (a `--only` render) leaves out the
 * intro and outro.
 */
export function buildVideo(spec: VideoSpec, inputs: SceneInput[], opts: { cards: boolean }): BuiltVideo {
  const planScenes: PlanScene[] = [];
  const placed: PlacedScene[] = [];
  let t = 0;
  const push = (s: PlanScene) => {
    planScenes.push(s);
    const start = t;
    t += s.duration;
    return start;
  };
  if (opts.cards) push({ kind: 'card', duration: INTRO_SEC, card: { variant: 'intro' } });
  for (const input of inputs) {
    const { scene, voice } = input;
    if (scene.kind === 'title') {
      const duration = toFrames(Math.max(scene.seconds ?? 0, voice.duration + DEFAULTS.video.breathSec));
      // Narrated card: its captions sit at the bottom (nothing on a card to keep clear of).
      const cues = layoutCaptions(scene, voice, []);
      const start = push({ kind: 'card', duration, card: { variant: 'chapter', title: scene.title ?? scene.id }, cues });
      placed.push({ ...input, planIndex: planScenes.length - 1, start });
      continue;
    }
    if (!input.scheduled || !input.recorded) throw new Error(`scene "${scene.id}": app scene needs its schedule and take`);
    const { plan, segments } = appPlanScene(scene, voice, input.scheduled, input.recorded);
    const start = push(plan);
    placed.push({ ...input, planIndex: planScenes.length - 1, start, segments });
  }
  if (opts.cards) push({ kind: 'card', duration: OUTRO_SEC, card: { variant: 'outro', title: spec.title } });
  return { plan: { brand: spec.brand, scenes: planScenes }, scenes: placed, total: t };
}

function hms(sec: number): string {
  const s = Math.floor(sec + EPS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

/** `HH:MM:SS Title` per scene. The first chapter starts at 00:00:00, so it covers the intro card. */
export function chaptersTxt(scenes: PlacedScene[]): string {
  return scenes.map((s, i) => `${hms(i === 0 ? 0 : s.start)} ${s.scene.title ?? s.scene.id}`).join('\n') + '\n';
}

/** The captions burned into the video, on the final video's clock. */
export function finalCues(video: BuiltVideo): Cue[] {
  return video.scenes.flatMap((s) =>
    (video.plan.scenes[s.planIndex]!.cues ?? []).map((c) => ({ ...c, start: s.start + c.start, end: s.start + c.end })),
  );
}

export function finalSrt(video: BuiltVideo): string {
  return toSrt(finalCues(video));
}
