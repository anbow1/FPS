import { describe, expect, it } from 'vitest';
import { LIGHTING } from '../src/config.ts';
import { adaptEv, meterEv } from '../src/render/exposure.ts';
import { preExposureFor } from '../src/render/colour.ts';

/** A metering grid where every cell reads `nits` cd/m², pre-exposed as the GPU pass would. */
function uniformGrid(nits: number, preExposure: number): Float32Array {
  const data = new Float32Array(64 * 36 * 4);
  for (let i = 0; i < data.length; i += 4) data[i] = nits * preExposure;
  return data;
}

describe('auto exposure', () => {
  it('a sunlit 18 % grey card meters within 0.3 EV of the sheet EV100 for clear noon', () => {
    const noon = LIGHTING.noon;
    const lux = noon.sunIlluminanceLux * Math.sin(noon.sunElevationRad) + noon.skyIlluminanceLux;
    const nits = (0.18 * lux) / Math.PI; // Lambertian: L = ρ · E / π
    const ev = meterEv(uniformGrid(nits, preExposureFor(noon.ev100)), preExposureFor(noon.ev100));
    expect(Math.abs(ev - noon.ev100)).toBeLessThan(0.3);
  });

  it('ignores the darkest half of the frame (a black doorway does not open the eye up)', () => {
    const pre = preExposureFor(15.3);
    const data = uniformGrid(5000, pre);
    for (let i = 0; i < data.length / 2; i += 4) data[i] = 0.5 * pre; // half the frame near-black
    const ev = meterEv(data, pre);
    expect(ev).toBeGreaterThan(meterEv(uniformGrid(5000, pre), pre) - 0.5);
  });

  it('walking from the noon street into a dim room adapts in about 2 s, with no jump', () => {
    const preset = LIGHTING.noon.ev100;
    const roomEv = preset - 5.5;
    let ev = preset;
    let t = 0;
    let largestStep = 0;
    while (Math.abs(ev - roomEv) > 0.25 && t < 10) {
      const next = adaptEv(ev, roomEv, preset, 1 / 60);
      largestStep = Math.max(largestStep, Math.abs(next - ev));
      ev = next;
      t += 1 / 60;
    }
    expect(t).toBeGreaterThan(1.5);
    expect(t).toBeLessThan(2.5);
    expect(largestStep).toBeLessThan(0.3); // no black frame: under a third of a stop per frame
  });

  it('coming back out into the sun adapts faster than going in', () => {
    const preset = LIGHTING.noon.ev100;
    let ev = preset - 5.5;
    let t = 0;
    while (Math.abs(ev - preset) > 0.25 && t < 10) {
      ev = adaptEv(ev, preset, preset, 1 / 60);
      t += 1 / 60;
    }
    expect(t).toBeLessThan(0.8);
  });

  it('never adapts past the preset clamp, so an interior never becomes day', () => {
    const preset = LIGHTING.noon.ev100;
    let ev = preset;
    for (let i = 0; i < 60 * 30; i++) ev = adaptEv(ev, -5, preset, 1 / 60);
    expect(ev).toBeGreaterThanOrEqual(preset - 7 - 1e-6);
  });
});
