import { describe, expect, it } from 'vitest';
import { AMMO } from '../src/config';
import { flyTo, holdoverMil, solveElevation, timeOfFlight } from '../src/game/ballistics';

const ap = AMMO.APFSDS;

describe('APFSDS against the projectile reference sheet', () => {
  it.each([
    [500, 0.32, 1567],
    [1000, 0.64, 1535],
    [2000, 1.3, 1473],
    [3000, 2.0, 1413],
  ])('%d m: time of flight %f s, speed ~%d m/s', (range, tof, speed) => {
    const t = timeOfFlight(ap, range);
    expect(t).toBeCloseTo(tof, 1);
    const s = flyTo(ap, solveElevation(ap, range, 0), range, { t: 0, y: 0, v: 0 });
    expect(Math.abs(s.v - speed) / speed).toBeLessThan(0.02);
  });

  it.each([
    [500, -1.0],
    [1000, 0.0],
    [2000, 2.1],
    [3000, 4.3],
  ])('holdover at %d m is about %f mil', (range, mil) => {
    expect(holdoverMil(ap, range)).toBeCloseTo(mil, 0);
    expect(Math.abs(holdoverMil(ap, range) - mil)).toBeLessThan(0.35);
  });
});

describe('fire-control solver', () => {
  it('hits the requested point for every ammo type', () => {
    for (const ammo of Object.values(AMMO)) {
      for (const [range, dy] of [[300, 0], [1200, 25], [2000, -40]] as const) {
        const a = solveElevation(ammo, range, dy);
        const s = flyTo(ammo, a, range, { t: 0, y: 0, v: 0 });
        expect(Math.abs(s.y - dy)).toBeLessThan(0.05);
      }
    }
  });

  it('slower rounds need more superelevation', () => {
    const r = 1500;
    expect(solveElevation(AMMO.HE, r, 0)).toBeGreaterThan(solveElevation(AMMO.HEAT, r, 0));
    expect(solveElevation(AMMO.HEAT, r, 0)).toBeGreaterThan(solveElevation(AMMO.APFSDS, r, 0));
  });
});
