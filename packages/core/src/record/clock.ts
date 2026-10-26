/**
 * The take's video runs on the wall clock: Playwright stamps each screencast frame with Chromium's wall-clock swap
 * time and encodes at a constant 25 fps, filling any jump in those stamps with copies of the last frame. The
 * recorder times its steps on the monotonic clock. When the system steps its wall clock (WSL2 does every ~30 s,
 * by 0.6 s idle and over 2 s under load; NTP can too), the video gains (or loses) that much from then on, and
 * monotonic times no longer match the video. `VideoClock` measures that shift so logged times land on the video's clock.
 */
export class VideoClock {
  private readonly ref: number;

  constructor(
    private readonly mono: () => number = () => performance.timeOrigin + performance.now(),
    private readonly wall: () => number = () => Date.now(),
  ) {
    this.ref = wall() - mono();
  }

  /** Seconds the wall clock (and so the video) has moved ahead of the monotonic clock since this clock was made. */
  shiftSec(): number {
    // Date.now() has whole milliseconds: round away the sub-millisecond jitter.
    return Math.round(this.wall() - this.mono() - this.ref) / 1000 + 0; // + 0: never -0
  }
}
