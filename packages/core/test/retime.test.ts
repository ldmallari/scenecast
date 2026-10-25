import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
/** Output time at which source time `s` is shown (a play segment containing it; the earlier one wins at joins, so an action is timed on arrival). */
const outTimeOf = (segs: Segment[], s: number) => {
  const g = segs.find((x) => x.hold === undefined && x.srcIn - 1e-6 <= s && s <= x.srcOut + 1e-6)!;
  return g.outStart + s - g.srcIn;
};

describe('retime', () => {
  it('late action trims idle', () => {
    // click recorded 3.0 s after the flash, scheduled to land at 1.0 + travel
    const segs = retime(take([{ index: 0, kind: 'click', at: 3.0 }]), sched([{ index: 0, do: 'click', startAt: 1.0 }]), voice(4), opts);
    expect(segs.some((g) => g.hold)).toBe(false);
    expect(segs.length).toBeGreaterThan(1);
    expect(outTimeOf(segs, FLASH + 3.0)).toBeCloseTo(1.0 + DEFAULT_TRAVEL_SEC, 3);
  });

  it('early action holds frame', () => {
    const segs = retime(take([{ index: 0, kind: 'click', at: 0.8 }]), sched([{ index: 0, do: 'click', startAt: 2.0 }]), voice(4), opts);
    const h = segs.find((g) => g.hold);
    expect(h).toBeDefined();
    expect(h!.srcIn).toBe(h!.srcOut);
    expect(h!.hold).toBeGreaterThan(1);
    expect(h!.srcIn).toBeCloseTo(FLASH + 0.8 - (DEFAULT_TRAVEL_SEC + 0.15), 6);
    expect(outTimeOf(segs, FLASH + 0.8)).toBeCloseTo(2.0 + DEFAULT_TRAVEL_SEC, 3);
  });

  it('scene length = voice + breath, first frame is after the flash', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const segs = retime(take([{ index: 0, kind: 'zoom', at: 1.5 }]), sched([{ index: 0, do: 'zoom', startAt: 1.0 }]), voice(4), opts);
    expect(sceneLen(segs)).toBeCloseTo(4.45, 6);
    expect(Math.min(...segs.map((g) => g.srcIn))).toBeGreaterThanOrEqual(FLASH_END);
    expect(segs[0]!.outStart).toBe(0);
  });

  it('late action keeps 0.8 s after the previous result and the glide before the action', () => {
    const segs = retime(
      take([{ index: 0, kind: 'click', at: 1.0 }, { index: 1, kind: 'click', at: 7.0 }]),
      sched([{ index: 0, do: 'click', startAt: 1.0 }, { index: 1, do: 'click', startAt: 3.0 }]),
      voice(6),
      opts,
    );
    const p = FLASH + 1.0;
    const base = outTimeOf(segs, p);
    for (let t = p; t <= p + 0.8; t += 0.01) expect(outTimeOf(segs, t) - base).toBeCloseTo(t - p, 6);
    const n = FLASH + 7.0;
    for (let t = n - 0.67; t <= n; t += 0.01) expect(outTimeOf(segs, t) - outTimeOf(segs, n)).toBeCloseTo(t - n, 6);
    // the cut comes from the middle of [p + 0.8, n - 0.67]
    const cut = segs.find((g, i) => i > 0 && g.srcIn > segs[i - 1]!.srcOut + 1e-6)!;
    expect(cut.srcIn).toBeGreaterThan(p + 0.8);
  });

  it('holds the last frame when the source runs out', () => {
    const segs = retime(take([{ index: 0, kind: 'zoom', at: 1.0 }]), sched([{ index: 0, do: 'zoom', startAt: 1.0 }]), voice(6), { ...opts, srcDuration: 4 });
    const last = segs[segs.length - 1]!;
    expect(last.hold).toBeGreaterThan(0);
    expect(last.srcIn).toBe(4);
    expect(sceneLen(segs)).toBeCloseTo(6.45, 6);
  });

  it('every event lands within 1/30 s for random late/early patterns', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
        const got = outTimeOf(segs, FLASH + e.at);
        expect(Math.abs(got - want)).toBeLessThanOrEqual(FRAME);
      });
      // the 0.67 s before every action plays 1:1 (as far back as the previous event)
      events.forEach((e, i) => {
        const sT = FLASH + e.at;
        const prev = i ? FLASH + events[i - 1]!.at : FLASH_END;
        const tOut = (j: number) => items[j]!.startAt + (events[j]!.kind === 'click' ? DEFAULT_TRAVEL_SEC : 0);
        if (tOut(i) - (i ? tOut(i - 1) : 0) < 0.67) return; // too little output time between events to keep it
        const base = outTimeOf(segs, sT);
        for (let t = Math.max(sT - 0.67, prev) + 0.005; t < sT; t += 0.01)
          expect(Math.abs(outTimeOf(segs, t) - (base - (sT - t)))).toBeLessThan(1e-6);
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
