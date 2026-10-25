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
  const times = take.events.map((e) => {
    const sch = scheduled.find((s) => s.index === e.index);
    if (!sch) throw new Error(`captions: no scheduled step for take event ${e.index}`);
    return sch.startAt + travelSecFor(sch.step);
  });
  return take.events.map((e, i) => ({
    start: times[i]!,
    end: i + 1 < times.length ? times[i + 1]! : opts.sceneEnd,
    boxes: [e.target, e.cursorTo, ...e.panels].filter((b): b is Box => b !== undefined).map(map),
  }));
}

/** Splits words into two lines, as even as possible, avoiding a one-word line when there are 4+ words. */
function twoLines(words: string[]): string[] {
  if (words.length < 2) return [words.join(' ')];
  const minWords = words.length >= 4 ? 2 : 1;
  let best = -1;
  let bestMax = Infinity;
  for (let k = minWords; k <= words.length - minWords; k++) {
    const m = Math.max(words.slice(0, k).join(' ').length, words.slice(k).join(' ').length);
    if (m < bestMax) {
      bestMax = m;
      best = k;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** Splits a phrase into cues of at most maxLines balanced lines. */
function splitPhrase(text: string): string[][] {
  const { maxLines, charsPerLine } = DEFAULTS.captions;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const total = words.join(' ').length;
  if (total <= charsPerLine) return [[words.join(' ')]];
  const n = Math.max(1, Math.ceil(total / (charsPerLine * maxLines)));
  // Balanced cue breaks: nearest word boundary to each even share, never leaving a one-word cue.
  const groups: string[][] = [];
  let from = 0;
  let consumed = 0;
  for (let c = 1; c <= n; c++) {
    if (c === n) {
      groups.push(words.slice(from));
      break;
    }
    const target = (total * c) / n;
    let to = from + 1;
    let acc = consumed + words[from]!.length;
    while (to < words.length - 1 && Math.abs(acc + 1 + words[to]!.length - target) < Math.abs(acc - target)) {
      acc += 1 + words[to]!.length;
      to++;
    }
    groups.push(words.slice(from, to));
    consumed = acc + 1;
    from = to;
  }
  return groups.map((g) => (g.join(' ').length <= charsPerLine ? [g.join(' ')] : twoLines(g)));
}

function captionBox(lines: string[], side: 'bottom' | 'top'): Box {
  const { width: W, height: H } = DEFAULTS.video;
  const widest = Math.max(...lines.map((l) => l.length));
  const w = widest * CHAR_EM * FONT_PX + 2 * PAD_X;
  const h = lines.length * FONT_PX * LINE_HEIGHT + 2 * PAD_Y;
  return { x: (W - w) / 2, y: side === 'bottom' ? H - EDGE - h : EDGE, w, h };
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
      const bottomHit = boxes.reduce((a, b) => a + Math.max(overlap(b, zone), overlap(b, bottom)), 0);
      const topHit = boxes.reduce((a, b) => a + overlap(b, top), 0);
      const cue: Cue = { start, end, lines, side: 'bottom', box: bottom };
      if (bottomHit > 0) {
        if (topHit === 0) Object.assign(cue, { side: 'top', box: top });
        else if (topHit < bottomHit) {
          Object.assign(cue, { side: 'top', box: top, reason: 'both sides overlap the target; top overlaps less' });
        } else cue.reason = 'both sides overlap the target; bottom overlaps less';
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
