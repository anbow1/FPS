import { describe, expect, it } from 'vitest';
import { hexToLinear, kelvinToLinearRgb, luminanceOf, preExposureFor } from '../src/render/colour.ts';

describe('colour helpers', () => {
  it('golden-hour sun (3200 K) is warm and the clear sky (10000 K) is cool', () => {
    const sun = kelvinToLinearRgb(3200);
    const sky = kelvinToLinearRgb(10000);
    expect(sun.r).toBeGreaterThan(sun.g);
    expect(sun.g).toBeGreaterThan(sun.b);
    expect(sky.b).toBeGreaterThan(sky.r);
  });

  it('6500 K is close to neutral white (within 15 % per channel)', () => {
    const c = kelvinToLinearRgb(6500);
    for (const v of [c.r, c.g, c.b]) expect(v).toBeGreaterThan(0.85);
  });

  it('rejects temperatures outside the approximation range', () => {
    expect(() => kelvinToLinearRgb(500)).toThrow(/1000–15000/);
  });

  it('pre-exposure matches the lighting sheet at noon (EV 15.3 → 2.08e-5)', () => {
    expect(Math.abs(preExposureFor(15.3) - 2.08e-5) / 2.08e-5).toBeLessThan(0.01); // the sheet rounds to 3 figures
  });

  it('sheet colours convert to the listed linear luminance (asphalt #3A3A3C → L 0.043)', () => {
    expect(luminanceOf(hexToLinear(0x3a3a3c))).toBeCloseTo(0.043, 3);
    expect(luminanceOf(hexToLinear(0x8a4b3a))).toBeCloseTo(0.107, 2);
  });
});

describe('light colour (white-balanced to D65)', () => {
  it('D65 itself renders white', async () => {
    const { lightColour } = await import('../src/render/colour.ts');
    const c = lightColour(6504);
    for (const v of [c.r, c.g, c.b]) expect(v).toBeCloseTo(1, 3);
  });

  it('noon sun (5500 K) is mildly warm, golden hour (3200 K) clearly warm', async () => {
    const { lightColour } = await import('../src/render/colour.ts');
    const noon = lightColour(5500);
    const golden = lightColour(3200);
    expect(noon.b).toBeGreaterThan(0.7); // photographic daylight: slightly warm of D65
    expect(noon.g).toBeGreaterThan(0.88); // but not magenta: green stays close to red
    expect(golden.b).toBeLessThan(0.5);
  });
});
