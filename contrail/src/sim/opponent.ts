import { Vec3 } from '../core/vec.ts';
import { steer } from './autopilot.ts';
import type { Combat, Combatant, Orders } from './combat.ts';
import { createOrders } from './combat.ts';
import type { GroundHeight } from './radar.ts';
import { MISSILES, predictShot } from './weapons.ts';

// The AI pilot: a priority list re-evaluated at its reaction time, flying the
// same aircraft through the same flight director and control laws as the
// player (brief: "no cheating on thrust or turn rate"). It knows only what its
// radar, its warning receiver and its eyes tell it — and its eyes cannot see
// through cloud (`canSee`).
//
//   bug out    low on fuel or out of weapons: run for home, fast;
//   defend     a missile is coming: beam it (into the notch), dive, flares
//              and chaff, then come back;
//   break      an enemy close behind: maximum-G turn into him and flares;
//   attack     inside visual range: lead pursuit, short-range missile in the
//              cone, gun inside a kilometre — and unload to rebuild energy
//              rather than lose a slow turning fight;
//   intercept  a contact further out: climb above it (energy), close, take a
//              medium-range shot only when the fly-out says it reaches, then
//              crank off to the gimbal limit to keep supporting it;
//   patrol     nothing known: a racetrack round its station, radar searching.
//
// Difficulty changes reaction time and mistakes, never the aircraft.

export type Difficulty = 'easy' | 'normal' | 'hard';

const PROFILE: Record<Difficulty, { reactS: number; aimErrRad: number; shotMargin: number }> = {
  easy: { reactS: 1.0, aimErrRad: 0.05, shotMargin: 0.55 },
  normal: { reactS: 0.55, aimErrRad: 0.025, shotMargin: 0.75 },
  hard: { reactS: 0.3, aimErrRad: 0.01, shotMargin: 0.9 },
};

export type AiState = 'patrol' | 'intercept' | 'attack' | 'break' | 'defend' | 'bugout';

export class Opponent {
  state: AiState = 'patrol';
  private thinkS = 0;
  private readonly orders = createOrders();
  /** Last known enemy position and velocity, and when (game time). */
  private readonly enemyPos = new Vec3();
  private readonly enemyVel = new Vec3();
  private knownS = -1e9;
  private enemyId: number | null = null;
  private lastShotS = -1e9;
  private defendUntilS = 0;
  private readonly threat = new Vec3();
  private patrolAngle = 0;
  private readonly profile: (typeof PROFILE)[Difficulty];
  private aimJitter = new Vec3();

  constructor(
    readonly me: Combatant,
    readonly combat: Combat,
    difficulty: Difficulty,
    /** Station: the racetrack's centre and altitude. */
    readonly station: Vec3,
    private readonly rand: () => number,
  ) {
    this.profile = PROFILE[difficulty];
  }

  /** Decides (at the reaction time) and flies (every step). `canSee` is the eye: range, aspect and cloud. */
  update(dtS: number, groundAt: GroundHeight, canSee: (from: Combatant, to: Combatant) => boolean): Orders {
    const o = this.orders;
    o.launch = false;
    o.flare = false;
    o.chaff = false;
    o.designate = false;
    o.breakLock = false;
    o.cycleRadar = false;
    o.trigger = false;
    const me = this.me;
    const ac = me.aircraft;
    const now = this.combat.nowS;
    if (!me.alive) return o;
    // ---- what it knows: radar contacts, the eye, the warning receiver
    for (const f of this.combat.fighters) {
      if (f === me || !f.alive) continue;
      const c = me.radar.contacts.get(f.id);
      if ((c && now - c.lastSeenS < 0.5) || canSee(me, f)) {
        this.enemyPos.copy(f.aircraft.position);
        this.enemyVel.copy(f.aircraft.velocity);
        this.knownS = now;
        this.enemyId = f.id;
      }
    }
    const known = now - this.knownS < 20;
    if (known) this.enemyPos.addScaled(this.enemyVel, dtS);
    // Incoming missiles it can know about: a launch warning, or a smoke trail within a few km.
    let missile: Vec3 | null = null;
    let missileRange = Infinity;
    for (const m of this.combat.missiles) {
      if (m.targetId !== me.id || m.state !== 'guiding') continue;
      const r = m.position.distanceTo(ac.position);
      const warned = me.rwr.worst === 'launch' || r < 5000;
      if (warned && r < missileRange) {
        missileRange = r;
        missile = m.position;
      }
    }
    // ---- decide at the reaction time
    this.thinkS -= dtS;
    if (this.thinkS <= 0) {
      this.thinkS = this.profile.reactS * (0.8 + 0.4 * this.rand());
      this.aimJitter.set(this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5).scale(2 * this.profile.aimErrRad);
      const s = me.stores;
      const outOfWeapons = s.mrm + s.srm === 0 && s.gunRounds < 20;
      if (ac.fuelKg < ac.cfg.mass.internalFuelKg * 0.12 || outOfWeapons) this.state = 'bugout';
      else if (missile) {
        this.state = 'defend';
        this.threat.copy(missile);
        this.defendUntilS = now + 6;
      } else if (this.state === 'defend' && now < this.defendUntilS) {
        // keep defending a little after the warning stops
      } else if (known) {
        const range = this.enemyPos.distanceTo(ac.position);
        const behind = this.enemyBehind();
        if (range < 3500 && behind) this.state = 'break';
        else this.state = range < 10_000 ? 'attack' : 'intercept';
      } else this.state = 'patrol';
      // Radar: lock what it can see, keep searching otherwise.
      // (Designating again while a lock is building would restart it.)
      if (known && me.radar.mode !== 'stt' && me.radar.contacts.size > 0 && this.state !== 'bugout') o.designate = true;
    }
    // ---- fly
    const dir = new Vec3();
    let speed = 260;
    let maxG = ac.cfg.limiter.gMax * 0.8;
    switch (this.state) {
      case 'patrol': {
        this.patrolAngle += dtS * 0.025;
        const target = new Vec3(this.station.x + Math.sin(this.patrolAngle) * 12_000, this.station.y, this.station.z + Math.cos(this.patrolAngle) * 12_000);
        dir.subVectors(target, ac.position);
        dir.y *= 4;
        speed = 230;
        maxG = 3;
        break;
      }
      case 'intercept': {
        const range = this.enemyPos.distanceTo(ac.position);
        const lead = this.enemyPos.clone().addScaled(this.enemyVel, Math.min(range / 600, 20));
        // Climb above the enemy for the energy and a longer missile shot.
        lead.y = Math.min(11_500, Math.max(2500, this.enemyPos.y + 1500));
        dir.subVectors(lead, ac.position);
        speed = 300;
        maxG = 5;
        this.mediumRangeShot(o);
        // After a shot, crank: turn away to the edge of the radar's gimbal while the missile flies.
        if (now - this.lastShotS < 25 && me.radar.locked) {
          const toE = new Vec3().subVectors(this.enemyPos, ac.position).normalize();
          const side = new Vec3(-toE.z, 0, toE.x);
          dir.copy(toE).scale(Math.cos(0.85)).addScaled(side, Math.sin(0.85));
        }
        break;
      }
      case 'attack': {
        const range = this.enemyPos.distanceTo(ac.position);
        const tof = range / 900;
        const aim = this.enemyPos.clone().addScaled(this.enemyVel, tof);
        dir.subVectors(aim, ac.position).normalize().add(this.aimJitter);
        speed = 240;
        maxG = ac.cfg.limiter.gMax;
        // Refuse a slow turning fight: unload and extend to rebuild speed.
        if (ac.speedMs < 160) {
          dir.copy(ac.velocity).normalize();
          dir.y = Math.min(dir.y, -0.15);
          maxG = 1.5;
          speed = 400;
        }
        this.closeInShots(o, range);
        break;
      }
      case 'break': {
        // Hard turn into the attacker: the direction towards him, as tight as the airframe allows.
        dir.subVectors(this.enemyPos, ac.position);
        maxG = ac.cfg.limiter.gMax;
        speed = 400;
        o.flare = true;
        break;
      }
      case 'defend': {
        // Beam the missile: fly at right angles to it (into the notch), descending, dispensing.
        const toM = new Vec3().subVectors(this.threat, ac.position).normalize();
        const beam = new Vec3(-toM.z, 0, toM.x);
        if (beam.dot(ac.velocity) < 0) beam.scale(-1);
        dir.copy(beam).normalize();
        dir.y = ac.position.y - groundAt(ac.position.x, ac.position.z) > 2500 ? -0.35 : 0;
        maxG = ac.cfg.limiter.gMax * 0.9;
        speed = 400;
        if (missileRange < 6000) {
          o.flare = true;
          o.chaff = true;
        }
        break;
      }
      case 'bugout': {
        dir.subVectors(this.station, ac.position);
        dir.y = 0;
        if (known) dir.subVectors(ac.position, this.enemyPos);
        dir.y = 0;
        speed = 420;
        maxG = 4;
        break;
      }
    }
    // Never into the ground: below 600 m with the nose down, pull up whatever else it wants.
    const agl = ac.position.y - groundAt(ac.position.x, ac.position.z);
    if (agl < 600 + Math.max(0, -ac.velocity.y) * 4) {
      dir.copy(ac.velocity);
      dir.y = 0;
      dir.normalize();
      dir.y = 0.6;
      maxG = ac.cfg.limiter.gMax;
    }
    steer(ac, { direction: dir, speedMs: speed, maxG }, o.flight);
    return o;
  }

  /** The enemy sits behind the 3–9 line and points at us. */
  private enemyBehind(): boolean {
    const ac = this.me.aircraft;
    const fwd = ac.orientation.rotate(new Vec3(0, 0, -1));
    const toE = new Vec3().subVectors(this.enemyPos, ac.position).normalize();
    const enemyFwd = this.enemyVel.clone().normalize();
    return fwd.dot(toE) < -0.2 && enemyFwd.dot(toE) < -0.6;
  }

  /** Medium-range shot when locked and the fly-out (with a safety margin) says it reaches. */
  private mediumRangeShot(o: Orders): void {
    const me = this.me;
    if (!me.radar.locked || me.stores.mrm <= 0 || this.combat.nowS - this.lastShotS < 20) return;
    const t = this.combat.get(me.radar.targetId ?? -1);
    if (!t) return;
    // Shoot only well inside the envelope: test the shot from further away than we are.
    const back = me.aircraft.position.clone().addScaled(new Vec3().subVectors(me.aircraft.position, t.aircraft.position).normalize(), me.aircraft.position.distanceTo(t.aircraft.position) * (1 - this.profile.shotMargin));
    if (!predictShot(MISSILES.mrm, back, me.aircraft.velocity, t.body).hit) return;
    o.weapon = 'mrm';
    o.launch = true;
    this.lastShotS = this.combat.nowS;
  }

  /** Short-range missile in the seeker cone, gun inside a kilometre with the nose on. */
  private closeInShots(o: Orders, range: number): void {
    const me = this.me;
    const now = this.combat.nowS;
    const t = this.enemyId !== null ? this.combat.get(this.enemyId) : undefined;
    if (!t) return;
    if (me.stores.srm > 0 && now - this.lastShotS > 6 && range > 900 && this.combat.launchTarget(me, 'srm') === t && predictShot(MISSILES.srm, me.aircraft.position, me.aircraft.velocity, t.body).hit) {
      o.weapon = 'srm';
      o.launch = true;
      this.lastShotS = now;
      return;
    }
    const fwd = me.aircraft.orientation.rotate(new Vec3(0, 0, -1));
    const toE = new Vec3().subVectors(t.aircraft.position, me.aircraft.position).normalize();
    if (range < 1100 && fwd.dot(toE) > Math.cos(0.035)) {
      o.weapon = 'gun';
      o.trigger = true;
    }
  }
}
