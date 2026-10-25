import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScene, DEFAULTS, VideoSpecSchema } from '../src/index.js';

const fx = (n: string) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);

describe('scene loader', () => {
  it('parses minimal valid file', async () => {
    const spec = await loadScene(fx('minimal.yaml'));
    expect(spec.voice.speed).toBe(0.9);
    expect(spec.voice).toEqual(DEFAULTS.voice);
    expect(spec.scenes[0]!.viewport).toBe('desktop');
  });

  it('unknown cue rejected', async () => {
    await expect(loadScene(fx('unknown-cue.yaml'))).rejects.toThrow(
      'scene "s1" step 0: cue "Upload" not in narration',
    );
  });

  it('occ selects nth occurrence', async () => {
    await expect(loadScene(fx('occ-2.yaml'))).resolves.toBeDefined();
    await expect(loadScene(fx('occ-1.yaml'))).rejects.toThrow(
      'scene "s1" step 0: cue "Sign" occurs 1 time(s), occ 2 requested',
    );
  });

  it('cue match is case-insensitive, whole-word and phrase-exact', async () => {
    const { parseScene } = await import('../src/index.js');
    const base = (narration: string, cue: string) => ({
      id: 'v', title: 'v', output: 'o.mp4',
      brand: { primary: '#000', accent: '#fff', font: 'F', introTitle: 'v' },
      app: { baseUrl: 'http://x' },
      scenes: [{ id: 's1', kind: 'app', narration, steps: [{ cue, do: 'click', sel: 'a' }] }],
    });
    expect(() => parseScene(base('Then Tick The Box now.', 'tick the box'))).not.toThrow();
    expect(() => parseScene(base('Signing in.', 'Sign'))).toThrow('cue "Sign" not in narration');
    expect(() => parseScene(base('Tick, then the box.', 'tick the box'))).toThrow('not in narration');
  });

  it('title scene needs page and seconds', async () => {
    await expect(loadScene(fx('title-bad.yaml'))).rejects.toThrow(/page/);
    await expect(loadScene(fx('title-bad.yaml'))).rejects.toThrow(/seconds/);
    const spec = await loadScene(fx('title-ok.yaml'));
    const dir = path.dirname(fx('title-ok.yaml'));
    expect(spec.scenes[0]!.page).toBe(path.join(dir, 'title.html'));
    expect(spec.brand.logo).toBe(path.join(dir, 'logo.svg'));
    expect(spec.app.storageState).toBe(path.join(dir, 'state.json'));
  });

  it('audit.allowList is optional and holds names', () => {
    const base = {
      id: 'v', title: 'v', output: 'o.mp4',
      brand: { primary: '#000', accent: '#fff', font: 'F', introTitle: 'v' },
      app: { baseUrl: 'http://x' },
      scenes: [{ id: 's1', kind: 'app', narration: 'Hi Ana Reyes.' }],
    };
    expect(VideoSpecSchema.parse(base).audit).toBeUndefined();
    expect(VideoSpecSchema.parse({ ...base, audit: { allowList: ['Ana Reyes'] } }).audit).toEqual({ allowList: ['Ana Reyes'] });
    expect(VideoSpecSchema.parse({ ...base, audit: {} }).audit).toEqual({ allowList: [] });
    expect(() => VideoSpecSchema.parse({ ...base, audit: { allowList: 'Ana' } })).toThrow();
  });
});
