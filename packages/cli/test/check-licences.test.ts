// scripts/check-licences.mjs: the allow-list, SPDX expressions, overrides and the THIRD_PARTY.md listing.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findUv } from '@scenecast/core';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts/check-licences.mjs');

interface Pkg {
  ecosystem: 'npm' | 'python';
  name: string;
  version: string;
  licence?: string;
  candidates?: string[];
}
interface Row extends Pkg {
  ok: boolean;
  problems: string[];
  how: string;
}
interface Override {
  licence: string;
  declared?: string;
  source: string;
  reason: string;
  tool?: boolean;
}
type Overrides = Partial<Record<'npm' | 'python', Record<string, Override>>>;
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  checkPackages: (pkgs: Pkg[], ctx: { thirdParty: string; overrides: Overrides }) => Row[];
  evaluate: (expr: string, extra?: string[]) => { ok: boolean; offending: string[] };
  normaliseLicence: (raw: unknown) => string | undefined;
};

// Fixture: a THIRD_PARTY.md that lists every fixture package, so only the licence decides.
const THIRD_PARTY = [
  '| Package | Licence | Source |',
  '|---|---|---|',
  '| `fake-remotion-player` | Remotion | https://example.invalid |',
  '| `dual-licensed` | MIT OR Apache-2.0 | https://example.invalid |',
  '| `gpl-or-mit` | GPL-3.0-only OR MIT | https://example.invalid |',
  '| `mit-and-gpl` | MIT AND GPL-3.0-only | https://example.invalid |',
  '| `no-licence-py` | MIT | https://example.invalid |',
  '| `zlib-thing` | Zlib | https://example.invalid |',
  '| `some-ffmpeg-binary` | GPL-2.0-or-later | https://example.invalid |',
  '| `@scope/native-*` | MIT | https://example.invalid |',
  '| `Some_Py.Package` | MIT | https://example.invalid |',
].join('\n');

const npm = (name: string, licence?: string): Pkg => ({ ecosystem: 'npm', name, version: '1.0.0', ...(licence ? { licence } : {}) });
const check = (pkgs: Pkg[], overrides: Overrides = {}) => mod.checkPackages(pkgs, { thirdParty: THIRD_PARTY, overrides });

describe('check-licences', () => {
  it('fails a package licensed "Remotion"', () => {
    const [row] = check([npm('fake-remotion-player', 'Remotion')]);
    expect(row!.ok).toBe(false);
    expect(row!.problems.join()).toContain('not on the allow-list (Remotion)');
  });

  it('passes an OR expression with an allowed branch, and fails an AND with a disallowed part', () => {
    const rows = check([npm('dual-licensed', '(MIT OR Apache-2.0)'), npm('gpl-or-mit', 'GPL-3.0-only OR MIT'), npm('mit-and-gpl', 'MIT AND GPL-3.0-only')]);
    expect(rows.map((r) => r.ok)).toEqual([true, true, false]);
    expect(rows[2]!.problems.join()).toContain('GPL-3.0-only');
  });

  it('allows every listed licence family, LGPL in any version, and nothing else', () => {
    for (const ok of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'Python-2.0', '0BSD', 'CC0-1.0', 'LGPL-2.1', 'LGPL-3.0-or-later', 'LGPL-2.1+', 'LGPL'])
      expect(mod.evaluate(ok).ok, ok).toBe(true);
    for (const bad of ['GPL-2.0-only', 'AGPL-3.0', 'BUSL-1.1', 'SSPL-1.0', 'Remotion', 'BSD', 'Zlib', 'UNLICENSED'])
      expect(mod.evaluate(bad).ok, bad).toBe(false);
    expect(mod.evaluate('(MIT AND (Zlib OR BSD-3-Clause))').ok).toBe(true);
    expect(mod.evaluate('Apache-2.0 WITH LLVM-exception').ok).toBe(true);
    expect(mod.evaluate('not a licence (at all').ok).toBe(false);
  });

  it('maps common free-text names and ignores URLs, UNKNOWN and pasted licence text', () => {
    expect(mod.normaliseLicence('MIT License')).toBe('MIT');
    expect(mod.normaliseLicence('Apache Software License')).toBe('Apache-2.0');
    expect(mod.normaliseLicence('3-Clause BSD License')).toBe('BSD-3-Clause');
    expect(mod.normaliseLicence('BSD')).toBe('BSD'); // ambiguous: fails until an override names the variant
    for (const none of ['', 'UNKNOWN', 'https://example.invalid/LICENSE', 'x'.repeat(300), undefined]) expect(mod.normaliseLicence(none)).toBeUndefined();
  });

  it('never passes a package with no licence metadata unless a reviewed override names one', () => {
    const pkg: Pkg = { ecosystem: 'python', name: 'no-licence-py', version: '1', candidates: ['UNKNOWN'] };
    const [bare] = check([pkg]);
    expect(bare!.ok).toBe(false);
    expect(bare!.problems.join()).toContain('no licence in its metadata');

    const [reviewed] = check([pkg], { python: { 'no_licence.py': { licence: 'MIT', declared: 'UNKNOWN', source: 'https://example.invalid/LICENSE', reason: 'LICENSE file is MIT' } } });
    expect(reviewed!.ok).toBe(true);
    expect(reviewed!.how).toBe('override');

    const [incomplete] = check([pkg], { python: { 'no-licence-py': { licence: 'MIT', declared: 'UNKNOWN', source: '', reason: '' } } });
    expect(incomplete!.ok).toBe(false);
  });

  it('accepts a reviewed-only permissive licence through an override, never on metadata alone', () => {
    const pkg = npm('zlib-thing', 'Zlib');
    expect(check([pkg])[0]!.ok).toBe(false);
    expect(check([pkg], { npm: { 'zlib-thing': { licence: 'Zlib', declared: 'Zlib', source: 'https://example.invalid', reason: 'reviewed' } } })[0]!.ok).toBe(true);
    // An override cannot launder a disallowed licence.
    expect(check([npm('mit-and-gpl', 'GPL-3.0-only')], { npm: { 'mit-and-gpl': { licence: 'GPL-3.0-only', declared: 'GPL-3.0-only', source: 'https://example.invalid', reason: 'x' } } })[0]!.ok).toBe(false);
  });

  it('fails a reviewed override once the package metadata changes (a relicense), or when it records none', () => {
    const ov = (declared?: string) => ({ npm: { 'zlib-thing': { licence: 'Zlib', ...(declared === undefined ? {} : { declared }), source: 'https://example.invalid', reason: 'reviewed' } } });
    expect(check([npm('zlib-thing', 'Zlib')], ov('Zlib'))[0]!.ok).toBe(true);
    const [changed] = check([npm('zlib-thing', 'BUSL-1.1')], ov('Zlib'));
    expect(changed!.ok).toBe(false);
    expect(changed!.problems.join()).toContain('metadata changed since the override was reviewed (was "Zlib", now "BUSL-1.1")');
    expect(check([npm('zlib-thing', 'Zlib')], ov())[0]!.ok).toBe(false);
  });

  it('lets a separately executed tool binary through only by an explicit tool override', () => {
    const pkg = npm('some-ffmpeg-binary', 'https://example.invalid/LICENSE.md');
    expect(check([pkg])[0]!.ok).toBe(false);
    const tool = { licence: 'GPL-2.0-or-later', declared: 'https://example.invalid/LICENSE.md', source: 'https://example.invalid', reason: 'executed as a separate program', tool: true };
    expect(check([pkg], { npm: { 'some-ffmpeg-binary': tool } })[0]!.ok).toBe(true);
  });

  it('fails a package missing from THIRD_PARTY.md, matching wildcards and Python name spellings', () => {
    const rows = check([
      npm('not-listed', 'MIT'),
      npm('@scope/native-linux-x64', 'MIT'),
      { ecosystem: 'python', name: 'some-py-package', version: '1', licence: 'MIT' },
    ]);
    expect(rows.map((r) => r.ok)).toEqual([false, true, true]);
    expect(rows[0]!.problems).toEqual(['missing from THIRD_PARTY.md']);
  });

  it.skipIf(!findUv())('passes on the real dependency tree', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
    expect(out).toContain('check-licences: PASS');
  }, 120_000);
});
