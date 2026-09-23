import { HEIGHT_CELL, PLAY_HALF, WATER_LEVEL, WORLD_SIZE } from '../config';
import { Simplex2 } from '../core/noise';
import { LAKES, ROADS, SITES } from './layout';

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Terrain height model. The height grid is the single source of truth: physics,
 * placement and the rendered LOD0 mesh all read the same samples.
 */
export class Heightfield {
  readonly n = WORLD_SIZE / HEIGHT_CELL + 1;
  readonly half = WORLD_SIZE / 2;
  readonly heights: Float32Array;
  /** 0..1 dirt-road coverage per grid sample */
  readonly road: Float32Array;
  private readonly sx: Simplex2;
  private readonly sy: Simplex2;
  private siteH: number[] = [];

  constructor(seed: number) {
    this.sx = new Simplex2(seed);
    this.sy = new Simplex2(seed * 7 + 3);
    this.siteH = SITES.map((s) => this.large(s.x, s.z) + 0.5);
    const n = this.n;
    this.heights = new Float32Array(n * n);
    this.road = new Float32Array(n * n);

    // Large features on a coarse 8 m grid, upsampled; small detail at full resolution.
    const step = 4;
    const cn = (n - 1) / step + 1;
    const coarse = new Float32Array(cn * cn);
    for (let j = 0; j < cn; j++) {
      for (let i = 0; i < cn; i++) {
        const x = -this.half + i * step * HEIGHT_CELL;
        const z = -this.half + j * step * HEIGHT_CELL;
        coarse[j * cn + i] = this.large(x, z);
      }
    }
    for (let j = 0; j < n; j++) {
      const cj = Math.min(cn - 2, Math.floor(j / step));
      const tj = j / step - cj;
      for (let i = 0; i < n; i++) {
        const ci = Math.min(cn - 2, Math.floor(i / step));
        const ti = i / step - ci;
        const a = coarse[cj * cn + ci]!;
        const b = coarse[cj * cn + ci + 1]!;
        const c = coarse[(cj + 1) * cn + ci]!;
        const d = coarse[(cj + 1) * cn + ci + 1]!;
        const big = (a * (1 - ti) + b * ti) * (1 - tj) + (c * (1 - ti) + d * ti) * tj;
        const x = -this.half + i * HEIGHT_CELL;
        const z = -this.half + j * HEIGHT_CELL;
        this.heights[j * n + i] = this.finish(x, z, big);
      }
    }
    this.rasteriseRoads();
  }

  /** Low-frequency shape: hills, ridges, lakes, flattened sites, boundary mountains. */
  private large(x: number, z: number): number {
    const s = this.sx;
    let h = 24 + s.fbm(x / 720, z / 720, 4) * 30;
    const ridgeMask = smoothstep(-0.15, 0.45, this.sy.fbm(x / 1300 + 4.1, z / 1300 - 2.7, 2));
    h += s.ridged(x / 430, z / 430, 4) * 24 * ridgeMask;
    // soft floor so only the authored lakes hold water
    h = 3 + Math.log1p(Math.exp((h - 3) * 0.5)) / 0.5;
    for (const l of LAKES) {
      const d = Math.hypot(x - l.x, z - l.z) / l.r;
      if (d < 1.6) {
        const w = 1 - smoothstep(0.25, 1.35, d + this.sy.noise(x / 90, z / 90) * 0.12);
        h = h + (WATER_LEVEL - l.depth - h) * w;
      }
    }
    for (let k = 0; k < SITES.length; k++) {
      const st = SITES[k]!;
      const d = Math.hypot(x - st.x, z - st.z);
      const w = 1 - smoothstep(st.r * 0.75, st.r * 1.5, d);
      if (w > 0) h = h + ((this.siteH[k] ?? h) - h) * w * 0.92;
    }
    // Mountain wall beyond the play area (soft square norm).
    const e = Math.pow(Math.pow(Math.abs(x), 6) + Math.pow(Math.abs(z), 6), 1 / 6);
    const m = smoothstep(PLAY_HALF - 30, 1150, e);
    if (m > 0) h += m * m * (130 + 90 * s.ridged(x / 240, z / 240, 4));
    return h;
  }

  private finish(x: number, z: number, big: number): number {
    const s = this.sy;
    let small = s.fbm(x / 95, z / 95, 3) * 2.0 + s.noise(x / 26, z / 26) * 0.45;
    for (const st of SITES) {
      const d = Math.hypot(x - st.x, z - st.z);
      small *= smoothstep(st.r * 0.6, st.r * 1.2, d) * 0.85 + 0.15;
    }
    return big + small;
  }

  /** Analytic height for anything outside the grid (distant mountain ring). */
  analytic(x: number, z: number): number {
    return this.finish(x, z, this.large(x, z));
  }

  private rasteriseRoads(): void {
    const n = this.n;
    const width = 4.2;
    for (const road of ROADS) {
      for (let k = 0; k < road.length - 1; k++) {
        const [ax, az] = road[k]!;
        const [bx, bz] = road[k + 1]!;
        const minX = Math.min(ax, bx) - 12;
        const maxX = Math.max(ax, bx) + 12;
        const minZ = Math.min(az, bz) - 12;
        const maxZ = Math.max(az, bz) + 12;
        const i0 = Math.max(0, Math.floor((minX + this.half) / HEIGHT_CELL));
        const i1 = Math.min(n - 1, Math.ceil((maxX + this.half) / HEIGHT_CELL));
        const j0 = Math.max(0, Math.floor((minZ + this.half) / HEIGHT_CELL));
        const j1 = Math.min(n - 1, Math.ceil((maxZ + this.half) / HEIGHT_CELL));
        const dx = bx - ax;
        const dz = bz - az;
        const len2 = dx * dx + dz * dz;
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const x = -this.half + i * HEIGHT_CELL;
            const z = -this.half + j * HEIGHT_CELL;
            // gentle meander so roads are not ruler-straight
            const wob = this.sx.noise(x / 60, z / 60) * 3.5;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
            const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t)) + wob;
            const v = 1 - smoothstep(width * 0.5, width * 0.5 + 2.5, Math.abs(d));
            const idx = j * n + i;
            if (v > this.road[idx]!) this.road[idx] = v;
          }
        }
      }
    }
    // Roads sink slightly into the ground (ruts / worn surface).
    for (let i = 0; i < n * n; i++) this.heights[i]! -= this.road[i]! * 0.18;
  }

  private sampleGrid(arr: Float32Array, x: number, z: number): number {
    const n = this.n;
    const fx = Math.min(n - 1.0001, Math.max(0, (x + this.half) / HEIGHT_CELL));
    const fz = Math.min(n - 1.0001, Math.max(0, (z + this.half) / HEIGHT_CELL));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = arr[j * n + i]!;
    const b = arr[j * n + i + 1]!;
    const c = arr[(j + 1) * n + i]!;
    const d = arr[(j + 1) * n + i + 1]!;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** Height matching the rendered triangles (grid is split along the same diagonal as the mesh). */
  heightAt(x: number, z: number): number {
    if (Math.abs(x) > this.half || Math.abs(z) > this.half) return this.analytic(x, z);
    const n = this.n;
    const fx = Math.min(n - 1.0001, Math.max(0, (x + this.half) / HEIGHT_CELL));
    const fz = Math.min(n - 1.0001, Math.max(0, (z + this.half) / HEIGHT_CELL));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h = this.heights;
    const a = h[j * n + i]!;
    const b = h[j * n + i + 1]!;
    const c = h[(j + 1) * n + i]!;
    const d = h[(j + 1) * n + i + 1]!;
    // triangles (a,c,b) and (b,c,d) — diagonal from b to c
    if (tx + tz <= 1) return a + (b - a) * tx + (c - a) * tz;
    return d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  }

  roadAt(x: number, z: number): number {
    if (Math.abs(x) > this.half || Math.abs(z) > this.half) return 0;
    return this.sampleGrid(this.road, x, z);
  }

  /** Unit normal via central differences; writes into out [x,y,z]. */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }, e = HEIGHT_CELL): void {
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx;
    const ny = 2 * e;
    const nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
  }

  gridHeight(i: number, j: number): number {
    const n = this.n;
    return this.heights[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))]!;
  }

  /** Terrain line-of-sight test between two points (sampled every `step` metres). */
  lineClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 8): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(len / step));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      if (this.heightAt(ax + dx * t, az + dz * t) > ay + dy * t) return false;
    }
    return true;
  }
}
