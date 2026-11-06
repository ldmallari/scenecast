import { describe, expect, it } from 'vitest';
import { mapSpans, parseNarration, phonemeProblem, sayMapProblems, stripMarkup } from '../src/speech.js';
import { phraseGaps, sceneSaySpans, splitPhrases, voicePlan } from '../src/voice.js';
import { DEFAULTS, parseScene } from '../src/index.js';

const base = {
  id: 'demo',
  title: 'Demo',
  output: 'demo',
  brand: { primary: '#123456', accent: '#abcdef', font: 'Inter', introTitle: 'Demo' },
  app: { baseUrl: 'http://localhost:3000' },
};
const one = (scene: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseScene({ ...base, ...extra, scenes: [{ id: 's1', kind: 'app', ...scene }] });

describe('parseNarration', () => {
  it('leaves a narration without markup exactly as it was', () => {
    const raw = 'Welcome to Demo Co.\nTo sign in,  type your email.';
    const { speech, errors } = parseNarration(raw);
    expect(errors).toEqual([]);
    expect(speech.text).toBe(raw);
    expect(speech.words).toEqual(raw.trim().split(/\s+/));
    expect(speech.spans).toEqual([]);
    // Asterisks with spaces round them, and brackets that are not markup, are words.
    expect(stripMarkup('5 * 3 is [about] fifteen')).toBe('5 * 3 is [about] fifteen');
  });

  it('strips every kind of markup and keeps it as marks on the clean words', () => {
    const raw = 'Ask [Mira](/mˈɪɹə/) about the *new* list. [pause 0.6] {speed 0.8}Then press [SKU](say: S K U),{/speed} now.';
    const { speech, errors } = parseNarration(raw);
    expect(errors).toEqual([]);
    expect(speech.text).toBe('Ask Mira about the new list. Then press SKU, now.');
    const i = (w: string) => speech.words.indexOf(w);
    expect(speech.stress[i('new')]).toBe(true);
    expect(speech.pause[i('Then')]).toBe(0.6);
    expect(speech.speed[i('Then')]).toBe(0.8);
    expect(speech.speed[i('SKU,')]).toBe(0.8);
    expect(speech.speed[i('now.')]).toBeUndefined();
    expect(speech.spans).toEqual([
      { from: 1, to: 2, ph: 'mˈɪɹə', before: '', after: '' },
      { from: i('SKU,'), to: i('SKU,') + 1, text: 'S K U', before: '', after: ',' },
    ]);
  });

  it('keeps a suffix outside a link with the word', () => {
    const { speech } = parseNarration("Open [Demo Co](say: Demo Koh)'s list.");
    expect(speech.words).toEqual(['Open', 'Demo', "Co's", 'list.']);
    expect(speech.spans).toEqual([{ from: 1, to: 3, text: 'Demo Koh', before: '', after: "'s" }]);
  });

  it('reports bad markup with what to write instead', () => {
    const bad = (raw: string) => parseNarration(raw).errors.join(' | ');
    expect(bad('One [pause] two')).toMatch(/\[pause <seconds>\]/);
    expect(bad('One [pause 9] two')).toMatch(/at most 5/);
    expect(bad('[pause 0.5] One two')).toMatch(/before the first word/);
    expect(bad('One two [pause 0.5]')).toMatch(/after the last word/);
    expect(bad('{speed 3}One{/speed}')).toMatch(/from 0.5 to 2/);
    expect(bad('{speed 0.8}One')).toMatch(/not closed/);
    expect(bad('One{/speed}')).toMatch(/closes no/);
    expect(bad('{speed 0.8}One {speed 0.9}two{/speed}')).toMatch(/already open/);
    expect(bad('Say [it](loudly)')).toMatch(/phonemes\/\) or \[word\]\(say:/);
    expect(bad('Say [it](/xyz§/)')).toMatch(/"§" is not in the misaki phoneme alphabet/);
    expect(bad('Say [it](say: )')).toMatch(/needs the words/);
  });
});

describe('say: maps', () => {
  it('match whole words case-sensitively, longest key first, never over inline markup', () => {
    const words = 'Ask the SKU team, the sku desk and Demo Co. today'.split(' ');
    const spans = mapSpans(words, { SKU: 'S K U', 'Demo Co': 'Demo Koh', Demo: 'Deemo' });
    expect(spans).toEqual([
      { from: 2, to: 3, text: 'S K U', before: '', after: '' },
      { from: 8, to: 10, text: 'Demo Koh', before: '', after: '.' },
    ]);
    expect(mapSpans(words, { SKU: '/tˈibɑɹ/' }, new Set([2]))).toEqual([]);
    expect(mapSpans(['YAML'], { YAML: 'YAML' })).toEqual([{ from: 0, to: 1, word: true, before: '', after: '' }]);
    expect(mapSpans(['Sibal,'], { Sibal: '/sˈibɑl/' })).toEqual([{ from: 0, to: 1, ph: 'sˈibɑl', before: '', after: ',' }]);
  });

  it('a scene map overrides the video map key by key; inline markup wins', () => {
    const spec = one(
      { narration: 'The SKU desk and the [SLA](say: S L A) clock.', say: { SKU: 'tee bee are' } },
      { say: { SKU: 'S K U', SLA: 'sla' } },
    );
    const plan = voicePlan(spec.scenes[0]!, spec.voice, spec.say);
    expect(plan.phrases[0]!.spans.map((s) => s.text)).toEqual(['tee bee are', 'S L A']);
  });

  it('checks keys and values', () => {
    expect(sayMapProblems({ SKU: '' }, 'say')[0]).toMatch(/needs a value/);
    expect(sayMapProblems({ '*x*': 'y' }, 'say')[0]).toMatch(/markup/);
    expect(sayMapProblems({ x: '/sˈi' }, 'say')[0]).toMatch(/between two slashes/);
    expect(sayMapProblems({ x: '/s§/' }, 'say')[0]).toMatch(/misaki phoneme alphabet/);
    expect(phonemeProblem('sˈibɑl')).toBeNull();
  });
});

describe('voicePlan', () => {
  it('matches splitPhrases and phraseGaps for a 1.x narration', () => {
    const t = 'To sign the work agreement: tick the box, type your name, and press Sign. Then wait.';
    const spec = one({ narration: t });
    const plan = voicePlan(spec.scenes[0]!, spec.voice);
    expect(plan.phrases.map((p) => p.text)).toEqual(splitPhrases(t));
    expect(plan.gaps).toEqual(phraseGaps(t, DEFAULTS.voice));
    expect(plan.groups).toEqual([0, 0, 1]); // flow: sentence (the default) joins the first sentence's two phrases
    expect(voicePlan(spec.scenes[0]!, { ...spec.voice, flow: 'phrase' }).groups).toEqual([0, 1, 2]);
    expect(plan.phrases.every((p) => p.speed === DEFAULTS.voice.speed && !p.spans.length && !p.stress.length)).toBe(true);
  });

  it('a pause splits the phrase with its own gap; a speed change splits it with a short join', () => {
    const spec = one({ narration: 'Open the list, [pause 0.6] then pick one. {speed 0.8}Save it{/speed} now.', voice: { speed: 1 } });
    const plan = voicePlan(spec.scenes[0]!, spec.voice);
    expect(plan.phrases.map((p) => [p.text, p.speed])).toEqual([
      ['Open the list,', 1],
      ['then pick one.', 1],
      ['Save it', 0.8],
      ['now.', 1],
    ]);
    expect(plan.gaps).toEqual([0, 0.6, 0.2, 0.05]);
    // The words are still the clean narration's, in order.
    expect(plan.phrases.map((p) => p.text).join(' ')).toBe(spec.scenes[0]!.narration);
  });

  it('a pause on a phrase break replaces its gap', () => {
    const spec = one({ narration: 'One two three. [pause 1.2] Four five.' });
    expect(voicePlan(spec.scenes[0]!, spec.voice).gaps).toEqual([0, 1.2]);
  });

  it('groups phrases by sentence or scene at one speed (voice.flow)', () => {
    const t = 'To sign the work agreement: tick the box. Then wait. {speed 0.8}Slowly{/speed} now.';
    const scene = one({ narration: t }).scenes[0]!;
    const v = { ...DEFAULTS.voice };
    expect(voicePlan(scene, { ...v, flow: 'sentence' }).groups).toEqual([0, 0, 1, 2, 3]);
    expect(voicePlan(scene, { ...v, flow: 'scene' }).groups).toEqual([0, 0, 0, 1, 2]);
    expect(voicePlan(scene, { ...v, flow: 'phrase' }).groups).toEqual([0, 1, 2, 3, 4]);
  });

  it('stress marks and spans are phrase-local; the audit gets them on narration words', () => {
    const spec = one({ narration: 'Open it. Find *your* [Sibal](/sˈibɑl/) now.' });
    const plan = voicePlan(spec.scenes[0]!, spec.voice);
    expect(plan.phrases[1]).toMatchObject({ text: 'Find your Sibal now.', stress: [1], spans: [{ from: 2, to: 3, ph: 'sˈibɑl' }] });
    expect(sceneSaySpans(spec.scenes[0]!, spec.voice)).toEqual([{ from: 4, to: 5, ph: 'sˈibɑl' }]);
  });
});

describe('the scene file', () => {
  it('holds the clean narration, so cues match words that carry markup', () => {
    const spec = one({
      narration: 'Ask [SKU](say: S K U) for *help*. [pause 0.5] Then press Save.',
      steps: [
        { cue: 'SKU', do: 'wait' },
        { cue: 'help', do: 'wait' },
        { cue: 'Save', do: 'wait' },
      ],
    });
    expect(spec.scenes[0]!.narration).toBe('Ask SKU for help. Then press Save.');
    expect(spec.voice).toMatchObject({ acronyms: true, flow: 'sentence', roomTone: true, polish: true });
    expect(spec.audit).toBeUndefined();
  });

  it('a cue on markup that is not a word is not found', () => {
    expect(() => one({ narration: 'Wait [pause 0.5] here.', steps: [{ cue: 'pause', do: 'wait' }] })).toThrow(/cue "pause" not in narration/);
  });

  it('gives clear errors for bad markup, say: entries and voice options', () => {
    expect(() => one({ narration: 'One {speed 0.8}two.' })).toThrow(/scene "s1": narration: a \{speed\} span is not closed/);
    expect(() => one({ narration: 'One two.', say: { two: '/t§/' } })).toThrow(/scene "s1" say: "two": "§" is not in the misaki/);
    expect(() => one({ narration: 'One two.' }, { say: { two: '' } })).toThrow(/say: "two" needs a value/);
    expect(() => one({ narration: 'One two.', voice: { speed: 3 } })).toThrow(/speed is at most 2/);
    expect(() => one({ narration: 'One two.' }, { voice: { flow: 'paragraph' } })).toThrow(/voice.flow is phrase, sentence or scene/);
    expect(() => one({ narration: 'One two.' }, { voice: { roomTone: -20 } })).toThrow(/roomTone is a level from -90 to -40/);
    expect(() => one({ narration: 'One two.' }, { audit: { pronunciation: 'loud' } })).toThrow(/audit.pronunciation is warn, fail or off/);
    expect(() => one({ narration: 'Ask Demo. Co is here.' }, { say: { 'Demo. Co': 'x' } })).toThrow(/runs across a phrase break/);
  });

  it('takes audit.pronunciation and per-scene voice speed', () => {
    const spec = one({ narration: 'One two.', voice: { speed: 1.1 } }, { audit: { pronunciation: 'fail' } });
    expect(spec.audit).toEqual({ allowList: [], pronunciation: 'fail' });
    expect(voicePlan(spec.scenes[0]!, spec.voice).phrases[0]!.speed).toBe(1.1);
  });
});
