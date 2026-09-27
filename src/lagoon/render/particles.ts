import { attribute, float, max, smoothstep, uniform, uv, vec4 } from 'three/tsl';
import { AdditiveBlending, type Camera, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three/webgpu';
import { PHYSICS } from '../../config.ts';
import { heightAt } from '../game/terrain.ts';
import { U } from './uniforms.ts';

// Pooled camera-facing particles. One pool is lit by the scene's sun and sky
// (water spray, sand, dust, splinters, leaves, smoke); the other is additive
// and self-lit (sparks, embers, flame licks) with luminance in cd/m² scaled
// by the pre-exposure. Simulation is a few lines of point-mass physics on the
// CPU; drawing is one instanced mesh per pool.

export interface ParticleSpec {
  colour: [number, number, number]; // linear albedo (lit) or relative emission (glow)
  sizeM: number;
  growPerS: number;
  lifeS: number;
  drag: number; // 1/s
  gravity: number; // multiple of g (negative rises)
  stretch: number; // elongate along velocity (droplets, sparks)
  bounce: boolean;
  opacity: number;
}

interface Particle {
  pos: Vector3;
  vel: Vector3;
  age: number;
  spec: ParticleSpec;
  size: number;
  alive: boolean;
}

export class ParticlePool {
  readonly mesh: InstancedMesh;
  private readonly list: Particle[] = [];
  private readonly fade: InstancedBufferAttribute;
  private readonly tint: InstancedBufferAttribute;
  private next = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly axis = new Vector3();
  private readonly camRight = new Vector3();
  private readonly camUp = new Vector3();
  private readonly tmp = new Vector3();
  /** Emissive luminance of the glow pool in cd/m² (hot sparks and embers); pre-exposed each frame. */
  glowLuminance = 12000;
  private readonly glowScale = uniform(0);
  private readonly across = new Vector3();
  private readonly along = new Vector3();

  constructor(
    capacity: number,
    readonly glow: boolean,
  ) {
    const geo = new PlaneGeometry(1, 1);
    this.fade = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.tint = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    geo.setAttribute('pFade', this.fade);
    geo.setAttribute('pTint', this.tint);
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: !glow });
    const r = uv().sub(0.5).length().mul(2);
    const soft = float(1).sub(smoothstep(0.35, 1.0, r));
    const tint = attribute('pTint', 'vec3');
    const fade = attribute('pFade', 'float');
    if (glow) {
      mat.blending = AdditiveBlending;
      mat.colorNode = vec4(tint.mul(this.glowScale).mul(soft).mul(fade), 1);
    } else {
      // Lit by sun and sky as a rough, thin, mostly forward-scattering puff.
      const light = U.sunIrradiance.mul(max(U.sunDir.y, 0.15)).add(U.skyIrradiance).add(U.groundRadiance.mul(Math.PI * 0.5)).div(Math.PI);
      mat.colorNode = vec4(tint.mul(light), soft.mul(fade));
    }
    this.mesh = new InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    this.mesh.renderOrder = 20;
    for (let i = 0; i < capacity; i++) this.list.push({ pos: new Vector3(), vel: new Vector3(), age: 0, spec: SPECS.spray, size: 0, alive: false });
    this.hideAll();
  }

  private hideAll(): void {
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < this.list.length; i++) this.mesh.setMatrixAt(i, this.m);
  }

  spawn(spec: ParticleSpec, pos: Vector3, vel: Vector3): void {
    const p = this.list[this.next] as Particle;
    this.next = (this.next + 1) % this.list.length;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.age = 0;
    p.spec = spec;
    p.size = spec.sizeM * (0.7 + Math.random() * 0.6);
    p.alive = true;
  }

  update(dt: number, camera: Camera, preExposure: number): void {
    this.glowScale.value = this.glowLuminance * preExposure;
    this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    this.camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    camera.getWorldQuaternion(this.q);
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i] as Particle;
      if (!p.alive) {
        this.fade.setX(i, 0);
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        continue;
      }
      const sp = p.spec;
      p.age += dt;
      if (p.age >= sp.lifeS) {
        p.alive = false;
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-sp.drag * dt));
      p.vel.y -= PHYSICS.gravityMs2 * sp.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (sp.bounce) {
        const ground = heightAt(p.pos.x, p.pos.z);
        if (p.pos.y < ground && ground > 0) {
          p.pos.y = ground;
          p.vel.y *= -0.3;
          p.vel.x *= 0.5;
          p.vel.z *= 0.5;
        } else if (p.pos.y < 0 && ground <= 0) p.age = sp.lifeS; // into the water
      }
      p.size += sp.growPerS * dt;
      const life = p.age / sp.lifeS;
      this.fade.setX(i, sp.opacity * Math.min(1, p.age * 20) * (1 - life * life));
      this.tint.setXYZ(i, sp.colour[0], sp.colour[1], sp.colour[2]);
      // Billboard, optionally stretched along the screen-projected velocity.
      const speed = p.vel.length();
      if (sp.stretch > 0 && speed > 0.5) {
        this.axis.copy(p.vel).normalize();
        const along = Math.min(6, 1 + speed * sp.stretch);
        // Build a basis: X across the streak, Y along it, facing the camera.
        const view = this.tmp.subVectors(camera.position, p.pos).normalize();
        this.across.crossVectors(this.axis, view).normalize().multiplyScalar(p.size);
        this.along.copy(this.axis).multiplyScalar(p.size * along);
        this.m.makeBasis(this.across, this.along, view);
        this.m.setPosition(p.pos);
      } else {
        this.m.compose(p.pos, this.q, this.s.setScalar(p.size));
      }
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fade.needsUpdate = true;
    this.tint.needsUpdate = true;
  }
}

const spec = (s: Partial<ParticleSpec> & Pick<ParticleSpec, 'colour' | 'sizeM' | 'lifeS'>): ParticleSpec => ({ growPerS: 0, drag: 0.5, gravity: 1, stretch: 0, bounce: false, opacity: 1, ...s });

export const SPECS = {
  spray: spec({ colour: [0.75, 0.82, 0.85], sizeM: 0.035, lifeS: 0.9, drag: 0.3, stretch: 0.06, opacity: 0.85 }),
  mist: spec({ colour: [0.8, 0.86, 0.9], sizeM: 0.18, growPerS: 0.6, lifeS: 0.8, drag: 3, gravity: 0.1, opacity: 0.35 }),
  sand: spec({ colour: [0.6, 0.52, 0.38], sizeM: 0.12, growPerS: 0.5, lifeS: 1.1, drag: 3.5, gravity: 0.15, opacity: 0.6 }),
  grit: spec({ colour: [0.55, 0.47, 0.33], sizeM: 0.012, lifeS: 0.7, drag: 0.4, bounce: true }),
  dust: spec({ colour: [0.45, 0.43, 0.4], sizeM: 0.1, growPerS: 0.45, lifeS: 1.0, drag: 3, gravity: 0.08, opacity: 0.55 }),
  chips: spec({ colour: [0.4, 0.38, 0.36], sizeM: 0.014, lifeS: 0.8, drag: 0.3, bounce: true }),
  splinter: spec({ colour: [0.42, 0.3, 0.19], sizeM: 0.016, lifeS: 1.0, drag: 0.6, stretch: 0.02, bounce: true }),
  leaf: spec({ colour: [0.12, 0.22, 0.05], sizeM: 0.05, lifeS: 2.6, drag: 2.5, gravity: 0.25 }),
  smoke: spec({ colour: [0.35, 0.34, 0.33], sizeM: 0.5, growPerS: 0.45, lifeS: 4.5, drag: 0.4, gravity: -0.03, opacity: 0.22 }),
  gunSmoke: spec({ colour: [0.6, 0.6, 0.6], sizeM: 0.12, growPerS: 0.5, lifeS: 1.2, drag: 2, gravity: -0.02, opacity: 0.18 }),
  rainSplash: spec({ colour: [0.75, 0.8, 0.85], sizeM: 0.03, lifeS: 0.25, drag: 0.5, stretch: 0.08, opacity: 0.6 }),
  // Glow pool (colour × luminance in cd/m² set per pool).
  spark: spec({ colour: [1, 0.55, 0.2], sizeM: 0.012, lifeS: 0.35, drag: 0.5, stretch: 0.05, bounce: true }),
  ember: spec({ colour: [1, 0.42, 0.12], sizeM: 0.018, lifeS: 2.2, drag: 0.9, gravity: -0.06 }),
  flame: spec({ colour: [1, 0.5, 0.16], sizeM: 0.3, growPerS: -0.1, lifeS: 0.55, drag: 1.5, gravity: -0.25 }),
} as const;

