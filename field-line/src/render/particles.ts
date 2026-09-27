import { float, instancedBufferAttribute, length, smoothstep, uv, vec3 } from 'three/tsl';
import { AdditiveBlending, Color, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry, type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

// Pooled camera-facing particles. Two kinds share this class: lit ones (dust,
// debris, smoke — a standard material so the sun and sky light them) and
// emissive additive ones (sparks, flash cores). Each particle is soft-edged
// in the shader; per-instance opacity fades it out. Nothing allocates per frame.

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
}

export class ParticlePool {
  readonly mesh: InstancedMesh;
  private readonly particles: Particle[] = [];
  private readonly fade: InstancedBufferAttribute;
  private next = 0;
  private readonly colour = new Color();

  constructor(capacity: number, emissive: boolean) {
    const sprite = softSprites(capacity, emissive);
    this.fade = sprite.fade;
    this.mesh = sprite.mesh;
    for (let i = 0; i < capacity; i++) {
      this.particles.push({ alive: false, pos: new Vector3(), vel: new Vector3(), size: 0, grow: 0, age: 0, life: 1, gravity: 0, drag: 0, opacity: 1 });
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
    p.age = 0;
    p.life = s.lifeSeconds;
    p.gravity = s.gravity;
    p.drag = s.drag;
    p.opacity = s.opacity;
    this.colour.setHex(s.colour);
    if (s.intensity !== 1) this.colour.multiplyScalar(s.intensity);
    this.mesh.setColorAt(i, this.colour);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(camera: PerspectiveCamera, dt: number): void {
    camera.getWorldQuaternion(_q);
    const arr = this.fade.array as Float32Array;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i] as Particle;
      if (!p.alive) {
        arr[i] = 0;
        continue;
      }
      p.age += dt;
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
      arr[i] = p.opacity * Math.min(1, t * 8) * (1 - t) * (1 - t);
      _s.setScalar(p.size);
      _m.compose(p.pos, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.fade.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Instanced soft round sprites with a per-instance opacity attribute. Lit
 * sprites use a standard material (sun and sky light them); emissive ones add light.
 */
export function softSprites(capacity: number, emissive: boolean): { mesh: InstancedMesh; fade: InstancedBufferAttribute } {
  const fade = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const soft = float(1).sub(smoothstep(0.25, 0.5, length(uv().sub(0.5))));
  const alpha = soft.mul(instancedBufferAttribute(fade));
  let material: MeshBasicNodeMaterial | MeshStandardNodeMaterial;
  if (emissive) {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    m.colorNode = vec3(1, 1, 1).mul(alpha); // additive: colour × alpha is the light added
    material = m;
  } else {
    const m = new MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
    m.opacityNode = alpha;
    material = m;
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
  return { mesh, fade };
}

const _zero = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();

export function spawnDefaults(): ParticleSpawn {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, sizeM: 0.2, growMs: 0, lifeSeconds: 1, colour: 0x8f8b85, intensity: 1, gravity: 0, drag: 0, opacity: 1 };
}
