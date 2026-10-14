import { float, min, smoothstep, texture, uniform } from 'three/tsl';
import { DataTexture, LinearFilter, type Node, RedFormat, UnsignedByteType, Vector2 } from 'three/webgpu';

// Foam that a moving hull leaves on the water, after the seaplane in "Halcyon"
// (an AI-made three.js scene): white trails stream back from the floats, widen
// and tear into lace until, many lengths behind, only streaks are left. The
// ripple field (rippleField.ts) cannot hold that: its window is 24–32 m, which
// a boat crosses in five seconds, and it only knows how stirred the water is
// now. This is a second, coarser field round the camera that remembers. The
// hull, the propeller and every splash stamp foam into it; each step it fades
// (a time constant of seconds) and spreads a little (diffusion), so a trail
// widens as it ages. It is stepped on the CPU at 15 Hz and uploaded as one R8
// texture, and the water shader turns the amount into lace with the surf's own
// laceCover, so a wake tears apart the way the foam behind a breaker does.

export interface WakeFoamOptions {
  /** Cells per side of the square window. */
  cells: number;
  /** Cell size (m). */
  cellM: number;
  /** Time for foam to fall to 1/e (s). */
  lifeS: number;
  /** How fast a trail widens: the diffusion coefficient (m²/s). */
  spreadM2PerS: number;
}

const STEP_S = 1 / 15;
const MAX_STEPS = 2;
/** The window is re-centred once the focus has moved this many cells away. */
const RECENTRE_CELLS = 16;
/** Foam is held up to this much: a churned patch stays white a while before it starts to thin. */
const MAX_FOAM = 1.6;
/** Below this everywhere the water counts as clear and the field stops stepping. */
const CLEAR = 0.004;

export class WakeFoam {
  readonly texture: DataTexture;
  private readonly n: number;
  private readonly cellM: number;
  private readonly decay: number;
  private readonly spread: number;
  private f: Float32Array;
  private g: Float32Array;
  private readonly bytes: Uint8Array;
  private readonly origin = uniform(new Vector2());
  private ci = 0;
  private cj = 0;
  private placed = false;
  private accS = 0;
  private active = false;
  private uploadClear = false;

  constructor(o: WakeFoamOptions) {
    this.n = o.cells;
    this.cellM = o.cellM;
    this.decay = Math.exp(-STEP_S / o.lifeS);
    // Explicit diffusion is stable below 0.25 per step; the trails here need far less.
    this.spread = Math.min(0.2, (o.spreadM2PerS * STEP_S) / (o.cellM * o.cellM));
    this.f = new Float32Array(this.n * this.n);
    this.g = new Float32Array(this.n * this.n);
    this.bytes = new Uint8Array(this.n * this.n);
    this.texture = new DataTexture(this.bytes, this.n, this.n, RedFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  get sizeM(): number {
    return this.n * this.cellM;
  }

  /** Add foam in a soft disc of `radiusM` at (x, z); `amount` is the foam added at its centre. */
  stamp(x: number, z: number, radiusM: number, amount: number): void {
    if (!this.placed || amount <= 0) return;
    const { n, f } = this;
    const fi = (x - this.ci * this.cellM) / this.cellM + n / 2 - 0.5;
    const fj = (z - this.cj * this.cellM) / this.cellM + n / 2 - 0.5;
    const rc = Math.max(radiusM / this.cellM, 0.75);
    const i0 = Math.max(1, Math.floor(fi - rc));
    const i1 = Math.min(n - 2, Math.ceil(fi + rc));
    const j0 = Math.max(1, Math.floor(fj - rc));
    const j1 = Math.min(n - 2, Math.ceil(fj + rc));
    if (i0 > i1 || j0 > j1) return;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d2 = ((i - fi) * (i - fi) + (j - fj) * (j - fj)) / (rc * rc);
        if (d2 >= 1) continue;
        const k = j * n + i;
        const w = (1 - d2) * (1 - d2);
        f[k] = Math.min(MAX_FOAM, (f[k] as number) + amount * w);
      }
    }
    this.active = true;
  }

  /**
   * Foam along a segment, e.g. where a stern has moved since the last frame: stamped every
   * ~0.3 m with the amount shared out, so a long frame still leaves an unbroken trail.
   */
  stampLine(x0: number, z0: number, x1: number, z1: number, radiusM: number, amount: number): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len > 8) {
      this.stamp(x1, z1, radiusM, amount);
      return;
    }
    const steps = Math.max(1, Math.ceil(len / 0.3));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      this.stamp(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, radiusM, amount / steps);
    }
  }

  /** Follow the focus (usually the camera), step the field and upload it while there is foam. */
  update(dtS: number, focusX: number, focusZ: number): void {
    this.follow(focusX, focusZ);
    if (!this.active) {
      if (this.uploadClear) {
        this.bytes.fill(0);
        this.texture.needsUpdate = true;
        this.uploadClear = false;
      }
      return;
    }
    this.accS = Math.min(this.accS + dtS, STEP_S * MAX_STEPS);
    let peak = -1;
    while (this.accS >= STEP_S) {
      this.accS -= STEP_S;
      peak = this.step();
    }
    if (peak < 0) return;
    if (peak < CLEAR) {
      this.f.fill(0);
      this.active = false;
      this.uploadClear = true;
      return;
    }
    const { f, bytes } = this;
    for (let k = 0; k < bytes.length; k++) bytes[k] = Math.min(255, (f[k] as number) * 255);
    this.texture.needsUpdate = true;
  }

  /** Foam in the cell holding world (x, z), 0 outside the window (CPU side, for tests). */
  amountAt(x: number, z: number): number {
    const { n } = this;
    const i = Math.round((x - this.ci * this.cellM) / this.cellM + n / 2 - 0.5);
    const j = Math.round((z - this.cj * this.cellM) / this.cellM + n / 2 - 0.5);
    if (!this.placed || i < 0 || j < 0 || i >= n || j >= n) return 0;
    return this.f[j * n + i] as number;
  }

  /** Foam amount (0–1, more where saturated) at world xz, gone at the window's edge. */
  sample(xz: Node<'vec2'>): Node<'float'> {
    const uv = xz.sub(this.origin).div(this.sizeM).add(0.5);
    const edge = min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y)));
    return texture(this.texture, uv).r.mul(smoothstep(0.0, 0.06, edge));
  }

  /** Fade and spread one step; returns the most foam left anywhere. */
  private step(): number {
    const { n, f, g, decay, spread } = this;
    let peak = 0;
    for (let j = 1; j < n - 1; j++) {
      const row = j * n;
      for (let i = 1; i < n - 1; i++) {
        const k = row + i;
        const c = f[k] as number;
        const lap = (f[k - 1] as number) + (f[k + 1] as number) + (f[k - n] as number) + (f[k + n] as number) - 4 * c;
        const v = (c + spread * lap) * decay;
        g[k] = v;
        if (v > peak) peak = v;
      }
    }
    this.f = g;
    this.g = f;
    return peak;
  }

  /** Keep the window centred on the focus: shift the foam by whole cells once it has drifted. */
  private follow(x: number, z: number): void {
    const ti = Math.round(x / this.cellM);
    const tj = Math.round(z / this.cellM);
    if (this.placed && Math.abs(ti - this.ci) < RECENTRE_CELLS && Math.abs(tj - this.cj) < RECENTRE_CELLS) return;
    const di = this.placed ? ti - this.ci : this.n;
    const dj = this.placed ? tj - this.cj : this.n;
    this.ci = ti;
    this.cj = tj;
    this.placed = true;
    this.origin.value.set(ti * this.cellM, tj * this.cellM);
    const { n, f, g } = this;
    g.fill(0);
    if (Math.abs(di) < n && Math.abs(dj) < n) {
      for (let j = 0; j < n; j++) {
        const sj = j + dj;
        if (sj < 0 || sj >= n) continue;
        for (let i = 0; i < n; i++) {
          const si = i + di;
          if (si < 0 || si >= n) continue;
          g[j * n + i] = f[sj * n + si] as number;
        }
      }
    }
    this.f = g;
    this.g = f;
    if (this.active) {
      const { bytes } = this;
      const cur = this.f;
      for (let k = 0; k < bytes.length; k++) bytes[k] = Math.min(255, (cur[k] as number) * 255);
      this.texture.needsUpdate = true;
    }
  }
}
