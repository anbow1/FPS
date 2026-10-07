import { Rng } from './rng';

// 2D simplex noise (Gustavson), seeded permutation.
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1];

export class Simplex2 {
  private perm = new Uint8Array(512);
  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  noise(xin: number, yin: number): number {
    const perm = this.perm;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = (perm[ii + perm[jj]!]! % 12) * 2;
      t0 *= t0;
      n += t0 * t0 * (GRAD[g]! * x0 + GRAD[g + 1]! * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = (perm[ii + i1 + perm[jj + j1]!]! % 12) * 2;
      t1 *= t1;
      n += t1 * t1 * (GRAD[g]! * x1 + GRAD[g + 1]! * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = (perm[ii + 1 + perm[jj + 1]!]! % 12) * 2;
      t2 *= t2;
      n += t2 * t2 * (GRAD[g]! * x2 + GRAD[g + 1]! * y2);
    }
    return 70 * n; // ~[-1, 1]
  }

  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let a = 1;
    let f = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += a * this.noise(x * f + o * 17.3, y * f - o * 9.1);
      norm += a;
      a *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  ridged(x: number, y: number, octaves: number): number {
    let a = 1;
    let f = 1;
    let sum = 0;
    let norm = 0;
    let w = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x * f + o * 31.7, y * f + o * 7.3));
      n *= n * w;
      w = Math.min(1, n * 2);
      sum += a * n;
      norm += a;
      a *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }
}

/**
 * Tileable value-noise fbm on a size×size grid (wraps at the edges), values in [0,1].
 * Used both for GPU textures and for CPU lookups of the very same data.
 */
export function tileableFbm(size: number, basePeriod: number, octaves: number, seed: number): Float32Array {
  const rng = new Rng(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      const ya = (y0 % period) * period;
      const yb = ((y0 + 1) % period) * period;
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const xa = x0 % period;
        const xb = (x0 + 1) % period;
        const a = lattice[ya + xa]!;
        const b = lattice[ya + xb]!;
        const c = lattice[yb + xa]!;
        const d = lattice[yb + xb]!;
        out[y * size + x]! += amp * (a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * ty);
      }
    }
    norm += amp;
    amp *= 0.5;
    period = Math.min(period * 2, size);
  }
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear, wrapping lookup into a tileable field; u,v in texture repeats. */
export function sampleWrap(data: Float32Array, size: number, u: number, v: number): number {
  const x = (u - Math.floor(u)) * size - 0.5;
  const y = (v - Math.floor(v)) * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const xa = ((x0 % size) + size) % size;
  const xb = (xa + 1) % size;
  const ya = ((y0 % size) + size) % size;
  const yb = (ya + 1) % size;
  const a = data[ya * size + xa]!;
  const b = data[ya * size + xb]!;
  const c = data[yb * size + xa]!;
  const d = data[yb * size + xb]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
