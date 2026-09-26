import * as THREE from 'three';
import type { AmmoSpec } from '../config';
import type { World } from '../world/world';
import { type ShellState, stepShell } from './ballistics';
import type { Effects } from './effects';
import type { SoftTarget } from './bullets';
import type { HitInfo, Tank, Team } from './tank';
import { PKind } from './effects';
import { hyp3 } from '../core/mathx';

export interface Shell {
  s: ShellState;
  ammo: AmmoSpec;
  /** firing tank, or null for infantry rockets */
  owner: Tank | null;
  team: Team;
  origin: THREE.Vector3;
  flown: number;
  age: number;
  tracer: THREE.Mesh | null;
  ignore: Tank | null;
  ignoreT: number;
  cracked: boolean;
  ricochets: number;
  /** set by the impact handler when the round glances off and keeps flying */
  bounce: boolean;
}

export interface ImpactEvent {
  shell: Shell;
  point: THREE.Vector3;
  dir: THREE.Vector3;
  kind: 'terrain' | 'building' | 'tank' | 'water' | 'soft';
  tank: Tank | null;
  soft?: SoftTarget;
  hit: HitInfo | null;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit: HitInfo = { t: 0, part: 'hull', localNormal: new THREE.Vector3(), point: new THREE.Vector3() };
const _best: HitInfo = { t: 0, part: 'hull', localNormal: new THREE.Vector3(), point: new THREE.Vector3() };
const _ray = { t: 0, x: 0, y: 0, z: 0, kind: 'none' as 'terrain' | 'building' | 'none' };
const _z = new THREE.Vector3(0, 0, 1);
const _r = new THREE.Vector3();

/** Live shells: same integrator as the fire-control solver, swept collision each physics step. */
export class Projectiles {
  readonly shells: Shell[] = [];

  constructor(private readonly effects: Effects) {}

  fire(owner: Tank, ammo: AmmoSpec, pos: THREE.Vector3, dir: THREE.Vector3): Shell {
    const v = owner.velocity;
    const s: Shell = {
      s: { x: pos.x, y: pos.y, z: pos.z, vx: dir.x * ammo.v0 + v.x, vy: dir.y * ammo.v0, vz: dir.z * ammo.v0 + v.z },
      ammo, owner, team: owner.team, origin: pos.clone(), flown: 0, age: 0, tracer: this.effects.spawnTracer(), ignore: owner, ignoreT: 0.25, cracked: false, ricochets: 0, bounce: false,
    };
    if (s.tracer) {
      const c = ammo.tracer;
      (s.tracer.material as THREE.MeshBasicMaterial).color.setRGB(c[0] * 30, c[1] * 30, c[2] * 30);
      s.tracer.scale.set(ammo.id === 'APFSDS' ? 0.6 : 1.4, ammo.id === 'APFSDS' ? 0.6 : 1.4, 1);
    }
    this.shells.push(s);
    return s;
  }

  /** Unguided infantry rocket: bright motor, smoke trail. */
  fireRocket(ammo: AmmoSpec, pos: THREE.Vector3, dir: THREE.Vector3): Shell {
    const s: Shell = {
      s: { x: pos.x, y: pos.y, z: pos.z, vx: dir.x * ammo.v0, vy: dir.y * ammo.v0, vz: dir.z * ammo.v0 },
      ammo, owner: null, team: 'enemy', origin: pos.clone(), flown: 0, age: 0, tracer: this.effects.spawnTracer(), ignore: null, ignoreT: 0,
      cracked: false, ricochets: 3, bounce: false,
    };
    if (s.tracer) {
      (s.tracer.material as THREE.MeshBasicMaterial).color.setRGB(40, 20, 6);
      s.tracer.scale.set(2.2, 2.2, 1);
    }
    this.shells.push(s);
    return s;
  }

  clear(): void {
    for (const s of this.shells) if (s.tracer) this.effects.releaseTracer(s.tracer);
    this.shells.length = 0;
  }

  update(dt: number, world: World, tanks: Tank[], soft: SoftTarget[], listener: THREE.Vector3, onImpact: (e: ImpactEvent) => void, onCrack: (p: THREE.Vector3) => void): void {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i]!;
      sh.age += dt;
      sh.ignoreT -= dt;
      _a.set(sh.s.x, sh.s.y, sh.s.z);
      stepShell(sh.s, sh.ammo.k, dt);
      _b.set(sh.s.x, sh.s.y, sh.s.z);
      const segLen = _a.distanceTo(_b);
      _dir.subVectors(_b, _a).divideScalar(Math.max(segLen, 1e-6));

      // tanks first (nearest along the segment)
      let bestT = 2;
      let bestTank: Tank | null = null;
      for (const t of tanks) {
        if (t === sh.ignore && sh.ignoreT > 0) continue;
        const h = t.raycast(_a, _b, _hit);
        if (h && h.t < bestT) {
          bestT = h.t;
          bestTank = t;
          _best.t = h.t;
          _best.part = h.part;
          _best.localNormal.copy(h.localNormal);
          _best.point.copy(h.point);
        }
      }
      let softHit: SoftTarget | null = null;
      for (const t of soft) {
        if (!t.alive || t.team === sh.team) continue;
        const tt = t.hitTest(_a, _b);
        if (tt >= 0 && tt < bestT) {
          bestT = tt;
          softHit = t;
          bestTank = null;
        }
      }
      if (sh.ammo.id === 'RPG') {
        // rocket motor smoke
        for (let k = 0; k < 3; k++) {
          const f = Math.random();
          this.effects.emit(PKind.Smoke, _a.x + (_b.x - _a.x) * f, _a.y + (_b.y - _a.y) * f, _a.z + (_b.z - _a.z) * f, (Math.random() - 0.5) * 0.6, 0.3, (Math.random() - 0.5) * 0.6, 0.5, 2.2 + Math.random(), 0.7, 0.68, 0.65, 0.4, 3.5);
        }
      }
      world.raycast(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _ray, 4);
      const groundT = _ray.kind === 'none' ? 2 : _ray.t;
      // water surface
      let waterT = 2;
      if (_a.y > 0 && _b.y <= 0) waterT = _a.y / (_a.y - _b.y);

      let done = false;
      if (softHit && bestT <= groundT && bestT <= waterT && bestT <= 1) {
        onImpact({ shell: sh, point: _a.clone().lerp(_b, bestT), dir: _dir.clone(), kind: 'soft', tank: null, soft: softHit, hit: null });
        done = true;
      } else if (bestTank && bestT <= groundT && bestT <= waterT) {
        onImpact({ shell: sh, point: _best.point.clone(), dir: _dir.clone(), kind: 'tank', tank: bestTank, hit: { ..._best, localNormal: _best.localNormal.clone(), point: _best.point.clone() } });
        done = !sh.bounce;
        if (sh.bounce) {
          sh.bounce = false;
          sh.ignore = bestTank;
          sh.ignoreT = 0.15;
          sh.s.x = _best.point.x;
          sh.s.y = _best.point.y;
          sh.s.z = _best.point.z;
        }
      } else if (waterT < groundT && waterT <= 1) {
        const p = _a.clone().lerp(_b, waterT);
        onImpact({ shell: sh, point: p, dir: _dir.clone(), kind: 'water', tank: null, hit: null });
        done = true;
      } else if (_ray.kind !== 'none') {
        onImpact({ shell: sh, point: new THREE.Vector3(_ray.x, _ray.y, _ray.z), dir: _dir.clone(), kind: _ray.kind, tank: null, hit: null });
        done = true;
      }
      if (!done) sh.flown += segLen;

      // supersonic crack for shells passing close to the listener
      if (!sh.cracked && sh.team !== 'player') {
        const d = distPointSegment(listener, _a, _b);
        if (d < 25) {
          sh.cracked = true;
          onCrack(listener);
        }
      }

      if (sh.tracer) {
        const len = Math.min(segLen * 0.9, 18);
        sh.tracer.position.set(sh.s.x, sh.s.y, sh.s.z).addScaledVector(_dir, -len / 2);
        sh.tracer.quaternion.setFromUnitVectors(_z, _dir);
        sh.tracer.scale.z = len;
        sh.tracer.visible = sh.age > 0.03;
      }
      if (done || sh.age > 7 || sh.s.y < -200 || Math.abs(sh.s.x) > 6000 || Math.abs(sh.s.z) > 6000) {
        if (sh.tracer) this.effects.releaseTracer(sh.tracer);
        this.shells.splice(i, 1);
      }
    }
  }

  /** Called from the impact handler: the shell glances off and keeps flying. */
  ricochet(sh: Shell, worldNormal: THREE.Vector3): void {
    const v = _r.set(sh.s.vx, sh.s.vy, sh.s.vz);
    const dn = v.dot(worldNormal);
    v.addScaledVector(worldNormal, -2 * dn).multiplyScalar(0.35);
    v.x += (Math.random() - 0.5) * 60;
    v.y += Math.random() * 60;
    v.z += (Math.random() - 0.5) * 60;
    sh.s.vx = v.x;
    sh.s.vy = v.y;
    sh.s.vz = v.z;
    sh.ricochets++;
    sh.bounce = sh.ricochets < 3;
  }
}

function distPointSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2)) : 0;
  return hyp3(a.x + abx * t - p.x, a.y + aby * t - p.y, a.z + abz * t - p.z);
}
