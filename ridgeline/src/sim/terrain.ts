// The battlefield: a 20 × 20 km region in detail and a ring of hills and
// mountains out past the horizon, from one height function (rules §6: logic,
// collision and the mesh read the same data). Baked once at load into two float
// grids — near: 20.48 km at 10 m (the scale a helicopter flies at), far:
// 163.84 km at 320 m — read by everyone with the same bilinear filter.
//
// The brief: "real relief ... good enough that masking is a real tactic — flat
// terrain kills this game". So the landform is a set of long ridges, 250–600 m
// above the valley floors, running south-west to north-east with saddles where
// they can be crossed low; a broad valley with a meandering river down the
// middle (its floodplain flat, its channel cut a few metres); and the forward
// base (FARP) on a levelled terrace by the river at the centre. Farther out the
// ridges rise into mountains, a backdrop and a wall.

export const TERRAIN = {
  nearSizeM: 20_480,
  nearRes: 2048,
  farSizeM: 163_840,
  farRes: 512,
  /** Near and far grids blend over this band of |x| or |z| (m) so the seam never shows. */
  blendFromM: 9400,
  blendToM: 10_100,
  seaLevelM: 0,
  /** The forward base terrace at the centre: elevation (m), flat radius and blend radius (m). */
  baseElevationM: 212,
  baseFlatM: 260,
  baseBlendM: 700,
  /** River: channel half-width and depth below the floodplain (m); its water surface sits this far below the banks. */
  riverHalfWidthM: 28,
  riverDepthM: 4,
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

/** The river's centreline: x (m) as a function of z, meandering north–south past the base. */
export function riverX(z: number): number {
  return 900 * Math.sin(z / 3300 + 0.4) + 420 * Math.sin(z / 1270 + 1.9) + 160 * Math.sin(z / 530) - 380;
}

/** Height of the valley floor along the river (m): falls gently to the south. */
function floorAt(z: number): number {
  return 205 - z * 0.004;
}

/**
 * Terrain height above sea level (m) — the source function, used only to bake
 * the grids. `detail` lets the far grid skip detail it cannot resolve.
 */
export function sourceHeight(x: number, z: number, detail = 1): number {
  const fine = detail > 0.5;
  // Distance from the river, warped a little so the valley walls are not parallel.
  const dRiver = Math.abs(x - riverX(z)) + 250 * fbm(x / 2600, z / 2600, 2, 7);
  const floor = floorAt(z);
  // Ridges: anisotropic ridged noise in coordinates turned 35°, long along SW–NE.
  const c = Math.cos(0.61);
  const s = Math.sin(0.61);
  const u = x * c - z * s;
  const v = x * s + z * c;
  const wu = u + 900 * fbm(u / 6000, v / 6000, 3, 11);
  const wv = v + 900 * fbm(u / 6000 + 4.1, v / 6000 - 1.3, 3, 12);
  const ridges = ridged(wu / 5200, wv / 1900, fine ? 7 : 4, 13);
  // Saddles: a slow noise along the ridge lines lowers them in places, the gaps to fly through.
  const saddle = 0.55 + 0.45 * smooth(-0.35, 0.35, fbm(wu / 2400, wv / 9000, 3, 17));
  // The valley: ridges grow from nothing at the floodplain edge to full height ~2.5 km out.
  const valley = smooth(350, 2600, dRiver);
  let h = floor + valley * (ridges * 560 * saddle + 40) + 30 * fbm(x / 1500, z / 1500, fine ? 5 : 2, 21) * (0.3 + valley);
  // Small-scale roughness: gullies and knolls (the cover a hover hides behind).
  if (fine) h += 9 * fbm(x / 260, z / 260, 4, 23) * valley;
  // Beyond the battlefield the ridges rise into mountains.
  const r = Math.max(Math.abs(x), Math.abs(z));
  h += smooth(11_000, 30_000, r) * ridged(x / 14_000, z / 14_000, fine ? 6 : 5, 31) * 1900;
  // The river channel cut into the floodplain.
  const bank = 1 - smooth(TERRAIN.riverHalfWidthM - 6, TERRAIN.riverHalfWidthM + 10, Math.abs(x - riverX(z)));
  h -= bank * TERRAIN.riverDepthM;
  // The forward base terrace by the river at the centre.
  const d = Math.hypot(x - 300, z);
  const flat = smooth(TERRAIN.baseFlatM, TERRAIN.baseBlendM, d);
  return TERRAIN.baseElevationM + (h - TERRAIN.baseElevationM) * flat;
}

/** Land cover from height, slope and noise (baked with the heights). */
export function sourceCover(x: number, z: number, h: number, slope: number, out: LandCover): LandCover {
  out.water = 0;
  const fromRiver = Math.abs(x - riverX(z));
  out.river = 1 - smooth(TERRAIN.riverHalfWidthM - 4, TERRAIN.riverHalfWidthM + 2, fromRiver);
  out.rock = smooth(0.4, 0.75, slope) * (1 - out.river);
  out.snow = smooth(1500, 2100, h + fbm(x / 3000, z / 3000, 2, 41) * 300) * smooth(0.75, 0.4, slope);
  // The forest belt: the middle slopes of the ridges, broken by clearings; riverside woods along the banks.
  const forestNoise = fbm(x / 2600, z / 2600, 4, 33);
  const belt = smooth(260, 340, h) * (1 - smooth(560, 720, h));
  const riverside = smooth(220, 60, fromRiver) * (1 - out.river);
  out.forest = (1 - out.snow) * smooth(0.0, 0.16, forestNoise * 0.8 + belt * 0.22 + riverside * 0.3 - 0.06) * (1 - out.rock * 0.8);
  // Keep the base clear.
  out.forest *= smooth(TERRAIN.baseFlatM, TERRAIN.baseBlendM + 200, Math.hypot(x - 300, z));
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
