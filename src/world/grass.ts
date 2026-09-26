import * as THREE from 'three';
import { WATER_LEVEL } from '../config';
import { sampleWrap } from '../core/noise';
import { hash2, Rng } from '../core/rng';
import { linear, PBR } from '../render/palette';
import { addPatch, foliageNormalPatch, G, inject, thermalPatch, translucencyPatch } from '../render/shaderPatch';
import type { NoiseSet } from '../render/textures';
import { NOISE_SIZE } from '../render/textures';
import type { Heightfield } from './heightfield';
import { SITES } from './layout';
import { hyp2 } from '../core/mathx';

const CHUNK = 24;
const MAX_PUSHERS = 10;

/**
 * Near-field grass blades in 24 m chunks around the camera. Blade positions are hashed per chunk,
 * so a chunk rebuilt later looks identical. Colour and density follow the same macro noise the
 * terrain shader uses, and blades bend away from vehicles.
 */
export class Grass {
  readonly group = new THREE.Group();
  private chunks = new Map<number, THREE.Mesh>();
  private pool: THREE.BufferGeometry[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly pushers: THREE.Vector4[] = [];
  private perChunk: number;
  private radius: number;
  private blade: { pos: Float32Array; tip: Float32Array };
  private job: GrassJob | null = null;

  constructor(
    private readonly hf: Heightfield,
    private readonly noise: NoiseSet,
    perChunk: number,
    radius: number,
  ) {
    this.perChunk = perChunk;
    this.radius = radius;
    for (let i = 0; i < MAX_PUSHERS; i++) this.pushers.push(new THREE.Vector4(0, -9999, 0, 0));
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide, vertexColors: true });
    const pushers = this.pushers;
    addPatch(this.material, {
      key: 'grass',
      apply(shader) {
        shader.uniforms.uTime = G.uTime;
        shader.uniforms.uWind = G.uWind;
        shader.uniforms.uPush = { value: pushers };
        inject(
          shader,
          'vertex',
          '#include <common>',
          `uniform float uTime; uniform vec2 uWind; uniform vec4 uPush[${MAX_PUSHERS}];
           attribute float tip;`,
          'after',
        );
        inject(
          shader,
          'vertex',
          '#include <begin_vertex>',
          `vec3 wpos = transformed;
           float ph = wpos.x * 0.35 + wpos.z * 0.27;
           float gust = sin(uTime * 1.7 + ph * 0.3) * 0.5 + 0.5;
           vec2 sway = uWind * (0.18 + 0.32 * gust) + vec2(sin(uTime * 3.1 + ph), cos(uTime * 2.6 + ph * 1.3)) * 0.05;
           vec2 push = vec2(0.0);
           for (int i = 0; i < ${MAX_PUSHERS}; i++) {
             vec2 d = wpos.xz - uPush[i].xz;
             float dist = length(d);
             float r = uPush[i].w;
             if (r > 0.0 && dist < r) push += normalize(d + 1e-4) * (1.0 - dist / r) * 1.2;
           }
           transformed.xz += (sway + push) * tip * tip;
           transformed.y -= length(push) * tip * 0.35;`,
          'after',
        );
      },
    });
    addPatch(this.material, foliageNormalPatch);
    addPatch(this.material, translucencyPatch(0.45));
    addPatch(this.material, thermalPatch('grass', '0.07 + 0.08 * uDay'));
    this.blade = makeBlade();
  }

  setDensity(perChunk: number, radius: number): void {
    if (perChunk === this.perChunk && radius === this.radius) return;
    this.perChunk = perChunk;
    this.radius = radius;
    for (const [, m] of this.chunks) this.release(m);
    this.chunks.clear();
    if (this.job) this.pool.push(this.job.g);
    this.job = null;
  }

  /** Vehicles flatten grass: xyz = position, w = radius. */
  setPusher(i: number, x: number, y: number, z: number, r: number): void {
    if (i < MAX_PUSHERS) this.pushers[i]!.set(x, y, z, r);
  }

  /**
   * Streams chunks in around the camera. A chunk is filled a slice of blades per frame (never a
   * whole chunk at once), nearest missing chunk first, and shown when complete.
   */
  update(cam: THREE.Vector3, bladesPerFrame = BLADES_PER_FRAME): void {
    const r = this.radius;
    for (const [key, m] of this.chunks) {
      const ci = Math.floor(key / 4096) - 2048;
      const cj = (key % 4096) - 2048;
      const cx = (ci + 0.5) * CHUNK;
      const cz = (cj + 0.5) * CHUNK;
      if (hyp2(cx - cam.x, cz - cam.z) > r + CHUNK) {
        this.release(m);
        this.chunks.delete(key);
      }
    }
    const job = this.job;
    if (job && hyp2((job.ci + 0.5) * CHUNK - cam.x, (job.cj + 0.5) * CHUNK - cam.z) > r + CHUNK) {
      this.pool.push(job.g);
      this.job = null;
    }
    // from the drone's altitude blades are sub-pixel: keep what exists, build nothing new
    if (cam.y - this.hf.heightAt(cam.x, cam.z) > 45) return;
    let left = bladesPerFrame;
    while (left > 0) {
      if (!this.job && !this.startNearest(cam)) return;
      left = this.fill(this.job!, left);
      if (this.job!.b >= this.perChunk) {
        const j = this.job!;
        this.job = null;
        const m = this.finish(j);
        this.chunks.set(j.key, m);
        this.group.add(m);
      }
    }
  }

  /** Fill everything around a point at once (spawn, before the first frame is shown). */
  warm(cam: THREE.Vector3): void {
    this.update(cam, 1e9);
  }

  private startNearest(cam: THREE.Vector3): boolean {
    const r = this.radius;
    const ci0 = Math.floor((cam.x - r) / CHUNK);
    const ci1 = Math.floor((cam.x + r) / CHUNK);
    const cj0 = Math.floor((cam.z - r) / CHUNK);
    const cj1 = Math.floor((cam.z + r) / CHUNK);
    let best = Infinity;
    let bi = 0;
    let bj = 0;
    for (let ci = ci0; ci <= ci1; ci++) {
      for (let cj = cj0; cj <= cj1; cj++) {
        const d = hyp2((ci + 0.5) * CHUNK - cam.x, (cj + 0.5) * CHUNK - cam.z);
        if (d > r || d >= best) continue;
        if (this.chunks.has((ci + 2048) * 4096 + (cj + 2048))) continue;
        best = d;
        bi = ci;
        bj = cj;
      }
    }
    if (best === Infinity) return false;
    this.job = {
      key: (bi + 2048) * 4096 + (bj + 2048),
      ci: bi,
      cj: bj,
      g: this.geometry(),
      rng: new Rng(Math.floor(hash2(bi, bj, 5) * 1e9)),
      b: 0,
      used: 0,
      minY: Infinity,
      maxY: -Infinity,
    };
    return true;
  }

  private release(m: THREE.Mesh): void {
    this.group.remove(m);
    this.pool.push(m.geometry);
  }

  private geometry(): THREE.BufferGeometry {
    const bladeV = this.blade.pos.length / 3;
    const n = this.perChunk;
    let g = this.pool.pop();
    if (!g || (g.getAttribute('position') as THREE.BufferAttribute).count !== n * bladeV) {
      g?.dispose();
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * bladeV * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * bladeV * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * bladeV * 3), 3));
      const tipA = new Float32Array(n * bladeV);
      for (let b = 0; b < n; b++) tipA.set(this.blade.tip, b * bladeV);
      g.setAttribute('tip', new THREE.BufferAttribute(tipA, 1));
    }
    return g;
  }

  /** Place up to `budget` blades of the job; returns the budget left over. */
  private fill(job: GrassJob, budget: number): number {
    const bladeV = this.blade.pos.length / 3;
    const n = this.perChunk;
    const { ci, cj, rng, g } = job;
    const P = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const N = (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
    const C = (g.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;
    const tn = _tn;
    const end = Math.min(n, job.b + budget);
    const spent = end - job.b;
    for (let b = job.b; b < end; b++) {
      const x = (ci + rng.next()) * CHUNK;
      const z = (cj + rng.next()) * CHUNK;
      const macro = sampleWrap(this.noise.r, NOISE_SIZE, x / 1100, z / 1100);
      const macro2 = sampleWrap(this.noise.g, NOISE_SIZE, x / 380 + 0.3, z / 380 + 0.3);
      const mid = sampleWrap(this.noise.g, NOISE_SIZE, x / 64, z / 64);
      const fine = sampleWrap(this.noise.b, NOISE_SIZE, x / 5.5, z / 5.5);
      const dry = smooth(0.4, 0.66, macro * 0.7 + macro2 * 0.3 + (mid - 0.5) * 0.3);
      const soil = smooth(0.74, 0.86, mid + (fine - 0.5) * 0.4 + dry * 0.06);
      const y = this.hf.heightAt(x, z);
      if (y < WATER_LEVEL + 0.8 || soil > 0.999) {
        rng.next();
        continue;
      }
      this.hf.normalAt(x, z, tn);
      const road = this.hf.roadAt(x, z);
      let keep = (1 - soil) * (1 - smooth(0.2, 0.33, 1 - tn.y)) * (1 - smooth(0.02, 0.2, road));
      for (const s of SITES) if (hyp2(x - s.x, z - s.z) < s.r * 0.35) keep *= 0.3;
      if (rng.next() > keep * (0.55 + 0.45 * fine)) continue;
      const h = (0.35 + rng.next() * 0.45) * (1 - dry * 0.25) * (0.7 + fine * 0.6);
      const w = 0.05 + rng.next() * 0.04;
      const rot = rng.next() * Math.PI * 2;
      const lean = (rng.next() - 0.5) * 0.4;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      // colour: same palette as the terrain, lighter tips come from `tip` below
      _c0.copy(GRASS_FRESH).lerp(GRASS_DRY, Math.min(1, dry + rng.next() * 0.25));
      _c0.multiplyScalar(0.8 + 0.35 * macro2 + rng.next() * 0.12);
      const bp = this.blade.pos;
      const base = job.used * bladeV;
      for (let k = 0; k < bladeV; k++) {
        const bx = bp[k * 3]! * w;
        const by = bp[k * 3 + 1]! * h;
        const t = this.blade.tip[k]!;
        const bz = lean * t * h;
        const i = (base + k) * 3;
        P[i] = x + bx * c + bz * s;
        P[i + 1] = y + by - 0.03;
        P[i + 2] = z - bx * s + bz * c;
        N[i] = tn.x * 0.6 + s * 0.2;
        N[i + 1] = tn.y;
        N[i + 2] = tn.z * 0.6 + c * 0.2;
        const shade = 0.55 + 0.6 * t;
        C[i] = _c0.r * shade;
        C[i + 1] = _c0.g * shade;
        C[i + 2] = _c0.b * shade;
      }
      if (y < job.minY) job.minY = y;
      if (y + h > job.maxY) job.maxY = y + h;
      job.used++;
    }
    job.b = end;
    return budget - spent;
  }

  private finish(job: GrassJob): THREE.Mesh {
    const bladeV = this.blade.pos.length / 3;
    const { g, ci, cj, used } = job;
    g.setDrawRange(0, used * bladeV);
    // upload only the blades that were kept (a full chunk is ~3 MB of vertex data)
    for (const name of ['position', 'normal', 'color']) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(3, used * bladeV * 3));
      a.needsUpdate = true;
    }
    // analytic bound instead of scanning every vertex
    if (!g.boundingSphere) g.boundingSphere = new THREE.Sphere();
    const cy = used ? (job.minY + job.maxY) / 2 : this.hf.heightAt((ci + 0.5) * CHUNK, (cj + 0.5) * CHUNK);
    g.boundingSphere.center.set((ci + 0.5) * CHUNK, cy, (cj + 0.5) * CHUNK);
    g.boundingSphere.radius = CHUNK * 0.75 + (used ? (job.maxY - job.minY) / 2 : 0) + 1;
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    m.castShadow = false;
    return m;
  }
}

interface GrassJob {
  key: number;
  ci: number;
  cj: number;
  g: THREE.BufferGeometry;
  rng: Rng;
  /** next blade index to place, blades kept so far */
  b: number;
  used: number;
  minY: number;
  maxY: number;
}

/** ~1-2 ms on a phone: a 5200-blade chunk streams in over four frames */
const BLADES_PER_FRAME = 1300;
const _tn = { x: 0, y: 1, z: 0 };

/** One tapered blade as a 3-segment triangle strip, unrolled to a triangle list. */
function makeBlade(): { pos: Float32Array; tip: Float32Array } {
  const rows: [number, number][] = [
    [0.5, 0],
    [0.42, 0.35],
    [0.28, 0.7],
    [0, 1],
  ];
  const tri: number[] = [];
  const tip: number[] = [];
  const v = (x: number, y: number) => {
    tri.push(x, y, 0);
    tip.push(y);
  };
  for (let r = 0; r < rows.length - 1; r++) {
    const [w0, y0] = rows[r]!;
    const [w1, y1] = rows[r + 1]!;
    v(-w0, y0); v(w0, y0); v(w1, y1);
    if (w1 > 0) {
      v(-w0, y0); v(w1, y1); v(-w1, y1);
    }
  }
  return { pos: new Float32Array(tri), tip: new Float32Array(tip) };
}

const _c0 = linear(0);
// palette colours converted to linear once, not per blade
const GRASS_FRESH = linear(PBR.grassFresh.color);
const GRASS_DRY = linear(PBR.grassDry.color);

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
