import { float, max, min, screenCoordinate, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { OceanFFT } from './ocean.ts';
import { waveWarp } from './waveWarp.ts';
import { WATER_LEVEL_M, WAVES } from '../config.ts';

// Wind whitecaps on the open sea, after the foam of web-ocean and Open Water (MIT): foam is
// born where the FFT surface folds over its crest, lingers for seconds, drifts with the wind
// and tears into lace as it thins. A crest folds where the surface curves down faster than the
// sea's usual curvature: the height's Laplacian (the divergence of the FFT's slope channels)
// below a threshold. That threshold follows the wind through Monahan & O'Muircheartaigh's
// (1980) whitecap coverage, W = 3.84e-6 · U^3.41 (U the 10 m wind, m/s): none in a breeze,
// ~0.3 % at 7 m/s, ~2 % at 12 m/s; the curvature is measured in units of its own RMS, so the
// coverage holds whatever wave scale the weather sets.
//
// Foam has memory, which a per-pixel crest test cannot give: a window round the camera holds
// the foam in a half-float target, ping-ponged each frame. A cell keeps what the cell upwind of
// it held a frame ago (the drift), faded with FOAM_LIFE_S, or the fresh foam a folding crest
// puts there, whichever is more. The water reads it through laceCover (shoreWaves.ts), so fresh
// whitecaps are solid and old ones break into streaks like the surf's foam.

/** Time for whitecap foam to fall to 1/e: bubbles rise and burst in a few seconds. */
const FOAM_LIFE_S = 3.5;
/** Foam drifts at a few per cent of the wind (the surface current plus the bubbles' windage). */
const DRIFT_PER_WIND = 0.03;
/**
 * Of the area under foam at any moment, the share that is an active, folding crest. Tuned on a
 * readback at 12 m/s: the crests run at their phase speed and leave trails, so solid foam (> 0.5)
 * covered 2.5× Monahan's W with 0.3; 0.12 brings it to W.
 */
const ACTIVE_SHARE = 0.12;
/** Past the window the water finds crests itself, without memory, over a coarser step (m). */
export const FAR_STEP_M = 1.0;

/** Whitecap coverage (0–1) for a 10 m wind of `windMps`. */
export function whitecapCoverage(windMps: number): number {
  return Math.min(0.1, 3.84e-6 * Math.max(windMps, 0) ** 3.41);
}

/** z such that a standard normal exceeds it with probability `p` (Abramowitz & Stegun 26.2.23). */
function normalTail(p: number): number {
  const q = Math.min(Math.max(p, 1e-9), 0.5);
  const t = Math.sqrt(-2 * Math.log(q));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
}

export class Whitecaps {
  readonly sizeM: number;
  private readonly n: number;
  private readonly cellM: number;
  private readonly targets: [THREE.RenderTarget, THREE.RenderTarget];
  private readonly quads: [THREE.QuadMesh, THREE.QuadMesh];
  private readonly lapRms: number;
  private cur = 0;
  private placed = false;
  /** Centre of the window being written, and of the one written last frame. */
  private readonly uOrigin = uniform(new THREE.Vector2());
  private readonly uPrevOrigin = uniform(new THREE.Vector2());
  private readonly uDrift = uniform(new THREE.Vector2());
  private readonly uDecay = uniform(1);
  /** Crest sharpness (in RMS units) where foam starts; ~9 = none. */
  private readonly uThreshold = uniform(9);
  private readonly uLapScale = uniform(1);
  /** The water's view: the latest target, its centre, and the mean coverage beyond it. */
  // Every texture node the water reads through: re-pointed at the latest target each frame
  // (a clone made by .sample() would keep the target it was made with).
  private readonly readers: THREE.TextureNode[] = [];
  private readonly readOrigin = uniform(new THREE.Vector2());
  readonly meanCoverage = uniform(0);
  /** For the water's own crest test beyond the window: threshold and curvature scale at FAR_STEP_M. */
  readonly farThreshold = uniform(9);
  readonly farLapScale = uniform(1);
  private readonly farLapRms: number;

  constructor(ocean: OceanFFT, depthMap: THREE.Texture, depthDomain: { x0: number; z0: number; sizeM: number }, quality: 'high' | 'low') {
    this.n = quality === 'high' ? 256 : 128;
    this.cellM = quality === 'high' ? 0.5 : 0.75;
    this.sizeM = this.n * this.cellM;
    const fmt = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    };
    this.targets = [new THREE.RenderTarget(this.n, this.n, fmt), new THREE.RenderTarget(this.n, this.n, fmt)];
    this.lapRms = ocean.laplacianRms(this.cellM);
    this.farLapRms = ocean.laplacianRms(FAR_STEP_M);
    const L = WAVES.openSea.patchM;
    const pass = (prev: THREE.RenderTarget, name: string): THREE.QuadMesh => {
      const uv = screenCoordinate.xy.div(this.n);
      const p = this.uOrigin.add(uv.sub(0.5).mul(this.sizeM));
      // What drifted here since last frame, faded; nothing from outside last frame's window.
      const from = p.sub(this.uDrift).sub(this.uPrevOrigin).div(this.sizeM).add(0.5);
      const inPrev = from.x.greaterThan(0).and(from.x.lessThan(1)).and(from.y.greaterThan(0)).and(from.y.lessThan(1));
      const kept = inPrev.select(texture(prev.texture, from).level(float(0)).r, float(0)).mul(this.uDecay);
      // The surface the water draws: the same warped lookup of the FFT patch (water.ts).
      const warp = waveWarp(p, L * 4, L * 0.7, 17);
      const e = this.cellM;
      const slopeAt = (dx: number, dz: number) => texture(ocean.surface.texture, warp.lookup.add(vec2(dx, dz)).div(L)).level(float(0));
      const lap = slopeAt(e, 0).y.sub(slopeAt(-e, 0).y).add(slopeAt(0, e).z.sub(slopeAt(0, -e).z)).div(2 * e);
      const sharp = lap.negate().div(this.uLapScale);
      // Over the open sea only: the reef and the lagoon's shallows are sheltered (water.ts `open`).
      const uvD = p.sub(vec2(depthDomain.x0, depthDomain.z0)).div(depthDomain.sizeM);
      const inD = uvD.x.greaterThan(0).and(uvD.x.lessThan(1)).and(uvD.y.greaterThan(0)).and(uvD.y.lessThan(1));
      const depth = float(WATER_LEVEL_M).sub(inD.select(texture(depthMap, uvD).level(float(0)).r, float(-40)));
      const open = smoothstep(2.5, WAVES.openSea.fullDepthM, depth);
      const born = smoothstep(this.uThreshold.sub(0.35), this.uThreshold.add(0.35), sharp).mul(open);
      const m = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending });
      m.name = name;
      // Raw data through fragmentNode, as ocean.ts does: no tone mapping or clamping on the way out.
      m.fragmentNode = vec4(min(max(kept, born), 1), 0, 0, 1);
      return new THREE.QuadMesh(m);
    };
    // Quad k writes target k, reading the other one.
    this.quads = [pass(this.targets[1], 'whitecaps-a'), pass(this.targets[0], 'whitecaps-b')];
  }

  get targetsForTimer(): THREE.RenderTarget[] {
    return [...this.targets];
  }

  /** Step the foam: `windMps` the 10 m wind, `waveScale` what the weather does to the FFT's slopes. */
  update(renderer: THREE.WebGPURenderer, dtS: number, focusX: number, focusZ: number, wind: { x: number; y: number }, waveScale: number): void {
    const dt = Math.min(Math.max(dtS, 0), 0.1);
    const windMps = Math.hypot(wind.x, wind.y);
    const coverage = whitecapCoverage(windMps);
    this.meanCoverage.value = coverage;
    this.uThreshold.value = coverage > 1e-6 ? normalTail(coverage * ACTIVE_SHARE) : 9;
    this.uLapScale.value = Math.max(this.lapRms * Math.sqrt(waveScale), 1e-4);
    // Without memory the crest itself must cover what the trails would: the whole W.
    this.farThreshold.value = coverage > 1e-6 ? normalTail(coverage) : 9;
    this.farLapScale.value = Math.max(this.farLapRms * Math.sqrt(waveScale), 1e-4);
    this.uDecay.value = Math.exp(-dt / FOAM_LIFE_S);
    this.uDrift.value.set(wind.x * DRIFT_PER_WIND * dt, wind.y * DRIFT_PER_WIND * dt);
    const ox = Math.round(focusX / this.cellM) * this.cellM;
    const oz = Math.round(focusZ / this.cellM) * this.cellM;
    this.uPrevOrigin.value.copy(this.placed ? this.uOrigin.value : new THREE.Vector2(1e6, 1e6));
    this.uOrigin.value.set(ox, oz);
    this.placed = true;
    const k = 1 - this.cur;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targets[k]);
    this.quads[k].render(renderer);
    renderer.setRenderTarget(prev);
    this.cur = k;
    for (const r of this.readers) r.value = this.targets[k].texture;
    this.readOrigin.value.set(ox, oz);
  }

  /** Foam amount (0–1) at world xz, and how much of the window covers it (0 at its edge). */
  sample(xz: THREE.Node<'vec2'>): { foam: THREE.Node<'float'>; inside: THREE.Node<'float'> } {
    const uv = xz.sub(this.readOrigin).div(this.sizeM).add(0.5);
    const edge = min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y)));
    const inside = smoothstep(0.0, 0.1, edge);
    const t = texture(this.targets[this.cur].texture, uv.clamp(0, 1));
    this.readers.push(t);
    return { foam: t.r.mul(inside), inside };
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    for (const q of this.quads) (q.material as THREE.Material).dispose();
  }
}
