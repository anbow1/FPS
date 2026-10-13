import { abs, float, instancedBufferAttribute, length, max, mix, mx_noise_float, normalize, pow, smoothstep, sqrt, uniform, uv, vec3 } from 'three/tsl';
import { AdditiveBlending, Color, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Node, PlaneGeometry, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

// Pooled camera-facing particles. Three kinds share this class:
//  - lit: dust, smoke, debris — a standard material so the sun and sky light
//    them. Each sprite is a billow, not a disc: a noise-broken cauliflower
//    edge and a rounded normal, so a cloud of them shades from its sunlit side
//    to its shadowed one like a real puff. Hot smoke glows orange from inside
//    while it is young (`glow`), the way a blast's smoke is lit by its fire.
//  - emissive: sparks and flash cores, additive.
//  - fire: additive billows whose colour follows their temperature, from a
//    white-yellow core through orange to a dull red as they cool and fade.
// Nothing allocates per frame.

export type SpriteKind = 'lit' | 'emissive' | 'fire';

/** Pre-exposed radiance of a fire billow at full heat (set each frame). */
export const fireRadiance = uniform(1);
/** Pre-exposed radiance of smoke's inner glow at full glow (set each frame). */
export const smokeGlowRadiance = uniform(1);

export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  sizeM: number;
  growMs: number; // size growth, m/s
  lifeSeconds: number;
  colour: number; // sRGB hex (lit) or linear HDR tint (emissive, via `intensity`)
  intensity: number; // emissive only: pre-exposed HDR multiplier
  gravity: number; // m/s², negative rises (hot smoke)
  drag: number; // 1/s
  opacity: number;
  /** Seconds before the particle appears (a blast's smoke follows its fire). */
  delaySeconds: number;
  /** Lit: inner glow at birth, 0 … 1, gone in the first fifth of the life. Fire: the starting heat. */
  heat: number;
}

interface Particle {
  alive: boolean;
  pos: Vector3;
  vel: Vector3;
  size: number;
  grow: number;
  age: number;
  life: number;
  gravity: number;
  drag: number;
  opacity: number;
  heat: number;
}

export class ParticlePool {
  readonly mesh: InstancedMesh;
  private readonly particles: Particle[] = [];
  private readonly fade: InstancedBufferAttribute;
  private readonly info: InstancedBufferAttribute;
  private next = 0;
  private readonly colour = new Color();

  constructor(
    capacity: number,
    private readonly kind: SpriteKind,
  ) {
    const sprite = softSprites(capacity, kind);
    this.fade = sprite.fade;
    this.info = sprite.info;
    this.mesh = sprite.mesh;
    for (let i = 0; i < capacity; i++) {
      this.particles.push({ alive: false, pos: new Vector3(), vel: new Vector3(), size: 0, grow: 0, age: 0, life: 1, gravity: 0, drag: 0, opacity: 1, heat: 0 });
    }
  }

  spawn(s: ParticleSpawn): void {
    const i = this.next;
    this.next = (this.next + 1) % this.particles.length;
    const p = this.particles[i] as Particle;
    p.alive = true;
    p.pos.set(s.x, s.y, s.z);
    p.vel.set(s.vx, s.vy, s.vz);
    p.size = s.sizeM;
    p.grow = s.growMs;
    p.age = -s.delaySeconds;
    p.life = s.lifeSeconds;
    p.gravity = s.gravity;
    p.drag = s.drag;
    p.opacity = s.opacity;
    p.heat = s.heat;
    this.colour.setHex(s.colour);
    if (s.intensity !== 1) this.colour.multiplyScalar(s.intensity);
    this.mesh.setColorAt(i, this.colour);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(camera: PerspectiveCamera, dt: number): void {
    camera.getWorldQuaternion(_q);
    const arr = this.fade.array as Float32Array;
    const info = this.info.array as Float32Array;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i] as Particle;
      if (!p.alive) {
        arr[i] = 0;
        continue;
      }
      p.age += dt;
      if (p.age < 0) {
        arr[i] = 0;
        this.mesh.setMatrixAt(i, _zero);
        continue;
      }
      if (p.age >= p.life) {
        p.alive = false;
        arr[i] = 0;
        this.mesh.setMatrixAt(i, _zero);
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.size += p.grow * dt;
      const t = p.age / p.life;
      if (this.kind === 'fire') {
        // Burns out: full brightness at once, then the heat carries the fade.
        arr[i] = p.opacity * Math.min(1, t * 25) * (1 - t * t);
        info[i * 2 + 1] = p.heat * (1 - t);
      } else {
        arr[i] = p.opacity * Math.min(1, t * 8) * Math.pow(1 - t, 1.5);
        info[i * 2 + 1] = this.kind === 'lit' ? p.heat * Math.max(0, 1 - t * 5) ** 2 : 0;
      }
      _s.setScalar(p.size);
      _m.compose(p.pos, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.fade.needsUpdate = true;
    this.info.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Instanced soft sprites with a per-instance opacity (`fade`) and `info`
 * (x: a fixed random seed for the billow's shape, y: glow or heat). Lit
 * sprites use a standard material (sun and sky light them); emissive and fire
 * ones add light.
 */
export function softSprites(capacity: number, kind: SpriteKind): { mesh: InstancedMesh; fade: InstancedBufferAttribute; info: InstancedBufferAttribute } {
  const fade = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const infoArr = new Float32Array(capacity * 2);
  // Golden-ratio seeds: neighbouring puffs never share a shape.
  for (let i = 0; i < capacity; i++) infoArr[i * 2] = (i * 0.618034) % 1;
  const info = new InstancedBufferAttribute(infoArr, 2);
  // The attribute nodes come back untyped; their item sizes (1 and 2) fix the types.
  const a = instancedBufferAttribute(fade) as unknown as Node<'float'>;
  const inf = instancedBufferAttribute(info) as unknown as Node<'vec2'>;
  const seed = inf.x.mul(97);
  const q = uv().sub(0.5).mul(2); // -1 … 1 across the sprite
  const r = length(q);
  let material: MeshBasicNodeMaterial | MeshStandardNodeMaterial;
  if (kind === 'emissive') {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    m.colorNode = vec3(1, 1, 1).mul(float(1).sub(smoothstep(0.5, 1, r)).mul(a)); // additive: colour × alpha is the light added
    material = m;
  } else {
    // The billow: two octaves of noise push the edge in and out (cauliflower lobes) and thin the interior.
    const n1 = mx_noise_float(vec3(q.mul(1.9), seed));
    const n2 = mx_noise_float(vec3(q.mul(4.3), seed.add(11.3)));
    const lumpy = n1.mul(0.6).add(n2.mul(0.3));
    // The second factor keeps every lobe inside the quad, so no puff shows a straight edge.
    const body = float(1).sub(smoothstep(0.35, 1, r.sub(lumpy.mul(0.38)))).mul(float(1).sub(smoothstep(0.82, 1, r)));
    const density = body.mul(float(0.75).add(n2.mul(0.25)));
    if (kind === 'fire') {
      const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
      // Temperature ramp: white-yellow when hot, orange, then a dull red as it cools; brightness falls steeply.
      const h = inf.y;
      const colour = vec3(1, pow(h, 1.6).mul(0.85).add(0.06), pow(h, 3.2).mul(0.7));
      const bright = pow(max(h, 0), 2.2).mul(float(0.7).add(abs(n1).mul(0.9)));
      m.colorNode = colour.mul(bright).mul(fireRadiance).mul(density).mul(a);
      material = m;
    } else {
      const m = new MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
      m.opacityNode = density.mul(a);
      // A rounded normal in view space (the sprite faces the camera): the puff shades like a ball, with the
      // noise denting it so lobes catch the light on their own.
      const bulge = sqrt(max(float(1).sub(r.mul(r)), 0.05));
      m.normalNode = normalize(vec3(q.x.add(n1.mul(0.5)), q.y.add(n2.mul(0.5)), bulge.add(0.35)));
      // Young blast smoke lit from inside by its fire, brightest in its thick core.
      m.emissiveNode = mix(vec3(1, 0.32, 0.07), vec3(1, 0.55, 0.2), inf.y).mul(inf.y).mul(smokeGlowRadiance).mul(body);
      material = m;
    }
  }
  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, capacity);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.castShadow = false;
  const white = new Color(1, 1, 1);
  for (let i = 0; i < capacity; i++) {
    mesh.setMatrixAt(i, _zero);
    mesh.setColorAt(i, white);
  }
  return { mesh, fade, info };
}

const _zero = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();

export function spawnDefaults(): ParticleSpawn {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, sizeM: 0.2, growMs: 0, lifeSeconds: 1, colour: 0x8f8b85, intensity: 1, gravity: 0, drag: 0, opacity: 1, delaySeconds: 0, heat: 0 };
}
