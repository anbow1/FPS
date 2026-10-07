import { attribute, cameraPosition, dot, float, length, max, mx_noise_float, normalize, positionWorld, screenUV, smoothstep, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import type { Atmosphere } from './atmosphere.ts';
import { OVERLAY_LAYER, overlayBlending, overlayVisibility } from './stage.ts';

// Contrails and wingtip vapour (brief: "contrails above a given altitude,
// wingtip vapour under high G"). Each trail is a ring buffer of emission points
// (world position, time, strength) drawn as one camera-facing ribbon; the CPU
// rebuilds the few hundred vertices every frame, which is cheaper than any GPU
// scheme at this size and keeps the strip exact at the nozzle.
//
// Formation, simplified from the Schmidt–Appleman criterion: exhaust contrails
// form when the ambient air is colder than about −40 °C (ISA: above ~8 km) and
// persist longer the colder and more humid it is; vapour forms where the
// pressure drop over a loaded wing cools humid air below its dew point — high G,
// enough speed, lower and moister air. Ice crystals scatter strongly forwards,
// so trails glow towards the sun and read grey away from it.

export interface TrailStyle {
  /** Seconds a point lives; opacity decays with time constant `fadeS`. */
  lifeS: number;
  fadeS: number;
  /** Half-width at birth (m) and its growth (m/s) as the trail spreads. */
  halfWidthM: number;
  spreadMs: number;
  /** Seconds after emission before the trail appears (condensation delay). */
  delayS: number;
  /** Seconds between emitted points. */
  sampleS: number;
  opacity: number;
}

export const CONTRAIL: TrailStyle = { lifeS: 70, fadeS: 25, halfWidthM: 0.9, spreadMs: 0.45, delayS: 0.12, sampleS: 0.1, opacity: 0.85 };
export const VAPOUR: TrailStyle = { lifeS: 0.9, fadeS: 0.35, halfWidthM: 0.15, spreadMs: 1.6, delayS: 0, sampleS: 1 / 60, opacity: 0.85 };

/** Contrail strength 0…1 for the ambient temperature (K) and humidity factor 0…1. */
export function contrailStrength(temperatureK: number, humidity: number, thrustFraction: number): number {
  const cold = Math.min(1, Math.max(0, (236 - temperatureK) / 10));
  return cold * humidity * Math.min(1, 0.35 + thrustFraction);
}

/** Wingtip vapour strength 0…1 from load factor, true airspeed and altitude (moister air lower down). */
export function vapourStrength(loadFactor: number, speedMs: number, altitudeM: number, humidity: number): number {
  const g = Math.min(1, Math.max(0, (loadFactor - 4.5) / 3));
  const v = Math.min(1, Math.max(0, (speedMs - 90) / 70));
  const moist = 0.3 + 0.7 * Math.min(1, Math.max(0, (9000 - altitudeM) / 6000));
  return g * v * moist * humidity;
}

class Trail {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly t: Float32Array;
  readonly s: Float32Array;
  /** Index of the oldest point and the number of points. */
  head = 0;
  count = 0;
  lastEmitS = -1e9;

  constructor(
    readonly style: TrailStyle,
    readonly capacity: number,
  ) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.t = new Float32Array(capacity);
    this.s = new Float32Array(capacity);
  }

  push(p: Vector3, timeS: number, strength: number): void {
    const i = (this.head + this.count) % this.capacity;
    if (this.count === this.capacity) this.head = (this.head + 1) % this.capacity;
    else this.count++;
    this.x[i] = p.x;
    this.y[i] = p.y;
    this.z[i] = p.z;
    this.t[i] = timeS;
    this.s[i] = strength;
  }

  expire(nowS: number): void {
    while (this.count > 0 && nowS - this.t[this.head]! > this.style.lifeS) {
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
  }

  /** The i-th point from the oldest. */
  at(i: number): number {
    return (this.head + i) % this.capacity;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}

/** All the trails of one aircraft in one draw call. */
export class Trails {
  readonly mesh: Mesh;
  private readonly trails: { trail: Trail; source: number }[] = [];
  private readonly geometry = new BufferGeometry();
  private readonly position: BufferAttribute;
  /** Per vertex: x = across (−1…1), y = opacity, z = age (s). */
  private readonly shade: BufferAttribute;
  private readonly index: BufferAttribute;
  private readonly maxVerts: number;
  private readonly tmp = new Vector3();
  private readonly side = new Vector3();
  private readonly tangent = new Vector3();
  private readonly toEye = new Vector3();

  /** One trail per emitter (e.g. each nozzle → contrail, each wingtip → vapour), in this order. */
  constructor(
    atmosphere: Atmosphere,
    emitters: { style: TrailStyle }[],
  ) {
    for (let k = 0; k < emitters.length; k++) {
      const style = emitters[k]!.style;
      this.trails.push({ trail: new Trail(style, Math.ceil(style.lifeS / style.sampleS) + 2), source: k });
    }
    // One extra (live) point per trail at the emitter itself.
    const points = this.trails.reduce((n, e) => n + e.trail.capacity + 1, 0);
    this.maxVerts = points * 2;
    this.position = new BufferAttribute(new Float32Array(this.maxVerts * 3), 3);
    this.shade = new BufferAttribute(new Float32Array(this.maxVerts * 3), 3);
    this.position.setUsage(DynamicDrawUsage);
    this.shade.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('shade', this.shade);
    // Rebuilt per frame: one strip per trail, never a quad bridging two trails.
    this.index = new BufferAttribute(new Uint32Array(this.maxVerts * 3), 1);
    this.index.setUsage(DynamicDrawUsage);
    this.geometry.setIndex(this.index);
    this.geometry.setDrawRange(0, 0);
    this.mesh = new Mesh(this.geometry, this.material(atmosphere));
    this.mesh.name = 'trails';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    // Drawn after the clouds (stage.ts), so a trail over a cloud deck stays visible.
    this.mesh.layers.set(OVERLAY_LAYER);
  }

  private material(atmosphere: Atmosphere): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ name: 'trails', transparent: true, depthWrite: false });
    overlayBlending(m, false);
    const sh = attribute('shade', 'vec3');
    const across = sh.x;
    const alpha = sh.y;
    const age = sh.z;
    // Soft round edge across the ribbon, broken up along it as the trail ages and spreads.
    const edge = float(1).sub(across.mul(across)).max(0).pow(0.8);
    const lumps = smoothstep(0.15, 0.65, mx_noise_float(positionWorld.mul(0.012)).mul(0.5).add(0.5).add(float(0.5).div(age.add(1))));
    // Ice: a strong forward lobe towards the sun plus an isotropic part; sky light from above.
    const view = normalize(positionWorld.sub(cameraPosition));
    const c = dot(view, atmosphere.sunDir);
    const g = 0.75;
    const forward = float((1 - g * g) / (4 * Math.PI)).div(float(1 + g * g).sub(c.mul(2 * g)).pow(1.5));
    const sun = atmosphere.transmittanceTo(float(6_360_000).add(max(positionWorld.y, 0)), atmosphere.sunDir.y).mul(atmosphere.sunIlluminance);
    const lit = sun.mul(forward.mul(0.6).add(0.25 / Math.PI)).add(atmosphere.skyOnly(vec3(0, 1, 0)).mul(0.8));
    m.colorNode = atmosphere.applyAerial(lit, screenUV, length(positionWorld.sub(cameraPosition)));
    m.opacityNode = alpha.mul(edge).mul(lumps).clamp(0, 1).mul(overlayVisibility());
    return m;
  }

  /** Emits, expires and rebuilds the ribbons. `positions[k]` is emitter k's world position now. */
  update(nowS: number, positions: Vector3[], strengths: number[], eye: Vector3): void {
    for (const { trail, source } of this.trails) {
      trail.expire(nowS);
      const p = positions[source]!;
      const s = strengths[source]!;
      if (nowS - trail.lastEmitS >= trail.style.sampleS) {
        // A run of zero-strength points is pointless: emit one to close the strip, then pause.
        const lastS = trail.count > 0 ? trail.s[trail.at(trail.count - 1)]! : 0;
        if (s > 0.001 || lastS > 0.001) trail.push(p, nowS, s);
        trail.lastEmitS = nowS;
      }
    }
    this.rebuild(nowS, positions, strengths, eye);
  }

  clear(): void {
    for (const { trail } of this.trails) trail.clear();
    this.geometry.setDrawRange(0, 0);
  }

  private rebuild(nowS: number, positions: Vector3[], strengths: number[], eye: Vector3): void {
    const pos = this.position.array as Float32Array;
    const sh = this.shade.array as Float32Array;
    const idx = this.index.array as Uint32Array;
    let v = 0;
    let k = 0;
    for (const { trail, source } of this.trails) {
      const n = trail.count;
      if (n === 0) continue;
      const st = trail.style;
      const start = v;
      // Points oldest → newest, then the live emitter position.
      const total = n + 1;
      const px = (i: number): number => (i < n ? trail.x[trail.at(i)]! : positions[source]!.x);
      const py = (i: number): number => (i < n ? trail.y[trail.at(i)]! : positions[source]!.y);
      const pz = (i: number): number => (i < n ? trail.z[trail.at(i)]! : positions[source]!.z);
      for (let i = 0; i < total; i++) {
        const age = i < n ? nowS - trail.t[trail.at(i)]! : 0;
        const strength = i < n ? trail.s[trail.at(i)]! : strengths[source]!;
        const a = Math.max(0, i - 1);
        const b = Math.min(total - 1, i + 1);
        this.tangent.set(px(b) - px(a), py(b) - py(a), pz(b) - pz(a));
        this.tmp.set(px(i), py(i), pz(i));
        this.toEye.copy(eye).sub(this.tmp);
        this.side.crossVectors(this.tangent, this.toEye);
        const len = this.side.length();
        if (len > 1e-6) this.side.multiplyScalar(1 / len);
        else this.side.set(0, 1, 0);
        const half = st.halfWidthM + st.spreadMs * age;
        // Opacity: condensation delay, exponential fade, end of life, spread thins the trail out.
        const delay = st.delayS > 0 ? Math.min(1, age / st.delayS) : 1;
        const life = Math.min(1, (st.lifeS - age) / (st.lifeS * 0.2));
        const thin = st.halfWidthM / half;
        const alpha = st.opacity * strength * delay * Math.exp(-age / st.fadeS) * Math.max(0, life) * Math.sqrt(thin);
        for (const sgn of [-1, 1]) {
          pos[v * 3] = this.tmp.x + this.side.x * half * sgn;
          pos[v * 3 + 1] = this.tmp.y + this.side.y * half * sgn;
          pos[v * 3 + 2] = this.tmp.z + this.side.z * half * sgn;
          sh[v * 3] = sgn;
          sh[v * 3 + 1] = alpha;
          sh[v * 3 + 2] = age;
          v++;
        }
      }
      for (let q = start; q + 3 < v; q += 2) {
        idx[k++] = q;
        idx[k++] = q + 1;
        idx[k++] = q + 2;
        idx[k++] = q + 1;
        idx[k++] = q + 3;
        idx[k++] = q + 2;
      }
    }
    this.position.needsUpdate = true;
    this.shade.needsUpdate = true;
    this.index.needsUpdate = true;
    this.geometry.setDrawRange(0, k);
    // Nothing to draw: skip the call (an empty draw is a WebGPU validation warning).
    this.mesh.visible = k > 0;
  }
}
