import { describe, expect, it } from 'vitest';
import { AIRCRAFT, PHYSICS } from '../src/config.ts';
import { aeroCoefficients, liftSlope } from '../src/sim/aero.ts';
import { Aircraft } from '../src/sim/aircraft.ts';
import { atmosphereAt } from '../src/sim/atmosphere.ts';
import { neutralInput } from '../src/sim/controlLaws.ts';
import { emChart, formatEmChart } from '../src/sim/em.ts';
import { createEngineState, stepEngine } from '../src/sim/engine.ts';

const DEG = Math.PI / 180;

function fly(ac: Aircraft, seconds: number, input = neutralInput(), each?: (ac: Aircraft) => void): void {
  const steps = Math.round(seconds / PHYSICS.stepSeconds);
  for (let i = 0; i < steps; i++) {
    ac.step(input, PHYSICS.stepSeconds, () => -1000);
    each?.(ac);
  }
}

describe('standard atmosphere', () => {
  it('matches the ISA table at sea level, 11 km and 20 km', () => {
    // US Standard Atmosphere 1976 at geometric altitudes.
    const sl = atmosphereAt(0);
    expect(sl.densityKgM3).toBeCloseTo(1.225, 3);
    expect(sl.speedOfSoundMs).toBeCloseTo(340.3, 0);
    const trop = atmosphereAt(11_000);
    expect(trop.temperatureK).toBeCloseTo(216.77, 1);
    expect(trop.densityKgM3).toBeCloseTo(0.3648, 3);
    expect(atmosphereAt(20_000).densityKgM3).toBeCloseTo(0.0889, 3);
  });
});

describe('aerodynamics', () => {
  it('has a linear lift slope near zero AoA and a stall break past the stall AoA', () => {
    const aero = AIRCRAFT.wraith.aero;
    const c = { lift: 0, drag: 0, separation: 0 };
    aeroCoefficients(aero, 2 * DEG, 0.5, c);
    expect(c.lift).toBeCloseTo(liftSlope(aero, 0.5) * 2 * DEG, 1);
    aeroCoefficients(aero, aero.stallAoaRad - 3 * DEG, 0.3, c);
    const beforeStall = c.lift;
    aeroCoefficients(aero, aero.stallAoaRad + 12 * DEG, 0.3, c);
    expect(c.lift).toBeLessThan(beforeStall * 0.8);
    expect(c.separation).toBeGreaterThan(0.9);
  });

  it('rises in zero-lift drag through the transonic region', () => {
    const aero = AIRCRAFT.wraith.aero;
    const c = { lift: 0, drag: 0, separation: 0 };
    aeroCoefficients(aero, 0, 0.6, c);
    const sub = c.drag;
    aeroCoefficients(aero, 0, 1.1, c);
    expect(c.drag).toBeGreaterThan(sub * 1.8);
  });
});

describe('engine', () => {
  it('loses most of its thrust by 12 km and gains it back in afterburner', () => {
    const cfg = AIRCRAFT.wraith.engine;
    const e = createEngineState();
    e.core = 1;
    stepEngine(cfg, e, 1, atmosphereAt(0).densityKgM3, 0, true, 0);
    const sl = e.thrustN;
    expect(sl).toBeCloseTo(cfg.dryThrustN, -3);
    stepEngine(cfg, e, 1, atmosphereAt(12_000).densityKgM3, 0, true, 0);
    expect(e.thrustN).toBeLessThan(sl * 0.4);
  });

  it('takes seconds to spool and lights the burner after a delay', () => {
    const cfg = AIRCRAFT.wraith.engine;
    const e = createEngineState();
    const rho = atmosphereAt(0).densityKgM3;
    stepEngine(cfg, e, 1.25, rho, 0.3, true, 0.5);
    expect(e.core).toBeLessThan(0.5);
    for (let i = 0; i < 600; i++) stepEngine(cfg, e, 1.25, rho, 0.3, true, 1 / 60);
    expect(e.burner).toBeGreaterThan(0.9);
    expect(e.fuelFlowKgS).toBeGreaterThan(5);
  });
});

describe('flight model', () => {
  it('holds roughly level flight hands off (1 G command)', () => {
    const ac = new Aircraft('wraith');
    ac.placeInFlight(0, 5000, 0, 0, 230);
    fly(ac, 15, { ...neutralInput(), throttle: 0.75 });
    expect(Math.abs(ac.position.y - 5000)).toBeLessThan(250);
    expect(ac.crashed).toBe(false);
  });

  it('pulls to the 9 G limit at corner speed and no further with the limiter on', () => {
    for (const id of ['wraith', 'talon'] as const) {
      const ac = new Aircraft(id);
      ac.placeInFlight(0, 3000, 0, 0, 290);
      let peak = 0;
      fly(ac, 4, { ...neutralInput(), pitch: 1, throttle: 1.25 }, (a) => (peak = Math.max(peak, a.loadFactor)));
      expect(peak).toBeGreaterThan(8.3);
      expect(peak).toBeLessThan(9.6);
    }
  });

  it('respects the AoA limit at low speed and exceeds it when relaxed', () => {
    const ac = new Aircraft('wraith');
    ac.placeInFlight(0, 3000, 0, 0, 110);
    let peak = 0;
    fly(ac, 3, { ...neutralInput(), pitch: 1, throttle: 1 }, (a) => (peak = Math.max(peak, a.alphaRad)));
    expect(peak).toBeLessThan(AIRCRAFT.wraith.limiter.aoaMaxRad + 4 * DEG);
    const relaxed = new Aircraft('wraith');
    relaxed.placeInFlight(0, 3000, 0, 0, 110);
    let peakRelaxed = 0;
    fly(relaxed, 3, { ...neutralInput(), pitch: 1, throttle: 1, limiterRelaxed: true }, (a) => (peakRelaxed = Math.max(peakRelaxed, a.alphaRad)));
    expect(peakRelaxed).toBeGreaterThan(peak + 5 * DEG);
  });

  it('rolls at the commanded rate and stops when the stick is centred', () => {
    const ac = new Aircraft('wraith');
    ac.placeInFlight(0, 5000, 0, 0, 220);
    fly(ac, 1.5, { ...neutralInput(), roll: 1 });
    expect(-ac.angular.z).toBeGreaterThan(AIRCRAFT.wraith.limiter.rollRateMaxRadS * 0.7);
    fly(ac, 1.5, neutralInput());
    expect(Math.abs(ac.angular.z)).toBeLessThan(0.1);
  });

  it('turns slower at 12 km than at 3 km (thin air)', () => {
    const rows = emChart('wraith', [3000, 12_000], [250]);
    expect(rows[1]!.points[0]!.sustainedDegS).toBeLessThan(rows[0]!.points[0]!.sustainedDegS * 0.5);
  });

  it('gives the Talon thrust vectoring the edge in pitch at low speed', () => {
    const pitchAt = (id: 'wraith' | 'talon'): number => {
      const ac = new Aircraft(id);
      ac.placeInFlight(0, 3000, 0, 0, 75);
      ac.engine.core = 1;
      fly(ac, 0.5, { ...neutralInput(), pitch: 1, throttle: 1, limiterRelaxed: true });
      return ac.angular.x;
    };
    expect(pitchAt('talon')).toBeGreaterThan(pitchAt('wraith'));
  });
});

describe('energy-manoeuvrability chart', () => {
  it('prints sensible numbers for both aircraft', () => {
    const alts = [0, 3000, 6000, 9000, 12_000];
    const speeds = [100, 150, 200, 250, 300, 350, 400, 450, 500];
    for (const id of ['wraith', 'talon'] as const) {
      const rows = emChart(id, alts, speeds);
      console.log(formatEmChart(id, rows));
      // Sea level, 250 m/s: a modern fighter sustains roughly 15–24 deg/s.
      const sl250 = rows[0]!.points[3]!;
      expect(sl250.sustainedDegS).toBeGreaterThan(13);
      expect(sl250.sustainedDegS).toBeLessThan(26);
      expect(sl250.instantDegS).toBeGreaterThan(sl250.sustainedDegS);
    }
  });
});
