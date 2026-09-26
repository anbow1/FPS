import type { SurfaceKind } from '../config.ts';
import type { Heightfield } from '../game/collision.ts';

// Heightfield construction shared by the map generators. Samples are laid out
// row by row along +X, starting at (originX, originZ), `cellM` apart.

export function makeHeightfield(
  halfSizeM: number,
  cellM: number,
  heightAt: (x: number, z: number) => number,
  surfaceAt: (x: number, z: number) => SurfaceKind,
): Heightfield {
  if (halfSizeM <= 0 || cellM <= 0) throw new Error(`heightfield needs positive sizes, got half ${halfSizeM} m, cell ${cellM} m`);
  const samples = Math.round((halfSizeM * 2) / cellM) + 1;
  const heightsM = new Float32Array(samples * samples);
  const origin = -halfSizeM;
  for (let iz = 0; iz < samples; iz++) {
    for (let ix = 0; ix < samples; ix++) {
      heightsM[iz * samples + ix] = heightAt(origin + ix * cellM, origin + iz * cellM);
    }
  }
  return { originX: origin, originZ: origin, cellM, samplesX: samples, samplesZ: samples, heightsM, surfaceAt };
}

/** Bilinear sample of a heightfield, for generators that need the ground before the collision world exists. */
export function sampleHeight(t: Heightfield, x: number, z: number): number {
  const fx = Math.min(Math.max((x - t.originX) / t.cellM, 0), t.samplesX - 1.001);
  const fz = Math.min(Math.max((z - t.originZ) / t.cellM, 0), t.samplesZ - 1.001);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const i = iz * t.samplesX + ix;
  const h = t.heightsM;
  const h00 = h[i] as number;
  const h10 = h[i + 1] as number;
  const h01 = h[i + t.samplesX] as number;
  const h11 = h[i + t.samplesX + 1] as number;
  return h00 + (h10 - h00) * u + (h01 - h00) * v + (h00 - h10 - h01 + h11) * u * v;
}

/** Distance from point p to segment ab in the XZ plane. */
export function distanceToSegmentXZ(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
