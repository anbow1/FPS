import { WATER_LEVEL_M } from '../config.ts';
import type { CollisionWorld } from './colliders.ts';

/**
 * A small fishing cutter riding at anchor out in the lagoon, off the dock: scenery (shared/vehicles/
 * boat_cutter). Its hull is a box the skiff fends off and a swimmer bumps into; it swings a little to its
 * anchor and rides the chop (render/mooredBoat.ts), the box stays put.
 */
export const CUTTER = {
  x: -18,
  z: -34,
  /** Heading of the bow (forward is (sin, cos) of it, as the skiff's). */
  yawRad: 0.9,
  lengthM: 8,
  beamM: 3.2,
  /** The model's keel to its waterline: an 8 m cutter draws about 0.9 m. */
  draftM: 0.9,
  /** Waterline to the deck edge amidships (the model's sheer is ~2 m over its keel). */
  freeboardM: 1.1,
} as const;

export function buildMooredColliders(c: CollisionWorld): void {
  const hy = (CUTTER.draftM + CUTTER.freeboardM) / 2;
  c.add({
    kind: 'box',
    x: CUTTER.x,
    y: WATER_LEVEL_M - CUTTER.draftM + hy,
    z: CUTTER.z,
    hx: CUTTER.beamM * 0.45,
    hy,
    hz: CUTTER.lengthM * 0.47,
    yawRad: CUTTER.yawRad,
    surface: 'wood',
  });
}
