import fs from 'node:fs';
import path from 'node:path';
import type { VideoSpec } from './scene/schema.js';
import { ensureToolchain, runPy } from './toolchain.js';

export interface VoiceTimeline {
  scenes: Record<
    string,
    {
      /** Seconds; the scene's voice clip length. */
      duration: number;
      phrases: { text: string; start: number; end: number }[];
      words: { w: string; start: number; end: number }[];
    }
  >;
}

export type SceneVoice = VoiceTimeline['scenes'][string];

const MAX_PHRASE = 140;

/** Sentences in order, with sentences longer than ~140 characters split at commas. Never returns empty strings. */
export function splitPhrases(narration: string): string[] {
  const sentences = narration
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const phrases: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_PHRASE) {
      phrases.push(sentence);
      continue;
    }
    let cur = '';
    for (const clause of sentence.split(/(?<=,)\s+/)) {
      const next = cur ? `${cur} ${clause}` : clause;
      if (cur && next.length > MAX_PHRASE) {
        phrases.push(cur);
        cur = clause;
      } else cur = next;
    }
    if (cur) phrases.push(cur);
  }
  return phrases;
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
    scenes: spec.scenes.map((s) => ({ id: s.id, phrases: splitPhrases(s.narration) })),
  };
  const inputPath = path.join(voiceDir, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  await runPy('scenecast_py.voice', ['--spec', inputPath, '--out', voiceDir]);
  return JSON.parse(fs.readFileSync(path.join(voiceDir, 'timeline.json'), 'utf8')) as VoiceTimeline;
}
