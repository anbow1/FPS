import { BOAT, LAGOON_PLAYER, WATER_LEVEL_M } from '../config.ts';
import type { CollisionWorld } from './colliders.ts';
import type { EventQueue, P3 } from './events.ts';
import { heightAt, LAGOON_CENTRE } from './terrain.ts';
import { waterSurfaceY } from './waves.ts';

// A small aluminium dinghy with an outboard, moored at the end of the dock.
//
// Floating: six points on the hull's waterplane (bow, stern, and both sides
// at the middle and aft) each push up with ρ·g·A·depth under the same waves
// the water is drawn with (game/waves.ts), plus a damper, so the hull heaves,
// pitches and rolls as the chop passes under it, and settles at the draft
// its weight asks for. Vertical motion, pitch and roll are integrated as a
// rigid body with the hull's mass and moments of inertia.
//
// Moving: the outboard pushes along the hull, turned by the tiller, with
// thrust falling off as the boat approaches the propeller's speed. Water
// resists moving sideways far more than forwards (the keel), and turning
// (yaw damping). Sand under the hull grounds it; dock piles push it off.

export interface BoatIntent {
  /** −1 (astern) … 1 (full ahead). */
  throttle: number;
  /** −1 (port) … 1 (starboard). */
  steer: number;
}

/** The six buoyancy points: along (+ bow), across (+ starboard), in the boat's frame (m). */
const POINTS: readonly (readonly [number, number])[] = [
  [BOAT.lengthM * 0.42, 0],
  [-BOAT.lengthM * 0.45, 0],
  [0, BOAT.beamM * 0.42],
  [0, -BOAT.beamM * 0.42],
  [-BOAT.lengthM * 0.3, BOAT.beamM * 0.42],
  [-BOAT.lengthM * 0.3, -BOAT.beamM * 0.42],
];
const RHO = 1025; // sea water, kg/m³
const G = 9.81;

export class Boat {
  /** Reference point: the middle of the hull at the waterline of a still sea. */
  readonly pos: P3;
  readonly prev: P3;
  /** World velocity (m/s). */
  readonly vel: P3 = { x: 0, y: 0, z: 0 };
  yawRad: number;
  prevYawRad: number;
  yawRate = 0;
  pitchRad = 0; // + bow up
  rollRad = 0; // + starboard down
  private pitchRate = 0;
  private rollRate = 0;
  throttle = 0;
  steer = 0;
  /** 0 … 1, the engine's speed as heard. */
  rpm = 0;
  engineRunning = false;
  occupied = false;
  grounded = false;
  private bumpCooldownS = 0;
  private readonly tmp: P3 = { x: 0, y: 0, z: 0 };

  constructor(pos: P3, yawRad: number) {
    this.pos = { ...pos };
    this.prev = { ...pos };
    this.yawRad = yawRad;
    this.prevYawRad = yawRad;
  }

  /** Forward and starboard unit vectors in the world (the player's convention: forward = −sin, −cos). */
  axes(): { fx: number; fz: number; rx: number; rz: number } {
    const s = Math.sin(this.yawRad);
    const c = Math.cos(this.yawRad);
    return { fx: -s, fz: -c, rx: c, rz: -s };
  }

  /** A point given in the boat's frame (along, up, across), in the world, ignoring pitch and roll above the deck. */
  toWorld(along: number, up: number, across: number, out: P3): P3 {
    const { fx, fz, rx, rz } = this.axes();
    out.x = this.pos.x + fx * along + rx * across;
    out.z = this.pos.z + fz * along + rz * across;
    out.y = this.pos.y + up + Math.sin(this.pitchRad) * along - Math.sin(this.rollRad) * across;
    return out;
  }

  /** Forward speed through the water (m/s). */
  get speedMs(): number {
    const { fx, fz } = this.axes();
    return this.vel.x * fx + this.vel.z * fz;
  }

  step(intent: BoatIntent, dt: number, timeS: number, waveScale: number, collision: CollisionWorld, events: EventQueue): void {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
    this.prevYawRad = this.yawRad;
    this.bumpCooldownS = Math.max(0, this.bumpCooldownS - dt);

    // Controls ease in: a tiller and a twist grip, not switches.
    const wantThrottle = this.occupied ? Math.max(-BOAT.reverseFraction, intent.throttle) : 0;
    this.throttle += (wantThrottle - this.throttle) * Math.min(1, dt * 2.5);
    this.steer += ((this.occupied ? intent.steer : 0) - this.steer) * Math.min(1, dt * 4);
    if (this.occupied && !this.engineRunning && Math.abs(intent.throttle) > 0.1) {
      this.engineRunning = true;
      events.push({ type: 'boat', what: 'engineStart' });
    }
    if (!this.occupied && this.engineRunning && Math.abs(this.throttle) < 0.02) this.engineRunning = false;
    const rpmTarget = this.engineRunning ? 0.18 + 0.82 * Math.abs(this.throttle) : 0;
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * 3);

    this.float(dt, timeS, waveScale);
    this.drive(dt);
    this.ground(dt, events);
    this.fend(collision, events);
    this.drift(dt);
  }

  /** Buoyancy at six points → heave force, pitch and roll torques; semi-implicit Euler. */
  private float(dt: number, timeS: number, waveScale: number): void {
    const area = (BOAT.waterplaneFraction * BOAT.lengthM * BOAT.beamM) / POINTS.length;
    const k = RHO * G * area;
    const c = BOAT.heaveDamping / POINTS.length;
    let force = -BOAT.massKg * G;
    let pitchTorque = 0;
    let rollTorque = 0;
    const { fx, fz, rx, rz } = this.axes();
    for (const [along, across] of POINTS) {
      const x = this.pos.x + fx * along + rx * across;
      const z = this.pos.z + fz * along + rz * across;
      const depthM = WATER_LEVEL_M - heightAt(x, z);
      const surface = waterSurfaceY(x, z, timeS, waveScale, depthM);
      const hullY = this.pos.y + Math.sin(this.pitchRad) * along - Math.sin(this.rollRad) * across - BOAT.keelBelowRefM;
      const immersed = Math.min(BOAT.hullDepthM, Math.max(0, surface - hullY));
      const vy = this.vel.y + this.pitchRate * along - this.rollRate * across;
      const f = immersed > 0 ? k * immersed - c * vy : 0;
      force += f;
      pitchTorque += f * along;
      rollTorque -= f * across;
    }
    // Under power the bow lifts a little, as a planing dinghy's does.
    pitchTorque += BOAT.massKg * Math.max(0, this.speedMs) * BOAT.squatNmPerKgMs;
    const iPitch = (BOAT.massKg * BOAT.lengthM * BOAT.lengthM) / 12;
    const iRoll = (BOAT.massKg * BOAT.beamM * BOAT.beamM) / 12;
    this.vel.y += (force / BOAT.massKg) * dt;
    this.pitchRate += (pitchTorque / iPitch - this.pitchRate * BOAT.angularDamping) * dt;
    this.rollRate += (rollTorque / iRoll - this.rollRate * BOAT.angularDamping) * dt;
    this.pos.y += this.vel.y * dt;
    this.pitchRad = clamp(this.pitchRad + this.pitchRate * dt, -0.5, 0.5);
    this.rollRad = clamp(this.rollRad + this.rollRate * dt, -0.6, 0.6);
  }

  /** Thrust along the hull, turned by the tiller; drag split into surge, sway and yaw. */
  private drive(dt: number): void {
    const { fx, fz, rx, rz } = this.axes();
    const u = this.vel.x * fx + this.vel.z * fz; // surge
    const v = this.vel.x * rx + this.vel.z * rz; // sway
    const run = this.engineRunning ? 1 : 0;
    const thrust = BOAT.maxThrustN * this.throttle * Math.max(0, 1 - Math.abs(u) / BOAT.propSpeedMs) * run;
    const delta = -this.steer * BOAT.maxTillerRad; // tiller to port swings the bow to starboard
    const surgeF = thrust * Math.cos(delta) - BOAT.surgeDragNs2m2 * u * Math.abs(u) - BOAT.surgeDragNsm * u;
    const swayF = thrust * Math.sin(delta) - BOAT.swayDragNs2m2 * v * Math.abs(v) - BOAT.swayDragNsm * v;
    // The propeller sits aft: side thrust there turns the bow the other way; the leg also steers like a rudder.
    // Yaw is positive toward port, so a starboard force F at `along` turns the boat by −F·along.
    const leverM = -BOAT.lengthM * 0.5;
    const rudder = -this.steer * u * Math.abs(u) * BOAT.rudderNmPerMs2;
    const iYaw = (BOAT.massKg * (BOAT.lengthM * BOAT.lengthM + BOAT.beamM * BOAT.beamM)) / 12;
    const yawTorque = -thrust * Math.sin(delta) * leverM + rudder - BOAT.yawDamping * this.yawRate - BOAT.yawDamping * 2 * this.yawRate * Math.abs(this.yawRate);
    this.yawRate += (yawTorque / iYaw) * dt;
    this.yawRad += this.yawRate * dt;
    const au = surgeF / BOAT.massKg;
    const av = swayF / BOAT.massKg;
    this.vel.x += (fx * au + rx * av) * dt;
    this.vel.z += (fz * au + rz * av) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // Banking into a turn.
    this.rollRate += -this.yawRate * u * 0.08 * dt;
  }

  /** Highest seabed (or beach) under any of the hull points at (x, z). */
  private highestBottom(x0: number, z0: number): number {
    const { fx, fz, rx, rz } = this.axes();
    let top = Number.NEGATIVE_INFINITY;
    for (const [along, across] of POINTS) top = Math.max(top, heightAt(x0 + fx * along + rx * across, z0 + fz * along + rz * across));
    return top;
  }

  /**
   * Sand under the keel: the hull sits on it and scrapes to a stop, and it is
   * never driven further up onto dry land (backing off still works).
   */
  private ground(dt: number, events: EventQueue): void {
    const bottom = this.highestBottom(this.pos.x, this.pos.z);
    if (bottom > WATER_LEVEL_M + 0.05 && bottom > this.highestBottom(this.prev.x, this.prev.z)) {
      this.pos.x = this.prev.x;
      this.pos.z = this.prev.z;
      this.vel.x = 0;
      this.vel.z = 0;
    }
    const deepest = this.highestBottom(this.pos.x, this.pos.z) + BOAT.keelBelowRefM;
    const wasGrounded = this.grounded;
    this.grounded = deepest > this.pos.y;
    if (!this.grounded) return;
    this.pos.y = deepest;
    if (this.vel.y < 0) this.vel.y = 0;
    const k = Math.exp(-dt * 4);
    this.vel.x *= k;
    this.vel.z *= k;
    this.yawRate *= k;
    if (!wasGrounded && Math.hypot(this.vel.x, this.vel.z) > 0.8) events.push({ type: 'boat', what: 'ground' });
  }

  /** Bow and stern pushed out of dock piles and rocks; a hard knock is heard. */
  private fend(collision: CollisionWorld, events: EventQueue): void {
    const { fx, fz } = this.axes();
    for (const along of [BOAT.lengthM * 0.3, -BOAT.lengthM * 0.3]) {
      const p = this.tmp;
      p.x = this.pos.x + fx * along;
      p.z = this.pos.z + fz * along;
      p.y = this.pos.y;
      const x0 = p.x;
      const z0 = p.z;
      collision.pushOut(p, BOAT.beamM * 0.5, this.pos.y - BOAT.keelBelowRefM, this.pos.y + 0.4);
      const dx = p.x - x0;
      const dz = p.z - z0;
      const d = Math.hypot(dx, dz);
      if (d < 1e-6) continue;
      this.pos.x += dx;
      this.pos.z += dz;
      const nx = dx / d;
      const nz = dz / d;
      const vn = this.vel.x * nx + this.vel.z * nz;
      if (vn < 0) {
        this.vel.x -= 1.3 * vn * nx;
        this.vel.z -= 1.3 * vn * nz;
        if (-vn > 0.6 && this.bumpCooldownS <= 0) {
          this.bumpCooldownS = 0.4;
          events.push({ type: 'boat', what: 'bump' });
        }
      }
    }
  }

  /** The same current that carries swimmers back at the edge of the world. */
  private drift(dt: number): void {
    const dx = this.pos.x - LAGOON_CENTRE.x;
    const dz = this.pos.z - LAGOON_CENTRE.z;
    const r = Math.hypot(dx, dz);
    const P = LAGOON_PLAYER;
    const t = Math.min(1, Math.max(0, (r - P.borderStartM) / (P.borderEndM - P.borderStartM)));
    if (t <= 0 || r < 1e-3) return;
    const push = P.borderCurrentMs * t * t * (3 - 2 * t) * 1.5;
    // Hard edge: the boat never leaves the world.
    if (r > P.borderEndM) {
      this.pos.x = LAGOON_CENTRE.x + (dx / r) * P.borderEndM;
      this.pos.z = LAGOON_CENTRE.z + (dz / r) * P.borderEndM;
    }
    this.vel.x -= (dx / r) * push * dt * 2;
    this.vel.z -= (dz / r) * push * dt * 2;
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}
