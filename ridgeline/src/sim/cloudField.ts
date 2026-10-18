// Cloud field shared by the renderer and the game logic (rules §2.5: one
// source of truth). Two tileable noise volumes and a coverage map, baked once:
//
//   shape   64³, Perlin-Worley (Schneider, "The Real-Time Volumetric Cloudscapes
//           of Horizon Zero Dawn", SIGGRAPH 2015): billowy cells with fbm
//           detail, tiling every SHAPE_TILE_M;
//   billow  64³ beside it (the GPU's G channel), a Worley fbm two octaves
//           finer (cells of 1.1 km down to 280 m) that carves the shape into
//           domes: the bumps the light march sees, so a cloud's body shades
//           as heaped billows rather than one smooth slab;
//   detail  48³, Worley fbm, erodes the edges: sampled twice (the second
//           3.1× finer), its coordinates warped by the shape so the edges
//           curl, and inverted above the base — wispy undersides, billowy
//           tops (Schneider 2015, "high-frequency noise modifier");
//   weather 256², coverage 0…1 over WEATHER_TILE_M, so the sky has clear gaps
//           and denser banks;
//   kind    256², the cloud type 0…1 over the same tile: flat stratocumulus
//           whose tops stay low (0) to cumulus towering to the layer's top
//           (1), so one layer holds clouds of different heights.
//
// `densityAt` evaluates the same formula as the GPU pass from the same bytes,
// so "inside a cloud" means the same thing to the AI's eyes and to the player's.

export const CLOUD_FIELD = {
  shapeRes: 64,
  detailRes: 48,
  weatherRes: 256,
  shapeTileM: 9000,
  detailTileM: 1100,
  /** The second detail octave's frequency over the first. */
  detailFine: 3.1,
  /** How far the shape warps the detail's coordinates (m per unit of shape away from ½). */
  detailWarpM: 260,
  /**
   * Density gain after the erosion (clamped to 1): the coverage remap ramps density up over the shape
   * noise's own scale, a hundred metres or more — edges a dozen pixels soft from a few kilometres.
   * Cumulus have hard edges: the ramp is cut to a quarter, the inside saturates.
   */
  densityGain: 4,
  /** How deep the billows carve the shape (share of it lost in the grooves between cells). */
  billowDepth: 0.4,
  /**
   * How much the detail noise eats from a cloud's edge. At 0.4 the cells only frayed the rims; 0.5 cuts
   * the gaps between them deep enough that each reads as its own lobe while the coverage still keeps
   * within a few hundredths of the preset's (tests/clouds.test.ts).
   */
  detailErosion: 0.5,
  weatherTileM: 160_000,
} as const;

export interface CloudLayer {
  baseM: number;
  topM: number;
  coverage: number;
}

export interface CloudData {
  shape: Uint8Array;
  billow: Uint8Array;
  detail: Uint8Array;
  weather: Uint8Array;
  kind: Uint8Array;
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
  const billow = new Uint8Array(S * S * S);
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        const w = z / S;
        const perlin = valueNoise(u, v, w, 4, 1) * 0.5 + valueNoise(u, v, w, 8, 2) * 0.3 + valueNoise(u, v, w, 16, 3) * 0.2;
        const w8 = worley(u, v, w, 8, 8);
        const w16 = worley(u, v, w, 16, 9);
        const wfbm = worley(u, v, w, 4, 7) * 0.625 + w8 * 0.25 + w16 * 0.125;
        // Perlin-Worley: perlin remapped by the worley fbm (Schneider 2015).
        const pw = Math.min(1, Math.max(0, remap(perlin, wfbm - 1, 1, 0, 1)));
        shapeF[(z * S + y) * S + x] = pw;
        billow[(z * S + y) * S + x] = Math.round((w8 * 0.625 + w16 * 0.25 + worley(u, v, w, 32, 10) * 0.125) * 255);
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
  const kindF = new Float32Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / W;
      const n = valueNoise(u, v, 0.5, 6, 31) * 0.55 + valueNoise(u, v, 0.5, 14, 32) * 0.3 + valueNoise(u, v, 0.5, 30, 33) * 0.15;
      weatherF[y * W + x] = n;
      // Cloud type in bands a few tens of kilometres wide, finer patches inside.
      kindF[y * W + x] = valueNoise(u, v, 0.25, 9, 41) * 0.7 + valueNoise(u, v, 0.25, 23, 42) * 0.3;
    }
  }
  return { shape, billow, detail, weather: equalise(weatherF), kind: equalise(kindF) };
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
 * gaps), raised to 1.3 because a column is cloudy if any height in it is — re-fitted whenever the
 * profile, the billows or the erosion change (tests/clouds.test.ts keeps it honest).
 */
export function localCoverage(layerCoverage: number, weather: number): number {
  const c = Math.min(1, Math.max(0, layerCoverage + (weather - 0.5) * 0.5));
  return c ** 1.3;
}

/**
 * Relative top of a cloud of type `kind` (0 flat stratocumulus … 1 cumulus to the layer's top). An
 * overcast is a deck whatever the type: the spread closes as the coverage reaches 1.
 */
export function cloudTop(kind: number, coverage: number): number {
  // Biased towards cumulus (the square root): a layer of flat heaps read as pancakes from below.
  const k = Math.sqrt(kind);
  const c2 = coverage * coverage;
  return 0.35 + 0.65 * (k + (1 - k) * c2 * c2);
}

/**
 * Height profile at height fraction `hf` for a cloud whose top is at `topF`: flat, slightly rounded
 * bases, tops that taper over their upper half (towers narrow as they rise).
 */
export function heightProfile(hf: number, topF: number): number {
  return Math.min(1, hf / 0.08) * Math.min(1, Math.max(0, (topF - hf) / (topF * 0.5)));
}

/**
 * Cloud density (extinction scale 0…1) at a world point — the GPU pass's
 * formula, term for term (render/clouds.ts). `windOffsetM` drifts the field.
 */
export function densityAt(data: CloudData, layer: CloudLayer, x: number, y: number, z: number, windOffsetX = 0, windOffsetZ = 0): number {
  if (y < layer.baseM || y > layer.topM) return 0;
  const hf = (y - layer.baseM) / (layer.topM - layer.baseM);
  const px = x + windOffsetX;
  const pz = z + windOffsetZ;
  const wu = px / CLOUD_FIELD.weatherTileM;
  const wv = pz / CLOUD_FIELD.weatherTileM;
  const profile = heightProfile(hf, cloudTop(sample2(data.kind, CLOUD_FIELD.weatherRes, wu, wv), layer.coverage));
  if (profile <= 0) return 0;
  const coverage = localCoverage(layer.coverage, sample2(data.weather, CLOUD_FIELD.weatherRes, wu, wv));
  const su = px / CLOUD_FIELD.shapeTileM;
  const sv = y / CLOUD_FIELD.shapeTileM;
  const sw = pz / CLOUD_FIELD.shapeTileM;
  const raw = billowed(sample3(data.shape, CLOUD_FIELD.shapeRes, su, sv, sw), sample3(data.billow, CLOUD_FIELD.shapeRes, su, sv, sw), layer.coverage);
  const base = Math.max(0, (raw * profile - (1 - coverage)) / Math.max(coverage, 1e-3));
  if (base <= 0) return 0;
  return erode(data, base, raw, hf, px, y, pz, overcastSmoothing(layer.coverage));
}

/**
 * The shape carved by the billows: grooves between the Worley cells, domes on them. A remap, not a
 * product, so the shape's top values stay where they were and the coverage keeps its meaning.
 */
export function billowed(shape: number, billow: number, coverage: number): number {
  const cut = CLOUD_FIELD.billowDepth * (1 - billow) * overcastSmoothing(coverage);
  return Math.max(0, (shape - cut) / (1 - cut));
}

/**
 * How much of the billows and the edge erosion a layer keeps: all of it in broken cumulus, half in an
 * overcast, whose deck is a smoother sheet (and would otherwise be holed).
 */
export function overcastSmoothing(coverage: number): number {
  const c2 = coverage * coverage;
  return 1 - 0.6 * c2 * c2;
}

/** The detail erosion of a base density: `raw` is the shape before the profile, which warps the detail. */
function erode(data: CloudData, base: number, raw: number, hf: number, px: number, y: number, pz: number, smoothing: number): number {
  const warp = (raw - 0.5) * CLOUD_FIELD.detailWarpM;
  const dx = (px + warp) / CLOUD_FIELD.detailTileM;
  const dy = y / CLOUD_FIELD.detailTileM;
  const dz = (pz - warp) / CLOUD_FIELD.detailTileM;
  const k = CLOUD_FIELD.detailFine;
  const det = sample3(data.detail, CLOUD_FIELD.detailRes, dx, dy, dz) * 0.65 + sample3(data.detail, CLOUD_FIELD.detailRes, dx * k + 0.37, dy * k, dz * k + 0.71) * 0.35;
  // Wispy at the base (the cells eat holes), billowy above it (the gaps between cells are eaten).
  const t = Math.min(1, hf * 5);
  const mod = (det * (1 - t) + (1 - det) * t) * CLOUD_FIELD.detailErosion * smoothing;
  return Math.min(1, Math.max(0, (base - mod) / (1 - mod)) * CLOUD_FIELD.densityGain);
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
