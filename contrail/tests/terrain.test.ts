import { describe, expect, it } from 'vitest';
import { bakeGrid, sampleGrid, sourceHeight, TERRAIN, TerrainData } from '../src/sim/terrain.ts';

describe('terrain', () => {
  it('bakes grids whose bilinear lookup matches the source at texel centres, with a flat airbase', async () => {
    const t0 = performance.now();
    const near = await bakeGrid(TERRAIN.nearRes, TERRAIN.nearSizeM, 1);
    const far = await bakeGrid(TERRAIN.farRes, TERRAIN.farSizeM, 0);
    const ms = performance.now() - t0;
    console.log(`bake ${ms.toFixed(0)} ms`);
    const data = new TerrainData(near, far);
    expect(data.heightAt(0, 0)).toBeCloseTo(TERRAIN.airbaseElevationM, 0);
    expect(Math.abs(data.heightAt(0, 1400) - TERRAIN.airbaseElevationM)).toBeLessThan(1);
    // A texel centre returns its own value.
    const cell = TERRAIN.nearSizeM / TERRAIN.nearRes;
    const x = -TERRAIN.nearSizeM / 2 + (300 + 0.5) * cell;
    const z = -TERRAIN.nearSizeM / 2 + (700 + 0.5) * cell;
    expect(sampleGrid(near, TERRAIN.nearRes, TERRAIN.nearSizeM, x, z)).toBeCloseTo(sourceHeight(x, z), 3);
    let min = Infinity;
    let max = -Infinity;
    for (const v of near) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    let fmin = Infinity;
    let fmax = -Infinity;
    for (const v of far) {
      fmin = Math.min(fmin, v);
      fmax = Math.max(fmax, v);
    }
    console.log(`near ${min.toFixed(0)}…${max.toFixed(0)} m, far ${fmin.toFixed(0)}…${fmax.toFixed(0)} m`);
    expect(max).toBeGreaterThan(1500);
    expect(fmin).toBeLessThan(0);
  });
});
