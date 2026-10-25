// Pure wiring between the stages: retimed takes, zooms, rings and captions become a ComposePlan;
// the plan's scene starts give the voice placements, chapters and the final-time captions.
import {
  DEFAULTS,
  clampZoom,
  layoutCaptions,
  outputTimeOf,
  phoneFrame,
  phoneToFrame,
  retime,
  RING_FADE_MS,
  RING_HOLD_MS,
  toSrt,
  travelSecFor,
  type Box,
  type CaptionEvent,
  type Cue,
  type Scene,
  type SceneVoice,
  type ScheduledStep,
  type Segment,
  type Take,
  type VideoSpec,
} from '@scenecast/core';
import type { ComposePlan, PlanScene, Timed } from '@scenecast/compose';

/** Intro and outro cards: silent, music only. */
export const INTRO_SEC = 3;
export const OUTRO_SEC = 3;
/** A zoom with no `ms` holds this long once it has eased in. */
export const ZOOM_HOLD_MS = 2000;

const FRAME: Box = { x: 0, y: 0, w: DEFAULTS.video.width, h: DEFAULTS.video.height };
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

/** Where `box` (frame px) shows on screen while the composer shows the region `zoom`. */
export function onScreen(box: Box, zoom: Box | null): Box {
  if (!zoom) return box;
  const s = FRAME.w / zoom.w;
  return { x: (box.x - zoom.x) * s, y: (box.y - zoom.y) * s, w: box.w * s, h: box.h * s };
}

/**
 * The views on screen during [lo, hi): null (the whole frame) and/or each zoom region, the way the
 * audit reads them: a held zoom shows only its region; while one eases in or out, both ends count.
 */
function views(lo: number, hi: number, zooms: Timed[], ease: number): (Box | null)[] {
  let rest: [number, number][] = [[lo, hi]];
  for (const z of zooms) {
    const [hl, hh] = [z.start + ease, z.end];
    rest = rest.flatMap(([a, b]): [number, number][] => {
      if (hh <= a || hl >= b || hl >= hh) return [[a, b]];
      const out: [number, number][] = [];
      if (hl > a) out.push([a, hl]);
      if (hh < b) out.push([hh, b]);
      return out;
    });
  }
  const out: (Box | null)[] = rest.some(([a, b]) => b - a > EPS) ? [null] : [];
  for (const z of zooms) if (lo < z.end + ease && hi > z.start) out.push(z.box);
  return out;
}

/** Output time of every take event: where retime put it, else where the schedule meant it. */
export function eventTimes(rec: Recorded, scheduled: ScheduledStep[], segments: Segment[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of rec.take.events) {
    const sch = scheduled.find((s) => s.index === e.index);
    if (!sch) throw new Error(`take event ${e.index} has no scheduled step`);
    out.set(e.index, outputTimeOf(segments, rec.flashTime + e.at) ?? sch.startAt + travelSecFor(sch.step));
  }
  return out;
}

/**
 * Caption events on screen: each take event's boxes (target, ring, cursor, panels; phone boxes mapped
 * into the frame once) stay active until the next event. Every window is split where a zoom starts,
 * finishes easing, ends or finishes easing out, and each piece carries the boxes as they look on
 * screen in every view of that piece, so a caption clear of these is clear of what the audit checks.
 */
export function captionEvents(take: Take, times: Map<number, number>, zooms: Timed[], sceneEnd: number): CaptionEvent[] {
  const phone = take.viewport === 'phone';
  const toFrame = (b: Box) => (phone ? phoneToFrame(b) : b);
  const ease = DEFAULTS.video.zoomEaseSec;
  const regions: Timed[] = zooms.map((z) => ({
    ...z,
    box: clampZoom(toFrame(z.box), FRAME, DEFAULTS.audit.zoomPadPx, undefined, phone ? phoneFrame().x : 0),
  }));
  const timed = take.events
    .map((e) => ({ e, t: times.get(e.index)! }))
    .sort((a, b) => a.t - b.t);
  const out: CaptionEvent[] = [];
  timed.forEach(({ e, t }, i) => {
    const end = i + 1 < timed.length ? timed[i + 1]!.t : sceneEnd;
    const boxes = [e.target, e.ringBox, e.cursorTo, ...e.panels].filter((b): b is Box => b !== undefined).map(toFrame);
    const cuts = [t, end];
    for (const z of regions) for (const c of [z.start, z.start + ease, z.end, z.end + ease]) if (c > t && c < end) cuts.push(c);
    cuts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const [lo, hi] = [cuts[k]!, cuts[k + 1]!];
      if (hi - lo <= EPS) continue;
      out.push({ start: lo, end: hi, boxes: views(lo, hi, regions, ease).flatMap((v) => boxes.map((b) => onScreen(b, v))) });
    }
  });
  return out;
}

/** One app scene of the plan: the retimed take with its zooms, composer rings and captions. */
export function appPlanScene(scene: Scene, voice: SceneVoice, scheduled: ScheduledStep[], rec: Recorded): { plan: PlanScene; segments: Segment[] } {
  const segments = retime(rec.take, scheduled, voice, {
    sceneId: scene.id,
    flashTime: rec.flashTime,
    flashEnd: rec.flashEnd,
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
      const start = push({ kind: 'card', duration, card: { variant: 'chapter', title: scene.title ?? scene.id } });
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
