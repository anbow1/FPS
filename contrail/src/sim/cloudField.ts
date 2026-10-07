// Cloud field shared by the renderer and the game logic (rules §2.5: one
// source of truth). Two tileable noise volumes and a coverage map, baked once:
//
//   shape   64³, Perlin-Worley (Schneider, "The Real-Time Volumetric Cloudscapes
//           of Horizon Zero Dawn", SIGGRAPH 2015): billowy cells with fbm
//           detail, tiling every SHAPE_TILE_M;
//   detail  32³, Worley fbm, erodes the edges into wisps;
//   weather 256², coverage 0…1 over WEATHER_TILE_M, so the sky has clear gaps
//           and denser banks.
//
// `densityAt` evaluates the same formula as the GPU pass from the same bytes,
// so "inside a cloud" means the same thing to the AI's eyes and to the player's.

export const CLOUD_FIELD = {
  shapeRes: 64,
  detailRes: 32,
  weatherRes: 256,
  shapeTileM: 9000,
  detailTileM: 1600,
  weatherTileM: 160_000,
} as const;

export interface CloudLayer {
  baseM: number;
  topM: number;
  coverage: number;
}

export interface CloudData {
  shape: Uint8Array;
  detail: Uint8Array;
  weather: Uint8Array;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable Worley F1 (inverted: 1 at feature points) with `cells` cells per period. */
function worley(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells;
  const py = y * cells;
  const pz = z * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx;
        const cy = iy + dy;
        const cz = iz + dz;
        const wx = ((cx % cells) + cells) % cells;
        const wy = ((cy % cells) + cells) % cells;
        const wz = ((cz % cells) + cells) % cells;
        const fx = cx + hash3(wx, wy, wz, seed) - px;
        const fy = cy + hash3(wx, wy, wz, seed + 1) - py;
        const fz = cz + hash3(wx, wy, wz, seed + 2) - pz;
        best = Math.min(best, fx * fx + fy * fy + fz * fz);
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

/** Tileable value noise in 3-D with `cells` cells per period. */
function valueNoise(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells;
  const py = y * cells;
  const pz = z * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fy = py - iy;
  const fz = pz - iz;
  const s = (t: number): number => t * t * (3 - 2 * t);
  const w = (v: number): number => ((v % cells) + cells) % cells;
  const at = (a: number, b: number, c: number): number => hash3(w(ix + a), w(iy + b), w(iz + c), seed);
  const x00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * s(fx);
  const x10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * s(fx);
  const x01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * s(fx);
  const x11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * s(fx);
  const y0 = x00 + (x10 - x00) * s(fy);
  const y1 = x01 + (x11 - x01) * s(fy);
  return y0 + (y1 - y0) * s(fz);
}

function remap(v: number, lo: number, hi: number, nlo: number, nhi: number): number {
  return nlo + ((v - lo) / (hi - lo)) * (nhi - nlo);
}

/**
 * Histogram equalisation to bytes: the noise's ranks spread evenly over 0…1, so "a fraction c of
 * the volume is above 1 − c" holds and the coverage numbers mean what they say.
 */
function equalise(values: Float32Array): Uint8Array {
  const order = Array.from(values.keys()).sort((a, b) => values[a]! - values[b]!);
  const out = new Uint8Array(values.length);
  for (let r = 0; r < order.length; r++) out[order[r]!] = Math.round((r / (order.length - 1)) * 255);
  return out;
}

export async function bakeCloudData(): Promise<CloudData> {
  const S = CLOUD_FIELD.shapeRes;
  const shapeF = new Float32Array(S * S * S);
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        const w = z / S;
        const perlin = valueNoise(u, v, w, 4, 1) * 0.5 + valueNoise(u, v, w, 8, 2) * 0.3 + valueNoise(u, v, w, 16, 3) * 0.2;
        const wfbm = worley(u, v, w, 4, 7) * 0.625 + worley(u, v, w, 8, 8) * 0.25 + worley(u, v, w, 16, 9) * 0.125;
        // Perlin-Worley: perlin remapped by the worley fbm (Schneider 2015).
        const pw = Math.min(1, Math.max(0, remap(perlin, wfbm - 1, 1, 0, 1)));
        shapeF[(z * S + y) * S + x] = pw;
      }
    }
    if (z % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  const shape = equalise(shapeF);
  const D = CLOUD_FIELD.detailRes;
  const detail = new Uint8Array(D * D * D);
  for (let z = 0; z < D; z++) {
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < D; x++) {
        const u = x / D;
        const v = y / D;
        const w = z / D;
        detail[(z * D + y) * D + x] = Math.round((worley(u, v, w, 4, 21) * 0.625 + worley(u, v, w, 8, 22) * 0.25 + worley(u, v, w, 16, 23) * 0.125) * 255);
      }
    }
  }
  const W = CLOUD_FIELD.weatherRes;
  const weatherF = new Float32Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / W;
      const n = valueNoise(u, v, 0.5, 6, 31) * 0.55 + valueNoise(u, v, 0.5, 14, 32) * 0.3 + valueNoise(u, v, 0.5, 30, 33) * 0.15;
      weatherF[y * W + x] = n;
    }
  }
  return { shape, detail, weather: equalise(weatherF) };
}

function sample3(data: Uint8Array, res: number, u: number, v: number, w: number): number {
  // Trilinear, wrapping — as the GPU's linear filter with repeat wrapping.
  const fu = (((u % 1) + 1) % 1) * res - 0.5;
  const fv = (((v % 1) + 1) % 1) * res - 0.5;
  const fw = (((w % 1) + 1) % 1) * res - 0.5;
  const i = Math.floor(fu);
  const j = Math.floor(fv);
  const k = Math.floor(fw);
  const a = fu - i;
  const b = fv - j;
  const c = fw - k;
  const wr = (t: number): number => ((t % res) + res) % res;
  const at = (di: number, dj: number, dk: number): number => data[(wr(k + dk) * res + wr(j + dj)) * res + wr(i + di)]! / 255;
  const x00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * a;
  const x10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * a;
  const x01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * a;
  const x11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * a;
  const y0 = x00 + (x10 - x00) * b;
  const y1 = x01 + (x11 - x01) * b;
  return y0 + (y1 - y0) * c;
}

function sample2(data: Uint8Array, res: number, u: number, v: number): number {
  const fu = (((u % 1) + 1) % 1) * res - 0.5;
  const fv = (((v % 1) + 1) % 1) * res - 0.5;
  const i = Math.floor(fu);
  const j = Math.floor(fv);
  const a = fu - i;
  const b = fv - j;
  const wr = (t: number): number => ((t % res) + res) % res;
  const at = (di: number, dj: number): number => data[wr(j + dj) * res + wr(i + di)]! / 255;
  return at(0, 0) + (at(1, 0) - at(0, 0)) * a + (at(0, 1) - at(0, 0)) * b + (at(0, 0) - at(1, 0) - at(0, 1) + at(1, 1)) * a * b;
}

/**
 * Coverage threshold at a point: the layer's coverage ±0.25 from the weather map (banks and clear
 * gaps), raised to 1.8 because a column is cloudy if any height in it is — measured: the fraction of
 * cloudy columns ≈ threshold^0.55 (tests/clouds.test.ts keeps it honest).
 */
export function localCoverage(layerCoverage: number, weather: number): number {
  const c = Math.min(1, Math.max(0, layerCoverage + (weather - 0.5) * 0.5));
  return c ** 1.8;
}

/**
 * Cloud density (extinction scale 0…1) at a world point — the GPU pass's
 * formula, term for term (render/clouds.ts). `windOffsetM` drifts the field.
 */
export function densityAt(data: CloudData, layer: CloudLayer, x: number, y: number, z: number, windOffsetX = 0, windOffsetZ = 0): number {
  if (y < layer.baseM || y > layer.topM) return 0;
  const hf = (y - layer.baseM) / (layer.topM - layer.baseM);
  // Rounded bottoms, anvil-ish tops.
  const profile = Math.min(1, hf / 0.12) * Math.min(1, (1 - hf) / 0.4);
  const px = x + windOffsetX;
  const pz = z + windOffsetZ;
  const cover = sample2(data.weather, CLOUD_FIELD.weatherRes, px / CLOUD_FIELD.weatherTileM, pz / CLOUD_FIELD.weatherTileM);
  const coverage = localCoverage(layer.coverage, cover);
  const shape = sample3(data.shape, CLOUD_FIELD.shapeRes, px / CLOUD_FIELD.shapeTileM, y / CLOUD_FIELD.shapeTileM, pz / CLOUD_FIELD.shapeTileM) * profile;
  const base = Math.max(0, (shape - (1 - coverage)) / Math.max(coverage, 1e-3));
  if (base <= 0) return 0;
  const det = sample3(data.detail, CLOUD_FIELD.detailRes, px / CLOUD_FIELD.detailTileM, y / CLOUD_FIELD.detailTileM, pz / CLOUD_FIELD.detailTileM);
  return Math.max(0, (base - det * 0.35) / (1 - det * 0.35));
}

/** Extinction per metre at density 1 (cumulus, roughly 0.05–0.1 m⁻¹). Shared with the renderer. */
export const CLOUD_EXTINCTION_PER_M = 0.06;

/**
 * Transmittance of the cloud along a straight line (the AI's eyes, IR seekers):
 * 1 = clear, 0 = hidden. Samples every ~150 m inside the layer only.
 */
export function lineTransmittance(data: CloudData, layer: CloudLayer, ax: number, ay: number, az: number, bx: number, by: number, bz: number, windOffsetX = 0, windOffsetZ = 0): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1) return 1;
  // Clip to the slab so long lines above or below the weather cost nothing.
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dy) < 1e-6) {
    if (ay < layer.baseM || ay > layer.topM) return 1;
  } else {
    const ta = (layer.baseM - ay) / dy;
    const tb = (layer.topM - ay) / dy;
    t0 = Math.max(0, Math.min(ta, tb));
    t1 = Math.min(1, Math.max(ta, tb));
    if (t1 <= t0) return 1;
  }
  const segM = (t1 - t0) * len;
  const n = Math.min(400, Math.max(2, Math.ceil(segM / 150)));
  let tau = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((i + 0.5) / n) * (t1 - t0);
    tau += densityAt(data, layer, ax + dx * t, ay + dy * t, az + dz * t, windOffsetX, windOffsetZ) * CLOUD_EXTINCTION_PER_M * (segM / n);
    if (tau > 12) return 0;
  }
  return Math.exp(-tau);
}
