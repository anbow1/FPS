import * as THREE from 'three/webgpu';
import type { BulletSpec } from '../config';
import type { World } from '../world/world';
import type { Audio } from './audio';
import { type ShellState, stepShell } from './ballistics';
import { type Effects, PKind } from './effects';
import type { HitInfo, Tank, Team } from './tank';

/** Something small arms can hurt: soldiers and drones. `hitTest` returns t in [0,1] or -1. */
export interface SoftTarget {
  alive: boolean;
  team: Team;
  hitTest(a: THREE.Vector3, b: THREE.Vector3): number;
  onBullet(point: THREE.Vector3, dir: THREE.Vector3, damage: number, from: Team): void;
}

interface Bullet {
  s: ShellState;
  spec: BulletSpec;
  team: Team;
  age: number;
  tracer: boolean;
  color: THREE.Color;
  ignore: Tank | null;
}

const MAX_TRACERS = 160;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit: HitInfo = { t: 0, part: 'hull', localNormal: new THREE.Vector3(), point: new THREE.Vector3() };
const _ray = { t: 0, x: 0, y: 0, z: 0, kind: 'none' as 'terrain' | 'building' | 'none' };
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();

/**
 * Machine-gun and rifle rounds. Same point-mass integrator as the shells (so the coax FCS mode
 * lays the gun correctly), swept collision per step, tracers as one instanced draw.
 */
export class Bullets {
  private list: Bullet[] = [];
  readonly tracers: THREE.InstancedMesh;
  private tracerColor = new THREE.Color();

  constructor(private readonly effects: Effects) {
    const g = new THREE.CylinderGeometry(0.018, 0.018, 1, 5, 1, true);
    g.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.tracers = new THREE.InstancedMesh(g, mat, MAX_TRACERS);
    this.tracers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TRACERS * 3), 3);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.tracers.renderOrder = 7;
  }

  /** `tracer` rounds glow: NATO red-orange, Warsaw-pact green. */
  fire(spec: BulletSpec, team: Team, pos: THREE.Vector3, dir: THREE.Vector3, tracer: boolean, ignore: Tank | null = null): void {
    if (this.list.length > 600) this.list.shift();
    const c = team === 'player' ? this.tracerColor.setRGB(28, 7, 2.5) : this.tracerColor.setRGB(6, 26, 5);
    this.list.push({
      s: { x: pos.x, y: pos.y, z: pos.z, vx: dir.x * spec.v0, vy: dir.y * spec.v0, vz: dir.z * spec.v0 },
      spec, team, age: 0, tracer, color: c.clone(), ignore,
    });
  }

  clear(): void {
    this.list.length = 0;
    this.tracers.count = 0;
  }

  update(dt: number, world: World, tanks: Tank[], soft: SoftTarget[], audio: Audio): void {
    let tc = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]!;
      b.age += dt;
      _a.set(b.s.x, b.s.y, b.s.z);
      stepShell(b.s, b.spec.k, dt);
      _b.set(b.s.x, b.s.y, b.s.z);
      const len = _a.distanceTo(_b);
      _dir.subVectors(_b, _a).divideScalar(Math.max(len, 1e-6));
      let bestT = 2;
      let what: 'tank' | 'soft' | 'ground' | null = null;
      let tankHit: Tank | null = null;
      let softHit: SoftTarget | null = null;
      for (const t of tanks) {
        if (t === b.ignore && b.age < 0.2) continue;
        const h = t.raycast(_a, _b, _hit);
        if (h && h.t < bestT) {
          bestT = h.t;
          what = 'tank';
          tankHit = t;
          _n.copy(h.localNormal);
        }
      }
      for (const s of soft) {
        if (!s.alive || s.team === b.team) continue;
        const t = s.hitTest(_a, _b);
        if (t >= 0 && t < bestT) {
          bestT = t;
          what = 'soft';
          softHit = s;
        }
      }
      world.raycast(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _ray, 5);
      if (_ray.kind !== 'none' && _ray.t < bestT) {
        bestT = _ray.t;
        what = 'ground';
      }
      let dead = b.age > 4 || b.s.y < -50;
      if (what && bestT <= 1) {
        const p = _a.clone().lerp(_b, bestT);
        dead = true;
        if (what === 'soft' && softHit) {
          softHit.onBullet(p, _dir, b.spec.damage, b.team);
        } else if (what === 'tank' && tankHit) {
          // small arms only spark off armour
          const wn = _n.transformDirection(tankHit.model.hull.matrixWorld);
          for (let k = 0; k < 4; k++) {
            const sp = 6 + Math.random() * 14;
            this.effects.emit(PKind.Spark, p.x, p.y, p.z, (wn.x + (Math.random() - 0.5)) * sp, (wn.y + Math.random() * 0.6) * sp, (wn.z + (Math.random() - 0.5)) * sp, 0.12, 0.15 + Math.random() * 0.2, 3, 1.8, 0.8, 1, 0.3);
          }
          if (Math.random() < 0.25) audio.ping(p);
        } else {
          const water = p.y < 0.05 && world.hf.heightAt(p.x, p.z) < 0;
          for (let k = 0; k < 3; k++) {
            this.effects.emit(PKind.Dust, p.x, p.y + 0.1, p.z, (Math.random() - 0.5) * 1.5, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 1.5,
              water ? 0.35 : 0.3, 0.6 + Math.random() * 0.5, water ? 0.8 : 0.42, water ? 0.85 : 0.36, water ? 0.9 : 0.28, 0.55, 2.5);
          }
        }
      }
      if (!dead && b.tracer && tc < MAX_TRACERS && b.age > 0.02) {
        const tl = Math.min(len * 1.2, 9);
        _s.set(1, 1, tl);
        _q.setFromUnitVectors(_z, _dir);
        _m.compose(_b.clone().addScaledVector(_dir, -tl / 2), _q, _s);
        this.tracers.setMatrixAt(tc, _m);
        this.tracers.setColorAt(tc, b.color);
        tc++;
      }
      if (dead) this.list.splice(i, 1);
    }
    this.tracers.count = tc;
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;
  }
}
