import { AI, HEALTH, PLAYER, ROUND_556, type RoundSpec } from '../config.ts';
import type { Rng } from '../core/rng.ts';
import { clamp, directionFromYawPitch, lerp, Vec3, wrapAngle } from '../core/vec.ts';
import { BodyHitboxes, type BodyPart, eyeHeightFor, partMultiplier, type Stance, type Team } from './actor.ts';
import { zeroElevationRad } from './ballistics.ts';
import type { CollisionWorld } from './collision.ts';
import { type CoverSpot, findCover } from './cover.ts';
import type { EventQueue } from './events.ts';
import type { Grenades } from './grenades.ts';
import { type CapsuleBody, moveCapsule } from './movement.ts';
import type { NavGrid } from './nav.ts';
import type { Player } from './player.ts';
import type { Projectiles } from './projectiles.ts';

// One AI rifleman: perception (vision cone + occlusion + hearing), a small
// state machine, cover use and believable misses. Squad logic is in squad.ts.

export type AiRole = 'point' | 'rifleman' | 'support' | 'leader';
export type AiState = 'patrol' | 'alert' | 'engage' | 'flank' | 'regroup' | 'dormant';

// AI rounds: same ballistics as the player's carbine, damage tuned for a fair fight.
const ROUND_AI: RoundSpec = { ...ROUND_556, damage: ROUND_556.damage * AI.rifleDamageScale };
const AI_MAG = 30;
const AI_RELOAD_SECONDS = 2.6;
const AI_RPM = 650;
const TURN_RATE_RAD_S = 4.5;

export interface AiContext {
  world: CollisionWorld;
  nav: NavGrid;
  player: Player;
  projectiles: Projectiles;
  grenades: Grenades;
  events: EventQueue;
  rng: Rng;
  timeSeconds: number;
  squadmates: (s: Soldier) => readonly Soldier[];
}

export class Soldier {
  readonly team: Team = 'enemy';
  readonly isPlayer = false;
  readonly hitboxes = new BodyHitboxes();
  readonly body: CapsuleBody;
  yawRad = 0;
  pitchRad = 0;
  stance: Stance = 'stand';
  leanM = 0;
  leanTargetM = 0;
  health: number = AI.health;
  armourHits: number = AI.armourHits;
  alive = true;
  deathSeconds = 0;
  readonly deathDir = new Vec3();
  invulnerable = false;
  state: AiState = 'patrol';

  // Perception.
  awareness = 0;
  seesPlayer = false;
  readonly lastKnown = new Vec3();
  hasLastKnown = false;
  timeSinceSeenSeconds = 999;
  engageSeconds = 0;
  blindSeconds = 0;
  suppression = 0;
  private perceptionTimer = 0;

  // Movement.
  readonly moveTarget = new Vec3();
  hasMoveTarget = false;
  running = false;
  private path: Vec3[] | null = null;
  private pathIndex = 0;
  private readonly pathGoal = new Vec3();
  private repathSeconds = 0;
  speedMs = 0;

  // Cover and fire.
  cover: CoverSpot | null = null;
  coverPhase: 'moving' | 'hide' | 'peek' = 'moving';
  private coverTimer = 0;
  private burstLeft = 0;
  private burstTimer = 0;
  private shotTimer = 0;
  magRounds = AI_MAG;
  reloadSeconds = 0;
  grenadeCooldown: number = AI.grenadeCooldownSeconds * 0.5;
  alertSeconds = 0;
  firedThisStep = false;
  shotsFired = 0;
  lastHitPart: BodyPart | null = null;
  hitsTaken = 0;
  readonly patrolOffset = new Vec3();

  constructor(
    readonly id: number,
    public role: AiRole,
    spawn: Vec3,
    yawRad: number,
  ) {
    this.body = {
      position: spawn.clone(),
      velocity: new Vec3(),
      heightM: PLAYER.heightStandM,
      radiusM: PLAYER.radiusM * 0.9,
      grounded: false,
      groundSurface: 'soil',
      groundNormal: new Vec3(0, 1, 0),
    };
    this.yawRad = yawRad;
    this.perceptionTimer = (id % 7) * 0.02;
    this.hitboxes.update(this.body.position, yawRad, this.stance, 0);
  }

  eye(out: Vec3): Vec3 {
    return out.set(this.body.position.x, this.body.position.y + eyeHeightFor(this.stance) + 0, this.body.position.z).addScaled(this.side(_tmpA), this.leanM);
  }

  side(out: Vec3): Vec3 {
    return out.set(Math.cos(this.yawRad), 0, -Math.sin(this.yawRad));
  }

  headPosition(out: Vec3): Vec3 {
    return out.copy(this.hitboxes.partCenter('head'));
  }

  chestPosition(out: Vec3): Vec3 {
    return out.copy(this.hitboxes.partCenter('chest'));
  }

  facing(out: Vec3): Vec3 {
    return directionFromYawPitch(this.yawRad, this.pitchRad, out);
  }

  // ------------------------------------------------------------------ damage

  receiveHit(damage: number, part: BodyPart, dir: Vec3, byPlayer: boolean, events: EventQueue): boolean {
    if (!this.alive) return false;
    let dmg = damage * partMultiplier(part);
    let armour = false;
    if (part === 'chest' && this.armourHits > 0) {
      armour = true;
      dmg *= 1 - HEALTH.armourAbsorbFraction;
      this.armourHits--;
      if (this.armourHits === 0) events.push({ type: 'plateBreak', actorId: this.id, isPlayer: false });
    }
    this.hitsTaken++;
    this.lastHitPart = part;
    if (!this.invulnerable) this.health -= dmg;
    const killed = this.health <= 0;
    events.push({ type: 'hit', targetId: this.id, part, pos: this.hitboxes.partCenter(part).clone(), armour, killed, byPlayer });
    if (killed) {
      this.alive = false;
      this.deathDir.copy(dir);
      this.body.velocity.set(0, 0, 0);
    } else if (this.state !== 'dormant') {
      // Being shot tells you roughly where from.
      this.awareness = 1;
      this.suppression = Math.min(1, this.suppression + 0.5);
      this.alertFrom(dir);
    }
    return armour;
  }

  receiveBlast(damage: number, fromDir: Vec3, events: EventQueue): void {
    this.receiveHit(damage, 'chest', fromDir, true, events);
  }

  receiveFlash(amount: number): void {
    if (this.state === 'dormant') return;
    this.blindSeconds = Math.max(this.blindSeconds, amount * 5);
  }

  nearMiss(): void {
    if (this.state === 'dormant') return;
    this.suppression = Math.min(1, this.suppression + 0.25);
    if (this.awareness < 0.6) this.awareness = 0.6;
  }

  private alertFrom(dir: Vec3): void {
    if (this.hasLastKnown && this.timeSinceSeenSeconds < 3) return;
    // Hit from `dir`: the shooter is somewhere back along it.
    this.lastKnown.copy(this.body.position).addScaled(dir, -40);
    this.hasLastKnown = true;
    if (this.state === 'patrol') this.state = 'alert';
  }

  hearNoise(pos: Vec3, errorM: number, rng: Rng): void {
    if (!this.alive || this.state === 'dormant') return;
    if (this.seesPlayer) return;
    this.lastKnown.set(pos.x + rng.range(-errorM, errorM), pos.y, pos.z + rng.range(-errorM, errorM));
    this.hasLastKnown = true;
    this.awareness = Math.max(this.awareness, 0.5);
    if (this.state === 'patrol') {
      this.state = 'alert';
      this.alertSeconds = 0;
    }
  }

  // ------------------------------------------------------------------ update

  update(ctx: AiContext, dt: number): void {
    this.firedThisStep = false;
    if (!this.alive) {
      this.deathSeconds += dt;
      this.hitboxes.update(this.body.position, this.yawRad, 'prone', 0);
      return;
    }
    this.blindSeconds = Math.max(0, this.blindSeconds - dt);
    this.suppression = Math.max(0, this.suppression - dt * 0.15);
    this.grenadeCooldown -= dt;
    this.timeSinceSeenSeconds += dt;
    if (this.state !== 'dormant') {
      this.perceptionTimer -= dt;
      if (this.perceptionTimer <= 0) {
        this.perceive(ctx, 0.12 - this.perceptionTimer);
        this.perceptionTimer = 0.12;
      }
      if (this.seesPlayer) this.engageSeconds += dt;
      this.updateReload(ctx, dt);
    }
    this.move(ctx, dt);
    this.leanM += (this.leanTargetM - this.leanM) * Math.min(1, dt * 6);
    this.hitboxes.update(this.body.position, this.yawRad, this.stance, this.leanM);
  }

  private perceive(ctx: AiContext, dt: number): void {
    const p = ctx.player;
    this.seesPlayer = false;
    if (!p.alive) {
      this.awareness = Math.max(0, this.awareness - dt * 0.2);
      return;
    }
    this.eye(_eye);
    _chest.copy(p.hitboxes.partCenter('chest'));
    _head.copy(p.hitboxes.partCenter('head'));
    _to.subVectors(_chest, _eye);
    const dist = _to.length();
    // Hearing: movement noise inside its radius gives a rough position.
    if (dist < p.noiseRadiusM) this.hearNoise(p.body.position, 1.5, ctx.rng);
    if (dist > AI.visionRangeM || this.blindSeconds > 0) {
      this.awareness = Math.max(0, this.awareness - dt * 0.1);
      return;
    }
    const forward = directionFromYawPitch(this.yawRad, 0, _fwd);
    const cosAngle = (forward.x * _to.x + forward.z * _to.z) / Math.max(1e-6, Math.hypot(_to.x, _to.z));
    const inCone = cosAngle >= Math.cos(AI.visionHalfAngleRad) || (this.state === 'engage' && dist < 25);
    let visible = false;
    if (inCone) {
      visible = !ctx.world.lineBlocked(_eye, _chest, true) || !ctx.world.lineBlocked(_eye, _head, true);
      if (visible && ctx.grenades.smokeDepthM(_eye, _chest) > 2.0) visible = false;
    }
    if (visible) {
      const farK = clamp((dist - AI.visionFalloffStartM) / (AI.visionRangeM - AI.visionFalloffStartM), 0, 1);
      let seconds = lerp(AI.detectionSecondsAtNear, AI.detectionSecondsAtFar, farK);
      if (p.stance === 'prone') seconds /= AI.proneDetectionMultiplier;
      else if (p.stance === 'crouch') seconds /= AI.crouchDetectionMultiplier;
      const moving = Math.hypot(p.body.velocity.x, p.body.velocity.z) > 2;
      if (moving) seconds *= 0.6;
      if (this.state === 'engage' || this.state === 'flank') seconds *= 0.4;
      this.awareness = Math.min(1.2, this.awareness + dt / seconds);
      if (this.awareness >= 1) {
        this.seesPlayer = true;
        this.timeSinceSeenSeconds = 0;
        this.lastKnown.copy(p.body.position);
        this.hasLastKnown = true;
      } else if (this.awareness > 0.35 && this.state === 'patrol') {
        this.lastKnown.copy(p.body.position);
        this.hasLastKnown = true;
        this.state = 'alert';
        this.alertSeconds = 0;
      }
    } else {
      this.awareness = Math.max(0, this.awareness - dt * (this.state === 'engage' ? 0.03 : 0.12));
    }
  }

  // ------------------------------------------------------------------ combat helpers (called by the squad brain)

  /** Aim at a world point; turn toward it at a limited rate. Returns the remaining yaw error. */
  aimAt(target: Vec3, dt: number): number {
    this.eye(_eye);
    const dx = target.x - _eye.x;
    const dz = target.z - _eye.z;
    const desiredYaw = Math.atan2(-dx, -dz);
    const desiredPitch = Math.atan2(target.y - _eye.y, Math.hypot(dx, dz));
    const dy = wrapAngle(desiredYaw - this.yawRad);
    const maxTurn = TURN_RATE_RAD_S * dt;
    this.yawRad = wrapAngle(this.yawRad + clamp(dy, -maxTurn, maxTurn));
    this.pitchRad += clamp(desiredPitch - this.pitchRad, -maxTurn, maxTurn);
    return Math.abs(wrapAngle(desiredYaw - this.yawRad));
  }

  /** Burst fire control. `precise` = sees the target (vs suppressive fire at a last known position). */
  shootAt(ctx: AiContext, target: Vec3, precise: boolean, dt: number): void {
    if (this.reloadSeconds > 0 || this.blindSeconds > 0) return;
    this.shotTimer -= dt;
    if (this.burstLeft <= 0) {
      this.burstTimer -= dt;
      if (this.burstTimer > 0) return;
      this.burstLeft = ctx.rng.int(AI.burstRounds[0], AI.burstRounds[1]);
    }
    if (this.shotTimer > 0) return;
    if (this.friendlyInLine(ctx, target)) return;
    this.shotTimer = 60 / AI_RPM;
    this.burstLeft--;
    if (this.burstLeft <= 0) this.burstTimer = ctx.rng.range(AI.burstPauseSeconds[0], AI.burstPauseSeconds[1]) * (1 + this.suppression);
    this.magRounds--;
    this.shotsFired++;
    this.firedThisStep = true;

    // Miss believably: a loose first burst that tightens as the fight goes on.
    const settle = clamp(this.engageSeconds / AI.spreadTightenSeconds, 0, 1);
    let spread = lerp(AI.firstBurstSpreadRad, AI.settledSpreadRad, settle);
    spread *= 1 + this.suppression * 1.5;
    if (!precise) spread = Math.max(spread, 0.04);
    if (this.speedMs > 1) spread *= 1.6;
    this.eye(_muzzle);
    const dx = target.x - _muzzle.x;
    const dz = target.z - _muzzle.z;
    const yaw = Math.atan2(-dx, -dz) + ctx.rng.gauss() * spread * 0.5;
    const pitch = Math.atan2(target.y - _muzzle.y, Math.hypot(dx, dz)) + ctx.rng.gauss() * spread * 0.5;
    directionFromYawPitch(yaw, pitch + zeroElevationRad(ROUND_AI), _dir);
    _muzzle.addScaled(_dir, 0.6);
    ctx.projectiles.spawn(this.id, _muzzle, _dir, ROUND_AI, 0.5 * ROUND_AI.bulletMassKg * ROUND_AI.muzzleVelocityMs ** 2, false, this.shotsFired % 4 === 0);
    ctx.events.push({ type: 'shot', shooterId: this.id, weapon: 'rifle', origin: _muzzle.clone(), dir: _dir.clone(), suppressed: false });
  }

  private friendlyInLine(ctx: AiContext, target: Vec3): boolean {
    this.eye(_eye);
    _to.subVectors(target, _eye);
    const len = _to.length();
    _to.scale(1 / Math.max(1e-6, len));
    for (const mate of ctx.squadmates(this)) {
      if (mate === this || !mate.alive) continue;
      mate.chestPosition(_mate);
      _mate.sub(_eye);
      const along = _mate.dot(_to);
      if (along <= 0 || along >= len) continue;
      const perp2 = _mate.dot(_mate) - along * along;
      if (perp2 < 1.0) return true;
    }
    return false;
  }

  private updateReload(ctx: AiContext, dt: number): void {
    if (this.reloadSeconds > 0) {
      this.reloadSeconds -= dt;
      if (this.reloadSeconds <= 0) this.magRounds = AI_MAG;
      return;
    }
    if (this.magRounds <= 0) {
      this.reloadSeconds = AI_RELOAD_SECONDS;
      this.eye(_eye);
      ctx.events.push({ type: 'callout', pos: _eye.clone(), text: 'reloading' });
    }
  }

  pickCover(ctx: AiContext, threat: Vec3, minThreatDistM: number, radiusM: number): boolean {
    const reserved: Vec3[] = [];
    for (const mate of ctx.squadmates(this)) if (mate !== this && mate.cover) reserved.push(mate.cover.pos);
    const spot = findCover(ctx.world, ctx.nav, { from: this.body.position, threat, radiusM, minThreatDistM, reserved });
    this.cover = spot;
    this.coverPhase = 'moving';
    if (spot) this.setMoveTarget(spot.pos, true);
    return spot !== null;
  }

  /** Cover cycle: hide, then lean or pop up to fire, then hide again. */
  runCoverCycle(dt: number): 'hide' | 'peek' | 'moving' {
    if (!this.cover) return 'moving';
    if (this.coverPhase === 'moving') {
      if (this.body.position.distanceToXZ(this.cover.pos) < 0.8) {
        this.coverPhase = 'hide';
        this.coverTimer = AI.hideSeconds * 0.5;
      }
      this.stance = 'stand';
      this.leanTargetM = 0;
      return 'moving';
    }
    this.coverTimer -= dt;
    if (this.coverTimer <= 0) {
      if (this.coverPhase === 'hide') {
        this.coverPhase = 'peek';
        this.coverTimer = AI.leanSeconds * (1 + 0.5 * Math.sin(this.id * 1.7));
      } else {
        this.coverPhase = 'hide';
        this.coverTimer = AI.hideSeconds * (1 + this.suppression * 1.5);
      }
    }
    if (this.coverPhase === 'hide') {
      this.stance = this.cover.low ? 'crouch' : 'stand';
      this.leanTargetM = 0;
    } else {
      this.stance = 'stand';
      this.leanTargetM = this.cover.low ? 0 : this.cover.leanSide * 0.45;
    }
    return this.coverPhase;
  }

  setMoveTarget(target: Vec3, run: boolean): void {
    this.running = run;
    if (this.hasMoveTarget && this.moveTarget.distanceToXZ(target) < 1.5) return;
    this.moveTarget.copy(target);
    this.hasMoveTarget = true;
    this.path = null;
    this.repathSeconds = 0;
  }

  clearMoveTarget(): void {
    this.hasMoveTarget = false;
    this.path = null;
  }

  atMoveTarget(): boolean {
    return !this.hasMoveTarget || this.body.position.distanceToXZ(this.moveTarget) < 1.0;
  }

  // ------------------------------------------------------------------ locomotion

  private move(ctx: AiContext, dt: number): void {
    const v = this.body.velocity;
    let desiredX = 0;
    let desiredZ = 0;
    if (this.hasMoveTarget && !this.atMoveTarget() && this.blindSeconds <= 0) {
      this.repathSeconds -= dt;
      const wantsPath = !this.path || this.repathSeconds <= 0 || this.pathGoal.distanceToXZ(this.moveTarget) > 1.5;
      // The nav grid rations searches per step; without one, keep the old path and ask next step.
      if (wantsPath && ctx.nav.reserveSearch()) {
        this.path = ctx.nav.findPath(this.body.position, this.moveTarget, 6000);
        this.pathIndex = 0;
        this.pathGoal.copy(this.moveTarget);
        this.repathSeconds = 4;
        if (!this.path) this.hasMoveTarget = false;
      }
      const wp = this.path?.[this.pathIndex];
      if (wp) {
        const dx = wp.x - this.body.position.x;
        const dz = wp.z - this.body.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.7 && this.path && this.pathIndex < this.path.length - 1) this.pathIndex++;
        const speed = this.stance === 'crouch' ? 1.6 : this.running ? AI.runSpeedMs : AI.walkSpeedMs;
        if (d > 1e-3) {
          desiredX = (dx / d) * speed;
          desiredZ = (dz / d) * speed;
        }
      }
    }
    // Separation from squadmates so they do not stack.
    for (const mate of ctx.squadmates(this)) {
      if (mate === this || !mate.alive) continue;
      const dx = this.body.position.x - mate.body.position.x;
      const dz = this.body.position.z - mate.body.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-3 && d < 1.2) {
        desiredX += (dx / d) * (1.2 - d) * 2;
        desiredZ += (dz / d) * (1.2 - d) * 2;
      }
    }
    const k = Math.min(1, dt * 8);
    v.x += (desiredX - v.x) * k;
    v.z += (desiredZ - v.z) * k;
    v.y -= 9.81 * dt;
    moveCapsule(ctx.world, this.body, dt, 0.42);
    this.speedMs = Math.hypot(v.x, v.z);
    // Face the way we walk unless the brain aims somewhere this step.
    if (this.speedMs > 0.5 && !this.seesPlayer && this.state !== 'engage') {
      const want = Math.atan2(-v.x, -v.z);
      this.yawRad = wrapAngle(this.yawRad + clamp(wrapAngle(want - this.yawRad), -TURN_RATE_RAD_S * dt, TURN_RATE_RAD_S * dt));
      this.pitchRad *= 0.9;
    }
  }
}

const _tmpA = new Vec3();
const _eye = new Vec3();
const _chest = new Vec3();
const _head = new Vec3();
const _to = new Vec3();
const _fwd = new Vec3();
const _muzzle = new Vec3();
const _dir = new Vec3();
const _mate = new Vec3();
