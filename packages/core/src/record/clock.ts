/**
 * The take's video runs on the wall clock: Playwright stamps each screencast frame with Chromium's wall-clock swap
 * time and encodes at a constant 25 fps, filling any forward jump in those stamps with copies of the last frame and
 * dropping frames whose stamps went back until they pass the last one written. The recorder times its steps on the
 * monotonic clock. When the system steps its wall clock (WSL2 does every ~30 s, by 0.6 s idle and over 2 s under
 * load; NTP can too), the video moves away from the monotonic clock from then on. `VideoClock` tracks where the video
 * is, so logged times land on the video's clock.
 */
export class VideoClock {
  private readonly monoRef: number;
  private readonly wallRef: number;
  /** The furthest the video has got (ms after the reference): after a step back it stays here until the wall catches up. */
  private high = 0;

  private readonly mono: () => number;
  private readonly wall: () => number;

  // Plain fields, not parameter properties: the CLI runs on Node's type stripping, which rejects them.
  constructor(
    mono: () => number = () => performance.timeOrigin + performance.now(),
    wall: () => number = () => Date.now(),
  ) {
    this.mono = mono;
    this.wall = wall;
    this.monoRef = mono();
    this.wallRef = wall();
  }

  /**
   * Notes where the video is now. Call it often (every few tens of ms) during the take, so a step back is measured
   * from where the video had really got to.
   */
  sample(): void {
    const m = this.mono() - this.monoRef;
    let shift = this.wall() - this.wallRef - m;
    // Date.now() truncates to whole ms: a shift that small is that noise, not a step.
    if (Math.abs(shift) < SHIFT_DEAD_BAND_MS) shift = 0;
    this.high = Math.max(this.high, m + shift);
  }

  /** Seconds the video's clock is ahead of the monotonic clock now (behind when negative), since this clock was made. */
  shiftSec(): number {
    this.sample();
    const ms = Math.round(this.high - (this.mono() - this.monoRef));
    return Math.abs(ms) < SHIFT_DEAD_BAND_MS ? 0 : ms / 1000;
  }
}

/** A wall-minus-monotonic difference smaller than this (ms) is treated as none. */
export const SHIFT_DEAD_BAND_MS = 5;
