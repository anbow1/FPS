import { Vec3 } from '../core/vec.ts';
import { BUILDING, STREET } from '../paris/config.ts';
import { buildPlan, inCrossing, type Lot, type StreetPlan } from '../paris/city/plan.ts';
import { crossRoadHalf } from '../paris/city/street.ts';
import { MapBuilder } from './builder.ts';
import { parisInterior, ROOM_DEPTH_M } from './parisInterior.ts';
import { makeHeightfield } from './terrain.ts';
import type { MapData, Pickup } from './types.ts';

// The Paris boulevard (paris/src/city/plan.ts) as a Field Line map: the same plan, seed and
// façades the Paris scene renders, here with colliders, cover and a fight on it. The playable
// square takes the stretch round the first two cross streets; the boulevard runs on past the
// map's edge for 500 m as a view (it is rendered, not walkable), the way the real street would.
//
// Paris works in its own frame (camera at z = 0 looking down −z); the map shifts it by
// PARIS_SHIFT_Z so the playable square is centred on the origin, as every map here is.
// The façades are faces only, so the blocks behind them are solid colliders (a box per house
// along the boulevard, one for the rest of the block), except for three houses with real rooms
// behind their fronts (parisInterior.ts). The open ends (the cross streets' far ends, the
// boulevard's near end) are closed by extra lots that face back into the street: from inside
// the map every way out is a building.

/** Paris z + this = map z. */
export const PARIS_SHIFT_Z = 120;
const HALF_M = 180;
/** How far the cross streets run from the boulevard's façades (paris/src/city/plan.ts CROSS_STREET_M). */
const CROSS_REACH_M = 110;
/** A block's collider height: the cornice (~20 m) and the mansard above it. */
const BLOCK_HEIGHT_M = 26;
/** The strip behind the boulevard's fronts that is built house by house (deeper than a house's rooms). */
const FRONT_STRIP_M = 14;
const SEED = 1859;

/** The plan with the closing lots added (render/parisStreet.ts draws the same list). */
export function boulevardPlan(): StreetPlan {
  const plan = buildPlan(SEED);
  plan.lots.push(...closingLots());
  // Three houses with rooms behind their fronts (parisInterior.ts), spread down the playable
  // stretch on alternating sides: one by the first crossing, two between the crossings.
  for (const [side, z] of ENTERABLE_AT) {
    const lot = plan.lots.find((l) => l.boulevard && l.side === side && z > l.zMin && z < l.zMax && l.widthM >= 13);
    if (!lot) throw new Error(`boulevard: no lot at side ${side}, z ${z} for a house with rooms`);
    lot.enterable = true;
    // A shop or café front (the bank's stone and grilles have no door to go in by).
    if (lot.ground === 'bank' || lot.ground === 'door') lot.ground = 'shop';
  }
  return plan;
}

/** Paris-frame (side, z) points whose lots get rooms. */
const ENTERABLE_AT: readonly [-1 | 1, number][] = [
  [-1, -30],
  [1, -110],
  [-1, -175],
];

/** Lots that close the cross streets' far ends and the boulevard's near end, facing into the street. */
function closingLots(): Lot[] {
  const F = STREET.facadeHalfM;
  const lots: Lot[] = [];
  const lot = (frame: Pick<Lot, 'side' | 'ox' | 'oz' | 'tx' | 'tz' | 'nx' | 'nz' | 'widthM'>, i: number): Lot => ({
    ...frame,
    boulevard: false,
    zMin: frame.oz,
    zMax: frame.oz,
    bays: Math.max(3, Math.round(frame.widthM / BUILDING.bayM)),
    upperStoreys: 4,
    ground: i % 3 === 0 ? 'cafe' : 'shop',
    stoneTone: (i * 0.37) % 1,
    paint: i % 6,
    cornerStart: false,
    cornerEnd: false,
  });
  let i = 0;
  for (const c of STREET.crossings) {
    if (!inPlay(c.zM)) continue;
    for (const side of [-1, 1] as const) {
      // Across the cross street at x = ±(F + reach), its front facing back toward the boulevard.
      const x = side * (F + CROSS_REACH_M);
      const z0 = c.zM - c.widthM / 2;
      // u runs along the front: for side +1 the front faces −x, so u runs toward −z… keep the
      // tangent so that (t × up) points out of the building: n = (−side, 0).
      lots.push(lot({ side, ox: x, oz: side > 0 ? z0 + c.widthM : z0, tx: 0, tz: side > 0 ? -1 : 1, nx: -side, nz: 0, widthM: c.widthM }, i++));
    }
  }
  // The boulevard's near end: one front across it, facing down the boulevard (−z).
  lots.push(lot({ side: 1, ox: -F, oz: STREET.nearZM, tx: 1, tz: 0, nx: 0, nz: -1, widthM: 2 * F }, i++));
  return lots;
}

/** Is a Paris-frame z inside the playable square? */
function inPlay(parisZ: number): boolean {
  return Math.abs(parisZ + PARIS_SHIFT_Z) < HALF_M;
}

export function buildBoulevard(): MapData {
  const plan = boulevardPlan();
  const terrain = makeHeightfield(HALF_M + 10, 4, () => 0, () => 'asphalt');
  const b = new MapBuilder(terrain, 1859);
  const kerb = STREET.kerbM;
  const F = STREET.facadeHalfM;
  const C = STREET.carriageHalfM;
  const zMap = (parisZ: number): number => parisZ + PARIS_SHIFT_Z;
  const zEdgeFar = -HALF_M; // map z where the play stops down the boulevard
  const crossings = STREET.crossings.filter((c) => inPlay(c.zM));

  // --- Blocks: solid between the boulevard, the cross streets and the closing lots.
  // Map-z spans of the street fronts between crossings (from the near end down to the map's edge).
  const fronts: [number, number][] = [];
  let top = zMap(STREET.nearZM);
  for (const c of crossings) {
    fronts.push([zMap(c.zM + c.widthM / 2), top]);
    top = zMap(c.zM - c.widthM / 2);
  }
  fronts.push([zEdgeFar - 20, top]);
  // Each block: a strip of FRONT_STRIP_M behind the boulevard's fronts, one box per house (a
  // house with rooms has them instead), and one box for the rest of the block behind.
  for (const side of [-1, 1] as const) {
    for (const [z0, z1] of fronts) {
      const depth = CROSS_REACH_M + 12 - FRONT_STRIP_M;
      b.boxOnBase('invisible', side * (F + FRONT_STRIP_M + depth / 2), 0, (z0 + z1) / 2, depth, BLOCK_HEIGHT_M, z1 - z0, 0, { surface: 'rock' });
    }
    for (const lot of plan.lots) {
      if (!lot.boulevard || lot.side !== side) continue;
      const za = zMap(lot.zMin);
      const zb = zMap(lot.zMax);
      if (zb < zEdgeFar - 20 || za > HALF_M + 10) continue;
      if (lot.enterable) {
        parisInterior(b, lot, PARIS_SHIFT_Z);
        // Behind its rooms, up to the block's box.
        b.boxOnBase('invisible', side * (F + (ROOM_DEPTH_M + FRONT_STRIP_M) / 2), 0, (za + zb) / 2, FRONT_STRIP_M - ROOM_DEPTH_M, BLOCK_HEIGHT_M, zb - za, 0, { surface: 'rock' });
        continue;
      }
      b.boxOnBase('invisible', side * (F + FRONT_STRIP_M / 2), 0, (za + zb) / 2, FRONT_STRIP_M, BLOCK_HEIGHT_M, zb - za, 0, { surface: 'rock' });
    }
    // Behind each cross street's closing lot.
    for (const c of crossings) b.boxOnBase('invisible', side * (F + CROSS_REACH_M + 6), 0, zMap(c.zM), 12, BLOCK_HEIGHT_M, c.widthM + 2, 0, { surface: 'rock' });
  }
  // Behind the near end's closing front, and the map's far edge across the boulevard (the view goes on).
  b.boxOnBase('invisible', 0, 0, zMap(STREET.nearZM) + 6, 2 * F + 4, BLOCK_HEIGHT_M, 12, 0, { surface: 'rock' });
  b.boxOnBase('invisible', 0, 0, zEdgeFar - 1, 2 * F + 4, 60, 2, 0, { surface: 'rock', blocksVision: false });

  // --- Pavements a kerb higher (rendered by the Paris street; colliders only).
  const gaps = crossings.map((c) => ({ z0: zMap(c.zM - crossRoadHalf(c.widthM)), z1: zMap(c.zM + crossRoadHalf(c.widthM)), c }));
  for (const side of [-1, 1] as const) {
    let zTop = zMap(STREET.nearZM);
    const segs: [number, number][] = [];
    for (const g of gaps) {
      segs.push([g.z1, zTop]);
      zTop = g.z0;
    }
    segs.push([zEdgeFar - 2, zTop]);
    for (const [z0, z1] of segs) b.boxOnBase('invisible', side * (C + F) / 2, 0, (z0 + z1) / 2, F - C, kerb, z1 - z0, 0, { surface: 'concrete', blocksVision: false });
    for (const g of gaps) {
      const cz = zMap(g.c.zM);
      const half = g.c.widthM / 2;
      for (const e of [-1, 1] as const) {
        const zIn = cz + e * crossRoadHalf(g.c.widthM);
        const zOut = cz + e * half;
        b.boxOnBase('invisible', side * (F + CROSS_REACH_M / 2), 0, (zIn + zOut) / 2, CROSS_REACH_M, kerb, Math.abs(zOut - zIn), 0, { surface: 'concrete', blocksVision: false });
      }
    }
  }

  // --- The plan's street furniture, where it stands in the map.
  const at = (p: { x: number; z: number }): { x: number; z: number } | null => {
    const z = zMap(p.z);
    return Math.abs(z) < HALF_M - 2 ? { x: p.x, z } : null;
  };
  for (const t of plan.trees) {
    const q = at(t);
    if (q) b.prop('streetTree', q.x, q.z, (t.seed % 628) / 100, { baseY: kerb, scale: 1.15 });
  }
  for (const l of plan.lamps) {
    const q = at(l);
    if (q) b.prop('lampPost', q.x, q.z, l.x < 0 ? Math.PI / 2 : -Math.PI / 2, { baseY: kerb });
  }
  for (const k of plan.kiosks) {
    const q = at(k);
    if (q) b.prop('kiosk', q.x, q.z, k.x < 0 ? Math.PI / 2 : -Math.PI / 2, { baseY: kerb });
  }
  for (const be of plan.benches) {
    const q = at(be);
    if (q) b.prop('bench', q.x, q.z, be.x < 0 ? Math.PI / 2 : -Math.PI / 2, { baseY: kerb });
  }
  for (const p of plan.parked) {
    const q = at(p);
    if (q) b.prop('car', q.x, q.z, p.x < 0 ? 0 : Math.PI, { colourIndex: p.seed % 251 });
  }
  // Café terraces: tables in two rows before the café, between the façade and the trees.
  for (const cafe of plan.cafes) {
    for (let z = cafe.zMin + 1.2; z < cafe.zMax - 1; z += 2.6) {
      const q = at({ x: cafe.side * (F - 1.6), z });
      if (q) b.prop('cafeSet', q.x, q.z, (z * 7) % 3, { baseY: kerb });
    }
  }

  // --- The fight: a checkpoint across the boulevard, wrecks and barricades for cover.
  const block = (x: number, z: number, yaw: number): void => void b.prop('roadBarrier', x, z, yaw);
  const zCheck = zMap(STREET.crossings[0].zM) - 22;
  for (const x of [-6.5, -3.2, 3.2, 6.5]) block(x, zCheck, 0);
  b.boxOnBase('sandbag', -1.4, 0, zCheck - 3, 3.6, 0.9, 1.0);
  b.boxOnBase('sandbag', 4.6, 0, zCheck + 2.5, 3.2, 0.9, 1.0, 0.2);
  b.prop('carWreck', -4.5, zMap(-150), 0.5, { colourIndex: 17 });
  b.prop('carWreck', 3.8, zMap(-175), -0.4, { colourIndex: 88 });
  b.prop('carWreck', 1.5, zMap(-260), 1.2, { colourIndex: 140 });
  b.prop('container', -3, zMap(-120), 0.15);
  b.prop('barrier', 0, zMap(-30), Math.PI / 2 + 0.2);
  b.prop('barrier', -5, zMap(-205), 0.3);
  for (const c of crossings) {
    // Barricades half across each cross street, 20 m in from the boulevard.
    for (const side of [-1, 1] as const) {
      const x = side * (F + 20);
      b.prop('barrier', x, zMap(c.zM) - 2.5, Math.PI / 2);
      b.prop('carWreck', side * (F + 48), zMap(c.zM) + 1.5, side * 1.3, { colourIndex: 33 + side });
    }
  }

  const pickups: Pickup[] = [
    { kind: 'medKit', pos: new Vec3(-12, kerb, zMap(-20)) },
    { kind: 'ammoPack', pos: new Vec3(12, kerb, zMap(-110)) },
    { kind: 'grenade', pos: new Vec3(-60, kerb, zMap(STREET.crossings[0].zM) + 6) },
    { kind: 'medKit', pos: new Vec3(70, kerb, zMap(STREET.crossings[1].zM) - 5) },
    { kind: 'ammoPack', pos: new Vec3(-2, 0, zMap(-250)) },
  ];
  const patrol = (...pts: [number, number][]): Vec3[] => pts.map(([x, z]) => new Vec3(x, 0, zMap(z)));
  const c0 = STREET.crossings[0].zM;
  const c1 = STREET.crossings[1].zM;
  return {
    id: 'boulevard',
    label: 'Boulevard',
    halfSizeM: HALF_M,
    terrain,
    boxes: b.boxes,
    props: b.props,
    trees: [],
    bushes: [],
    roads: [],
    paint: b.paint,
    track: [],
    playerSpawn: { pos: new Vec3(4, 0, zMap(STREET.nearZM - 12)), yawRad: 0 },
    squadSpawns: [
      { pos: new Vec3(0, 0, zMap(c0 - 40)), patrol: patrol([-6, c0 - 32], [6, c0 - 32], [6, c0 - 66], [-6, c0 - 66]) },
      { pos: new Vec3(70, 0, zMap(c0)), patrol: patrol([30, c0], [110, c0]) },
      { pos: new Vec3(-70, 0, zMap(c1)), patrol: patrol([-110, c1], [-25, c1], [-5, c1 + 30]) },
      { pos: new Vec3(0, 0, zMap(c1 - 30)), patrol: patrol([-5, c1 - 12], [5, c1 - 36], [-5, c1 - 56]) },
    ],
    reinforcementSpawns: [new Vec3(0, 0, zEdgeFar + 8), new Vec3(115, 0, zMap(c1)), new Vec3(-115, 0, zMap(c0))],
    interiors: b.interiors,
    bulbs: b.bulbs,
    pickups,
    extraction: { hold: new Vec3(0, 0, zMap(c1)), exit: new Vec3(0, 0, zEdgeFar + 4) },
    rangeTargets: [],
    groundSurface: 'asphalt',
    wetDefault: false,
  };
}

/** Is a map point on the boulevard's or a cross street's carriageway (for render and AI)? */
export function onBoulevardRoad(x: number, z: number): boolean {
  const pz = z - PARIS_SHIFT_Z;
  if (Math.abs(x) < STREET.carriageHalfM) return true;
  const c = inCrossing(pz);
  return c !== null && Math.abs(pz - c.zM) < crossRoadHalf(c.widthM);
}
