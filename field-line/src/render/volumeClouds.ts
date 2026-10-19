import { Break, exp, float, Fn, hash, If, Loop, max, min, mix, positionWorld, pow, screenCoordinate, select, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { DataTexture, LinearFilter, Mesh, type Node, NodeMaterial, type Object3D, RedFormat, RepeatWrapping, RGBAFormat, RGFormat, UnsignedByteType, Vector2, Vector3 } from 'three/webgpu';

// Fair-weather cumulus as a volume, marched — Ridgeline's and Contrail's
// clouds (their render/clouds.ts and sim/cloudField.ts, docs/graphics-playbook
// §6v), brought down to the street. A layer drawn on the dome (the first try,
// relief-lit noise) read as grey plastic: no lobe had a sunlit side and a
// shaded one, no rim glowed, nothing had depth. Marched, each billow is lit by
// the light that really reaches it.
//
//   field   Perlin-Worley shape carved by Worley billows, eroded by a finer
//           Worley fbm warped by the shape (wisps under, cauliflower above),
//           over a coverage map with clear gaps and denser banks; baked once
//           at load (Schneider, "The Real-Time Volumetric Cloudscapes of
//           Horizon Zero Dawn", SIGGRAPH 2015);
//   march   at half resolution (a quarter on Low), steps growing with the
//           distance, refined to a third on entering a cloud, jittered per
//           frame for TRAA to average;
//   light   a short shadow march toward the sun with Wrenninge's multiple-
//           scattering octaves and a dual-lobe phase (the silver lining), Beer–
//           powder darkening of the thin rims away from the sun, the sky from
//           above through the cloud over the point, the ground's bounce on the
//           bases, and each lobe lit by the face the ray entered;
//   haze    far clouds fade into the sky drawn behind them;
//   shadow  the same field over the streets: the sun's ray through the slab,
//           a few shape samples, on every material that takes the sun's
//           shadow — the city goes into shade as a cloud passes over.
//
// Units: the scene's pre-exposed radiance, from the preset's sun and sky
// illuminance (Lighting.apply), as every other lit surface.

const EARTH_RADIUS_M = 6_360_000;
const MAX_MARCH_M = 60_000;
/** Distance over which the haze takes a cloud (m): the preset's visibility, roughly. */
const HAZE_M = 32_000;

const FIELD = {
  shapeRes: 64,
  detailRes: 48,
  weatherRes: 256,
  shapeTileM: 7000,
  detailTileM: 1100,
  /** The second detail octave's frequency over the first. */
  detailFine: 3.1,
  /** How far the shape warps the detail's coordinates (m per unit of shape away from ½). */
  detailWarpM: 260,
  /** Density gain after the erosion: cumulus have hard edges, so the coverage ramp is cut to a quarter. */
  densityGain: 3,
  /** How deep the billows carve the shape. */
  billowDepth: 0.4,
  /** How much the detail eats from a cloud's edge. */
  detailErosion: 0.5,
  weatherTileM: 160_000,
} as const;

/** Gain on the sun's multiple scattering (see the march). */
const SUN_GAIN = 1.8;

/** Extinction per metre at density 1 (cumulus, roughly 0.05–0.1 m⁻¹). */
const EXTINCTION_PER_M = 0.06;

export interface CloudQuality {
  /** Maximum view steps, and the step as a fraction of the distance (it grows with the pixel footprint). */
  steps: number;
  stepFraction: number;
  /** Shadow march towards the sun: steps, first step (m), growth per step. */
  lightSteps: number;
  lightStepM: number;
  lightGrowth: number;
  resolutionScale: number;
}

export const CLOUD_QUALITY: Record<'high' | 'low', CloudQuality> = {
  high: { steps: 80, stepFraction: 0.018, lightSteps: 5, lightStepM: 40, lightGrowth: 2.2, resolutionScale: 0.5 },
  low: { steps: 36, stepFraction: 0.04, lightSteps: 3, lightStepM: 80, lightGrowth: 3.4, resolutionScale: 0.25 },
};

type F = Node<'float'>;
type V3 = Node<'vec3'>;

// ------------------------------------------------------------------ the baked field

interface CloudData {
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

/** Tileable Worley F1, inverted (1 at the feature points), `cells` per period. */
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

/** Tileable value noise in 3-D, `cells` per period. */
function valueNoise(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells;
  const py = y * cells;
  const pz = z * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const s = (t: number): number => t * t * (3 - 2 * t);
  const fx = s(px - ix);
  const fy = s(py - iy);
  const fz = s(pz - iz);
  const w = (v: number): number => ((v % cells) + cells) % cells;
  const at = (a: number, b: number, c: number): number => hash3(w(ix + a), w(iy + b), w(iz + c), seed);
  const x00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * fx;
  const x10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * fx;
  const x01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * fx;
  const x11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Ranks spread evenly over 0…255, so "a fraction c of the field lies above 1 − c" holds for the coverage. */
function equalise(values: Float32Array): Uint8Array {
  const order = Array.from(values.keys()).sort((a, b) => (values[a] as number) - (values[b] as number));
  const out = new Uint8Array(values.length);
  for (let r = 0; r < order.length; r++) out[order[r] as number] = Math.round((r / (order.length - 1)) * 255);
  return out;
}

/** About a second of work, yielded every few slices so the loading screen keeps drawing. */
export async function bakeCloudField(): Promise<CloudData> {
  const S = FIELD.shapeRes;
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
        // Perlin-Worley: the fbm remapped by the Worley fbm (Schneider 2015).
        shapeF[(z * S + y) * S + x] = Math.min(1, Math.max(0, (perlin - (wfbm - 1)) / (2 - wfbm)));
        billow[(z * S + y) * S + x] = Math.round((w8 * 0.625 + w16 * 0.25 + worley(u, v, w, 32, 10) * 0.125) * 255);
      }
    }
    if (z % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  const D = FIELD.detailRes;
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
  const W = FIELD.weatherRes;
  const weatherF = new Float32Array(W * W);
  const kindF = new Float32Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / W;
      weatherF[y * W + x] = valueNoise(u, v, 0.5, 6, 31) * 0.55 + valueNoise(u, v, 0.5, 14, 32) * 0.3 + valueNoise(u, v, 0.5, 30, 33) * 0.15;
      // Cloud type in bands a few tens of kilometres wide: flat heaps (0) to cumulus towering to the top (1).
      kindF[y * W + x] = valueNoise(u, v, 0.25, 9, 41) * 0.7 + valueNoise(u, v, 0.25, 23, 42) * 0.3;
    }
  }
  return { shape: equalise(shapeF), billow, detail, weather: equalise(weatherF), kind: equalise(kindF) };
}

// ------------------------------------------------------------------ GPU side

/**
 * A tileable volume as a 2-D atlas of its z slices, each padded by one wrapped texel so bilinear filtering
 * never bleeds between tiles; sampled with two bilinear fetches and a lerp between slices.
 */
interface VolumeAtlas {
  tex: DataTexture;
  res: number;
  cols: number;
  rows: number;
}

function volumeAtlas(channels: Uint8Array[], res: number, cols: number): VolumeAtlas {
  const rows = Math.ceil(res / cols);
  const tile = res + 2;
  const W = cols * tile;
  const H = rows * tile;
  const n = channels.length;
  const out = new Uint8Array(W * H * n);
  const wrap = (i: number): number => (i + res) % res;
  for (let k = 0; k < res; k++) {
    const ox = (k % cols) * tile;
    const oy = Math.floor(k / cols) * tile;
    for (let j = 0; j < tile; j++) {
      for (let i = 0; i < tile; i++) {
        const src = (k * res + wrap(j - 1)) * res + wrap(i - 1);
        for (let c = 0; c < n; c++) out[((oy + j) * W + ox + i) * n + c] = (channels[c] as Uint8Array)[src] as number;
      }
    }
  }
  const tex = new DataTexture(out, W, H, n === 2 ? RGFormat : RedFormat, UnsignedByteType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.unpackAlignment = 1;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, res, cols, rows };
}

function sampleVolume(v: VolumeAtlas, uvw: V3): Node<'vec2'> {
  const tile = v.res + 2;
  const W = v.cols * tile;
  const H = v.rows * tile;
  const p = uvw.xy.fract().mul(v.res).add(1);
  const z = uvw.z.fract().mul(v.res).sub(0.5);
  const k0 = z.floor();
  const f = z.sub(k0);
  const slice = (k: F): Node<'vec2'> => {
    const kw = k.add(v.res).mod(v.res);
    const col = kw.mod(v.cols);
    const row = kw.div(v.cols).floor();
    // Explicit LOD: these fetches sit in loops and branches (non-uniform control flow in WGSL).
    return texture(v.tex, vec2(col.mul(tile).add(p.x).div(W), row.mul(tile).add(p.y).div(H))).level(float(0)).xy;
  };
  return mix(slice(k0), slice(k0.add(1)), f);
}

function hg(c: F, g: number): F {
  return float((1 - g * g) / (4 * Math.PI)).div(pow(float(1 + g * g).sub(c.mul(2 * g)), 1.5));
}

export class VolumeClouds {
  readonly base = uniform(1400);
  readonly top = uniform(3300);
  /** 0 … 1; 0 draws nothing (overcast and night presets keep the dome's own haze). */
  readonly coverage = uniform(0.35);
  /** Wind drift of the field (m). */
  readonly windOffset = uniform(new Vector2());
  readonly frame = uniform(0);
  readonly sunDir = uniform(new Vector3(0, 1, 0));
  /** Sun irradiance at normal incidence, per channel, pre-exposed. */
  readonly sunIrradiance = uniform(new Vector3());
  /** Mean sky radiance, per channel, pre-exposed. */
  readonly skyRadiance = uniform(new Vector3());
  readonly windVelocity = new Vector2(5.6, 2.1);
  private readonly shape: VolumeAtlas;
  private readonly detail: VolumeAtlas;
  private readonly weatherTex: DataTexture;

  constructor(
    data: CloudData,
    public quality: CloudQuality,
  ) {
    this.shape = volumeAtlas([data.shape, data.billow], FIELD.shapeRes, 8);
    this.detail = volumeAtlas([data.detail], FIELD.detailRes, 8);
    const W = FIELD.weatherRes;
    const rg = new Uint8Array(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      rg[i * 4] = data.weather[i] as number;
      rg[i * 4 + 1] = data.kind[i] as number;
    }
    const w = new DataTexture(rg, W, W, RGBAFormat, UnsignedByteType);
    w.minFilter = LinearFilter;
    w.magFilter = LinearFilter;
    w.wrapS = w.wrapT = RepeatWrapping;
    w.generateMipmaps = false;
    w.needsUpdate = true;
    this.weatherTex = w;
  }

  /** Per frame: the drift and the jitter index. */
  update(dtS: number): void {
    const o = this.windOffset.value;
    o.x = (o.x + this.windVelocity.x * dtS) % (FIELD.weatherTileM * 4);
    o.y = (o.y + this.windVelocity.y * dtS) % (FIELD.weatherTileM * 4);
    this.frame.value = (this.frame.value + 1) % 64;
  }

  /**
   * Density at flat-world x, z and true altitude h. `out.erosion` (with the detail): how much of the shape
   * the detail ate there, 0…1 — the folds between lobes.
   */
  private density(x: F, h: F, z: F, detail: boolean, out?: { erosion: F }): F {
    const hf = h.sub(this.base).div(this.top.sub(this.base));
    const px = x.add(this.windOffset.x);
    const pz = z.add(this.windOffset.y);
    const weather = texture(this.weatherTex, vec2(px, pz).div(FIELD.weatherTileM)).level(float(0));
    // The type's top, closing to the layer's top as the coverage reaches an overcast.
    const c2 = this.coverage.mul(this.coverage);
    const kind = weather.g.sqrt();
    const topF = kind.add(float(1).sub(kind).mul(c2).mul(c2)).mul(0.5).add(0.5);
    // Domes: the coverage threshold rises with height, so the cloud narrows as it climbs and only the densest
    // columns reach the type's top — towers with rounded crowns over flat bases. (A height profile multiplied
    // into the shape cut every cloud off at a third of the layer: flat slabs.)
    const rel = hf.div(topF).clamp(0, 1);
    const dome = smoothstep(0, 0.06, hf).mul(float(1).sub(rel.mul(rel)));
    const coverage = pow(this.coverage.add(weather.r.sub(0.5).mul(0.5)).clamp(0, 1), 1.3);
    const sb = sampleVolume(this.shape, vec3(px, h, pz).div(FIELD.shapeTileM));
    const smoothing = float(1).sub(c2.mul(c2).mul(0.6));
    const cut = sb.y.oneMinus().mul(FIELD.billowDepth).mul(smoothing);
    const raw = max(sb.x.sub(cut).div(float(1).sub(cut)), 0);
    const thr = float(1).sub(coverage.mul(dome));
    // Normalised over at least a quarter of the range: near the crowns 1 − thr is small, and dividing by it
    // turned every top into a hard plaster shell.
    const base = max(raw.sub(thr), 0).div(max(float(1).sub(thr), 0.25));
    // The light march skips the detail but keeps the gain, or light would reach deeper than the eye does.
    if (!detail) return base.mul(FIELD.densityGain).min(1);
    const warp = raw.sub(0.5).mul(FIELD.detailWarpM);
    const d = vec3(px.add(warp), h, pz.sub(warp)).div(FIELD.detailTileM);
    const det = sampleVolume(this.detail, d).x.mul(0.65).add(sampleVolume(this.detail, d.mul(FIELD.detailFine).add(vec3(0.37, 0, 0.71))).x.mul(0.35));
    // Wispy at the base (the cells eat holes), billowy above (the gaps between cells are eaten).
    const mod = mix(det, float(1).sub(det), hf.mul(5).clamp(0, 1)).mul(FIELD.detailErosion).mul(smoothing);
    if (out) out.erosion = mod.div(FIELD.detailErosion);
    return max(base.sub(mod).div(float(1).sub(mod)), 0).mul(FIELD.densityGain).min(1);
  }

  /** Altitude along a view ray: h(t) = y₀ + t·dy + t²(1 − dy²)/2R — the Earth curving away under the layer. */
  private curvature(dirY: F): F {
    return max(float(1).sub(dirY.mul(dirY)).div(2 * EARTH_RADIUS_M), 1e-12);
  }

  /** Roots of a·t² + b·t + c = 0 in the numerically stable form (a is tiny). */
  private roots(a: F, b: F, c: F): { lo: F; hi: F; hit: Node<'bool'> } {
    const disc = b.mul(b).sub(a.mul(c).mul(4));
    const sq = sqrt(max(disc, 0));
    const q = b.add(select(b.greaterThanEqual(0), sq, sq.negate())).mul(-0.5);
    const qSafe = select(q.abs().lessThan(1e-20), float(1e-20), q);
    const r1 = qSafe.div(a);
    const r2 = c.div(qSafe);
    return { lo: min(r1, r2), hi: max(r1, r2), hit: disc.greaterThan(0) };
  }

  /** Where a ray from the camera (height `camY` over the layer's datum) enters and leaves the slab, clipped to the march. */
  segment(camY: F, dir: V3): { start: F; end: F } {
    const a = this.curvature(dir.y);
    const t = this.roots(a, dir.y, camY.sub(this.top));
    const b = this.roots(a, dir.y, camY.sub(this.base));
    const tt1 = select(t.hit, t.lo, float(-1));
    const tt2 = select(t.hit, t.hi, float(-1));
    const tb2 = select(b.hit, b.hi, tt1);
    // From below (the street) the ray enters through the base and leaves through the top.
    const start = max(max(tb2, tt1), 0);
    return { start, end: min(tt2, float(MAX_MARCH_M)) };
  }

  /**
   * The reduced-resolution march: (in-scattered light, premultiplied and hazed; the transmittance left) for a
   * world view direction from the camera at `cam`. The scene's depth is not consulted: nothing in the
   * world reaches the layer, and a coarse texel straddling a roof would leave a halo of clear sky.
   */
  march(dir: V3, cam: V3): Node<'vec4'> {
    const q = this.quality;
    return Fn(() => {
      const seg = this.segment(cam.y, dir);
      const scatter = vec3(0).toVar();
      const T = float(1).toVar();
      const depthSum = float(0).toVar();
      const weightSum = float(0).toVar();
      // Interleaved gradient noise (Jimenez 2014), rotated each frame for TRAA to average, with white noise on top.
      const pix = screenCoordinate.xy.add(this.frame.mul(5.588238));
      const jitter = pix.x.mul(0.06711056).add(pix.y.mul(0.00583715)).fract().mul(52.9829189).fract().toVar();
      jitter.assign(jitter.add(hash(pix.x.add(pix.y.mul(1973.0)))).fract());
      If(seg.end.greaterThan(seg.start).and(this.coverage.greaterThan(0.01)), () => {
        const a = this.curvature(dir.y);
        const sun = this.sunDir;
        const cosSun = dir.dot(sun);
        // Dual-lobe phase per octave of Wrenninge's approximation (g halves each octave).
        const phases = [0, 1, 2, 3].map((k) => mix(hg(cosSun, 0.8 * 0.5 ** k), hg(cosSun, -0.25 * 0.5 ** k), 0.3));
        const sunColour = this.sunIrradiance;
        const skyUp = this.skyRadiance;
        // Light bounced off the ground into the bases (albedo ~0.15).
        const groundUp = sunColour.mul(max(sun.y, 0)).mul(0.15 / Math.PI);
        const sigma = float(EXTINCTION_PER_M);
        const stepOf = (t: F): F => t.mul(q.stepFraction).add(15).clamp(15, 1200);
        const t = seg.start.add(stepOf(seg.start).mul(jitter)).toVar();
        // Coarse steps through clear air; on the first hit, back up and go on at a third of the step.
        const fine = float(1).toVar();
        const prevDt = stepOf(seg.start).toVar();
        // How the sun meets the cloud's face where this ray entered it (1 until it does).
        const lobe = float(1).toVar();
        // Set on entering a cloud; the lobe is taken at the next sample inside.
        const needLobe = float(0).toVar();
        Loop(q.steps, () => {
          If(T.lessThan(0.01).or(t.greaterThan(seg.end)), () => {
            Break();
          });
          const dt = min(stepOf(t).mul(fine), seg.end.sub(t)).toVar();
          const px = cam.x.add(dir.x.mul(t));
          const pz = cam.z.add(dir.z.mul(t));
          const h = cam.y.add(dir.y.mul(t)).add(a.mul(t).mul(t));
          const eroded = { erosion: float(0) as F };
          const dens = this.density(px, h, pz, true, eroded).toVar();
          const fold = eroded.erosion.toVar();
          const firstHit = dens.greaterThan(0.001).and(fine.greaterThan(0.99));
          If(firstHit, () => {
            fine.assign(1 / 3);
            t.subAssign(prevDt.mul(0.75));
            dt.assign(0);
            needLobe.assign(1);
          }).ElseIf(dens.greaterThan(0.001), () => {
            If(needLobe.greaterThan(0.5), () => {
              needLobe.assign(0);
              // The face the ray entered, taken at the first fine step inside (within a third of a coarse step
              // of the surface — at the coarse hit itself, wherever the jitter put it, it flickered pixel to
              // pixel): its outward normal from the gradient of the full density, detail and all, once per
              // cloud, lit with a wrap. Each billow gets a bright side and a shaded one — the cauliflower. From
              // the shape alone the faces were the cloud's whole flank, smooth plaster; over 40 m the finest
              // detail made rough stone. 90 m is about how far light diffuses inside before it shows.
              const e = 90;
              const g = vec3(this.density(px.add(e), h, pz, true).sub(dens), this.density(px, h.add(e), pz, true).sub(dens), this.density(px, h, pz.add(e), true).sub(dens));
              const gl = g.length();
              const facing = g.negate().div(max(gl, 1e-4)).dot(sun).add(0.5).div(1.5).clamp(0, 1);
              lobe.assign(select(gl.greaterThan(1e-4), mix(float(0.4), float(1.4), facing), float(1)));
            });
            const sigmaT = dens.mul(sigma);
            // Light where the step's energy comes from: within one mean free path of its start.
            const back = min(dt.mul(0.5), float(1).div(sigmaT));
            const lx = px.sub(dir.x.mul(dt.mul(0.5).sub(back)));
            const lz = pz.sub(dir.z.mul(dt.mul(0.5).sub(back)));
            const lh = h.sub(dir.y.mul(dt.mul(0.5).sub(back)));
            const tauSun = float(0).toVar();
            let travelled = 0;
            for (let j = 0; j < q.lightSteps; j++) {
              const stepM = q.lightStepM * q.lightGrowth ** j;
              const along = travelled + stepM * 0.5;
              travelled += stepM;
              tauSun.addAssign(this.density(lx.add(sun.x.mul(along)), lh.add(sun.y.mul(along)), lz.add(sun.z.mul(along)), false).mul(stepM));
            }
            // Half the view's extinction toward the sun: with the edge gain the cores saturate, and at full
            // extinction the light died in the first tens of metres and every cloud went grey.
            tauSun.mulAssign(sigma.mul(0.5));
            let ms: F = float(0);
            for (let k = 0; k < 4; k++) ms = ms.add(exp(tauSun.mul(-(0.3 ** k))).mul(phases[k] as F).mul(0.6 ** k));
            const hf = lh.sub(this.base).div(this.top.sub(this.base)).clamp(0, 1);
            // Sky light from above through the cloud over the point (the local density standing in for up
            // to 250 m of the column): grey bases and folds, white tops.
            const upM = min(this.top.sub(lh), float(250)).max(0);
            const skyVis = exp(dens.mul(upM).mul(EXTINCTION_PER_M * 0.25).negate());
            const ambient = skyUp.mul(mix(float(0.6), float(1.4), hf)).mul(mix(float(0.45), float(1), skyVis)).add(groundUp.mul(float(1).sub(hf)));
            // Beer–powder (Schneider 2015): thin rims darker away from the sun, so every billow outlines itself.
            const powder = float(1).sub(exp(sigmaT.mul(-140)).mul(0.6));
            const powderK = mix(powder, float(1), cosSun.mul(0.5).add(0.5).pow(2));
            // The folds between lobes lie in their neighbours' shadow (the light march sees only the shape).
            const folds = float(1).sub(fold.mul(0.55).mul(float(1).sub(smoothstep(0.2, 0.85, cosSun))));
            // SUN_GAIN: the octaves' phases are mostly forward lobes, so a face lit from the side came out a third
            // as bright as white card; a thick cloud's lit face is nearly a white diffuser.
            const S = sunColour.mul(ms.mul(SUN_GAIN)).mul(powderK).mul(folds).mul(lobe).add(ambient.mul(folds.mul(0.4).add(0.6))).mul(sigmaT);
            const stepT = exp(sigmaT.mul(dt).negate());
            // Integrate S·T over the step analytically (Hillaire 2016).
            scatter.addAssign(T.mul(S.sub(S.mul(stepT)).div(sigmaT)));
            const w = T.sub(T.mul(stepT));
            depthSum.addAssign(t.mul(w));
            weightSum.addAssign(w);
            T.mulAssign(stepT);
          }).Else(() => {
            fine.assign(min(fine.mul(1.3), 1));
          });
          prevDt.assign(dt.max(1));
          t.addAssign(dt);
        });
      });
      // Haze: the cloud dissolves into the sky behind it with distance — its opacity fades, so the composite
      // shows the real dome there, whatever its colour toward the sun or away.
      const opacity = float(1).sub(T);
      const depth = depthSum.div(max(weightSum, 1e-6));
      const clear = exp(depth.div(-HAZE_M));
      return vec4(scatter.mul(clear), float(1).sub(opacity.mul(clear)));
    })();
  }

  /**
   * The cloud's shadow on everything under `root` that receives the sun's (the sun light only): call once the
   * world is built, before the shaders compile. Materials added later go without.
   */
  shadeReceivers(root: Object3D, samples: number): void {
    // Built inside the callback: the shadow node calls it while the material's shader is being built.
    const fn = ((shadow: Node<'vec4'>) => shadow.mul(this.sunShadow(samples))) as unknown as () => Node;
    root.traverse((o) => {
      if (!(o instanceof Mesh) || !o.receiveShadow) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m instanceof NodeMaterial) m.receivedShadowNode = fn;
    });
  }

  /** Sunlight left after the slab along the sun's ray from the shaded point (flat: the map is a few kilometres). */
  private sunShadow(samples: number): F {
    const p = positionWorld;
    const sun = this.sunDir;
    const sy = max(sun.y, 0.05);
    const tIn = max(this.base.sub(p.y), 0).div(sy);
    const len = this.top.sub(this.base).div(sy);
    const tau = float(0).toVar();
    for (let k = 0; k < samples; k++) {
      const t = tIn.add(len.mul((k + 0.5) / samples));
      tau.addAssign(this.density(p.x.add(sun.x.mul(t)), p.y.add(sun.y.mul(t)), p.z.add(sun.z.mul(t)), false));
    }
    // Beer at half the extinction (forward scattering lets light through the thin edges), with a floor: under a
    // cumulus the street still has the sky's light and some of the sun's.
    const lit = exp(tau.mul(len.div(samples)).mul(EXTINCTION_PER_M * 0.5).negate()).mul(0.88).add(0.12);
    return select(this.coverage.greaterThan(0.01), lit, float(1));
  }

  /** Full resolution: the march over the scene, only where the scene lies beyond the layer's entry (the sky). */
  composite(scene: V3, cloud: Node<'vec4'>, dir: V3, cam: V3, distanceM: F): V3 {
    const seg = this.segment(cam.y, dir);
    const behind = distanceM.greaterThan(seg.start).and(seg.end.greaterThan(seg.start));
    return select(behind, scene.mul(cloud.a).add(cloud.rgb), scene);
  }
}
