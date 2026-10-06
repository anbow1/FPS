import { AIRCRAFT, type AircraftId, PHYSICS } from '../config.ts';
import { aeroCoefficients, maxLiftCoefficient } from './aero.ts';
import { atmosphereAt } from './atmosphere.ts';
import { createEngineState, stepEngine } from './engine.ts';

// Energy-manoeuvrability chart (Boyd and Christie's E-M theory): for each
// altitude and true airspeed, the sustained turn rate (thrust = drag at full
// afterburner, level) and the instantaneous turn rate (the lift limit or the G
// limit, whichever comes first). The brief asks for it to tune the two aircraft
// against each other; it uses the same aero and engine functions as the flight
// model, so it cannot drift from what the player flies.

export interface EmPoint {
  speedMs: number;
  mach: number;
  /** Sustained turn rate (deg/s); 0 where the aircraft cannot hold level flight. */
  sustainedDegS: number;
  sustainedG: number;
  /** Instantaneous turn rate (deg/s) at the lift or G limit. */
  instantDegS: number;
  instantG: number;
}

export interface EmRow {
  altitudeM: number;
  points: EmPoint[];
}

const RAD = 180 / Math.PI;

export function emChart(id: AircraftId, altitudesM: readonly number[], speedsMs: readonly number[], fuelFraction = 0.5): EmRow[] {
  const cfg = AIRCRAFT[id];
  const massKg = cfg.mass.emptyKg + cfg.mass.internalFuelKg * fuelFraction;
  const weightN = massKg * PHYSICS.gravityMs2;
  const S = cfg.aero.wingAreaM2;
  const coeff = { lift: 0, drag: 0, separation: 0 };
  const rows: EmRow[] = [];
  for (const altitudeM of altitudesM) {
    const air = atmosphereAt(altitudeM);
    const points: EmPoint[] = [];
    for (const speedMs of speedsMs) {
      const mach = speedMs / air.speedOfSoundMs;
      const q = 0.5 * air.densityKgM3 * speedMs * speedMs;
      // Full afterburner thrust once spooled at this condition.
      const engine = createEngineState();
      engine.core = 1;
      engine.burner = 1;
      engine.lightingS = 10;
      stepEngine(cfg.engine, engine, 1.25, air.densityKgM3, mach, true, 0);
      const thrustN = engine.thrustN;
      const clMax = maxLiftCoefficient(cfg.aero, mach);
      const instantG = Math.min(cfg.limiter.gMax, (clMax * q * S) / weightN);
      // Sustained: the largest n with drag(n) ≤ thrust, by bisection on n.
      const dragAt = (n: number): number => {
        const cl = (n * weightN) / (q * S);
        if (cl > clMax) return Number.POSITIVE_INFINITY;
        // AoA for this CL in attached flow, then the full drag at that AoA.
        let lo = 0;
        let hi = cfg.aero.stallAoaRad;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          aeroCoefficients(cfg.aero, mid, mach, coeff);
          if (coeff.lift < cl) lo = mid;
          else hi = mid;
        }
        aeroCoefficients(cfg.aero, hi, mach, coeff);
        return coeff.drag * q * S;
      };
      let sustainedG = 0;
      if (dragAt(1) <= thrustN) {
        let lo = 1;
        let hi = Math.max(1, instantG);
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (dragAt(mid) <= thrustN) lo = mid;
          else hi = mid;
        }
        sustainedG = lo;
      }
      const rate = (n: number): number => (n > 1 ? ((PHYSICS.gravityMs2 * Math.sqrt(n * n - 1)) / speedMs) * RAD : 0);
      points.push({ speedMs, mach, sustainedDegS: rate(sustainedG), sustainedG, instantDegS: rate(instantG), instantG });
    }
    rows.push({ altitudeM, points });
  }
  return rows;
}

/** Plain-text table of the chart (debug overlay and the milestone report). */
export function formatEmChart(id: AircraftId, rows: readonly EmRow[]): string {
  const lines: string[] = [`${AIRCRAFT[id].name} — turn rate (deg/s) sustained / instantaneous, full afterburner, 50 % fuel`];
  const header = rows[0]?.points.map((p) => String(Math.round(p.speedMs)).padStart(9)).join('') ?? '';
  lines.push(`alt \\ TAS m/s ${header}`);
  for (const row of rows) {
    const cells = row.points.map((p) => `${p.sustainedDegS.toFixed(1)}/${p.instantDegS.toFixed(0)}`.padStart(9)).join('');
    lines.push(`${String(row.altitudeM / 1000).padStart(5)} km      ${cells}`);
  }
  return lines.join('\n');
}
