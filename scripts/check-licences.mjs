#!/usr/bin/env node
// Licence check: every production dependency must carry an allowed licence and be listed in THIRD_PARTY.md.
//
//   node scripts/check-licences.mjs
//
// npm packages come from `pnpm licenses list --prod --json`. Python packages come from `uv pip list` of the py/
// environment (set up by `scenecast doctor`), narrowed to the production dependencies in py/uv.lock
// (`uv export --no-dev`), with each licence read from the package's installed metadata.
//
// A package whose metadata states no usable licence, or a licence that is only acceptable after a human read it,
// needs an entry in scripts/licence-overrides.json (the licence, a source URL and the reason). Nothing passes
// silently: a package with no licence and no override FAILs.
//
// Exit code: 0 PASS, 1 a package FAILs, 2 the check could not run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Licences any dependency may carry (SPDX ids; LGPL in any version). */
export const ALLOWED = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'Python-2.0', '0BSD', 'CC0-1.0'];
const LGPL = /^LGPL(-[23]\.[01])?(-only|-or-later|\+)?$/;

/** Permissive licences accepted only for a package with a reviewed override (never on metadata alone). */
export const REVIEWED_ONLY = ['MIT-0', 'MIT-CMU', 'Zlib', 'PSF-2.0', 'CNRI-Python'];

/** Free-text licence names (whole string, lower case) and the SPDX expression they stand for. */
const ALIASES = new Map(
  Object.entries({
    'mit license': 'MIT',
    'the mit license': 'MIT',
    'the mit license (mit)': 'MIT',
    'apache 2.0': 'Apache-2.0',
    'apache-2': 'Apache-2.0',
    'apache license 2.0': 'Apache-2.0',
    'apache license, version 2.0': 'Apache-2.0',
    'apache software license': 'Apache-2.0',
    'apache software license 2.0': 'Apache-2.0',
    'bsd 3-clause license': 'BSD-3-Clause',
    '3-clause bsd license': 'BSD-3-Clause',
    'new bsd license': 'BSD-3-Clause',
    'bsd 2-clause license': 'BSD-2-Clause',
    'simplified bsd license': 'BSD-2-Clause',
    'isc license': 'ISC',
    'isc license (iscl)': 'ISC',
    'mozilla public license 2.0 (mpl 2.0)': 'MPL-2.0',
    'gnu library or lesser general public license (lgpl)': 'LGPL',
    'gnu lesser general public license v2 or later (lgplv2+)': 'LGPL-2.0-or-later',
    'gnu lesser general public license v3 (lgplv3)': 'LGPL-3.0-only',
    'python software foundation license': 'PSF-2.0',
    psfl: 'PSF-2.0',
    // Ambiguous: which BSD? Kept as "BSD" so it fails until an override names the variant.
    bsd: 'BSD',
    'bsd license': 'BSD',
  }),
);

/** Licence classifiers ("License :: OSI Approved :: MIT License") keep only their last part. */
const classifierName = (c) => c.split('::').pop().trim();

/**
 * A raw licence string as an SPDX-style expression, or undefined when it names no licence (empty, UNKNOWN,
 * a URL or pasted licence text).
 */
export function normaliseLicence(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || /^(unknown|none|n\/a)$/i.test(s) || /^https?:\/\//i.test(s) || s.length >= 200) return undefined;
  return ALIASES.get(s.toLowerCase()) ?? s;
}

/** Parses an SPDX expression (AND, OR, WITH, parentheses) into a tree; throws when it is not one. */
export function parseExpression(expr) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const op = (name) => typeof peek() === 'string' && peek().toUpperCase() === name;
  const factor = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`incomplete licence expression "${expr}"`);
    if (t === '(') {
      const inner = or();
      if (tokens[i++] !== ')') throw new Error(`unbalanced parentheses in "${expr}"`);
      return inner;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(t) || ['AND', 'OR', 'WITH'].includes(t.toUpperCase()))
      throw new Error(`"${expr}" is not a licence expression`);
    if (op('WITH')) i += 2; // an exception only ever widens what the licence permits
    return { id: t };
  };
  const and = () => {
    const parts = [factor()];
    while (op('AND')) (i++, parts.push(factor()));
    return parts.length === 1 ? parts[0] : { and: parts };
  };
  const or = () => {
    const parts = [and()];
    while (op('OR')) (i++, parts.push(and()));
    return parts.length === 1 ? parts[0] : { or: parts };
  };
  const tree = or();
  if (i !== tokens.length) throw new Error(`"${expr}" is not a licence expression`);
  return tree;
}

/** Whether a single licence id is allowed (`extra` adds ids, for packages with a reviewed override). */
export function isAllowedId(id, extra = []) {
  return ALLOWED.includes(id) || LGPL.test(id) || extra.includes(id);
}

/**
 * Evaluates an expression: an OR passes when any branch passes, an AND when every part does.
 * Returns the ids that make it fail (empty when it passes).
 */
export function evaluate(expr, extra = []) {
  let tree;
  try {
    tree = parseExpression(expr);
  } catch {
    return { ok: false, offending: [expr] };
  }
  const walk = (n) => {
    if (n.id) return isAllowedId(n.id, extra) ? [] : [n.id];
    if (n.and) return [...new Set(n.and.flatMap(walk))];
    const branches = n.or.map(walk);
    return branches.some((b) => b.length === 0) ? [] : [...new Set(branches.flat())];
  };
  const offending = walk(tree);
  return { ok: offending.length === 0, offending };
}

/** PEP 503 name: lower case, runs of `-`, `_` and `.` become one `-`. */
export const pyName = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');

/** Names listed in THIRD_PARTY.md: the code span in the first cell of each table row (`*` matches any text). */
export function parseThirdParty(markdown) {
  const names = [];
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*`([^`]+)`/.exec(line);
    if (m) names.push(m[1].trim());
  }
  return names;
}

const globRe = (pattern, norm) =>
  new RegExp(`^${pattern.split('*').map((p) => norm(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

function listed(pkg, names) {
  const norm = pkg.ecosystem === 'python' ? pyName : (s) => s;
  const name = norm(pkg.name);
  return names.some((n) => (n.includes('*') ? globRe(n, norm).test(name) : norm(n) === name));
}

function findOverride(pkg, overrides) {
  const table = overrides?.[pkg.ecosystem] ?? {};
  const norm = pkg.ecosystem === 'python' ? pyName : (s) => s;
  const key = Object.keys(table).find((k) => norm(k) === norm(pkg.name));
  return key === undefined ? undefined : table[key];
}

/**
 * The licence verdict for each package. A package is
 * `{ ecosystem: 'npm' | 'python', name, version, licence?: string, candidates?: string[] }`: `licence` is the
 * declared licence; `candidates` (Python) are the metadata fields in order of trust, the first usable one wins.
 */
export function checkPackages(packages, { thirdParty, overrides }) {
  const names = parseThirdParty(thirdParty);
  const rows = [];
  for (const pkg of packages) {
    const problems = [];
    const override = findOverride(pkg, overrides);
    const declared = [pkg.licence, ...(pkg.candidates ?? [])].map(normaliseLicence).find((l) => l !== undefined);
    let licence = declared;
    let how = 'metadata';
    if (override) {
      if (!override.licence || !override.source || !override.reason)
        problems.push('its override needs licence, source and reason');
      licence = override.licence;
      how = override.tool ? 'override (tool binary, never linked)' : 'override';
      if (!override.tool) {
        const r = evaluate(override.licence ?? '', REVIEWED_ONLY);
        if (!r.ok) problems.push(`licence ${override.licence} is not allowed (${r.offending.join(', ')})`);
      }
    } else if (licence === undefined) {
      problems.push(`no licence in its metadata (raw: ${JSON.stringify(pkg.licence ?? pkg.candidates ?? null)}); add a reviewed override`);
    } else {
      const r = evaluate(licence);
      if (!r.ok) problems.push(`licence ${licence} is not on the allow-list (${r.offending.join(', ')})`);
    }
    if (!listed(pkg, names)) problems.push('missing from THIRD_PARTY.md');
    rows.push({ ...pkg, licence, how, ok: problems.length === 0, problems });
  }
  return rows;
}

// ---------------------------------------------------------------- reading the real tree

function npmPackages() {
  const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
  const byLicence = JSON.parse(out);
  const pkgs = [];
  for (const [licence, list] of Object.entries(byLicence))
    for (const p of list) for (const version of p.versions) pkgs.push({ ecosystem: 'npm', name: p.name, version, licence });
  return pkgs;
}

const PY_META = `
import json, sys
from importlib import metadata
out = {}
for d in metadata.distributions():
    md = d.metadata
    lic = md.get("License") or ""
    cls = [c for c in md.get_all("Classifier", []) if c.startswith("License ::")]
    out[md["Name"]] = {"expression": md.get("License-Expression"), "license": lic, "classifiers": cls}
json.dump(out, sys.stdout)
`;

async function pythonPackages() {
  const { findUv, uvEnv } = await import(pathToFileURL(path.join(REPO, 'packages/core/src/toolchain.ts')).href);
  const uv = findUv();
  if (!uv) throw new Error('uv was not found: run `scenecast doctor` first (it sets up uv and the Python environment)');
  const env = uvEnv();
  const project = path.join(REPO, 'py');
  const run = (args) => execFileSync(uv, args, { cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const python = run(['run', '--no-sync', '--project', project, 'python', '-c', 'import sys; print(sys.executable)']).trim();
  const installed = JSON.parse(run(['pip', 'list', '--python', python, '--format', 'json']));
  const meta = JSON.parse(run(['run', '--no-sync', '--project', project, 'python', '-c', PY_META]));
  // Production dependencies only (not the dev group): every name in the locked, dev-free requirement set.
  const exported = run(['export', '--project', project, '--no-dev', '--frozen', '--format', 'requirements-txt', '--no-hashes']);
  const prod = new Set(['scenecast-py']);
  for (const line of exported.split('\n')) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==|@)/.exec(line.trim());
    if (m) prod.add(pyName(m[1]));
  }
  const metaByName = new Map(Object.entries(meta).map(([k, v]) => [pyName(k), v]));
  const pkgs = [];
  for (const { name, version } of installed) {
    if (!prod.has(pyName(name))) continue;
    const m = metaByName.get(pyName(name)) ?? {};
    const classifiers = (m.classifiers ?? []).map(classifierName);
    const fromClassifiers = classifiers.length ? classifiers.map((c) => normaliseLicence(c) ?? c).join(' AND ') : undefined;
    pkgs.push({
      ecosystem: 'python',
      name,
      version,
      licence: m.expression ?? undefined,
      candidates: [m.license, fromClassifiers].filter(Boolean),
    });
  }
  return pkgs;
}

async function main() {
  const thirdParty = fs.readFileSync(path.join(REPO, 'THIRD_PARTY.md'), 'utf8');
  const overrides = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/licence-overrides.json'), 'utf8'));
  const packages = [...npmPackages(), ...(await pythonPackages())];
  const rows = checkPackages(packages, { thirdParty, overrides });
  const failed = rows.filter((r) => !r.ok);
  const count = (eco) => rows.filter((r) => r.ecosystem === eco).length;
  for (const r of rows.filter((r) => r.ok && r.how !== 'metadata'))
    console.log(`  reviewed  ${r.ecosystem} ${r.name}@${r.version}: ${r.licence} (${r.how})`);
  for (const r of failed) console.log(`  FAIL      ${r.ecosystem} ${r.name}@${r.version}: ${r.problems.join('; ')}`);
  console.log(
    `check-licences: ${failed.length ? 'FAIL' : 'PASS'} (${count('npm')} npm and ${count('python')} Python production packages, ${failed.length} failing)`,
  );
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`check-licences: could not run: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
    },
  );
}
