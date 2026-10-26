import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blankRanges, detectFlash, lastFrameTime, scanBlank } from '../src/ffmpeg.js';
import { DEFAULT_TRAVEL_SEC, type Take, type TakeEvent } from '../src/record/record.js';
import { outputTimeOf, retime, type Segment } from '../src/retime.js';
import { travelSecFor, type ScheduledStep } from '../src/schedule.js';
import { ensureToolchain } from '../src/toolchain.js';
import type { SceneVoice } from '../src/voice.js';

const FRAME = 1 / 30;
const FLASH = 1.0;
const FLASH_END = 1.1;
const voice = (duration: number): SceneVoice => ({ duration, phrases: [], words: [] });
const take = (events: (Pick<TakeEvent, 'index' | 'kind' | 'at'> & { busyUntil?: number })[]): Take => ({
  file: 'take.webm',
  flashAt: FLASH,
  events: events.map((e) => ({ ...e, panels: [], loading: false })),
});
const sched = (items: { index: number; do: 'click' | 'zoom' | 'type' | 'ring' | 'wait'; startAt: number; travel?: number }[]): ScheduledStep[] =>
  items.map((i) => ({ index: i.index, step: { do: i.do } as never, cueTime: null, startAt: i.startAt, travel: i.travel ?? travelSecFor({ do: i.do }) }));
const opts = { sceneId: 's', flashTime: FLASH, flashEnd: FLASH_END };
afterEach(() => vi.restoreAllMocks());

const sceneLen = (segs: Segment[]) => {
  const l = segs[segs.length - 1]!;
  return l.outStart + (l.hold ?? l.srcOut - l.srcIn);
};
/** Output time at which source time `s` is shown (a play segment containing it; the earlier one wins at joins, so an action is timed on arrival). */
const outTimeOf = (segs: Segment[], s: number) => {
  const g = segs.find((x) => x.hold === undefined && x.srcOut >= s - FRAME - 1e-9)!;
  return g.outStart + Math.min(Math.max(s - g.srcIn, 0), g.srcOut - g.srcIn);
};

/** Like outTimeOf, but for a frame in the middle of a stretch: the last segment containing it wins (after any hold). */
const outTimeInside = (segs: Segment[], s: number) => {
  const g = [...segs].reverse().find((x) => x.hold === undefined && x.srcIn - 0.5 / 30 <= s && s <= x.srcOut + 0.5 / 30)!;
  return g.outStart + s - g.srcIn;
};

describe('retime', () => {
  it('late action trims idle', () => {
    // click recorded 3.0 s after the flash, scheduled to land at 1.0 + travel
    const segs = retime(take([{ index: 0, kind: 'click', at: 3.0 }]), sched([{ index: 0, do: 'click', startAt: 1.0 }]), voice(4), opts);
    expect(segs.some((g) => g.hold)).toBe(false);
    expect(segs.length).toBeGreaterThan(1);
    expect(outTimeOf(segs, FLASH + 3.0)).toBeCloseTo(1.0 + DEFAULT_TRAVEL_SEC, 1);
  });

  it('early action holds frame', () => {
    const segs = retime(take([{ index: 0, kind: 'click', at: 0.8 }]), sched([{ index: 0, do: 'click', startAt: 2.0 }]), voice(4), opts);
    const h = segs.find((g) => g.hold);
    expect(h).toBeDefined();
    expect(h!.srcIn).toBe(h!.srcOut);
    expect(h!.hold).toBeGreaterThan(1);
    expect(h!.srcIn).toBeCloseTo(FLASH + 0.8 - (DEFAULT_TRAVEL_SEC + 0.15), 6);
    expect(h!.hold! * 30).toBeCloseTo(Math.round(h!.hold! * 30), 9);
    expect(outTimeOf(segs, FLASH + 0.8)).toBeCloseTo(2.0 + DEFAULT_TRAVEL_SEC, 1);
  });

  it("uses each step's own travel", () => {
    // A pre-positioned click: no glide, so it shows at its startAt, not startAt + 0.52.
    const segs = retime(take([{ index: 0, kind: 'click', at: 0.8 }]), sched([{ index: 0, do: 'click', startAt: 2.0, travel: 0 }]), voice(4), opts);
    expect(Math.abs(outTimeOf(segs, FLASH + 0.8) - 2.0)).toBeLessThanOrEqual(FRAME);
    const h = segs.find((g) => g.hold)!;
    expect(h.srcIn).toBeCloseTo(FLASH + 0.8 - 0.15, 6); // the hold protects only travel + 0.15
  });

  it('an early-arrival hold protects a long glide (travel + 0.15)', () => {
    const segs = retime(take([{ index: 0, kind: 'click', at: 2.0 }]), sched([{ index: 0, do: 'click', startAt: 2.2, travel: 0.8 }]), voice(4), opts);
    const h = segs.find((g) => g.hold)!;
    expect(h.srcIn).toBeCloseTo(FLASH + 2.0 - (0.8 + 0.15), 6);
    expect(outTimeOf(segs, FLASH + 2.0)).toBeCloseTo(3.0, 1);
  });

  it('a late action never cuts inside its own long glide', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const segs = retime(take([{ index: 0, kind: 'click', at: 4.0 }]), sched([{ index: 0, do: 'click', startAt: 1.4, travel: 1.0 }]), voice(4), opts);
    const clips = segs.filter((g) => g.hold === undefined);
    // The last 1.15 s before the click plays straight through.
    expect(clips.some((g) => g.srcIn <= FLASH + 4.0 - 1.15 + 1e-6 && g.srcOut >= FLASH + 4.0 - FRAME)).toBe(true); // up to a frame of rounding
    expect(outTimeOf(segs, FLASH + 4.0)).toBeCloseTo(2.4, 1);
  });

  it('scene length = voice + breath, first frame is after the flash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A click shown at 1.0 s: too little room to cut 0.4 s outside its protected glide, so retime warns.
    const segs = retime(take([{ index: 0, kind: 'click', at: 1.5 }]), sched([{ index: 0, do: 'click', startAt: 1.0 - DEFAULT_TRAVEL_SEC }]), voice(4), opts);
    expect(Math.abs(sceneLen(segs) - 4.45)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quiet window'));
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
    for (let t = p; t <= p + 0.8; t += 0.01) expect(Math.abs(outTimeOf(segs, t) - base - (t - p))).toBeLessThanOrEqual(FRAME);
    const n = FLASH + 7.0;
    for (let t = n - 0.67; t <= n; t += 0.01) expect(Math.abs(outTimeOf(segs, t) - outTimeOf(segs, n) - (t - n))).toBeLessThanOrEqual(FRAME);
    // the cut comes from the middle of [p + 0.8, n - 0.67]
    const cut = segs.find((g, i) => i > 0 && g.srcIn > segs[i - 1]!.srcOut + 0.1)!;
    expect(cut.srcIn).toBeGreaterThan(p + 0.8);
  });

  it('throws when an action happened before the take started', () => {
    expect(() =>
      retime(take([{ index: 0, kind: 'zoom', at: 0.05 }]), sched([{ index: 0, do: 'zoom', startAt: 1 }]), voice(4), opts),
    ).toThrow('scene "s": action 0 happened before the take started');
  });

  it('throws when take events are out of order against the schedule', () => {
    expect(() =>
      retime(
        take([{ index: 0, kind: 'zoom', at: 3 }, { index: 1, kind: 'zoom', at: 2 }]),
        sched([{ index: 0, do: 'zoom', startAt: 1 }, { index: 1, do: 'zoom', startAt: 2 }]),
        voice(4),
        opts,
      ),
    ).toThrow('scene "s": take events out of order at action 1');
  });

  it('holds the last frame when the source runs out', () => {
    const segs = retime(take([{ index: 0, kind: 'zoom', at: 1.0 }]), sched([{ index: 0, do: 'zoom', startAt: 1.0 }]), voice(6), { ...opts, srcDuration: 4 });
    const last = segs[segs.length - 1]!;
    expect(last.hold).toBeGreaterThan(0);
    expect(last.srcIn).toBeCloseTo(4 - 0.04, 9);
    expect(Math.abs(sceneLen(segs) - 6.45)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
  });

  it('never reads past the last frame', () => {
    const segs = retime(take([{ index: 0, kind: 'click', at: 1.0 }]), sched([{ index: 0, do: 'click', startAt: 0.5, travel: 0.5 }]), voice(14.6), {
      sceneId: 's',
      flashTime: 0.5,
      flashEnd: 0.6,
      srcDuration: 14.84,
      lastFrameSec: 14.8,
    });
    for (const g of segs) {
      expect(g.srcOut).toBeLessThanOrEqual(14.8 + 1e-9);
      expect(g.srcIn).toBeLessThanOrEqual(14.8 + 1e-9);
    }
    // 15.05 s (voice + breath), give or take the half output frame the scene end rounds to.
    expect(Math.abs(segs.reduce((t, g) => t + (g.hold ?? g.srcOut - g.srcIn), 0) - 15.05)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
    // The clip runs up to the last frame, which is then held to the end.
    const end = segs.at(-1)!;
    expect(end.hold).toBeGreaterThan(0);
    expect(end.srcIn).toBe(14.8);
  });

  it('a clip that output-frame rounding would stretch past the last frame ends on it', () => {
    // Clip [0.6, 14.83) then a hold: rounding the hold's start onto the 30 fps grid lengthens the clip.
    for (const lastFrameSec of [14.79, 14.81, 14.83, 14.85]) {
      const segs = retime(take([{ index: 0, kind: 'click', at: 1.0 }]), sched([{ index: 0, do: 'click', startAt: 0.5, travel: 0.5 }]), voice(14.6), {
        sceneId: 's', flashTime: 0.5, flashEnd: 0.6, lastFrameSec,
      });
      for (const g of segs) expect(g.srcOut).toBeLessThanOrEqual(lastFrameSec + 1e-9);
      expect(Math.abs(sceneLen(segs) - 15.05)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
    }
  });

  it('trims inside a long zoom hold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A zoom at 2.0 s held 3 s (the recorder logs no busyUntil for it: the composer draws the zoom), then a click
    // logged 1.5 s late at 6.5 s that must show at 5.0 s. Source time = take time here (flash at 0).
    const s = sched([
      { index: 0, do: 'zoom', startAt: 2.0, travel: 0 },
      { index: 1, do: 'click', startAt: 5.0 - DEFAULT_TRAVEL_SEC },
    ]);
    (s[0]!.step as { ms?: number }).ms = 3000;
    const segs = retime(take([{ index: 0, kind: 'zoom', at: 2.0 }, { index: 1, kind: 'click', at: 6.5 }]), s, voice(7), {
      sceneId: 's',
      flashTime: 0,
      flashEnd: 0.1,
    });
    const clips = segs.filter((g) => g.hold === undefined).sort((a, b) => a.outStart - b.outStart);
    const cuts: [number, number][] = [];
    // A gap of a frame or less between clips is output-frame rounding, not a cut.
    for (let i = 1; i < clips.length; i++) if (clips[i]!.srcIn > clips[i - 1]!.srcOut + 0.1) cuts.push([clips[i - 1]!.srcOut, clips[i]!.srcIn]);
    // One cut, inside the quiet window [zoom + 0.8, click - (travel + 0.15)] = [2.8, 5.83] of source time, and it
    // trims time while the zoom is still held (before 2.0 + 3.0).
    expect(cuts).toHaveLength(1);
    const [lo, hi] = cuts[0]!;
    expect(lo).toBeGreaterThanOrEqual(2.8 - 1 / 30);
    expect(hi).toBeLessThanOrEqual(5.83 + 1 / 30);
    expect(hi - lo).toBeCloseTo(1.5, 1);
    expect(lo).toBeLessThan(5.0);
    expect(warn).not.toHaveBeenCalled();
    expect(Math.abs(outTimeOf(segs, 6.5) - 5.0)).toBeLessThanOrEqual(FRAME);
  });

  it('every event lands within 1/30 s for random late/early patterns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      expect(Math.abs(sceneLen(segs) - (dur + 0.45))).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
      events.forEach((e, i) => {
        const want = items[i]!.startAt + (e.kind === 'click' ? DEFAULT_TRAVEL_SEC : 0);
        const got = outTimeOf(segs, FLASH + e.at);
        expect(Math.abs(got - want)).toBeLessThanOrEqual(FRAME);
      });
      // each action's travel + 0.15 s before it plays 1:1 (as far back as the previous event): 0.67 s for a click, 0.15 s for a zoom
      events.forEach((e, i) => {
        const sT = FLASH + e.at;
        const prev = i ? FLASH + events[i - 1]!.at : FLASH_END;
        const tOut = (j: number) => items[j]!.startAt + (events[j]!.kind === 'click' ? DEFAULT_TRAVEL_SEC : 0);
        const protect = (e.kind === 'click' ? DEFAULT_TRAVEL_SEC : 0) + 0.15;
        if (tOut(i) - (i ? tOut(i - 1) : 0) < protect) return; // too little output time between events to keep it
        const base = outTimeOf(segs, sT);
        for (let t = Math.max(sT - protect, prev + 0.05); t < sT - 0.05; t += 0.01)
          expect(Math.abs(outTimeInside(segs, t) - (base - (sT - t)))).toBeLessThanOrEqual(FRAME);
      });
      // 1:1 speed, contiguous
      let t = 0;
      for (const g of segs) {
        const len = g.hold ?? g.srcOut - g.srcIn;
        expect(g.outStart).toBeCloseTo(t, 6);
        expect(len * 30).toBeCloseTo(Math.round(len * 30), 6);
        expect(g.outStart * 30).toBeCloseTo(Math.round(g.outStart * 30), 6);
        t += len;
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
  }, 30_000);
});

describe('lastFrameTime', () => {
  it('lastFrameTime returns the last frame, not the container length', async () => {
    const { ffmpeg } = await ensureToolchain();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-last-'));
    const file = path.join(dir, 'take.webm');
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=3', '-c:v', 'libvpx', '-b:v', '200k', file]);
    expect(Math.abs((await lastFrameTime(file)) - 2.96)).toBeLessThanOrEqual(0.001);
  }, 30_000);
});

describe('outputTimeOf', () => {
  const segs = [
    { src: 'a', srcIn: 0.2, srcOut: 2.2, outStart: 0 },
    { src: 'a', srcIn: 2.2, srcOut: 2.2, outStart: 2.0, hold: 0.5 },
    { src: 'a', srcIn: 3.0, srcOut: 5.0, outStart: 2.5 },
  ];
  it('inverts the segments: clips map 1:1, cut source time maps to nothing', () => {
    expect(outputTimeOf(segs, 1.2)).toBeCloseTo(1.0, 9);
    expect(outputTimeOf(segs, 3.0)).toBeCloseTo(2.5, 9);
    expect(outputTimeOf(segs, 4.5)).toBeCloseTo(4.0, 9);
    expect(outputTimeOf(segs, 2.6)).toBeNull();
    // Up to a frame past a clip's end (frame-grid rounding) lands on the clip's end.
    expect(outputTimeOf(segs, 2.21)).toBeCloseTo(2.0, 9);
  });
});

describe('blank frames', () => {
  it('blankRanges: runs after the flash, each holding the last good frame before it', () => {
    const t = [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.24, 0.28];
    const std = [0, 0, 12, 11, 0.1, 0.0, 10, 0.3];
    // Frames before `from` (the flash and anything earlier) never count.
    const r6 = (r: { start: number; end: number; holdAt: number }) => ({ start: +r.start.toFixed(6), end: +r.end.toFixed(6), holdAt: +r.holdAt.toFixed(6) });
    expect(blankRanges(t, std, 0.08, 2).map(r6)).toEqual([
      { start: 0.16, end: 0.24, holdAt: 0.12 },
      { start: 0.28, end: 0.32, holdAt: 0.24 },
    ]);
    expect(blankRanges(t, std.map(() => 9), 0, 2)).toEqual([]);
  });

  it('retime freezes the last good frame over a blank run, keeping the scene length and the sync', () => {
    const blank = { start: FLASH + 1.6, end: FLASH + 1.68, holdAt: FLASH + 1.56 };
    const t = take([{ index: 0, kind: 'click', at: 1.0 }]);
    const s = sched([{ index: 0, do: 'click', startAt: 1.0 - DEFAULT_TRAVEL_SEC }]);
    const plain = retime(t, s, voice(4), opts);
    const segs = retime(t, s, voice(4), { ...opts, blanks: [blank] });
    expect(sceneLen(segs)).toBeCloseTo(sceneLen(plain), 9);
    const freeze = segs.find((g) => g.hold !== undefined && g.srcIn === blank.holdAt);
    expect(freeze).toBeDefined();
    expect(freeze!.hold!).toBeGreaterThan(0);
    // No clip shows a blank frame: nothing plays source time inside the run.
    for (const g of segs.filter((x) => x.hold === undefined))
      // ...with two output frames of margin before the run and one after (re-encoding rounds to the nearest frame).
      expect(g.srcOut <= blank.start - 2 * FRAME + FRAME / 2 + 1e-9 || g.srcIn >= blank.end + FRAME - 1e-9).toBe(true);
    expect(outTimeOf(segs, FLASH + 1.0)).toBeCloseTo(outTimeOf(plain, FLASH + 1.0), 9);
  });

  it('keeps an action just before a blank run on screen (the click that starts a navigation)', () => {
    // The click lands one source frame before the page goes blank.
    const blank = { start: FLASH + 1.04, end: FLASH + 1.08, holdAt: FLASH + 1.0 };
    const t = take([{ index: 0, kind: 'click', at: 1.0 }]);
    const s = sched([{ index: 0, do: 'click', startAt: 1.0 - DEFAULT_TRAVEL_SEC }]);
    const segs = retime(t, s, voice(4), { ...opts, blanks: [blank] });
    expect(outputTimeOf(segs, FLASH + 1.0)).not.toBeNull();
    expect(segs.some((g) => g.hold !== undefined && g.srcIn === blank.holdAt)).toBe(true);
  });

  it('maps an action logged inside a blank run to its place in the freeze', () => {
    // The click is logged a few ms after the first blank frame (the two clocks agree only to a frame).
    const blank = { start: FLASH + 1.0, end: FLASH + 1.04, holdAt: FLASH + 0.96 };
    const t = take([{ index: 0, kind: 'click', at: 1.008 }]);
    const s = sched([{ index: 0, do: 'click', startAt: 1.008 - DEFAULT_TRAVEL_SEC }]);
    const plain = retime(t, s, voice(4), opts);
    const segs = retime(t, s, voice(4), { ...opts, blanks: [blank] });
    const out = outputTimeOf(segs, FLASH + 1.008);
    expect(out).not.toBeNull();
    expect(Math.abs(out! - outputTimeOf(plain, FLASH + 1.008)!)).toBeLessThanOrEqual(FRAME);
  });

  it('an early-arrival hold never freezes a blank frame', () => {
    const at = FLASH + 0.8 - (DEFAULT_TRAVEL_SEC + 0.15); // where the plain early-arrival hold freezes
    const blank = { start: at - 0.02, end: at + 0.06, holdAt: at - 0.06 };
    const t = take([{ index: 0, kind: 'click', at: 0.8 }]);
    const s = sched([{ index: 0, do: 'click', startAt: 2.0 }]);
    const segs = retime(t, s, voice(4), { ...opts, blanks: [blank] });
    const holds = segs.filter((g) => g.hold !== undefined);
    expect(holds.length).toBeGreaterThan(0);
    for (const h of holds) expect(h.srcIn < blank.start - 1e-9 || h.srcIn >= blank.end + FRAME - 1e-9).toBe(true);
    expect(holds.some((h) => h.srcIn === blank.holdAt)).toBe(true);
  });

  it('scanBlank finds a white frame run inside a take (fixture video)', async () => {
    const { ffmpeg } = await ensureToolchain();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-blank-'));
    const file = path.join(dir, 'take.webm');
    // A busy test pattern with a 0.12 s plain white stretch at 1.0 s, like a page between navigations.
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2',
      '-f', 'lavfi', '-i', 'color=c=0xF4F6F8:s=320x180:r=25:d=2',
      '-filter_complex', '[0:v][1:v]overlay=enable=between(t\\,1.0\\,1.1)',
      '-c:v', 'libvpx', '-b:v', '1M', '-t', '2', file,
    ]);
    const runs = await scanBlank(file, 0.2);
    expect(runs).toHaveLength(1);
    expect(Math.abs(runs[0]!.start - 1.0)).toBeLessThanOrEqual(0.04 + 1e-6);
    expect(runs[0]!.end).toBeGreaterThan(runs[0]!.start);
    expect(runs[0]!.holdAt).toBeLessThan(runs[0]!.start);
    // Before `from`, it is ignored.
    expect(await scanBlank(file, 1.5)).toEqual([]);
  }, 30_000);
});

describe('retime never cuts inside an action that is still playing out', () => {
  /** Source ranges retime removed: the gaps between consecutive clips. */
  const cuts = (segs: Segment[]) => {
    const clips = segs.filter((g) => g.hold === undefined).sort((a, b) => a.outStart - b.outStart);
    const out: [number, number][] = [];
    for (let i = 1; i < clips.length; i++) if (clips[i]!.srcIn > clips[i - 1]!.srcOut + 1e-6) out.push([clips[i - 1]!.srcOut, clips[i]!.srcIn]);
    return out;
  };
  const insideOf = (c: [number, number][], lo: number, hi: number) => c.filter(([a, b]) => a < hi - 1e-6 && b > lo + 1e-6);

  // Each case: the action at 1.0 s lasts until `busy`; the next click happened at 4.0 s but must show at 2.6 s.
  const cases: { name: string; kind: 'type' | 'ring' | 'wait'; busy: number }[] = [
    { name: 'typing longer than 1 s', kind: 'type', busy: 2.2 },
    { name: 'a recorder ring (hold plus fades)', kind: 'ring', busy: 2.5 },
    { name: 'a step held with ms', kind: 'wait', busy: 2.3 },
  ];
  for (const c of cases) {
    it(c.name, () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = sched([
        { index: 0, do: c.kind, startAt: c.kind === 'type' ? 1.0 - DEFAULT_TRAVEL_SEC : 1.0 },
        { index: 1, do: 'click', startAt: 2.6 - DEFAULT_TRAVEL_SEC },
      ]);
      const plain = retime(take([{ index: 0, kind: c.kind, at: 1.0 }, { index: 1, kind: 'click', at: 4.0 }]), s, voice(5), opts);
      const segs = retime(take([{ index: 0, kind: c.kind, at: 1.0, busyUntil: c.busy }, { index: 1, kind: 'click', at: 4.0 }]), s, voice(5), opts);
      // Without the logged end, the old window cut into the action; with it, nothing inside [action, end] goes.
      expect(insideOf(cuts(plain), FLASH + 1.0, FLASH + c.busy).length).toBeGreaterThan(0);
      expect(insideOf(cuts(segs), FLASH + 1.0, FLASH + c.busy)).toEqual([]);
      // Sync is unchanged: both actions land where they did.
      for (const at of [1.0, 4.0]) expect(outTimeOf(segs, FLASH + at)).toBeCloseTo(outTimeOf(plain, FLASH + at), 6);
      expect(sceneLen(segs)).toBeCloseTo(sceneLen(plain), 9);
    });
  }
});
