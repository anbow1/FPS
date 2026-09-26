import type { Pipeline } from './pipeline';

/** Quality steps, cheapest change first: AO off costs nothing to toggle, resolution reallocates. */
const STEPS: { ao: boolean; scale: number }[] = [
  { ao: true, scale: 1 },
  { ao: false, scale: 1 },
  { ao: false, scale: 0.87 },
  { ao: false, scale: 0.76 },
  { ao: false, scale: 0.67 },
  { ao: false, scale: 0.58 },
];

/**
 * Keeps the frame rate at the display's 60 Hz by trading image quality, never gameplay.
 * Frame times are judged by percentiles of a one-second window, so a single slow frame does nothing.
 * Going down is quick; going up is slow and remembers a level that failed, so it never oscillates.
 */
export class FrameGovernor {
  level = 0;
  /** frame times of the current one-second window */
  private samples = new Float32Array(512);
  private n = 0;
  private window = 0;
  private cooldown = 2;
  private goodFor = 0;
  /** level that was too slow the last time we tried it, and how long to stay away */
  private ceiling = -1;
  private ceilingT = 0;

  constructor(
    private readonly pipeline: Pipeline,
    private readonly onChange: () => void,
  ) {}

  reset(): void {
    this.n = this.window = this.goodFor = 0;
    this.cooldown = 2;
  }

  /** `dt` is the real frame interval (s); only call while the game is being played. */
  update(dt: number): void {
    if (dt <= 0 || dt > 1) return; // returning from a hidden tab or a breakpoint is not performance data
    this.cooldown -= dt;
    this.ceilingT -= dt;
    if (this.n < this.samples.length) this.samples[this.n++] = dt;
    this.window += dt;
    if (this.window < 1) return;
    // percentiles ignore isolated hitches (GC, a texture upload) but catch judder: step down when
    // over 30 % of frames miss vsync, step up only when 90 % are comfortably on time
    const sorted = this.samples.subarray(0, this.n).sort();
    const p70 = sorted[Math.floor(this.n * 0.7)]!;
    const p90 = sorted[Math.floor(this.n * 0.9)]!;
    this.n = this.window = 0;
    if (this.cooldown > 0) return;
    // below ~52 fps means frames miss vsync regularly
    if (p70 > 1 / 52 && this.level < STEPS.length - 1) {
      if (this.goodFor < 3) this.ceiling = this.level; // we just came up and it failed
      this.ceilingT = 60;
      this.set(this.level + 1);
      this.cooldown = 2.5;
      this.goodFor = 0;
      return;
    }
    if (p90 < 1 / 58.5) this.goodFor++;
    else this.goodFor = 0;
    const blocked = this.ceilingT > 0 && this.level - 1 <= this.ceiling;
    if (this.goodFor >= 8 && this.level > 0 && !blocked) {
      this.set(this.level - 1);
      this.cooldown = 3;
      this.goodFor = 0;
    }
  }

  private set(level: number): void {
    this.level = level;
    const s = STEPS[level]!;
    this.pipeline.aoAllowed = s.ao;
    this.pipeline.setRenderScale(s.scale);
    this.onChange();
  }

  get label(): string {
    const s = STEPS[this.level]!;
    return `${Math.round(s.scale * 100)} %${s.ao ? '' : ' · AO off'}`;
  }
}
