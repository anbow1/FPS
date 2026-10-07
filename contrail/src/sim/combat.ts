import { Vec3 } from '../core/vec.ts';
import { AIRCRAFT, type AircraftId } from '../config.ts';
import { Aircraft } from './aircraft.ts';
import { neutralInput, type PilotInput } from './controlLaws.ts';
import { RADAR, Radar, type GroundHeight, type RadarBody, WarningReceiver } from './radar.ts';
import { createStores, type Decoy, dispense, GUN, gunDirection, MISSILES, Missile, type MissileKind, type Round, stepDecoy, stepRound, stepStores, type Stores } from './weapons.ts';

// The fight: every aircraft with its radar, warning receiver and stores, and
// everything in the air between them — rounds, missiles, flares and chaff.
// Pure logic, fixed step, no rendering: the player and the AI drive it through
// the same `Orders`, so neither can do what the other cannot.

export type WeaponMode = 'gun' | 'srm' | 'mrm';

/** What a pilot (player or AI) asks for this step. */
export interface Orders {
  flight: PilotInput;
  trigger: boolean;
  /** Edge-triggered: launch the selected missile, drop countermeasures, radar commands. */
  launch: boolean;
  flare: boolean;
  chaff: boolean;
  designate: boolean;
  breakLock: boolean;
  cycleRadar: boolean;
  weapon: WeaponMode;
}

export function createOrders(): Orders {
  return { flight: neutralInput(), trigger: false, launch: false, flare: false, chaff: false, designate: false, breakLock: false, cycleRadar: false, weapon: 'gun' };
}

export interface Combatant {
  id: number;
  kind: AircraftId;
  aircraft: Aircraft;
  radar: Radar;
  rwr: WarningReceiver;
  stores: Stores;
  /** 1 = intact, 0 = destroyed. */
  health: number;
  alive: boolean;
  /** Seconds since destroyed (for the wreck's fall and the respawn). */
  deadS: number;
  gunAccumulator: number;
  /** The radar body view of this aircraft (shared vectors). */
  body: RadarBody;
  isPlayer: boolean;
}

export interface Explosion {
  position: Vec3;
  ageS: number;
  size: number;
}

export interface CombatEvents {
  /** Missiles launched this step (for sounds and the missile camera). */
  launches: Missile[];
  explosions: Explosion[];
  /** Rounds that struck an aircraft this step. */
  hits: { targetId: number; position: Vec3 }[];
}

/** The hit sphere radius of an airframe (m): half the span, a generous game choice. */
function hitRadiusM(kind: AircraftId): number {
  return AIRCRAFT[kind].aero.spanM * 0.45;
}

export class Combat {
  readonly fighters: Combatant[] = [];
  readonly rounds: Round[] = [];
  readonly missiles: Missile[] = [];
  readonly decoys: Decoy[] = [];
  readonly explosions: Explosion[] = [];
  nowS = 0;
  private nextId = 1;

  constructor(private readonly rand: () => number) {}

  add(kind: AircraftId, isPlayer: boolean, aircraft?: Aircraft): Combatant {
    const ac = aircraft ?? new Aircraft(kind, 0.7);
    const c: Combatant = {
      id: this.nextId++,
      kind,
      aircraft: ac,
      radar: new Radar(RADAR[kind]),
      rwr: new WarningReceiver(),
      stores: createStores(kind),
      health: 1,
      alive: true,
      deadS: 0,
      gunAccumulator: 0,
      body: { id: 0, position: ac.position, velocity: ac.velocity, orientation: ac.orientation, signatureFront: AIRCRAFT[kind].signatureFront, signatureSide: AIRCRAFT[kind].signatureSide, alive: true },
      isPlayer,
    };
    c.body.id = c.id;
    this.fighters.push(c);
    return c;
  }

  get(id: number): Combatant | undefined {
    return this.fighters.find((f) => f.id === id);
  }

  /** Resets a fighter's stores and health (respawn). */
  rearm(c: Combatant): void {
    c.stores = createStores(c.kind);
    c.health = 1;
    c.alive = true;
    c.body.alive = true;
    c.deadS = 0;
    c.aircraft.crashed = false;
    c.radar.breakLock('search');
    c.radar.contacts.clear();
  }

  step(dtS: number, orders: Map<number, Orders>, groundAt: GroundHeight, sunDir: Vec3, events: CombatEvents): void {
    this.nowS += dtS;
    const bodies = this.fighters.map((f) => f.body);
    for (const f of this.fighters) {
      const o = orders.get(f.id) ?? createOrders();
      const ac = f.aircraft;
      if (!f.alive) {
        // The wreck falls without control.
        f.deadS += dtS;
        const limp = neutralInput();
        limp.throttle = 0;
        if (!ac.crashed) ac.step(limp, dtS, groundAt);
        continue;
      }
      ac.step(o.flight, dtS, groundAt);
      if (ac.crashed) this.kill(f, events, 1.5);
      stepStores(f.stores, dtS);
      // ---- radar
      if (o.cycleRadar) f.radar.cycleMode();
      if (o.designate) f.radar.designate();
      if (o.breakLock) f.radar.breakLock('search');
      f.radar.step(dtS, this.nowS, ac.position, ac.velocity, ac.orientation, bodies.filter((b) => b.id !== f.id), groundAt);
      // ---- gun
      if (o.trigger && o.weapon === 'gun' && f.stores.gunRounds > 0) {
        f.gunAccumulator += dtS * GUN.roundsPerS;
        const dir = gunDirection(ac.orientation);
        while (f.gunAccumulator >= 1 && f.stores.gunRounds > 0) {
          f.gunAccumulator -= 1;
          f.stores.gunRounds--;
          const muzzle = ac.position.clone().addScaled(dir, 6);
          const jitter = new Vec3((this.rand() - 0.5) * 0.004, (this.rand() - 0.5) * 0.004, (this.rand() - 0.5) * 0.004);
          const vel = ac.velocity.clone().addScaled(dir.clone().add(jitter).normalize(), GUN.muzzleMs);
          this.rounds.push({ position: muzzle, velocity: vel, ageS: 0, tracer: f.stores.gunRounds % 5 === 0, ownerId: f.id });
        }
      } else f.gunAccumulator = 0;
      // ---- missiles
      if (o.launch && o.weapon !== 'gun') this.tryLaunch(f, o.weapon, events);
      // ---- countermeasures
      if (o.flare) dispense(f.stores, 'flare', ac.position, ac.velocity, f.id, this.decoys);
      if (o.chaff) dispense(f.stores, 'chaff', ac.position, ac.velocity, f.id, this.decoys);
    }
    // Paints for the warning receivers: radars' search and track beams, missiles guiding.
    for (const f of this.fighters) {
      if (!f.alive) continue;
      for (const [id, level] of f.radar.painted) this.get(id)?.rwr.paint(f.id, level, f.aircraft.position, this.get(id)!.aircraft.position, this.get(id)!.aircraft.orientation, this.nowS);
    }
    for (const m of this.missiles) {
      const t = this.get(m.targetId);
      if (!t || m.state !== 'guiding') continue;
      // An active radar missile, or one riding the launcher's lock, sets off the launch warning.
      if (m.spec.kind === 'mrm' && (m.active || this.get(m.ownerId)?.radar.locked)) t.rwr.paint(1000 + m.ownerId, 'launch', m.active ? m.position : this.get(m.ownerId)!.aircraft.position, t.aircraft.position, t.aircraft.orientation, this.nowS);
    }
    for (const f of this.fighters) f.rwr.step(this.nowS);
    // ---- rounds
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i]!;
      const from = r.position.clone();
      stepRound(r, dtS);
      let gone = r.ageS > 4 || r.position.y < groundAt(r.position.x, r.position.z);
      for (const f of this.fighters) {
        if (!f.alive || f.id === r.ownerId) continue;
        if (segmentHitsSphere(from, r.position, f.aircraft.position, hitRadiusM(f.kind))) {
          events.hits.push({ targetId: f.id, position: r.position.clone() });
          f.health -= 0.06;
          if (f.health <= 0) this.kill(f, events, 1.2);
          gone = true;
          break;
        }
      }
      if (gone) this.rounds.splice(i, 1);
    }
    // ---- missiles
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i]!;
      const t = this.get(m.targetId);
      const owner = this.get(m.ownerId);
      const datalink = !!owner && owner.alive && owner.radar.locked && owner.radar.targetId === m.targetId;
      m.step(dtS, t && t.alive ? t.body : null, datalink, this.decoys, sunDir, this.rand);
      if (m.state === 'hit' && t) {
        const dmg = m.lethality();
        t.health -= dmg;
        events.explosions.push({ position: m.position.clone(), ageS: 0, size: m.spec.kind === 'mrm' ? 9 : 6 });
        this.explosions.push(events.explosions[events.explosions.length - 1]!);
        if (t.health <= 0) this.kill(t, events, 1.6);
      }
      if (m.state === 'hit' || m.state === 'missed') {
        if (m.state === 'missed' && m.position.y > groundAt(m.position.x, m.position.z) + 5) {
          // Self-destruct in the air.
          const e = { position: m.position.clone(), ageS: 0, size: 3 };
          events.explosions.push(e);
          this.explosions.push(e);
        }
        this.missiles.splice(i, 1);
      }
    }
    // ---- decoys and explosions
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i]!;
      stepDecoy(d, dtS);
      if (d.ageS > d.lifeS) this.decoys.splice(i, 1);
    }
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i]!.ageS += dtS;
      if (this.explosions[i]!.ageS > 6) this.explosions.splice(i, 1);
    }
  }

  private kill(f: Combatant, events: CombatEvents, size: number): void {
    if (!f.alive) return;
    f.alive = false;
    f.body.alive = false;
    f.health = 0;
    const e = { position: f.aircraft.position.clone(), ageS: 0, size: 14 * size };
    events.explosions.push(e);
    this.explosions.push(e);
  }

  /** Launches the selected missile if the seeker or the radar says it can guide. */
  tryLaunch(f: Combatant, kind: MissileKind, events: CombatEvents): boolean {
    const stores = f.stores;
    if (kind === 'srm' ? stores.srm <= 0 : stores.mrm <= 0) return false;
    const target = this.launchTarget(f, kind);
    if (!target) return false;
    const ac = f.aircraft;
    const fwd = ac.orientation.rotate(new Vec3(0, 0, -1));
    const down = ac.orientation.rotate(new Vec3(0, -1, 0));
    // Off the rail (short range) or dropped clear of the bay (medium range), then the motor lights.
    const pos = ac.position.clone().addScaled(down, kind === 'mrm' ? 1.5 : 0.6);
    const vel = ac.velocity.clone().addScaled(fwd, 15).addScaled(down, kind === 'mrm' ? 6 : 0);
    const m = new Missile(MISSILES[kind], f.id, target.id, pos, vel, target.aircraft.position);
    this.missiles.push(m);
    events.launches.push(m);
    if (kind === 'srm') stores.srm--;
    else stores.mrm--;
    return true;
  }

  /**
   * Who the selected missile would go for: the radar's locked target (medium range), or the nearest
   * enemy inside the infrared seeker's cone and range (short range).
   */
  launchTarget(f: Combatant, kind: MissileKind): Combatant | null {
    if (kind === 'mrm') {
      if (!f.radar.locked || f.radar.targetId === null) return null;
      const t = this.get(f.radar.targetId);
      return t && t.alive ? t : null;
    }
    const fwd = f.aircraft.orientation.rotate(new Vec3(0, 0, -1));
    const spec = MISSILES.srm;
    let best: Combatant | null = null;
    let bestRange = Infinity;
    for (const t of this.fighters) {
      if (t === f || !t.alive) continue;
      const los = new Vec3().subVectors(t.aircraft.position, f.aircraft.position);
      const r = los.length();
      if (r > spec.seekerRangeM || r < 300) continue;
      // The seeker is slaved to the radar when it has a lock, otherwise it looks off the nose.
      const cone = f.radar.locked && f.radar.targetId === t.id ? spec.seekerHalfRad : spec.seekerHalfRad * 0.6;
      if (fwd.dot(los.scale(1 / r)) < Math.cos(cone)) continue;
      if (r < bestRange) {
        bestRange = r;
        best = t;
      }
    }
    return best;
  }
}

function segmentHitsSphere(a: Vec3, b: Vec3, c: Vec3, r: number): boolean {
  const ab = new Vec3().subVectors(b, a);
  const ac = new Vec3().subVectors(c, a);
  const len2 = ab.dot(ab);
  const t = len2 > 0 ? Math.max(0, Math.min(1, ac.dot(ab) / len2)) : 0;
  const p = a.clone().addScaled(ab, t);
  return p.distanceTo(c) < r;
}

export function createEvents(): CombatEvents {
  return { launches: [], explosions: [], hits: [] };
}
