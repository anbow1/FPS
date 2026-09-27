import { describe, expect, it } from 'vitest';
import { ROUND_556, ROUND_MAGNUM } from '../src/config.ts';
import { dragDecelerationMs2, g7DragCoefficient, solveRange } from '../src/game/ballistics.ts';

// Known-good values: references/ballistics-reference.png, "Holdover · time · speed at range".
const SHEET = {
  rifle: [
    { rangeM: 100, mil: -1.2, tof: 0.12, speed: 815 },
    { rangeM: 300, mil: 0.0, tof: 0.4, speed: 626 },
    { rangeM: 500, mil: 2.3, tof: 0.77, speed: 462 },
    { rangeM: 800, mil: 8.8, tof: 1.6, speed: 303 },
  ],
  magnum: [
    { rangeM: 100, mil: -1.1, tof: 0.12, speed: 829 },
    { rangeM: 300, mil: 0.0, tof: 0.37, speed: 732 },
    { rangeM: 500, mil: 1.7, tof: 0.67, speed: 642 },
    { rangeM: 800, mil: 5.0, tof: 1.18, speed: 519 },
  ],
};

describe('G7 point-mass ballistics', () => {
  it('drag coefficient peaks just above Mach 1 like the G7 table', () => {
    expect(g7DragCoefficient(1.05)).toBeCloseTo(0.4043, 4);
    expect(g7DragCoefficient(0.5)).toBeLessThan(g7DragCoefficient(1.0));
  });

  it('drag deceleration is zero at zero speed', () => {
    expect(dragDecelerationMs2(0, ROUND_556)).toBe(0);
  });

  it.each(SHEET.rifle)('5.56 rifle at $rangeM m matches the sheet', ({ rangeM, mil, tof, speed }) => {
    const s = solveRange(ROUND_556, rangeM);
    expect(s.holdoverMil).toBeCloseTo(mil, 0);
    expect(Math.abs(s.holdoverMil - mil)).toBeLessThan(0.15);
    expect(Math.abs(s.timeOfFlightSeconds - tof)).toBeLessThan(0.015);
    expect(Math.abs(s.speedMs - speed) / speed).toBeLessThan(0.01);
  });

  it.each(SHEET.magnum)('magnum sniper at $rangeM m matches the sheet', ({ rangeM, mil, tof, speed }) => {
    const s = solveRange(ROUND_MAGNUM, rangeM);
    expect(Math.abs(s.holdoverMil - mil)).toBeLessThan(0.15);
    expect(Math.abs(s.timeOfFlightSeconds - tof)).toBeLessThan(0.015);
    expect(Math.abs(s.speedMs - speed) / speed).toBeLessThan(0.01);
  });

  it('sniper holdover at 600 m sits between the 500 m and 800 m sheet values', () => {
    const s = solveRange(ROUND_MAGNUM, 600);
    expect(s.holdoverMil).toBeGreaterThan(1.7);
    expect(s.holdoverMil).toBeLessThan(5.0);
  });

  it('rejects a zero or negative range', () => {
    expect(() => solveRange(ROUND_556, 0)).toThrow(/positive/);
  });
});
