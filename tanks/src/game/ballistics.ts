import { type AmmoSpec, GRAVITY, SIGHT_ZERO_M } from '../config';
import { hyp2, hyp3 } from '../core/mathx';

/**
 * Point-mass shell model: gravity plus quadratic drag a = -k|v|v.
 * One integrator (midpoint / RK2) is shared by the live projectiles and the fire-control
 * solver, so what the FCS predicts is exactly what the shell does.
 */
export interface ShellState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

export function stepShell(s: ShellState, k: number, dt: number): void {
  const sp = hyp3(s.vx, s.vy, s.vz);
  const ax = -k * sp * s.vx;
  const ay = -k * sp * s.vy - GRAVITY;
  const az = -k * sp * s.vz;
  const mvx = s.vx + ax * dt * 0.5;
  const mvy = s.vy + ay * dt * 0.5;
  const mvz = s.vz + az * dt * 0.5;
  const msp = hyp3(mvx, mvy, mvz);
  const bx = -k * msp * mvx;
  const by = -k * msp * mvy - GRAVITY;
  const bz = -k * msp * mvz;
  s.x += mvx * dt;
  s.y += mvy * dt;
  s.z += mvz * dt;
  s.vx += bx * dt;
  s.vy += by * dt;
  s.vz += bz * dt;
}

export interface FlightSample {
  /** time of flight (s) */
  t: number;
  /** height relative to the launch point (m) */
  y: number;
  /** speed at that point (m/s) */
  v: number;
}

const tmp: ShellState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const SOLVER_DT = 1 / 240;

/** Flies a shell in the vertical plane launched at `angle` and reports its state at horizontal range `range`. */
export function flyTo(ammo: AmmoSpec, angle: number, range: number, out: FlightSample): FlightSample {
  tmp.x = 0; tmp.y = 0; tmp.z = 0;
  tmp.vx = ammo.v0 * Math.cos(angle);
  tmp.vy = ammo.v0 * Math.sin(angle);
  tmp.vz = 0;
  let t = 0;
  let px = 0;
  let py = 0;
  let pv = ammo.v0;
  while (tmp.x < range && t < 30) {
    px = tmp.x;
    py = tmp.y;
    pv = hyp2(tmp.vx, tmp.vy);
    stepShell(tmp, ammo.k, SOLVER_DT);
    t += SOLVER_DT;
    if (tmp.vx <= 1) break;
  }
  const seg = tmp.x - px;
  const f = seg > 1e-6 ? (range - px) / seg : 1;
  out.t = t - SOLVER_DT * (1 - f);
  out.y = py + (tmp.y - py) * f;
  out.v = pv + (hyp2(tmp.vx, tmp.vy) - pv) * f;
  return out;
}

const sample: FlightSample = { t: 0, y: 0, v: 0 };

/**
 * Launch elevation (rad, from horizontal) that puts the shell through a point `range` metres away
 * horizontally and `dy` metres above the muzzle. Newton iterations on the small-angle form.
 */
export function solveElevation(ammo: AmmoSpec, range: number, dy: number): number {
  const r = Math.max(1, range);
  let angle = Math.atan2(dy, r);
  for (let i = 0; i < 6; i++) {
    flyTo(ammo, angle, r, sample);
    const err = dy - sample.y;
    angle += Math.atan2(err, r) * Math.cos(angle) ** 2;
    if (Math.abs(err) < 0.005) break;
  }
  return angle;
}

export function timeOfFlight(ammo: AmmoSpec, range: number, dy = 0): number {
  const a = solveElevation(ammo, range, dy);
  return flyTo(ammo, a, range, sample).t;
}

/**
 * Holdover in mil (positive = hold high) for a sight zeroed at SIGHT_ZERO_M, as on the reference sheet.
 * `sightHeight` is the sight axis above the bore.
 */
export function holdoverMil(ammo: AmmoSpec, range: number, sightHeight = 0, zero = SIGHT_ZERO_M): number {
  // bore angle relative to the sight line that zeroes the round at `zero`
  const boreAngle = solveElevation(ammo, zero, 0) + Math.atan2(sightHeight, zero);
  flyTo(ammo, boreAngle, range, sample);
  const heightVsLos = sample.y - sightHeight + (sightHeight * range) / zero;
  return (-heightVsLos / range) * 1000;
}

/** Remaining penetration at a given flown distance. */
export function penetrationAt(ammo: AmmoSpec, distance: number): number {
  return Math.max(0, ammo.pen0 - (ammo.penLossPerKm * distance) / 1000);
}

/**
 * Bore direction (world, unit) that lands a round from `from` on `to`, including superelevation.
 * Works for any vector type with x/y/z.
 */
export function aimDirection(
  ammo: AmmoSpec,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  out: { x: number; y: number; z: number },
): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const range = Math.max(1, hyp2(dx, dz));
  const el = solveElevation(ammo, range, to.y - from.y);
  const c = Math.cos(el);
  out.x = (dx / range) * c;
  out.y = Math.sin(el);
  out.z = (dz / range) * c;
  return range;
}
