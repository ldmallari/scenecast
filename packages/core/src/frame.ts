import { DEFAULTS } from './scene/schema.js';
import type { Box } from './record/record.js';

/** Share of the frame height a phone take fills in the composed frame. */
export const PHONE_HEIGHT_SHARE = 0.8;

/** Where the phone take sits in the frame: scaled to 80% of frame height, centred both ways. */
export function phoneFrame(): { x: number; y: number; w: number; h: number; scale: number } {
  const { width: fw, height: fh } = DEFAULTS.video;
  const { width: pw, height: ph } = DEFAULTS.phone;
  const h = fh * PHONE_HEIGHT_SHARE;
  const scale = h / ph;
  const w = pw * scale;
  return { x: (fw - w) / 2, y: (fh - h) / 2, w, h, scale };
}

/** Maps a box in the 390×844 phone take's pixels into 1920×1080 frame pixels. */
export function phoneToFrame(box: Box): Box {
  const f = phoneFrame();
  return { x: f.x + box.x * f.scale, y: f.y + box.y * f.scale, w: box.w * f.scale, h: box.h * f.scale };
}

// Zoom geometry, shared by the composer (which draws it) and the audit (which checks it).

const MAX_ZOOM = 2.5;
const NAV_MAX_W = 320;
const EPS = 1e-6;

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

