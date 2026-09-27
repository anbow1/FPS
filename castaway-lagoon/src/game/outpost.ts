import { OUTPOST_CENTRE } from './terrain.ts';

// The survival outpost's layout, in the shelter's own frame: metres, X to the
// right, Z toward the back wall, the open front facing −Z (the lagoon). Logic
// builds colliders and interactables from it; render builds meshes from the
// same numbers, so a table you see is the table you bump into.

export const OUTPOST = {
  x: OUTPOST_CENTRE.x,
  z: OUTPOST_CENTRE.z,
  groundY: 1.05, // the clearing is flattened to this height (terrain.ts)
  yawRad: -0.22, // front turned toward the lagoon's middle
  deckHeightM: 0.3, // plank floor on short stilts, clear of the wet sand
  deckHalfX: 2.3,
  deckHalfZ: 1.85,
  frontPostHeightM: 2.55,
  backPostHeightM: 1.95,
  postRadiusM: 0.075,
} as const;

export const DECK_TOP_Y = OUTPOST.groundY + OUTPOST.deckHeightM;

export interface LocalPoint {
  x: number;
  y: number; // above the deck top unless stated
  z: number;
}

/** Shelter-local → world. `y` is added to the deck top. */
export function outpostToWorld(lx: number, ly: number, lz: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const c = Math.cos(OUTPOST.yawRad);
  const s = Math.sin(OUTPOST.yawRad);
  out.x = OUTPOST.x + lx * c + lz * s;
  out.z = OUTPOST.z - lx * s + lz * c;
  out.y = DECK_TOP_Y + ly;
  return out;
}

/** Furniture and props, shelter-local. Sizes are full extents in metres. */
export const FURNITURE = {
  table: { x: -1.2, z: -0.55, sx: 1.25, sz: 0.72, heightM: 0.78, yawRad: 0.04 },
  cot: { x: 0.95, z: 0.98, sx: 1.95, sz: 0.74, heightM: 0.44, yawRad: -0.03 },
  crate: { x: -1.42, z: 1.12, sx: 0.86, sy: 0.5, sz: 0.52, yawRad: 0.06 },
  ammoBox: { x: -0.55, z: 1.4, sx: 0.3, sy: 0.19, sz: 0.16, yawRad: 0.3 },
  jerryCan: { x: 1.98, z: -1.3, sx: 0.17, sy: 0.47, sz: 0.35, yawRad: 0.5 },
  backpack: { x: -0.2, z: 1.5, yawRad: 0.1 },
  stool: { x: -1.25, z: -1.25, radiusM: 0.2, heightM: 0.42 },
  lantern: { x: 0.25, y: 2.18, z: -1.05 },
  firePit: { x: 0.9, z: -4.2, radiusM: 0.55 },
  dryingRack: { x: -3.9, z: -1.2, widthM: 1.7, heightM: 1.75, yawRad: 0.35 },
  firewood: { x: 3.3, z: 0.9, sx: 0.9, sy: 0.55, sz: 1.2, yawRad: 0.1 },
  bucket: { x: 2.1, z: -3.6 },
  sideHides: [
    { z: -1.0, widthM: 0.8, lengthM: 1.25 },
    { z: 0.05, widthM: 0.95, lengthM: 1.45 },
    { z: 1.0, widthM: 0.7, lengthM: 1.1 },
  ],
} as const;

/** Wooden dock running out into the lagoon (second reference image). World frame. */
export const DOCK = {
  x: 9,
  z: 1.5,
  yawRad: 0.12,
  lengthM: 17,
  halfWidthM: 0.95,
  deckY: 0.62,
  pileSpacingM: 2.4,
} as const;

/** Driftwood log with tin cans lined up for target practice. */
export const CAN_LOG = { x: 1.5, z: 5.2, yawRad: 0.35, lengthM: 2.4, radiusM: 0.17, canCount: 4 } as const;
