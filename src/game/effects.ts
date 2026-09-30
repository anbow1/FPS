import * as THREE from 'three/webgpu';
import { makeSmokeSprite } from '../render/textures';
import { kelvinToLinear } from '../render/lighting';
import { float, instancedBufferAttribute, length, mix, smoothstep, texture, uniform, uv, vec3 } from 'three/tsl';
import { G } from '../render/nodes';

/**
 * CPU-simulated particles rendered as two point clouds: lit alpha-blended (smoke, dust, debris)
 * and additive emissive (fire, sparks, flash). Emissive values are in candela-ish units and get
 * pre-exposed like every other light, with a floor so fire still reads at noon.
 */
export const enum PKind {
  Smoke,
  Dust,
  Debris,
  Fire,
  Spark,
  Flash,
}

interface Pool {
  sprite: THREE.Sprite;
  max: number;
  count: number;
  pos: Float32Array;
  vel: Float32Array;
  col: Float32Array; // rgb albedo or emissive
  age: Float32Array;
  life: Float32Array;
  size: Float32Array; // start size
  grow: Float32Array;
  alpha: Float32Array;
  rot: Float32Array;
  kind: Uint8Array;
  // GPU attributes (per instance)
  aSize: Float32Array;
  aAlpha: Float32Array;
  aRot: Float32Array;
  aCol: Float32Array;
  attrs: THREE.InstancedBufferAttribute[];
}

/** Uniforms of the lit (smoke, dust, debris) and additive (fire, sparks, flash) particles. */
const PU = {
  ambient: uniform(new THREE.Color()),
  sun: uniform(new THREE.Color()),
  emissive: uniform(1),
};

/**
 * One pool = one instanced sprite: camera-facing quads sized in metres, their per-particle
 * position, size, rotation, alpha and colour in instanced attributes rewritten each frame.
 * (WebGPU draws points at one pixel only, so the old point sprites became real quads.)
 */
function makePool(max: number, additive: boolean, spriteTex: THREE.Texture): Pool {
  const pos = new Float32Array(max * 3);
  const aSize = new Float32Array(max);
  const aAlpha = new Float32Array(max);
  const aRot = new Float32Array(max);
  const aCol = new Float32Array(max * 3);
  const attr = (a: Float32Array, n: number) => new THREE.InstancedBufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  const attrs = [attr(pos, 3), attr(aSize, 1), attr(aAlpha, 1), attr(aRot, 1), attr(aCol, 3)] as const;
  const [P, S, A, R, C] = attrs;
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.name = additive ? 'particles-add' : 'particles-lit';
  mat.positionNode = instancedBufferAttribute(P);
  mat.scaleNode = instancedBufferAttribute(S);
  mat.rotationNode = instancedBufferAttribute(R);
  const alpha = instancedBufferAttribute(A) as unknown as THREE.Node<'float'>;
  const col = instancedBufferAttribute(C) as unknown as THREE.Node<'vec3'>;
  const t = texture(spriteTex, uv());
  if (additive) {
    mat.blending = THREE.AdditiveBlending;
    mat.fog = false;
    const d = length(uv().sub(0.5)).mul(2);
    const a = t.a.mul(alpha).mul(float(1).sub(smoothstep(0.2, 1, d)));
    // additive: the colour carries the coverage, alpha stays 1
    mat.colorNode = mix(col.mul(PU.emissive), vec3(1.2), G.uThermal).mul(a);
    mat.opacityNode = float(1);
  } else {
    // thermal imagers see through most smoke and dust
    const a = t.a.mul(alpha).mul(mix(1, 0.25, G.uThermal));
    // cheap volumetric lighting: ambient + forward-scattered sun, darker in dense cores
    const light = PU.ambient.mul(1.6).add(PU.sun.mul(t.r.mul(0.25).add(0.35)));
    const lit = col.mul(light).mul(t.r.mul(0.3).add(0.7));
    mat.colorNode = mix(lit, vec3(col.r.mul(0.1).add(0.03)), G.uThermal);
    mat.opacityNode = a;
  }
  const sprite = new THREE.Sprite(mat);
  sprite.count = 0;
  sprite.frustumCulled = false;
  return {
    sprite, max, count: 0, pos,
    vel: new Float32Array(max * 3), col: new Float32Array(max * 3), age: new Float32Array(max), life: new Float32Array(max),
    size: new Float32Array(max), grow: new Float32Array(max), alpha: new Float32Array(max), rot: new Float32Array(max),
    kind: new Uint8Array(max), aSize, aAlpha, aRot, aCol, attrs: [...attrs],
  };
}

interface FlashLight {
  light: THREE.PointLight;
  cd: number;
  ttl: number;
}

export interface Fire {
  x: number;
  y: number;
  z: number;
  ttl: number;
  intensity: number;
  acc: number;
  light: THREE.PointLight | null;
}

interface Tracer {
  mesh: THREE.Mesh;
  active: boolean;
}

export class Effects {
  readonly group = new THREE.Group();
  private lit: Pool;
  private add: Pool;
  private flashes: FlashLight[] = [];
  private fireLights: THREE.PointLight[] = [];
  readonly fires: Fire[] = [];
  private tracers: Tracer[] = [];
  private tracerGeo: THREE.BufferGeometry;
  private exposure = 1;
  private fireColor = kelvinToLinear(1900);
  private flashColor = kelvinToLinear(2400);
  private wind = new THREE.Vector2(1, 0.35);
  shake = 0;

  constructor(maxParticles: number) {
    const sprite = makeSmokeSprite(3);
    this.lit = makePool(maxParticles, false, sprite);
    this.add = makePool(Math.floor(maxParticles / 2), true, sprite);
    this.lit.sprite.renderOrder = 5;
    this.add.sprite.renderOrder = 6;
    this.group.add(this.lit.sprite, this.add.sprite);

    // Fixed light count: toggling intensity never changes the shader program.
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 60, 2);
      this.group.add(l);
      this.flashes.push({ light: l, cd: 0, ttl: 0 });
    }
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 45, 2);
      l.castShadow = false;
      l.shadow.mapSize.set(512, 512);
      l.shadow.bias = -0.002;
      this.group.add(l);
      this.fireLights.push(l);
    }
    this.tracerGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true);
    this.tracerGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.tracers.push({ mesh: m, active: false });
    }
  }

  /** Changes the light's shader variant, so only call on quality changes. */
  setWreckShadow(on: boolean): void {
    const l = this.fireLights[0]!;
    l.castShadow = on;
    // render the cube map once so an idle light never samples uninitialised memory (NaN → bloom smear)
    l.shadow.needsUpdate = true;
  }

  setMaxParticles(n: number): void {
    this.lit.max = Math.min(this.lit.pos.length / 3, n);
    this.add.max = Math.min(this.add.pos.length / 3, Math.floor(n / 2));
  }

  /** Keep particle lighting and emissive levels consistent with the current light preset. */
  /** Particle lighting and emissive levels follow the light preset (the height fog is the scene's). */
  setLighting(exposure: number, ambient: THREE.Color, sun: THREE.Color): void {
    this.exposure = exposure;
    PU.ambient.value.copy(ambient);
    PU.sun.value.copy(sun).multiplyScalar(1 / Math.PI);
    // fire luminance ~5e4 cd/m² pre-exposed, floored/capped so it reads day and night
    PU.emissive.value = Math.min(40, Math.max(2.5, 5e4 * exposure));
  }

  setWind(w: THREE.Vector2): void {
    this.wind.copy(w);
  }

  emit(kind: PKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, r: number, g: number, b: number, alpha = 1, grow = 1): void {
    const p = kind === PKind.Fire || kind === PKind.Spark || kind === PKind.Flash ? this.add : this.lit;
    let i: number;
    if (p.count < p.max) i = p.count++;
    else i = Math.floor(Math.random() * p.max); // pool full: recycle a random particle
    p.pos[i * 3] = x;
    p.pos[i * 3 + 1] = y;
    p.pos[i * 3 + 2] = z;
    p.vel[i * 3] = vx;
    p.vel[i * 3 + 1] = vy;
    p.vel[i * 3 + 2] = vz;
    p.col[i * 3] = r;
    p.col[i * 3 + 1] = g;
    p.col[i * 3 + 2] = b;
    p.age[i] = 0;
    p.life[i] = life;
    p.size[i] = size;
    p.grow[i] = grow;
    p.alpha[i] = alpha;
    p.rot[i] = Math.random() * 6.28;
    p.kind[i] = kind;
  }

  // ------------------------------------------------------------------ composite effects

  muzzleBlast(pos: THREE.Vector3, dir: THREE.Vector3, groundY: number, big: boolean): void {
    const f = this.flashColor;
    for (let i = 0; i < 14; i++) {
      const s = Math.random();
      const sp = 20 + s * 60;
      this.emit(PKind.Flash, pos.x + dir.x * s * 2.5, pos.y + dir.y * s * 2.5, pos.z + dir.z * s * 2.5,
        dir.x * sp, dir.y * sp, dir.z * sp, (big ? 3.2 : 1.6) * (1 - s * 0.5), 0.06 + Math.random() * 0.05, f.r * 1.6, f.g * 1.1, f.b * 0.7, 1, 1.5);
    }
    // side-venting from the muzzle brake + ground blast dust
    // side-venting from the muzzle brake, pushed forward so it does not sit on the sight
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 6 + Math.random() * 14;
      const vx = dir.x * sp * 1.1 + Math.cos(a) * sp * 0.45;
      const vz = dir.z * sp * 1.1 + Math.sin(a) * sp * 0.45;
      this.emit(PKind.Smoke, pos.x + dir.x * 2, pos.y + dir.y * 2, pos.z + dir.z * 2, vx, Math.random() * 1.5, vz, 1.4 + Math.random() * 1.2, 1.8 + Math.random() * 2, 0.38, 0.37, 0.35, 0.32, 4);
    }
    // ground blast kicks up dust in a fan ahead of the muzzle
    if (pos.y - groundY < 4) {
      for (let i = 0; i < 28; i++) {
        const a = Math.atan2(dir.z, dir.x) + (Math.random() - 0.5) * 2.4;
        const sp = 5 + Math.random() * 12;
        const r = 3 + Math.random() * 3;
        this.emit(PKind.Dust, pos.x + Math.cos(a) * r, groundY + 0.3, pos.z + Math.sin(a) * r, Math.cos(a) * sp, 0.5 + Math.random() * 1.2, Math.sin(a) * sp,
          1.6 + Math.random() * 1.6, 1.6 + Math.random() * 1.8, 0.5, 0.43, 0.34, 0.35, 3.5);
      }
    }
    this.flash(pos, big ? 1.5e6 : 6e4, 0.05);
    this.shake = Math.max(this.shake, big ? 0.6 : 0.2);
  }

  flash(pos: THREE.Vector3, candela: number, ttl: number): void {
    const f = this.flashes.find((q) => q.ttl <= 0) ?? this.flashes[0]!;
    f.light.position.copy(pos);
    f.light.color.copy(this.flashColor);
    f.cd = candela;
    f.ttl = ttl;
  }

  /** Shell hitting the ground: dirt fountain, dust ring, scorched earth. */
  groundImpact(x: number, y: number, z: number, explosive: number): void {
    const n = 20 + explosive * 30;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 8 + Math.random() * (12 + explosive * 20);
      const out = 2 + Math.random() * (4 + explosive * 6);
      this.emit(PKind.Debris, x, y + 0.2, z, Math.cos(a) * out, up, Math.sin(a) * out, 0.3 + Math.random() * 0.5, 1.2 + Math.random(), 0.25, 0.2, 0.15, 1, 1);
    }
    for (let i = 0; i < 18 + explosive * 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * (4 + explosive * 5);
      this.emit(PKind.Dust, x, y + 0.5 + Math.random(), z, Math.cos(a) * sp, 1.5 + Math.random() * 4, Math.sin(a) * sp, 2.5 + explosive * 2, 3 + Math.random() * 4, 0.45, 0.38, 0.3, 0.7, 3.5);
    }
    if (explosive > 0) this.explosionCore(x, y + 0.6, z, explosive);
  }

  explosionCore(x: number, y: number, z: number, scale: number): void {
    const f = this.fireColor;
    for (let i = 0; i < 16 * scale + 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * 1.2;
      const sp = 3 + Math.random() * 10 * scale;
      this.emit(PKind.Fire, x, y, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 2, Math.sin(a) * Math.cos(e) * sp, 2.5 * scale + 1, 0.25 + Math.random() * 0.35, f.r * 2.5, f.g * 1.7, f.b, 1, 2.2);
    }
    for (let i = 0; i < 12 * scale; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 10 + Math.random() * 30;
      this.emit(PKind.Spark, x, y, z, Math.cos(a) * sp, 4 + Math.random() * 16, Math.sin(a) * sp, 0.25, 0.4 + Math.random() * 0.6, 3, 1.6, 0.6, 1, 0.5);
    }
    for (let i = 0; i < 10 * scale; i++) {
      this.emit(PKind.Smoke, x + (Math.random() - 0.5) * 2, y + Math.random() * 2, z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3, 2 + Math.random() * 3, (Math.random() - 0.5) * 3,
        3 * scale + 1, 5 + Math.random() * 5, 0.12, 0.11, 0.1, 0.8, 4);
    }
    this.flash(_v.set(x, y + 1, z), 4e5 * scale, 0.09);
  }

  /** Armour hit: sparks, a puff of spall dust; brighter when the plate held (ricochet/no-pen). */
  armourHit(p: THREE.Vector3, n: THREE.Vector3, pen: boolean): void {
    for (let i = 0; i < (pen ? 18 : 30); i++) {
      const sp = 10 + Math.random() * 35;
      this.emit(PKind.Spark, p.x, p.y, p.z, (n.x + (Math.random() - 0.5) * 1.6) * sp, (n.y + Math.random() * 0.8) * sp, (n.z + (Math.random() - 0.5) * 1.6) * sp,
        0.18 + Math.random() * 0.12, 0.2 + Math.random() * 0.5, 3, 1.8, 0.8, 1, 0.3);
    }
    for (let i = 0; i < 8; i++) {
      this.emit(PKind.Smoke, p.x, p.y, p.z, n.x * 3 + (Math.random() - 0.5) * 2, 1 + Math.random() * 2, n.z * 3 + (Math.random() - 0.5) * 2, 1.2, 1.5 + Math.random(), 0.35, 0.33, 0.3, 0.6, 3);
    }
    this.flash(p, pen ? 2e5 : 1e5, 0.04);
  }

  /** Catastrophic kill: fireball, smoke column, debris. */
  bigExplosion(x: number, y: number, z: number): void {
    this.explosionCore(x, y + 1, z, 2.5);
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 6 + Math.random() * 20;
      this.emit(PKind.Debris, x, y + 1.5, z, Math.cos(a) * sp, 8 + Math.random() * 18, Math.sin(a) * sp, 0.3 + Math.random() * 0.4, 2 + Math.random() * 1.5, 0.1, 0.1, 0.1, 1, 1);
    }
    this.shake = Math.max(this.shake, 1);
  }

  addFire(x: number, y: number, z: number, ttl: number, intensity = 1): Fire {
    const f: Fire = { x, y, z, ttl, intensity, acc: 0, light: null };
    this.fires.push(f);
    return f;
  }

  spawnTracer(): THREE.Mesh | null {
    const t = this.tracers.find((q) => !q.active);
    if (!t) return null;
    t.active = true;
    t.mesh.visible = true;
    return t.mesh;
  }

  releaseTracer(m: THREE.Mesh): void {
    const t = this.tracers.find((q) => q.mesh === m);
    if (t) {
      t.active = false;
      t.mesh.visible = false;
    }
  }

  clear(): void {
    this.lit.count = 0;
    this.add.count = 0;
    this.fires.length = 0;
    for (const t of this.tracers) {
      t.active = false;
      t.mesh.visible = false;
    }
  }

  update(dt: number, cam: THREE.Vector3, wreckShadow: boolean): void {
    const t = G.uTime.value;
    this.simulate(this.lit, dt);
    this.simulate(this.add, dt);
    const ex = this.exposure;
    for (const f of this.flashes) {
      f.ttl -= dt;
      f.light.intensity = f.ttl > 0 ? Math.min(1e5, f.cd * ex) : 0;
    }
    // Fires: emit flames + smoke, nearest three get the flickering 1900 K lights (4-9 Hz).
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i]!;
      f.ttl -= dt;
      if (f.ttl <= 0) {
        this.fires.splice(i, 1);
        continue;
      }
      const k = Math.min(1, f.ttl / 20) * f.intensity;
      f.acc += dt * 45 * k;
      while (f.acc > 1) {
        f.acc -= 1;
        const c = this.fireColor;
        this.emit(PKind.Fire, f.x + (Math.random() - 0.5) * 1.6, f.y + Math.random() * 0.6, f.z + (Math.random() - 0.5) * 1.6,
          (Math.random() - 0.5) * 0.8, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 1.4, 0.5 + Math.random() * 0.5, c.r * 2, c.g * 1.4, c.b, 0.9, 1.4);
        if (Math.random() < 0.6) {
          this.emit(PKind.Smoke, f.x, f.y + 2, f.z, this.wind.x * 1.5 + (Math.random() - 0.5), 3 + Math.random() * 2, this.wind.y * 1.5 + (Math.random() - 0.5),
            2.5, 8 + Math.random() * 6, 0.08, 0.075, 0.07, 0.7, 5);
        }
      }
    }
    const sorted = this.fires.slice().sort((a, b) => dist2(a, cam) - dist2(b, cam));
    this.fireLights.forEach((l, i) => {
      const f = sorted[i];
      if (!f) {
        l.intensity = 0;
        return;
      }
      const flick = 0.75 + 0.15 * Math.sin(t * 2 * Math.PI * 4.3 + i) + 0.1 * Math.sin(t * 2 * Math.PI * 8.7 + i * 2);
      l.position.set(f.x, f.y + 2, f.z);
      l.color.copy(this.fireColor);
      l.intensity = Math.min(1e5, 12000 * ex * flick * Math.min(1, f.ttl / 10) * f.intensity);
    });
    // Burning wreck casts shadow (sheet) — only the nearest one, and only while it burns.
    this.fireLights[0]!.shadow.autoUpdate = wreckShadow && !!sorted[0];
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }

  private simulate(p: Pool, dt: number): void {
    const wx = this.wind.x;
    const wz = this.wind.y;
    let n = p.count;
    for (let i = 0; i < n; i++) {
      p.age[i]! += dt;
      if (p.age[i]! >= p.life[i]!) {
        n--;
        this.copy(p, n, i);
        i--;
        continue;
      }
      const k = p.kind[i]!;
      const i3 = i * 3;
      let drag = 1.2;
      let grav = 0;
      if (k === PKind.Debris) {
        drag = 0.1;
        grav = 9.81;
      } else if (k === PKind.Spark) {
        drag = 0.8;
        grav = 9.81;
      } else if (k === PKind.Fire) {
        drag = 2.5;
        grav = -3;
      } else if (k === PKind.Smoke) {
        drag = 1.1;
        grav = -0.6;
      } else if (k === PKind.Dust) {
        drag = 1.6;
        grav = 0.25;
      } else if (k === PKind.Flash) {
        drag = 8;
      }
      const f = Math.exp(-drag * dt);
      const windF = k === PKind.Smoke || k === PKind.Dust ? 1 - f : 0;
      p.vel[i3] = p.vel[i3]! * f + wx * windF * 2;
      p.vel[i3 + 1] = p.vel[i3 + 1]! * f - grav * dt;
      p.vel[i3 + 2] = p.vel[i3 + 2]! * f + wz * windF * 2;
      p.pos[i3]! += p.vel[i3]! * dt;
      p.pos[i3 + 1]! += p.vel[i3 + 1]! * dt;
      p.pos[i3 + 2]! += p.vel[i3 + 2]! * dt;
      const life = p.age[i]! / p.life[i]!;
      p.aSize[i] = p.size[i]! * (1 + p.grow[i]! * Math.sqrt(life));
      const fadeIn = Math.min(1, p.age[i]! / 0.08);
      p.aAlpha[i] = p.alpha[i]! * fadeIn * (1 - life) * (1 - life * 0.3);
      p.aRot[i] = p.rot[i]! + p.age[i]! * 0.3;
      p.aCol[i3] = p.col[i3]!;
      p.aCol[i3 + 1] = p.col[i3 + 1]!;
      p.aCol[i3 + 2] = p.col[i3 + 2]!;
      if (k === PKind.Fire) {
        // fire cools to smoke colour
        const cool = 1 - life;
        p.aCol[i3]! *= cool;
        p.aCol[i3 + 1]! *= cool * cool;
        p.aCol[i3 + 2]! *= cool * cool * cool;
      }
    }
    p.count = n;
    p.sprite.count = n;
    for (const a of p.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  private copy(p: Pool, from: number, to: number): void {
    if (from === to) return;
    for (let c = 0; c < 3; c++) {
      p.pos[to * 3 + c] = p.pos[from * 3 + c]!;
      p.vel[to * 3 + c] = p.vel[from * 3 + c]!;
      p.col[to * 3 + c] = p.col[from * 3 + c]!;
    }
    p.age[to] = p.age[from]!;
    p.life[to] = p.life[from]!;
    p.size[to] = p.size[from]!;
    p.grow[to] = p.grow[from]!;
    p.alpha[to] = p.alpha[from]!;
    p.rot[to] = p.rot[from]!;
    p.kind[to] = p.kind[from]!;
  }
}

function dist2(f: Fire, c: THREE.Vector3): number {
  return (f.x - c.x) ** 2 + (f.z - c.z) ** 2;
}

const _v = new THREE.Vector3();
