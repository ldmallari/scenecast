import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScene, parseScene, sceneWarnings, DEFAULTS, VideoSpecSchema } from '../src/index.js';

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

  it('title scene needs seconds; page is optional', async () => {
    const err = await loadScene(fx('title-bad.yaml')).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/requires seconds/);
    expect(err).not.toMatch(/page/);
    const noPage = VideoSpecSchema.safeParse({
      id: 'v', title: 'V', output: 'v', brand: { primary: '#000', accent: '#fff', font: 'Inter', introTitle: 'V' },
      app: { baseUrl: 'http://x' }, scenes: [{ id: 't', kind: 'title', narration: 'Hi.', seconds: 2 }],
    });
    expect(noPage.success).toBe(true);
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
      scenes: [{ id: 's1', kind: 'app', narration: 'Hi Mira Solano.' }],
    };
    expect(VideoSpecSchema.parse(base).audit).toBeUndefined();
    expect(VideoSpecSchema.parse({ ...base, audit: { allowList: ['Mira Solano'] } }).audit).toEqual({ allowList: ['Mira Solano'] });
    expect(VideoSpecSchema.parse({ ...base, audit: {} }).audit).toEqual({ allowList: [] });
    expect(() => VideoSpecSchema.parse({ ...base, audit: { allowList: 'Mira' } })).toThrow();
  });
});

describe('scene file strictness', () => {
  const base = () => ({
    id: 't', title: 'T', output: 't',
    brand: { primary: '#000', accent: '#fff', font: 'Inter', introTitle: 'T' },
    app: { baseUrl: 'http://127.0.0.1:9' },
    scenes: [{ id: 's', kind: 'app', narration: 'Open the sign-in page, then the user\'s menu.', steps: [] as object[] }],
  });

  it('rejects unknown keys (typos) instead of ignoring them', () => {
    const typo = base();
    (typo.scenes[0]!.steps as object[]).push({ cue: 'Open', do: 'click', sel: '#a', ofset: 0.2 });
    expect(() => parseScene(typo)).toThrow(/Unrecognized key\(s\) in object: 'ofset'/);
    expect(() => parseScene({ ...base(), audit: { allowlist: ['x'] } })).toThrow(/'allowlist'/);
    expect(() => parseScene({ ...base(), app: { baseUrl: 'http://x', navs: [] } })).toThrow(/'navs'/);
  });

  it('validates cues the way the scheduler finds them (punctuated words do not match inside)', () => {
    const inside = base();
    (inside.scenes[0]!.steps as object[]).push({ cue: 'in', do: 'click', sel: '#a' });
    expect(() => parseScene(inside)).toThrow('cue "in" not in narration');
    const possessive = base();
    (possessive.scenes[0]!.steps as object[]).push({ cue: 'user', do: 'click', sel: '#a' });
    expect(() => parseScene(possessive)).toThrow('cue "user" not in narration');
    const ok = base();
    (ok.scenes[0]!.steps as object[]).push({ cue: 'sign-in', do: 'click', sel: '#a' });
    expect(() => parseScene(ok)).not.toThrow();
  });

  it('a cue with & matches a narration with & (v1.2)', () => {
    const amp = base();
    amp.scenes[0]!.narration = 'Choose "Save & close".';
    (amp.scenes[0]!.steps as object[]).push({ cue: 'Save & close', do: 'click', sel: '#a' });
    expect(() => parseScene(amp)).not.toThrow();
  });

  it('the demo scene file loads under the strict schema', async () => {
    const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/demo-app/video.yaml');
    await expect(loadScene(demo)).resolves.toBeDefined();
  });
});

describe('v1.1 scene fields', () => {
  const base = {
    id: 'demo',
    title: 'Demo',
    output: 'out/demo.mp4',
    brand: { primary: '#2255cc', accent: '#ffaa00', font: 'Inter', introTitle: 'Demo' },
    app: { baseUrl: 'http://localhost:3000' },
  };
  const one = (steps: unknown[], sceneExtra: Record<string, unknown> = {}) => ({
    ...base,
    scenes: [{ id: 's1', kind: 'app', narration: 'Open the menu now.', steps, ...sceneExtra }],
  });
  const withApp = (appExtra: Record<string, unknown>) => ({
    ...one([]),
    app: { ...base.app, ...appExtra },
  });

  it('a v1 scene file loads unchanged and gets the v1.1 defaults', async () => {
    const s = await loadScene(fx('minimal.yaml'));
    expect(s.cards).toEqual({ introSec: 3, outroSec: 3, entrance: 'reveal' });
    expect(s.cursor).toEqual({ start: 'center', park: 'right', parkAfterSec: 2.5 });
    expect(s.phone).toEqual({ align: 'left' });
    expect(s.voice.clauseGapSec).toBe(0.15);
  });
  it('the v1 demo scene file still loads', async () => {
    const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/demo-app/video.yaml');
    await expect(loadScene(demo)).resolves.toBeDefined();
  });
  it('unzoom needs a zoom before it', () => {
    expect(() => parseScene(one([{ cue: 'menu', do: 'unzoom' }]))).toThrow('scene "s1" step 0: unzoom with no zoom before it');
  });
  it('a scene zoom counts as the zoom an unzoom ends', () => {
    expect(() => parseScene(one([{ cue: 'menu', do: 'unzoom' }], { zoom: { sel: '.a' } }))).not.toThrow();
  });
  it('a zoom ended by unzoom takes no ms', () => {
    expect(() => parseScene(one([{ cue: 'open', do: 'zoom', sel: '.a', ms: 900 }, { cue: 'menu', do: 'unzoom' }])))
      .toThrow('scene "s1" step 0: zoom has ms and is ended by the unzoom at step 1; drop one');
  });
  it('a zoom with ms is fine when nothing unzooms it', () => {
    expect(() => parseScene(one([{ cue: 'open', do: 'zoom', sel: '.a', ms: 900 }]))).not.toThrow();
  });
  it('scroll takes one of sel, by, to', () => {
    expect(() => parseScene(one([{ do: 'scroll', by: 400, to: 0 }]))).toThrow('scene "s1" step 0: scroll takes one of sel, by, to');
    expect(() => parseScene(one([{ do: 'scroll', by: 400 }]))).not.toThrow();
  });
  it('step fields are checked against their step kind', () => {
    expect(() => parseScene(one([{ cue: 'open', do: 'zoom', sel: '.a', glideMs: 300 }]))).toThrow('glideMs is for click, type, hover, check, upload and park steps');
    expect(() => parseScene(one([{ cue: 'open', do: 'ring', sel: '.a', ringSel: '.b' }]))).toThrow('ringSel and ringMs are for click, type, hover, check and upload steps');
    expect(() => parseScene(one([{ cue: 'open', do: 'click', sel: '.a', at: 'left' }]))).toThrow('at is for park steps');
  });
  it('a park step on a phone scene is rejected, pointing to wait', () => {
    expect(() => parseScene(one([{ cue: 'open', do: 'park' }], { viewport: 'phone' }))).toThrow(
      'park has no effect on a phone scene (there is no cursor; the touch indicator fades by itself); use wait to hold',
    );
    expect(() => parseScene(one([{ cue: 'open', do: 'wait', ms: 500 }], { viewport: 'phone' }))).not.toThrow();
  });

  it('park and check steps and their fields are accepted; ringSel does not set ring', () => {
    const s = parseScene(one([
      { cue: 'open', do: 'park', at: { x: 10, y: 20 }, glideMs: 300 },
      { cue: 'menu', do: 'check', sel: '#c', ringSel: ['.a', '.b'], ringMs: 800 },
    ]));
    expect(s.scenes[0]!.steps[1]!.ring).toBeUndefined();
  });
  it('a route uses one of json, body, module', () => {
    expect(() => parseScene(withApp({ routes: [{ url: '**/x', json: {}, body: 'y' }] }))).toThrow('app.routes[0]: use one of json, body, module');
    expect(() => parseScene(withApp({ routes: [{ url: '**/x', json: { a: 1 }, status: 201 }] }))).not.toThrow();
  });
  it('initScript resolves a file and keeps inline code', async () => {
    const s = await loadScene(fx('v11-init.yaml'));
    expect(s.app.initScript).toEqual([fx('init.js'), 'window.__inline = 1;']);
    await expect(loadScene(fx('v11-init-missing.yaml'))).rejects.toThrow(`app.initScript: no such file: ${fx('missing.js')}`);
  });
  it('parseScene alone leaves initScript as written', () => {
    expect(parseScene(withApp({ initScript: 'x.js' })).app.initScript).toBe('x.js');
  });
  it('cards.introSec is 0 or at least 1', () => {
    expect(() => parseScene({ ...one([]), cards: { introSec: 0.5 } })).toThrow('cards.introSec: 0 (no card) or at least 1');
    expect(() => parseScene({ ...one([]), cards: { outroSec: 0.5 } })).toThrow('cards.outroSec: 0 (no card) or at least 1');
    expect(parseScene({ ...one([]), cards: { introSec: 0 } }).cards.introSec).toBe(0);
  });
  it('page on an app scene is kept and warned', () => {
    const s = parseScene(one([], { page: 'p.html' }));
    expect(s.scenes[0]!.page).toBe('p.html');
    expect(sceneWarnings(s)).toEqual(['scene "s1": page is used only on title scenes; ignored']);
  });
  it('brand background forms parse', () => {
    for (const background of ['#123456', { from: '#111', to: '#222', angle: 90 }, { image: 'bg.png', dim: 0.5 }])
      expect(() => parseScene({ ...one([]), brand: { ...base.brand, background, cardFont: 'Serif' } })).not.toThrow();
  });
  it('DEFAULTS carries the v1.1 values', () => {
    expect(DEFAULTS.cursor).toMatchObject({ parkDelaySec: 0.6, marginPx: 96, spotY: 0.45 });
    expect(DEFAULTS.phone).toMatchObject({ touchPx: 34, touchLeadSec: 0.25, centreShare: 0.3 });
    expect(DEFAULTS.captions.fullFrameShare).toBe(0.9);
    expect(DEFAULTS.video.takeTailSec).toBe(0.5);
  });
});

describe('upload steps', () => {
  const spec = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
    id: 'v', title: 'V', output: 'v',
    brand: { primary: '#000', accent: '#fff', font: 'Inter', introTitle: 'V' },
    app: { baseUrl: 'http://x', ...extra },
    scenes: [{ id: 's1', kind: 'app', narration: 'Attach the receipt now.', steps }],
  });

  it('needs sel and file; file is only for upload', () => {
    expect(() => parseScene(spec([{ cue: 'Attach', do: 'upload', sel: '.dropzone', file: 'r.pdf' }]))).not.toThrow();
    expect(() => parseScene(spec([{ cue: 'Attach', do: 'upload', sel: '.dropzone', file: ['a.pdf', 'b.png'], glideMs: 300, ringSel: '.list' }]))).not.toThrow();
    expect(() => parseScene(spec([{ cue: 'Attach', do: 'upload', sel: '.dropzone' }]))).toThrow('scene "s1" step 0: upload needs file (the file to choose)');
    expect(() => parseScene(spec([{ cue: 'Attach', do: 'upload', file: 'r.pdf' }]))).toThrow('scene "s1" step 0: upload needs sel');
    expect(() => parseScene(spec([{ cue: 'Attach', do: 'click', sel: '.a', file: 'r.pdf' }]))).toThrow('scene "s1" step 0: file is for upload steps');
  });

  it('resolves files against the scene file and names a missing one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-upload-'));
    try {
      fs.writeFileSync(path.join(dir, 'receipt.pdf'), '%PDF-1.4');
      const write = (file: string) =>
        fs.writeFileSync(path.join(dir, 'video.json'), JSON.stringify(spec([{ cue: 'Attach', do: 'upload', sel: '.d', file }], {
          login: [{ do: 'upload', sel: '#avatar', file: './receipt.pdf' }],
        })));
      write('./receipt.pdf');
      const s = await loadScene(path.join(dir, 'video.json'));
      expect(s.scenes[0]!.steps[0]!.file).toEqual([path.join(dir, 'receipt.pdf')]);
      expect(s.app.login![0]!.file).toEqual([path.join(dir, 'receipt.pdf')]);
      write('./nope.pdf');
      await expect(loadScene(path.join(dir, 'video.json'))).rejects.toThrow(
        `scene "s1" step 0: upload file not found: ${path.join(dir, 'nope.pdf')}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setup steps', () => {
  const spec = (setup: unknown[], extra: Record<string, unknown> = {}) => ({
    id: 'v', title: 'V', output: 'v',
    brand: { primary: '#000', accent: '#fff', font: 'Inter', introTitle: 'V' },
    app: { baseUrl: 'http://x' },
    scenes: [{ id: 's1', kind: 'app', narration: 'Attach the receipt now.', setup, steps: [], ...extra }],
  });

  it('take the step format without cues', () => {
    const s = parseScene(spec([{ do: 'click', sel: '#new' }, { do: 'type', sel: '#t', text: 'x' }, { do: 'press', text: 'Tab' }]));
    expect(s.scenes[0]!.setup).toHaveLength(3);
    expect(() => parseScene(spec([{ cue: 'Attach', do: 'click', sel: '#new' }]))).toThrow(
      'scene "s1" setup step 0: setup steps run before recording starts and take no cue, occ or offset',
    );
  });

  it('reject what only matters on camera', () => {
    for (const d of ['zoom', 'ring', 'unzoom', 'park'])
      expect(() => parseScene(spec([{ do: d, sel: '.a' }]))).toThrow(`scene "s1" setup step 0: ${d} is not filmed in setup; make it a scene step`);
  });

  it('are for app scenes only', () => {
    expect(() => parseScene(spec([{ do: 'click', sel: '#new' }], { kind: 'title', seconds: 2 }))).toThrow(
      'scene "s1": setup is for app scenes',
    );
  });

  it('need sel where the step acts on an element, and reject fields that only matter on camera', () => {
    for (const d of ['click', 'check', 'hover'])
      expect(() => parseScene(spec([{ do: d }]))).toThrow(`scene "s1" setup step 0: ${d} needs sel`);
    expect(() => parseScene(spec([{ do: 'click', sel: '#a', ringSel: '#b' }]))).toThrow(
      'scene "s1" setup step 0: ringSel is not used in setup (nothing is filmed)',
    );
    expect(() => parseScene(spec([{ do: 'click', sel: '#a', glideMs: 300 }]))).toThrow('glideMs is not used in setup');
    expect(() => parseScene(spec([{ do: 'click', sel: '#a', by: 300 }]))).toThrow('scene "s1" setup step 0: by and to are for scroll steps');
    expect(() => parseScene(spec([{ do: 'scroll', sel: '#a', by: 300 }]))).toThrow('scene "s1" setup step 0: scroll takes one of sel, by, to');
    expect(() => parseScene(spec([{ do: 'type', text: 'x' }, { do: 'wait', ms: 200 }, { do: 'scroll', by: 300 }]))).not.toThrow();
  });

  it('check uploads like scene steps', () => {
    expect(() => parseScene(spec([{ do: 'upload', sel: '.d' }]))).toThrow('scene "s1" setup step 0: upload needs file (the file to choose)');
  });
});

describe('app.seedInputs', () => {
  it('resolves against the scene file and names a missing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-seedin-'));
    try {
      fs.writeFileSync(path.join(dir, 'people.json'), '[]');
      const write = (seedInputs: string[]) =>
        fs.writeFileSync(path.join(dir, 'video.json'), JSON.stringify({
          id: 'v', title: 'V', output: 'v', brand: { primary: '#000', accent: '#fff', font: 'Inter', introTitle: 'V' },
          app: { baseUrl: 'http://x', seed: 'make seed', seedInputs }, scenes: [{ id: 's', kind: 'app', narration: 'Hi.' }],
        }));
      write(['./people.json']);
      expect((await loadScene(path.join(dir, 'video.json'))).app.seedInputs).toEqual([path.join(dir, 'people.json')]);
      write(['./nope.json']);
      await expect(loadScene(path.join(dir, 'video.json'))).rejects.toThrow(`app.seedInputs: no such file: ${path.join(dir, 'nope.json')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
