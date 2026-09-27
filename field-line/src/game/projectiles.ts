import { MATERIAL_PENETRATION_J_PER_M, type RoundSpec } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import type { BodyHitboxes, BodyPart } from './actor.ts';
import { BALLISTIC_SUBSTEPS, energyFraction, integrateBullet } from './ballistics.ts';
import type { CollisionWorld, RayBoxHit } from './collision.ts';
import type { EventQueue } from './events.ts';

// Pooled bullets, ray-cast per sub-step with drag (rules §5). Penetration is
// a per-material energy cost along the ray (damage model brief).

export interface ShootableActor {
  id: number;
  alive: boolean;
  isPlayer: boolean;
  hitboxes: BodyHitboxes;
  /** Applies damage; returns true when armour took it. */
  receiveHit(damage: number, part: BodyPart, dir: Vec3, byPlayer: boolean, events: EventQueue): boolean;
  /** Supersonic round passed close by (suppression, crack). */
  nearMiss(pos: Vec3, byPlayer: boolean, events: EventQueue): void;
  headPosition(out: Vec3): Vec3;
}

export interface Bullet {
  active: boolean;
  shooterId: number;
  byPlayer: boolean;
  round: RoundSpec;
  pos: Vec3;
  prevPos: Vec3; // start of the last step, for tracer rendering
  vel: Vec3;
  energyJ: number;
  muzzleEnergyJ: number;
  ageSeconds: number;
  tracer: boolean;
  crackedFor: number; // bitmask of actor ids (low bits) already cracked
}

const POOL_SIZE = 256;
const MAX_AGE_SECONDS = 4;
const NEAR_MISS_RADIUS_M = 3;
const SUPERSONIC_MS = 350;

export interface BulletImpactListener {
  (boxId: number, pos: Vec3, byPlayer: boolean): void;
}

export class Projectiles {
  readonly pool: Bullet[] = [];
  readonly wind = new Vec3();
  onBoxImpact: BulletImpactListener | null = null;
  private nextIndex = 0;

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push({
        active: false,
        shooterId: -1,
        byPlayer: false,
        round: null as unknown as RoundSpec, // assigned on spawn, never read while inactive
        pos: new Vec3(),
        prevPos: new Vec3(),
        vel: new Vec3(),
        energyJ: 0,
        muzzleEnergyJ: 0,
        ageSeconds: 0,
        tracer: false,
        crackedFor: 0,
      });
    }
  }

  spawn(shooterId: number, origin: Vec3, dir: Vec3, round: RoundSpec, energyJ: number, byPlayer: boolean, tracer = false): void {
    const b = this.pool[this.nextIndex] as Bullet;
    this.nextIndex = (this.nextIndex + 1) % POOL_SIZE;
    b.active = true;
    b.shooterId = shooterId;
    b.byPlayer = byPlayer;
    b.round = round;
    b.pos.copy(origin);
    b.prevPos.copy(origin);
    b.vel.copy(dir).scale(round.muzzleVelocityMs);
    b.energyJ = energyJ;
    b.muzzleEnergyJ = energyJ;
    b.ageSeconds = 0;
    b.tracer = tracer;
    b.crackedFor = 0;
  }

  update(world: CollisionWorld, actors: readonly ShootableActor[], events: EventQueue, dt: number): void {
    const h = dt / BALLISTIC_SUBSTEPS;
    for (const b of this.pool) {
      if (!b.active) continue;
      b.prevPos.copy(b.pos);
      b.ageSeconds += dt;
      for (let s = 0; s < BALLISTIC_SUBSTEPS && b.active; s++) {
        _start.copy(b.pos);
        integrateBullet(b.pos, b.vel, this.wind, b.round, h);
        this.traceSegment(b, _start, world, actors, events);
      }
      if (b.ageSeconds > MAX_AGE_SECONDS || b.pos.y < -50) b.active = false;
    }
  }

  private traceSegment(b: Bullet, start: Vec3, world: CollisionWorld, actors: readonly ShootableActor[], events: EventQueue): void {
    _seg.subVectors(b.pos, start);
    let remaining = _seg.length();
    if (remaining < 1e-6) return;
    _dir.copy(_seg).scale(1 / remaining);
    _from.copy(start);
    // A penetrating round can pass several boxes in one sub-step.
    for (let guard = 0; guard < 6 && b.active; guard++) {
      const boxes = world.raycastBoxes(_from, _dir, remaining, _hits);
      let boxHit: RayBoxHit | null = null;
      for (const hit of boxes) {
        // Skip a box we are leaving (entry at 0 because we start inside it).
        if (hit.exitM <= 1e-4) continue;
        boxHit = hit;
        break;
      }
      const terrainHit = world.raycastTerrain(_from, _dir, remaining);
      let actorHit: { actor: ShootableActor; part: BodyPart; dist: number } | null = null;
      for (const actor of actors) {
        if (!actor.alive || actor.id === b.shooterId) continue;
        const r = actor.hitboxes.raycast(_from, _dir, remaining);
        if (r && (!actorHit || r.hit.entryM < actorHit.dist)) actorHit = { actor, part: r.part, dist: r.hit.entryM };
        this.checkNearMiss(b, actor, events);
      }
      const boxDist = boxHit ? boxHit.entryM : Infinity;
      const terrainDist = terrainHit ? terrainHit.distanceM : Infinity;
      const actorDist = actorHit ? actorHit.dist : Infinity;
      const nearest = Math.min(boxDist, terrainDist, actorDist);
      if (nearest === Infinity) return;

      if (actorHit && actorDist === nearest) {
        // Damage scales with the kinetic energy the round still carries.
        const damage = b.round.damage * energyFraction(b.round, b.vel.length());
        _point.copy(_from).addScaled(_dir, actorDist);
        const armour = actorHit.actor.receiveHit(damage, actorHit.part, _dir, b.byPlayer, events);
        events.push({ type: 'impact', pos: _point.clone(), normal: new Vec3(-_dir.x, -_dir.y, -_dir.z), surface: armour ? 'armourPlate' : 'flesh', exit: false });
        b.active = false;
        return;
      }
      if (terrainHit && terrainDist === nearest) {
        _point.copy(_from).addScaled(_dir, terrainDist);
        events.push({ type: 'impact', pos: _point.clone(), normal: terrainHit.normal, surface: terrainHit.surface, exit: false });
        b.active = false;
        return;
      }
      if (!boxHit) return;
      const box = boxHit.box;
      _point.copy(_from).addScaled(_dir, boxHit.entryM);
      const entryImpact = boxHit.entryM > 1e-4;
      if (entryImpact) {
        events.push({ type: 'impact', pos: _point.clone(), normal: boxHit.normal, surface: box.surface, exit: false });
        this.onBoxImpact?.(box.id, _point, b.byPlayer);
      }
      if (box.surface === 'glass') {
        events.push({ type: 'glassBreak', pos: _point.clone() });
        world.removeBox(box);
      }
      const thicknessM = boxHit.exitM - boxHit.entryM;
      b.energyJ = 0.5 * b.round.bulletMassKg * b.vel.dot(b.vel);
      const costJ = thicknessM * (MATERIAL_PENETRATION_J_PER_M[box.surface] ?? 1e9);
      if (costJ >= b.energyJ) {
        b.active = false;
        return;
      }
      // Through: lose energy (speed ∝ √energy), step out of the far face and continue.
      const ratio = Math.sqrt((b.energyJ - costJ) / b.energyJ);
      b.energyJ -= costJ;
      b.vel.scale(ratio);
      _from.copy(_from).addScaled(_dir, boxHit.exitM + 1e-3);
      if (box.surface !== 'glass' && box.surface !== 'foliage') {
        events.push({ type: 'impact', pos: _from.clone(), normal: _dir.clone(), surface: box.surface, exit: true });
      }
      remaining -= boxHit.exitM + 1e-3;
      if (remaining <= 0) {
        b.pos.copy(_from);
        return;
      }
    }
  }

  private checkNearMiss(b: Bullet, actor: ShootableActor, events: EventQueue): void {
    if (actor.id < 30 && (b.crackedFor & (1 << actor.id)) !== 0) return;
    actor.headPosition(_head);
    _toHead.subVectors(_head, _from);
    const t = Math.max(0, _toHead.dot(_dir));
    _closest.copy(_from).addScaled(_dir, t);
    if (_closest.distanceTo(_head) > NEAR_MISS_RADIUS_M) return;
    if (_toHead.dot(_dir) < -2) return; // already behind us
    if (actor.id < 30) b.crackedFor |= 1 << actor.id;
    if (b.vel.length() > SUPERSONIC_MS || !actor.isPlayer) actor.nearMiss(_closest, b.byPlayer, events);
  }
}

const _start = new Vec3();
const _seg = new Vec3();
const _dir = new Vec3();
const _from = new Vec3();
const _point = new Vec3();
const _head = new Vec3();
const _toHead = new Vec3();
const _closest = new Vec3();
const _hits: RayBoxHit[] = [];
