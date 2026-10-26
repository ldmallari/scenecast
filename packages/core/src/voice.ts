import fs from 'node:fs';
import path from 'node:path';
import type { VideoSpec, VoiceCfg } from './scene/schema.js';
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

/** Bumped whenever the Python word timing changes, so cached voice timelines are re-made (it is in the cache key). */
export const VOICE_ALIGN_VERSION = 2;

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
  const sentences = narration
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.flatMap((sentence) => splitClauses(sentence).flatMap(splitLong));
}

/**
 * The silence before each phrase of `splitPhrases(narration)`: 0 before the first, `clauseGapSec` after a phrase
 * that ends at ":" or ";", and `phraseGapSec` otherwise.
 */
export function phraseGaps(narration: string, voice: Pick<VoiceCfg, 'phraseGapSec' | 'clauseGapSec'>): number[] {
  const phrases = splitPhrases(narration);
  return phrases.map((_, i) => (i === 0 ? 0 : CLAUSE_END.test(phrases[i - 1]!) ? voice.clauseGapSec : voice.phraseGapSec));
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
    voice: spec.voice,
    models,
    scenes: spec.scenes.map((s) => ({ id: s.id, phrases: splitPhrases(s.narration), gaps: phraseGaps(s.narration, spec.voice) })),
  };
  const inputPath = path.join(voiceDir, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  await runPy('scenecast_py.voice', ['--spec', inputPath, '--out', voiceDir]);
  return JSON.parse(fs.readFileSync(path.join(voiceDir, 'timeline.json'), 'utf8')) as VoiceTimeline;
}
