import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitPhrases, phraseGaps, buildVoice, VOICE_ALIGN_VERSION } from '../src/voice.js';
import { findUv } from '../src/toolchain.js';
import { DEFAULTS, VideoSpecSchema } from '../src/scene/schema.js';

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

  it('splits at : and ; when both sides have three words, with clause gaps', () => {
    const t = 'Two things matter here: speed and care; then you ship it. Done now.';
    expect(splitPhrases(t)).toEqual(['Two things matter here:', 'speed and care;', 'then you ship it.', 'Done now.']);
    expect(phraseGaps(t, DEFAULTS.voice)).toEqual([0, 0.15, 0.15, 0.2]);
    expect(splitPhrases('Pick one: yes.')).toEqual(['Pick one: yes.']);
  });

  it('keeps short lists, clock times and colons inside words in one phrase', () => {
    expect(splitPhrases('Check two things: speed; care.')).toEqual(['Check two things: speed; care.']);
    expect(splitPhrases('The meeting starts at 9:30 and ends at 10:15 today.')).toEqual([
      'The meeting starts at 9:30 and ends at 10:15 today.',
    ]);
    // Exactly three words on each side splits; a closing quote after the colon still counts.
    expect(splitPhrases('Open the "Team settings:" pick a role now.')).toEqual(['Open the "Team settings:"', 'pick a role now.']);
  });

  it('phraseGaps follows the voice settings and matches splitPhrases one to one', () => {
    const t = 'To sign the work agreement: tick the box, type your name, and press Sign. Then wait.';
    const voice = { ...DEFAULTS.voice, phraseGapSec: 0.3, clauseGapSec: 0 };
    expect(splitPhrases(t)).toEqual(['To sign the work agreement:', 'tick the box, type your name, and press Sign.', 'Then wait.']);
    expect(phraseGaps(t, voice)).toEqual([0, 0, 0.3]);
    expect(phraseGaps('', voice)).toEqual([]);
    // The words are kept exactly, in order, so word indices still count the narration split on whitespace.
    expect(splitPhrases(t).join(' ').split(/\s+/)).toEqual(t.split(/\s+/));
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
      const input = JSON.parse(fs.readFileSync(path.join(dir, 'voice', 'input.json'), 'utf8'));
      expect(input.scenes[0]).toEqual({
        id: 's1',
        phrases: ['Welcome to the dashboard.', 'Tick the box, type your name, and press Sign.'],
        gaps: [0, 0.2],
      });
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

describe('the voice stage version', () => {
  it('is 3: two words on one start are split by a frame (align.separate_ties), so voices cached by 1.1 are re-made', () => {
    expect(VOICE_ALIGN_VERSION).toBe(3);
  });
});
