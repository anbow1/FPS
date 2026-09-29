import { describe, expect, it } from 'vitest';
import { SHORE } from '../src/config.ts';
import { heightAt } from '../src/game/terrain.ts';
import { computeShoreField, heightGrid, phaseSpeed, SHORE_DOMAIN } from '../src/render/shoreField.ts';

// The baked shore-wave field (render/shoreField.ts): wave fronts must slow in
// shallow water, turn to face the beach, and reach the lagoon's south beach
// through the channel with reduced energy.

const omega = (2 * Math.PI) / SHORE.periodS;

function sample(f: ReturnType<typeof computeShoreField>, x: number, z: number): { t: number; dx: number; dz: number; exposure: number; tShore: number } {
  const i = Math.floor((x - SHORE_DOMAIN.x0) / f.cellM);
  const j = Math.floor((z - SHORE_DOMAIN.z0) / f.cellM);
  const k = (j * f.res + i) * 4;
  const dx = f.data[k + 1] as number;
  const dz = f.data[k + 2] as number;
  return { t: f.data[k] as number, dx, dz, exposure: Math.hypot(dx, dz), tShore: f.data[k + 3] as number };
}

describe('shore wave field', () => {
  it('slows waves in shallow water (dispersion)', () => {
    const deep = phaseSpeed(omega, 12);
    const shallow = phaseSpeed(omega, 0.5);
    expect(deep).toBeGreaterThan(shallow * 2);
    // Shallow-water limit: c → √(g h).
    expect(phaseSpeed(omega, 0.2)).toBeCloseTo(Math.sqrt(9.81 * 0.2), 1);
  });

  it('turns fronts to meet a straight beach head-on, whatever the swell angle', () => {
    // A beach along z = 0 sloping down to the north (−Z), like the lagoon's south shore.
    const f = computeShoreField(heightGrid((_x, z) => Math.min(3, z * 0.05), 128), 128);
    const off = sample(f, 0, -400);
    const near = sample(f, 0, -8);
    expect(near.t).toBeGreaterThan(off.t);
    // Offshore the front follows the swell; near the beach it points almost straight up the slope.
    expect(Math.abs(near.dx / near.exposure)).toBeLessThan(Math.abs(off.dx / off.exposure) + 1e-3);
    expect(near.dz / near.exposure).toBeGreaterThan(0.97);
  });

  it('reaches the lagoon beach through the channel, calmed on the way', () => {
    const f = computeShoreField(heightGrid(heightAt, 256), 256);
    const beach = sample(f, 0, -8);
    const sea = sample(f, 0, -455);
    expect(Number.isFinite(beach.t) && beach.t < 1e4).toBe(true);
    expect(beach.t).toBeGreaterThan(sea.t);
    expect(beach.exposure).toBeGreaterThan(0.05);
    expect(beach.exposure).toBeLessThan(sea.exposure);
    // On the dry beach the shoreline arrival time is carried inland.
    const sand = sample(f, 0, 6);
    expect(sand.tShore).toBeLessThan(1e4);
  });
});
