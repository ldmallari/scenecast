// Plan types, the scene timeline and zoom clamping (Node side). Per-frame helpers the Revideo
// page uses live in timing.ts, which stays free of Node imports.
import { DEFAULTS, phoneToFrame, type Box, type Brand, type Cue, type NavBox, type Segment } from '@scenecast/core';
export { clampZoom } from '@scenecast/core';
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
  /** The scene file's declared navs (`app.nav`), same pixel space as zooms: a zoom shows each whole or not at all. */
  navs?: NavBox[];
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

/** The scene with its zoom, ring and nav boxes in frame px: phone-take boxes go through `phoneToFrame`. */
export function inFramePixels(scene: PlanScene): PlanScene {
  if (!scene.phone) return scene;
  const map = (t: Timed): Timed => ({ ...t, box: phoneToFrame(t.box) });
  return {
    ...scene,
    zooms: scene.zooms?.map(map),
    rings: scene.rings?.map(map),
    navBox: scene.navBox && phoneToFrame(scene.navBox),
    navs: scene.navs?.map((n) => ({ ...n, box: phoneToFrame(n.box) })),
  };
}
