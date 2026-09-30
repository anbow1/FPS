import { float, min, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import { DataTexture, LinearFilter, type Node, RGBAFormat, UnsignedByteType, Vector2 } from 'three/webgpu';

// Interactive ripples on water, shared file for file by Field Line, Castaway
// Lagoon and Tanks (docs/graphics-playbook.md §7.7). A small height field
// follows the player and is stepped on the CPU with the damped 2-D wave
// equation (explicit, leapfrog in time, 5-point Laplacian):
//   h' = (2h − h₋ + C²·∇²h)·damp,  C = c·Δt/Δx
// Wading legs, hulls, stones, bullets and blasts push the surface; rings
// spread at c, meet, and bounce off banks (land cells hold the surface at 0).
// Each frame the slope (∂h/∂x, ∂h/∂z) goes up as an RGBA8 texture that the
// water shader reads once per pixel, which is cheaper than summing a list of
// analytic rings per pixel and needs no render-target ping-pong, so it runs
// the same on the WebGL 2 fallback. When the field has calmed down it stops
// stepping and uploading altogether.

export interface RippleOptions {
  /** Cells per side of the square window. */
  cells: number;
  /** Cell size (m): the shortest ripple the field can hold is about four cells. */
  cellM: number;
  /** Wave speed (m/s). */
  speedMps: number;
  /** Time for a ring's height to fall to 1/e (s). */
  lifeS: number;
  /** Whether a world point is open water; land cells hold the surface still, so rings reflect off banks. */
  isWater?: (x: number, z: number) => boolean;
}

/** Fixed simulation step (s). With the speeds used here C² stays far below the 2-D limit of 0.5. */
const STEP_S = 1 / 30;
/** Steps per frame at most: a long frame drops time instead of spending more of it. */
const MAX_STEPS = 3;
/** Slopes are encoded in ±SLOPE_RANGE; steeper ripples saturate. */
const SLOPE_RANGE = 0.6;
/** Heights this small everywhere count as calm water (m). */
const CALM_M = 2e-5;
/** The window is re-centred once the focus has moved this many cells away. */
const RECENTRE_CELLS = 12;

export class RippleField {
  readonly texture: DataTexture;
  private readonly n: number;
  private readonly cellM: number;
  private readonly c2: number;
  private readonly damp: number;
  private readonly isWater: ((x: number, z: number) => boolean) | undefined;
  private h: Float32Array;
  private prev: Float32Array;
  private next: Float32Array;
  private mask: Uint8Array;
  private readonly maskScratch: Uint8Array;
  private readonly bytes: Uint8Array;
  private readonly origin = uniform(new Vector2());
  /** Window centre in whole cells. */
  private ci = 0;
  private cj = 0;
  private placed = false;
  private accS = 0;
  private active = false;
  private uploadFlat = false;

  constructor(opts: RippleOptions) {
    const n = opts.cells;
    this.n = n;
    this.cellM = opts.cellM;
    this.c2 = ((opts.speedMps * STEP_S) / opts.cellM) ** 2;
    this.damp = Math.exp(-STEP_S / opts.lifeS);
    this.isWater = opts.isWater;
    this.h = new Float32Array(n * n);
    this.prev = new Float32Array(n * n);
    this.next = new Float32Array(n * n);
    this.mask = new Uint8Array(n * n).fill(1);
    this.maskScratch = new Uint8Array(n * n);
    this.bytes = new Uint8Array(n * n * 4);
    this.fillFlat();
    this.texture = new DataTexture(this.bytes, n, n, RGBAFormat, UnsignedByteType);
    this.texture.magFilter = this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Side of the window (m). */
  get sizeM(): number {
    return this.n * this.cellM;
  }

  /**
   * Push the water at (x, z) down by up to `depthM` over a smooth bump of
   * `radiusM`. Called once for a splash, or every frame, scaled by speed, for
   * something moving through the water.
   */
  disturb(x: number, z: number, radiusM: number, depthM: number): void {
    if (!this.placed) return;
    const n = this.n;
    const r = Math.max(radiusM, this.cellM * 1.5);
    const fi = (x - this.originX()) / this.cellM + n / 2 - 0.5;
    const fj = (z - this.originZ()) / this.cellM + n / 2 - 0.5;
    const rc = r / this.cellM;
    const i0 = Math.max(1, Math.floor(fi - rc));
    const i1 = Math.min(n - 2, Math.ceil(fi + rc));
    const j0 = Math.max(1, Math.floor(fj - rc));
    const j1 = Math.min(n - 2, Math.ceil(fj + rc));
    if (i0 > i1 || j0 > j1) return;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - fi, j - fj) / rc;
        if (d >= 1) continue;
        const k = j * n + i;
        if (this.mask[k] === 0) continue;
        this.h[k] = (this.h[k] as number) - depthM * 0.5 * (1 + Math.cos(Math.PI * d));
      }
    }
    this.active = true;
  }

  /** Follow the focus (usually the camera), step the field and upload it if anything moved. */
  update(dtS: number, focusX: number, focusZ: number): void {
    this.follow(focusX, focusZ);
    if (!this.active) {
      if (this.uploadFlat) {
        this.fillFlat();
        this.texture.needsUpdate = true;
        this.uploadFlat = false;
      }
      return;
    }
    this.accS = Math.min(this.accS + dtS, STEP_S * MAX_STEPS);
    let stepped = false;
    let peak = 0;
    while (this.accS >= STEP_S) {
      this.accS -= STEP_S;
      peak = this.step();
      stepped = true;
    }
    if (!stepped) return;
    if (peak < CALM_M) {
      this.h.fill(0);
      this.prev.fill(0);
      this.active = false;
      this.uploadFlat = true;
      return;
    }
    this.encode();
    this.texture.needsUpdate = true;
  }

  /**
   * vec3(∂h/∂x, ∂h/∂z, agitation 0–1) at world xz, faded to calm at the
   * window's edge. The shading normal is normalize(−∂h/∂x, 1, −∂h/∂z).
   */
  sample(xz: Node<'vec2'>): Node<'vec3'> {
    const uv = xz.sub(this.origin).div(this.sizeM).add(0.5);
    const t = texture(this.texture, uv);
    const edge = min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y)));
    const fade = smoothstep(0.0, 0.08, edge);
    const s = SLOPE_RANGE * (255 / 127);
    return vec3(t.r.sub(128 / 255).mul(s), t.g.sub(128 / 255).mul(s), t.b).mul(fade);
  }

  private originX(): number {
    return this.ci * this.cellM;
  }

  private originZ(): number {
    return this.cj * this.cellM;
  }

  /** One leapfrog step; returns the largest |h| left. */
  private step(): number {
    const { n, c2, damp, h, prev, next, mask } = this;
    let peak = 0;
    for (let j = 1; j < n - 1; j++) {
      const row = j * n;
      for (let i = 1; i < n - 1; i++) {
        const k = row + i;
        if (mask[k] === 0) {
          next[k] = 0;
          continue;
        }
        const c = h[k] as number;
        const lap = (h[k - 1] as number) + (h[k + 1] as number) + (h[k - n] as number) + (h[k + n] as number) - 4 * c;
        const v = (2 * c - (prev[k] as number) + c2 * lap) * damp;
        next[k] = v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
    this.prev = h;
    this.h = next;
    this.next = prev;
    return peak;
  }

  /** Slopes by central differences, and the height's size as agitation (foam around a splash). */
  private encode(): void {
    const { n, h, bytes } = this;
    const inv = 1 / (2 * this.cellM) / SLOPE_RANGE;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const o = k * 4;
        if (i === 0 || j === 0 || i === n - 1 || j === n - 1) {
          bytes[o] = bytes[o + 1] = 128;
          bytes[o + 2] = 0;
          continue;
        }
        const gx = ((h[k + 1] as number) - (h[k - 1] as number)) * inv;
        const gz = ((h[k + n] as number) - (h[k - n] as number)) * inv;
        const hk = h[k] as number;
        bytes[o] = toByte(gx);
        bytes[o + 1] = toByte(gz);
        // 1 at 12 cm: a blast or a heavy stone froths, a wading wake (a few cm) does not
        bytes[o + 2] = Math.min(255, Math.abs(hk) * 255 * 8);
      }
    }
  }

  private fillFlat(): void {
    for (let o = 0; o < this.bytes.length; o += 4) {
      this.bytes[o] = this.bytes[o + 1] = 128;
      this.bytes[o + 2] = 0;
      this.bytes[o + 3] = 255;
    }
  }

  /** Keep the window centred on the focus: shift everything by whole cells once it has drifted. */
  private follow(x: number, z: number): void {
    const ti = Math.round(x / this.cellM);
    const tj = Math.round(z / this.cellM);
    if (this.placed && Math.abs(ti - this.ci) < RECENTRE_CELLS && Math.abs(tj - this.cj) < RECENTRE_CELLS) return;
    const di = this.placed ? ti - this.ci : this.n;
    const dj = this.placed ? tj - this.cj : this.n;
    this.ci = ti;
    this.cj = tj;
    this.placed = true;
    this.origin.value.set(this.originX(), this.originZ());
    const { n } = this;
    // shift the two time levels in place of their spares, then the mask
    for (const [src, dst] of [
      [this.h, this.next],
      [this.prev, this.next],
    ] as const) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const si = i + di;
          const sj = j + dj;
          dst[j * n + i] = si >= 0 && si < n && sj >= 0 && sj < n ? (src[sj * n + si] as number) : 0;
        }
      }
      src.set(dst);
    }
    const m = this.maskScratch;
    const x0 = this.originX() + (0.5 - n / 2) * this.cellM;
    const z0 = this.originZ() + (0.5 - n / 2) * this.cellM;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const si = i + di;
        const sj = j + dj;
        if (si >= 0 && si < n && sj >= 0 && sj < n) m[j * n + i] = this.mask[sj * n + si] as number;
        else m[j * n + i] = !this.isWater || this.isWater(x0 + i * this.cellM, z0 + j * this.cellM) ? 1 : 0;
      }
    }
    this.mask.set(m);
    if (this.active) {
      this.encode();
      this.texture.needsUpdate = true;
    }
  }
}

function toByte(s: number): number {
  const v = Math.round(128 + s * 127);
  return v < 1 ? 1 : v > 255 ? 255 : v;
}
