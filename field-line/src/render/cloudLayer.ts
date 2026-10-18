import { cameraPosition, dot, exp, float, Fn, fwidth, If, length, log2, max, mix, normalize, pow, positionWorld, smoothstep, texture, time, uniform, vec2, vec3 } from 'three/tsl';
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, type Node, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector3 } from 'three/webgpu';
import { tileFbm } from '../core/noise.ts';

// Fair-weather cumulus over the city and the forest, in place of three's
// SkyMesh clouds — four octaves of gradient noise lit by their own local
// density, which read as soft smears however the numbers were set. Still a
// layer, not a volume (the sky pixel can afford a dozen fetches, not a march),
// but shaped and lit like the real thing:
//
//   - shape: where a low-frequency field rises over the preset's coverage,
//     carved by inverted Worley cells into rounded lobes, its rims frayed by
//     finer noise (Schneider's erosion, "The Real-Time Volumetric Cloudscapes
//     of Horizon Zero Dawn", SIGGRAPH 2015) — the cauliflower edge;
//   - relief: the result taken as the cloud's thickness, a dome ~900 m tall,
//     whose slope gives each lobe a surface to light: seen near the zenith,
//     the flat base; toward the horizon, the sides, lit on the sun's side;
//   - light: the sun through the cloud toward it (three samples of the
//     thickness along the sun's bearing), Henyey–Greenstein forward
//     scattering in the thin rims (the silver lining), a diffuse glow from
//     multiple scattering, the sky's own light from above and the ground's
//     bounce on the bases;
//   - distance: detail fades as a pixel covers more of the layer (explicit
//     mip levels from the footprint, so it cannot shimmer), and far clouds
//     dissolve into the sky behind them.
//
// All radiance in the scene's pre-exposed units, set per preset by
// Lighting.apply from the same sun and sky illuminance as everything else.

const SIZE = 256;
/** Height of the cloud bases over the camera (m): fair-weather cumulus. */
const BASE_M = 1500;
/** One repeat of the noise texture at the coarsest scale (m): clouds ~1–2 km across, gaps between them. */
const TILE_M = 9000;
/** How tall the thickest cloud stands (m), for the slope of its lobes. */
const THICK_M = 900;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable Worley: distance to the nearest feature point, in cell sizes (0 at a point, ~1 at the borders). */
function worley(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const wrap = (i: number): number => ((i % cells) + cells) % cells;
  let best = 9;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const cx = ix + di;
      const cy = iy + dj;
      const fx = cx + hash(wrap(cx), wrap(cy), seed);
      const fy = cy + hash(wrap(cx), wrap(cy), seed + 1);
      best = Math.min(best, Math.hypot(x - fx, y - fy));
    }
  }
  return Math.min(1, best);
}

/** Ranks spread evenly over 0…1, so a coverage c leaves a fraction c of the field above 1 − c. */
function equalise(values: Float32Array): Float32Array {
  const order = Array.from(values.keys()).sort((a, b) => (values[a] as number) - (values[b] as number));
  const out = new Float32Array(values.length);
  order.forEach((idx, r) => (out[idx] = r / (order.length - 1)));
  return out;
}

/**
 * R: where clouds stand (fbm rounded by large cells, equalised); G: billows (inverted Worley, three
 * octaves); B: fine detail (fbm). Tileable, 256².
 */
function bakeNoise(): DataTexture {
  const n = SIZE * SIZE;
  const place = new Float32Array(n);
  const data = new Uint8Array(n * 4);
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const u = i / SIZE;
      const v = j / SIZE;
      const k = j * SIZE + i;
      place[k] = tileFbm(u * 4, v * 4, 4, 5, 501) * 0.7 + (1 - worley(u, v, 5, 503)) * 0.3;
      const billow = 1 - (worley(u, v, 8, 507) * 0.6 + worley(u, v, 16, 509) * 0.28 + worley(u, v, 32, 511) * 0.12);
      data[k * 4 + 1] = Math.round(Math.min(1, Math.max(0, billow)) * 255);
      data[k * 4 + 2] = Math.round(Math.min(1, tileFbm(u * 16, v * 16, 16, 3, 513) * 1.15) * 255);
      data[k * 4 + 3] = 255;
    }
  }
  const eq = equalise(place);
  for (let k = 0; k < n; k++) data[k * 4] = Math.round((eq[k] as number) * 255);
  const t = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

export class CloudLayer {
  /** 0 while the sky's raw radiance is measured (Lighting.measureSkyIrradiance): the layer is in scene units. */
  readonly enabled = uniform(1);
  readonly coverage = uniform(0.25);
  /** Sun irradiance at normal incidence, per channel, pre-exposed. */
  readonly sunIrradiance = uniform(new Vector3());
  /** Mean sky radiance, per channel, pre-exposed. */
  readonly skyRadiance = uniform(new Vector3());
  private readonly noise = bakeNoise();

  constructor(private readonly sunDir: Node<'vec3'>) {}

  /** Cloud thickness 0…1 at a point of the layer (m), the coarsest map read at mip `lod`. */
  private thickness(q: V2, lod: F): F {
    const w = q.div(TILE_M);
    const cov = this.coverage;
    const place = texture(this.noise, w).level(lod).r;
    // Explicit levels: these fetches sit inside a branch (non-uniform control flow), and the finer maps
    // repeat 4× and 16× as often, so they reach their coarse mips two and four levels sooner.
    const billow = texture(this.noise, w.mul(4).add(vec2(0.37, 0.11))).level(lod.add(2)).g;
    const detail = texture(this.noise, w.mul(16).add(vec2(0.71, 0.53))).level(lod.add(4)).b;
    const base = place.sub(float(1).sub(cov)).div(max(cov, 1e-3)).clamp(0, 1);
    // The billows carve the grooves between lobes; the detail frays only the thin rims.
    const cut = float(1).sub(billow).mul(0.55);
    const shape = base.sub(cut).div(float(1).sub(cut)).clamp(0, 1);
    const fray = detail.mul(0.3).mul(float(1).sub(shape));
    return shape.sub(fray).div(float(1).sub(fray)).clamp(0, 1);
  }

  /** `sky` (the dome's colour, scene units) with the cloud layer over it. */
  over(sky: V3): V3 {
    return Fn(() => {
      const dir = normalize(positionWorld.sub(cameraPosition));
      const dy = max(dir.y, 0.015);
      const t = float(BASE_M).div(dy);
      // Wind drift ~6 m/s from the west-south-west.
      const q = cameraPosition.xz.add(dir.xz.mul(t)).add(vec2(time.mul(5.6), time.mul(2.1)));
      // Metres of the layer per pixel, for the mip level (outside the branch: derivatives need uniform flow).
      const footprint = max(length(fwidth(q)), 1);
      const lod = max(log2(footprint.div(TILE_M / SIZE)), 0);
      const out = vec3(sky).toVar();
      If(dir.y.greaterThan(0.01).and(this.enabled.mul(this.coverage).greaterThan(0)), () => {
        const h0 = this.thickness(q, lod);
        If(h0.greaterThan(0.002), () => {
          // Relief: the thickness as a dome THICK_M tall; its slope over a couple of pixels (no finer).
          const eps = max(footprint.mul(1.5), 35);
          const hx = this.thickness(q.add(vec2(eps, 0)), lod);
          const hz = this.thickness(q.add(vec2(0, eps)), lod);
          const grad = vec2(hx.sub(h0), hz.sub(h0)).div(eps).mul(THICK_M);
          const domeN = normalize(vec3(grad.x.negate(), 1, grad.y.negate()));
          // Overhead the flat base faces down; toward the horizon the sides face the eye.
          const side = float(1).sub(smoothstep(0.06, 0.45, dir.y));
          const n = normalize(mix(vec3(0, -1, 0), domeN.add(dir.negate().mul(0.6)), side));
          // Sunlight through the cloud toward the sun: the thickness along its bearing.
          const sun = this.sunDir;
          const bearing = normalize(sun.xz.add(vec2(1e-4, 0)));
          const h1 = this.thickness(q.add(bearing.mul(260)), lod);
          const h2 = this.thickness(q.add(bearing.mul(650)), lod);
          const lit = exp(h0.mul(0.6).add(h1).add(h2.mul(0.6)).mul(-2.2));
          const cosT = dot(dir, sun);
          // Henyey–Greenstein, g = 0.6: the forward lobe that makes thin rims glow toward the sun.
          const hg = float(0.64 / (4 * Math.PI)).div(pow(float(1.36).sub(cosT.mul(1.2)), 1.5));
          const E = this.sunIrradiance;
          const direct = E.mul(max(dot(n, sun), 0).mul(0.9 / Math.PI)).mul(lit);
          const through = E.mul(hg).mul(exp(h0.mul(-3))).mul(float(1).sub(exp(h0.mul(-7)))).mul(2.2);
          const glow = E.mul(0.05).mul(exp(h0.mul(-1.2))).mul(lit.mul(0.6).add(0.4));
          const ambient = this.skyRadiance.mul(0.9).mul(mix(float(0.5), float(1.05), n.y.mul(0.5).add(0.5)));
          const bounce = this.skyRadiance.mul(0.3).mul(float(1).sub(side)).mul(sun.y.max(0));
          const cloud = direct.add(through).add(glow).add(ambient).add(bounce);
          // Far clouds dissolve into the sky behind them; thin ones show it through.
          const hazed = mix(out, cloud, exp(t.div(-38000)));
          const alpha = float(1).sub(exp(h0.mul(-9))).mul(smoothstep(0.01, 0.06, dir.y));
          out.assign(mix(out, hazed, alpha));
        });
      });
      return out;
    })() as unknown as V3;
  }
}
