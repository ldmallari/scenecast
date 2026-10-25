// Parent side of the Revideo worker: spawns render-worker.ts, watches its progress and makes sure
// the worker and its browser never outlive a stalled render or this process.
// Node APIs only and erasable types, so plain `node` can import it (the orphan test does).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RevideoJob } from './render-worker.ts';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(SRC_DIR, 'render-worker.ts');
/** A render that reports no progress for this long is stopped. */
export const STALL_SEC = 90;
/** After SIGTERM, how long the worker gets to close its browser before SIGKILL. */
const KILL_GRACE_MS = 5000;
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs one Revideo render in a child process (render-worker.ts) and resolves with the file it
 * wrote. The worker is detached (its own process group) and is stopped:
 * - on a stall (no progress for `stallSec`): SIGTERM to the group, SIGKILL after a grace period;
 * - when this process gets SIGINT/SIGTERM/SIGHUP: the group gets SIGTERM, then the signal is
 *   re-raised here with the default handling;
 * - when this process dies any other way (even SIGKILL): the worker sees EOF on the stdin pipe
 *   held open here and exits.
 * On SIGTERM or exit the worker's puppeteer exit hook kills the browser's process group, and the
 * Vite server ends with the worker.
 */
export function runRevideo(job: RevideoJob, jobFile: string, opts: { stallSec?: number; onLog?: (line: string) => void } = {}): Promise<string> {
  const stallSec = opts.stallSec ?? STALL_SEC;
  fs.writeFileSync(jobFile, JSON.stringify(job));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', WORKER_FILE, jobFile], {
      cwd: path.dirname(SRC_DIR),
      detached: true, // own process group, so the whole tree can be signalled
      stdio: ['pipe', 'pipe', 'pipe'], // stdin stays open: EOF tells the worker we are gone
    });
    const tail: string[] = [];
    const keep = (line: string) => {
      opts.onLog?.(line);
      tail.push(line);
      if (tail.length > 30) tail.shift();
    };
    let done: string | undefined;
    let error: string | undefined;
    let stalled = false;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;
    const signal = (sig: NodeJS.Signals) => {
      if (closed) return; // the group id may already be reused
      try {
        process.kill(-child.pid!, sig);
      } catch {
        /* already gone */
      }
    };
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        signal('SIGTERM');
        killer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
      }, stallSec * 1000);
    };
    kick();

    const onSignal = (sig: NodeJS.Signals) => {
      signal('SIGTERM');
      removeHandlers();
      process.kill(process.pid, sig); // no listener left: default action
    };
    const onExit = () => signal('SIGTERM');
    const removeHandlers = () => {
      for (const s of FORWARDED) process.off(s, onSignal);
      process.off('exit', onExit);
    };
    for (const s of FORWARDED) process.on(s, onSignal);
    process.on('exit', onExit);

    const handleLine = (line: string) => {
      const m = /^@@scenecast (progress|done|error) (.*)$/.exec(line);
      if (!m) keep(line);
      else if (m[1] === 'progress') kick();
      else if (m[1] === 'done') done = m[2];
      else error = m[2];
    };
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(keep));
    child.stdin.on('error', () => {}); // EPIPE if the worker is already gone
    child.on('error', (e) => {
      removeHandlers();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (stalled) signal('SIGKILL'); // anything left in the group, before marking it closed
      closed = true;
      removeHandlers();
      child.stdin.destroy();
      if (buf) handleLine(buf); // a last line without a newline
      buf = '';
      const context = tail.length ? `\n${tail.join('\n')}` : '';
      if (stalled) reject(new Error(`Revideo render made no progress for ${stallSec} s and was stopped${context}`));
      else if (code === 0 && done) resolve(done);
      else reject(new Error(`Revideo render failed (exit ${code}): ${error ?? 'no result'}${context}`));
    });
  });
}
