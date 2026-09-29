import { AI, GRENADES, type GrenadeKind, HEALTH, HITBOX, PHYSICS, PLAYER } from '../config.ts';
import { clamp, Vec3 } from '../core/vec.ts';
import { BodyHitboxes, type BodyPart, eyeHeightFor, partMultiplier, type Stance } from './actor.ts';
import type { CollisionWorld } from './collision.ts';
import type { EventQueue } from './events.ts';
import { type CapsuleBody, headroomM, moveCapsule } from './movement.ts';

export interface PlayerIntent {
  moveRight: number; // -1..1
  moveForward: number; // -1..1
  sprint: boolean;
  jump: boolean;
  crouchPressed: boolean;
  pronePressed: boolean;
  aiming: boolean;
  holdBreath: boolean;
}

export type ItemKind = 'medKit' | 'ammoPack';

export const PLAYER_ID = 0;

export class Player {
  readonly id = PLAYER_ID;
  readonly body: CapsuleBody;
  readonly hitboxes = new BodyHitboxes();
  yawRad = 0;
  pitchRad = 0;
  stance: Stance = 'stand';
  /** Smoothed eye height for the camera (m above feet). */
  eyeHeightM: number = PLAYER.eyeStandM;
  staminaSeconds: number = PLAYER.staminaMaxSeconds;
  sliding = false;
  alive = true;

  // Two-layer health.
  bufferHp: number = HEALTH.bufferMax;
  permanentHp: number = HEALTH.permanentMax;
  bleeding = false;
  secondsSinceHit = 99;
  armourHitsLeft: number = HEALTH.armourPlateHits;

  limpSeconds = 0;
  brokenLegSeconds = 0;
  armSwaySeconds = 0;

  breathHoldLeftSeconds: number = PLAYER.breathHoldSeconds;
  breathPenaltySeconds = 0;
  holdingBreath = false;

  medKits = 1;
  ammoPacks: number = HEALTH.ammoPackCarriedMax;
  grenades: Record<GrenadeKind, number> = { ...GRENADES.startCount };
  grenadeKind: GrenadeKind = 'frag';
  itemInUse: { kind: ItemKind; secondsLeft: number } | null = null;

  noiseRadiusM = 0;
  /** Seconds spent within AI.campRadiusM of campAnchor — AI grenades a camper. */
  campSeconds = 0;
  readonly campAnchor = new Vec3();
  private airborneMaxY = 0;
  private footstepDistanceM = 0;
  headBobPhase = 0;
  readonly prevPosition = new Vec3();

  constructor(spawn: Vec3, yawRad: number) {
    this.body = {
      position: spawn.clone(),
      velocity: new Vec3(),
      heightM: PLAYER.heightStandM,
      radiusM: PLAYER.radiusM,
      grounded: false,
      groundSurface: 'soil',
      groundNormal: new Vec3(0, 1, 0),
    };
    this.yawRad = yawRad;
    this.prevPosition.copy(spawn);
    this.campAnchor.copy(spawn);
    this.airborneMaxY = spawn.y;
  }

  get healthTotal(): number {
    return this.bufferHp + this.permanentHp;
  }

  /** Water over the feet (m), set by the game each step: wading is slow, and no one lies down in it. */
  wadeDepthM = 0;

  update(intent: PlayerIntent, world: CollisionWorld, dt: number, events: EventQueue): void {
    this.prevPosition.copy(this.body.position);
    if (!this.alive) {
      this.body.velocity.set(0, 0, 0);
      return;
    }
    this.updateStance(intent, world);
    this.updateMovement(intent, dt);
    const wasGrounded = this.body.grounded;
    if (!wasGrounded) this.airborneMaxY = Math.max(this.airborneMaxY, this.body.position.y);
    const result = moveCapsule(world, this.body, dt, this.stance === 'prone' ? 0.2 : PLAYER.stepUpM);
    if (result.landed) this.onLand(events);
    if (this.body.grounded) this.airborneMaxY = this.body.position.y;
    this.updateFootsteps(events);
    this.updateHealth(dt);
    this.updateBreath(intent, dt, events);
    this.updateCamping(dt);
    const targetEye = eyeHeightFor(this.stance) - (this.sliding ? 0.25 : 0);
    this.eyeHeightM += (targetEye - this.eyeHeightM) * (1 - Math.exp(-dt / (PLAYER.stanceChangeSeconds * 0.4)));
    this.hitboxes.update(this.body.position, this.yawRad, this.stance, 0);
  }

  private updateStance(intent: PlayerIntent, world: CollisionWorld): void {
    const p = this.body.position;
    const speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    let desired: Stance = this.stance;
    if (intent.crouchPressed) {
      if (this.stance === 'stand' && speed >= PLAYER.slideMinSpeedMs && this.body.grounded) this.sliding = true;
      desired = this.stance === 'crouch' ? 'stand' : 'crouch';
    }
    if (intent.pronePressed) desired = this.stance === 'prone' ? 'crouch' : 'prone';
    // Prone in water deeper than a hand's width would put the face under.
    if (desired === 'prone' && this.wadeDepthM > PLAYER.maxProneWaterM) desired = 'crouch';
    if (intent.sprint && intent.moveForward > 0 && this.stance !== 'stand' && !this.sliding && !intent.crouchPressed) {
      desired = 'stand';
    }
    if (desired === this.stance) return;
    const neededM = desired === 'stand' ? PLAYER.heightStandM : desired === 'crouch' ? PLAYER.heightCrouchM : PLAYER.heightProneM;
    if (neededM > this.body.heightM && headroomM(world, p.x, p.y, p.z, this.body.radiusM) < neededM) return;
    this.stance = desired;
    this.body.heightM = neededM;
    if (desired !== 'crouch') this.sliding = false;
  }

  private updateMovement(intent: PlayerIntent, dt: number): void {
    const v = this.body.velocity;
    const len = Math.hypot(intent.moveRight, intent.moveForward);
    const inX = len > 1 ? intent.moveRight / len : intent.moveRight;
    const inZ = len > 1 ? intent.moveForward / len : intent.moveForward;
    // Camera-relative input → world (yaw 0 looks down -Z).
    const sy = Math.sin(this.yawRad);
    const cy = Math.cos(this.yawRad);
    const dirX = inX * cy - inZ * sy;
    const dirZ = -inX * sy - inZ * cy;
    const hasInput = len > 0.01;

    const injured = this.limpSeconds > 0 || this.brokenLegSeconds > 0;
    const canSprint =
      intent.sprint && !intent.aiming && intent.moveForward > 0.3 && this.stance === 'stand' && !injured && this.itemInUse === null;
    const sprinting = canSprint && this.staminaSeconds > (this.isSprinting ? 0 : PLAYER.staminaMinToSprint);
    this.isSprinting = sprinting && hasInput;

    let targetSpeed: number = PLAYER.jogSpeedMs;
    if (this.stance === 'prone') targetSpeed = PLAYER.proneSpeedMs;
    else if (this.stance === 'crouch') targetSpeed = PLAYER.crouchSpeedMs;
    else if (sprinting) targetSpeed = PLAYER.sprintSpeedMs;
    else if (intent.aiming || this.itemInUse) targetSpeed = PLAYER.walkSpeedMs;
    if (injured) targetSpeed *= PLAYER.limpSpeedMultiplier;
    // Wading: drag grows with the depth of water pushed aside.
    targetSpeed *= 1 - Math.min(1, this.wadeDepthM / PLAYER.wadeDepthForHalfSpeedM) * 0.5;

    // Stamina: drains while sprinting, recovers faster crouched or prone ("seated").
    if (this.isSprinting) {
      this.staminaSeconds = Math.max(0, this.staminaSeconds - dt);
    } else {
      const rate = PLAYER.staminaRecoverPerSecond * (this.stance === 'stand' ? 1 : PLAYER.staminaRecoverSeatedMultiplier);
      this.staminaSeconds = Math.min(PLAYER.staminaMaxSeconds, this.staminaSeconds + rate * dt);
    }

    if (this.body.grounded) {
      if (this.sliding) {
        const speed = Math.hypot(v.x, v.z);
        const newSpeed = Math.max(0, speed - PLAYER.slideFrictionMs2 * dt);
        if (speed > 1e-4) {
          v.x *= newSpeed / speed;
          v.z *= newSpeed / speed;
        }
        if (newSpeed < PLAYER.crouchSpeedMs) this.sliding = false;
      } else {
        // Force-based drive: accelerate toward the desired velocity, limited by
        // the drive force; with no input, ground friction brings us to rest.
        const desiredX = hasInput ? dirX * targetSpeed : 0;
        const desiredZ = hasInput ? dirZ * targetSpeed : 0;
        const dvx = desiredX - v.x;
        const dvz = desiredZ - v.z;
        const dvLen = Math.hypot(dvx, dvz);
        const accel = hasInput ? PLAYER.groundAccelMs2 : PLAYER.groundFrictionMs2;
        const maxDv = accel * dt;
        if (dvLen > 1e-6) {
          const k = Math.min(1, maxDv / dvLen);
          v.x += dvx * k;
          v.z += dvz * k;
        }
      }
      if (intent.jump && this.stance === 'stand' && !injured) {
        v.y = PLAYER.jumpSpeedMs;
        this.body.grounded = false;
      }
    } else {
      v.x += dirX * PLAYER.airAccelMs2 * dt;
      v.z += dirZ * PLAYER.airAccelMs2 * dt;
    }
    v.y -= PHYSICS.gravityMs2 * dt;

    const speed = Math.hypot(v.x, v.z);
    if (this.stance === 'prone') this.noiseRadiusM = speed > 0.1 ? PLAYER.noiseRadiusProneM : 0;
    else if (this.stance === 'crouch') this.noiseRadiusM = speed > 0.1 ? PLAYER.noiseRadiusCrouchM : 0;
    else if (speed > 4.5) this.noiseRadiusM = PLAYER.noiseRadiusSprintM;
    else if (speed > 2) this.noiseRadiusM = PLAYER.noiseRadiusJogM;
    else this.noiseRadiusM = speed > 0.1 ? PLAYER.noiseRadiusWalkM : 0;
    this.headBobPhase += speed * dt * (this.stance === 'prone' ? 2.5 : 1.75);
  }

  isSprinting = false;

  private onLand(events: EventQueue): void {
    const fallM = this.airborneMaxY - this.body.position.y;
    let brokenLeg = false;
    if (fallM > PLAYER.fallDamageStartM) {
      const damage = (fallM - PLAYER.fallDamageStartM) * PLAYER.fallDamagePerM;
      this.applyRawDamage(damage);
      if (fallM > PLAYER.fallBrokenLegM) {
        this.brokenLegSeconds = PLAYER.brokenLegSeconds;
        brokenLeg = true;
      }
    }
    events.push({ type: 'land', impactSpeedMs: -Math.min(0, this.body.velocity.y) || Math.sqrt(2 * PHYSICS.gravityMs2 * Math.max(0, fallM)), brokenLeg });
    this.airborneMaxY = this.body.position.y;
  }

  private updateFootsteps(events: EventQueue): void {
    if (!this.body.grounded) return;
    const moved = Math.hypot(this.body.position.x - this.prevPosition.x, this.body.position.z - this.prevPosition.z);
    this.footstepDistanceM += moved;
    const stride = this.stance === 'prone' ? 0.9 : this.isSprinting ? 1.6 : 1.3;
    if (this.footstepDistanceM >= stride) {
      this.footstepDistanceM = 0;
      const loudness = this.stance === 'prone' ? 0.15 : this.stance === 'crouch' ? 0.3 : this.isSprinting ? 1 : 0.6;
      events.push({ type: 'footstep', pos: this.body.position.clone(), surface: this.body.groundSurface, loudness, isPlayer: true });
    }
  }

  private updateHealth(dt: number): void {
    this.secondsSinceHit += dt;
    this.limpSeconds = Math.max(0, this.limpSeconds - dt);
    this.brokenLegSeconds = Math.max(0, this.brokenLegSeconds - dt);
    this.armSwaySeconds = Math.max(0, this.armSwaySeconds - dt);
    if (this.secondsSinceHit > HEALTH.bufferRegenDelaySeconds && !this.bleeding) {
      this.bufferHp = Math.min(HEALTH.bufferMax, this.bufferHp + HEALTH.bufferRegenPerSecond * dt);
    }
    if (this.permanentHp < HEALTH.bleedBelowPermanent) this.bleeding = true;
    if (this.bleeding) this.applyRawDamage(HEALTH.bleedPerSecond * dt);
  }

  private updateBreath(intent: PlayerIntent, dt: number, events: EventQueue): void {
    const wantHold = intent.aiming && intent.holdBreath && this.breathPenaltySeconds <= 0;
    if (wantHold && this.breathHoldLeftSeconds > 0) {
      if (!this.holdingBreath) events.push({ type: 'breath', holding: true });
      this.holdingBreath = true;
      this.breathHoldLeftSeconds -= dt;
      if (this.breathHoldLeftSeconds <= 0) {
        this.breathHoldLeftSeconds = 0;
        this.breathPenaltySeconds = PLAYER.breathRecoverPenaltySeconds;
        this.holdingBreath = false;
        events.push({ type: 'breath', holding: false });
      }
    } else {
      if (this.holdingBreath) events.push({ type: 'breath', holding: false });
      this.holdingBreath = false;
      this.breathPenaltySeconds = Math.max(0, this.breathPenaltySeconds - dt);
      // Full breath back in about 4 s.
      this.breathHoldLeftSeconds = Math.min(PLAYER.breathHoldSeconds, this.breathHoldLeftSeconds + dt * 1.5);
    }
  }

  private updateCamping(dt: number): void {
    if (this.body.position.distanceToXZ(this.campAnchor) > AI.campRadiusM) {
      this.campAnchor.copy(this.body.position);
      this.campSeconds = 0;
    } else {
      this.campSeconds += dt;
    }
  }

  /** Multiplier on weapon sway from stance, injuries and breathing. */
  swayMultiplier(): number {
    let m = this.stance === 'prone' ? 0.3 : this.stance === 'crouch' ? 0.6 : 1;
    if (this.armSwaySeconds > 0) m *= HITBOX.armSwayMultiplier;
    if (this.holdingBreath) m *= 0.12;
    if (this.breathPenaltySeconds > 0) m *= PLAYER.breathPenaltySwayMultiplier;
    const staminaShort = 1 - this.staminaSeconds / PLAYER.staminaMaxSeconds;
    m *= 1 + staminaShort * 1.5; // winded after a sprint
    return m;
  }

  /** Recoil recovery multiplier: prone and crouched shooters settle faster. */
  recoilRecoveryMultiplier(): number {
    return this.stance === 'prone' ? 1.8 : this.stance === 'crouch' ? 1.3 : 1;
  }

  /** Bullet or fragment damage. Returns true when the chest plate took the hit. */
  takeHit(baseDamage: number, part: BodyPart, fromDir: Vec3, events: EventQueue): boolean {
    if (!this.alive) return false;
    let damage = baseDamage * partMultiplier(part);
    let armour = false;
    if (part === 'chest' && this.armourHitsLeft > 0) {
      armour = true;
      damage *= 1 - HEALTH.armourAbsorbFraction;
      this.armourHitsLeft--;
      if (this.armourHitsLeft === 0) events.push({ type: 'plateBreak', actorId: this.id, isPlayer: true });
    }
    if (part === 'legL' || part === 'legR') this.limpSeconds = Math.max(this.limpSeconds, HITBOX.legLimpSeconds);
    if (part === 'armL' || part === 'armR') this.armSwaySeconds = Math.max(this.armSwaySeconds, HITBOX.armSwaySeconds);
    this.applyRawDamage(damage);
    this.secondsSinceHit = 0;
    if (this.itemInUse?.kind === 'medKit') {
      events.push({ type: 'itemInterrupted', item: 'medKit' });
      this.itemInUse = null;
    }
    events.push({ type: 'playerHit', fromDir: fromDir.clone(), part, armour, damage });
    return armour;
  }

  applyRawDamage(amount: number): void {
    if (amount <= 0 || !this.alive) return;
    const fromBuffer = Math.min(this.bufferHp, amount);
    this.bufferHp -= fromBuffer;
    this.permanentHp -= amount - fromBuffer;
    this.secondsSinceHit = 0;
    if (this.permanentHp <= 0) {
      this.permanentHp = 0;
      this.alive = false;
    }
  }

  /** Med kit effect, after its 6 s use completes. */
  heal(): void {
    this.permanentHp = clamp(this.permanentHp + HEALTH.medKitHeal, 0, HEALTH.permanentMax);
    this.bleeding = false;
    this.limpSeconds = 0;
  }

  eyePosition(out: Vec3): Vec3 {
    return out.set(this.body.position.x, this.body.position.y + this.eyeHeightM, this.body.position.z);
  }
}
