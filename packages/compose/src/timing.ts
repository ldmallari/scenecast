// Per-frame timing helpers. Pure and free of Node imports: the Revideo page runs them every frame.
import type { Box, CardsCfg, Segment } from '@scenecast/core';
import type { ResolvedBackground, SceneTiming, Timed } from './plan.js';

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


/** The accent bar's full width on a card, in px. */
export const CARD_BAR_W = 88;

export type CardPart = 'logo' | 'bar' | 'title' | 'subtitle' | 'next';
export interface PartLook {
  opacity: number;
  /** Extra px below the part's resting place. */
  dy: number;
  scale: number;
  /** The accent bar's width (the full width for every other part). */
  barW: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const RISE_PX = 14;
const REST: PartLook = { opacity: 1, dy: 0, scale: 1, barW: CARD_BAR_W };

/** `reveal`: the logo scales and fades in, the bar grows, then the text lines rise in one after another (ease-out). */
const REVEAL = {
  logo: { at: 0, sec: 0.6, fromScale: 0.92 },
  bar: { at: 0.15, sec: 0.5 },
  text: { title: 0.25, subtitle: 0.35, next: 0.45 } as Record<'title' | 'subtitle' | 'next', number>,
  textSec: 0.5,
};
/** `rise`, the v1 look: every part fades in and rises 14 px over 0.5 s (ease-in-out); the logo only fades. */
const RISE = { sec: 0.5, delay: { logo: 0, bar: 0, title: 0.05, subtitle: 0.15, next: 0.25 } as Record<CardPart, number> };

/** How a card part looks `t` seconds into its card under the given entrance. */
export function entranceAt(entrance: CardsCfg['entrance'], part: CardPart, t: number): PartLook {
  if (entrance === 'none') return { ...REST };
  if (entrance === 'rise') {
    const k = easeInOutCubic((t - RISE.delay[part]) / RISE.sec);
    return { opacity: k, dy: part === 'logo' ? 0 : RISE_PX * (1 - k), scale: 1, barW: CARD_BAR_W };
  }
  if (part === 'logo') {
    const k = easeOutCubic((t - REVEAL.logo.at) / REVEAL.logo.sec);
    return { opacity: k, dy: 0, scale: REVEAL.logo.fromScale + (1 - REVEAL.logo.fromScale) * k, barW: CARD_BAR_W };
  }
  if (part === 'bar') {
    const k = easeOutCubic((t - REVEAL.bar.at) / REVEAL.bar.sec);
    return { opacity: 1, dy: 0, scale: 1, barW: CARD_BAR_W * k };
  }
  const k = easeOutCubic((t - REVEAL.text[part]) / REVEAL.textSec);
  return { opacity: k, dy: RISE_PX * (1 - k), scale: 1, barW: CARD_BAR_W };
}

/**
 * The start and end points of a CSS `linear-gradient(<angle>deg, from, to)` over a `w`×`h` box, in coordinates
 * centred on the box with y down (Revideo's). 0 deg points up and angles turn clockwise, so 135 runs from the
 * top-left corner to the bottom-right one; as in CSS, the line is just long enough that those corners get
 * exactly `from` and `to`.
 */
export function gradientLine(angle: number, w: number, h: number): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return { from: { x: -dx * half, y: -dy * half }, to: { x: dx * half, y: dy * half } };
}

// Colour: which ink (text colour) reads on a background.

export const DARK_INK = '#14161B';
export const LIGHT_INK = '#FFFFFF';

/** The 0–1 sRGB channels of a #rgb / #rrggbb colour. */
export function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Relative luminance of sRGB channels (WCAG). */
export function luminanceOf([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two relative luminances. */
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The background's colour at a frame-px point (Revideo's centred coordinates), as 0–1 sRGB channels. */
function colourAt(bg: Exclude<ResolvedBackground, { kind: 'image' }>, x: number, y: number, width: number, height: number): [number, number, number] {
  if (bg.kind === 'color') return channels(bg.color);
  const { from, to } = gradientLine(bg.angle, width, height);
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const t = Math.min(1, Math.max(0, ((x - from.x) * dx + (y - from.y) * dy) / (dx * dx + dy * dy)));
  const [a, b] = [channels(bg.from), channels(bg.to)];
  return a.map((c, i) => c + (b[i]! - c) * t) as [number, number, number];
}

/**
 * Ink for text set straight on the background over `box` (frame px, top-left), or null when neither ink keeps 4.5:1
 * everywhere under it (or the background is a photo): such text needs a backing plate.
 */
export function inkOver(bg: ResolvedBackground, box: { x: number; y: number; w: number; h: number }, width: number, height: number): string | null {
  if (bg.kind === 'image') return null;
  const corners = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ].map(([x, y]) => luminanceOf(colourAt(bg, x! - width / 2, y! - height / 2, width, height)));
  const worst = (ink: string) => Math.min(...corners.map((l) => contrast(l, luminanceOf(channels(ink)))));
  const ink = worst(LIGHT_INK) >= worst(DARK_INK) ? LIGHT_INK : DARK_INK;
  return worst(ink) >= 4.5 ? ink : null;
}
