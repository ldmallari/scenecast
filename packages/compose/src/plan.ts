// Plan types, the scene timeline and zoom clamping (Node side). Per-frame helpers the Revideo
// page uses live in timing.ts, which stays free of Node imports.
import { DEFAULTS, phoneToFrame, type Box, type Brand, type CardsCfg, type Cue, type NavBox, type PhoneAlign, type Segment } from '@scenecast/core';
export { clampZoom } from '@scenecast/core';
import type { PageFonts } from './fonts.js';
export { CARD_BAR_W, easeInOutCubic, entranceAt, gradientLine, inkOver, ringAlpha, sceneOpacity, srcTimeAt, zoomBoxAt, type CardPart, type PartLook } from './timing.js';

/** Something shown from `start` to `end` (scene seconds) around `box` (frame px; take px on phone scenes). */
export interface Timed {
  start: number;
  end: number;
  box: Box;
  /** The box is shown from `start` with no ease-in (a scene that starts zoomed). */
  instant?: boolean;
}

export interface CardSpec {
  variant: 'intro' | 'outro' | 'chapter';
  /** Intro defaults to `brand.introTitle`; outro and chapter cards need a title. */
  title?: string;
  /** Intro defaults to `brand.introSubtitle`. */
  subtitle?: string;
  /** A smaller line under the title (the outro's "Next: …"). */
  next?: string;
  /** A rendered card page (a 1920×1080 image file) shown full-frame instead of the drawn card. */
  image?: string;
}

export interface PlanScene {
  kind: 'app' | 'card';
  /** Scene length in seconds on the output clock (whole frames). */
  duration: number;
  /** Retimed clips and holds; times are scene seconds. */
  segments?: Segment[];
  cues?: Cue[];
  /** Zoom targets (frame px, or take px on phone scenes); clamped and padded by the renderer (see `clampZoom`). */
  zooms?: Timed[];
  /** Highlight rings the composer draws (only those the recorder did not draw); same pixel space as zooms. */
  rings?: Timed[];
  card?: CardSpec;
  /**
   * A 390×844 phone take, shown inside a drawn phone body at 80% of the frame height, placed by the plan's
   * `phoneAlign`. Its zoom, ring and nav boxes are in the take's own pixels (as the recorder logs them); the
   * renderer maps them into the frame with core's `phoneToFrame`. Cue boxes are already in frame px (captions.ts).
   */
  phone?: boolean;
  /** The app's left nav (same pixel space as zooms), so a zoom never cuts it partly. */
  navBox?: Box;
  /** The scene file's declared navs (`app.nav`), same pixel space as zooms: a zoom shows each whole or not at all. */
  navs?: NavBox[];
}

export interface ComposePlan {
  brand: Brand;
  scenes: PlanScene[];
  /** Cross-fade between scenes; default `DEFAULTS.video.dissolveSec`. */
  dissolveSec?: number;
  /** Card settings the composer needs; without it the entrance is `DEFAULTS.cards.entrance`. */
  cards?: Pick<CardsCfg, 'entrance'>;
  /** Where phone scenes place the phone (the scene file's `phone.align`); default `'center'`, the v1 placement. */
  phoneAlign?: PhoneAlign;
}

/** The background of the cards (and the phone stage), with any image as a URL the Revideo page can load. */
export type ResolvedBackground =
  | { kind: 'color'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'image'; url: string; dim: number };

/** The card look a plan asks for. */
export interface CardLook {
  background: ResolvedBackground;
  /** Font family of the card text (`brand.cardFont`, else `brand.font`). */
  cardFont: string;
  entrance: CardsCfg['entrance'];
}

export interface SceneTiming {
  /** Global time of the scene's own t = 0. */
  start: number;
  /** Global time the next scene is fully visible (start + duration). */
  end: number;
  /** Seconds the scene fades in before `start`, over the previous scene's tail. */
  fadeIn: number;
}

/** What the Revideo page receives: the plan with media URLs, clamped zooms and timings resolved. */
export interface ResolvedPlan {
  width: number;
  height: number;
  fps: number;
  zoomEaseSec: number;
  total: number;
  brand: Brand;
  logoUrl?: string;
  background: ResolvedBackground;
  cardFont: string;
  entrance: CardsCfg['entrance'];
  /** The fonts the page loads (bundled faces) and must find (every family the plan names). */
  fonts: PageFonts;
  /** Phone take rectangle in frame px (where `phoneAlign` puts it). */
  phoneRect: Box;
  phoneAlign: PhoneAlign;
  /** The phone body drawn around the screen (`DEFAULTS.phone.bezelPx`; captions keep their gap from it). */
  phoneBezel: number;
  scenes: (PlanScene & SceneTiming)[];
}

/**
 * `brand.background` resolved: a colour string, a gradient (`angle` defaults to 135, CSS convention) or an image
 * (shown at `imageUrl`, else at its path, under a black overlay of `dim`, default 0.35). None: `brand.primary`.
 */
export function resolveBackground(brand: Brand, imageUrl?: string): ResolvedBackground {
  const bg = brand.background;
  if (bg === undefined) return { kind: 'color', color: brand.primary };
  if (typeof bg === 'string') return { kind: 'color', color: bg };
  if ('image' in bg) return { kind: 'image', url: imageUrl ?? bg.image, dim: bg.dim ?? DEFAULTS.background.dim };
  return { kind: 'gradient', from: bg.from, to: bg.to, angle: bg.angle ?? DEFAULTS.background.angle };
}

/**
 * The pure part of resolving a plan's card look: the background (with the background image's URL), the card
 * font and the entrance. `logoUrl` is accepted so callers can pass every resolved brand URL in one object.
 */
export function resolveLook(plan: ComposePlan, urls: { logoUrl?: string; backgroundUrl?: string }): CardLook {
  return {
    background: resolveBackground(plan.brand, urls.backgroundUrl),
    cardFont: plan.brand.cardFont ?? plan.brand.font,
    entrance: plan.cards?.entrance ?? DEFAULTS.cards.entrance,
  };
}

/**
 * Dissolve model: the total is the sum of scene durations. Scene k+1 keeps its own clock
 * (its t = 0 is at the sum of the earlier durations, so voice sync is untouched) and fades in
 * over the last `dissolveSec` of scene k, showing its first frame during that pre-roll.
 */
export function timeline(plan: ComposePlan): { scenes: SceneTiming[]; total: number } {
  const d = plan.dissolveSec ?? DEFAULTS.video.dissolveSec;
  let t = 0;
  const scenes = plan.scenes.map((s, i) => {
    if (!(s.duration > 0)) throw new Error(`scene ${i}: duration must be > 0 (got ${s.duration})`);
    if (i + 1 < plan.scenes.length && s.duration < d) {
      throw new Error(`scene ${i}: duration ${s.duration} s is shorter than the ${d} s dissolve into the next scene`);
    }
    const timing = { start: t, end: t + s.duration, fadeIn: i === 0 ? 0 : d };
    t += s.duration;
    return timing;
  });
  return { scenes, total: t };
}

/**
 * The scene with its zoom, ring and nav boxes in frame px: phone-take boxes go through `phoneToFrame` for a phone
 * placed at `align` (the plan's `phoneAlign`).
 */
export function inFramePixels(scene: PlanScene, align: PhoneAlign): PlanScene {
  if (!scene.phone) return scene;
  const toFrame = (b: Box) => phoneToFrame(b, align);
  const map = (t: Timed): Timed => ({ ...t, box: toFrame(t.box) });
  return {
    ...scene,
    zooms: scene.zooms?.map(map),
    rings: scene.rings?.map(map),
    navBox: scene.navBox && toFrame(scene.navBox),
    navs: scene.navs?.map((n) => ({ ...n, box: toFrame(n.box) })),
  };
}
