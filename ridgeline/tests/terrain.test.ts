import { describe, expect, it } from 'vitest';
import { bakeGrid, riverX, sampleGrid, sourceHeight, TERRAIN, TerrainData } from '../src/sim/terrain.ts';

describe('terrain', () => {
  it('bakes grids that match the source, with a flat base, a river channel and ridges to hide behind', async () => {
    const t0 = performance.now();
    const near = await bakeGrid(TERRAIN.nearRes, TERRAIN.nearSizeM, 1);
    const far = await bakeGrid(TERRAIN.farRes, TERRAIN.farSizeM, 0);
    console.log(`bake ${(performance.now() - t0).toFixed(0)} ms`);
    const data = new TerrainData(near, far);
    expect(Math.abs(data.heightAt(300, 0) - TERRAIN.baseElevationM)).toBeLessThan(0.5);
    expect(Math.abs(data.heightAt(300, 200) - TERRAIN.baseElevationM)).toBeLessThan(1);
    // A texel centre returns its own value.
    const cell = TERRAIN.nearSizeM / TERRAIN.nearRes;
    const x = -TERRAIN.nearSizeM / 2 + (300 + 0.5) * cell;
    const z = -TERRAIN.nearSizeM / 2 + (700 + 0.5) * cell;
    expect(sampleGrid(near, TERRAIN.nearRes, TERRAIN.nearSizeM, x, z)).toBeCloseTo(sourceHeight(x, z), 3);
    // The river channel sits below its banks.
    const zr = 5000;
    expect(data.heightAt(riverX(zr), zr)).toBeLessThan(data.heightAt(riverX(zr) + 120, zr) - 2);
    // Relief: ridges well above the valley floor inside the battlefield.
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j < TERRAIN.nearRes; j += 4)
      for (let i = 0; i < TERRAIN.nearRes; i += 4) {
        const v = near[j * TERRAIN.nearRes + i]!;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    console.log(`near ${min.toFixed(0)}…${max.toFixed(0)} m`);
    expect(max - min).toBeGreaterThan(400);
    // Masking is possible: from the valley at 30 m above the ground, most directions are closed by
    // terrain within 4 km for a target also at 30 m.
    let blocked = 0;
    const n = 24;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const ox = 300;
      const oz = 0;
      const tx = ox + Math.sin(a) * 4000;
      const tz = oz + Math.cos(a) * 4000;
      const y0 = data.heightAt(ox, oz) + 30;
      const y1 = data.heightAt(tx, tz) + 30;
      for (let s = 1; s < 100; s++) {
        const f = s / 100;
        if (data.heightAt(ox + (tx - ox) * f, oz + (tz - oz) * f) > y0 + (y1 - y0) * f) {
          blocked++;
          break;
        }
      }
    }
    console.log(`lines of sight blocked: ${blocked}/${n}`);
    expect(blocked).toBeGreaterThan(n / 2);
  });
});

describe('terrain maps', () => {
  it('bakes the same normal and cover texels from bands with border rows as from the whole grid', async () => {
    const { bakeMapRows } = await import('../src/sim/terrain.ts');
    const res = 64;
    const size = 6400;
    const grid = await bakeGrid(res, size, 1);
    const whole = bakeMapRows(grid, 0, res, size, 0, res);
    const rows = 10;
    for (let j0 = 0; j0 < res; j0 += rows) {
      const j1 = Math.min(res, j0 + rows);
      const r0 = Math.max(0, j0 - 1);
      const band = bakeMapRows(grid.slice(r0 * res, Math.min(res, j1 + 1) * res), r0, res, size, j0, j1);
      expect(Array.from(band.normal)).toEqual(Array.from(whole.normal.subarray(j0 * res * 4, j1 * res * 4)));
      expect(Array.from(band.cover)).toEqual(Array.from(whole.cover.subarray(j0 * res * 4, j1 * res * 4)));
    }
  });
});
