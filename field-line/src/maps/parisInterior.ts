import { LOCAL_LIGHTS } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import { BUILDING } from '../paris/config.ts';
import { openingOf, storeysOf } from '../paris/city/facade.ts';
import type { Lot } from '../paris/city/plan.ts';
import type { MapBuilder, Opening } from './builder.ts';
import type { BoxLook } from './types.ts';

// Real rooms behind a Paris front (paris/city/facade.ts): the shop on the ground floor, the
// entresol above it and the étage noble with its continuous balcony over the boulevard. The
// floors above stay solid. Every opening of the inner wall sits exactly behind the façade's
// own (openingOf), so the windows one sees from the street are the ones one shoots through
// from inside; the façade skips its painted glass on such a lot and the map's glass stands in.
//
// The rooms are open plan, as a shop and a flat's front rooms are; a U-shaped stair runs up
// along one party wall: the ground floor's 4.4 m in one flight of 26 risers away from the
// street, the entresol's 3.0 m in a second flight back toward it, landing on the étage noble.
// The noble's French windows open onto the balcony (Paris balconies: 0.62 m deep, on corbels).

/** How deep the rooms run behind the front (m). */
export const ROOM_DEPTH_M = 12;
const WALL_M = 0.3;
/** The inner face of the front wall: behind the façade's deepest reveal (0.24 m). */
const FRONT_IN_M = 0.25;
const SLAB_M = 0.2;
/** A flight's width: Haussmann main stairs run 1.3–1.5 m. */
export const STAIR_W = 1.4;
const STAIR_START_M = 2.0;
/** The thin wall between the two flights (the stair's spine) and round the second one. */
const STAIR_WALL_M = 0.12;

/** Where the stair runs in a lot: the two lanes' centre u and the flights' ends (d). */
export function stairLayout(lot: Lot): { laneA: number; laneB: number; start: number; aEnd: number; bEnd: number } {
  const [ground, entresol] = storeysOf(lot);
  const runOf = (rise: number): number => Math.round(rise / 0.17) * 0.28;
  const laneA = lot.widthM - WALL_M - STAIR_W / 2;
  const aEnd = STAIR_START_M + runOf(ground?.h ?? 0);
  return { laneA, laneB: laneA - STAIR_W, start: STAIR_START_M, aEnd, bEnd: aEnd - runOf(entresol?.h ?? 0) };
}

/**
 * Builds the rooms of `lot` into `b`. Lot coordinates: u along the front from its start, d in from
 * the façade; the lot is in the Paris frame, `shiftZ` takes it to the map's.
 */
export function parisInterior(b: MapBuilder, lot: Lot, shiftZ: number): void {
  if (lot.tx !== 0 && lot.tz !== 0) throw new Error('parisInterior: the lot must be axis aligned');
  const W = lot.widthM;
  const D = ROOM_DEPTH_M;
  const bay = W / lot.bays;
  const X = (u: number, d: number): number => lot.ox + lot.tx * u - lot.nx * d;
  const Z = (u: number, d: number): number => lot.oz + lot.tz * u - lot.nz * d + shiftZ;
  const uAlongZ = lot.tz !== 0;
  /** A box over u0…u1 × d0…d1 from `y0`, `h` high. */
  const box = (look: BoxLook, u0: number, u1: number, d0: number, d1: number, y0: number, h: number, extra: { blocksVision?: boolean; surface?: 'rock' | 'sheetMetal'; interior?: boolean } = {}): void => {
    const lu = Math.abs(u1 - u0);
    const ld = Math.abs(d1 - d0);
    if (lu < 0.01 || ld < 0.01 || h < 0.01) return;
    const cu = (u0 + u1) / 2;
    const cd = (d0 + d1) / 2;
    b.boxOnBase(look, X(cu, cd), y0, Z(cu, cd), uAlongZ ? ld : lu, h, uAlongZ ? lu : ld, 0, { interior: true, ...extra });
  };
  /** A wall along u at depth d (a centre line), from u0 to u1. */
  const wallU = (look: BoxLook, d: number, u0: number, u1: number, y0: number, h: number, openings: Opening[]): void => {
    b.wall(look, X(u0, d), Z(u0, d), X(u1, d), Z(u1, d), y0, h, WALL_M, openings, true);
  };
  /** A wall along d at u, from d0 to d1. */
  const wallD = (look: BoxLook, u: number, d0: number, d1: number, y0: number, h: number): void => {
    b.wall(look, X(u, d0), Z(u, d0), X(u, d1), Z(u, d1), y0, h, WALL_M, [], true);
  };

  const storeys = storeysOf(lot);
  const [ground, entresol, noble, above] = storeys;
  if (!ground || !entresol || !noble || !above) throw new Error('parisInterior: a lot has at least five storeys');
  const entrance = Math.floor(lot.bays / 2);
  const ceilingY = above.y0;
  const frontD = FRONT_IN_M + WALL_M / 2;

  // --- The front's inner wall, storey by storey, with the façade's openings.
  for (const st of [ground, entresol, noble]) {
    const op = openingOf(st.kind, bay);
    const openings: Opening[] = [];
    for (let i = 0; i < lot.bays; i++) {
      const cu = (i + 0.5) * bay;
      const start = cu - op.w / 2;
      if (st.kind === 'ground') {
        // The shop door is open; the other bays are shop windows on a low stall riser.
        if (i === entrance) openings.push({ startM: start, widthM: op.w, bottomM: 0, topM: op.h - 0.6, glass: false });
        else openings.push({ startM: start, widthM: op.w, bottomM: 0.45, topM: op.h - 0.6, glass: true });
      } else {
        // The entresol's low windows are glazed; the noble's French windows stand open onto the balcony.
        openings.push({ startM: start, widthM: op.w, bottomM: op.sill, topM: op.sill + op.h, glass: st.kind === 'entresol' });
      }
    }
    // u runs one way or the other along the world axis; the wall's openings count from its start.
    wallU('paint', frontD, 0, W, st.y0, st.h, openings);
  }
  // Party walls and the back wall, the full height of the three storeys.
  wallD('paint', WALL_M / 2, FRONT_IN_M + WALL_M, D - WALL_M, 0, ceilingY);
  wallD('paint', W - WALL_M / 2, FRONT_IN_M + WALL_M, D - WALL_M, 0, ceilingY);
  wallU('paint', D - WALL_M / 2, 0, W, 0, ceilingY, []);

  // --- Floors: tiles in the shop, parquet upstairs; slabs with the stair holes; the ceiling.
  const u0 = WALL_M;
  const u1 = W - WALL_M;
  const d0 = FRONT_IN_M + WALL_M;
  const d1 = D - WALL_M;
  box('tiles', u0, u1, d0, d1, 0, ground.y0 + 0.01);
  const { laneA, laneB, aEnd, bEnd } = stairLayout(lot);
  // A slab is its floor finish over a painted ceiling below (one look per box, so two boxes).
  const FINISH_M = 0.03;
  const piece = (look: BoxLook, ua: number, ub: number, da: number, db: number, y: number): void => {
    box('paint', ua, ub, da, db, y - SLAB_M, SLAB_M - FINISH_M);
    box(look, ua, ub, da, db, y - FINISH_M, FINISH_M);
  };
  const slab = (y: number, hole: { ua: number; ub: number; da: number; db: number } | null, look: BoxLook): void => {
    if (!hole) {
      piece(look, u0, u1, d0, d1, y);
      return;
    }
    piece(look, u0, hole.ua, d0, d1, y);
    piece(look, hole.ub, u1, d0, d1, y);
    piece(look, hole.ua, hole.ub, d0, hole.da, y);
    piece(look, hole.ua, hole.ub, hole.db, d1, y);
  };
  const holeA = { ua: laneA - STAIR_W / 2, ub: laneA + STAIR_W / 2, da: STAIR_START_M - 0.1, db: aEnd + 0.05 };
  const holeB = { ua: laneB - STAIR_W / 2, ub: laneB + STAIR_W / 2, da: bEnd - 0.05, db: aEnd + 0.1 };
  slab(entresol.y0, holeA, 'woodFloor');
  slab(noble.y0, holeB, 'woodFloor');
  slab(ceilingY, null, 'paint');
  // The stairwell is closed, as a Haussmann stair is: a spine wall between the flights from the
  // shop floor to a rail's height above the noble floor, and a wall round the second flight on
  // the room side. Open sides would be ledges, and the navigation mesh (game/navMesh.ts) drops
  // a stair whose side falls away: walls let the AI use it, and nobody falls into the well.
  const spineU = laneA - STAIR_W / 2;
  box('paint', spineU - STAIR_WALL_M / 2, spineU + STAIR_WALL_M / 2, STAIR_START_M, aEnd, 0, noble.y0 + 1.0);
  const outerU = laneB - STAIR_W / 2;
  box('paint', outerU - STAIR_WALL_M, outerU, bEnd, aEnd, entresol.y0 - SLAB_M, noble.y0 + 1.0 - (entresol.y0 - SLAB_M));
  // Rails at the holes' open ends: before the first flight's foot upstairs, behind the second's top.
  const rail = (ua: number, ub: number, da: number, db: number, y: number): void => box('metalDark', ua, ub, da, db, y, 0.95, { blocksVision: false });
  rail(holeA.ua, holeA.ub, holeA.da - 0.05, holeA.da, entresol.y0);
  rail(holeB.ua, holeB.ub, holeB.db, holeB.db + 0.05, noble.y0);

  // --- The stair: up and away from the street, then back toward it.
  const inX = -lot.nx;
  const inZ = -lot.nz;
  b.stairFlight(X(laneA, STAIR_START_M), Z(laneA, STAIR_START_M), ground.y0, ground.h, inX, inZ, 'concrete');
  b.stairFlight(X(laneB, aEnd), Z(laneB, aEnd), entresol.y0, entresol.h, -inX, -inZ, 'concrete');

  // --- Above the étage noble the building is solid (no one goes there; it stops shots and sight).
  const top = storeys[storeys.length - 1];
  const roofY = (top ? top.y0 + top.h : ceilingY + 10) + BUILDING.mansardRiseM;
  box('invisible', 0, W, 0, D, ceilingY, roofY - ceilingY, { surface: 'rock', interior: false });

  // --- The balcony along the étage noble: its floor on the corbels, the railing at its edge.
  box('invisible', 0, W, -BUILDING.balconyDepthM, 0, noble.y0 - 0.22, 0.22, { surface: 'rock', interior: false });
  box('invisible', 0, W, -BUILDING.balconyDepthM, -BUILDING.balconyDepthM + 0.06, noble.y0, 1.0, { surface: 'sheetMetal', blocksVision: false, interior: false });
  for (const ue of [0, W]) box('invisible', ue - 0.03, ue + 0.03, -BUILDING.balconyDepthM, 0, noble.y0, 1.0, { surface: 'sheetMetal', blocksVision: false, interior: false });

  // --- Light: two bulbs per storey under the ceiling, and the volume the renderer treats as indoors.
  for (const st of [ground, entresol, noble]) {
    const y = st.y0 + st.h - SLAB_M - 0.2;
    for (const f of [0.3, 0.7]) b.bulb(X(W * f, D * 0.5), y, Z(W * f, D * 0.5), LOCAL_LIGHTS.interiorBulbCd);
  }
  const ax = X(u0, d0);
  const az = Z(u0, d0);
  const bx = X(u1, d1);
  const bz = Z(u1, d1);
  // A Paris front is half glass (the shopfront ~55 % of the ground storey, French windows ~40 %
  // above), twice the glazing the default fraction is tuned for, though on one wall only: a stop more.
  b.interiors.push({ min: new Vec3(Math.min(ax, bx), 0, Math.min(az, bz)), max: new Vec3(Math.max(ax, bx), ceilingY - SLAB_M, Math.max(az, bz)), skyFraction: 0.12 });

  // --- A little furniture: a counter across the shop, stock in crates behind it and upstairs.
  const prop = (u: number, d: number, y: number, yaw: number, scale = 1): void => void b.prop('crate', X(u, d), Z(u, d), yaw, { baseY: y, scale });
  box('wood', u0 + 1.0, laneB - STAIR_W, D - 3.2, D - 2.6, ground.y0, 1.0);
  prop(u0 + 0.9, D - 1.2, ground.y0, 0.2);
  prop(u0 + 2.0, D - 1.0, ground.y0, 1.1, 1.2);
  prop(u0 + 1.2, D - 1.6, entresol.y0, 0.6);
  prop(u0 + 1.0, 3.0, noble.y0, 0.3, 0.8);
}
