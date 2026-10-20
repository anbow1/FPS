import { PHYSICS } from '../config.ts';

// Fixed-step loop (rules §5): logic runs at exactly 60 Hz, rendering runs at
// the display rate and interpolates with `alpha` = leftover fraction of a step.

export interface LoopCallbacks {
  step: (dtSeconds: number) => void;
  render: (alpha: number, frameSeconds: number) => void;
}

export class FixedLoop {
  private accumulatorSeconds = 0;
  private lastMs = -1;
  private running = false;
  private rafId = 0;
  /** While true the simulation stands still (the pause screen); frames are still drawn, with no time passing. */
  paused = false;

  /** `maxStepsPerFrame` defaults to the config value; tests on a slow software GPU raise it to keep game time moving. */
  constructor(
    private readonly callbacks: LoopCallbacks,
    private readonly maxStepsPerFrame: number = PHYSICS.maxStepsPerFrame,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMs = -1;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    // First frame: no elapsed time yet, so no step, but still render.
    const frameSeconds = this.lastMs < 0 ? 0 : Math.min((nowMs - this.lastMs) / 1000, 0.25 * (this.maxStepsPerFrame / PHYSICS.maxStepsPerFrame));
    this.lastMs = nowMs;
    if (this.paused) {
      this.callbacks.render(this.accumulatorSeconds / PHYSICS.stepSeconds, 0);
      return;
    }
    this.accumulatorSeconds += frameSeconds;
    let steps = 0;
    while (this.accumulatorSeconds >= PHYSICS.stepSeconds && steps < this.maxStepsPerFrame) {
      this.callbacks.step(PHYSICS.stepSeconds);
      this.accumulatorSeconds -= PHYSICS.stepSeconds;
      steps++;
    }
    if (steps === this.maxStepsPerFrame) this.accumulatorSeconds = 0;
    this.callbacks.render(this.accumulatorSeconds / PHYSICS.stepSeconds, frameSeconds);
  };
}
