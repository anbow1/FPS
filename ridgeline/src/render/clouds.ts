import { Break, cameraPosition, exp, float, Fn, hash, If, Loop, max, min, mix, positionWorld, pow, screenCoordinate, select, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { DataTexture, LinearFilter, Mesh, type Node, NodeMaterial, type Object3D, RedFormat, RepeatWrapping, RGBAFormat, RGFormat, UnsignedByteType, Vector2, Vector3 } from 'three/webgpu';
import { CLOUD_EXTINCTION_PER_M, CLOUD_FIELD, type CloudData, type CloudLayer, densityAt } from '../sim/cloudField.ts';
import type { Atmosphere } from './atmosphere.ts';

// Volumetric cloud layer (brief: "volumetric clouds that hide the aircraft from
// the AI's eyes"). A ray march through the slab between the preset's base and
// top, at reduced resolution inside the post chain (rtt at ½ on High, ⅓ on
// Low), composited over the hazed scene before TRAA, which also averages the
// per-frame jitter of the march start. Density is cloudField.ts's formula from
// the same bytes, so what the player sees is what the AI cannot see through.
//
// Lighting, all in the atmosphere's pre-exposed units:
//   sun     the atmosphere's transmittance to the layer's middle (white at noon,
//           red at dusk), a 6-step shadow march towards the sun, and Wrenninge's
//           multiple-scattering octaves (Wrenninge et al., "Oz: The Great and
//           Volumetric", SIGGRAPH 2013 talk) with a dual-lobe Henyey–Greenstein
//           phase — the silver lining towards the sun, flat backlit grey away;
//   ambient the sky-view LUT at the zenith, stronger at the tops;
//   steps   Hillaire's energy-conserving integration (SIGGRAPH 2016 course);
//   haze    each pixel's cloud is treated as a surface at its transmittance-
//           weighted depth and passed through the aerial perspective.
//
// The layer follows the Earth's curvature exactly as the terrain does: a sample
// at horizontal distance d from the camera sits d²/2R lower on screen, so the
// overcast meets the horizon instead of running flat to infinity.

const EARTH_RADIUS_M = 6_360_000;
/** Pixels nearer than this take the cloud as uniform fog at the camera's density (the aircraft inside a cloud). */
export const CLOUD_NEAR_M = 300;
const MAX_MARCH_M = 120_000;

type F = Node<'float'>;
type V3 = Node<'vec3'>;

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
  high: { steps: 96, stepFraction: 0.015, lightSteps: 6, lightStepM: 30, lightGrowth: 2, resolutionScale: 0.5 },
  // Low runs at 2× on phones: a quarter-scale buffer keeps its cost near the old third-scale one at 1×.
  low: { steps: 40, stepFraction: 0.035, lightSteps: 3, lightStepM: 80, lightGrowth: 3.4, resolutionScale: 0.25 },
};

/**
 * A tileable volume as a 2-D atlas of its z slices, each padded by one wrapped texel so bilinear
 * filtering never bleeds between tiles. Sampled with two bilinear fetches and a lerp between slices —
 * exactly the trilinear, wrapping lookup of cloudField.ts's `sample3`. (Data3DTexture would save a
 * fetch, but three r186's WebGPU backend binds it through a 2-D view from an rtt pass.)
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
        for (let c = 0; c < n; c++) out[((oy + j) * W + ox + i) * n + c] = channels[c]![src]!;
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
  // Texel coordinates inside a padded tile (texel i's centre at i + 1.5).
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

export class Clouds {
  readonly base = uniform(1600);
  readonly top = uniform(3400);
  readonly coverage = uniform(0.55);
  /** Wind drift of the field (m), shared with `densityAt` for the game logic. */
  readonly windOffset = uniform(new Vector2());
  readonly frame = uniform(0);
  /** Cloud density at the camera (CPU, from cloudField.ts): fog for the nearest pixels. */
  readonly cameraDensity = uniform(0);
  readonly windVelocity = new Vector2(9, 3);
  readonly layer: CloudLayer = { baseM: 1600, topM: 3400, coverage: 0.55 };
  private readonly shape: VolumeAtlas;
  private readonly detail: VolumeAtlas;
  private readonly weatherTex: DataTexture;

  constructor(
    readonly data: CloudData,
    private readonly atmosphere: Atmosphere,
    public quality: CloudQuality,
  ) {
    this.shape = volumeAtlas([data.shape, data.billow], CLOUD_FIELD.shapeRes, 8);
    this.detail = volumeAtlas([data.detail], CLOUD_FIELD.detailRes, 8);
    // R coverage, G cloud type: one binding for both (every shadow receiver samples it).
    const W = CLOUD_FIELD.weatherRes;
    const rg = new Uint8Array(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      rg[i * 4] = data.weather[i]!;
      rg[i * 4 + 1] = data.kind[i]!;
    }
    const w = new DataTexture(rg, W, W, RGBAFormat, UnsignedByteType);
    w.minFilter = LinearFilter;
    w.magFilter = LinearFilter;
    w.wrapS = w.wrapT = RepeatWrapping;
    w.unpackAlignment = 1;
    w.generateMipmaps = false;
    w.needsUpdate = true;
    this.weatherTex = w;
  }

  setLayer(layer: CloudLayer): void {
    Object.assign(this.layer, layer);
    this.base.value = layer.baseM;
    this.top.value = layer.topM;
    this.coverage.value = layer.coverage;
  }

  /** Per frame: drift, the jitter index, the density around the camera. */
  update(dtS: number, camera: Vector3, temporal: boolean): void {
    const o = this.windOffset.value;
    o.x = (o.x + this.windVelocity.x * dtS) % (CLOUD_FIELD.weatherTileM * 4);
    o.y = (o.y + this.windVelocity.y * dtS) % (CLOUD_FIELD.weatherTileM * 4);
    this.frame.value = temporal ? (this.frame.value + 1) % 64 : 0;
    this.cameraDensity.value = this.densityAt(camera.x, camera.y, camera.z);
  }

  /** The game logic's view of the same field (AI eyes, seekers, the camera fog). */
  densityAt(x: number, y: number, z: number): number {
    const o = this.windOffset.value;
    return densityAt(this.data, this.layer, x, y, z, o.x, o.y);
  }

  // ---- shader side

  /**
   * Density at a point given as flat-world x, z and true altitude h — cloudField.densityAt, term for term.
   * `out.erosion` (with the detail): how much of the shape the detail ate there, 0…1 — the folds between lobes.
   */
  private density(x: F, h: F, z: F, detail: boolean, out?: { erosion: F }): F {
    const hf = h.sub(this.base).div(this.top.sub(this.base));
    const px = x.add(this.windOffset.x);
    const pz = z.add(this.windOffset.y);
    const weather = texture(this.weatherTex, vec2(px, pz).div(CLOUD_FIELD.weatherTileM)).level(float(0));
    // cloudTop: the type's top, closing to the layer's top as the coverage reaches an overcast.
    const c2 = this.coverage.mul(this.coverage);
    const kind = weather.g.sqrt();
    const topF = kind.add(float(1).sub(kind).mul(c2).mul(c2)).mul(0.65).add(0.35);
    const profile = min(hf.div(0.08), 1).mul(topF.sub(hf).div(topF.mul(0.5)).clamp(0, 1)).max(0);
    const coverage = pow(this.coverage.add(weather.r.sub(0.5).mul(0.5)).clamp(0, 1), 1.3);
    // Shape and billows in one fetch (R, G): cloudField.billowed.
    const sb = sampleVolume(this.shape, vec3(px, h, pz).div(CLOUD_FIELD.shapeTileM));
    // cloudField.overcastSmoothing: billows and erosion fade as the layer closes into a deck.
    const smoothing = float(1).sub(c2.mul(c2).mul(0.6));
    const cut = sb.y.oneMinus().mul(CLOUD_FIELD.billowDepth).mul(smoothing);
    const raw = max(sb.x.sub(cut).div(float(1).sub(cut)), 0);
    const base = max(raw.mul(profile).sub(float(1).sub(coverage)).div(max(coverage, 1e-3)), 0);
    // The light march and the ground shadows skip the detail but keep the gain, or light would reach
    // four times deeper into a cloud than the eye does.
    if (!detail) return base.mul(CLOUD_FIELD.densityGain).min(1);
    // Detail warped by the shape, two octaves, wispy at the base and billowy above (cloudField.erode).
    const warp = raw.sub(0.5).mul(CLOUD_FIELD.detailWarpM);
    const d = vec3(px.add(warp), h, pz.sub(warp)).div(CLOUD_FIELD.detailTileM);
    const k = CLOUD_FIELD.detailFine;
    const det = sampleVolume(this.detail, d).x.mul(0.65).add(sampleVolume(this.detail, d.mul(k).add(vec3(0.37, 0, 0.71))).x.mul(0.35));
    const mod = mix(det, float(1).sub(det), hf.mul(5).clamp(0, 1)).mul(CLOUD_FIELD.detailErosion).mul(smoothing);
    if (out) out.erosion = mod.div(CLOUD_FIELD.detailErosion);
    return max(base.sub(mod).div(float(1).sub(mod)), 0).mul(CLOUD_FIELD.densityGain).min(1);
  }

  /** Altitude along a view ray: h(t) = y₀ + t·dy + t²(1 − dy²)/2R (the terrain's curvature drop, inverted). */
  private curvature(dirY: F): F {
    return max(float(1).sub(dirY.mul(dirY)).div(2 * EARTH_RADIUS_M), 1e-12);
  }

  /** Roots of a·t² + b·t + c = 0 in the numerically stable form (a is tiny: ~1e-7). */
  private roots(a: F, b: F, c: F): { lo: F; hi: F; hit: Node<'bool'> } {
    const disc = b.mul(b).sub(a.mul(c).mul(4));
    const sq = sqrt(max(disc, 0));
    const q = b.add(select(b.greaterThanEqual(0), sq, sq.negate())).mul(-0.5);
    const qSafe = select(q.abs().lessThan(1e-20), float(1e-20), q);
    const r1 = qSafe.div(a);
    const r2 = c.div(qSafe);
    return { lo: min(r1, r2), hi: max(r1, r2), hit: disc.greaterThan(0) };
  }

  /**
   * The first stretch of the ray inside the layer, as (start, end) along the ray, clipped to [0, limit]:
   * {h ≤ top} is one interval (h is convex in t), {h < base} is cut out of it, leaving up to two.
   */
  segment(camY: F, dir: V3, limit: F): { start: F; end: F } {
    const a = this.curvature(dir.y);
    const t = this.roots(a, dir.y, camY.sub(this.top));
    const b = this.roots(a, dir.y, camY.sub(this.base));
    const tt1 = select(t.hit, t.lo, float(-1));
    const tt2 = select(t.hit, t.hi, float(-1));
    const tb1 = select(b.hit, b.lo, tt1);
    const tb2 = select(b.hit, b.hi, tt1);
    const s1 = max(tt1, 0);
    const e1 = min(min(tb1, tt2), limit);
    const s2 = max(max(tb2, tt1), 0);
    const e2 = min(tt2, limit);
    const first = e1.greaterThan(s1);
    return { start: select(first, s1, s2), end: select(first, e1, e2) };
  }

  /**
   * The low-resolution march: (in-scattered light with haze, transmittance) for a world view direction
   * and the distance to the scene surface behind it.
   */
  march(dir: V3, sceneDistanceM: F, uv: Node<'vec2'>): Node<'vec4'> {
    const q = this.quality;
    return Fn(() => {
      const cam = this.atmosphere.cameraWorld;
      // Surfaces nearer than CLOUD_NEAR_M (the aircraft) do not stop the march: the full-resolution
      // composite handles them, so their silhouettes don't punch low-resolution holes in the cloud.
      const limit = select(sceneDistanceM.lessThan(CLOUD_NEAR_M), float(MAX_MARCH_M), min(sceneDistanceM, MAX_MARCH_M));
      const seg = this.segment(cam.y, dir, limit);
      const scatter = vec3(0).toVar();
      const T = float(1).toVar();
      const depthSum = float(0).toVar();
      const weightSum = float(0).toVar();
      // Interleaved gradient noise (Jimenez 2014), rotated each frame for TRAA to average.
      const pix = screenCoordinate.xy.add(this.frame.mul(5.588238));
      const jitter = pix.x.mul(0.06711056).add(pix.y.mul(0.00583715)).fract().mul(52.9829189).fract().toVar();
      // Per-pixel white noise added to it, so a frame TRAA could not accumulate (fast motion)
      // shows grain rather than IGN's diagonal stripes.
      jitter.assign(jitter.add(hash(pix.x.add(pix.y.mul(1973.0)))).fract());
      If(seg.end.greaterThan(seg.start), () => {
        const a = this.curvature(dir.y);
        const cosSun = dir.dot(this.atmosphere.sunDir);
        // Dual-lobe phase per octave of Wrenninge's approximation (g halves each octave).
        const phases = [0, 1, 2, 3].map((k) => mix(hg(cosSun, 0.8 * 0.5 ** k), hg(cosSun, -0.25 * 0.5 ** k), 0.3));
        const mid = this.base.add(this.top).mul(0.5);
        const sunColour = this.atmosphere.transmittanceTo(float(EARTH_RADIUS_M).add(mid), this.atmosphere.sunDir.y).mul(this.atmosphere.sunIlluminance);
        const skyUp = this.atmosphere.skyOnly(vec3(0, 1, 0));
        // Light bounced off the ground into the cloud bases (albedo ~0.15).
        const groundUp = sunColour.mul(max(this.atmosphere.sunDir.y, 0)).mul(0.15 / Math.PI);
        const sigma = float(CLOUD_EXTINCTION_PER_M);
        const sun = this.atmosphere.sunDir;
        // Steps grow with distance (a pixel's footprint does): 1.5 % of the range, 15 m to 1.5 km.
        const stepOf = (t: F): F => t.mul(q.stepFraction).add(15).clamp(15, 1500);
        const t = seg.start.add(stepOf(seg.start).mul(jitter)).toVar();
        // Coarse steps through empty air; on the first hit, back up and continue at a third of the
        // step, easing back out after the cloud — the edges are where coarse steps show as grain lines.
        const fine = float(1).toVar();
        const prevDt = stepOf(seg.start).toVar();
        // How the sun meets the cloud's surface where this ray entered it (1 until it does): see firstHit.
        const lobe = float(1).toVar();
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
            // The surface the ray just entered: its outward normal from the shape's gradient (shape only, 60 m,
            // once per cloud entered — not per step), lit by the sun with a wrap. Each lobe then has a bright
            // side and a shaded one; lit by the march alone the interior was uniform and the clouds flat slabs.
            const e = 60;
            const d0 = this.density(px, h, pz, false);
            const g = vec3(this.density(px.add(e), h, pz, false).sub(d0), this.density(px, h.add(e), pz, false).sub(d0), this.density(px, h, pz.add(e), false).sub(d0));
            const gl = g.length();
            const facing = g.negate().div(max(gl, 1e-4)).dot(sun).add(0.4).div(1.4).clamp(0, 1);
            lobe.assign(select(gl.greaterThan(1e-4), mix(float(0.35), float(1.3), facing), float(1)));
          }).ElseIf(dens.greaterThan(0.001), () => {
            const sigmaT = dens.mul(sigma);
            // Light where the step's energy comes from: within one mean free path of its start, not
            // at its middle (a 300 m step into a cloud would otherwise be lit from deep inside).
            const back = min(dt.mul(0.5), float(1).div(sigmaT));
            const lx = px.sub(dir.x.mul(dt.mul(0.5).sub(back)));
            const lz = pz.sub(dir.z.mul(dt.mul(0.5).sub(back)));
            const lh = h.sub(dir.y.mul(dt.mul(0.5).sub(back)));
            // Optical depth towards the sun, shape only, geometric steps.
            const tauSun = float(0).toVar();
            let travelled = 0;
            for (let j = 0; j < q.lightSteps; j++) {
              const stepM = q.lightStepM * q.lightGrowth ** j;
              const along = travelled + stepM * 0.5;
              travelled += stepM;
              tauSun.addAssign(this.density(lx.add(sun.x.mul(along)), lh.add(sun.y.mul(along)), lz.add(sun.z.mul(along)), false).mul(stepM));
            }
            // Half the view's extinction towards the sun: with the edge gain the cores saturate, and at
            // full extinction the light died in the first tens of metres and every cloud went grey.
            tauSun.mulAssign(sigma.mul(0.5));
            // Wrenninge octaves: a = 0.6, b = 0.3 — the energy of higher scattering orders.
            let ms: F = float(0);
            for (let k = 0; k < 4; k++) ms = ms.add(exp(tauSun.mul(-(0.3 ** k))).mul(phases[k]!).mul(0.6 ** k));
            const hf = lh.sub(this.base).div(this.top.sub(this.base)).clamp(0, 1);
            // Sky light comes in from above, through the cloud over the point: the local density
            // stands in for the column above it, up to 250 m of it (a sample up there cost a fifth
            // more per step and lost the device on a software GPU). Diffuse light, so a softened
            // extinction. Bases and the folds between towers go grey; the tops stay white — the
            // contrast a flat ambient loses.
            const upM = min(this.top.sub(lh), float(250)).max(0);
            const skyVis = exp(dens.mul(upM).mul(CLOUD_EXTINCTION_PER_M * 0.25).negate());
            const ambient = skyUp.mul(mix(float(0.6), float(1.4), hf)).mul(mix(float(0.45), float(1), skyVis)).add(groundUp.mul(float(1).sub(hf)));
            // Beer–powder (Schneider 2015): light scattered towards the eye builds up over the first
            // few tens of metres inside, so the thin rims seen away from the sun are darker than the
            // body and every billow outlines itself; towards the sun the forward lobe wins and the
            // rims glow (the silver lining) — the effect fades in that direction.
            const powder = float(1).sub(exp(sigmaT.mul(-140)).mul(0.6));
            const powderK = mix(powder, float(1), cosSun.mul(0.5).add(0.5).pow(2));
            // The folds between lobes, where the detail ate the shape, lie in their neighbours' shadow: the
            // light march sees only the coarse shape (a detail sample there cost the device on a software
            // GPU), so without this every billow was lit alike and the clouds read as smooth slabs. Toward
            // the sun the thin folds glow instead.
            const folds = float(1).sub(fold.mul(0.55).mul(float(1).sub(smoothstep(0.2, 0.85, cosSun))));
            const S = sunColour.mul(ms).mul(powderK).mul(folds).mul(lobe).add(ambient.mul(folds.mul(0.4).add(0.6))).mul(sigmaT);
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
      // Haze in front of the cloud: the cloud as a surface at its weighted depth, opacity 1 − T.
      const opacity = float(1).sub(T);
      const cloudDepth = depthSum.div(max(weightSum, 1e-6));
      const radiance = scatter.div(max(opacity, 1e-4));
      const hazed = this.atmosphere.applyAerial(radiance, uv, cloudDepth).mul(opacity);
      return vec4(select(opacity.greaterThan(1e-4), hazed, vec3(0)), T);
    })();
  }

  /**
   * Full-resolution composite: the march result over the scene, with the aircraft-sized edge cases
   * resolved per pixel — surfaces in front of the layer take no cloud, surfaces within CLOUD_NEAR_M
   * of the eye take fog at the camera's own density.
   */
  composite(scene: V3, cloud: Node<'vec4'>, dir: V3, distanceM: F): V3 {
    const cam = this.atmosphere.cameraWorld;
    const seg = this.segment(cam.y, dir, float(MAX_MARCH_M));
    const behind = distanceM.greaterThan(seg.start).and(seg.end.greaterThan(seg.start));
    const far = select(behind, scene.mul(cloud.a).add(cloud.rgb), scene);
    const fogT = exp(this.cameraDensity.mul(CLOUD_EXTINCTION_PER_M).mul(distanceM).negate());
    const fogColour = cloud.rgb.div(max(float(1).sub(cloud.a), 0.05));
    const near = scene.mul(fogT).add(fogColour.mul(float(1).sub(fogT)));
    return select(distanceM.lessThan(CLOUD_NEAR_M), near, far);
  }

  /**
   * Fraction of sunlight reaching a rendered point through the layer (cloud shadows on the ground and
   * the aircraft): a short shape-only march along the sun direction through the slab.
   */
  /** Applies the cloud shadow to every shadow-receiving node material under `root` (sun light only). */
  shadeReceivers(root: Object3D, samples: number): void {
    // ShadowNode calls this with the shadow factor; three's typing declares it argument-less.
    // Built inside the callback: the march assigns to variables, which needs the shader-building stack.
    const cloud = (): Node<'float'> => this.sunShadow(positionWorld, cameraPosition, samples);
    const fn = ((shadow: Node<'vec4'>) => shadow.mul(cloud())) as unknown as () => Node;
    root.traverse((o) => {
      if (!(o instanceof Mesh) || !o.receiveShadow) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!(m instanceof NodeMaterial)) continue;
        // A material may carry a sun factor of its own (the terrain's ridge shadows): keep it, times the cloud's.
        const own = m.userData.shadowFactor as Node<'float'> | undefined;
        m.receivedShadowNode = own ? (((shadow: Node<'vec4'>) => shadow.mul(cloud()).mul(own)) as unknown as () => Node) : fn;
      }
    });
  }

  sunShadow(worldPos: V3, cameraPos: V3, samples: number): F {
    const d = worldPos.xz.sub(cameraPos.xz);
    const altitude = worldPos.y.add(d.dot(d).div(2 * EARTH_RADIUS_M));
    const sun = this.atmosphere.sunDir;
    const sy = max(sun.y, 0.03);
    // Where the sun ray crosses the slab (flat is close enough over a few kilometres).
    const tIn = max(this.base.sub(altitude), 0).div(sy);
    const tOut = max(this.top.sub(altitude), 0).div(sy);
    const len = tOut.sub(tIn);
    const tau = float(0).toVar();
    for (let k = 0; k < samples; k++) {
      const t = tIn.add(len.mul((k + 0.5) / samples));
      tau.addAssign(this.density(worldPos.x.add(sun.x.mul(t)), altitude.add(sun.y.mul(t)), worldPos.z.add(sun.z.mul(t)), false));
    }
    // Beer with a soft floor: forward scattering keeps some light under thin cloud.
    return exp(tau.mul(len.div(samples)).mul(CLOUD_EXTINCTION_PER_M * 0.5).negate()).mul(0.9).add(0.1);
  }
}
