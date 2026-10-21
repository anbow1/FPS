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

/**
 * Land cover from height, slope, aspect and relief (baked with the heights). `northness` is how far
 * the slope faces north (−1 … 1, the horizontal normal's −z: shaded from the midday sun),
 * `concavity` the ground's curvature (> 0 in a gully or hollow, < 0 on a ridge or knoll, −1 … 1).
 */
export function sourceCover(x: number, z: number, h: number, slope: number, northness: number, concavity: number, out: LandCover): LandCover {
  out.water = 0;
  const fromRiver = Math.abs(x - riverX(z));
  out.river = 1 - smooth(TERRAIN.riverHalfWidthM - 4, TERRAIN.riverHalfWidthM + 2, fromRiver);
  // Wind strips the ridges to rock; gullies fill with debris and soil.
  out.rock = smooth(0.4, 0.75, slope - concavity * 0.12) * (1 - out.river);
  // Late-summer snow: the line is ~250 m lower on a shaded north face and in the gullies the
  // avalanches and drifts fill, higher on the sunny side and on wind-blown ridges, and it breaks
  // into patches a few hundred metres across round the line (as in any alpine aerial photo).
  const snowLine = h + fbm(x / 3000, z / 3000, 2, 41) * 300 + northness * 240 + concavity * 260 + fbm(x / 420, z / 420, 3, 47) * 140;
  out.snow = smooth(1500, 2100, snowLine) * smooth(0.75, 0.4, slope - Math.max(concavity, 0) * 0.15);
  // The forest belt: the middle slopes of the ridges, broken by clearings; riverside woods along the banks.
  const forestNoise = fbm(x / 2600, z / 2600, 4, 33);
  const belt = smooth(260, 340, h) * (1 - smooth(560, 720, h));
  const riverside = smooth(220, 60, fromRiver) * (1 - out.river);
  out.forest = (1 - out.snow) * smooth(0.0, 0.16, forestNoise * 0.8 + belt * 0.22 + riverside * 0.3 - 0.06) * (1 - out.rock * 0.8);
  // Keep the base clear.
  out.forest *= smooth(TERRAIN.baseFlatM, TERRAIN.baseBlendM + 200, Math.hypot(x - 300, z));
  return out;
}

/**
 * Normal and land-cover texels (RGBA8 each) for rows j0…j1 of a baked grid. `grid` holds rows from
 * `row0` on (a band plus one row either side is enough), so worker threads get only their slice.
 */
export function bakeMapRows(grid: Float32Array, row0: number, res: number, sizeM: number, j0: number, j1: number): { normal: Uint8Array; cover: Uint8Array } {
  const n = (j1 - j0) * res * 4;
  const normal = new Uint8Array(n);
  const cover = new Uint8Array(n);
  const cell = sizeM / res;
  const lc: LandCover = { forest: 0, rock: 0, snow: 0, water: 0, river: 0 };
  const rows = grid.length / res;
  const h = (i: number, j: number): number => grid[Math.min(rows - 1, Math.max(0, Math.min(res - 1, Math.max(0, j)) - row0)) * res + Math.min(res - 1, Math.max(0, i))]!;
  for (let j = j0; j < j1; j++) {
    const z = -sizeM / 2 + (j + 0.5) * cell;
    for (let i = 0; i < res; i++) {
      const x = -sizeM / 2 + (i + 0.5) * cell;
      const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * cell);
      const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(dx, 1, dz);
      const k = ((j - j0) * res + i) * 4;
      normal[k] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      normal[k + 1] = Math.round((inv * 0.5 + 0.5) * 255);
      normal[k + 2] = Math.round((-dz * inv * 0.5 + 0.5) * 255);
      // Curvature from the 8-neighbour Laplacian (m⁻¹; one row either side, as the bands carry), into
      // −1…1: a 10 m deep gully 40 m across reads ~0.7. In the normal map's alpha (render/landCover.ts).
      const lap = (h(i + 1, j) + h(i - 1, j) + h(i, j + 1) + h(i, j - 1) + 0.5 * (h(i + 1, j + 1) + h(i - 1, j + 1) + h(i + 1, j - 1) + h(i - 1, j - 1)) - 6 * h(i, j)) / (3 * cell * cell);
      const concavity = Math.tanh(lap * 25 * Math.min(1, cell / 10));
      normal[k + 3] = Math.round((concavity * 0.5 + 0.5) * 255);
      const horiz = Math.hypot(dx, dz);
      const northness = horiz > 1e-4 ? (dz / horiz) * Math.min(1, horiz * 3) : 0;
      sourceCover(x, z, h(i, j), 1 - inv, northness, concavity, lc);
      cover[k] = Math.round(lc.forest * 255);
      cover[k + 1] = Math.round(lc.rock * 255);
      cover[k + 2] = Math.round(lc.snow * 255);
      cover[k + 3] = Math.round(Math.max(lc.water, lc.river) * 255);
    }
  }
  return { normal, cover };
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

/**
 * Bakes one grid on worker threads, a band of rows each (the same source function, so the result is
 * bit-identical to `bakeGrid`); falls back to the main thread where workers are unavailable (tests).
 */
/** Runs `bands` jobs on a few module workers; `job(b)` makes band b's message, `take(b, data)` stores the reply. */
async function onWorkers<T>(bands: number, job: (b: number) => { msg: object; transfer?: Transferable[] }, take: (b: number, data: T) => void, onProgress?: (f: number) => void): Promise<void> {
  const threads = Math.max(2, Math.min(8, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));
  let next = 0;
  let done = 0;
  const run = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      const send = (): void => {
        if (next >= bands) {
          w.terminate();
          resolve();
          return;
        }
        const b = next++;
        w.onmessage = (e: MessageEvent<T>): void => {
          take(b, e.data);
          done++;
          onProgress?.(done / bands);
          send();
        };
        const { msg, transfer } = job(b);
        w.postMessage(msg, transfer ?? []);
      };
      w.onerror = (e): void => {
        w.terminate();
        reject(new Error(`terrain worker failed: ${e.message}`));
      };
      send();
    });
  await Promise.all(Array.from({ length: Math.min(threads, bands) }, run));
}

/** Bakes one grid on worker threads, a band of rows each — bit-identical to `bakeGrid`. */
async function bakeGridParallel(res: number, sizeM: number, detail: number, onProgress?: (f: number) => void): Promise<Float32Array> {
  const out = new Float32Array(res * res);
  const bands = 32;
  const rows = Math.ceil(res / bands);
  await onWorkers<Float32Array>(
    bands,
    (b) => ({ msg: { kind: 'heights', res, sizeM, detail, j0: b * rows, j1: Math.min(res, (b + 1) * rows) } }),
    (b, data) => out.set(data, b * rows * res),
    onProgress,
  );
  return out;
}

/** Normal and cover maps of a grid on worker threads (each gets its band of rows plus a border row). */
export async function bakeMapsParallel(grid: Float32Array, res: number, sizeM: number, onProgress?: (f: number) => void): Promise<{ normal: Uint8Array; cover: Uint8Array }> {
  if (typeof Worker === 'undefined') return bakeMapRows(grid, 0, res, sizeM, 0, res);
  const normal = new Uint8Array(res * res * 4);
  const cover = new Uint8Array(res * res * 4);
  const bands = 32;
  const rows = Math.ceil(res / bands);
  await onWorkers<{ normal: Uint8Array; cover: Uint8Array }>(
    bands,
    (b) => {
      const j0 = b * rows;
      const j1 = Math.min(res, j0 + rows);
      const r0 = Math.max(0, j0 - 1);
      const slice = grid.slice(r0 * res, Math.min(res, j1 + 1) * res);
      return { msg: { kind: 'maps', res, sizeM, j0, j1, row0: r0, grid: slice }, transfer: [slice.buffer] };
    },
    (b, data) => {
      normal.set(data.normal, b * rows * res * 4);
      cover.set(data.cover, b * rows * res * 4);
    },
    onProgress,
  );
  return { normal, cover };
}

export async function bakeTerrain(onProgress?: (f: number) => void): Promise<TerrainData> {
  if (typeof Worker === 'undefined') {
    const near = await bakeGrid(TERRAIN.nearRes, TERRAIN.nearSizeM, 1, (f) => onProgress?.(f * 0.75));
    const far = await bakeGrid(TERRAIN.farRes, TERRAIN.farSizeM, 0, (f) => onProgress?.(0.75 + f * 0.25));
    return new TerrainData(near, far);
  }
  const t0 = performance.now();
  try {
    const [near, far] = await Promise.all([bakeGridParallel(TERRAIN.nearRes, TERRAIN.nearSizeM, 1, (f) => onProgress?.(f * 0.85)), bakeGridParallel(TERRAIN.farRes, TERRAIN.farSizeM, 0)]);
    console.log(`terrain grids baked on workers in ${(performance.now() - t0).toFixed(0)} ms`);
    return new TerrainData(near, far);
  } catch (err) {
    // A WebView without module workers: bake here, slower but the same.
    console.warn(err);
    const near = await bakeGrid(TERRAIN.nearRes, TERRAIN.nearSizeM, 1, (f) => onProgress?.(f * 0.75));
    const far = await bakeGrid(TERRAIN.farRes, TERRAIN.farSizeM, 0, (f) => onProgress?.(0.75 + f * 0.25));
    return new TerrainData(near, far);
  }
}
