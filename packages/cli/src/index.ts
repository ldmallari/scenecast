// scenecast command line: doctor, login, render, preview.
//
// One command per process: Revideo (render and preview) keeps process-wide state, so a process
// never renders or previews twice. Run the CLI again for the next video.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { applyAppContext, captureSessionStorage, ensureToolchain, findUv, loadScene, type Toolchain } from '@scenecast/core';
import { preview } from '@scenecast/compose';
import { prepare, render } from './render.js';

export { render, prepare, runSeed, type RenderOptions, type RenderResult } from './render.js';
export { StageCache, hashFile } from './cache.js';

const USAGE = `Usage:
  scenecast doctor                      check the toolchain (uv, Python, ffmpeg, Chromium, models)
  scenecast login <video.yaml>          sign in by hand and save app.storageState
  scenecast render <video.yaml> [--only <sceneId>] [--no-audit] [--keep-work] [--fresh]
                                [--out <dir>] [--work <dir>]
  scenecast preview <video.yaml>        open the composed video in the Revideo player

render writes <out>/<output>.mp4, .srt, chapters.txt and audit/; its exit code is the audit verdict.
Stages whose inputs did not change are reused from <work>/<id>/; --fresh redoes them all (for
example after the app itself changed).`;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const firstLine = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0]!.trim();

function fileCheck(name: string, file: string | undefined): Check {
  return file && fs.existsSync(file) ? { name, ok: true, detail: file } : { name, ok: false, detail: file ? `not found: ${file}` : 'not set up' };
}

/** Sets up the toolchain if needed and reports each part. Exit code 1 when anything is missing. */
export async function doctor(): Promise<number> {
  let tc: Toolchain | undefined;
  let setupError = '';
  try {
    tc = await ensureToolchain();
  } catch (e) {
    setupError = (e as Error).message;
  }
  const checks: Check[] = [];
  const tool = (name: string, bin: string | undefined, args: string[]): Check => {
    if (!bin) return { name, ok: false, detail: 'not set up' };
    try {
      return { name, ok: true, detail: `${bin} (${firstLine(bin, args)})` };
    } catch {
      return { name, ok: false, detail: `${bin} does not run` };
    }
  };
  checks.push(tool('uv', findUv(), ['--version']));
  checks.push(tool('python env', tc?.python, ['--version']));
  checks.push(tool('ffmpeg', tc?.ffmpeg, ['-hide_banner', '-version']));
  checks.push(fileCheck('chromium', chromium.executablePath()));
  checks.push(fileCheck('kokoro model', tc?.models.kokoro));
  checks.push(fileCheck('kokoro voices', tc?.models.voices));
  checks.push(fileCheck('whisper model', tc?.models.whisper));
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) console.log(`${c.name.padEnd(width)}  ${c.ok ? 'OK     ' : 'MISSING'}  ${c.detail}`);
  if (setupError) console.log(`\ntoolchain setup failed: ${setupError}`);
  if (!checks.find((c) => c.name === 'chromium')!.ok) console.log('\nInstall Chromium (in the scenecast checkout) with: pnpm -C packages/cli exec playwright install chromium');
  return checks.every((c) => c.ok) ? 0 : 1;
}

/** Opens a headed browser on the app; once you have signed in, Enter saves the session to app.storageState. */
export async function login(file: string): Promise<number> {
  const spec = await loadScene(file);
  const target = spec.app.storageState;
  if (!target) throw new Error(`${file}: set app.storageState to the file the session should be saved to`);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: null });
    await applyAppContext(context, spec.app);
    const page = await context.newPage();
    await page.goto(spec.app.baseUrl);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const closed = new Promise<'closed'>((r) => browser.on('disconnected', () => r('closed')));
    const answer = await Promise.race([rl.question('Sign in in the browser window, then press Enter here to save the session. '), closed]);
    rl.close();
    if (answer === 'closed') throw new Error('the browser was closed before the session was saved');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await context.storageState({ path: target });
    // An app that keeps its session in sessionStorage: save that too, from the tab the sign-in ended in.
    const last = page.isClosed() ? context.pages().at(-1) : page;
    if (last) await captureSessionStorage(last, target, spec.app.baseUrl);
    console.log(`scenecast: saved the session to ${target}`);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      'no-audit': { type: 'boolean' },
      'keep-work': { type: 'boolean' },
      fresh: { type: 'boolean' },
      out: { type: 'string' },
      work: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, file] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }
  const needFile = () => {
    if (!file) throw new Error(`${command} needs a scene file (video.yaml)`);
    return file;
  };
  switch (command) {
    case 'doctor':
      return doctor();
    case 'login':
      return login(needFile());
    case 'render': {
      const result = await render(needFile(), {
        only: values.only,
        audit: !values['no-audit'],
        keepWork: values['keep-work'],
        fresh: values.fresh,
        outDir: values.out,
        workRoot: values.work,
      });
      return result.exitCode;
    }
    case 'preview': {
      const { video } = await prepare(needFile(), { only: values.only, fresh: values.fresh, workRoot: values.work });
      const p = await preview(video.plan);
      console.log(`scenecast: preview at ${p.url} (no audio); press Ctrl-C to stop`);
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      await p.close();
      return 0;
    }
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}
