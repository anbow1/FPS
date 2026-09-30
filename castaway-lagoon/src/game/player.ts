import { LAGOON_PLAYER as P, PHYSICS, WATER_LEVEL_M } from '../config.ts';
import type { CollisionWorld } from './colliders.ts';
import type { EventQueue, P3 } from './events.ts';
import { heightAt, LAGOON_CENTRE, normalAt, type SurfaceKind } from './terrain.ts';
import { waterSurfaceY } from './waves.ts';

// First-person walker and swimmer: acceleration-based movement (no instant
// top speed, no instant stop), step-up onto the deck and dock, wading that
// slows you down, jumping, one footstep per stride. Deeper than swimDepthM the
// walker floats with the eye just above the chop (the same waves the water is
// drawn with, game/waves.ts), swims on the surface, dives while the dive key
// is held and, once under, swims where it looks. Breath runs down under water;
// with none left the swimmer is pushed back up. Past the border radius a
// current carries everyone back toward the lagoon.

export interface MoveIntent {
  moveRight: number; // −1..1
  moveForward: number; // −1..1
  sprint: boolean;
  jump: boolean;
  /** Held: swim down. */
  dive: boolean;
  /** Held: swim up. */
  rise: boolean;
  slowed: boolean; // aiming or busy: no sprint
}

/** Where the water is this step: game time and the weather's wave scale (game/waves.ts). */
export interface WaterState {
  timeS: number;
  waveScale: number;
}

const PLAY_RADIUS_M = P.borderEndM;
const HEAD_CLEARANCE_M = 1.8;
/** Feet below the surface when floating. */
const FLOAT_FEET_M = P.eyeHeightM - P.floatEyeAboveWaterM;

export class Player {
  readonly pos: P3;
  readonly prev: P3;
  readonly vel: P3 = { x: 0, y: 0, z: 0 };
  yawRad: number;
  pitchRad = -0.04;
  grounded = true;
  surface: SurfaceKind = 'sand';
  wadingDepthM = 0;
  sprinting = false;
  /** Floating or diving, not walking. */
  swimming = false;
  /** The eye is below the surface. */
  underwater = false;
  /** Seconds of air left. */
  airS: number = P.breathSeconds;
  /** Out of air: pushed up until the head is out. */
  gasping = false;
  /** Surface height at the player this step (m). */
  waterY = WATER_LEVEL_M;
  /** Current strength at the world's edge, 0–1 (HUD hint). */
  current = 0;
  private strokeS = 0;
  /** Advances with distance walked: drives head bob and hand sway. */
  stridePhase = 0;
  private strideAccumM = 0;
  private readonly groundInfo: { surface: SurfaceKind } = { surface: 'sand' };
  private readonly n = { x: 0, y: 1, z: 0 };

  constructor(spawn: P3, yawRad: number) {
    this.pos = { ...spawn };
    this.prev = { ...spawn };
    this.yawRad = yawRad;
  }

  get speedMs(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  look(dYawRad: number, dPitchRad: number): void {
    this.yawRad -= dYawRad;
    this.pitchRad = Math.max(-P.maxPitchRad, Math.min(P.maxPitchRad, this.pitchRad - dPitchRad));
  }

  forward(out: P3): P3 {
    const cp = Math.cos(this.pitchRad);
    out.x = -Math.sin(this.yawRad) * cp;
    out.y = Math.sin(this.pitchRad);
    out.z = -Math.cos(this.yawRad) * cp;
    return out;
  }

  eye(out: P3): P3 {
    out.x = this.pos.x;
    out.y = this.pos.y + P.eyeHeightM;
    out.z = this.pos.z;
    return out;
  }

  step(intent: MoveIntent, dt: number, collision: CollisionWorld, events: EventQueue, water: WaterState): void {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
    const depthHere = WATER_LEVEL_M - heightAt(this.pos.x, this.pos.z);
    this.waterY = waterSurfaceY(this.pos.x, this.pos.z, water.timeS, water.waveScale, depthHere);
    if (!this.swimming && this.grounded && depthHere > P.swimDepthM && this.onTerrain(collision)) {
      this.swimming = true;
      this.sprinting = false;
      events.push({ type: 'swim', what: 'start' });
    }
    if (this.swimming) this.swim(intent, dt, collision, events);
    else this.walk(intent, dt, collision, events);
    this.drift(dt);
    this.breathe(dt, events);
  }

  private onTerrain(collision: CollisionWorld): boolean {
    return collision.groundAt(this.pos.x, this.pos.z, this.pos.y, P.stepHeightM) <= heightAt(this.pos.x, this.pos.z) + 1e-3;
  }

  private walk(intent: MoveIntent, dt: number, collision: CollisionWorld, events: EventQueue): void {
    const len = Math.hypot(intent.moveRight, intent.moveForward);
    const ix = len > 1 ? intent.moveRight / len : intent.moveRight;
    const iz = len > 1 ? intent.moveForward / len : intent.moveForward;
    const sin = Math.sin(this.yawRad);
    const cos = Math.cos(this.yawRad);
    // Right = (cos, 0, −sin), forward = (−sin, 0, −cos).
    const wishX = ix * cos - iz * sin;
    const wishZ = -ix * sin - iz * cos;
    const hasInput = len > 0.01;
    this.sprinting = intent.sprint && !intent.slowed && iz > 0.3 && this.wadingDepthM < 0.3 && hasInput;
    const wadeK = 1 - (1 - P.wadeSpeedFactor) * Math.min(1, this.wadingDepthM / 0.7);
    const target = (this.sprinting ? P.sprintSpeedMs : P.walkSpeedMs) * wadeK * (intent.slowed ? 0.6 : 1);
    if (this.grounded) {
      const desiredX = hasInput ? wishX * target : 0;
      const desiredZ = hasInput ? wishZ * target : 0;
      const dx = desiredX - this.vel.x;
      const dz = desiredZ - this.vel.z;
      const d = Math.hypot(dx, dz);
      const maxDv = (hasInput ? P.groundAccelMs2 : P.groundFrictionMs2) * dt;
      if (d <= maxDv) {
        this.vel.x = desiredX;
        this.vel.z = desiredZ;
      } else {
        this.vel.x += (dx / d) * maxDv;
        this.vel.z += (dz / d) * maxDv;
      }
      if (intent.jump && this.wadingDepthM < 0.5) {
        this.vel.y = P.jumpSpeedMs;
        this.grounded = false;
        events.push({ type: 'jump', surface: this.surface });
      }
    } else if (hasInput) {
      this.vel.x += wishX * P.airAccelMs2 * dt;
      this.vel.z += wishZ * P.airAccelMs2 * dt;
    }
    if (!this.grounded) this.vel.y -= PHYSICS.gravityMs2 * dt;

    const oldX = this.pos.x;
    const oldZ = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    collision.pushOut(this.pos, P.radiusM, this.pos.y + P.stepHeightM, this.pos.y + HEAD_CLEARANCE_M);
    this.limit(oldX, oldZ, collision);

    const ground = collision.groundAt(this.pos.x, this.pos.z, Math.max(this.pos.y, this.prev.y), P.stepHeightM, this.groundInfo);
    const wasGrounded = this.grounded;
    if (this.pos.y <= ground + 0.02 && this.vel.y <= 0) {
      if (!wasGrounded) {
        const impact = -this.vel.y;
        events.push({ type: 'land', surface: this.groundInfo.surface, impactSpeedMs: impact });
      }
      this.pos.y = ground;
      this.vel.y = 0;
      this.grounded = true;
    } else if (wasGrounded && this.pos.y - ground < P.stepHeightM && this.vel.y <= 0) {
      this.pos.y = ground; // walk down gentle slopes and steps without hopping
    } else if (this.pos.y > ground + 0.02) {
      this.grounded = false;
    }
    this.surface = this.groundInfo.surface;
    const onTerrain = ground <= heightAt(this.pos.x, this.pos.z) + 1e-3;
    this.wadingDepthM = onTerrain ? Math.max(0, WATER_LEVEL_M - this.pos.y) : 0;
    if (this.wadingDepthM > 0.04) this.surface = 'water';

    const moved = Math.hypot(this.pos.x - oldX, this.pos.z - oldZ);
    this.stridePhase += (moved / P.strideM) * Math.PI;
    if (this.grounded) {
      this.strideAccumM += moved;
      const stride = this.sprinting ? P.strideM * 1.35 : P.strideM;
      if (this.strideAccumM >= stride * 0.5) {
        this.strideAccumM = 0;
        events.push({ type: 'footstep', surface: this.surface, pos: { ...this.pos }, running: this.sprinting, wadingDepthM: this.wadingDepthM });
      }
    }
  }

  /**
   * Swimming: velocity eases toward the stroke (water drag), the float height
   * rides the chop, the seabed is a floor, and shallow enough water with the
   * feet on the bottom turns the swimmer back into a walker.
   */
  private swim(intent: MoveIntent, dt: number, collision: CollisionWorld, events: EventQueue): void {
    const floatY = this.waterY - FLOAT_FEET_M;
    const len = Math.hypot(intent.moveRight, intent.moveForward);
    const ix = len > 1 ? intent.moveRight / len : intent.moveRight;
    const iz = len > 1 ? intent.moveForward / len : intent.moveForward;
    const sin = Math.sin(this.yawRad);
    const cos = Math.cos(this.yawRad);
    const submerged = this.pos.y < floatY - 0.3;
    const fast = intent.sprint && !intent.slowed && iz > 0.3;
    const speed = fast ? P.swimSprintMs : P.swimSpeedMs;
    // Under water forward follows the look, pitch included; on the surface it stays level.
    const cp = submerged ? Math.cos(this.pitchRad) : 1;
    let wantX = (ix * cos - iz * sin * cp) * speed;
    let wantZ = (-ix * sin - iz * cos * cp) * speed;
    let wantY = submerged ? iz * Math.sin(this.pitchRad) * speed : 0;
    if (this.gasping) wantY = P.ascendSpeedMs * 1.4;
    else if (intent.dive) wantY = -P.diveSpeedMs;
    else if (intent.rise) wantY = P.ascendSpeedMs;
    else if (!submerged) wantY = (floatY - this.pos.y) * 3; // bob with the chop
    else wantY += 0.25; // lungs full of air: a slow drift up
    if (this.gasping) {
      wantX *= 0.3;
      wantZ *= 0.3;
    }
    const k = Math.min(1, dt * P.swimResponse);
    this.vel.x += (wantX - this.vel.x) * k;
    this.vel.z += (wantZ - this.vel.z) * k;
    this.vel.y += (wantY - this.vel.y) * Math.min(1, dt * P.swimResponse * 2);

    const oldX = this.pos.x;
    const oldZ = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    collision.pushOut(this.pos, P.radiusM, this.pos.y + 0.2, this.pos.y + HEAD_CLEARANCE_M);
    this.limit(oldX, oldZ, collision);
    const floor = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
    }
    if (this.pos.y > floatY && !this.gasping) {
      this.pos.y = floatY;
      if (this.vel.y > 0) this.vel.y = 0;
    }
    this.grounded = false;
    this.sprinting = fast;
    this.surface = 'water';
    this.wadingDepthM = Math.max(0, this.waterY - this.pos.y);

    // Standing again: shallow water and the feet on the bottom.
    const depth = WATER_LEVEL_M - floor;
    if (depth < P.swimDepthM - 0.1 && this.pos.y <= floor + 0.05 && !intent.dive) {
      this.swimming = false;
      this.grounded = true;
      this.pos.y = floor;
      this.vel.y = 0;
      events.push({ type: 'swim', what: 'stand' });
      return;
    }
    const moved = Math.hypot(this.pos.x - oldX, this.pos.z - oldZ);
    this.stridePhase += (moved / P.strideM) * Math.PI * 0.5;
    this.strokeS += dt * (fast ? 1.4 : 1);
    if ((len > 0.1 || intent.dive || intent.rise) && this.strokeS >= P.swimStrokeSeconds) {
      this.strokeS = 0;
      events.push({ type: 'swimStroke', pos: { ...this.pos }, underwater: this.underwater, fast });
    }
  }

  /** Past the border a current carries the player back toward the lagoon's middle. */
  private drift(dt: number): void {
    const dx = this.pos.x - LAGOON_CENTRE.x;
    const dz = this.pos.z - LAGOON_CENTRE.z;
    const r = Math.hypot(dx, dz);
    const t = Math.min(1, Math.max(0, (r - P.borderStartM) / (P.borderEndM - P.borderStartM)));
    this.current = t * t * (3 - 2 * t);
    if (this.current <= 0 || r < 1e-3) return;
    const push = P.borderCurrentMs * this.current * dt;
    this.pos.x -= (dx / r) * push;
    this.pos.z -= (dz / r) * push;
  }

  /** Air runs down under water and comes back at the surface; with none left the swimmer is pushed up. */
  private breathe(dt: number, events: EventQueue): void {
    const was = this.underwater;
    this.underwater = this.pos.y + P.eyeHeightM < this.waterY - 0.03;
    if (this.underwater !== was) events.push({ type: 'swim', what: this.underwater ? 'under' : 'surface', airFraction: this.airS / P.breathSeconds });
    if (this.underwater) {
      this.airS = Math.max(0, this.airS - dt);
      if (this.airS === 0 && !this.gasping) {
        this.gasping = true;
        events.push({ type: 'swim', what: 'outOfAir' });
      }
    } else {
      this.airS = Math.min(P.breathSeconds, this.airS + dt * P.breathRecoveryPerS);
      if (this.gasping && this.airS > P.breathSeconds * 0.3) this.gasping = false;
    }
  }

  /** Cliffs too steep to walk and the edge of the play area stop the walker. */
  private limit(oldX: number, oldZ: number, collision: CollisionWorld): void {
    if (this.blocked(this.pos.x, this.pos.z, collision)) {
      if (!this.blocked(this.pos.x, oldZ, collision)) this.pos.z = oldZ;
      else if (!this.blocked(oldX, this.pos.z, collision)) this.pos.x = oldX;
      else {
        this.pos.x = oldX;
        this.pos.z = oldZ;
      }
    }
  }

  private blocked(x: number, z: number, collision: CollisionWorld): boolean {
    if (Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z) > PLAY_RADIUS_M) return true;
    const ground = collision.groundAt(x, z, this.pos.y, P.stepHeightM);
    const terrain = heightAt(x, z);
    if (ground > terrain + 1e-3) return false; // on the deck or the dock
    if (this.swimming) return terrain > this.waterY - 0.3 && terrain > this.pos.y + P.stepHeightM; // a rock face out of the water
    normalAt(x, z, this.n);
    return this.n.y < 0.6 && terrain > this.pos.y + 0.05;
  }
}
