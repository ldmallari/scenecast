import { clampZoom, phoneScreen, phoneToFrame } from './frame.js';
import type { Box, Take } from './record/record.js';
import { DEFAULTS, type PhoneAlign, type Scene } from './scene/schema.js';
import { actionAt, type ScheduledStep } from './schedule.js';
import type { SceneVoice } from './voice.js';

/** Where a cue sits: centred at the bottom or top, in a corner, or (phone scenes) in the column beside the phone. */
export type CaptionSide = 'bottom' | 'top' | 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'beside';

/** How captions are cut and where they may go: `sides` are tried in order. */
export interface CaptionLayout {
  charsPerLine: number;
  maxLines: number;
  sides: CaptionSide[];
  /** The column (frame px) a `beside` cue sits in. */
  beside?: Box;
}

export const DESKTOP_CAPTIONS: CaptionLayout = {
  charsPerLine: DEFAULTS.captions.charsPerLine,
  maxLines: DEFAULTS.captions.maxLines,
  sides: ['bottom', 'top', 'bottom-left', 'bottom-right', 'top-left', 'top-right'],
};

/**
 * Captions for a phone scene. A phone placed `left` or `right` has a column beside it: from
 * `captions.beside.gapPx` (120 px) past the phone screen to that far from the frame edge, as tall as the phone,
 * with shorter lines (30 characters, 3 lines). A cue tries that column first, then the bottom and the top.
 * A centred phone has no room beside it and uses the desktop layout.
 */
export function phoneCaptions(align: PhoneAlign): CaptionLayout {
  if (align === 'center') return DESKTOP_CAPTIONS;
  const W = DEFAULTS.video.width;
  const { charsPerLine, maxLines, gapPx } = DEFAULTS.captions.beside;
  const body = phoneBody(align);
  const s = phoneScreen(align);
  const [x0, x1] = align === 'left' ? [body.x + body.w + gapPx, W - gapPx] : [gapPx, body.x - gapPx];
  return { charsPerLine, maxLines, sides: ['beside', 'bottom', 'top'], beside: { x: x0, y: s.y, w: x1 - x0, h: s.h } };
}

/** The drawn phone (its screen plus the bezel the composer draws around it), in frame px. */
export function phoneBody(align: PhoneAlign): Box {
  const s = phoneScreen(align);
  const b = DEFAULTS.phone.bezelPx;
  return { x: s.x - b, y: s.y - b, w: s.w + 2 * b, h: s.h + 2 * b };
}

/** The column beside the phone lies right of the frame's centre (the phone is on the left). */
export const besideOnRight = (beside: Box) => beside.x + beside.w / 2 > DEFAULTS.video.width / 2;

/** Words a cue or a line never ends on (compared lower-cased, letters only). */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  'a an the to of and or but for in on at by with from into onto as if so than then that this is are be your my our their its'.split(' '),
);

export interface Cue {
  start: number;
  end: number;
  lines: string[];
  side: CaptionSide;
  box: Box;
  reason?: string;
}

/** Boxes (frame px) that must stay uncovered from `start` to `end` (output seconds). */
export interface CaptionEvent {
  start: number;
  end: number;
  boxes: Box[];
  /**
   * The phone as shown while a zoom on a phone scene magnifies it: the column beside the phone is not free while
   * it overlaps them, so the cue goes to the next side (with a plate). Never a reason to report: only `beside` is
   * ruled out by them.
   */
  besideBlockers?: Box[];
}

const FONT_PX = 44;
const LINE_HEIGHT = 1.3;
const PAD_X = 28;
const PAD_Y = 18;
const CHAR_EM = 0.55;
const EDGE = 72;

/**
 * Caption events from a take timed by the schedule alone (no zooms): a thin wrapper over `zoomedCaptionEvents`,
 * which is what the pipeline uses, so there is one caption-event builder.
 */
export function eventsForCaptions(take: Take, scheduled: ScheduledStep[], opts: { sceneEnd: number; align: PhoneAlign }): CaptionEvent[] {
  const times = new Map<number, number>();
  for (const e of take.events) {
    const sch = scheduled.find((s) => s.index === e.index);
    if (!sch) throw new Error(`captions: no scheduled step for take event ${e.index}`);
    times.set(e.index, actionAt(sch));
  }
  return zoomedCaptionEvents(take, times, [], opts.sceneEnd, opts.align);
}

const EPS = 1e-6;

const intersect = (a: Box, b: Box): Box => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};

/**
 * The box covers at least `fullFrameShare` (90%) of the screen: area(box ∩ screen) ≥ 0.9 · area(screen).
 * Such a box can't be kept clear of a caption, so caption layout and the audit don't protect it.
 */
export function fillsScreen(box: Box, screen: Box): boolean {
  const area = screen.w * screen.h;
  if (!(area > 0)) return false;
  const i = intersect(box, screen);
  return i.w * i.h >= DEFAULTS.captions.fullFrameShare * area - EPS;
}

/** Where `box` (frame px) shows on screen while the composer shows the region `zoom`. */
export function onScreen(box: Box, zoom: Box | null): Box {
  if (!zoom) return box;
  const s = DEFAULTS.video.width / zoom.w;
  return { x: (box.x - zoom.x) * s, y: (box.y - zoom.y) * s, w: box.w * s, h: box.h * s };
}

/**
 * The views on screen during [lo, hi): null (the whole frame) and/or each zoom region, the way the
 * audit reads them: a held zoom shows only its region; while one eases in or out, both ends count.
 */
function views(lo: number, hi: number, zooms: TimedBox[], ease: number): (Box | null)[] {
  let rest: [number, number][] = [[lo, hi]];
  for (const z of zooms) {
    const [hl, hh] = [z.start + (z.instant ? 0 : ease), z.end];
    rest = rest.flatMap(([a, b]): [number, number][] => {
      if (hh <= a || hl >= b || hl >= hh) return [[a, b]];
      const out: [number, number][] = [];
      if (hl > a) out.push([a, hl]);
      if (hh < b) out.push([hh, b]);
      return out;
    });
  }
  const out: (Box | null)[] = rest.some(([a, b]) => b - a > EPS) ? [null] : [];
  for (const z of zooms) if (lo < z.end + ease && hi > z.start) out.push(z.box);
  return out;
}

/** Something shown from `start` to `end` (scene seconds) around `box`: a plan zoom (take px on phone scenes). */
export interface TimedBox {
  start: number;
  end: number;
  box: Box;
  /** Shown from `start` with no ease-in (a scene that starts zoomed). */
  instant?: boolean;
}

/**
 * Caption events on screen, for a scene with zooms. `times` is each take event's output time (where
 * retime put it); `zooms` are the plan's zooms (unclamped, as the composer gets them). Each take event's
 * boxes (target, ring, cursor, panels; phone boxes mapped into the frame once) stay active until the
 * next event. Every window is split where a zoom starts,
 * finishes easing, ends or finishes easing out, and each piece carries the boxes as they look on
 * screen in every view of that piece, so a caption clear of these is clear of what the audit checks.
 * A box that fills the app's screen as shown in a view (the frame, or the phone screen, seen through
 * that view and clipped to the frame; see `fillsScreen`) is left out of that view. `align` is where the
 * phone sits (the scene file's `phone.align`); desktop takes ignore it.
 */
export function zoomedCaptionEvents(
  take: Take,
  times: Map<number, number>,
  zooms: TimedBox[],
  sceneEnd: number,
  align: PhoneAlign,
): CaptionEvent[] {
  const phone = take.viewport === 'phone';
  const toFrame = (b: Box) => (phone ? phoneToFrame(b, align) : b);
  const navs = (take.navs ?? []).map((n) => ({ ...n, box: toFrame(n.box) }));
  const ease = DEFAULTS.video.zoomEaseSec;
  const frame: Box = { x: 0, y: 0, w: DEFAULTS.video.width, h: DEFAULTS.video.height };
  const screen: Box = phone ? phoneScreen(align) : frame;
  const regions: TimedBox[] = zooms.map((z) => ({
    ...z,
    box: clampZoom(toFrame(z.box), frame, DEFAULTS.audit.zoomPadPx, undefined, phone ? screen.x : 0, navs),
  }));
  /** The boxes as they look in view `v`, without those that fill the screen shown there. */
  const shown = (boxes: Box[], v: Box | null): Box[] => {
    const visible = intersect(onScreen(screen, v), frame);
    return boxes.map((b) => onScreen(b, v)).filter((b) => !fillsScreen(b, visible));
  };
  const timed = take.events
    .map((e) => ({ e, t: times.get(e.index)! }))
    .sort((a, b) => a.t - b.t);
  const out: CaptionEvent[] = [];
  timed.forEach(({ e, t }, i) => {
    const end = i + 1 < timed.length ? timed[i + 1]!.t : sceneEnd;
    const boxes = [e.target, e.ringBox, e.cursorTo, ...e.panels].filter((b): b is Box => b !== undefined).map(toFrame);
    const cuts = [t, end];
    for (const z of regions) for (const c of [z.start, z.start + ease, z.end, z.end + ease]) if (c > t && c < end) cuts.push(c);
    cuts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const [lo, hi] = [cuts[k]!, cuts[k + 1]!];
      if (hi - lo <= EPS) continue;
      out.push({ start: lo, end: hi, boxes: views(lo, hi, regions, ease).flatMap((v) => shown(boxes, v)) });
    }
  });
  // A zoom on a phone scene magnifies the phone, which can then reach under the column beside it: from the zoom's
  // start until it has eased out, the phone as shown (both ends of the ease, spanned) rules that column out.
  if (phone) {
    const body = phoneBody(align);
    for (const z of regions) {
      const ends = [body, onScreen(body, z.box)].map((b) => intersect(b, frame));
      const x = Math.min(...ends.map((b) => b.x));
      const y = Math.min(...ends.map((b) => b.y));
      const span = { x, y, w: Math.max(...ends.map((b) => b.x + b.w)) - x, h: Math.max(...ends.map((b) => b.y + b.h)) - y };
      out.push({ start: z.start, end: Math.min(sceneEnd, z.end + ease), boxes: [], besideBlockers: [span] });
    }
  }
  return out;
}

/** Breaks any word longer than a line into line-sized pieces. */
function breakLongWords(words: string[], max: number): string[] {
  return words.flatMap((w) => (w.length <= max ? [w] : w.match(new RegExp(`.{1,${max}}`, 'gu')) ?? [w]));
}

const len = (ws: string[]) => ws.join(' ').length;

/**
 * A break after a function word costs this much: finite, so when every way to cut needs one the cut still
 * happens (the rule is dropped for that break only); far above any other cost, so it never wins otherwise.
 */
const FUNCTION_WORD_BREAK = 1e6;
/** A break that does not follow clause punctuation (`, : ; — .`). */
const MID_CLAUSE_BREAK = 1;
const CLAUSE_END = /[,:;—.]["'”’)\]]*$/u;
/**
 * A possessive ("Demo Co's", "users'"): it belongs with the word after it, so a break after it costs like a function
 * word's. A quoted label ending in s ("‘Requests’", "'Settings'") is not one: it opens with a quote.
 */
const POSSESSIVE = /^(?!['‘"“]).*\p{L}(?:['’]s|s['’])$/u;
/**
 * Abbreviations whose full stop ends no clause ("e.g.", "a.m.", "Demo Co."), inside brackets or quotes and with a
 * comma or closing bracket after them.
 */
const ABBREVIATION = /^[(\["“‘]*(?:e\.g|i\.e|etc|vs|cf|approx|incl|a\.m|p\.m|co|inc|ltd|no|st|jr|sr|mr|mrs|ms|dr)\.[)\]"”’]*,?$/iu;

const COMPOUND = /\p{L}-\p{L}/u;
const isFunctionWord = (word: string) => FUNCTION_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, ''));

/**
 * The cost of breaking after `word`. A word that ends a clause is a free break even when it is a function word
 * ("…asked for, / Open"): it ends its clause, so a line may end on it.
 */
function breakCost(word: string): number {
  if (ABBREVIATION.test(word)) return MID_CLAUSE_BREAK;
  if (CLAUSE_END.test(word)) return 0;
  if (isFunctionWord(word)) return FUNCTION_WORD_BREAK;
  if (POSSESSIVE.test(word)) return FUNCTION_WORD_BREAK;
  return MID_CLAUSE_BREAK;
}

/**
 * The cost of breaking before `words[i]`: `breakCost` of the word before, and two breaks that cost like ending on a
 * function word, because both split what reads as one unit:
 * - after a hyphenated compound that leads into its noun ("your to-do / list"), unless the next word is a function
 *   word ("sign-in / to");
 * - before a function word that ends a clause the line before does not end ("the team asked / for, Open"): it leaves the
 *   clause's last word alone at the start of the line.
 */
function breakCostAt(words: string[], i: number): number {
  const [prev, next] = [words[i - 1]!, words[i]];
  const cost = breakCost(prev);
  if (next === undefined || CLAUSE_END.test(prev) || ABBREVIATION.test(prev)) return cost;
  if (COMPOUND.test(prev) && !isFunctionWord(next)) return FUNCTION_WORD_BREAK;
  if (CLAUSE_END.test(next) && isFunctionWord(next)) return Math.max(cost, FUNCTION_WORD_BREAK);
  return cost;
}

/**
 * The cheapest way to cut words[0..n) into `parts` pieces: the sum of each piece's cost and the cost of
 * each break. `piece(i, j)` is the cost of words[i..j) as one piece (Infinity when it can't be one).
 * Returns the end index of each piece and the total cost, or null when no cut is finite.
 */
function cheapestCut(words: string[], parts: number, piece: (i: number, j: number) => number): { ends: number[]; cost: number } | null {
  const n = words.length;
  // best[k][j]: cheapest cost of words[0..j) in k pieces; from[k][j]: where the last of them starts.
  const best = Array.from({ length: parts + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from = Array.from({ length: parts + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let k = 1; k <= parts; k++)
    for (let j = k; j <= n; j++)
      for (let i = k - 1; i < j; i++) {
        const before = best[k - 1]![i]!;
        if (before === Infinity) continue;
        const c = before + piece(i, j) + (i > 0 ? breakCostAt(words, i) : 0);
        if (c < best[k]![j]!) {
          best[k]![j] = c;
          from[k]![j] = i;
        }
      }
  if (best[parts]![n] === Infinity) return null;
  const ends: number[] = [];
  for (let k = parts, j = n; k > 0; j = from[k]![j]!, k--) ends.unshift(j);
  return { ends, cost: best[parts]![n]! };
}

/**
 * Caption imbalance (preflight F17): Σ(len_i − mean)² / charsPerLine², over the pieces' character lengths.
 * The total length of `parts` pieces is fixed, so the mean is too and each piece adds its own term.
 */
const imbalance = (pieceLen: number, mean: number, charsPerLine: number) => (pieceLen - mean) ** 2 / charsPerLine ** 2;

/** The mean piece length when words[0..n) (`total` characters joined) is cut into `parts` pieces. */
const meanLen = (total: number, parts: number) => (total - (parts - 1)) / parts;

/**
 * Cuts words into the fewest pieces (from `minParts`) that need no break after a function word (nor a piece that
 * must end a line on one): one more piece beats such a break, so a word moves down rather than end a line or cue
 * on "your". When every count needs one, it takes the fewest pieces for which `piece` is finite. Cheapest first
 * within a count; each piece holds at least `minWords` words. Returns the pieces' word ranges, or null.
 */
function fewestPieces(
  words: string[],
  minParts: number,
  maxParts: number,
  minWords: number,
  piece: (i: number, j: number, mean: number) => number,
): [number, number][] | null {
  const total = len(words);
  let fallback: number[] | null = null;
  for (let parts = Math.max(1, minParts); parts <= Math.min(maxParts, Math.floor(words.length / minWords)); parts++) {
    const mean = meanLen(total, parts);
    const cut = cheapestCut(words, parts, (i, j) => (j - i < minWords ? Infinity : piece(i, j, mean)));
    if (!cut) continue;
    if (cut.cost < FUNCTION_WORD_BREAK) return ranges(cut.ends);
    fallback ??= cut.ends;
  }
  return fallback && ranges(fallback);
}

const ranges = (ends: number[]): [number, number][] => ends.map((e, k) => [k ? ends[k - 1]! : 0, e]);

/**
 * The lines of one cue (one line when it fits), cut with the same costs as cues, or null when the words
 * can't fit in `maxLines`. `forced` is the cost of the function-word line ends it could not avoid.
 */
function cueLines(words: string[], layout: CaptionLayout): { lines: string[]; forced: number } | null {
  const { charsPerLine, maxLines } = layout;
  if (len(words) <= charsPerLine) return { lines: [words.join(' ')], forced: 0 };
  // No one-word line in a cue of 4+ words.
  const ranges = fewestPieces(words, 2, maxLines, words.length >= 4 ? 2 : 1, (i, j, mean) => {
    const l = len(words.slice(i, j));
    return l > charsPerLine ? Infinity : imbalance(l, mean, charsPerLine);
  });
  if (!ranges) return null;
  const forced = ranges.reduce((a, [i]) => a + (i > 0 && breakCostAt(words, i) >= FUNCTION_WORD_BREAK ? FUNCTION_WORD_BREAK : 0), 0);
  return { lines: ranges.map(([i, j]) => words.slice(i, j).join(' ')), forced };
}

/**
 * Splits a phrase into cues of lines. It uses the fewest cues that fit with no cue or line ending on a function
 * word (one more cue, rather than a line ending on "your"; the fewest that fit at all when every count needs such
 * an end); among those, it picks the breaks
 * (between cues and between lines) with the lowest total cost: a break after a function word is all but
 * ruled out, one that does not follow clause punctuation costs 1, and uneven cues or lines add their
 * imbalance. Cues hold at least two words when the phrase has 4+ (one only when a hard-broken word needs it).
 * The split depends only on the text and `layout`, never on where a cue is placed.
 */
export function splitCaption(text: string, layout: CaptionLayout = DESKTOP_CAPTIONS): string[][] {
  const { charsPerLine, maxLines } = layout;
  const words = breakLongWords(text.trim().split(/\s+/).filter(Boolean), charsPerLine);
  if (!words.length) return [];
  if (len(words) <= charsPerLine) return [[words.join(' ')]];
  const memo = new Map<string, ReturnType<typeof cueLines>>();
  const linesOf = (i: number, j: number) => {
    const key = `${i},${j}`;
    if (!memo.has(key)) memo.set(key, len(words.slice(i, j)) > charsPerLine * maxLines ? null : cueLines(words.slice(i, j), layout));
    return memo.get(key)!;
  };
  for (const minWords of words.length >= 4 ? [2, 1] : [1]) {
    const ranges = fewestPieces(words, Math.ceil(len(words) / (charsPerLine * maxLines)), words.length, minWords, (i, j, mean) => {
      const cue = linesOf(i, j);
      // A cue is scored by the breaks around it and its imbalance; its own line breaks are chosen
      // afterwards, except that a cue whose lines must end on a function word costs as if a cue did.
      return cue ? cue.forced + imbalance(len(words.slice(i, j)), mean, charsPerLine) : Infinity;
    });
    if (ranges) return ranges.map(([i, j]) => linesOf(i, j)!.lines);
  }
  // Unreachable: every word fits a line, so one word per cue always fits.
  return words.map((w) => [w]);
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

/**
 * The cue's box on `side`. Every side has the same size, so where a cue lands never changes its lines. A `beside`
 * cue sits in the layout's column, centred on it vertically and against its side facing the phone.
 */
function captionBox(lines: string[], side: CaptionSide, layout: CaptionLayout): Box {
  const { width: W, height: H } = DEFAULTS.video;
  const widest = Math.max(...lines.map((l) => l.length));
  const w = Math.min(W, widest * CHAR_EM * FONT_PX + 2 * PAD_X);
  const h = lines.length * FONT_PX * LINE_HEIGHT + 2 * PAD_Y;
  const centred = Math.max(0, (W - w) / 2);
  const [bottom, top] = [H - EDGE - h, EDGE];
  const [left, right] = [Math.min(EDGE, centred), Math.max(centred, W - EDGE - w)];
  switch (side) {
    case 'bottom':
      return { x: centred, y: bottom, w, h };
    case 'top':
      return { x: centred, y: top, w, h };
    case 'bottom-left':
      return { x: left, y: bottom, w, h };
    case 'bottom-right':
      return { x: right, y: bottom, w, h };
    case 'top-left':
      return { x: left, y: top, w, h };
    case 'top-right':
      return { x: right, y: top, w, h };
    case 'beside': {
      const col = layout.beside;
      if (!col) throw new Error("captions: 'beside' needs a layout with a beside column (phoneCaptions)");
      const bw = Math.min(w, col.w);
      return { x: besideOnRight(col) ? col.x : col.x + col.w - bw, y: col.y + (col.h - h) / 2, w: bw, h };
    }
  }
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Phrase by phrase, cue by cue: each cue takes the first side in `layout.sides` that covers nothing it must
 * not cover. When every side covers something, it takes the side that covers least (the earliest on a tie)
 * and says why in `reason`.
 */
export function layoutCaptions(
  _scene: Pick<Scene, 'id'>,
  voice: SceneVoice,
  events: CaptionEvent[],
  layout: CaptionLayout = DESKTOP_CAPTIONS,
): Cue[] {
  const cues: Cue[] = [];
  for (const phrase of voice.phrases) {
    const groups = splitCaption(phrase.text, layout);
    const chars = groups.map((g) => g.join(' ').length);
    const sum = chars.reduce((a, b) => a + b, 0);
    let acc = 0;
    groups.forEach((lines, i) => {
      const start = i === 0 ? phrase.start : phrase.start + ((phrase.end - phrase.start) * acc) / sum;
      acc += chars[i]!;
      const end = i === groups.length - 1 ? phrase.end : phrase.start + ((phrase.end - phrase.start) * acc) / sum;
      const during = events.filter((e) => e.start < end && e.end > start);
      const boxes = during.flatMap((e) => e.boxes);
      const blockers = during.flatMap((e) => e.besideBlockers ?? []);
      let best: { side: CaptionSide; box: Box; hit: number } | null = null;
      let tie = false;
      for (const side of layout.sides) {
        const box = captionBox(lines, side, layout);
        // The magnified phone under the column: that side is out (unless it is the only one).
        if (side === 'beside' && layout.sides.length > 1 && blockers.some((b) => overlap(b, box) > 0)) continue;
        const hit = boxes.some((b) => overlap(b, box) > 0) ? unionArea(boxes, box) : 0;
        // Areas within a rounding error of each other are a tie (box edges are fractional px).
        if (!best || hit < best.hit - EPS) [best, tie] = [{ side, box, hit }, false];
        else if (Math.abs(hit - best.hit) <= EPS) tie = true;
        if (hit === 0) break;
      }
      if (!best) throw new Error('captions: the layout has no sides');
      const cue: Cue = { start, end, lines, side: best.side, box: best.box };
      if (best.hit > 0) {
        const first = layout.sides[0]!;
        cue.reason = `no free position; ${best.side === first && tie ? `all equal, ${first} kept` : `${best.side} overlaps least`}`;
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
