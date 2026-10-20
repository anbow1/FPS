import * as THREE from 'three/webgpu';
import { PLAY_HALF, WATER_LEVEL } from '../config';
import { Rng } from '../core/rng';
import { obbDistance, type World } from '../world/world';
import { aimDirection, timeOfFlight } from './ballistics';
import type { Tank } from './tank';
import { halfX, halfZ, insideCityBounds, lineX, lineZ, PITCH_X, PITCH_Z } from '../world/cityPlan';
import { CITY } from '../config';
import { hyp2 } from '../core/mathx';

const PROBE_OFFSETS = [0, -0.45, 0.45, -0.9, 0.9, -1.4, 1.4];

type State = 'patrol' | 'engage' | 'search' | 'reposition' | 'unstick';

const _v = new THREE.Vector3();
const _to = new THREE.Vector3();
const _m = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = { x: 0, y: 0, z: 0 };
const _near: number[] = [];
const _snap = { x: 0, z: 0 };

/**
 * Enemy commander: perceives with terrain line-of-sight, leads moving targets using the same
 * ballistic solver as the player's FCS, fires from short halts and relocates after a couple of
 * shots (shoot-and-scoot). Aim error settles over time, faster at higher skill.
 */
export class TankAI {
  state: State = 'patrol';
  private goal = new THREE.Vector2();
  private rng: Rng;
  private thinkT = 0;
  private lastSeen = new THREE.Vector3();
  private lastSeenT = -999;
  private visible = false;
  private errMil = 6;
  private errDir = new THREE.Vector2();
  private shotsHere = 0;
  private stuckT = 0;
  /** heading probes are re-run at 10 Hz; steering uses the last result in between */
  private probeT = 0;
  private probeYaw = 0;
  private probeWant = Number.NaN;
  private unstickT = 0;
  private haltT = 0;
  private hpAtThink: number;
  private tof = 1;
  private angleOffset: number;

  constructor(
    readonly tank: Tank,
    private readonly skill: number,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.hpAtThink = tank.hp;
    this.angleOffset = (this.rng.next() < 0.5 ? -1 : 1) * this.rng.range(0.25, 0.45);
    this.pickPatrolGoal();
  }

  private pickPatrolGoal(): void {
    const t = this.tank;
    for (let i = 0; i < 10; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const d = this.rng.range(120, 380);
      const x = Math.max(-PLAY_HALF + 60, Math.min(PLAY_HALF - 60, t.pos.x + Math.cos(a) * d));
      const z = Math.max(-PLAY_HALF + 60, Math.min(PLAY_HALF - 60, t.pos.z + Math.sin(a) * d));
      this.goal.set(x, z);
      return;
    }
  }

  update(dt: number, world: World, target: Tank, time: number, onFire: (t: Tank) => void): void {
    const t = this.tank;
    if (!t.alive) return;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.2 + this.rng.next() * 0.1;
      this.think(world, target, time);
    }

    // aim: lead the target, add the (shrinking) aim error
    const knows = time - this.lastSeenT < 12;
    if (knows && target.alive) {
      target.centre(_to);
      if (this.visible) _to.addScaledVector(target.velocity, this.tof * (0.6 + 0.4 * this.skill));
      else _to.copy(this.lastSeen);
      const dist = t.pos.distanceTo(_to);
      const err = (this.errMil / 1000) * dist;
      _to.x += this.errDir.x * err;
      _to.y += this.errDir.y * err * 0.6;
      _to.z -= this.errDir.x * err * 0.3;
      t.muzzlePosition(_m);
      aimDirection(t.ammoSpec, _m, _to, _dir);
      t.aimDir.set(_dir.x, _dir.y, _dir.z);
    } else {
      // look where we are going
      _aim.set(Math.sin(t.yaw), 0.02, Math.cos(t.yaw));
      t.aimDir.lerp(_aim, dt * 0.5).normalize();
    }

    // settle aim while stationary, degrade while moving
    const moving = Math.abs(t.speed) > 1 || target.velocity.lengthSq() > 4;
    const settle = (0.35 + this.skill * 0.6) * (moving ? 0.35 : 1);
    const floor = 0.35 + (1 - this.skill) * 1.2 + (moving ? 1 : 0);
    this.errMil = floor + (this.errMil - floor) * Math.exp(-settle * dt);

    // fire decision
    this.haltT -= dt;
    if (this.state === 'engage' && this.visible && t.canFire()) {
      const aligned = t.aimError() < 0.0025;
      if (aligned && this.errMil < floor + 0.6 && Math.abs(t.speed) < 2.5) {
        onFire(t);
        this.shotsHere++;
        this.errMil += 1.5;
        this.errDir.set(this.rng.gauss(), this.rng.gauss()).normalize();
        if (this.shotsHere >= 2 + this.rng.int(0, 1)) this.startReposition(target);
      }
    }
    this.drive(dt, world);
  }

  private think(world: World, target: Tank, time: number): void {
    const t = this.tank;
    t.centre(_v);
    _v.y += 0.8;
    target.centre(_to);
    _to.y += 0.6;
    const dist = _v.distanceTo(_to);
    this.visible = target.alive && dist < 2600 && world.lineOfSight(_v.x, _v.y, _v.z, _to.x, _to.y, _to.z);
    const heardShot = time - target.lastShotTime < 1 && dist < 1800;
    const wasHit = t.hp < this.hpAtThink && t.lastHitBy === target;
    this.hpAtThink = t.hp;
    if (this.visible || heardShot || wasHit) {
      this.lastSeen.copy(target.pos);
      this.lastSeenT = time;
    }
    if (this.visible) {
      this.tof = timeOfFlight(t.ammoSpec, dist, _to.y - _v.y);
    }
    if (wasHit && this.state === 'engage' && this.rng.next() < 0.5) this.startReposition(target);

    // prefer HE on soft targets? tanks only here: APFSDS long range, HEAT close
    t.selectAmmo(dist > 1400 ? 'APFSDS' : this.rng.next() < 0.7 ? 'APFSDS' : 'HEAT');

    switch (this.state) {
      case 'patrol':
        if (this.visible || time - this.lastSeenT < 1) this.state = this.visible ? 'engage' : 'search';
        else if (hyp2(this.goal.x - t.pos.x, this.goal.y - t.pos.z) < 25) this.pickPatrolGoal();
        break;
      case 'search':
        this.goal.set(this.lastSeen.x, this.lastSeen.z);
        if (this.visible) this.state = 'engage';
        else if (time - this.lastSeenT > 25) this.state = 'patrol';
        break;
      case 'engage':
        if (!this.visible) {
          if (time - this.lastSeenT > 3) this.state = 'search';
        } else {
          // hold at a good range, angled so the front armour is presented obliquely
          const ideal = 900 + this.skill * 400;
          if (dist > ideal + 400) this.goal.set(target.pos.x, target.pos.z);
          else if (dist < 350) this.goal.set(t.pos.x + (t.pos.x - target.pos.x), t.pos.z + (t.pos.z - target.pos.z));
          else this.goal.set(t.pos.x, t.pos.z);
        }
        break;
      case 'reposition':
        if (hyp2(this.goal.x - t.pos.x, this.goal.y - t.pos.z) < 12 || this.haltT < -12) {
          this.state = this.visible ? 'engage' : 'search';
          this.shotsHere = 0;
        }
        break;
      case 'unstick':
        break;
    }
  }

  private startReposition(target: Tank): void {
    const t = this.tank;
    const dx = t.pos.x - target.pos.x;
    const dz = t.pos.z - target.pos.z;
    const d = hyp2(dx, dz) || 1;
    const side = this.rng.next() < 0.5 ? -1 : 1;
    const lat = this.rng.range(40, 90) * side;
    const back = this.rng.range(-10, 40);
    this.goal.set(t.pos.x + (-dz / d) * lat + (dx / d) * back, t.pos.z + (dx / d) * lat + (dz / d) * back);
    this.state = 'reposition';
    this.haltT = 0;
  }

  /** Steering with slope/water/building/tank avoidance probes. */
  /** Scores a fan of headings 16 m ahead: slopes, water, map edge, buildings and rocks. */
  private probe(wantYaw: number, world: World): number {
    const t = this.tank;
    let best = wantYaw;
    let bestScore = -Infinity;
    const h0 = world.hf.heightAt(t.pos.x, t.pos.z);
    const buildings = world.buildings;
    const rocks = world.vegetation.rocks;
    for (let k = 0; k < PROBE_OFFSETS.length; k++) {
      const off = PROBE_OFFSETS[k]!;
      const yaw = wantYaw + off;
      const px = t.pos.x + Math.sin(yaw) * 16;
      const pz = t.pos.z + Math.cos(yaw) * 16;
      const h = world.hf.heightAt(px, pz);
      let score = -Math.abs(off) * 1.2;
      const slope = Math.abs(h - h0) / 16;
      if (slope > 0.4) score -= 6;
      if (WATER_LEVEL - h > 0.9) score -= 8;
      if (Math.abs(px) > PLAY_HALF || Math.abs(pz) > PLAY_HALF) score -= 10;
      for (const i of world.nearBuildings(px, pz, 6, _near)) if (obbDistance(buildings[i]!, px, pz) < 6) score -= 5;
      for (let i = 0; i < rocks.length; i++) {
        const r = rocks[i]!;
        const dx = r.x - px;
        const dz = r.z - pz;
        const rr = r.r + 4;
        if (dx * dx + dz * dz < rr * rr) score -= 3;
      }
      if (score > bestScore) {
        bestScore = score;
        best = yaw;
      }
    }
    return best;
  }

  private drive(dt: number, world: World): void {
    const t = this.tank;
    if (this.state === 'unstick') {
      this.unstickT -= dt;
      t.throttle = -0.8;
      t.steer = 0.6;
      if (this.unstickT <= 0) this.state = 'patrol';
      return;
    }
    const gd = hyp2(this.goal.x - t.pos.x, this.goal.y - t.pos.z);
    // in the town the tank follows the streets to its goal (townWaypoint); elsewhere straight at it
    townWaypoint(world, t.pos.x, t.pos.z, this.goal.x, this.goal.y, _snap);
    let wantYaw = Math.atan2(_snap.x - t.pos.x, _snap.z - t.pos.z);
    let throttle = this.state === 'patrol' ? 0.55 : 0.9;
    if (this.state === 'engage') {
      // short halt, hull angled towards the threat
      const tx = this.lastSeen.x - t.pos.x;
      const tz = this.lastSeen.z - t.pos.z;
      if (gd < 20) {
        wantYaw = Math.atan2(tx, tz) + this.angleOffset;
        throttle = 0;
      }
    }
    if (gd < 8 && this.state !== 'engage') throttle = 0;
    // probe candidate headings (10 Hz, or at once when the wanted heading swings)
    this.probeT -= dt;
    if (this.probeT <= 0 || !(Math.abs(wantYaw - this.probeWant) < 0.3)) {
      this.probeT = 0.1;
      this.probeWant = wantYaw;
      this.probeYaw = this.probe(wantYaw, world);
    }
    const best = this.probeYaw;
    let d = best - t.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    t.steer = Math.max(-1, Math.min(1, -d * 2.2));
    t.throttle = throttle * Math.max(0.15, Math.cos(d));
    if (Math.abs(d) > 1.2 && throttle > 0) t.throttle = 0.15;
    // stuck detection
    if (t.throttle > 0.4 && Math.abs(t.speed) < 0.4 && t.mobile) {
      this.stuckT += dt;
      if (this.stuckT > 3) {
        this.stuckT = 0;
        this.unstickT = 2.5;
        this.state = 'unstick';
      }
    } else this.stuckT = 0;
  }
}

/**
 * Where to drive next toward a goal when the town is involved: along the street the tank is on to
 * the cross street nearest the goal, then along that one (a Manhattan route on the grid); off the
 * streets (a courtyard, the square) back to the nearest one first. Outside the town, the goal itself
 * (snapped onto a street if it lies in the town). Writes `out`.
 */
export function townWaypoint(world: World, x: number, z: number, goalX: number, goalZ: number, out: { x: number; z: number }): void {
  const city = world.city;
  out.x = goalX;
  out.z = goalZ;
  if (insideCityBounds(goalX, goalZ)) city.snapToStreet(goalX, goalZ, out);
  if (!insideCityBounds(x, z)) return;
  const gx = out.x;
  const gz = out.z;
  const kx = Math.min(CITY.blocksX, Math.max(0, Math.round((x - CITY.x0M) / PITCH_X)));
  const kz = Math.min(CITY.blocksZ, Math.max(0, Math.round((z - CITY.z0M) / PITCH_Z)));
  const onX = Math.abs(x - lineX(kx)) < halfX(kx) + 2 && city.isStreet(lineX(kx), z);
  const onZ = Math.abs(z - lineZ(kz)) < halfZ(kz) + 2 && city.isStreet(x, lineZ(kz));
  const kgx = Math.min(CITY.blocksX, Math.max(0, Math.round((gx - CITY.x0M) / PITCH_X)));
  const kgz = Math.min(CITY.blocksZ, Math.max(0, Math.round((gz - CITY.z0M) / PITCH_Z)));
  if (onX && onZ) {
    // at a junction: take the axis with more of the way left
    if (Math.abs(gx - x) > Math.abs(gz - z)) {
      out.x = kgx === kx ? gx : lineX(kgx);
      out.z = lineZ(kz);
    } else {
      out.x = lineX(kx);
      out.z = kgz === kz ? gz : lineZ(kgz);
    }
  } else if (onX) {
    // running along z on the x-line: to the goal if it is on this street, else to the junction
    out.x = lineX(kx);
    out.z = Math.abs(gx - lineX(kx)) < 3 ? gz : lineZ(kgz);
  } else if (onZ) {
    out.x = Math.abs(gz - lineZ(kz)) < 3 ? gx : lineX(kgx);
    out.z = lineZ(kz);
  } else {
    city.snapToStreet(x, z, out);
  }
}
