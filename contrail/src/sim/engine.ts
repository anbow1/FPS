import { ISA, type EngineConfig } from '../config.ts';

// A turbofan as the pilot feels it: thrust that lapses with air density and
// gains a little with ram pressure, a core that takes seconds to spool, an
// afterburner with a light-off delay, and fuel flow from specific fuel
// consumption. Above the tropopause the air is isothermal and thrust falls with
// density alone, so the top end collapses as it should.

export interface EngineState {
  /** Core speed as a fraction of military power, 0.05 (idle) … 1. */
  core: number;
  /** Afterburner stage 0 … 1 (0 = off). */
  burner: number;
  /** Seconds the burner has been requested but not yet lit. */
  lightingS: number;
  /** Total thrust of all engines this step (N). */
  thrustN: number;
  /** Fuel burnt this step (kg/s). */
  fuelFlowKgS: number;
}

export function createEngineState(): EngineState {
  return { core: 0.05, burner: 0, lightingS: 0, thrustN: 0, fuelFlowKgS: 0 };
}

const IDLE = 0.05;

/**
 * Advances the engine by `dtS`. `throttle` 0…1 is the dry range (idle to
 * military), 1…1.25 the afterburner detent (minimum to maximum burner).
 */
export function stepEngine(engine: EngineConfig, state: EngineState, throttle: number, densityKgM3: number, mach: number, hasFuel: boolean, dtS: number): void {
  const t = hasFuel ? Math.min(Math.max(throttle, 0), 1.25) : 0;
  const coreTarget = hasFuel ? IDLE + (1 - IDLE) * Math.min(t, 1) : 0;
  // Spooling is slow at low core speed and quicker near the top, as in a real fan.
  const rate = coreTarget > state.core ? (0.35 + state.core) / engine.spoolUpS : 1 / engine.spoolDownS;
  state.core += Math.sign(coreTarget - state.core) * Math.min(Math.abs(coreTarget - state.core), rate * dtS);
  const wantBurner = t > 1.001 && state.core > 0.95;
  if (wantBurner) {
    state.lightingS += dtS;
    if (state.lightingS >= engine.lightOffS) {
      const burnerTarget = (t - 1) / 0.25;
      state.burner += Math.sign(burnerTarget - state.burner) * Math.min(Math.abs(burnerTarget - state.burner), dtS / 0.6);
    }
  } else {
    state.lightingS = 0;
    state.burner = Math.max(0, state.burner - dtS / 0.3);
  }

  const sigma = densityKgM3 / ISA.seaLevelDensityKgM3;
  const lapse = Math.pow(sigma, 0.8);
  const inlet = 1 - 0.55 * smooth(engine.inletLimitMach - 0.1, engine.inletLimitMach + 0.35, mach);
  // Dry thrust grows roughly with core speed squared above idle (fan pressure ratio).
  const dry = engine.dryThrustN * state.core * state.core * lapse * (1 + engine.ramDry * mach) * inlet;
  const wet = (engine.wetThrustN - engine.dryThrustN) * state.burner * lapse * (1 + engine.ramWet * mach) * inlet;
  state.thrustN = (dry + wet) * engine.engines;
  // In afterburner the whole engine runs at the wet consumption, not only the extra thrust.
  const tsfc = engine.tsfcDryKgNs + (engine.tsfcWetKgNs - engine.tsfcDryKgNs) * Math.min(1, state.burner * 3);
  state.fuelFlowKgS = state.thrustN * tsfc;
}

function smooth(e0: number, e1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
}
