import { JEEP, LAGOON_PLAYER, PHYSICS, WATER_LEVEL_M } from '../config.ts';
import type { CollisionWorld } from './colliders.ts';
import type { EventQueue, P3 } from './events.ts';
import { heightAt, LAGOON_CENTRE, surfaceAt } from './terrain.ts';

// The old jeep parked by the shelter: a light 4×4 on soft sand.
//
// Driving is a bicycle model: the engine pushes with min(peak tractive force,
// power / speed), rolling resistance depends on what the tyres are on (soft
// sand drags ~4× more than turf), gravity pulls along the slope, and the yaw
// rate follows v·tan(steer)/wheelbase, capped by what the tyres can grip
// (v·ω ≤ μ·g), so a fast turn on sand runs wide instead of spinning. The
// body rides four sampled wheel heights: it pitches and rolls over dunes on
// springs and leans out of corners. Tree trunks, rocks and the shelter push
// it back; deeper than the air intake it will not go.

export interface JeepIntent {
  /** −1 (brake / reverse) … 1 (accelerate). */
  throttle: number;
  /** −1 (left) … 1 (right). */
  steer: number;
}

export type JeepDoor = 'driver' | 'passenger';

export class Jeep {
  readonly pos: P3;
  readonly prev: P3;
  yawRad: number;
  prevYawRad: number;
  /** Forward speed (m/s); negative in reverse. */
  speedMs = 0;
  yawRate = 0;
  pitchRad = 0; // + nose up
  rollRad = 0; // + right side down
  steerRad = 0;
  throttle = 0;
  /** 0 … 1, engine speed as heard. */
  rpm = 0;
  engineRunning = false;
  occupied = false;
  headlights = false;
  /** Wheel rotation (rad), for drawing. */
  wheelAngle = 0;
  /** Door and bonnet openings, 0 shut … 1 open; they swing toward their targets. */
  readonly doors: Record<JeepDoor, number> = { driver: 0, passenger: 0 };
  readonly doorTarget: Record<JeepDoor, number> = { driver: 0, passenger: 0 };
  bonnet = 0;
  bonnetTarget = 0;
  private bumpCooldownS = 0;
  private readonly tmp: P3 = { x: 0, y: 0, z: 0 };

  constructor(pos: P3, yawRad: number) {
    this.pos = { ...pos };
    this.pos.y = this.restHeight();
    this.prev = { ...this.pos };
    this.yawRad = yawRad;
    this.prevYawRad = yawRad;
  }

  axes(): { fx: number; fz: number; rx: number; rz: number } {
    const s = Math.sin(this.yawRad);
    const c = Math.cos(this.yawRad);
    return { fx: -s, fz: -c, rx: c, rz: -s };
  }

  /** A point in the jeep's frame (along + forward, up, across + right), in the world, pitch and roll included. */
  toWorld(along: number, up: number, across: number, out: P3): P3 {
    const { fx, fz, rx, rz } = this.axes();
    out.x = this.pos.x + fx * along + rx * across;
    out.z = this.pos.z + fz * along + rz * across;
    out.y = this.pos.y + up + Math.sin(this.pitchRad) * along - Math.sin(this.rollRad) * across;
    return out;
  }

  step(intent: JeepIntent, dt: number, collision: CollisionWorld, events: EventQueue): void {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
    this.prevYawRad = this.yawRad;
    this.bumpCooldownS = Math.max(0, this.bumpCooldownS - dt);
    this.swing(dt);

    if (this.occupied && !this.engineRunning && Math.abs(intent.throttle) > 0.1) {
      this.engineRunning = true;
      events.push({ type: 'jeep', what: 'start' });
    }
    const throttleIn = this.occupied ? intent.throttle : 0;
    this.throttle += (throttleIn - this.throttle) * Math.min(1, dt * 4);
    // Less lock at speed, as a driver gives.
    const lock = JEEP.maxSteerRad / (1 + Math.abs(this.speedMs) / 9);
    this.steerRad += ((this.occupied ? intent.steer : 0) * lock - this.steerRad) * Math.min(1, dt * 5);

    this.drive(dt);
    this.settle(dt);
    this.obstacles(collision, events);
    this.border();
    this.wheelAngle += (this.speedMs / JEEP.wheelRadiusM) * dt;
    const rpmTarget = this.engineRunning ? 0.15 + 0.6 * Math.min(1, Math.abs(this.speedMs) / JEEP.maxSpeedMs) + 0.25 * Math.abs(this.throttle) : 0;
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * 4);
  }

  private drive(dt: number): void {
    const surface = surfaceAt(this.pos.x, this.pos.z);
    const soft = surface === 'sand' || surface === 'wetSand';
    const crr = soft ? JEEP.rollingSand : JEEP.rollingFirm;
    const mu = soft ? JEEP.gripSand : JEEP.gripFirm;
    const g = PHYSICS.gravityMs2;
    const v = this.speedMs;
    const m = JEEP.massKg;
    let force = 0;
    const run = this.engineRunning ? 1 : 0;
    if (this.throttle > 0.02) {
      force += run * this.throttle * Math.min(JEEP.peakTractionN, JEEP.powerW / Math.max(1, Math.abs(v)));
    } else if (this.throttle < -0.02) {
      // Brake while rolling forward, then reverse.
      if (v > 0.3) force -= -this.throttle * JEEP.brakeN;
      else force -= run * -this.throttle * JEEP.peakTractionN * 0.6;
    }
    // Resistance: rolling (opposes motion), aero, and gravity along the slope.
    const rolling = crr * m * g;
    const resist = rolling * Math.sign(v) + JEEP.aeroNs2m2 * v * Math.abs(v);
    force -= resist;
    force -= m * g * Math.sin(this.pitchRad);
    let nv = v + (force / m) * dt;
    // Rolling resistance stops a slow jeep instead of reversing it.
    if (Math.sign(nv) !== Math.sign(v) && v !== 0 && Math.abs(this.throttle) < 0.02) nv = 0;
    if (Math.abs(nv) < 0.05 && Math.abs(this.throttle) < 0.02 && Math.abs(Math.sin(this.pitchRad)) < crr) nv = 0;
    this.speedMs = Math.max(-JEEP.maxReverseMs, Math.min(JEEP.maxSpeedMs, nv));
    // Turning: kinematic yaw rate, capped by grip. Yaw is positive to the left.
    let want = (-this.speedMs * Math.tan(this.steerRad)) / JEEP.wheelbaseM;
    const cap = (mu * g) / Math.max(1, Math.abs(this.speedMs));
    want = Math.max(-cap, Math.min(cap, want));
    this.yawRate += (want - this.yawRate) * Math.min(1, dt * 8);
    this.yawRad += this.yawRate * dt;
    const { fx, fz } = this.axes();
    this.pos.x += fx * this.speedMs * dt;
    this.pos.z += fz * this.speedMs * dt;
  }

  /** Ride height, pitch and roll from the four wheels' ground heights, on springs; lean out of a corner. */
  private settle(dt: number): void {
    const hw = JEEP.trackM / 2;
    const hl = JEEP.wheelbaseM / 2;
    const { fx, fz, rx, rz } = this.axes();
    const at = (a: number, c: number): number => heightAt(this.pos.x + fx * a + rx * c, this.pos.z + fz * a + rz * c);
    const fl = at(hl, -hw);
    const fr = at(hl, hw);
    const rl = at(-hl, -hw);
    const rr = at(-hl, hw);
    const targetY = (fl + fr + rl + rr) / 4 + JEEP.rideHeightM;
    const targetPitch = Math.atan2((fl + fr - rl - rr) / 2, JEEP.wheelbaseM);
    // Turning right (yaw rate < 0 going forward) throws the body left: left side down is negative roll.
    const lean = this.speedMs * this.yawRate * JEEP.leanPerMs2;
    const targetRoll = Math.atan2((fl + rl - fr - rr) / 2, JEEP.trackM) + lean;
    const k = Math.min(1, dt * 10);
    this.pos.y += (targetY - this.pos.y) * k;
    this.pitchRad += (targetPitch - this.pitchRad) * k;
    this.rollRad += (targetRoll - this.rollRad) * Math.min(1, dt * 6);
  }

  /** Trunks, rocks and the shelter push the body back; a bank too steep or water too deep stops it. */
  private obstacles(collision: CollisionWorld, events: EventQueue): void {
    const { fx, fz } = this.axes();
    let hit = false;
    for (const along of [JEEP.lengthM * 0.28, -JEEP.lengthM * 0.28]) {
      const p = this.tmp;
      p.x = this.pos.x + fx * along;
      p.z = this.pos.z + fz * along;
      p.y = this.pos.y;
      const x0 = p.x;
      const z0 = p.z;
      collision.pushOut(p, JEEP.widthM * 0.5, this.pos.y - JEEP.rideHeightM + 0.25, this.pos.y + 1.2);
      if (Math.hypot(p.x - x0, p.z - z0) > 1e-6) {
        this.pos.x += p.x - x0;
        this.pos.z += p.z - z0;
        hit = true;
      }
    }
    // The intake is at the bonnet: deeper water than this stalls the engine, so it is not entered.
    const nose = this.toWorld(JEEP.lengthM * 0.45, 0, 0, this.tmp);
    const wet = WATER_LEVEL_M - heightAt(nose.x, nose.z) > JEEP.maxWadeM;
    if (wet) {
      this.pos.x = this.prev.x;
      this.pos.z = this.prev.z;
      hit = true;
    }
    if (hit) {
      if (Math.abs(this.speedMs) > 1.5 && this.bumpCooldownS <= 0) {
        this.bumpCooldownS = 0.5;
        events.push({ type: 'jeep', what: 'bump' });
      }
      this.speedMs *= -0.15;
    }
  }

  private border(): void {
    const dx = this.pos.x - LAGOON_CENTRE.x;
    const dz = this.pos.z - LAGOON_CENTRE.z;
    const r = Math.hypot(dx, dz);
    const max = LAGOON_PLAYER.borderEndM;
    if (r > max) {
      this.pos.x = LAGOON_CENTRE.x + (dx / r) * max;
      this.pos.z = LAGOON_CENTRE.z + (dz / r) * max;
      this.speedMs *= 0.5;
    }
  }

  private swing(dt: number): void {
    const k = Math.min(1, dt * 4);
    for (const d of ['driver', 'passenger'] as const) this.doors[d] += (this.doorTarget[d] - this.doors[d]) * k;
    this.bonnet += (this.bonnetTarget - this.bonnet) * Math.min(1, dt * 2.5);
  }

  private restHeight(): number {
    return heightAt(this.pos.x, this.pos.z) + JEEP.rideHeightM;
  }
}
