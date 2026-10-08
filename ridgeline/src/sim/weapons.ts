import { PHYSICS, WEAPONS } from '../config.ts';
import { clamp, Vec3 } from '../core/vec.ts';
import { GroundForce, type GroundTarget } from './targets.ts';
import type { Helicopter } from './helicopter.ts';

// The attack helicopter's armament (brief, Weapons), every shot a flying
// body rather than a hitscan:
//
//   gun      30 mm class chin cannon on a turret slaved to the crew's line of
//            sight, within its travel and slew rate; rounds with a time of
//            flight, drag, gravity and a dispersion cone; every third a
//            tracer; a burst heats the barrel and an overheated gun stops
//            until it cools;
//   rockets  unguided, from fixed pods along the shaft line, fired in ripples
//            of 1 / 4 / 8; a short motor burn, then ballistic, dispersing
//            with range — the HUD cue shows where they would land now;
//   missile  fire-and-forget with a lock taken before launch: the target in
//            the line of sight, in range and not behind terrain — or the one
//            the laser designator is on, wherever the seeker box is;
//   laser    the designator: on, it ranges the point the crew's sight rests on
//            (the gun shoots there) and marks the vehicle at that spot. It climbs
//            over the target and dives onto its roof (top attack), steered
//            by a lateral-acceleration-limited pursuit with lead.
//
// Damage is splash round the impact plus a direct-hit bonus, scaled by the
// armour on the side that was hit (targets.ts). Expended stores leave the
// aircraft's mass.

export type WeaponId = 'gun' | 'rockets' | 'missile';
export const WEAPON_ORDER: readonly WeaponId[] = ['gun', 'rockets', 'missile'];
export type ShotKind = 'round' | 'rocket' | 'missile';

export interface Shot {
  readonly kind: ShotKind;
  readonly position: Vec3;
  readonly velocity: Vec3;
  ageS: number;
  readonly tracer: boolean;
  /** The missile's target (fire-and-forget: kept after launch whatever the crew does). */
  readonly target: GroundTarget | null;
  burning: boolean;
  alive: boolean;
}

/** An impact or explosion, for the effects and the sound: dust for a round in the dirt, a blast for the rest. */
export interface Blast {
  readonly position: Vec3;
  readonly kind: 'dust' | 'blast' | 'kill';
  readonly size: number;
  ageS: number;
}

/** Launch points in body axes (m): the gun's turret pivot, the rocket pods' fronts, the missile rails. */
export interface Hardpoints {
  gun: [number, number, number];
  pods: [number, number, number][];
  rails: [number, number, number][];
}

export interface FireEvents {
  /** Rounds fired this step, rockets and missiles launched, impacts and kills (positions for sound distances). */
  rounds: number;
  launches: Vec3[];
  blasts: Blast[];
  kills: GroundTarget[];
}

const BLAST_LIFE_S = 9;
const G = PHYSICS.gravityMs2;
const scratch = { a: new Vec3(), b: new Vec3(), c: new Vec3(), d: new Vec3() };

export class Armament {
  selected: WeaponId = 'gun';
  rounds: number = WEAPONS.gun.rounds;
  rockets: number = WEAPONS.rockets.count;
  missiles: number = WEAPONS.missile.count;
  /** Rockets per trigger press. */
  ripple: number = WEAPONS.rockets.ripples[0];
  /** Barrel heat 0…1 and whether it tripped. */
  heat = 0;
  overheated = false;
  /** Turret angles in body axes (rad): azimuth right +, elevation up +. */
  gunAzRad = 0;
  gunElRad = -0.1;
  /** The target the missile seeker holds (only while the missile is selected). */
  lock: GroundTarget | null = null;
  /** The laser designator: on or off, its range to the spot (m, 0 = no return) and the vehicle it marks. */
  laser = false;
  laserRangeM = 0;
  designated: GroundTarget | null = null;
  readonly shots: Shot[] = [];
  readonly blasts: Blast[] = [];
  readonly events: FireEvents = { rounds: 0, launches: [], blasts: [], kills: [] };
  private gunClockS = 0;
  private rippleLeft = 0;
  private rippleClockS = 0;
  private podIndex = 0;
  private railIndex = 0;
  private roundCount = 0;
  private wasTrigger = false;

  constructor(
    readonly hardpoints: Hardpoints,
    private readonly random: () => number = Math.random,
  ) {}

  /** Stores mass still aboard (kg). */
  get storesKg(): number {
    return this.rounds * WEAPONS.gun.massKg + this.rockets * WEAPONS.rockets.massKg + this.missiles * WEAPONS.missile.massKg;
  }

  /** Stores mass at full load (kg). */
  static fullStoresKg(): number {
    return WEAPONS.gun.rounds * WEAPONS.gun.massKg + WEAPONS.rockets.count * WEAPONS.rockets.massKg + WEAPONS.missile.count * WEAPONS.missile.massKg;
  }

  /** Rearm (a respawn on the pad). */
  rearm(): void {
    this.rounds = WEAPONS.gun.rounds;
    this.rockets = WEAPONS.rockets.count;
    this.missiles = WEAPONS.missile.count;
    this.heat = 0;
    this.overheated = false;
    this.rippleLeft = 0;
    this.podIndex = this.railIndex = 0;
  }

  cycleWeapon(): void {
    this.selected = WEAPON_ORDER[(WEAPON_ORDER.indexOf(this.selected) + 1) % WEAPON_ORDER.length] ?? 'gun';
    if (this.selected !== 'missile') this.lock = null;
  }

  cycleRipple(): void {
    const r = WEAPONS.rockets.ripples;
    this.ripple = r[(r.indexOf(this.ripple as (typeof r)[number]) + 1) % r.length] ?? 1;
  }

  /** Missiles fired so far (rail order), for hiding them on the model. */
  get missilesFired(): number {
    return WEAPONS.missile.count - this.missiles;
  }

  /** Body-axes unit vector of the gun barrel. */
  gunDirBody(out: Vec3): Vec3 {
    const ce = Math.cos(this.gunElRad);
    return out.set(Math.sin(this.gunAzRad) * ce, Math.sin(this.gunElRad), -Math.cos(this.gunAzRad) * ce);
  }

  /** Muzzle position in world space. */
  muzzle(h: Helicopter, out: Vec3): Vec3 {
    const [x, y, z] = this.hardpoints.gun;
    const d = this.gunDirBody(scratch.d);
    return h.orientation.rotate(out.set(x + d.x * 2.4, y + d.y * 2.4, z + d.z * 2.4)).add(h.position);
  }

  /**
   * One fixed step. `trigger` is held; `eye` and `look` are the crew's sight line (world), `aim` the point
   * it rests on (where the gun should put its rounds).
   */
  step(dtS: number, h: Helicopter, trigger: boolean, eye: Vec3, look: Vec3, aim: Vec3, force: GroundForce, groundAt: (x: number, z: number) => number): void {
    const ev = this.events;
    ev.rounds = 0;
    ev.launches.length = 0;
    ev.blasts.length = 0;
    ev.kills.length = 0;
    const pressed = trigger && !this.wasTrigger;
    this.wasTrigger = trigger;
    const alive = !h.crashed;

    this.slewGun(dtS, h, aim);
    this.heat = Math.max(0, this.heat - WEAPONS.gun.coolPerS * dtS);
    if (this.overheated && this.heat < WEAPONS.gun.resumeHeat) this.overheated = false;

    // ---- the gun
    this.gunClockS += dtS;
    if (alive && trigger && this.selected === 'gun' && !this.overheated && this.rounds > 0) {
      const period = 1 / WEAPONS.gun.roundsPerS;
      while (this.gunClockS >= period && this.rounds > 0 && !this.overheated) {
        this.gunClockS -= period;
        this.fireRound(h);
        ev.rounds++;
      }
    } else this.gunClockS = Math.min(this.gunClockS, 1 / WEAPONS.gun.roundsPerS);

    // ---- rockets: a press starts a ripple; the ripple runs out on its own
    if (alive && pressed && this.selected === 'rockets' && this.rippleLeft === 0 && this.rockets > 0) {
      this.rippleLeft = Math.min(this.ripple, this.rockets);
      this.rippleClockS = WEAPONS.rockets.rippleIntervalS;
    }
    if (this.rippleLeft > 0) {
      this.rippleClockS += dtS;
      while (this.rippleLeft > 0 && this.rippleClockS >= WEAPONS.rockets.rippleIntervalS) {
        this.rippleClockS -= WEAPONS.rockets.rippleIntervalS;
        if (!alive || this.rockets <= 0) {
          this.rippleLeft = 0;
          break;
        }
        ev.launches.push(this.fireRocket(h).position.clone());
        this.rippleLeft--;
      }
    }

    // ---- laser: range the sight's spot and mark the vehicle within a few metres of it
    this.designated = null;
    this.laserRangeM = 0;
    if (this.laser && alive) {
      const range = eye.distanceTo(aim);
      if (range < WEAPONS.missile.lockRangeM * 1.2) {
        this.laserRangeM = range;
        let best: number = WEAPONS.laserMarkM;
        for (const t of force.targets) {
          if (!t.alive) continue;
          const d = GroundForce.centre(t, scratch.c).distanceTo(aim);
          if (d < best) {
            best = d;
            this.designated = t;
          }
        }
      }
    }

    // ---- missile: lock (the designated vehicle first), then a press launches at the locked target
    if (this.selected === 'missile' && alive) {
      const marked = this.designated && this.designated.position.distanceTo(eye) > 150 ? this.designated : null;
      this.lock = marked ?? this.findLock(eye, look, force, groundAt, this.lock);
      if (pressed && this.lock && this.missiles > 0) ev.launches.push(this.fireMissile(h, this.lock).position.clone());
    } else this.lock = null;

    // ---- fly everything
    for (const s of this.shots) if (s.alive) this.fly(s, dtS, force, groundAt);
    for (let i = this.shots.length - 1; i >= 0; i--) if (!this.shots[i]?.alive) this.shots.splice(i, 1);
    for (const b of this.blasts) b.ageS += dtS;
    while (this.blasts.length > 0 && (this.blasts[0]?.ageS ?? 0) > BLAST_LIFE_S) this.blasts.shift();
  }

  /** Turn the turret towards the aim point, allowing for the drop over the time of flight. */
  private slewGun(dtS: number, h: Helicopter, aim: Vec3): void {
    const gw = WEAPONS.gun;
    const [px, py, pz] = this.hardpoints.gun;
    const pivot = h.orientation.rotate(scratch.a.set(px, py, pz)).add(h.position);
    const to = scratch.b.subVectors(aim, pivot);
    const range = to.length();
    // Super-elevation: the drop over the flight, the flight a little longer than drag-free.
    const tof = (range / gw.muzzleMs) * (1 + range * gw.dragPerM * 0.5);
    to.y += 0.5 * G * tof * tof;
    const d = h.orientation.unrotate(to.normalize());
    const az = clamp(Math.atan2(d.x, -d.z), -gw.azimuthRad, gw.azimuthRad);
    const el = clamp(Math.asin(clamp(d.y, -1, 1)), -gw.elevationDownRad, gw.elevationUpRad);
    const step = gw.slewRadS * dtS;
    this.gunAzRad += clamp(az - this.gunAzRad, -step, step);
    this.gunElRad += clamp(el - this.gunElRad, -step, step);
  }

  private spread(dir: Vec3, halfRad: number): Vec3 {
    // A uniform-ish cone: two perpendicular kicks.
    const u = Math.abs(dir.y) < 0.9 ? scratch.c.set(0, 1, 0) : scratch.c.set(1, 0, 0);
    const a = scratch.a.cross(dir, u).normalize();
    const b = scratch.d.cross(dir, a).normalize();
    const r = halfRad * Math.sqrt(this.random());
    const t = this.random() * Math.PI * 2;
    return dir
      .addScaled(a, r * Math.cos(t))
      .addScaled(b, r * Math.sin(t))
      .normalize();
  }

  private fireRound(h: Helicopter): void {
    const gw = WEAPONS.gun;
    const pos = this.muzzle(h, new Vec3());
    const dir = this.spread(h.orientation.rotate(this.gunDirBody(new Vec3())), gw.dispersionRad);
    const vel = h.velocity.clone().addScaled(dir, gw.muzzleMs);
    this.shots.push({ kind: 'round', position: pos, velocity: vel, ageS: 0, tracer: this.roundCount++ % 3 === 0, target: null, burning: false, alive: true });
    this.rounds--;
    this.heat += gw.heatPerRound;
    if (this.heat >= 1) this.overheated = true;
  }

  private fireRocket(h: Helicopter): Shot {
    const rw = WEAPONS.rockets;
    const pods = this.hardpoints.pods;
    const p = pods[this.podIndex++ % pods.length] ?? [0, 0, 0];
    const pos = h.orientation.rotate(new Vec3(p[0], p[1], p[2])).add(h.position);
    const dir = this.spread(h.orientation.rotate(new Vec3(0, -Math.sin(rw.podDownRad), -Math.cos(rw.podDownRad))), rw.dispersionRad);
    const s: Shot = { kind: 'rocket', position: pos, velocity: rocketLaunchVelocity(h, dir, new Vec3()), ageS: 0, tracer: false, target: null, burning: true, alive: true };
    this.shots.push(s);
    this.rockets--;
    return s;
  }

  private fireMissile(h: Helicopter, target: GroundTarget): Shot {
    const mw = WEAPONS.missile;
    const rails = this.hardpoints.rails;
    const p = rails[this.railIndex++ % rails.length] ?? [0, 0, 0];
    const pos = h.orientation.rotate(new Vec3(p[0], p[1], p[2])).add(h.position);
    const dir = h.orientation.rotate(new Vec3(0, 0.05, -1).normalize());
    const s: Shot = { kind: 'missile', position: pos, velocity: h.velocity.clone().addScaled(dir, mw.launchMs), ageS: 0, tracer: false, target, burning: true, alive: true };
    this.shots.push(s);
    this.missiles--;
    return s;
  }

  /** The target nearest the line of sight inside the lock cone, in range and in clear view; or null. */
  private findLock(eye: Vec3, look: Vec3, force: GroundForce, groundAt: (x: number, z: number) => number, current: GroundTarget | null): GroundTarget | null {
    const mw = WEAPONS.missile;
    let best: GroundTarget | null = null;
    let bestAngle: number = mw.lockConeRad;
    // A held lock survives a little more wander than it takes to acquire one.
    if (current?.alive) {
      const a = this.angleTo(eye, look, current);
      if (a !== null && a < mw.lockConeRad * 2.5 && clearLine(eye, GroundForce.centre(current, scratch.c), groundAt)) return current;
    }
    for (const t of force.targets) {
      if (!t.alive) continue;
      const a = this.angleTo(eye, look, t);
      if (a === null || a >= bestAngle) continue;
      if (!clearLine(eye, GroundForce.centre(t, scratch.c), groundAt)) continue;
      best = t;
      bestAngle = a;
    }
    return best;
  }

  private angleTo(eye: Vec3, look: Vec3, t: GroundTarget): number | null {
    const to = GroundForce.centre(t, scratch.b).sub(eye);
    const d = to.length();
    if (d > WEAPONS.missile.lockRangeM || d < 150) return null;
    return Math.acos(clamp(to.dot(look) / (d * (look.length() || 1)), -1, 1));
  }

  private fly(s: Shot, dtS: number, force: GroundForce, groundAt: (x: number, z: number) => number): void {
    const prev = scratch.a.copy(s.position);
    s.ageS += dtS;
    const v = s.velocity;
    const speed = v.length();
    if (s.kind === 'round') {
      const k = WEAPONS.gun.dragPerM * speed;
      v.x -= v.x * k * dtS;
      v.y -= (v.y * k + G) * dtS;
      v.z -= v.z * k * dtS;
      if (s.ageS > 7) s.alive = false;
    } else if (s.kind === 'rocket') {
      const rw = WEAPONS.rockets;
      s.burning = s.ageS < rw.burnS;
      const thrust = s.burning ? rw.thrustMs2 / Math.max(speed, 1) : 0;
      const k = rw.dragPerM * speed;
      v.x += v.x * (thrust - k) * dtS;
      v.y += (v.y * (thrust - k) - G) * dtS;
      v.z += v.z * (thrust - k) * dtS;
      if (s.ageS > 14) s.alive = false;
    } else this.guide(s, dtS, speed);
    s.position.addScaled(v, dtS);

    // ---- what it hit on the way: a target's hull, else the ground
    let hit: GroundTarget | null = null;
    let hitT = 2;
    for (const t of force.targets) {
      if (!t.alive) continue;
      const c = GroundForce.centre(t, scratch.b);
      const r = s.kind === 'missile' ? WEAPONS.missile.fuseM : 0;
      const u = segmentHit(prev, s.position, c, r + targetRadius(t));
      if (u !== null && u < hitT) {
        hit = t;
        hitT = u;
      }
    }
    const g1 = groundAt(s.position.x, s.position.z);
    let groundT = 2;
    if (s.position.y <= g1) {
      const g0 = groundAt(prev.x, prev.z);
      const above0 = prev.y - g0;
      const above1 = s.position.y - g1;
      groundT = above0 <= 0 ? 0 : above0 / (above0 - above1);
    }
    if (hit === null && groundT > 1) return;
    const u = Math.min(hitT, groundT);
    const at = scratch.c.copy(prev).lerp(s.position, clamp(u, 0, 1));
    this.detonate(s, at, hit && hitT <= groundT ? hit : null, force, groundAt);
  }

  /** Missile guidance: loft over the target, then pursue it with lead, within the turn limit. */
  private guide(s: Shot, dtS: number, speed: number): void {
    const mw = WEAPONS.missile;
    const v = s.velocity;
    s.burning = s.ageS < mw.burnS;
    const t = s.target;
    if (s.ageS > 0.35 && t) {
      const goal = GroundForce.centre(t, scratch.b);
      const dx = goal.x - s.position.x;
      const dz = goal.z - s.position.z;
      const flat = Math.hypot(dx, dz);
      const tgo = Math.hypot(flat, goal.y - s.position.y) / Math.max(speed, 50);
      goal.addScaled(t.velocity, tgo);
      // Top attack: fly at a point high over the target, then pitch over where a turn of radius v²/a
      // followed by a straight dive at `diveRad` would end on the target — so it comes down onto the thin
      // roof rather than flat into the front or past it.
      const above = s.position.y - goal.y;
      const turnRadius = (speed * speed) / mw.maxAccelMs2;
      const th = mw.diveRad;
      const pitchOver = turnRadius * Math.sin(th) + Math.max(0, above - turnRadius * (1 - Math.cos(th))) / Math.tan(th);
      if (flat > pitchOver) goal.y += Math.min(mw.loftMaxM, 60 + flat * mw.loftPerM);
      const want = goal.sub(s.position).normalize();
      const have = scratch.d.copy(v).normalize();
      // Turn the velocity towards `want` by at most a·dt / v.
      const cos = clamp(have.dot(want), -1, 1);
      const angle = Math.acos(cos);
      const maxTurn = (mw.maxAccelMs2 / Math.max(speed, 30)) * dtS;
      if (angle > 1e-5) {
        const f = Math.min(1, maxTurn / angle);
        have.lerp(want, f).normalize();
      }
      v.copy(have).scale(speed);
    } else if (s.ageS <= 0.35) v.y -= G * dtS * 0.5;
    const thrust = s.burning ? mw.thrustMs2 : 0;
    const k = mw.dragPerM * speed * speed;
    const nv = Math.max(0, speed + (thrust - k) * dtS);
    if (speed > 1) v.scale(nv / speed);
    if (s.ageS > 30) s.alive = false;
  }

  private detonate(s: Shot, at: Vec3, direct: GroundTarget | null, force: GroundForce, groundAt: (x: number, z: number) => number): void {
    s.alive = false;
    const travel = s.velocity;
    const spec =
      s.kind === 'round'
        ? { direct: WEAPONS.gun.directDamage, splash: WEAPONS.gun.splashM, splashDamage: WEAPONS.gun.directDamage * 0.5 }
        : s.kind === 'rocket'
          ? { direct: WEAPONS.rockets.directDamage, splash: WEAPONS.rockets.splashM, splashDamage: WEAPONS.rockets.splashDamage }
          : { direct: WEAPONS.missile.damage, splash: WEAPONS.missile.splashM, splashDamage: WEAPONS.missile.damage * 0.5 };
    const kills = this.events.kills;
    if (direct && force.damage(direct, spec.direct, travel)) kills.push(direct);
    for (const t of force.targets) {
      if (!t.alive || t === direct) continue;
      const d = GroundForce.centre(t, scratch.b).distanceTo(at) - targetRadius(t);
      if (d >= spec.splash) continue;
      // Splash comes from the burst point: armour by the direction from there.
      const from = scratch.d.subVectors(GroundForce.centre(t, scratch.b), at);
      if (force.damage(t, spec.splashDamage * (1 - Math.max(0, d) / spec.splash), from, true)) kills.push(t);
    }
    const onGround = at.y - groundAt(at.x, at.z) < 1;
    const b: Blast = { position: at.clone(), kind: s.kind === 'round' && !direct && onGround ? 'dust' : 'blast', size: s.kind === 'round' ? 1.2 : s.kind === 'rocket' ? 4 : 6, ageS: 0 };
    this.blasts.push(b);
    this.events.blasts.push(b);
    for (const k of kills) {
      const kb: Blast = { position: GroundForce.centre(k, new Vec3()), kind: 'kill', size: k.kind === 'tank' ? 9 : 7, ageS: 0 };
      this.blasts.push(kb);
      this.events.blasts.push(kb);
    }
  }

  /**
   * Where rockets fired now would land, by flying one undispersed rocket ahead (the HUD's ballistic cue);
   * null if they would not come down within 6 km.
   */
  rocketImpact(h: Helicopter, groundAt: (x: number, z: number) => number, out: Vec3): Vec3 | null {
    const rw = WEAPONS.rockets;
    // From between the pods, with the same integration as a real rocket's (fixed step, age counted
    // before the burn test), so the cue and the rockets agree.
    const pods = this.hardpoints.pods;
    const mid = scratch.c.set(0, 0, 0);
    for (const p of pods) ((mid.x += p[0] / pods.length), (mid.y += p[1] / pods.length), (mid.z += p[2] / pods.length));
    const pos = h.orientation.rotate(out.copy(mid)).add(h.position);
    const dir = h.orientation.rotate(scratch.a.set(0, -Math.sin(rw.podDownRad), -Math.cos(rw.podDownRad)));
    const vel = rocketLaunchVelocity(h, dir, scratch.b);
    const dt = PHYSICS.stepSeconds;
    for (let t = dt; t < 14; t += dt) {
      const speed = vel.length();
      const thrust = t < rw.burnS ? rw.thrustMs2 / Math.max(speed, 1) : 0;
      const k = rw.dragPerM * speed;
      vel.x += vel.x * (thrust - k) * dt;
      vel.y += (vel.y * (thrust - k) - G) * dt;
      vel.z += vel.z * (thrust - k) * dt;
      pos.addScaled(vel, dt);
      if (pos.y <= groundAt(pos.x, pos.z)) return pos;
      if (pos.distanceTo(h.position) > 6000) return null;
    }
    return null;
  }
}

/**
 * A rocket leaves along the pod's line: the aircraft's speed along that line plus the launch speed. Its fins
 * turn it into the airflow straight away, so a sideways drift does not carry it off the shaft line — the
 * rockets go where the nose points, which is how they are aimed.
 */
function rocketLaunchVelocity(h: Helicopter, dir: Vec3, out: Vec3): Vec3 {
  const along = Math.max(0, h.velocity.dot(dir));
  return out.copy(dir).scale(along + WEAPONS.rockets.launchMs);
}

function targetRadius(t: GroundTarget): number {
  return t.kind === 'truck' ? 2.4 : 2.7;
}

/** Where along the segment a→b (0…1) it first comes within `r` of `c`, or null. */
export function segmentHit(a: Vec3, b: Vec3, c: Vec3, r: number): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const fz = a.z - c.z;
  const A = dx * dx + dy * dy + dz * dz;
  const B = 2 * (fx * dx + fy * dy + fz * dz);
  const C = fx * fx + fy * fy + fz * fz - r * r;
  if (C <= 0) return 0;
  if (A < 1e-9) return null;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const u = (-B - Math.sqrt(disc)) / (2 * A);
  return u >= 0 && u <= 1 ? u : null;
}

/** True if the straight line from a to b stays above the ground (sampled every ~40 m). */
export function clearLine(a: Vec3, b: Vec3, groundAt: (x: number, z: number) => number): boolean {
  const d = a.distanceTo(b);
  const n = Math.max(4, Math.ceil(d / 40));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    if (y < groundAt(x, z) + 0.5) return false;
  }
  return true;
}
