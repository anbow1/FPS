// The world below: a 100 × 100 km region in detail and a ring out past the
// horizon (≈390 km seen from 12 km), from one height function (rules §6: logic,
// collision and the mesh read the same data). The function is expensive, so it
// is baked once at load into two float grids — near: 102.4 km at 100 m, far:
// 819.2 km at 1.6 km — and everything (the terrain mesh on the GPU, the radar
// altimeter, ground collision, landing) reads those grids with the same
// bilinear filter, so what you see is what you hit.
//
// Landforms, all procedural (no data files): a mountain range across the
// north with ridged peaks to ~3 km, rolling farmland and hills in the middle,
// meandering river valleys, a coast with open sea to the south-west, and an
// airbase plateau at 120 m at the centre with its runway along north–south.

export const TERRAIN = {
  nearSizeM: 102_400,
  nearRes: 1024,
  farSizeM: 819_200,
  farRes: 512,
  /** Near and far grids blend over this band of |x| or |z| (m) so the seam never shows. */
  blendFromM: 46_000,
  blendToM: 50_000,
  seaLevelM: 0,
  airbaseElevationM: 120,
  /** Flattened airbase plateau: full flat inside, blended to the land outside (m). */
  airbaseFlatM: 2600,
  airbaseBlendM: 5200,
} as const;

/** Land cover at a point, 0…1 weights (sum ≤ 1; the rest is grass/farmland). */
export interface LandCover {
  forest: number;
  rock: number;
  snow: number;
  water: number;
  river: number;
}

// ---- fast gradient noise (a 256-entry gradient table instead of trig per corner)
const GRAD_X = new Float32Array(256);
const GRAD_Y = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const a = (i / 256) * Math.PI * 2 + 0.37;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

function hashIndex(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 255;
}

/** 2-D gradient noise in about [−1, 1]. */
export function gnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const g00 = hashIndex(ix, iy, seed);
  const g10 = hashIndex(ix + 1, iy, seed);
  const g01 = hashIndex(ix, iy + 1, seed);
  const g11 = hashIndex(ix + 1, iy + 1, seed);
  const n00 = GRAD_X[g00]! * fx + GRAD_Y[g00]! * fy;
  const n10 = GRAD_X[g10]! * (fx - 1) + GRAD_Y[g10]! * fy;
  const n01 = GRAD_X[g01]! * fx + GRAD_Y[g01]! * (fy - 1);
  const n11 = GRAD_X[g11]! * (fx - 1) + GRAD_Y[g11]! * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  return (n00 + (n10 - n00) * u + (n01 - n00) * v + (n00 - n10 - n01 + n11) * u * v) * 1.41;
}

function fbm(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * gnoise(fx, fy, seed + i * 17);
    amp *= 0.5;
    fx = fx * 2.01 + 3.1;
    fy = fy * 2.01 - 1.7;
  }
  return sum;
}

function ridged(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let weight = 1;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(gnoise(fx, fy, seed + i * 31));
    n *= n * weight;
    weight = Math.min(1, n * 2);
    sum += n * amp;
    amp *= 0.5;
    fx = fx * 2.03 + 1.3;
    fy = fy * 2.03 - 0.9;
  }
  return sum;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** River strength 0…1 at (x, z): narrow valleys along the zero line of a warped noise field. */
function riverAt(x: number, z: number): number {
  const n = fbm(x / 28_000 + 11.3, z / 28_000 - 4.2, 3, 71);
  // ~200 m wide at the bottom, valleys a few km across.
  return 1 - smooth(0.0, 0.035, Math.abs(n));
}

/**
 * Terrain height above sea level (m) — the source function, used only to bake
 * the grids. `octaves` lets the far grid skip detail it cannot resolve.
 */
export function sourceHeight(x: number, z: number, detail = 1): number {
  // Domain warp for organic shapes.
  const wx = x + 6000 * fbm(x / 40_000, z / 40_000, 3, 5);
  const wz = z + 6000 * fbm(x / 40_000 + 7.7, z / 40_000 - 2.1, 3, 9);
  // Continent: higher to the north-east, sea to the south-west beyond ~35 km.
  const trend = -(x + z) / 140_000 + 0.55 * fbm(wx / 160_000, wz / 160_000, 3, 1);
  const coast = smooth(-0.62, -0.2, trend);
  let h = -600 + 900 * coast + 260 * trend;
  // Mountain range across the north (z < 0) and patches elsewhere.
  const rangeMask = smooth(-12_000, -40_000, wz) * 0.9 + smooth(0.25, 0.6, fbm(wx / 90_000 + 5, wz / 90_000, 3, 3)) * 0.6;
  const mountains = ridged(wx / 16_000, wz / 16_000, detail > 0.5 ? 7 : 4, 13);
  h += Math.min(1, rangeMask) * coast * mountains * 3200;
  // Rolling hills everywhere on land.
  h += coast * (fbm(wx / 7000, wz / 7000, detail > 0.5 ? 6 : 3, 21) * 260 + 80);
  // River valleys carved into the land.
  h -= coast * riverAt(wx, wz) * 90;
  // Airbase plateau at the centre.
  const d = Math.hypot(x, z * 0.6);
  const flat = smooth(TERRAIN.airbaseFlatM, TERRAIN.airbaseBlendM, d);
  return TERRAIN.airbaseElevationM + (h - TERRAIN.airbaseElevationM) * flat;
}

/** Land cover from height, slope and noise (baked with the heights). */
export function sourceCover(x: number, z: number, h: number, slope: number, out: LandCover): LandCover {
  const wx = x + 6000 * fbm(x / 40_000, z / 40_000, 3, 5);
  const wz = z + 6000 * fbm(x / 40_000 + 7.7, z / 40_000 - 2.1, 3, 9);
  out.water = h < TERRAIN.seaLevelM ? 1 : 0;
  const river = riverAt(wx, wz);
  out.river = h > TERRAIN.seaLevelM && river > 0.75 ? smooth(0.75, 0.95, river) : 0;
  out.rock = smooth(0.35, 0.7, slope) * (1 - out.water);
  out.snow = smooth(2100, 2700, h + fbm(x / 3000, z / 3000, 2, 41) * 300) * smooth(0.75, 0.4, slope);
  const forestNoise = fbm(x / 9000, z / 9000, 4, 33);
  out.forest = (1 - out.water) * (1 - out.snow) * smooth(0.0, 0.18, forestNoise + smooth(500, 1400, h) * 0.3 - smooth(1800, 2300, h) * 0.6) * (1 - out.rock * 0.7);
  // Keep the airbase clear.
  const base = 1 - smooth(TERRAIN.airbaseFlatM, TERRAIN.airbaseBlendM, Math.hypot(x, z * 0.6));
  out.forest *= 1 - base;
  return out;
}

/** The baked grids and the one bilinear lookup everybody uses. */
export class TerrainData {
  constructor(
    readonly near: Float32Array,
    readonly far: Float32Array,
  ) {}

  /** Height (m) at world (x, z): bilinear on the near grid inside, the far grid outside, blended between. */
  heightAt(x: number, z: number): number {
    const m = Math.max(Math.abs(x), Math.abs(z));
    if (m <= TERRAIN.blendFromM) return sampleGrid(this.near, TERRAIN.nearRes, TERRAIN.nearSizeM, x, z);
    const far = sampleGrid(this.far, TERRAIN.farRes, TERRAIN.farSizeM, x, z);
    if (m >= TERRAIN.blendToM) return far;
    const t = (m - TERRAIN.blendFromM) / (TERRAIN.blendToM - TERRAIN.blendFromM);
    return sampleGrid(this.near, TERRAIN.nearRes, TERRAIN.nearSizeM, x, z) * (1 - t) + far * t;
  }
}

/** Bilinear sample of a square grid of `res` × `res` texel centres covering [−size/2, size/2]². */
export function sampleGrid(grid: Float32Array, res: number, sizeM: number, x: number, z: number): number {
  const u = (x / sizeM + 0.5) * res - 0.5;
  const v = (z / sizeM + 0.5) * res - 0.5;
  const i = Math.min(res - 2, Math.max(0, Math.floor(u)));
  const j = Math.min(res - 2, Math.max(0, Math.floor(v)));
  const fu = Math.min(1, Math.max(0, u - i));
  const fv = Math.min(1, Math.max(0, v - j));
  const a = grid[j * res + i]!;
  const b = grid[j * res + i + 1]!;
  const c = grid[(j + 1) * res + i]!;
  const d = grid[(j + 1) * res + i + 1]!;
  return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
}

/** Bakes one grid; yields to the browser every few rows so the loading screen stays alive. */
export async function bakeGrid(res: number, sizeM: number, detail: number, onProgress?: (f: number) => void): Promise<Float32Array> {
  const out = new Float32Array(res * res);
  const cell = sizeM / res;
  for (let j = 0; j < res; j++) {
    const z = -sizeM / 2 + (j + 0.5) * cell;
    for (let i = 0; i < res; i++) out[j * res + i] = sourceHeight(-sizeM / 2 + (i + 0.5) * cell, z, detail);
    if (j % 32 === 31) {
      onProgress?.(j / res);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return out;
}

export async function bakeTerrain(onProgress?: (f: number) => void): Promise<TerrainData> {
  const near = await bakeGrid(TERRAIN.nearRes, TERRAIN.nearSizeM, 1, (f) => onProgress?.(f * 0.75));
  const far = await bakeGrid(TERRAIN.farRes, TERRAIN.farSizeM, 0, (f) => onProgress?.(0.75 + f * 0.25));
  return new TerrainData(near, far);
}
