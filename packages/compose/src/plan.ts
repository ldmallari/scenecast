// Plan types, the scene timeline and zoom clamping (Node side). Per-frame helpers the Revideo
// page uses live in timing.ts, which stays free of Node imports.
import { DEFAULTS, phoneToFrame, type Box, type Brand, type Cue, type Segment } from '@scenecast/core';
export { easeInOutCubic, ringAlpha, sceneOpacity, srcTimeAt, zoomBoxAt } from './timing.js';

/** Something shown from `start` to `end` (scene seconds) around `box` (frame px; take px on phone scenes). */
export interface Timed {
  start: number;
  end: number;
  box: Box;
}

export interface CardSpec {
  variant: 'intro' | 'outro' | 'chapter';
  /** Intro defaults to `brand.introTitle`; outro and chapter cards need a title. */
  title?: string;
  /** Intro defaults to `brand.introSubtitle`. */
  subtitle?: string;
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
   * A 390×844 phone take, shown inside a CSS-drawn outline at 80% of the frame height. Its zoom,
   * ring and nav boxes are in the take's own pixels (as the recorder logs them); the renderer maps
   * them into the frame with core's `phoneToFrame`. Cue boxes are already in frame px (captions.ts).
   */
  phone?: boolean;
  /** The app's left nav (same pixel space as zooms), so a zoom never cuts it partly. */
  navBox?: Box;
}

export interface ComposePlan {
  brand: Brand;
  scenes: PlanScene[];
  /** Cross-fade between scenes; default `DEFAULTS.video.dissolveSec`. */
  dissolveSec?: number;
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
  /** Phone take rectangle in frame px. */
  phoneRect: Box;
  scenes: (PlanScene & SceneTiming)[];
}

const MAX_ZOOM = 2.5;
const NAV_MAX_W = 320;
const EPS = 1e-6;

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

const isLeftNav = (nav: Box | undefined, edge: number): nav is Box => !!nav && nav.x <= edge + EPS && nav.w < NAV_MAX_W;

/** Grows `b` around its centre to the frame's aspect and at most MAX_ZOOM magnification. */
function fitAspect(b: Box, frame: Box): Box {
  const aspect = frame.w / frame.h;
  let w = Math.max(b.w, b.h * aspect, frame.w / MAX_ZOOM);
  let h = w / aspect;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function clampInto(b: Box, frame: Box): Box {
  if (b.w >= frame.w - EPS || b.h >= frame.h - EPS) return { ...frame };
  const x = Math.min(Math.max(b.x, frame.x), frame.x + frame.w - b.w);
  const y = Math.min(Math.max(b.y, frame.y), frame.y + frame.h - b.h);
  return { x, y, w: b.w, h: b.h };
}

/** The region's left edge falls inside the nav (the part of it that is on screen). */
const cutsNav = (b: Box, nav: Box, frame: Box) => b.x > Math.max(nav.x, frame.x) + EPS && b.x < nav.x + nav.w - EPS;

/**
 * The zoom region for a target `box`: padded by `pad`, grown to the frame's aspect ratio
 * (never more than 2.5× magnification), clamped inside the frame. A left nav (`navBox`
 * with x ≤ `navEdge` and w < 320; `navEdge` is the screen's left edge: 0, or the phone
 * screen's x on phone scenes) is never cut partly: the region widens to include it or shifts
 * right to exclude it, whichever moves its left edge less (shifting only when the target
 * itself is clear of the nav). Returns the full frame when the target needs no zoom.
 */
export function clampZoom(box: Box, frame: Box, pad: number, navBox?: Box, navEdge = 0): Box {
  const padded = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
  let z = clampInto(fitAspect(padded, frame), frame);
  const nav = isLeftNav(navBox, navEdge) ? navBox : undefined;
  if (!nav || !cutsNav(z, nav, frame)) return z;

  const navRight = nav.x + nav.w;
  const widen = (): Box => {
    // Grow to the left edge of the nav, keeping the right edge, then refit.
    const right = z.x + z.w;
    const grown = fitAspect({ x: nav.x, y: z.y, w: right - nav.x, h: z.h }, frame);
    return clampInto({ ...grown, x: nav.x }, frame);
  };
  const targetClear = box.x >= navRight - EPS;
  const shiftBy = navRight - z.x;
  const widenBy = z.x - nav.x;
  if (targetClear && shiftBy <= widenBy) {
    const shifted = clampInto({ ...z, x: navRight }, frame);
    if (!cutsNav(shifted, nav, frame) && shifted.x <= box.x + EPS) return shifted;
  }
  return widen();
}

/** The scene with its zoom, ring and nav boxes in frame px: phone-take boxes go through `phoneToFrame`. */
export function inFramePixels(scene: PlanScene): PlanScene {
  if (!scene.phone) return scene;
  const map = (t: Timed): Timed => ({ ...t, box: phoneToFrame(t.box) });
  return {
    ...scene,
    zooms: scene.zooms?.map(map),
    rings: scene.rings?.map(map),
    navBox: scene.navBox && phoneToFrame(scene.navBox),
  };
}
