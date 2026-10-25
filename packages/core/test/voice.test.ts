import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitPhrases, buildVoice } from '../src/voice.js';
import { findUv } from '../src/toolchain.js';
import { VideoSpecSchema } from '../src/scene/schema.js';

function spec(narrations: string[]) {
  return VideoSpecSchema.parse({
    id: 'demo',
    title: 'Demo',
    output: 'out/demo.mp4',
    brand: { primary: '#123456', accent: '#abcdef', font: 'Inter', introTitle: 'Demo' },
    app: { baseUrl: 'http://localhost:3000' },
    scenes: narrations.map((narration, i) => ({ id: `s${i + 1}`, kind: 'app', narration })),
  });
}

describe('splitPhrases', () => {
  it('splitPhrases keeps sentence order and never returns empty strings', () => {
    const text = '  Welcome to the dashboard.  Tick the box!   Ready? ';
    expect(splitPhrases(text)).toEqual(['Welcome to the dashboard.', 'Tick the box!', 'Ready?']);
    expect(splitPhrases('')).toEqual([]);
    expect(splitPhrases('   ')).toEqual([]);
    expect(splitPhrases('One.. Two')).toEqual(['One..', 'Two']);
  });

  it('splits long sentences at commas to about 140 characters', () => {
    const clause = 'open the settings panel and choose a theme';
    const long = Array.from({ length: 6 }, () => clause).join(', ') + '.';
    const phrases = splitPhrases(long);
    expect(phrases.length).toBeGreaterThan(1);
    for (const p of phrases) expect(p.length).toBeLessThanOrEqual(140);
    expect(phrases.join(' ')).toBe(long);
  });
});

describe.skipIf(!findUv())('buildVoice (fake TTS)', () => {
  it('fallback word time is monotonic', async () => {
    const prev = process.env.SCENECAST_FAKE_TTS;
    process.env.SCENECAST_FAKE_TTS = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-voice-'));
    try {
      const tl = await buildVoice(spec(['Welcome to the dashboard. Tick the box, type your name, and press Sign.']), dir);
      const s = tl.scenes.s1!;
      expect(s.phrases).toHaveLength(2);
      expect(s.duration).toBeCloseTo(2.2, 5);
      expect(s.words.map((w) => w.w)).toEqual(
        'Welcome to the dashboard. Tick the box, type your name, and press Sign.'.split(' '),
      );
      for (const w of s.words) expect(w.end).toBeGreaterThan(w.start);
      for (let i = 1; i < s.words.length; i++) expect(s.words[i]!.start).toBeGreaterThanOrEqual(s.words[i - 1]!.end);
      expect(fs.existsSync(path.join(dir, 'voice', 's1.wav'))).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'voice', 'timeline.json'), 'utf8'));
      expect(onDisk).toEqual(tl);
    } finally {
      if (prev === undefined) delete process.env.SCENECAST_FAKE_TTS;
      else process.env.SCENECAST_FAKE_TTS = prev;
    }
  }, 300_000);
});

describe.skipIf(!process.env.SCENECAST_E2E)('buildVoice e2e (real Kokoro + whisper)', () => {
  it('produces word times for a real phrase', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-voice-e2e-'));
    const tl = await buildVoice(spec(['Welcome to the dashboard.']), dir);
    const s = tl.scenes.s1!;
    expect(s.duration).toBeGreaterThan(1);
    expect(s.words.length).toBe(4);
    console.log(JSON.stringify(s, null, 2));
  }, 600_000);
});
