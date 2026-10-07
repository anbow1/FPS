import { Vec3 } from '../core/vec.ts';
import type { Quat } from '../core/quat.ts';

// Fire-control radar as a game abstraction (brief: "invented curves that feel
// right", no real radar engineering). What it models, and why each matters:
//
//   sweep     a beam sweeps the azimuth limits at a fixed rate; a contact is
//             only seen when the beam passes it, so the picture refreshes in
//             frames, not continuously;
//   range     detection range scales with the target's signature by a square
//             root: the stealth type's nose (0.12) is seen at ~35 % of the
//             range of a conventional fighter's, its side as anyone's;
//   notch     a target crossing the line of sight (closing speed near zero)
//             against the ground clutter (the radar looking down) falls out of
//             the doppler filter — the best emergent tactic in the game;
//   masking   terrain between the antenna and the target hides it;
//   modes     search (wide sweep), track-while-scan (narrow sweep round the
//             designated contact, faster refresh), single-target track (the
//             beam stays on one target: it knows it is being tracked).
// Lock takes time and breaks on a hard turn out of the gimbal limits, on
// masking, or on a notch held for a moment.

export type RadarMode = 'search' | 'tws' | 'stt';

export interface RadarSpec {
  /** Detection range against signature 1 (m). */
  rangeM: number;
  /** Gimbal limits (rad) and the scan half-width in search (rad). */
  gimbalRad: number;
  searchHalfAzRad: number;
  twsHalfAzRad: number;
  /** Elevation coverage either side of the antenna's elevation (rad). */
  halfElRad: number;
  /** Beam sweep rate (rad/s) and half beam width (rad). */
  sweepRadS: number;
  beamHalfRad: number;
  /** Seconds from designation to a firm lock. */
  lockS: number;
}

export const RADAR: Record<'wraith' | 'talon', RadarSpec> = {
  wraith: { rangeM: 85_000, gimbalRad: rad(60), searchHalfAzRad: rad(60), twsHalfAzRad: rad(25), halfElRad: rad(8), sweepRadS: rad(100), beamHalfRad: rad(2.5), lockS: 1.2 },
  talon: { rangeM: 95_000, gimbalRad: rad(60), searchHalfAzRad: rad(60), twsHalfAzRad: rad(25), halfElRad: rad(8), sweepRadS: rad(90), beamHalfRad: rad(2.5), lockS: 1.5 },
};

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** What the radar knows about a body it might see. */
export interface RadarBody {
  id: number;
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  signatureFront: number;
  signatureSide: number;
  alive: boolean;
}

export interface Contact {
  id: number;
  rangeM: number;
  /** Bearing and elevation relative to the radar's own nose (rad). */
  azRad: number;
  elRad: number;
  /** Closing speed (m/s, positive = closing). */
  closureMs: number;
  /** World position at the last detection. */
  position: Vec3;
  lastSeenS: number;
}

/** Signature towards a viewer: the front value within the nose cone, the side value abeam and aft. */
export function aspectSignature(target: RadarBody, toViewer: Vec3): number {
  const fwd = target.orientation.rotate(new Vec3(0, 0, -1));
  const c = Math.max(0, fwd.dot(toViewer));
  // Narrow frontal reduction: only within ~40° of the nose does the stealth shaping pay off fully.
  const w = Math.pow(c, 3);
  return target.signatureSide + (target.signatureFront - target.signatureSide) * w;
}

/** Detection range against a target with signature `sig` (m). */
export function detectionRangeM(spec: RadarSpec, sig: number): number {
  return spec.rangeM * Math.sqrt(Math.max(sig, 1e-4));
}

/** True when the target sits in the doppler notch: crossing the line of sight against ground clutter. */
export function inNotch(radarPos: Vec3, target: RadarBody): boolean {
  const los = new Vec3().subVectors(target.position, radarPos);
  const range = los.length();
  if (range < 1) return false;
  los.scale(1 / range);
  const radial = Math.abs(target.velocity.dot(los));
  // Looking down: the line of sight below the horizontal by more than a degree puts ground behind the target.
  const lookDown = los.y < -Math.sin(rad(1));
  return lookDown && radial < 25;
}

export type GroundHeight = (x: number, z: number) => number;

/** True when terrain blocks the line between two points (sampled every ~400 m). */
export function terrainMasks(a: Vec3, b: Vec3, groundAt: GroundHeight): boolean {
  const d = a.distanceTo(b);
  const n = Math.max(4, Math.min(160, Math.ceil(d / 400)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    if (y < groundAt(x, z) + 5) return true;
  }
  return false;
}

export class Radar {
  mode: RadarMode = 'search';
  /** Antenna elevation relative to the horizon (rad), set by the player or the AI. */
  antennaElRad = 0;
  /** Current beam azimuth relative to the nose (rad) and its sweep direction. */
  beamAzRad = 0;
  private sweepDir = 1;
  /** Display range scale (m): what the scope shows, not what the radar can see. */
  rangeScaleM = 40_000;
  readonly contacts = new Map<number, Contact>();
  /** Designated contact (TWS) or the locked one (STT). */
  targetId: number | null = null;
  /** 0…1 while acquiring a lock; 1 = locked (STT). */
  lockProgress = 0;
  /** Seconds the locked target has been unseen (notched, masked, outside the gimbal). */
  private lostS = 0;
  /** Bodies painted this step (for their warning receivers): id → 'search' | 'track'. */
  readonly painted = new Map<number, 'search' | 'track'>();
  private readonly tmp = new Vec3();

  constructor(readonly spec: RadarSpec) {}

  get locked(): boolean {
    return this.mode === 'stt' && this.lockProgress >= 1;
  }

  get target(): Contact | null {
    return this.targetId === null ? null : (this.contacts.get(this.targetId) ?? null);
  }

  /** Cycles search → TWS → back (STT is entered by locking). */
  cycleMode(): void {
    if (this.mode === 'search') this.mode = 'tws';
    else this.breakLock('search');
  }

  /** Designates the contact nearest the nose; in TWS starts a lock on it. */
  designate(): void {
    let best: Contact | null = null;
    let bestScore = Infinity;
    for (const c of this.contacts.values()) {
      const score = Math.hypot(c.azRad, c.elRad) + c.rangeM / 200_000;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return;
    this.targetId = best.id;
    this.mode = 'stt';
    this.lockProgress = 0;
    this.lostS = 0;
  }

  breakLock(mode: RadarMode = 'tws'): void {
    this.mode = mode;
    this.lockProgress = 0;
    this.lostS = 0;
    if (mode === 'search') this.targetId = null;
  }

  /** Angles of a world point relative to the radar's nose: azimuth (right +) and elevation (up +). */
  private angles(own: Vec3, ownRot: Quat, p: Vec3): { range: number; az: number; el: number } {
    const v = this.tmp.subVectors(p, own);
    const range = v.length();
    ownRot.unrotate(v);
    // Body axes: forward −z, right +x, up +y.
    const az = Math.atan2(v.x, -v.z);
    const el = Math.atan2(v.y, Math.hypot(v.x, v.z));
    return { range, az, el };
  }

  /**
   * One step: moves the beam, detects what it passes, keeps or breaks the lock. `nowS` is game time.
   */
  step(dtS: number, nowS: number, ownPos: Vec3, ownVel: Vec3, ownRot: Quat, bodies: readonly RadarBody[], groundAt: GroundHeight): void {
    this.painted.clear();
    const spec = this.spec;
    // Antenna elevation in body terms: the commanded elevation relative to the horizon, less the nose's pitch.
    const fwd = ownRot.rotate(new Vec3(0, 0, -1));
    const noseEl = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    const antennaEl = this.antennaElRad - noseEl;
    const sees = (b: RadarBody): { ok: boolean; range: number; az: number; el: number } => {
      const a = this.angles(ownPos, ownRot, b.position);
      if (!b.alive || Math.abs(a.az) > spec.gimbalRad || Math.abs(a.el) > spec.gimbalRad) return { ok: false, ...a };
      const toViewer = new Vec3().subVectors(ownPos, b.position).normalize();
      const sig = aspectSignature(b, toViewer);
      if (a.range > detectionRangeM(spec, sig)) return { ok: false, ...a };
      if (inNotch(ownPos, b) || terrainMasks(ownPos, b.position, groundAt)) return { ok: false, ...a };
      return { ok: true, ...a };
    };
    const record = (b: RadarBody, a: { range: number; az: number; el: number }): void => {
      const los = new Vec3().subVectors(b.position, ownPos).scale(1 / Math.max(a.range, 1));
      const closure = -new Vec3().subVectors(b.velocity, ownVel).dot(los);
      const c = this.contacts.get(b.id);
      if (c) {
        c.rangeM = a.range;
        c.azRad = a.az;
        c.elRad = a.el;
        c.closureMs = closure;
        c.position.copy(b.position);
        c.lastSeenS = nowS;
      } else this.contacts.set(b.id, { id: b.id, rangeM: a.range, azRad: a.az, elRad: a.el, closureMs: closure, position: b.position.clone(), lastSeenS: nowS });
    };
    if (this.mode === 'stt' && this.targetId !== null) {
      // The beam stays on the target: it is painted continuously and knows it.
      const b = bodies.find((x) => x.id === this.targetId);
      const s = b ? sees(b) : null;
      if (b && s?.ok) {
        record(b, s);
        this.painted.set(b.id, 'track');
        this.lostS = 0;
        this.lockProgress = Math.min(1, this.lockProgress + dtS / spec.lockS);
        this.beamAzRad = s.az;
      } else {
        this.lostS += dtS;
        // A lock survives a moment's loss (a notch flicker); acquisition does not.
        if (this.lockProgress < 1 || this.lostS > 1.5) this.breakLock('tws');
      }
    } else {
      // Sweep between the limits; TWS narrows round the designated contact.
      let centre = 0;
      let half = spec.searchHalfAzRad;
      const t = this.target;
      if (this.mode === 'tws' && t) {
        centre = Math.max(-spec.gimbalRad + spec.twsHalfAzRad, Math.min(spec.gimbalRad - spec.twsHalfAzRad, t.azRad));
        half = spec.twsHalfAzRad;
      }
      const prev = this.beamAzRad;
      let next = prev + this.sweepDir * spec.sweepRadS * dtS;
      if (next > centre + half) {
        next = centre + half;
        this.sweepDir = -1;
      } else if (next < centre - half) {
        next = centre - half;
        this.sweepDir = 1;
      }
      this.beamAzRad = next;
      const lo = Math.min(prev, next) - spec.beamHalfRad;
      const hi = Math.max(prev, next) + spec.beamHalfRad;
      for (const b of bodies) {
        const s = sees(b);
        if (s.az < lo || s.az > hi) continue;
        if (Math.abs(s.el - antennaEl) > spec.halfElRad) continue;
        this.painted.set(b.id, 'search');
        if (s.ok) record(b, s);
      }
    }
    // Forget contacts not refreshed for two full frames.
    const frameS = (2 * spec.searchHalfAzRad) / spec.sweepRadS;
    for (const [id, c] of this.contacts) {
      if (id === this.targetId && this.mode === 'stt') continue;
      if (nowS - c.lastSeenS > frameS * 2.2) {
        this.contacts.delete(id);
        if (id === this.targetId) this.targetId = null;
      }
    }
  }
}

export type ThreatLevel = 'search' | 'track' | 'launch';

export interface Threat {
  id: number;
  /** Bearing relative to the own nose (rad, right +). */
  bearingRad: number;
  level: ThreatLevel;
  lastS: number;
}

/**
 * Radar warning receiver: who is painting us, from which bearing, and how hard. Search paints are
 * remembered for a few seconds (they come once a sweep), tracks and launches only while they last.
 */
export class WarningReceiver {
  readonly threats = new Map<number, Threat>();

  /** A paint from emitter `id` at world position `from`. */
  paint(id: number, level: ThreatLevel, from: Vec3, ownPos: Vec3, ownRot: Quat, nowS: number): void {
    const v = new Vec3().subVectors(from, ownPos);
    ownRot.unrotate(v);
    const bearing = Math.atan2(v.x, -v.z);
    const old = this.threats.get(id);
    // A launch outranks a track outranks a search within the same moment.
    const rank = { search: 0, track: 1, launch: 2 } as const;
    if (old && nowS - old.lastS < 0.2 && rank[old.level] > rank[level]) level = old.level;
    this.threats.set(id, { id, bearingRad: bearing, level, lastS: nowS });
  }

  step(nowS: number): void {
    for (const [id, t] of this.threats) {
      const hold = t.level === 'search' ? 4 : 0.6;
      if (nowS - t.lastS > hold) this.threats.delete(id);
    }
  }

  /** The most serious level present, for the warning tone. */
  get worst(): ThreatLevel | null {
    let w: ThreatLevel | null = null;
    for (const t of this.threats.values()) {
      if (t.level === 'launch') return 'launch';
      if (t.level === 'track') w = 'track';
      else if (!w) w = 'search';
    }
    return w;
  }
}
