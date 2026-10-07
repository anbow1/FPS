import { describe, expect, it } from 'vitest';
import { blackbody } from '../src/core/blackbody.ts';
import { contrailStrength, vapourStrength } from '../src/render/trails.ts';
import { atmosphereAt } from '../src/sim/atmosphere.ts';

describe('trail formation', () => {
  it('forms contrails only in the cold air above about 8 km', () => {
    const at = (h: number): number => contrailStrength(atmosphereAt(h).temperatureK, 1, 1);
    expect(at(3000)).toBe(0);
    expect(at(7000)).toBe(0);
    expect(at(10_000)).toBeGreaterThan(0.9);
  });

  it('draws wingtip vapour only when pulling hard at speed', () => {
    expect(vapourStrength(1, 250, 2000, 1)).toBe(0);
    expect(vapourStrength(8, 60, 2000, 1)).toBe(0);
    expect(vapourStrength(8, 250, 2000, 1)).toBeGreaterThan(0.9);
    // Drier air high up: weaker.
    expect(vapourStrength(8, 250, 11_000, 1)).toBeLessThan(vapourStrength(8, 250, 2000, 1));
  });
});

describe('black body', () => {
  it('runs from red-orange through white to blue', () => {
    const [r1, , b1] = blackbody(1900);
    expect(r1).toBeGreaterThan(b1 * 10);
    const [r6, g6, b6] = blackbody(6500);
    expect(Math.abs(r6 - g6)).toBeLessThan(0.1);
    expect(Math.abs(b6 - g6)).toBeLessThan(0.1);
    const [r12, , b12] = blackbody(12_000);
    expect(b12).toBeGreaterThan(r12);
  });
});
