import { Vec3 } from '../core/vec.ts';
import type { Quat } from '../core/quat.ts';
import { atmosphereAt } from './atmosphere.ts';
import { inNotch, type RadarBody } from './radar.ts';

// Weapons as game abstractions (brief: invented curves that feel right; no
// real seeker or fuzing engineering):
//
//   gun    rounds with a real time of flight: muzzle velocity plus the
//          shooter's, gravity and drag; every fifth a tracer. A burst limit.
//   SRM    infrared missile: a seeker cone off the nose, short hot motor,
//          high G, proportional navigation; decoyed by flares and by the sun
//          near the line of sight.
//   MRM    radar missile: guided on the launcher's track while the launcher
//          holds the lock, active on its own seeker for the last 15 km; a long
//          motor but a lot of drag, so a shot at maximum range arrives slow and
//          usually misses. Chaff and the notch defeat the active seeker.
//   flares and chaff: finite, a short cooldown, each fooling one guidance type.

export const GRAVITY = 9.81;

export interface GunSpec {
  rounds: number;
  muzzleMs: number;
  roundsPerS: number;
  /** Drag factor for rounds (1/m at sea-level density): deceleration = k·ρ/ρ₀·v². */
  dragPerM: number;
}

export const GUN: GunSpec = { rounds: 180, muzzleMs: 1050, roundsPerS: 55, dragPerM: 0.00042 };

export interface Round {
  position: Vec3;
  velocity: Vec3;
  ageS: number;
  tracer: boolean;
  ownerId: number;
}

/** Steps a round: gravity and quadratic drag scaled by air density. */
export function stepRound(r: Round, dtS: number): void {
  const rho = atmosphereAt(r.position.y).densityKgM3 / 1.225;
  const v = r.velocity.length();
  const k = GUN.dragPerM * rho * v;
  r.velocity.x -= r.velocity.x * k * dtS;
  r.velocity.y -= (r.velocity.y * k + GRAVITY) * dtS;
  r.velocity.z -= r.velocity.z * k * dtS;
  r.position.addScaled(r.velocity, dtS);
  r.ageS += dtS;
}

/** Where a round fired now along the gun line will be after flying `rangeM` (world), and its time of flight. */
export function gunImpact(ownPos: Vec3, ownVel: Vec3, gunDir: Vec3, rangeM: number): { point: Vec3; tofS: number } {
  const r: Round = { position: ownPos.clone(), velocity: ownVel.clone().addScaled(gunDir, GUN.muzzleMs), ageS: 0, tracer: false, ownerId: -1 };
  const dt = 1 / 120;
  // Range measured from the muzzle in the shooter's frame (the shooter keeps flying alongside).
  const rel = new Vec3();
  while (r.ageS < 4) {
    stepRound(r, dt);
    rel.subVectors(r.position, ownPos).addScaled(ownVel, -r.ageS);
    if (rel.length() >= rangeM) break;
  }
  return { point: r.position, tofS: r.ageS };
}

export type MissileKind = 'srm' | 'mrm';

export interface MissileSpec {
  kind: MissileKind;
  burnS: number;
  /** Motor acceleration (m/s²) and drag factor (1/m at sea level). */
  thrustMs2: number;
  dragPerM: number;
  /** Lateral acceleration limit (G) and the speed below which it fades. */
  maxG: number;
  /** Seeker cone half-angle off the missile's nose (rad) and seeker range (m). */
  seekerHalfRad: number;
  seekerRangeM: number;
  /** Proximity fuse radius (m) and lethal radius (m). */
  fuseM: number;
  lethalM: number;
  timeoutS: number;
  /** Below this speed after burn-out the missile is spent. */
  minSpeedMs: number;
}

export const MISSILES: Record<MissileKind, MissileSpec> = {
  srm: { kind: 'srm', burnS: 2.6, thrustMs2: 260, dragPerM: 0.00024, maxG: 40, seekerHalfRad: (45 * Math.PI) / 180, seekerRangeM: 11_000, fuseM: 10, lethalM: 7, timeoutS: 22, minSpeedMs: 260 },
  mrm: { kind: 'mrm', burnS: 7, thrustMs2: 150, dragPerM: 0.00011, maxG: 30, seekerHalfRad: (40 * Math.PI) / 180, seekerRangeM: 15_000, fuseM: 15, lethalM: 10, timeoutS: 70, minSpeedMs: 300 },
};

export interface Decoy {
  kind: 'flare' | 'chaff';
  position: Vec3;
  velocity: Vec3;
  ageS: number;
  lifeS: number;
  ownerId: number;
}

export type MissileState = 'guiding' | 'ballistic' | 'hit' | 'missed';

export class Missile {
  readonly position: Vec3;
  readonly velocity: Vec3;
  ageS = 0;
  state: MissileState = 'guiding';
  /** MRM: guided on the launcher's data until its own seeker takes over. */
  active = false;
  /** Seeker locked onto a decoy or the sun instead of the target. */
  decoyed: Decoy | 'sun' | null = null;
  /** Last known target position (from the seeker or the datalink). */
  readonly aim: Vec3;
  readonly aimVel = new Vec3();
  private readonly prevLos = new Vec3();
  private hasLos = false;
  missDistanceM = Infinity;

  constructor(
    readonly spec: MissileSpec,
    readonly ownerId: number,
    readonly targetId: number,
    position: Vec3,
    velocity: Vec3,
    target: Vec3,
  ) {
    this.position = position.clone();
    this.velocity = velocity.clone();
    this.aim = target.clone();
  }

  get burning(): boolean {
    return this.ageS < this.spec.burnS;
  }

  get speedMs(): number {
    return this.velocity.length();
  }

  /**
   * One step. `target` is the intended body; `datalink` is true while the launcher still holds its
   * radar lock (MRM); `decoys` are flares and chaff in the air; `sunDir` the direction to the sun;
   * `rand` a 0…1 source (seeded in tests).
   */
  step(dtS: number, target: RadarBody | null, datalink: boolean, decoys: readonly Decoy[], sunDir: Vec3, rand: () => number): void {
    if (this.state === 'hit' || this.state === 'missed') return;
    const s = this.spec;
    this.ageS += dtS;
    const fwd = this.velocity.clone().normalize();
    // ---- what the guidance steers at
    if (target && target.alive && !this.decoyed) {
      const los = new Vec3().subVectors(target.position, this.position);
      const range = los.length();
      los.scale(1 / Math.max(range, 1));
      const inCone = fwd.dot(los) > Math.cos(s.seekerHalfRad) && range < s.seekerRangeM;
      if (s.kind === 'srm') {
        if (inCone) {
          this.aim.copy(target.position);
          this.aimVel.copy(target.velocity);
        } else this.state = 'ballistic';
      } else {
        if (!this.active && range < s.seekerRangeM && inCone) this.active = true;
        if (this.active) {
          // The active seeker is a doppler radar too: a target in the notch drops out.
          if (inCone && !inNotch(this.position, target)) {
            this.aim.copy(target.position);
            this.aimVel.copy(target.velocity);
          } else if (!inCone) this.state = 'ballistic';
        } else if (datalink) {
          this.aim.copy(target.position);
          this.aimVel.copy(target.velocity);
        } else {
          // No datalink: fly on to where the target was going.
          this.aim.addScaled(this.aimVel, dtS);
        }
      }
      // Decoys inside the seeker cone may seduce it, once each per decoy age.
      for (const d of decoys) {
        const fits = (s.kind === 'srm' && d.kind === 'flare') || (s.kind === 'mrm' && this.active && d.kind === 'chaff');
        if (!fits || d.ageS > 0.6 || d.ageS < 0.15) continue;
        const dl = new Vec3().subVectors(d.position, this.position);
        const dr = dl.length();
        if (dr > s.seekerRangeM || fwd.dot(dl.scale(1 / dr)) < Math.cos(s.seekerHalfRad)) continue;
        // About a one-in-four chance per decoy over its effective first half-second; a notching
        // target makes chaff far more convincing.
        let p = s.kind === 'srm' ? 0.011 : 0.009;
        if (s.kind === 'mrm' && inNotch(this.position, target)) p *= 3;
        if (rand() < p * dtS * 60) this.decoyed = d;
      }
      // The sun near the line of sight seduces an infrared seeker.
      if (s.kind === 'srm' && !this.decoyed && los.dot(sunDir) > Math.cos((12 * Math.PI) / 180) && rand() < 0.02 * dtS * 60) this.decoyed = 'sun';
    }
    if (this.decoyed === 'sun') this.aim.copy(this.position).addScaled(sunDir, 50_000);
    else if (this.decoyed) this.aim.copy(this.decoyed.position);
    // ---- proportional navigation (N = 4) on the line-of-sight rate, plus gravity compensation
    const accel = new Vec3();
    if (this.state === 'guiding') {
      const los = new Vec3().subVectors(this.aim, this.position);
      const range = los.length();
      los.scale(1 / Math.max(range, 1));
      if (this.hasLos) {
        const losRate = new Vec3().subVectors(los, this.prevLos).scale(1 / dtS);
        const closing = Math.max(this.speedMs, 100);
        accel.copy(losRate).scale(4 * closing);
        // Only the component across the flight path steers.
        accel.addScaled(fwd, -accel.dot(fwd));
        accel.y += GRAVITY;
      }
      this.prevLos.copy(los);
      this.hasLos = true;
    }
    // Lateral limit: full G at speed, fading as dynamic pressure falls.
    const rho = atmosphereAt(this.position.y).densityKgM3;
    const q = 0.5 * rho * this.speedMs * this.speedMs;
    const gLimit = s.maxG * GRAVITY * Math.min(1, q / 120_000);
    const a = accel.length();
    if (a > gLimit) accel.scale(gLimit / a);
    // ---- motor, drag (rising with manoeuvre), gravity
    const v = this.speedMs;
    const induced = 1 + (accel.length() / Math.max(gLimit, 1)) * 1.5;
    const drag = s.dragPerM * (rho / 1.225) * v * v * induced;
    accel.addScaled(fwd, (this.burning ? s.thrustMs2 : 0) - drag);
    accel.y -= GRAVITY;
    this.velocity.addScaled(accel, dtS);
    this.position.addScaled(this.velocity, dtS);
    // ---- fuse and end of flight
    if (target && target.alive) {
      const d = this.position.distanceTo(target.position);
      this.missDistanceM = Math.min(this.missDistanceM, d);
      if (d < s.fuseM) this.state = 'hit';
    }
    if (this.state !== 'hit' && (this.ageS > s.timeoutS || (!this.burning && this.speedMs < s.minSpeedMs) || this.position.y < 0)) this.state = 'missed';
  }

  /** Damage dealt at detonation: certain inside half the lethal radius, falling to nothing at the fuse radius. */
  lethality(): number {
    if (this.state !== 'hit') return 0;
    const d = this.missDistanceM;
    const s = this.spec;
    if (d <= s.lethalM * 0.5) return 1;
    return Math.max(0, 1 - (d - s.lethalM * 0.5) / (s.fuseM - s.lethalM * 0.5)) * 0.9 + 0.1;
  }
}

export interface Stores {
  gunRounds: number;
  srm: number;
  mrm: number;
  flares: number;
  chaff: number;
  /** Seconds until the next countermeasure salvo of each kind. */
  flareCooldownS: number;
  chaffCooldownS: number;
}

export function createStores(kind: 'wraith' | 'talon'): Stores {
  return kind === 'wraith' ? { gunRounds: 180, srm: 2, mrm: 4, flares: 30, chaff: 30, flareCooldownS: 0, chaffCooldownS: 0 } : { gunRounds: 150, srm: 4, mrm: 4, flares: 48, chaff: 48, flareCooldownS: 0, chaffCooldownS: 0 };
}

/** Dispenses a salvo of two decoys behind the aircraft if the cooldown allows. */
export function dispense(stores: Stores, kind: 'flare' | 'chaff', pos: Vec3, vel: Vec3, ownerId: number, out: Decoy[]): boolean {
  const left = kind === 'flare' ? stores.flares : stores.chaff;
  const cd = kind === 'flare' ? stores.flareCooldownS : stores.chaffCooldownS;
  if (left <= 0 || cd > 0) return false;
  for (let i = 0; i < Math.min(2, left); i++) {
    const v = vel.clone().scale(0.75);
    v.x += (i === 0 ? -1 : 1) * 25;
    v.y -= 15;
    out.push({ kind, position: pos.clone(), velocity: v, ageS: 0, lifeS: kind === 'flare' ? 4.5 : 3.5, ownerId });
  }
  if (kind === 'flare') {
    stores.flares -= Math.min(2, left);
    stores.flareCooldownS = 0.45;
  } else {
    stores.chaff -= Math.min(2, left);
    stores.chaffCooldownS = 0.45;
  }
  return true;
}

/** Flares fall and slow; chaff blooms and hangs. */
export function stepDecoy(d: Decoy, dtS: number): void {
  const k = d.kind === 'flare' ? 0.9 : 3;
  d.velocity.scale(Math.exp(-k * dtS));
  d.velocity.y -= (d.kind === 'flare' ? GRAVITY : 1) * dtS;
  d.position.addScaled(d.velocity, dtS);
  d.ageS += dtS;
}

/** Launch envelope by fly-out against a target holding its course: returns the miss distance (m). */
export function predictShot(spec: MissileSpec, launchPos: Vec3, launchVel: Vec3, target: RadarBody): { hit: boolean; timeS: number } {
  const m = new Missile(spec, -1, target.id, launchPos, launchVel, target.position);
  if (spec.kind === 'mrm') m.active = false;
  const t: RadarBody = { ...target, position: target.position.clone(), velocity: target.velocity.clone() };
  const dt = 1 / 30;
  const none: Decoy[] = [];
  const sun = new Vec3(0, -1, 0);
  for (let i = 0; i < spec.timeoutS * 30 && m.state === 'guiding'; i++) {
    t.position.addScaled(t.velocity, dt);
    m.step(dt, t, true, none, sun, () => 1);
  }
  return { hit: m.state === 'hit', timeS: m.ageS };
}

/** Steps the stores' cooldowns. */
export function stepStores(s: Stores, dtS: number): void {
  s.flareCooldownS = Math.max(0, s.flareCooldownS - dtS);
  s.chaffCooldownS = Math.max(0, s.chaffCooldownS - dtS);
}

/** Gun line in world space (the gun is bore-sighted a little above the nose line, as real guns are). */
export function gunDirection(rot: Quat): Vec3 {
  const d = new Vec3(0, Math.sin((1.5 * Math.PI) / 180), -1).normalize();
  return rot.rotate(d);
}
