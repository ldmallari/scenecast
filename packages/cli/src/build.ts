// Pure wiring between the stages: retimed takes, zooms, rings and captions become a ComposePlan;
// the plan's scene starts give the voice placements, chapters and the final-time captions.
import {
  actionAt,
  DEFAULTS,
  DESKTOP_CAPTIONS,
  layoutCaptions,
  phoneCaptions,
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
  type CardsCfg,
  type CursorCfg,
  type ScheduleOpts,
  spotPoint,
  travelSecFor,
  type PhoneAlign,
  type PhoneCfg,
  type Take,
  type VideoSpec,
  zoomedCaptionEvents as captionEvents,
} from '@scenecast/core';
import type { ComposePlan, PlanScene, Timed } from '@scenecast/compose';

/**
 * How a scene's steps are scheduled. Desktop scenes park the cursor between distant pointer steps (unless
 * `cursor.park` is off); phone scenes never park (there is no cursor; the touch indicator fades by itself) and tap
 * with no glide, the touch indicator fading in for the touch lead.
 */
export function scheduleOptsFor(scene: Scene, cursor: CursorCfg, sceneEnd: number): ScheduleOpts {
  const phone = scene.viewport === 'phone';
  const parkSpot = phone || cursor.park === 'off' ? undefined : cursor.park;
  return {
    travelSec: (step) => travelSecFor(step, { touch: phone }),
    ...(parkSpot ? { park: { to: spotPoint(parkSpot, { width: DEFAULTS.video.width, height: DEFAULTS.video.height }), afterSec: cursor.parkAfterSec } } : {}),
    sceneEnd,
  };
}

// The zoom-aware caption events live in core (captions.ts); re-exported for the CLI's tests and callers.
export { onScreen, captionEvents };

/** Default intro and outro card lengths (`cards.introSec` / `outroSec`); the cards are silent, music only. */
export const INTRO_SEC = DEFAULTS.cards.introSec;
export const OUTRO_SEC = DEFAULTS.cards.outroSec;
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
  /** Time of the take's last decodable frame (lastFrameTime): retime never reads past it. */
  lastFrameSec?: number;
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
  /** Title scenes with `page`: the rendered page image the card shows. */
  cardImage?: string;
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

/**
 * The plan's zooms for a take, in scene seconds. A scene that starts zoomed (`take.initialZoom`) shows that
 * box from the first frame (`instant`) until its first zoom or unzoom step, else to the scene end. A zoom
 * step ends at the unzoom that closes it (the next unzoom with no zoom between), else `ms` (default 2 s)
 * after it has eased in. No zoom ends after the next zoom starts or after the scene (`duration`).
 */
export function planZooms(take: Take, scheduled: ScheduledStep[], times: Map<number, number>, duration: number): Timed[] {
  const stepOf = (index: number) => scheduled.find((s) => s.index === index)!.step;
  const marks = take.events
    .filter((e) => e.kind === 'unzoom' || (e.kind === 'zoom' && e.target))
    .sort((a, b) => a.index - b.index)
    .map((e) => ({ e, t: times.get(e.index)! }));
  const zooms: Timed[] = [];
  if (take.initialZoom) zooms.push({ start: 0, end: Math.min(duration, marks[0]?.t ?? duration), box: take.initialZoom, instant: true });
  marks.forEach(({ e, t }, i) => {
    if (e.kind !== 'zoom') return;
    const next = marks[i + 1];
    let end: number;
    if (next?.e.kind === 'unzoom') end = next.t;
    else {
      end = t + DEFAULTS.video.zoomEaseSec + (stepOf(e.index).ms ?? ZOOM_HOLD_MS) / 1000;
      const nextZoom = marks.slice(i + 1).find((m) => m.e.kind === 'zoom');
      if (nextZoom) end = Math.min(end, nextZoom.t);
    }
    zooms.push({ start: t, end: Math.min(duration, end), box: e.target! });
  });
  return zooms;
}

/**
 * One app scene of the plan: the retimed take with its zooms, composer rings and captions. `align` is where a phone
 * take sits (`phone.align`): its boxes are mapped there, and its captions go beside the phone (`phoneCaptions`).
 */
export function appPlanScene(
  scene: Scene,
  voice: SceneVoice,
  scheduled: ScheduledStep[],
  rec: Recorded,
  align: PhoneAlign,
): { plan: PlanScene; segments: Segment[] } {
  const segments = retime(rec.take, scheduled, voice, {
    sceneId: scene.id,
    flashTime: rec.flashTime,
    flashEnd: rec.flashEnd,
    blanks: rec.blanks ?? [],
    srcDuration: rec.srcDuration,
    ...(rec.lastFrameSec !== undefined ? { lastFrameSec: rec.lastFrameSec } : {}),
  });
  const duration = toFrames(voice.duration + DEFAULTS.video.breathSec);
  const times = eventTimes(rec, scheduled, segments);
  const stepOf = (index: number) => scheduled.find((s) => s.index === index)!.step;
  const zooms = planZooms(rec.take, scheduled, times, duration);
  const rings: Timed[] = [];
  for (const e of rec.take.events) {
    const step = stepOf(e.index);
    const t = times.get(e.index)!;
    // `ring: true` on a non-ring step: the composer draws it, held for `ringMs`. The recorder draws `do: ring` and `ringSel` rings itself.
    if (step.ring && step.ringSel === undefined && e.kind !== 'ring' && e.target) {
      const end = t + ((step.ringMs ?? RING_HOLD_MS) + 2 * RING_FADE_MS) / 1000;
      rings.push({ start: t, end: Math.min(duration, end), box: padBox(e.target, step.pad ?? 0) });
    }
  }
  const layout = rec.take.viewport === 'phone' ? phoneCaptions(align) : DESKTOP_CAPTIONS;
  const cues = layoutCaptions(scene, voice, captionEvents(rec.take, times, zooms, duration, align), layout);
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
 * What `buildVideo` needs of the scene file: test fixtures may leave out `cards` and `phone` (then `DEFAULTS.cards`
 * and `DEFAULTS.phone.align` apply).
 */
export type BuildSpec = Omit<VideoSpec, 'cards' | 'phone'> & { cards?: CardsCfg; phone?: PhoneCfg };

export interface BuildOpts {
  /** false (a `--only` render) leaves out the intro and outro cards. */
  cards: boolean;
  /** The rendered `cards.introPage` / `outroPage` images. */
  introImage?: string;
  outroImage?: string;
}

/**
 * The whole video: an intro card, then every scene (app scenes as retimed takes, title scenes as
 * narrated chapter cards), then an outro card. The intro and outro last `cards.introSec` and `outroSec`
 * (0 leaves the card out); the outro shows `cards.outroTitle` (else the video title) and `outroNext`.
 */
export function buildVideo(spec: BuildSpec, inputs: SceneInput[], opts: BuildOpts): BuiltVideo {
  const cards: CardsCfg = spec.cards ?? DEFAULTS.cards;
  const align: PhoneAlign = spec.phone?.align ?? DEFAULTS.phone.align;
  const planScenes: PlanScene[] = [];
  const placed: PlacedScene[] = [];
  let t = 0;
  const push = (s: PlanScene) => {
    planScenes.push(s);
    const start = t;
    t += s.duration;
    return start;
  };
  if (opts.cards && cards.introSec > 0)
    push({ kind: 'card', duration: toFrames(cards.introSec), card: { variant: 'intro', ...(opts.introImage ? { image: opts.introImage } : {}) } });
  for (const input of inputs) {
    const { scene, voice } = input;
    if (scene.kind === 'title') {
      const duration = toFrames(Math.max(scene.seconds ?? 0, voice.duration + DEFAULTS.video.breathSec));
      // Narrated card: its captions sit at the bottom (nothing on a card to keep clear of).
      const cues = layoutCaptions(scene, voice, []);
      const card = { variant: 'chapter' as const, title: scene.title ?? scene.id, ...(input.cardImage ? { image: input.cardImage } : {}) };
      const start = push({ kind: 'card', duration, card, cues });
      placed.push({ ...input, planIndex: planScenes.length - 1, start });
      continue;
    }
    if (!input.scheduled || !input.recorded) throw new Error(`scene "${scene.id}": app scene needs its schedule and take`);
    const { plan, segments } = appPlanScene(scene, voice, input.scheduled, input.recorded, align);
    const start = push(plan);
    placed.push({ ...input, planIndex: planScenes.length - 1, start, segments });
  }
  if (opts.cards && cards.outroSec > 0) {
    const card = {
      variant: 'outro' as const,
      title: cards.outroTitle ?? spec.title,
      ...(cards.outroNext ? { next: cards.outroNext } : {}),
      ...(opts.outroImage ? { image: opts.outroImage } : {}),
    };
    push({ kind: 'card', duration: toFrames(cards.outroSec), card });
  }
  return { plan: { brand: spec.brand, scenes: planScenes, cards: { entrance: cards.entrance }, phoneAlign: align }, scenes: placed, total: t };
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
