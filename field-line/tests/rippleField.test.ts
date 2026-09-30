import { describe, expect, it } from 'vitest';
import { RippleField } from '../src/render/rippleField.ts';

const N = 96;
const CELL_M = 0.2;

/** |slope| (encoded units) of the uploaded texture at a world point, given where the window is centred. */
function slopeAt(f: RippleField, centreX: number, centreZ: number, x: number, z: number): number {
  const i = Math.round((x - Math.round(centreX / CELL_M) * CELL_M) / CELL_M + N / 2 - 0.5);
  const j = Math.round((z - Math.round(centreZ / CELL_M) * CELL_M) / CELL_M + N / 2 - 0.5);
  const b = f.texture.image.data as Uint8Array;
  const o = (j * N + i) * 4;
  return Math.hypot((b[o] as number) - 128, (b[o + 1] as number) - 128);
}

/** Radius (m) along +x where the slope is largest. */
function ringRadius(f: RippleField, cx: number, cz: number): number {
  let best = 0;
  let bestR = 0;
  for (let r = 0; r < (N / 2 - 2) * CELL_M; r += CELL_M) {
    const s = slopeAt(f, cx, cz, cx + r, cz);
    if (s > best) {
      best = s;
      bestR = r;
    }
  }
  return bestR;
}

function run(f: RippleField, seconds: number, x = 0, z = 0): void {
  for (let t = 0; t < seconds; t += 1 / 60) f.update(1 / 60, x, z);
}

describe('RippleField', () => {
  // In 2-D the steepest part of the ring trails the leading front (at c·t) a little.
  it('spreads a splash as a ring at the wave speed', () => {
    const f = new RippleField({ cells: N, cellM: CELL_M, speedMps: 1.2, lifeS: 3 });
    f.update(1 / 60, 0, 0);
    f.disturb(0, 0, 0.3, 0.05);
    run(f, 2.5);
    expect(ringRadius(f, 0, 0)).toBeGreaterThan(1.6);
    expect(ringRadius(f, 0, 0)).toBeLessThan(3.6);
  });

  it('goes calm and stops uploading once the ring has died away', () => {
    const f = new RippleField({ cells: N, cellM: CELL_M, speedMps: 1.2, lifeS: 0.4 });
    f.update(1 / 60, 0, 0);
    f.disturb(0, 0, 0.3, 0.05);
    run(f, 1);
    expect(ringRadius(f, 0, 0)).toBeGreaterThan(0);
    run(f, 12);
    const b = f.texture.image.data as Uint8Array;
    for (let o = 0; o < b.length; o += 4) {
      expect(b[o]).toBe(128);
      expect(b[o + 1]).toBe(128);
    }
  });

  it('holds land still, so rings stop at the bank', () => {
    const f = new RippleField({ cells: N, cellM: CELL_M, speedMps: 1.2, lifeS: 3, isWater: (x) => x > -1 });
    f.update(1 / 60, 0, 0);
    f.disturb(0, 0, 0.3, 0.05);
    run(f, 2.5);
    for (let x = -8; x < -1.5; x += CELL_M) expect(slopeAt(f, 0, 0, x, 0)).toBe(0);
    for (let x = 1.5; x < 3; x += CELL_M) expect(slopeAt(f, 0, 0, x, 0)).toBeGreaterThanOrEqual(0);
    expect(ringRadius(f, 0, 0)).toBeGreaterThan(1.6);
  });

  it('keeps a ring where it is in the world when the window re-centres', () => {
    const f = new RippleField({ cells: N, cellM: CELL_M, speedMps: 1.2, lifeS: 3 });
    f.update(1 / 60, 0, 0);
    f.disturb(0, 0, 0.3, 0.05);
    run(f, 1);
    // move the focus 3 m (15 cells, past the re-centring threshold) and keep going
    run(f, 1.5, -3, 0);
    // the ring is still centred on world x = 0: equal slopes 2.5 m to either side
    const left = slopeAt(f, -3, 0, -2.6, 0) + slopeAt(f, -3, 0, -3, 0) + slopeAt(f, -3, 0, -2.8, 0);
    const right = slopeAt(f, -3, 0, 2.6, 0) + slopeAt(f, -3, 0, 3, 0) + slopeAt(f, -3, 0, 2.8, 0);
    expect(left).toBeGreaterThan(0);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(Math.max(3, left * 0.2));
  });
});
