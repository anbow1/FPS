import { AI, GRENADES, PHYSICS } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import { Grenades } from './grenades.ts';
import type { AiContext, AiRole, Soldier } from './soldier.ts';

// Squad of four: point, rifleman, support, leader (brief). The squad shares
// what it knows, the leader calls a flank, support lays suppressive fire, and
// when the leader dies the rest fall back to cover and regroup.

const ROLES: readonly AiRole[] = ['point', 'rifleman', 'support', 'leader'];
const FORMATION: Record<AiRole, [number, number]> = {
  point: [0, -6],
  rifleman: [-3, -2],
  support: [3, -2],
  leader: [0, 0],
};

export class Squad {
  readonly members: Soldier[] = [];
  patrol: Vec3[];
  private patrolIndex = 0;
  readonly knownPos = new Vec3();
  knowsPos = false;
  knownAgeSeconds = 999;
  private engagedSeconds = 0;
  flankCalled = false;
  private regroupSeconds = 0;
  leaderDead = false;
  private grenadeCooldown = 0;

  constructor(
    readonly id: number,
    patrol: Vec3[],
  ) {
    this.patrol = patrol.length > 0 ? patrol : [new Vec3()];
  }

  static roleFor(index: number): AiRole {
    return ROLES[index % ROLES.length] as AiRole;
  }

  get alive(): boolean {
    return this.members.some((m) => m.alive);
  }

  get leader(): Soldier | undefined {
    return this.members.find((m) => m.role === 'leader' && m.alive);
  }

  /** Everyone heard something: share the position. */
  alertAll(pos: Vec3, errorM: number, ctx: AiContext): void {
    for (const m of this.members) m.hearNoise(pos, errorM, ctx.rng);
    this.knownPos.copy(pos);
    this.knowsPos = true;
    this.knownAgeSeconds = 0;
  }

  update(ctx: AiContext, dt: number): void {
    this.knownAgeSeconds += dt;
    this.grenadeCooldown -= dt;
    // Pool knowledge: anyone who sees the player updates the squad picture.
    let anySees = false;
    for (const m of this.members) {
      if (!m.alive || m.state === 'dormant') continue;
      if (m.seesPlayer) {
        anySees = true;
        if (!this.knowsPos || this.knownAgeSeconds > 2) {
          ctx.events.push({ type: 'callout', pos: m.body.position.clone(), text: 'contact' });
        }
        this.knownPos.copy(m.lastKnown);
        this.knowsPos = true;
        this.knownAgeSeconds = 0;
      } else if (m.hasLastKnown && m.state === 'alert' && !this.knowsPos) {
        this.knownPos.copy(m.lastKnown);
        this.knowsPos = true;
        this.knownAgeSeconds = 5;
      }
    }
    if (anySees) this.engagedSeconds += dt;
    this.checkLeader(ctx);

    for (const m of this.members) {
      if (!m.alive || m.state === 'dormant') continue;
      // Contact spreads after a reaction delay.
      if (this.knowsPos && this.knownAgeSeconds < 1 && m.state !== 'engage' && m.state !== 'flank' && m.state !== 'regroup') {
        if (this.knownAgeSeconds > AI.reactionSeconds || m.seesPlayer) {
          m.state = 'engage';
          m.cover = null;
        }
      }
      switch (m.state) {
        case 'patrol':
          this.doPatrol(m, ctx);
          break;
        case 'alert':
          this.doAlert(m, dt);
          break;
        case 'engage':
          this.doEngage(m, ctx, dt);
          break;
        case 'flank':
          this.doFlank(m, ctx, dt);
          break;
        case 'regroup':
          this.doRegroup(m, ctx, dt);
          break;
      }
    }
    this.maybeCallFlank(ctx);
    this.maybeGrenade(ctx);
  }

  private doPatrol(m: Soldier, ctx: AiContext): void {
    m.stance = 'stand';
    m.leanTargetM = 0;
    const wp = this.patrol[this.patrolIndex] as Vec3;
    const leader = this.leader ?? m;
    if (m === leader) {
      if (leader.body.position.distanceToXZ(wp) < 2.5) this.patrolIndex = (this.patrolIndex + 1) % this.patrol.length;
      m.setMoveTarget(wp, false);
    } else {
      const f = FORMATION[m.role];
      const c = Math.cos(leader.yawRad);
      const s = Math.sin(leader.yawRad);
      _tmp.set(leader.body.position.x + c * f[0] + s * f[1], 0, leader.body.position.z - s * f[0] + c * f[1]);
      if (ctx.nav.walkable(_tmp.x, _tmp.z) && m.body.position.distanceToXZ(_tmp) > 1.5) m.setMoveTarget(_tmp, false);
    }
  }

  private doAlert(m: Soldier, dt: number): void {
    m.alertSeconds += dt;
    m.leanTargetM = 0;
    m.stance = 'stand';
    if (!m.hasLastKnown) {
      m.state = 'patrol';
      return;
    }
    // Search: each member takes a point around the last known position.
    const idx = this.members.indexOf(m);
    const a = idx * 1.7 + m.alertSeconds * 0.05;
    _tmp.set(m.lastKnown.x + Math.cos(a) * 5, 0, m.lastKnown.z + Math.sin(a) * 5);
    m.setMoveTarget(_tmp, m.alertSeconds < 10);
    if (m.atMoveTarget()) m.yawRad += dt * 0.8; // look around
    else if (m.alertSeconds < 3) m.aimAt(_tmp.set(m.lastKnown.x, m.lastKnown.y + 1.4, m.lastKnown.z), dt);
    if (m.alertSeconds > AI.alertSearchSeconds) {
      m.state = 'patrol';
      m.hasLastKnown = false;
      m.awareness = 0;
    }
  }

  private doEngage(m: Soldier, ctx: AiContext, dt: number): void {
    const threat = m.seesPlayer ? ctx.player.body.position : this.knowsPos ? this.knownPos : m.lastKnown;
    if (!m.cover || (m.coverPhase === 'moving' && m.atMoveTarget() && m.body.position.distanceToXZ(m.cover.pos) > 2)) {
      if (!m.pickCover(ctx, threat, 12, AI.coverSearchRadiusM)) {
        // No cover: drop and fight from where we are.
        m.clearMoveTarget();
        m.stance = m.role === 'support' ? 'prone' : 'crouch';
      }
    }
    // Staying in cover that has been flanked is pointless: re-evaluate when seen from the side.
    if (m.cover && m.coverPhase === 'hide' && m.seesPlayer && m.body.position.distanceToXZ(ctx.player.body.position) < 30) {
      const hidden = ctx.world.lineBlocked(m.eye(_eye), _tmp.copy(ctx.player.body.position).addScaled(_up, 1.3), true);
      if (!hidden) m.cover = null;
    }
    const phase = m.cover ? m.runCoverCycle(dt) : 'peek';
    _aim.copy(ctx.player.hitboxes.partCenter('chest'));
    if (!m.seesPlayer) _aim.set(threat.x, threat.y + 1.2, threat.z);
    const err = m.aimAt(_aim, dt);
    if (phase === 'peek' || (phase === 'moving' && m.seesPlayer && m.role !== 'point')) {
      if (m.seesPlayer && err < 0.08) m.shootAt(ctx, _aim, true, dt);
      else if (m.role === 'support' && this.knowsPos && this.knownAgeSeconds < 8 && err < 0.12) m.shootAt(ctx, _aim, false, dt);
    }
    // Lost contact for a while: go look.
    if (!m.seesPlayer && m.timeSinceSeenSeconds > AI.engageLoseSightSeconds && this.knownAgeSeconds > AI.engageLoseSightSeconds && m.role !== 'support') {
      m.state = 'alert';
      m.alertSeconds = 0;
      m.cover = null;
      m.lastKnown.copy(this.knownPos);
    }
  }

  private doFlank(m: Soldier, ctx: AiContext, dt: number): void {
    m.stance = 'stand';
    m.leanTargetM = 0;
    if (m.seesPlayer) {
      _aim.copy(ctx.player.hitboxes.partCenter('chest'));
      if (m.aimAt(_aim, dt) < 0.08 && m.body.position.distanceToXZ(ctx.player.body.position) < 60) m.shootAt(ctx, _aim, true, dt);
    }
    if (m.atMoveTarget()) {
      m.state = 'engage';
      m.cover = null;
    }
  }

  private doRegroup(m: Soldier, ctx: AiContext, dt: number): void {
    this.regroupSeconds += dt / Math.max(1, this.members.filter((x) => x.alive).length);
    if (!m.cover) m.pickCover(ctx, this.knownPos, 30, 45);
    const phase = m.runCoverCycle(dt);
    if (phase !== 'moving') m.stance = 'crouch';
    if (m.seesPlayer) {
      _aim.copy(ctx.player.hitboxes.partCenter('chest'));
      if (m.aimAt(_aim, dt) < 0.08 && phase !== 'moving') m.shootAt(ctx, _aim, true, dt);
    }
    if (this.regroupSeconds > 10) {
      m.state = 'engage';
      m.cover = null;
    }
  }

  private checkLeader(ctx: AiContext): void {
    if (this.leaderDead) return;
    const leader = this.members.find((m) => m.role === 'leader');
    if (!leader || leader.alive) return;
    this.leaderDead = true;
    this.regroupSeconds = 0;
    const survivors = this.members.filter((m) => m.alive && m.state !== 'dormant');
    for (const m of survivors) {
      m.state = 'regroup';
      m.cover = null;
    }
    if (survivors[0]) ctx.events.push({ type: 'callout', pos: survivors[0].body.position.clone(), text: 'fallback' });
    // Support steps up as leader after the fall-back.
    const next = survivors.find((m) => m.role === 'support') ?? survivors[0];
    if (next) next.role = 'leader';
    this.leaderDead = !next;
    this.flankCalled = false;
    this.engagedSeconds = 0;
  }

  /** Leader calls a flank once the squad has been engaged for a few seconds. */
  private maybeCallFlank(ctx: AiContext): void {
    if (this.flankCalled || !this.knowsPos || this.engagedSeconds < AI.flankDelaySeconds) return;
    const leader = this.leader;
    if (!leader || leader.state === 'regroup') return;
    const flankers = this.members.filter((m) => m.alive && (m.role === 'point' || m.role === 'rifleman'));
    if (flankers.length === 0) return;
    // Side vector of the squad → player axis; flank to whichever side is walkable.
    _axis.subVectors(this.knownPos, leader.body.position);
    _axis.y = 0;
    const dist = _axis.length();
    if (dist < 8) return;
    _axis.scale(1 / dist);
    const flankDist = Math.min(35, Math.max(18, dist * 0.6));
    let placed = 0;
    for (const side of [1, -1]) {
      for (const f of flankers) {
        if (f.state === 'flank') continue;
        _tmp.set(this.knownPos.x - _axis.z * side * flankDist - _axis.x * 6, 0, this.knownPos.z + _axis.x * side * flankDist - _axis.z * 6);
        const spot = ctx.nav.nearestWalkable(_tmp.x, _tmp.z, _tmp);
        if (!spot) continue;
        f.state = 'flank';
        f.cover = null;
        f.setMoveTarget(spot, true);
        placed++;
        break;
      }
      if (placed >= Math.min(2, flankers.length)) break;
    }
    if (placed > 0) {
      this.flankCalled = true;
      ctx.events.push({ type: 'callout', pos: leader.body.position.clone(), text: 'flank' });
    }
  }

  /** Grenade a player who stays in one spot for more than 8 s (brief). */
  private maybeGrenade(ctx: AiContext): void {
    if (this.grenadeCooldown > 0 || ctx.player.campSeconds < AI.grenadeCampSeconds || !this.knowsPos || this.knownAgeSeconds > 6) return;
    const thrower = this.members.find(
      (m) => m.alive && m.state !== 'dormant' && m.grenadeCooldown <= 0 && m.body.position.distanceToXZ(ctx.player.body.position) < 38 && m.body.position.distanceToXZ(ctx.player.body.position) > 8,
    );
    if (!thrower) return;
    m_throw(thrower, ctx, this.knownPos);
    thrower.grenadeCooldown = AI.grenadeCooldownSeconds;
    this.grenadeCooldown = AI.grenadeCooldownSeconds * 0.6;
    ctx.events.push({ type: 'callout', pos: thrower.body.position.clone(), text: 'grenade' });
  }
}

/** Lob a frag at a 40° launch, speed solved for flat ground, with a random short/long error. */
function m_throw(m: Soldier, ctx: AiContext, target: Vec3): void {
  m.eye(_eye);
  _eye.y += 0.3;
  const dx = target.x - _eye.x;
  const dz = target.z - _eye.z;
  const range = Math.hypot(dx, dz) * ctx.rng.range(0.85, 1.1);
  const angle = 0.7;
  const dh = target.y - _eye.y;
  const denom = 2 * Math.cos(angle) ** 2 * (range * Math.tan(angle) - dh);
  const speed = denom > 0 ? Math.min(GRENADES.throwSpeedMs * 1.2, Math.sqrt((PHYSICS.gravityMs2 * range * range) / denom)) : GRENADES.throwSpeedMs;
  const yaw = Math.atan2(-dx, -dz) + ctx.rng.range(-0.08, 0.08);
  Grenades.throwVelocity(yaw, angle - GRENADES.throwUpBiasRad, speed, _zero, _vel);
  ctx.grenades.throw('frag', _eye, _vel, GRENADES.fuseFragSeconds - 1.2, false, ctx.events);
}

const _tmp = new Vec3();
const _aim = new Vec3();
const _axis = new Vec3();
const _eye = new Vec3();
const _vel = new Vec3();
const _zero = new Vec3();
const _up = new Vec3(0, 1, 0);
