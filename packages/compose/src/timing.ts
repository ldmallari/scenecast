// Per-frame timing helpers. Pure and free of Node imports: the Revideo page runs them every frame.
import type { Box, Segment } from '@scenecast/core';
import type { SceneTiming, Timed } from './plan.js';

const RING_FADE = 0.15;
const RING_OPACITY = 0.9;
const EPS = 1e-6;

/** Opacity of a scene at global time `t`: fades in before `start`, hidden from `end`. */
export function sceneOpacity(s: SceneTiming, t: number): number {
  if (t >= s.end - EPS || t < s.start - s.fadeIn - EPS) return 0;
  if (t >= s.start || s.fadeIn === 0) return 1;
  return Math.min(1, Math.max(0, (t - (s.start - s.fadeIn)) / s.fadeIn));
}

/** Source file and time shown at scene time `t`. Before the first segment shows its first frame. */
export function srcTimeAt(segments: Segment[], t: number): { src: string; time: number } | undefined {
  if (!segments.length) return undefined;
  let seg = segments[0]!;
  for (const s of segments) if (s.outStart <= t + EPS) seg = s;
  if (seg.hold !== undefined) return { src: seg.src, time: seg.srcIn };
  const time = seg.srcIn + Math.max(0, t - seg.outStart);
  return { src: seg.src, time: Math.min(seg.srcOut, time) };
}

export function easeInOutCubic(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
}

const lerpBox = (a: Box, b: Box, k: number): Box => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
  w: a.w + (b.w - a.w) * k,
  h: a.h + (b.h - a.h) * k,
});

/**
 * The visible region at scene time `t`: each zoom eases in from whatever was showing over
 * `easeSec` (an `instant` zoom shows its box at once), holds until its end, then eases back to
 * the full frame (unless the next zoom has already started).
 */
export function zoomBoxAt(zooms: Timed[], t: number, full: Box, easeSec: number): Box {
  const sorted = [...zooms].sort((a, b) => a.start - b.start);
  const moves: { at: number; to: Box; instant?: boolean }[] = [];
  sorted.forEach((z, i) => {
    moves.push({ at: z.start, to: z.box, ...(z.instant ? { instant: true } : {}) });
    const next = sorted[i + 1];
    if (!next || next.start > z.end) moves.push({ at: z.end, to: full });
  });
  const valueAt = (time: number, upto: number): Box => {
    let i = upto;
    while (i >= 0 && moves[i]!.at > time) i--;
    if (i < 0) return full;
    const m = moves[i]!;
    const k = easeSec > 0 && !m.instant ? easeInOutCubic((time - m.at) / easeSec) : 1;
    if (k >= 1) return m.to;
    return lerpBox(valueAt(m.at, i - 1), m.to, k);
  };
  return valueAt(t, moves.length - 1);
}

/** Ring opacity: fades in and out over 150 ms, 90% at full strength. */
export function ringAlpha(r: { start: number; end: number }, t: number): number {
  if (t < r.start || t > r.end) return 0;
  const k = Math.min(1, (t - r.start) / RING_FADE, (r.end - t) / RING_FADE);
  return RING_OPACITY * Math.max(0, k);
}

