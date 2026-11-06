// Narration markup and pronunciation (`say:`): what the voice is told to say, kept apart from the script's words.
//
// The narration a scene file holds may carry delivery and pronunciation markup:
//   [pause 0.6]                 silence before the next word, in seconds
//   {speed 0.85}…{/speed}        the voice speed for the words in between
//   *word*                       a stressed word (misaki's stress mark)
//   [word](/phonemes/)           how to say the word, in misaki phonemes
//   [word](say: other words)     what to say in place of the word
// parseNarration removes the markup (the clean narration is what captions, cues, the scheduler and the audit read)
// and keeps it as per-word marks; voicePhrases turns the marks and the `say:` maps into what the voice stage speaks.

/** Misaki's phoneme alphabet as Kokoro takes it (scenecast_py/kokoro.py VOCAB), plus the space. */
const PHONEME_CHARS = new Set(
  ';:,.!?—…"()“” ̃ʣʥʦʨᵝꭧAIOQSTWYᵊabcdefhijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ',
);

/** A pronunciation span over clean words [from, to): one of `text` (said instead), `ph` (phonemes) or `word` (say the
 * word as a word: no automatic acronym). `before`/`after`: what the first/last word has outside the span (punctuation,
 * or a suffix like "'s"); the voice keeps them around the replacement. */
export interface SaySpan {
  from: number;
  to: number;
  text?: string;
  ph?: string;
  word?: true;
  before: string;
  after: string;
}

/** The narration parsed: the clean text and its words, with a mark per word. */
export interface Speech {
  /** The narration without markup (the narration itself, byte for byte, when it has none). */
  text: string;
  words: string[];
  /** Seconds of silence before word i (`[pause s]`). */
  pause: (number | undefined)[];
  /** The speed of word i from a `{speed}` span. */
  speed: (number | undefined)[];
  stress: boolean[];
  /** Inline pronunciations (`[word](/ph/)`, `[word](say: text)`). */
  spans: SaySpan[];
}

/** `say:` values: replacement words, or phonemes in slashes. */
export type SayMap = Record<string, string>;

export const PAUSE_MAX_SEC = 5;
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
/** The gap where a speed change splits a sentence (Kokoro takes one speed per call). */
export const SPEED_JOIN_SEC = 0.05;

const TOKEN =
  /\[pause\b([^\]]*)\]|\{speed\b([^}]*)\}|\{\/speed\}|\[([^\]\n]+)\]\(([^)\n]*)\)|\*(?=[^\s*])([^*\n]*?[^\s*])\*/g;

/** Leading and trailing characters that are not letters or digits. */
const EDGE = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u;

export function splitEdges(word: string): { lead: string; core: string; trail: string } {
  const m = EDGE.exec(word)!;
  return { lead: m[1]!, core: m[2]!, trail: m[3]! };
}

/** Problems with a phoneme string (`/…/` stripped): empty, or symbols misaki's alphabet does not have. */
export function phonemeProblem(ph: string): string | null {
  if (!ph.trim()) return 'the phonemes are empty';
  const bad = [...new Set([...ph].filter((c) => !PHONEME_CHARS.has(c)))];
  return bad.length ? `"${bad.join('')}" ${bad.length > 1 ? 'are' : 'is'} not in the misaki phoneme alphabet` : null;
}

/** A `say:` value or inline target as a span body: phonemes, replacement words, or the word itself. */
function sayBody(value: string, key: string): { ph: string } | { text: string } | { word: true } {
  const v = value.trim();
  if (v.length > 2 && v.startsWith('/') && v.endsWith('/')) return { ph: v.slice(1, -1) };
  if (v === key.trim()) return { word: true };
  return { text: v };
}

function parseSeconds(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*s?\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * Parses the narration's markup. Returns the speech and a list of problems (empty when it is valid). A narration
 * without markup comes back as its own text, so 1.x files read exactly as before.
 */
export function parseNarration(raw: string): { speech: Speech; errors: string[] } {
  const errors: string[] = [];
  let clean = '';
  // Per clean character: its speed, whether it is stressed, and its inline span (index into `bodies`).
  const cSpeed: (number | undefined)[] = [];
  const cStress: boolean[] = [];
  const cSpan: (number | undefined)[] = [];
  const pauses: { at: number; sec: number }[] = [];
  const bodies: ({ ph: string } | { text: string } | { word: true })[] = [];
  let speed: number | undefined;
  let any = false;
  const put = (s: string, stress = false, span?: number) => {
    for (const ch of s) {
      clean += ch;
      for (let k = 0; k < ch.length; k++) {
        cSpeed.push(speed);
        cStress.push(stress);
        cSpan.push(span);
      }
    }
  };
  let last = 0;
  for (const m of raw.matchAll(TOKEN)) {
    put(raw.slice(last, m.index));
    last = m.index! + m[0].length;
    any = true;
    const [, pause, speedArg, linkText, linkTarget, stressed] = m;
    if (pause !== undefined) {
      const sec = parseSeconds(pause);
      if (sec === null || !(sec > 0) || sec > PAUSE_MAX_SEC)
        errors.push(`"${m[0]}": a pause is [pause <seconds>], more than 0 and at most ${PAUSE_MAX_SEC}`);
      else pauses.push({ at: clean.length, sec });
      put(' ');
    } else if (speedArg !== undefined) {
      const v = parseSeconds(speedArg.replace(/s\s*$/, ''));
      if (speed !== undefined) errors.push(`"${m[0]}": a {speed} span is already open; close it with {/speed} first`);
      else if (v === null || v < SPEED_MIN || v > SPEED_MAX)
        errors.push(`"${m[0]}": speed is a number from ${SPEED_MIN} to ${SPEED_MAX}, as in {speed 0.85}`);
      else speed = v;
    } else if (m[0] === '{/speed}') {
      if (speed === undefined) errors.push('"{/speed}" closes no {speed} span');
      speed = undefined;
    } else if (linkText !== undefined) {
      const target = linkTarget!.trim();
      let body: (typeof bodies)[number] | null = null;
      if (target.length > 2 && target.startsWith('/') && target.endsWith('/')) {
        const problem = phonemeProblem(target.slice(1, -1));
        if (problem) errors.push(`"${m[0]}": ${problem}`);
        else body = { ph: target.slice(1, -1) };
      } else if (/^say\s*:/.test(target)) {
        const text = target.replace(/^say\s*:/, '').trim();
        if (!text) errors.push(`"${m[0]}": say: needs the words to say`);
        else body = { text };
      } else errors.push(`"${m[0]}": use [word](/phonemes/) or [word](say: other words)`);
      if (!/[\p{L}\p{N}]/u.test(linkText)) errors.push(`"${m[0]}": the bracketed text needs a word`);
      if (body) {
        bodies.push(body);
        put(linkText, false, bodies.length - 1);
      } else put(linkText);
    } else if (stressed !== undefined) {
      put(stressed, true);
    }
  }
  put(raw.slice(last));
  if (speed !== undefined) errors.push('a {speed} span is not closed with {/speed}');

  if (!any) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    const none = words.map(() => undefined);
    return { speech: { text: raw, words, pause: none, speed: [...none], stress: words.map(() => false), spans: [] }, errors };
  }

  const words: string[] = [];
  const starts: number[] = [];
  for (const w of clean.matchAll(/\S+/g)) {
    words.push(w[0]);
    starts.push(w.index!);
  }
  const pause: (number | undefined)[] = words.map(() => undefined);
  for (const p of pauses) {
    const i = starts.findIndex((s) => s >= p.at);
    if (i <= 0) errors.push(`[pause ${p.sec}] ${i === 0 ? 'comes before the first word' : 'comes after the last word'}; a pause goes between words`);
    else pause[i] = (pause[i] ?? 0) + p.sec;
  }
  const speedOf: (number | undefined)[] = [];
  const stress: boolean[] = [];
  const spans: SaySpan[] = [];
  words.forEach((w, i) => {
    const s = starts[i]!;
    const chars = [...Array(w.length).keys()].map((k) => s + k);
    const letter = chars.find((c) => /[\p{L}\p{N}]/u.test(clean[c]!)) ?? s;
    speedOf.push(cSpeed[letter]);
    stress.push(chars.some((c) => cStress[c]));
  });
  // Inline spans: the words their characters fall in.
  bodies.forEach((body, k) => {
    const idx = words.map((_, i) => i).filter((i) => [...Array(words[i]!.length).keys()].some((c) => cSpan[starts[i]! + c] === k));
    if (!idx.length) return;
    const from = idx[0]!;
    const to = idx[idx.length - 1]! + 1;
    const first = [...Array(words[from]!.length).keys()].findIndex((c) => cSpan[starts[from]! + c] === k);
    const lastW = words[to - 1]!;
    let lastC = lastW.length - 1;
    while (lastC >= 0 && cSpan[starts[to - 1]! + lastC] !== k) lastC--;
    spans.push({ from, to, ...body, before: words[from]!.slice(0, first), after: lastW.slice(lastC + 1) });
  });
  return { speech: { text: words.join(' '), words, pause, speed: speedOf, stress, spans }, errors };
}

/** The narration without markup (what captions show and cues match). */
export function stripMarkup(raw: string): string {
  return parseNarration(raw).speech.text;
}

/** Problems with a `say:` map's keys and values (`where` names the map, e.g. "say" or `scene "x" say`). */
export function sayMapProblems(map: SayMap, where: string): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (!/[\p{L}\p{N}]/u.test(key)) out.push(`${where}: key "${key}" needs a word`);
    if (/[[\]{}*]/.test(key)) out.push(`${where}: key "${key}" may not hold markup ([ ] { } *)`);
    const v = value.trim();
    if (!v) out.push(`${where}: "${key}" needs a value: words to say, or phonemes in slashes ("/sˈibɑl/")`);
    else if (v.startsWith('/') && v.endsWith('/') && v.length > 2) {
      const problem = phonemeProblem(v.slice(1, -1));
      if (problem) out.push(`${where}: "${key}": ${problem}`);
    } else if (v.startsWith('/') || (v.endsWith('/') && v.length > 1)) out.push(`${where}: "${key}": phonemes go between two slashes, as in "/sˈibɑl/"`);
  }
  return out;
}

/**
 * The spans a `say:` map gives the words: each key (one word or several) matches the words whose cores (edge
 * punctuation left out) equal its words, case-sensitively; longer keys first, never overlapping each other or
 * `taken` words (inline markup wins).
 */
export function mapSpans(words: string[], map: SayMap, taken: ReadonlySet<number> = new Set()): SaySpan[] {
  const cores = words.map((w) => splitEdges(w).core);
  const keys = Object.keys(map)
    .map((k) => ({ k, parts: k.trim().split(/\s+/).map((p) => splitEdges(p).core) }))
    .filter((e) => e.parts.every((p) => p !== ''))
    .sort((a, b) => b.parts.length - a.parts.length || b.k.length - a.k.length);
  const used = new Set(taken);
  const out: SaySpan[] = [];
  for (const { k, parts } of keys) {
    for (let i = 0; i + parts.length <= words.length; i++) {
      const range = parts.map((_, j) => i + j);
      if (range.some((r) => used.has(r)) || !parts.every((p, j) => cores[i + j] === p)) continue;
      range.forEach((r) => used.add(r));
      const first = splitEdges(words[i]!);
      const last = splitEdges(words[i + parts.length - 1]!);
      out.push({ from: i, to: i + parts.length, ...sayBody(map[k]!, k), before: first.lead, after: last.trail });
      i += parts.length - 1;
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** One phrase as the voice stage takes it. Word indices are within the phrase. */
export interface VoicePhrase {
  text: string;
  speed: number;
  /** Pronunciation spans (inline markup and the `say:` maps). */
  spans: SaySpan[];
  /** Stressed words. */
  stress: number[];
}

export interface VoicePlan {
  phrases: VoicePhrase[];
  /** The silence before each phrase (0 before the first). */
  gaps: number[];
  /** Phrases with the same group number are voiced in one call (`voice.flow`); a sentence's phrases share one by default. */
  groups: number[];
}
