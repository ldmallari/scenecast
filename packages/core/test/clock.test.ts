import { describe, expect, it } from 'vitest';
import { VideoClock } from '../src/record/clock.js';

describe('VideoClock', () => {
  it('measures how far a wall-clock step moved the video from the monotonic clock', () => {
    let mono = 1_000.25;
    let wall = 1_792_000_000_000;
    const clock = new VideoClock(() => mono, () => wall);
    expect(clock.shiftSec()).toBe(0);
    // Both clocks run on together: no shift (Date.now's whole milliseconds give sub-ms jitter, rounded away).
    mono += 1500.4;
    wall += 1500;
    expect(clock.shiftSec()).toBe(0);
    // The system steps its wall clock 2.2 s ahead (as WSL2 does under load): the video gains 2.2 s from here on.
    mono += 10;
    wall += 10 + 2200;
    expect(clock.shiftSec()).toBeCloseTo(2.2, 9);
    // A step back loses time in the video (the encoder drops frames until the stamps catch up).
    mono += 10;
    wall += 10 - 700;
    expect(clock.shiftSec()).toBeCloseTo(1.5, 9);
  });
});
