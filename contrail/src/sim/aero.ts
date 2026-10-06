import type { AeroConfig } from '../config.ts';

// Lift and drag coefficients against angle of attack and Mach.
//
// Lift: Polhamus' leading-edge suction analogy (NASA TN D-3767, 1966), the
// standard first model for slender, strake-equipped wings:
//   CL = Kp·sinα·cos²α + Kv·cosα·sin²α
// The potential term Kp is the wing's lift slope (DATCOM / Helmbold, with the
// compressibility correction below); the vortex term Kv keeps lift rising to
// high AoA. Past the stall AoA the vortices burst: lift blends over a few
// degrees into a separated flat-plate value, 1.15·sin 2α (Hoerner), so there
// is a break and a post-stall regime instead of a cliff.
//
// Drag: zero-lift drag with a transonic rise (peak just above Mach 1, easing
// supersonic), plus induced drag k·CL² whose factor grows supersonic, and in
// separated flow the normal-force drag 1.8·sin²α.

export interface AeroCoefficients {
  lift: number;
  drag: number;
  /** 0 = attached flow, 1 = fully separated (stall). */
  separation: number;
}

export function aspectRatio(aero: AeroConfig): number {
  return (aero.spanM * aero.spanM) / aero.wingAreaM2;
}

/** Lift-curve slope per radian at Mach number M. */
export function liftSlope(aero: AeroConfig, mach: number): number {
  const A = aspectRatio(aero);
  const subsonic = (m: number): number => (2 * Math.PI * A) / (2 + Math.sqrt(4 + A * A * (1 - m * m)));
  // Supersonic thin-wing value 4/√(M²−1), never above the sonic plateau πA/2.
  const supersonic = (m: number): number => Math.min((Math.PI * A) / 2, 4 / Math.sqrt(m * m - 1));
  if (mach <= 0.95) return subsonic(Math.max(mach, 0));
  if (mach >= 1.05) return supersonic(mach);
  const t = (mach - 0.95) / 0.1;
  return subsonic(0.95) * (1 - t) + supersonic(1.05) * t;
}

export function zeroLiftDrag(aero: AeroConfig, mach: number): number {
  const rise = smooth(0.85, 1.08, mach);
  const ease = 1 - 0.3 * smooth(1.2, 2.2, mach);
  return aero.cd0Subsonic + aero.cd0WaveRise * rise * ease;
}

export function inducedFactor(aero: AeroConfig, mach: number): number {
  const k0 = 1 / (Math.PI * aero.oswald * aspectRatio(aero));
  return k0 * (1 + 1.2 * smooth(0.9, 1.6, mach));
}

/** CL, CD and the separation fraction at angle of attack `alphaRad` (sign kept) and Mach `mach`. */
export function aeroCoefficients(aero: AeroConfig, alphaRad: number, mach: number, out: AeroCoefficients = { lift: 0, drag: 0, separation: 0 }): AeroCoefficients {
  const a = Math.abs(alphaRad);
  const s = Math.sin(a);
  const c = Math.cos(a);
  const attached = liftSlope(aero, mach) * s * c * c + aero.vortexLiftK * c * s * s;
  const separated = 1.15 * Math.sin(2 * a);
  // Negative AoA stalls earlier: the strakes do nothing upside down.
  const stallAt = alphaRad >= 0 ? aero.stallAoaRad : aero.stallAoaRad * 0.6;
  const w = sigmoid((a - stallAt) / aero.stallWidthRad);
  const sign = alphaRad >= 0 ? 1 : -1;
  const cl = (1 - w) * attached + w * separated;
  const cd0 = zeroLiftDrag(aero, mach);
  const attachedDrag = inducedFactor(aero, mach) * attached * attached;
  const separatedDrag = 1.8 * s * s;
  out.lift = sign * cl;
  out.drag = cd0 + (1 - w) * attachedDrag + w * separatedDrag;
  out.separation = w;
  return out;
}

/** Highest CL the wing makes in attached flow at Mach `mach` (found by scanning AoA up to the stall). */
export function maxLiftCoefficient(aero: AeroConfig, mach: number): number {
  let best = 0;
  const tmp: AeroCoefficients = { lift: 0, drag: 0, separation: 0 };
  for (let deg = 0; deg <= 60; deg += 0.5) {
    aeroCoefficients(aero, (deg * Math.PI) / 180, mach, tmp);
    if (tmp.lift > best) best = tmp.lift;
  }
  return best;
}

/** AoA (rad) that gives lift coefficient `cl` in attached flow (bisection on the rising part of the curve). */
export function aoaForLift(aero: AeroConfig, cl: number, mach: number): number {
  const tmp: AeroCoefficients = { lift: 0, drag: 0, separation: 0 };
  let lo = 0;
  let hi = aero.stallAoaRad;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    aeroCoefficients(aero, mid, mach, tmp);
    if (tmp.lift < cl) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
