import { phoneToFrame } from './frame.js';
import { travelSecFor, type Box, type Take } from './record/record.js';
import { DEFAULTS, type Scene } from './scene/schema.js';
import type { ScheduledStep } from './schedule.js';
import type { SceneVoice } from './voice.js';

export interface Cue {
  start: number;
  end: number;
  lines: string[];
  side: 'bottom' | 'top';
  box: Box;
  reason?: string;
}

/** Boxes (frame px) that must stay uncovered from `start` to `end` (output seconds). */
export interface CaptionEvent {
  start: number;
  end: number;
  boxes: Box[];
}

const FONT_PX = 44;
const LINE_HEIGHT = 1.3;
const PAD_X = 28;
const PAD_Y = 18;
const CHAR_EM = 0.55;
const EDGE = 72;

/** Caption events from a take: each event's boxes are active from its output time to the next event's (or `sceneEnd`). */
export function eventsForCaptions(take: Take, scheduled: ScheduledStep[], opts: { sceneEnd: number }): CaptionEvent[] {
  const map = (b: Box): Box => (take.viewport === 'phone' ? phoneToFrame(b) : b);
  const timed = take.events
    .map((e) => {
      const sch = scheduled.find((s) => s.index === e.index);
      if (!sch) throw new Error(`captions: no scheduled step for take event ${e.index}`);
      return { e, t: sch.startAt + travelSecFor(sch.step) };
    })
    .sort((a, b) => a.t - b.t);
  return timed.map(({ e, t }, i) => ({
    start: t,
    end: i + 1 < timed.length ? timed[i + 1]!.t : opts.sceneEnd,
    boxes: [e.target, e.ringBox, e.cursorTo, ...e.panels].filter((b): b is Box => b !== undefined).map(map),
  }));
}

/** Breaks any word longer than a line into line-sized pieces. */
function breakLongWords(words: string[], max: number): string[] {
  return words.flatMap((w) => (w.length <= max ? [w] : w.match(new RegExp(`.{1,${max}}`, 'gu')) ?? [w]));
}

const len = (ws: string[]) => ws.join(' ').length;

/** Splits words into two lines, as even as possible, avoiding a one-word line when there are 4+ words. */
function twoLines(words: string[]): string[] {
  if (words.length < 2) return [words.join(' ')];
  const minWords = words.length >= 4 ? 2 : 1;
  let best = -1;
  let bestMax = Infinity;
  for (let k = minWords; k <= words.length - minWords; k++) {
    const m = Math.max(len(words.slice(0, k)), len(words.slice(k)));
    if (m < bestMax) {
      bestMax = m;
      best = k;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** Lines for one cue: a single line when it fits, else two balanced lines. */
function cueLines(g: string[], max: number): string[] {
  return len(g) <= max ? [g.join(' ')] : twoLines(g);
}

/** Cuts words into n groups of similar size, each with at least `min` words; null if impossible. */
function breaksFor(words: string[], n: number, min: number): string[][] | null {
  if (n * min > words.length) return null;
  const prefix = [0];
  words.forEach((w, i) => prefix.push(prefix[i]! + w.length + 1));
  const total = prefix[words.length]!;
  const groups: string[][] = [];
  let from = 0;
  for (let c = 1; c < n; c++) {
    const lo = from + min;
    const hi = words.length - (n - c) * min;
    const target = prefix[from]! + ((total - prefix[from]!) / (n - c + 1));
    let to = lo;
    for (let k = lo; k <= hi; k++) if (Math.abs(prefix[k]! - target) < Math.abs(prefix[to]! - target)) to = k;
    groups.push(words.slice(from, to));
    from = to;
  }
  groups.push(words.slice(from));
  return groups;
}

/** Splits a phrase into cues of at most maxLines balanced lines. */
function splitPhrase(text: string): string[][] {
  const { maxLines, charsPerLine } = DEFAULTS.captions;
  const words = breakLongWords(text.trim().split(/\s+/).filter(Boolean), charsPerLine);
  if (!words.length) return [];
  if (len(words) <= charsPerLine) return [[words.join(' ')]];
  let fallback: string[][] | null = null;
  // Prefer two words per cue; drop to one only when pieces of a hard-broken word cannot fit otherwise.
  for (const min of words.length >= 4 ? [2, 1] : [1]) {
    for (let n = Math.max(1, Math.ceil(len(words) / (charsPerLine * maxLines))); ; n++) {
      const groups = breaksFor(words, n, min);
      if (!groups) break;
      const lines = groups.map((g) => cueLines(g, charsPerLine));
      fallback ??= lines;
      if (lines.every((l) => l.length <= maxLines && l.every((x) => x.length <= charsPerLine))) return lines;
    }
  }
  return fallback ?? [[words.join(' ')]];
}

/** Total area of the union of `boxes` clipped to `clip`. */
function unionArea(boxes: Box[], clip: Box): number {
  const rs = boxes
    .map((b) => ({
      x0: Math.max(b.x, clip.x),
      y0: Math.max(b.y, clip.y),
      x1: Math.min(b.x + b.w, clip.x + clip.w),
      y1: Math.min(b.y + b.h, clip.y + clip.h),
    }))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  const xs = [...new Set(rs.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const [xa, xb] = [xs[i]!, xs[i + 1]!];
    const ys = rs.filter((r) => r.x0 <= xa && r.x1 >= xb).map((r) => [r.y0, r.y1] as const).sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [y0, y1] of ys) {
      covered += Math.max(0, y1 - Math.max(y0, end));
      end = Math.max(end, y1);
    }
    area += covered * (xb - xa);
  }
  return area;
}

function captionBox(lines: string[], side: 'bottom' | 'top'): Box {
  const { width: W, height: H } = DEFAULTS.video;
  const widest = Math.max(...lines.map((l) => l.length));
  const w = Math.min(W, widest * CHAR_EM * FONT_PX + 2 * PAD_X);
  const h = lines.length * FONT_PX * LINE_HEIGHT + 2 * PAD_Y;
  return { x: Math.max(0, (W - w) / 2), y: side === 'bottom' ? H - EDGE - h : EDGE, w, h };
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Phrase by phrase, cue by cue; each cue sits at the bottom unless something it must not cover is there. */
export function layoutCaptions(_scene: Pick<Scene, 'id'>, voice: SceneVoice, events: CaptionEvent[]): Cue[] {
  const { width: W, height: H } = DEFAULTS.video;
  const zone: Box = { x: 0, y: H * (1 - DEFAULTS.captions.bottomZone), w: W, h: H * DEFAULTS.captions.bottomZone };
  const cues: Cue[] = [];
  for (const phrase of voice.phrases) {
    const groups = splitPhrase(phrase.text);
    const chars = groups.map((g) => g.join(' ').length);
    const sum = chars.reduce((a, b) => a + b, 0);
    let acc = 0;
    groups.forEach((lines, i) => {
      const start = i === 0 ? phrase.start : phrase.start + ((phrase.end - phrase.start) * acc) / sum;
      acc += chars[i]!;
      const end = i === groups.length - 1 ? phrase.end : phrase.start + ((phrase.end - phrase.start) * acc) / sum;
      const boxes = events.filter((e) => e.start < end && e.end > start).flatMap((e) => e.boxes);
      const bottom = captionBox(lines, 'bottom');
      const top = captionBox(lines, 'top');
      const cue: Cue = { start, end, lines, side: 'bottom', box: bottom };
      // The bottom zone only triggers a look at the top; the choice compares real caption-box overlap.
      const trigger = boxes.some((b) => overlap(b, zone) > 0 || overlap(b, bottom) > 0);
      const bottomHit = trigger ? unionArea(boxes, bottom) : 0;
      if (bottomHit > 0) {
        const topHit = unionArea(boxes, top);
        if (topHit === 0) Object.assign(cue, { side: 'top', box: top });
        else if (topHit < bottomHit)
          Object.assign(cue, { side: 'top', box: top, reason: 'both sides overlap the target; top overlaps less' });
        else cue.reason = `both sides overlap the target; ${topHit === bottomHit ? 'equal, bottom kept' : 'bottom overlaps less'}`;
      }
      cues.push(cue);
    });
  }
  return cues;
}

function stamp(sec: number): string {
  const ms = Math.round(sec * 1000);
  const p = (n: number, d: number) => String(n).padStart(d, '0');
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
}

export function toSrt(cues: Pick<Cue, 'start' | 'end' | 'lines'>[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.lines.join('\n')}\n`).join('\n');
}

export function parseSrt(srt: string): { start: number; end: number; lines: string[] }[] {
  const sec = (s: string) => {
    const m = /^(\d+):(\d\d):(\d\d),(\d{3})$/.exec(s.trim());
    if (!m) throw new Error(`srt: bad timestamp "${s}"`);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  return srt
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const [, time, ...lines] = block.split('\n');
      const [a, b] = (time ?? '').split('-->');
      return { start: sec(a ?? ''), end: sec(b ?? ''), lines };
    });
}
