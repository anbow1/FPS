import { beforeAll, describe, expect, it } from 'vitest';
import { bakeCloudData, type CloudData, densityAt, lineTransmittance } from '../src/sim/cloudField.ts';

// The cloud field is game logic (AI eyes) as well as scenery: its coverage
// numbers must mean what the presets say, and a line through a cloud must be
// blocked while a line above the weather is clear.

let data: CloudData;

beforeAll(async () => {
  data = await bakeCloudData();
}, 60_000);

function cloudyColumns(coverage: number): number {
  const layer = { baseM: 1600, topM: 3400, coverage };
  // Deterministic sample grid over the weather tile.
  let cloudy = 0;
  const n = 40;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = (i + 0.37) * 4000;
      const z = (j + 0.61) * 4000;
      let col = 0;
      for (let h = 1650; h < 3400 && col <= 0.05; h += 60) col = Math.max(col, densityAt(data, layer, x, h, z));
      if (col > 0.05) cloudy++;
    }
  }
  return cloudy / (n * n);
}

describe('cloud field', () => {
  it('covers about as much sky as the preset says', () => {
    for (const c of [0.12, 0.55, 0.95]) expect(Math.abs(cloudyColumns(c) - c)).toBeLessThan(0.08);
  });

  it('is empty outside the layer', () => {
    const layer = { baseM: 1600, topM: 3400, coverage: 1 };
    expect(densityAt(data, layer, 1234, 1500, 5678)).toBe(0);
    expect(densityAt(data, layer, 1234, 3500, 5678)).toBe(0);
  });

  it('hides a target behind an overcast but not above it', () => {
    const layer = { baseM: 1600, topM: 3400, coverage: 1 };
    // Looking from below the deck up through it.
    expect(lineTransmittance(data, layer, 0, 500, 0, 2000, 6000, 3000)).toBeLessThan(0.01);
    // Both above the weather.
    expect(lineTransmittance(data, layer, 0, 5000, 0, 20000, 6000, 3000)).toBe(1);
  });
});
