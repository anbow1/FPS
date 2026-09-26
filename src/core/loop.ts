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

  constructor(private readonly callbacks: LoopCallbacks) {}

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
    const frameSeconds = this.lastMs < 0 ? 0 : Math.min((nowMs - this.lastMs) / 1000, 0.25);
    this.lastMs = nowMs;
    this.accumulatorSeconds += frameSeconds;
    let steps = 0;
    while (this.accumulatorSeconds >= PHYSICS.stepSeconds && steps < PHYSICS.maxStepsPerFrame) {
      this.callbacks.step(PHYSICS.stepSeconds);
      this.accumulatorSeconds -= PHYSICS.stepSeconds;
      steps++;
    }
    if (steps === PHYSICS.maxStepsPerFrame) this.accumulatorSeconds = 0;
    this.callbacks.render(this.accumulatorSeconds / PHYSICS.stepSeconds, frameSeconds);
  };
}
