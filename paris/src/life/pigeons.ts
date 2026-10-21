import { abs, attribute, cos, float, mix, positionLocal, sin, step, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, ConeGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial, PlaneGeometry, Quaternion, SphereGeometry, Vector3 } from 'three/webgpu';
import { STREET } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { merge } from '../render/meshkit.ts';
import { linearRgb } from '../render/nodes.ts';
import type { Person } from './crowd.ts';

// Feral pigeons on the pavement by the kerb, pecking at crumbs and walking a
// few steps at a time; when someone walks into the flock the nearest take off,
// and at `startleS` (a door slammed, a scooter) the whole flock goes up in a
// ripple — a burst of wingbeats (~8 Hz) climbing away across the boulevard.
// Wings, head and pecking move in the vertex shader from per-bird phases.

const FLOCK = 16;
const WINGBEAT_HZ = 8;

interface Bird {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  flying: boolean;
  /** Seconds until the next few steps on the ground. */
  idle: number;
  phase: number;
}

export class Pigeons {
  readonly mesh: InstancedMesh;
  private readonly birds: Bird[] = [];
  private readonly rng = new Rng(31);
  private readonly flight: InstancedBufferAttribute;

  constructor(
    centreX: number,
    centreZ: number,
    private readonly startleS: number,
  ) {
    for (let i = 0; i < FLOCK; i++) {
      this.birds.push({ x: centreX + this.rng.range(-0.35, 0.35), y: STREET.kerbM, z: centreZ + this.rng.range(-2.4, 2.4), yaw: this.rng.next() * 6.28, vx: 0, vy: 0, vz: 0, flying: false, idle: this.rng.range(0, 2), phase: this.rng.next() * 6.28 });
    }
    const geo = pigeonGeometry();
    this.flight = new InstancedBufferAttribute(new Float32Array(FLOCK * 2), 2);
    geo.setAttribute('flight', this.flight);
    this.mesh = new InstancedMesh(geo, pigeonMaterial(), FLOCK);
    this.mesh.name = 'pigeons';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  step(dt: number, t: number, people: readonly Person[]): void {
    this.birds.forEach((b, i) => {
      if (b.flying) {
        // Climbing hard at first, then levelling off and speeding up.
        b.vy = Math.max(1.0, b.vy - 1.6 * dt);
        const speed = Math.hypot(b.vx, b.vz);
        if (speed < 7) {
          b.vx *= 1 + 0.5 * dt;
          b.vz *= 1 + 0.5 * dt;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        b.yaw = Math.atan2(-b.vx, -b.vz);
        return;
      }
      // The startle runs through the flock from the nearest bird outward, a few hundredths of a second apart.
      if (t > this.startleS + i * 0.045) {
        b.flying = true;
        b.vx = -this.rng.range(2.0, 3.2);
        b.vz = -this.rng.range(1.0, 2.5);
        b.vy = this.rng.range(2.8, 3.8);
        b.yaw = Math.atan2(-b.vx, -b.vz);
        return;
      }
      // Someone within ~1.3 m: up and away from them, toward the trees.
      for (const p of people) {
        const dx = b.x - p.x;
        const dz = b.z - p.z;
        if (p.mode === 'walk' && dx * dx + dz * dz < 1.7 && Math.abs(p.y - b.y) < 0.5) {
          const d = Math.hypot(dx, dz) || 1;
          b.flying = true;
          b.vx = (dx / d) * 2.5 - Math.sign(b.x) * 1.5;
          b.vz = (dz / d) * 3.0;
          b.vy = 3.2;
          b.yaw = Math.atan2(-b.vx, -b.vz);
          break;
        }
      }
      if (b.flying) return;
      b.idle -= dt;
      if (b.idle < 0) {
        // A few quick steps in a new direction, then pecking again.
        b.yaw += this.rng.range(-1.2, 1.2);
        b.idle = this.rng.range(0.8, 2.5);
      } else if (b.idle > 0.5) {
        const step = 0.25 * dt;
        b.x -= Math.sin(b.yaw) * step;
        b.z -= Math.cos(b.yaw) * step;
      }
    });
  }

  update(t: number): void {
    this.birds.forEach((b, i) => {
      _m.compose(_p.set(b.x, b.y, b.z), _q.setFromAxisAngle(_y, b.yaw), _s.setScalar(1));
      this.mesh.setMatrixAt(i, _m);
      // Wing angle (rad) and pecking (0…1) for the shader.
      const wing = b.flying ? Math.sin((t * WINGBEAT_HZ + b.phase) * Math.PI * 2) * 0.9 : -1.35;
      const peck = b.flying ? 0 : Math.max(0, Math.sin(t * 5 + b.phase * 3)) * (b.idle < 0.5 ? 1 : 0.3);
      this.flight.setXY(i, wing, peck);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flight.needsUpdate = true;
  }
}

/** A pigeon (front −Z, feet at y = 0): body, head, tail, two wings hinged at the shoulders. */
function pigeonGeometry(): BufferGeometry {
  const tag = (g: BufferGeometry, kind: number): BufferGeometry => {
    const n = g.index ? g.toNonIndexed() : g;
    n.setAttribute('kind', new BufferAttribute(new Float32Array(n.getAttribute('position').count).fill(kind), 1));
    return n;
  };
  const parts = [
    tag(new SphereGeometry(1, 10, 8).scale(0.07, 0.07, 0.13).translate(0, 0.13, 0.01), 0),
    tag(new SphereGeometry(0.038, 8, 6).translate(0, 0.21, -0.11), 1),
    tag(new ConeGeometry(0.012, 0.03, 5).rotateX(-Math.PI / 2).translate(0, 0.205, -0.155), 1),
    tag(new PlaneGeometry(0.1, 0.11).rotateX(-Math.PI / 2 + 0.2).translate(0, 0.13, 0.17), 0),
    tag(new PlaneGeometry(0.26, 0.15).translate(0.15, 0, 0).rotateX(-Math.PI / 2).translate(0.04, 0.16, 0.02), 2),
    tag(new PlaneGeometry(0.26, 0.15).translate(-0.15, 0, 0).rotateX(-Math.PI / 2).translate(-0.04, 0.16, 0.02), 3),
    tag(new SphereGeometry(0.01, 4, 3).scale(1, 4, 1).translate(0.03, 0.04, 0.02), 0),
    tag(new SphereGeometry(0.01, 4, 3).scale(1, 4, 1).translate(-0.03, 0.04, 0.02), 0),
  ];
  const kinds: number[] = [];
  for (const p of parts) kinds.push(...(p.getAttribute('kind').array as Float32Array));
  const g = merge(parts, 'pigeon');
  g.setAttribute('kind', new BufferAttribute(new Float32Array(kinds), 1));
  return g;
}

function pigeonMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'pigeon', roughness: 0.7, side: 2 });
  const kind = attribute('kind', 'float');
  const flight = attribute('flight', 'vec2');
  const is = (k: number) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const wingSide = is(2).sub(is(3));
  const p = positionLocal;
  // Wings turn about the body's long axis at the shoulder (x = ±0.04); folded, they lie along the back.
  // On the ground (angle −1.35) the wing folds: its span shrinks to a patch on the flank.
  const folded = step(flight.x, -1.3);
  const angle = mix(flight.x, float(-0.35), folded);
  const rx = abs(p.x).sub(0.04).mul(mix(float(1), float(0.18), folded));
  const wingPos = vec3(wingSide.mul(float(0.04).add(rx.mul(cos(angle)))), p.y.add(rx.mul(sin(angle))), p.z);
  const isWing = is(2).add(is(3));
  const head = is(1);
  const pecked = vec3(p.x, p.y.sub(flight.y.mul(0.09)), p.z.sub(flight.y.mul(0.03)));
  m.positionNode = mix(mix(p, wingPos, isWing), pecked, head);
  const grey = vec3(...linearRgb(0x8d929c));
  const dark = vec3(...linearRgb(0x5a5f6a));
  const neck = vec3(...linearRgb(0x3e6a5a));
  m.colorNode = mix(mix(grey, dark, head), neck, step(0.17, p.y).mul(step(p.z, -0.04)).mul(is(0)).mul(0.6)).mul(mix(float(1), float(0.85), isWing));
  return m;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _y = new Vector3(0, 1, 0);
