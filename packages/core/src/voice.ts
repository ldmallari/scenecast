import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, type Scene, type VideoSpec, type VoiceCfg } from './scene/schema.js';
import { mapSpans, parseNarration, SPEED_JOIN_SEC, type SaySpan, type SayMap, type Speech, type VoicePhrase, type VoicePlan } from './speech.js';
import { ensureToolchain, runPy } from './toolchain.js';

export interface VoiceTimeline {
  scenes: Record<
    string,
    {
      /** Seconds; the scene's voice clip length. */
      duration: number;
      /** `onset`: seconds from the phrase start to its first word's sound, measured on the clean clip (absent when
       * the phrase's alignment fell back). */
      phrases: { text: string; start: number; end: number; onset?: number }[];
      /** `from`: where the time came from (forced alignment, the speech onset, the free transcript, or the
       * character position); absent in timelines made before v1.1. */
      words: { w: string; start: number; end: number; from?: WordSource }[];
    }
  >;
}

export type SceneVoice = VoiceTimeline['scenes'][string];
export type WordSource = 'forced' | 'onset' | 'free' | 'position';

/**
 * Bumped whenever the Python word timing changes, so cached voice timelines are re-made (it is in the cache key).
 * 3: two spoken words on one start are split by a frame instead of the phrase falling back to the free transcript.
 * 4: phrases go to the voice with their pronunciation spans, speed and stress (1.3); all-caps words are spelled out
 *    by an explicit rule; the aligner times what is said and maps it back onto the script's words.
 */
export const VOICE_ALIGN_VERSION = 4;

const MAX_PHRASE = 140;
/** A clause split needs at least this many words on each side, so a list like "speed; care" stays one phrase. */
const MIN_CLAUSE_WORDS = 3;
/** A word that ends a clause: ":" or ";", optionally followed by closing quotes or brackets ("settings:"). */
const CLAUSE_END = /[:;]["'”’)\]]*$/u;

/**
 * Splits a sentence after ":" or ";" when both sides have at least three words. Colons inside a word ("9:30") are
 * not clause ends: only a word that ends with one counts.
 */
function splitClauses(sentence: string): string[] {
  const words = sentence.split(/\s+/);
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < words.length - 1; i++) {
    if (!CLAUSE_END.test(words[i]!)) continue;
    if (i + 1 - from >= MIN_CLAUSE_WORDS && words.length - (i + 1) >= MIN_CLAUSE_WORDS) {
      out.push(words.slice(from, i + 1).join(' '));
      from = i + 1;
    }
  }
  out.push(words.slice(from).join(' '));
  return out;
}

/** Splits a clause longer than ~140 characters at commas (as v1 split long sentences). */
function splitLong(clause: string): string[] {
  if (clause.length <= MAX_PHRASE) return [clause];
  const out: string[] = [];
  let cur = '';
  for (const part of clause.split(/(?<=,)\s+/)) {
    const next = cur ? `${cur} ${part}` : part;
    if (cur && next.length > MAX_PHRASE) {
      out.push(cur);
      cur = part;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The phrases the voice speaks one at a time: sentences in order, each split after ":" or ";" when both sides
 * have at least three words, and parts longer than ~140 characters split at commas. Never returns empty strings,
 * and joining the phrases with spaces gives back the narration's words exactly, so word indices (the narration
 * split on whitespace) are the same either way.
 *
 * This differs on purpose from caption breaks (captions.ts), which may break at any of `, : ; — .`, never after a
 * possessive, and treat abbreviations ("e.g.", "Co.") as mid-clause. A voice phrase is a spoken unit with a pause
 * after it, so it only splits where a speaker would pause: sentence ends, clause colons and semicolons, and commas
 * in long sentences. Captions may break a phrase further, but never join two phrases into one cue line.
 */
export function splitPhrases(narration: string): string[] {
  return sentencePhrases(narration).flat();
}

/** splitPhrases, kept by sentence. */
function sentencePhrases(narration: string): string[][] {
  const sentences = narration
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.map((sentence) => splitClauses(sentence).flatMap(splitLong));
}

/**
 * The silence before each phrase of `splitPhrases(narration)`: 0 before the first, `clauseGapSec` after a phrase
 * that ends at ":" or ";", and `phraseGapSec` otherwise.
 */
export function phraseGaps(narration: string, voice: Pick<VoiceCfg, 'phraseGapSec' | 'clauseGapSec'>): number[] {
  const phrases = splitPhrases(narration);
  return phrases.map((_, i) => (i === 0 ? 0 : CLAUSE_END.test(phrases[i - 1]!) ? voice.clauseGapSec : voice.phraseGapSec));
}

/** The scene's parsed narration (load keeps it on the scene; a scene built in code is parsed here). */
export function sceneSpeech(scene: Pick<Scene, 'narration'> & { speech?: Speech }): Speech {
  return scene.speech ?? parseNarration(scene.narration).speech;
}

/**
 * What the voice says for one scene: the phrases of `splitPhrases` (on the clean narration), split again where a
 * `[pause]` stands or the speed changes, each with its speed, stress and pronunciation spans (inline markup first,
 * then the scene's `say:` over the video's, key by key); the gap before each phrase (a pause sets its own gap, a
 * speed change inside a sentence `SPEED_JOIN_SEC`); and which phrases are voiced together (`voice.flow`).
 *
 * Throws when a pronunciation span would run across two phrases (it is said as one piece).
 */
export function voicePlan(
  scene: Pick<Scene, 'narration' | 'id'> & { speech?: Speech; say?: SayMap; voice?: { speed?: number } },
  voice: Pick<VoiceCfg, 'phraseGapSec' | 'clauseGapSec' | 'speed'> & { flow?: VoiceCfg['flow'] },
  videoSay: SayMap = {},
): VoicePlan {
  const speech = sceneSpeech(scene);
  const base = scene.voice?.speed ?? voice.speed;
  const speedOf = (i: number) => speech.speed[i] ?? base;
  // Phrases as word ranges, with their sentence and the gap before them.
  const ranges: { from: number; to: number; sentence: number; gap: number }[] = [];
  let at = 0;
  sentencePhrases(speech.text).forEach((phrases, sentence) =>
    phrases.forEach((p) => {
      const n = p.split(/\s+/).length;
      const prev = ranges[ranges.length - 1];
      const baseGap = !prev ? 0 : CLAUSE_END.test(speech.words[prev.to - 1]!) ? voice.clauseGapSec : voice.phraseGapSec;
      let from = at;
      for (let i = at + 1; i < at + n; i++) {
        if (speech.pause[i] === undefined && speedOf(i) === speedOf(i - 1)) continue;
        ranges.push({ from, to: i, sentence, gap: from === at ? (ranges.length ? speech.pause[from] ?? baseGap : 0) : speech.pause[from] ?? SPEED_JOIN_SEC });
        from = i;
      }
      ranges.push({ from, to: at + n, sentence, gap: from === at ? (ranges.length ? speech.pause[from] ?? baseGap : 0) : speech.pause[from] ?? SPEED_JOIN_SEC });
      at += n;
    }),
  );
  const inline = speech.spans;
  const taken = new Set(inline.flatMap((s) => [...Array(s.to - s.from).keys()].map((k) => s.from + k)));
  const spans = [...inline, ...mapSpans(speech.words, { ...videoSay, ...(scene.say ?? {}) }, taken)];
  const phrases: VoicePhrase[] = ranges.map((r) => ({
    text: speech.words.slice(r.from, r.to).join(' '),
    speed: speedOf(r.from),
    spans: [] as SaySpan[],
    stress: [] as number[],
  }));
  const phraseOf = (i: number) => ranges.findIndex((r) => r.from <= i && i < r.to);
  for (const s of spans) {
    const k = phraseOf(s.from);
    if (phraseOf(s.to - 1) !== k)
      throw new Error(
        `scene "${scene.id}": "${speech.words.slice(s.from, s.to).join(' ')}" has a pronunciation but runs across a phrase break ` +
          '(a sentence end, a clause break or a pause); give each part its own',
      );
    phrases[k]!.spans.push({ ...s, from: s.from - ranges[k]!.from, to: s.to - ranges[k]!.from });
  }
  for (const p of phrases) p.spans.sort((a, b) => a.from - b.from);
  speech.stress.forEach((on, i) => {
    if (on) phrases[phraseOf(i)]!.stress.push(i - ranges[phraseOf(i)]!.from);
  });
  // Groups: each phrase alone, or the phrases of one sentence (or of the scene) that share a speed.
  const flow = voice.flow ?? DEFAULTS.voice.flow;
  const groups: number[] = [];
  ranges.forEach((r, k) => {
    const prev = ranges[k - 1];
    const join = prev !== undefined && flow !== 'phrase' && phrases[k - 1]!.speed === phrases[k]!.speed &&
      (flow === 'scene' || prev.sentence === r.sentence);
    groups.push(k === 0 ? 0 : join ? groups[k - 1]! : groups[k - 1]! + 1);
  });
  return { phrases, gaps: ranges.map((r) => r.gap), groups };
}

/** The scene's pronunciation spans on narration word indices (for the audit's pronunciation check). */
export function sceneSaySpans(
  scene: Parameters<typeof voicePlan>[0],
  voice: Parameters<typeof voicePlan>[1],
  videoSay: SayMap = {},
): { from: number; to: number; text?: string; ph?: string }[] {
  let plan: VoicePlan;
  try {
    plan = voicePlan(scene, voice, videoSay);
  } catch {
    return [];
  }
  const out: { from: number; to: number; text?: string; ph?: string }[] = [];
  let at = 0;
  for (const p of plan.phrases) {
    for (const s of p.spans)
      out.push({ from: s.from + at, to: s.to + at, ...(s.text !== undefined ? { text: s.text } : {}), ...(s.ph !== undefined ? { ph: s.ph } : {}) });
    at += p.text.split(/\s+/).length;
  }
  return out;
}

/** The voice options the Python voice stage reads (not the mix's room tone). */
export function voiceStageOptions(voice: VoiceCfg): Record<string, unknown> {
  const { roomTone: _roomTone, ...rest } = voice;
  return rest;
}

/**
 * Synthesises every scene's narration phrase by phrase. `workDir` is the video's work
 * directory (work/<id>); writes `voice/<scene>.wav` and `voice/timeline.json` inside it.
 */
export async function buildVoice(spec: VideoSpec, workDir: string): Promise<VoiceTimeline> {
  const voiceDir = path.join(workDir, 'voice');
  fs.mkdirSync(voiceDir, { recursive: true });
  const fake = process.env.SCENECAST_FAKE_TTS === '1';
  const models = fake ? null : (await ensureToolchain()).models;
  const input = {
    voice: voiceStageOptions(spec.voice),
    models,
    scenes: spec.scenes.map((s) => ({ id: s.id, ...voicePlan(s, spec.voice, spec.say) })),
  };
  const inputPath = path.join(voiceDir, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  await runPy('scenecast_py.voice', ['--spec', inputPath, '--out', voiceDir]);
  return JSON.parse(fs.readFileSync(path.join(voiceDir, 'timeline.json'), 'utf8')) as VoiceTimeline;
}
