import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFlash } from '../src/ffmpeg.js';
import { DEFAULT_TRAVEL_SEC, type Take, type TakeEvent } from '../src/record/record.js';
import { retime, type Segment } from '../src/retime.js';
import type { ScheduledStep } from '../src/schedule.js';
import { ensureToolchain } from '../src/toolchain.js';
import type { SceneVoice } from '../src/voice.js';

const FRAME = 1 / 30;
const FLASH = 1.0;
const FLASH_END = 1.1;
const voice = (duration: number): SceneVoice => ({ duration, phrases: [], words: [] });
const take = (events: Pick<TakeEvent, 'index' | 'kind' | 'at'>[]): Take => ({
  file: 'take.webm',
  flashAt: FLASH,
  events: events.map((e) => ({ ...e, panels: [], loading: false })),
});
const sched = (items: { index: number; do: 'click' | 'zoom'; startAt: number }[]): ScheduledStep[] =>
  items.map((i) => ({ index: i.index, step: { do: i.do } as never, cueTime: null, startAt: i.startAt }));
const opts = { flashTime: FLASH, flashEnd: FLASH_END };

const sceneLen = (segs: Segment[]) => {
  const l = segs[segs.length - 1]!;
  return l.outStart + (l.hold ?? l.srcOut - l.srcIn);
};
/** Output time at which source time `s` is shown (start of the segment that begins at it). */
const outTimeOf = (segs: Segment[], s: number) => {
  const start = segs.find((g) => g.hold === undefined && Math.abs(g.srcIn - s) < 1e-6);
  if (start) return start.outStart;
  const end = segs.find((g) => g.hold === undefined && Math.abs(g.srcOut - s) < 1e-6);
  if (end) return end.outStart + end.srcOut - end.srcIn;
  // early action followed by trimmed idle: the hold of the frame just before the action ends at the action
  const h = segs.find((g) => g.hold !== undefined && g.srcIn <= s && s - g.srcIn <= 0.04 + 1e-6)!;
  return h.outStart + h.hold!;
};

describe('retime', () => {
  it('late action trims idle', () => {
    // click recorded 3.0 s after the flash, scheduled to land at 1.0 + travel
    const segs = retime(take([{ index: 0, kind: 'click', at: 3.0 }]), sched([{ index: 0, do: 'click', startAt: 1.0 }]), voice(4), opts);
    expect(segs.some((g) => g.hold)).toBe(false);
    expect(segs[0]!.srcIn).toBeGreaterThan(FLASH_END + 0.5);
    expect(outTimeOf(segs, FLASH + 3.0)).toBeCloseTo(1.0 + DEFAULT_TRAVEL_SEC, 3);
  });

  it('early action holds frame', () => {
    const segs = retime(take([{ index: 0, kind: 'click', at: 0.8 }]), sched([{ index: 0, do: 'click', startAt: 2.0 }]), voice(4), opts);
    const h = segs.find((g) => g.hold);
    expect(h).toBeDefined();
    expect(h!.srcIn).toBe(h!.srcOut);
    expect(h!.hold).toBeGreaterThan(1);
    expect(outTimeOf(segs, FLASH + 0.8)).toBeCloseTo(2.0 + DEFAULT_TRAVEL_SEC, 3);
  });

  it('scene length = voice + breath, first frame is after the flash', () => {
    const segs = retime(take([{ index: 0, kind: 'zoom', at: 1.5 }]), sched([{ index: 0, do: 'zoom', startAt: 1.0 }]), voice(4), opts);
    expect(sceneLen(segs)).toBeCloseTo(4.45, 6);
    expect(Math.min(...segs.map((g) => g.srcIn))).toBeGreaterThanOrEqual(FLASH_END);
    expect(segs[0]!.outStart).toBe(0);
  });

  it('holds the last frame when the source runs out', () => {
    const segs = retime(take([{ index: 0, kind: 'zoom', at: 1.0 }]), sched([{ index: 0, do: 'zoom', startAt: 1.0 }]), voice(6), { ...opts, srcDuration: 4 });
    const last = segs[segs.length - 1]!;
    expect(last.hold).toBeGreaterThan(0);
    expect(last.srcIn).toBe(4);
    expect(sceneLen(segs)).toBeCloseTo(6.45, 6);
  });

  it('every event lands within 1/30 s for random late/early patterns', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rnd() * 6);
      const events: Pick<TakeEvent, 'index' | 'kind' | 'at'>[] = [];
      const items: { index: number; do: 'click' | 'zoom'; startAt: number }[] = [];
      let at = 0.2 + rnd() * 0.5;
      let startAt = rnd() * 2;
      for (let i = 0; i < n; i++) {
        const pointer = rnd() < 0.5;
        events.push({ index: i, kind: pointer ? 'click' : 'zoom', at });
        items.push({ index: i, do: pointer ? 'click' : 'zoom', startAt });
        at += 0.3 + rnd() * 4; // real gaps
        startAt += 0.6 + rnd() * 4; // scheduled gaps (late or early vs real)
      }
      const dur = startAt + 1;
      const segs = retime(take(events), sched(items), voice(dur), opts);
      expect(sceneLen(segs)).toBeCloseTo(dur + 0.45, 6);
      events.forEach((e, i) => {
        const want = items[i]!.startAt + (e.kind === 'click' ? DEFAULT_TRAVEL_SEC : 0);
        expect(Math.abs(outTimeOf(segs, FLASH + e.at) - want)).toBeLessThanOrEqual(FRAME);
      });
      // 1:1 speed, contiguous
      let t = 0;
      for (const g of segs) {
        expect(g.outStart).toBeCloseTo(t, 6);
        t += g.hold ?? g.srcOut - g.srcIn;
      }
    }
  });
});

describe('detectFlash', () => {
  it('finds the marker', async () => {
    const { ffmpeg } = await ensureToolchain();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-flash-'));
    const file = path.join(dir, 'clip.mp4');
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=3',
      '-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=160x90:r=25:d=0.2',
      '-filter_complex', '[1:v]setpts=PTS+1.0/TB[m];[0:v][m]overlay=eof_action=pass:enable=between(t\\,1.0\\,1.2)',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '3', file,
    ]);
    expect(Math.abs((await detectFlash(file)) - 1.0)).toBeLessThanOrEqual(FRAME);
    const none = path.join(dir, 'none.mp4');
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=1', '-pix_fmt', 'yuv420p', none]);
    await expect(detectFlash(none)).rejects.toThrow(`no flash marker found in ${none}`);
  });
});
