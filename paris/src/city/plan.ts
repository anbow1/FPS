import { BUILDING, STREET } from '../config.ts';
import { Rng } from '../core/rng.ts';

// The boulevard's layout, as data both the renderer and the people use: the
// lots along each side between the cross streets, the plane trees and lamps
// on the pavements, the shops and cafés on the ground floors, and the
// furniture. Pure logic, deterministic from one seed.
//
// Frame: the boulevard runs along z (the camera looks down −z), x across it,
// y up; ground at y = 0 on the carriageway, the pavements a kerb higher.
// Side −1 is the left (x < 0), +1 the right.

export type Side = -1 | 1;
export type GroundUse = 'shop' | 'cafe' | 'bank' | 'door';

export interface Lot {
  /** The boulevard side it stands on (cross-street lots: the side of the boulevard they run off). */
  side: Side;
  /** Where the front starts (u = 0) on the ground, the direction along it and its outward normal (toward the street), in xz. */
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  /** Length of the front. */
  widthM: number;
  /** On the boulevard (false: a cross street). */
  boulevard: boolean;
  /** Extent along the boulevard (boulevard lots only; zMin < zMax). */
  zMin: number;
  zMax: number;
  /** Whole bays across the front. */
  bays: number;
  /** Storeys above the entresol up to the cornice: the étage noble, the 3rd (and 4th), the 5th (3 or 4). */
  upperStoreys: number;
  ground: GroundUse;
  /** Stone tint (a hash: newer cleaned stone vs older, greyer), 0…1. */
  stoneTone: number;
  /** The shop's painted colour index, and the awning's. */
  paint: number;
  /** Its ends (u = 0, u = width) that meet a corner, where the neighbour's front turns away: no party wall shows there. */
  cornerStart: boolean;
  cornerEnd: boolean;
}

export interface Placed {
  x: number;
  z: number;
  /** Seed for its own variation. */
  seed: number;
}

export interface CafeTerrace {
  side: Side;
  zMin: number;
  zMax: number;
}

export interface StreetPlan {
  lots: Lot[];
  trees: Placed[];
  lamps: Placed[];
  cafes: CafeTerrace[];
  /** Advertising columns and newspaper kiosks on the pavements. */
  columns: Placed[];
  kiosks: Placed[];
  benches: Placed[];
  /** Parked cars in the parking lanes: x, z, a variant seed. */
  parked: Placed[];
}

/** Is `z` within a cross street (with `marginM` of its corners)? */
export function inCrossing(z: number, marginM = 0): { zM: number; widthM: number } | null {
  for (const c of STREET.crossings) if (Math.abs(z - c.zM) < c.widthM / 2 + marginM) return c;
  return null;
}

/** The pavement's top height at `x` (0 on the carriageway). */
export function groundY(x: number, z: number): number {
  const ax = Math.abs(x);
  if (ax < STREET.carriageHalfM) return 0;
  // The cross streets' carriageways run through at road level between their own kerbs.
  const c = inCrossing(z);
  if (c && Math.abs(z - c.zM) < c.widthM / 2 - 3.2) return 0;
  return STREET.kerbM;
}

export function buildPlan(seed: number): StreetPlan {
  const rng = new Rng(seed);
  const lots: Lot[] = [];
  const cafes: CafeTerrace[] = [];
  // Street fronts: the stretches between cross streets, both sides.
  const edges = [STREET.nearZM, ...STREET.crossings.flatMap((c) => [c.zM + c.widthM / 2, c.zM - c.widthM / 2]), STREET.farZM];
  for (const side of [-1, 1] as const) {
    for (let k = 0; k + 1 < edges.length; k += 2) {
      const zMax = edges[k] as number;
      const zMin = edges[k + 1] as number;
      // Lots fill from zMax (u = width on the boulevard's +z axis) toward zMin (u = 0).
      fillFront(rng, zMax - zMin, k > 0 ? 'end' : null, k + 2 < edges.length ? 'start' : null, lots, (u0, w) => ({ side, ox: side * STREET.facadeHalfM, oz: zMax - u0 - w, tx: 0, tz: 1, nx: -side, nz: 0, widthM: w, boulevard: true, zMin: zMax - u0 - w, zMax: zMax - u0 }));
    }
  }
  // The cross streets' fronts, from the boulevard's corners outward, both sides of each.
  for (const c of STREET.crossings) {
    for (const side of [-1, 1] as const) {
      for (const e of [-1, 1] as const) {
        const z = c.zM + (e * c.widthM) / 2;
        fillFront(rng, CROSS_STREET_M, side > 0 ? 'start' : 'end', null, lots, (u0, w) => ({ side, ox: side * (STREET.facadeHalfM + u0 + (side > 0 ? 0 : w)), oz: z, tx: 1, tz: 0, nx: 0, nz: -e, widthM: w, boulevard: false, zMin: z, zMax: z }));
      }
    }
  }
  // A café on most stretches near the camera, a terrace before it.
  for (const lot of lots) {
    if (lot.ground === 'cafe' && lot.boulevard) cafes.push({ side: lot.side, zMin: lot.zMin + 0.6, zMax: lot.zMax - 0.6 });
  }

  const trees: Placed[] = [];
  const lamps: Placed[] = [];
  for (const side of [-1, 1] as const) {
    let n = 0;
    for (let z = STREET.nearZM - 4; z > STREET.farZM + 4; z -= STREET.treeSpacingM) {
      if (inCrossing(z, 3)) continue;
      trees.push({ x: side * STREET.treeXM, z: z + side * 1.5, seed: rng.int(1 << 30) });
      if (n++ % STREET.lampEveryTrees === 1) lamps.push({ x: side * STREET.lampXM, z: z + side * 1.5 + STREET.treeSpacingM / 2, seed: rng.int(1 << 30) });
    }
  }
  // Lamps at every corner, where the crossing needs light.
  for (const c of STREET.crossings) for (const side of [-1, 1] as const) for (const e of [-1, 1]) lamps.push({ x: side * STREET.lampXM, z: c.zM + e * (c.widthM / 2 + 1.2), seed: rng.int(1 << 30) });

  // One advertising column and one kiosk per stretch, on alternating sides, clear of the trees.
  const columns: Placed[] = [];
  const kiosks: Placed[] = [];
  const benches: Placed[] = [];
  STREET.crossings.forEach((c, i) => {
    const side: Side = i % 2 === 0 ? 1 : -1;
    columns.push({ x: side * 11.2, z: c.zM + c.widthM / 2 + 7.5, seed: i });
    kiosks.push({ x: -side * 11.4, z: c.zM + c.widthM / 2 + 22, seed: i });
  });
  for (const t of trees) if (rng.next() < 0.18 && !inCrossing(t.z, 6)) benches.push({ x: t.x - Math.sign(t.x) * 0.2, z: t.z - 4.5, seed: t.seed });

  // Parking lanes: cars nose to tail with gaps, none within 10 m of a crossing.
  const parked: Placed[] = [];
  for (const side of [-1, 1] as const) {
    let z = STREET.nearZM;
    // Beyond ~450 m a parked car is a few pixels in the haze; the moving traffic fills the view there.
    while (z > -450) {
      z -= 4.6 + rng.range(0.6, 2.4);
      // A delivery bay on the right kerb where the camera passes, so the view is over the kerb, not a car roof.
      const bay = side > 0 && z > -10 && z < 18;
      if (inCrossing(z, 10) || bay || rng.next() < 0.12) continue;
      parked.push({ x: side * STREET.parkingXM, z, seed: rng.int(1 << 30) });
    }
  }
  return { lots, trees, lamps, cafes, columns, kiosks, benches, parked };
}

/** How far the cross streets' fronts run from the boulevard (the haze and the turn hide the rest). */
const CROSS_STREET_M = 110;

type LotFrame = Pick<Lot, 'side' | 'ox' | 'oz' | 'tx' | 'tz' | 'nx' | 'nz' | 'widthM' | 'boulevard' | 'zMin' | 'zMax'>;

/**
 * Lots along one front of `lengthM`, from its start: whole bays, the last lot taking what is left. `frame`
 * places a lot from its start along the front and its width; `firstCorner` / `lastCorner` name which end
 * (in the lot's own u) of the first and last lot meets a corner.
 */
function fillFront(rng: Rng, lengthM: number, firstCorner: 'start' | 'end' | null, lastCorner: 'start' | 'end' | null, out: Lot[], frame: (u0: number, widthM: number) => LotFrame): void {
  let u = 0;
  while (lengthM - u > 0.5) {
    const left = lengthM - u;
    let bays = Math.max(4, Math.min(8, Math.round(rng.range(BUILDING.lotMinM, BUILDING.lotMaxM) / BUILDING.bayM)));
    let width = bays * BUILDING.bayM;
    // Never leave a sliver: the last lot takes what is left (its bays stretched to fit).
    if (left - width < BUILDING.lotMinM) {
      width = left;
      bays = Math.max(3, Math.round(width / BUILDING.bayM));
    }
    const first = u === 0;
    const last = u + width >= lengthM - 0.5;
    const r = rng.next();
    const ground: GroundUse = r < 0.2 ? 'cafe' : r < 0.3 ? 'bank' : r < 0.42 ? 'door' : 'shop';
    out.push({
      ...frame(u, width),
      bays,
      upperStoreys: rng.next() < 0.78 ? 4 : 3,
      ground,
      stoneTone: rng.next(),
      paint: rng.int(6),
      cornerStart: (first && firstCorner === 'start') || (last && lastCorner === 'start'),
      cornerEnd: (first && firstCorner === 'end') || (last && lastCorner === 'end'),
    });
    u += width;
  }
}

/** The cornice height of a lot (top of the 5th floor). */
export function corniceY(lot: Lot): number {
  const B = BUILDING;
  return STREET.kerbM + B.groundStoreyM + B.entresolM + B.nobleM + B.upperM * (lot.upperStoreys - 2) + B.fifthM;
}
