import { describe, expect, it } from 'vitest';
import { PHYSICS } from '../src/config.ts';
import { Aircraft } from '../src/sim/aircraft.ts';
import { neutralInput } from '../src/sim/controlLaws.ts';

const FLAT = (): number => 120;

function run(ac: Aircraft, seconds: number, input = neutralInput(), each?: (ac: Aircraft, t: number) => void): void {
  const steps = Math.round(seconds / PHYSICS.stepSeconds);
  for (let i = 0; i < steps; i++) {
    ac.step(input, PHYSICS.stepSeconds, FLAT);
    each?.(ac, i * PHYSICS.stepSeconds);
  }
}

describe('landing gear', () => {
  it('sits still on the runway at its static compression with the brakes on', () => {
    const ac = new Aircraft('wraith');
    ac.placeOnGround(0, 0, 0, 120);
    run(ac, 5, { ...neutralInput(), throttle: 0, brake: true });
    expect(ac.crashed).toBe(false);
    expect(ac.gear.weightOnWheels).toBe(true);
    expect(Math.hypot(ac.velocity.x, ac.velocity.z)).toBeLessThan(0.2);
    const main = ac.gear.compression[1]!;
    expect(main).toBeGreaterThan(0.05);
    expect(main).toBeLessThan(0.3);
  });

  it('takes off in afterburner within the runway when rotated at ~80 m/s', () => {
    for (const id of ['wraith', 'talon'] as const) {
      const ac = new Aircraft(id);
      ac.placeOnGround(0, 1400, 0, 120);
      const input = { ...neutralInput(), throttle: 1.25 };
      let liftoffZ = Number.NaN;
      run(ac, 40, input, (a) => {
        // Rotate at ~78 m/s to about 12° nose up, then hold the attitude.
        const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, 2 * (a.orientation.w * a.orientation.x)))) * 180) / Math.PI;
        input.pitch = a.speedMs > 78 ? Math.max(-0.3, Math.min(0.6, (12 - pitchDeg) * 0.08)) : 0;
        if (Number.isNaN(liftoffZ) && !a.gear.weightOnWheels && a.position.y > 125) liftoffZ = a.position.z;
      });
      expect(ac.crashed).toBe(false);
      expect(Number.isNaN(liftoffZ)).toBe(false);
      // Ground roll under 2.2 km from the start point.
      expect(1400 - liftoffZ).toBeLessThan(2200);
      expect(ac.position.y).toBeGreaterThan(300);
    }
  });

  it('survives a 1.5 m/s touchdown and collapses at 6 m/s', () => {
    const land = (sinkMs: number): Aircraft => {
      const ac = new Aircraft('wraith');
      ac.placeInFlight(0, 125, 0, 0, 75);
      ac.toggleGear();
      ac.gear.position = 1;
      ac.velocity.y = -sinkMs;
      ac.angular.set(0, 0, 0);
      // Slight nose-up attitude so the mains touch first.
      ac.orientation.setFromYawPitchRoll(0, 0.1, 0);
      run(ac, 3, { ...neutralInput(), throttle: 0.2 });
      return ac;
    };
    const soft = land(1.5);
    expect(soft.crashed).toBe(false);
    expect(soft.gear.touchdownSinkMs).toBeGreaterThan(0.5);
    const hard = land(6);
    expect(hard.crashed).toBe(true);
  });
});
