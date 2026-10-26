import { describe, expect, it } from 'vitest';
import { VideoClock } from '../src/record/clock.js';

/** A fake monotonic clock (fractional ms) and a wall clock that, like Date.now(), truncates to whole ms. */
function clocks() {
  const c = { mono: 1_000.25, wallExact: 1_792_000_000_000.7 };
  const clock = new VideoClock(() => c.mono, () => Math.floor(c.wallExact));
  const run = (ms: number) => {
    c.mono += ms;
    c.wallExact += ms;
  };
  return { c, clock, run };
}

describe('VideoClock', () => {
  it('measures how far a wall-clock step moved the video from the monotonic clock', () => {
    const { c, clock, run } = clocks();
    expect(clock.shiftSec()).toBe(0);
    run(1500.4);
    expect(clock.shiftSec()).toBe(0);
    // The system steps its wall clock 2.2 s ahead (as WSL2 does under load): the video gains 2.2 s from here on.
    c.wallExact += 2200;
    run(10);
    expect(clock.shiftSec()).toBeCloseTo(2.2, 2);
    run(3000);
    expect(clock.shiftSec()).toBeCloseTo(2.2, 2);
  });

  it('never reports the whole-millisecond truncation of Date.now() as a step', () => {
    const { clock, run } = clocks();
    for (let i = 0; i < 2000; i++) {
      run(0.37 + (i % 7) * 0.11);
      expect(clock.shiftSec()).toBe(0);
    }
  });

  it('a step back holds the video where it had got to until the wall clock catches up', () => {
    const { c, clock, run } = clocks();
    for (let i = 0; i < 100; i++) {
      run(20);
      clock.sample(); // the recorder samples every 20 ms
    }
    // 2 s in, the wall clock steps 0.7 s back. The encoder drops frames until their stamps pass the last one written,
    // so an action in the next 0.7 s shows where the video stopped (2.0 s), not 0.7 s earlier.
    c.wallExact -= 700;
    run(300);
    expect(clock.shiftSec()).toBeCloseTo(-0.3, 2); // shown at 2.0 s, fired at 2.3 s
    run(400);
    expect(clock.shiftSec()).toBeCloseTo(-0.7, 2); // caught up: from here the video is 0.7 s behind
    run(1000);
    expect(clock.shiftSec()).toBeCloseTo(-0.7, 2);
  });
});
