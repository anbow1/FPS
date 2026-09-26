import { PHYSICS, type RoundSpec } from '../config.ts';
import { Vec3 } from '../core/vec.ts';

// G7 point-mass model — the same one that draws references/ballistics-reference.png
// (see _generate_references.py). The game and the tests share this integrator,
// so the holdover the tests check is the holdover the player gets.

// Standard G7 drag function, Mach → Cd (public table, copied from the generator).
const G7_MACH = [
  0.0, 0.5, 0.7, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975, 1.0, 1.025, 1.05, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4,
  2.6, 2.8, 3.0, 3.5, 4.0, 5.0,
];
const G7_CD = [
  0.1198, 0.1194, 0.1202, 0.1242, 0.1306, 0.1464, 0.166, 0.2054, 0.2993, 0.3803, 0.4015, 0.4043, 0.4014, 0.3884, 0.3732,
  0.358, 0.344, 0.3315, 0.3117, 0.298, 0.2864, 0.2752, 0.2643, 0.2533, 0.2424, 0.217, 0.195, 0.1618,
];
const LB_PER_IN2_TO_KG_PER_M2 = 703.07;

/** Sub-steps per 60 Hz physics step. 4 → 240 Hz, within 1 % of the sheet's 5 kHz reference. */
export const BALLISTIC_SUBSTEPS = 4;

export function g7DragCoefficient(mach: number): number {
  if (mach <= 0) return G7_CD[0] as number;
  const last = G7_MACH.length - 1;
  if (mach >= (G7_MACH[last] as number)) return G7_CD[last] as number;
  let i = 1;
  while ((G7_MACH[i] as number) < mach) i++;
  const m0 = G7_MACH[i - 1] as number;
  const m1 = G7_MACH[i] as number;
  const t = (mach - m0) / (m1 - m0);
  return (G7_CD[i - 1] as number) + ((G7_CD[i] as number) - (G7_CD[i - 1] as number)) * t;
}

/** Deceleration magnitude from drag, m/s², at air-relative speed `speedMs`. */
export function dragDecelerationMs2(speedMs: number, round: RoundSpec): number {
  const cd = g7DragCoefficient(speedMs / PHYSICS.speedOfSoundMs);
  const bcSi = round.g7BallisticCoefficient * LB_PER_IN2_TO_KG_PER_M2;
  return (PHYSICS.airDensityKgM3 * speedMs * speedMs * cd * Math.PI) / (8 * bcSi);
}

const _relVel = new Vec3();
const _midVel = new Vec3();

/**
 * Advances one bullet by `dtSeconds` with midpoint (RK2) integration.
 * Drag acts on the velocity relative to the air, so wind drifts the round.
 */
export function integrateBullet(position: Vec3, velocity: Vec3, windMs: Vec3, round: RoundSpec, dtSeconds: number): void {
  // Half step for the midpoint velocity.
  accelerationAt(velocity, windMs, round, _relVel);
  _midVel.copy(velocity).addScaled(_relVel, dtSeconds * 0.5);
  accelerationAt(_midVel, windMs, round, _relVel);
  position.addScaled(_midVel, dtSeconds);
  velocity.addScaled(_relVel, dtSeconds);
}

function accelerationAt(velocity: Vec3, windMs: Vec3, round: RoundSpec, out: Vec3): Vec3 {
  out.subVectors(velocity, windMs);
  const speed = out.length();
  if (speed < 1e-6) return out.set(0, -PHYSICS.gravityMs2, 0);
  const decel = dragDecelerationMs2(speed, round);
  out.scale(-decel / speed);
  out.y -= PHYSICS.gravityMs2;
  return out;
}

export interface TrajectorySample {
  rangeM: number;
  heightM: number; // relative to the bore line origin
  timeSeconds: number;
  speedMs: number;
}

/** Flies a round in the vertical plane with the game's integrator and step. */
export function flyFlat(round: RoundSpec, elevationRad: number, maxRangeM: number): TrajectorySample[] {
  const dt = PHYSICS.stepSeconds / BALLISTIC_SUBSTEPS;
  const pos = new Vec3(0, 0, 0);
  const vel = new Vec3(round.muzzleVelocityMs * Math.cos(elevationRad), round.muzzleVelocityMs * Math.sin(elevationRad), 0);
  const noWind = new Vec3();
  const samples: TrajectorySample[] = [{ rangeM: 0, heightM: 0, timeSeconds: 0, speedMs: round.muzzleVelocityMs }];
  let t = 0;
  while (pos.x < maxRangeM && t < 12) {
    integrateBullet(pos, vel, noWind, round, dt);
    t += dt;
    samples.push({ rangeM: pos.x, heightM: pos.y, timeSeconds: t, speedMs: vel.length() });
  }
  return samples;
}

function interpolate(samples: TrajectorySample[], rangeM: number, key: 'heightM' | 'timeSeconds' | 'speedMs'): number {
  if (samples.length < 2) throw new Error('trajectory needs at least two samples');
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i] as TrajectorySample;
    if (b.rangeM >= rangeM) {
      const a = samples[i - 1] as TrajectorySample;
      const t = (rangeM - a.rangeM) / (b.rangeM - a.rangeM);
      return a[key] + (b[key] - a[key]) * t;
    }
  }
  throw new Error(`range ${rangeM} m is past the end of the trajectory (${samples[samples.length - 1]?.rangeM ?? 0} m)`);
}

const zeroCache = new Map<RoundSpec, number>();

/** Bore elevation (rad) that puts the round on the line of sight at the zero range. */
export function zeroElevationRad(round: RoundSpec): number {
  const cached = zeroCache.get(round);
  if (cached !== undefined) return cached;
  let lo = 0;
  let hi = 0.03;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    const s = flyFlat(round, mid, round.zeroRangeM + 1);
    if (interpolate(s, round.zeroRangeM, 'heightM') < round.sightHeightM) lo = mid;
    else hi = mid;
  }
  const result = 0.5 * (lo + hi);
  zeroCache.set(round, result);
  return result;
}

export interface RangeSolution {
  holdoverMil: number; // + = hold high
  timeOfFlightSeconds: number;
  speedMs: number;
  dropBelowSightM: number;
}

/** Holdover, time and speed at `rangeM` for a rifle zeroed per its spec. */
export function solveRange(round: RoundSpec, rangeM: number): RangeSolution {
  if (rangeM <= 0) throw new Error(`range must be positive, got ${rangeM} m`);
  const samples = flyFlat(round, zeroElevationRad(round), rangeM + 2);
  const heightVsSight = interpolate(samples, rangeM, 'heightM') - round.sightHeightM;
  return {
    holdoverMil: (-heightVsSight / rangeM) * 1000 + 0,
    timeOfFlightSeconds: interpolate(samples, rangeM, 'timeSeconds'),
    speedMs: interpolate(samples, rangeM, 'speedMs'),
    dropBelowSightM: -heightVsSight,
  };
}

/** Kinetic energy retained, as a fraction of muzzle energy. Scales damage. */
export function energyFraction(round: RoundSpec, speedMs: number): number {
  const ratio = speedMs / round.muzzleVelocityMs;
  return ratio * ratio;
}

export function muzzleEnergyJ(round: RoundSpec): number {
  return 0.5 * round.bulletMassKg * round.muzzleVelocityMs * round.muzzleVelocityMs;
}
