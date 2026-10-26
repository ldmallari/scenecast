import { DEFAULTS, type PhoneAlign } from './scene/schema.js';
import type { Box } from './record/record.js';

/** Share of the frame height a phone take fills in the composed frame. */
export const PHONE_HEIGHT_SHARE = 0.8;

/**
 * Where the phone take sits in the frame: scaled to 80% of the frame height and centred vertically. `center`
 * centres it across too; `left` and `right` put its centre at `phone.centreShare` (30%) or 1 − that (70%) of
 * the width, leaving room for captions beside it. Every caller passes the scene file's `phone.align`.
 */
export function phoneFrame(align: PhoneAlign): { x: number; y: number; w: number; h: number; scale: number } {
  const { width: fw, height: fh } = DEFAULTS.video;
  const { width: pw, height: ph, centreShare } = DEFAULTS.phone;
  const h = fh * PHONE_HEIGHT_SHARE;
  const scale = h / ph;
  const w = pw * scale;
  const cx = align === 'left' ? fw * centreShare : align === 'right' ? fw * (1 - centreShare) : fw / 2;
  return { x: cx - w / 2, y: (fh - h) / 2, w, h, scale };
}

/** The phone screen's rectangle in frame px (`phoneFrame` without its scale). */
export function phoneScreen(align: PhoneAlign): Box {
  const { x, y, w, h } = phoneFrame(align);
  return { x, y, w, h };
}

/** Maps a box in the 390×844 phone take's pixels into 1920×1080 frame pixels, for a phone placed at `align`. */
export function phoneToFrame(box: Box, align: PhoneAlign): Box {
  const f = phoneFrame(align);
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

/** A declared nav bar (`app.nav`) and its box, in the same pixel space as the zoom. */
export interface NavBox {
  edge: 'left' | 'top';
  box: Box;
}

const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS;
const contains = (outer: Box, inner: Box, tol = EPS) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;
const strictlyInside = (v: number, lo: number, hi: number) => v > lo + EPS && v < hi - EPS;

/**
 * The region shows the nav partly. A left nav is checked across: neither side of the region may fall
 * inside its x-span. A top nav is checked both ways: the region either misses it or holds all of it.
 */
export function cutsDeclaredNav(z: Box, nav: NavBox): boolean {
  const b = nav.box;
  if (nav.edge === 'left') return strictlyInside(z.x, b.x, b.x + b.w) || strictlyInside(z.x + z.w, b.x, b.x + b.w);
  return overlaps(z, b) && !contains(z, b);
}

/** Moves or grows `z` so it shows `nav` whole or not at all, keeping the padded target inside. */
function settleNav(z: Box, padded: Box, nav: NavBox, frame: Box): Box {
  if (!cutsDeclaredNav(z, nav)) return z;
  const b = nav.box;
  // Exclude it: shift past the nav when the target is clear of it.
  const shifted = nav.edge === 'left' ? clampInto({ ...z, x: b.x + b.w }, frame) : clampInto({ ...z, y: b.y + b.h }, frame);
  if (!cutsDeclaredNav(shifted, nav) && contains(shifted, padded)) return shifted;
  // Include it: grow to hold the nav (a left nav across only; a top bar whole), refit and clamp.
  const want = nav.edge === 'left' ? { x: b.x, y: z.y, w: z.x + z.w - b.x, h: z.h } : union(z, b);
  const grown = clampInto(fitAspect(union(want, padded), frame), frame);
  return grown;
}

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/**
 * The zoom region for a target `box`: padded by `pad`, grown to the frame's aspect ratio
 * (never more than 2.5× magnification), clamped inside the frame. A left nav (`navBox`
 * with x ≤ `navEdge` and w < 320; `navEdge` is the screen's left edge: 0, or the phone
 * screen's x on phone scenes) is never cut partly: the region widens to include it or shifts
 * right to exclude it, whichever moves its left edge less (shifting only when the target
 * itself is clear of the nav). Declared `navs` (the scene file's `app.nav`) are never cut
 * partly either: the region shifts past one (when the target is clear of it) or grows to hold
 * it. Returns the full frame when the target needs no zoom.
 */
export function clampZoom(box: Box, frame: Box, pad: number, navBox?: Box, navEdge = 0, navs: NavBox[] = []): Box {
  const padded = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
  let z = clampInto(fitAspect(padded, frame), frame);
  const nav = isLeftNav(navBox, navEdge) ? navBox : undefined;
  if (nav && cutsNav(z, nav, frame)) z = fixLeftNav(z, box, nav, frame);
  // Two passes: settling one nav can move the region onto another.
  for (let pass = 0; pass < 2; pass++) for (const n of navs) z = settleNav(z, padded, n, frame);
  return z;
}

function fixLeftNav(z: Box, box: Box, nav: Box, frame: Box): Box {
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
