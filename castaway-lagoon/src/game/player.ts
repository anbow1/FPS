import { LAGOON_PLAYER as P, PHYSICS, WATER_LEVEL_M } from '../config.ts';
import type { CollisionWorld } from './colliders.ts';
import type { EventQueue, P3 } from './events.ts';
import { heightAt, LAGOON_CENTRE, normalAt, type SurfaceKind } from './terrain.ts';

// First-person walker: acceleration-based movement (no instant top speed, no
// instant stop), step-up onto the deck and dock, wading that slows you down
// and stops you at chest depth, jumping, and one footstep per stride.

export interface MoveIntent {
  moveRight: number; // −1..1
  moveForward: number; // −1..1
  sprint: boolean;
  jump: boolean;
  slowed: boolean; // aiming or busy: no sprint
}

const PLAY_RADIUS_M = 190;
const HEAD_CLEARANCE_M = 1.8;

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

  step(intent: MoveIntent, dt: number, collision: CollisionWorld, events: EventQueue): void {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
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

  /** Chest-deep water, cliffs too steep to walk and the edge of the play area stop the walker. */
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
    if (WATER_LEVEL_M - terrain > P.maxWadeDepthM) return true;
    normalAt(x, z, this.n);
    return this.n.y < 0.6 && terrain > this.pos.y + 0.05;
  }
}
