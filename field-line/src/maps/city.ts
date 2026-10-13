import type { SurfaceKind } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import { CITY_SCALE, MapBuilder } from './builder.ts';
import { enterableBuilding } from './buildings.ts';
import { makeHeightfield } from './terrain.ts';
import type { BoxLook, MapData, Pickup } from './types.ts';

// City block, 400 × 400 m (brief). A street grid with 14 m roads (two 3.5 m
// lanes each way), pavement slabs whose edges are the 0.15 m kerbs, a central
// block with four enterable buildings round a courtyard, a ring of solid
// façade blocks with alleys, lots and a park, and a wall of tall buildings at
// the map edge. Sightlines run 30–150 m along the streets and across the lots.

const HALF_M = 200;
const ROAD_WIDTH_M = 4 * CITY_SCALE.laneM; // 14 m
const INNER_ROAD_M = 60; // road centre lines at ±60 and ±150
const OUTER_ROAD_M = 150;
const ROAD_CENTRES = [-OUTER_ROAD_M, -INNER_ROAD_M, INNER_ROAD_M, OUTER_ROAD_M];
const EDGE_M = 190;
/** The road grid as the render needs it (render/cityRoad.ts): positive centre lines (mirrored), width, end. */
export const CITY_ROADS = { centresM: [INNER_ROAD_M, OUTER_ROAD_M] as const, widthM: ROAD_WIDTH_M, edgeM: EDGE_M } as const;
/** Wall above the top storey's windows, covered by the cornice and parapet. */
export const PARAPET_ZONE_M = 1.0; // roads run to here; tall buildings close the map beyond

function onRoad(x: number, z: number): boolean {
  const h = ROAD_WIDTH_M / 2;
  if (Math.abs(x) > EDGE_M + 5 || Math.abs(z) > EDGE_M + 5) return false;
  return ROAD_CENTRES.some((c) => Math.abs(x - c) < h || Math.abs(z - c) < h);
}

export function buildCity(): MapData {
  const surfaceAt = (x: number, z: number): SurfaceKind => (onRoad(x, z) ? 'asphalt' : 'concrete');
  const terrain = makeHeightfield(HALF_M + 10, 4, () => 0, surfaceAt);
  const b = new MapBuilder(terrain, 4101);
  const kerb = CITY_SCALE.kerbM;
  const roadH = ROAD_WIDTH_M / 2;

  // Pavement slabs between the roads: 3 × 3 blocks inside the outer ring,
  // plus the edge strips. Their raised edges are the kerbs.
  const bands: [number, number][] = [
    [-EDGE_M - 10, -OUTER_ROAD_M - roadH],
    [-OUTER_ROAD_M + roadH, -INNER_ROAD_M - roadH],
    [-INNER_ROAD_M + roadH, INNER_ROAD_M - roadH],
    [INNER_ROAD_M + roadH, OUTER_ROAD_M - roadH],
    [OUTER_ROAD_M + roadH, EDGE_M + 10],
  ];
  for (const [xa, xb] of bands) {
    for (const [za, zb] of bands) b.boxOnBase('pavement', (xa + xb) / 2, 0, (za + zb) / 2, xb - xa, kerb, zb - za);
  }

  // --- Central block: four enterable buildings round a courtyard.
  const specs: { cx: number; cz: number; w: number; d: number; storeys: number; q: 0 | 1 | 2 | 3; look: BoxLook }[] = [
    { cx: -30, cz: -42, w: 22, d: 14, storeys: 3, q: 2, look: 'brick' },
    { cx: 30, cz: -42, w: 22, d: 14, storeys: 4, q: 2, look: 'plaster' },
    { cx: -30, cz: 42, w: 22, d: 14, storeys: 4, q: 0, look: 'brickDark' },
    { cx: 30, cz: 42, w: 22, d: 14, storeys: 5, q: 0, look: 'brick' },
  ];
  for (const s of specs) {
    enterableBuilding(b, { cx: s.cx, cz: s.cz, widthM: s.w, depthM: s.d, storeys: s.storeys, quarterTurns: s.q, baseY: kerb, wallLook: s.look, floorLook: s.storeys % 2 === 0 ? 'woodFloor' : 'tiles' });
  }
  // Courtyard cover: low walls, containers, a wreck, barriers, sandbags.
  b.boxOnBase('concrete', -12, kerb, 0, 8, 1.0, 0.4);
  b.boxOnBase('concrete', 14, kerb, -8, 0.4, 1.0, 7);
  b.boxOnBase('sandbag', 0, kerb, 14, 4.0, 0.9, 1.0);
  b.boxOnBase('sandbag', 2, kerb, -16, 3.2, 0.9, 1.0);
  b.prop('container', 22, 12, 0.2, { baseY: kerb });
  b.prop('container', -24, -12, 1.4, { baseY: kerb });
  b.prop('carWreck', 4, 2, 0.9, { baseY: kerb, colourIndex: 2 });
  b.prop('barrier', -4, 24, 0.0, { baseY: kerb });
  b.prop('barrier', 10, 24, 0.3, { baseY: kerb });
  for (const [x, z] of [[-40, 0], [40, 2], [0, -30], [0, 30]] as const) b.prop('streetTree', x, z, 0, { baseY: kerb, scale: 1.1 });
  for (const [x, z] of [[-18, 20], [18, -22]] as const) b.prop('bench', x, z, 0.5, { baseY: kerb });

  // --- Ring blocks: façade buildings with alleys; one parking lot, one park.
  const ring: [number, number][] = [];
  for (const cx of [-105, 0, 105]) for (const cz of [-105, 0, 105]) if (cx !== 0 || cz !== 0) ring.push([cx, cz]);
  for (const [cx, cz] of ring) {
    if (cx === 0 && cz === 105) cityPark(b, cx, cz);
    else if (cx === 105 && cz === 0) parkingLot(b, cx, cz);
    else facadeBlock(b, cx, cz);
  }

  // --- Map edge: tall façades behind the outer road, road ends barricaded.
  for (const side of [-1, 1]) {
    for (let a = -180; a <= 180; a += 30) {
      const h = fitStoreys(24 + (Math.abs(a * 7 + side * 13) % 5) * 5, 3.2);
      const along = a;
      if (ROAD_CENTRES.some((c) => Math.abs(along - c) < roadH + 1)) {
        b.prop('container', along, side * 178, Math.PI / 2, { baseY: 0 });
        b.prop('container', side * 178, along, 0, { baseY: 0 });
        continue;
      }
      b.boxOnBase('brickDark', along, kerb, side * 180, 26, h, 16, 0, { facade: { storeyM: 3.2, bayM: 3.6, seed: a + side } });
      b.boxOnBase('concrete', side * 180, kerb, along, 16, h + 3.2, 26, 0, { facade: { storeyM: 3.2, bayM: 3.6, seed: a * 3 + side } });
    }
  }
  for (const [x, z, sx, sz] of [[0, -198, 400, 1], [0, 198, 400, 1], [-198, 0, 1, 400], [198, 0, 1, 400]] as const) {
    b.boxOnBase('invisible', x, 0, z, sx, 60, sz);
  }

  streetDressing(b);

  const pickups: Pickup[] = [
    { kind: 'medKit', pos: new Vec3(-30, kerb + 0.05, -40) },
    { kind: 'ammoPack', pos: new Vec3(30, kerb + 0.05, 40) },
    { kind: 'medKit', pos: new Vec3(33, kerb + 3.05, -40) },
    { kind: 'ammoPack', pos: new Vec3(-8, kerb, 1) },
    { kind: 'grenade', pos: new Vec3(24, kerb, 16) },
    { kind: 'medKit', pos: new Vec3(105, kerb, 8) },
  ];

  const patrol = (...pts: [number, number][]): Vec3[] => pts.map(([x, z]) => new Vec3(x, 0, z));
  return {
    id: 'city',
    label: 'City block',
    halfSizeM: HALF_M,
    terrain,
    boxes: b.boxes,
    props: b.props,
    trees: [],
    bushes: [],
    roads: roadSegments(),
    track: [],
    playerSpawn: { pos: new Vec3(0, kerb, 125), yawRad: 0 },
    squadSpawns: [
      { pos: new Vec3(0, 0, -8), patrol: patrol([-15, -20], [15, -20], [15, 20], [-15, 20]) },
      { pos: new Vec3(0, 0, -100), patrol: patrol([-100, -60], [100, -60], [100, -100], [-100, -100]) },
      { pos: new Vec3(60, 0, 20), patrol: patrol([60, -120], [60, 120]) },
      { pos: new Vec3(-60, 0, -30), patrol: patrol([-60, 110], [-60, -110], [-150, -110]) },
    ],
    reinforcementSpawns: [new Vec3(150, 0, -150), new Vec3(-150, 0, -150), new Vec3(150, 0, 150), new Vec3(-150, 0, 150)],
    interiors: b.interiors,
    bulbs: b.bulbs,
    pickups,
    extraction: { hold: new Vec3(0, kerb, 0), exit: new Vec3(INNER_ROAD_M, 0, -175) },
    rangeTargets: [],
    groundSurface: 'asphalt',
    wetDefault: false,
  };
}

/**
 * A façade block's height: whole storeys plus the parapet zone the cornice covers (render/facadeTrim.ts),
 * so the top storey's windows are never cut by the roof line.
 */
export function fitStoreys(heightM: number, storeyM: number): number {
  return Math.max(2, Math.round(heightM / storeyM)) * storeyM + PARAPET_ZONE_M;
}

function roadSegments(): MapData['roads'] {
  const out: MapData['roads'] = [];
  for (const c of ROAD_CENTRES) {
    out.push({ a: new Vec3(c, 0, -EDGE_M), b: new Vec3(c, 0, EDGE_M), widthM: ROAD_WIDTH_M });
    out.push({ a: new Vec3(-EDGE_M, 0, c), b: new Vec3(EDGE_M, 0, c), widthM: ROAD_WIDTH_M });
  }
  return out;
}

/** A 76 × 76 m block of solid façade buildings split by a cross of alleys. */
function facadeBlock(b: MapBuilder, cx: number, cz: number): void {
  const kerb = CITY_SCALE.kerbM;
  const alley = 7;
  const inner = 76 / 2;
  const quad = (inner * 2 - alley) / 2; // one building footprint side
  let n = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = cx + sx * (alley / 2 + quad / 2);
      const z = cz + sz * (alley / 2 + quad / 2);
      const seed = Math.abs(cx * 31 + cz * 17 + n * 7);
      const storeyM = seed % 2 === 0 ? 3.0 : 3.4;
      const h = fitStoreys(12 + (seed % 6) * 3.2, storeyM);
      const look: BoxLook = seed % 3 === 0 ? 'concrete' : seed % 3 === 1 ? 'brick' : 'plaster';
      // Set back 3 m from the kerb for the pavement.
      b.boxOnBase(look, x, kerb, z, quad - 6, h, quad - 6, 0, { facade: { storeyM, bayM: 3.2, seed } });
      n++;
    }
  }
  // Alley clutter: bins and a crate stack give cover in the cross alleys.
  b.prop('trashBin', cx + 1.5, cz + 12, 0);
  b.prop('trashBin', cx - 1.8, cz - 15, 0.3);
  b.prop('crate', cx + 12, cz - 1.5, 0.2);
  b.prop('crate', cx - 16, cz + 1.2, 1.1, { scale: 1.2 });
}

function parkingLot(b: MapBuilder, cx: number, cz: number): void {
  const kerb = CITY_SCALE.kerbM;
  // Rows of parked cars, 0.8 m door gap (scale sheet), with two containers and a hut.
  for (let row = -2; row <= 2; row++) {
    for (let i = -6; i <= 6; i++) {
      if ((i * 5 + row * 3 + 40) % 7 === 0) continue; // empty bays
      b.prop('car', cx + i * 2.6, cz + row * 12, row % 2 === 0 ? 0 : Math.PI, { baseY: kerb, colourIndex: (i + row + 20) % 6 });
    }
  }
  b.prop('container', cx - 26, cz - 30, 0.1, { baseY: kerb });
  b.prop('container', cx + 28, cz + 28, 1.6, { baseY: kerb });
  b.boxOnBase('metalDark', cx + 30, kerb, cz - 30, 4, 2.8, 3);
}

function cityPark(b: MapBuilder, cx: number, cz: number): void {
  const kerb = CITY_SCALE.kerbM;
  for (let i = 0; i < 18; i++) {
    const a = i * 2.4;
    const r = 12 + (i % 4) * 6;
    b.prop('streetTree', cx + Math.cos(a) * r, cz + Math.sin(a) * r, a, { baseY: kerb, scale: 0.9 + (i % 3) * 0.15 });
  }
  for (const [x, z, yaw] of [[-8, -6, 0], [8, 6, Math.PI], [-6, 10, 1.2], [6, -12, 2.2]] as const) b.prop('bench', cx + x, cz + z, yaw, { baseY: kerb });
  b.boxOnBase('stone', cx, kerb, cz, 5, 0.6, 5); // dry fountain basin
}

/** Parked cars, wrecks, lamp posts and barriers along the road grid. */
function streetDressing(b: MapBuilder): void {
  const kerb = CITY_SCALE.kerbM;
  const roadH = ROAD_WIDTH_M / 2;
  let k = 0;
  for (const c of ROAD_CENTRES) {
    for (let a = -175; a <= 175; a += 5.0) {
      k++;
      if (ROAD_CENTRES.some((cc) => Math.abs(a - cc) < roadH + 6)) continue; // junctions stay clear
      const hash = (k * 2654435761) >>> 0;
      // Parked along the kerb (1.1 m from it), both sides, road along Z then along X.
      if (hash % 5 < 2) b.prop('car', c - roadH + 1.1, a, 0, { colourIndex: hash % 6 });
      if (hash % 7 < 2) b.prop('car', c + roadH - 1.1, a + 2, Math.PI, { colourIndex: (hash >> 3) % 6 });
      if ((hash >> 5) % 5 < 2) b.prop('car', a, c - roadH + 1.1, Math.PI / 2, { colourIndex: (hash >> 7) % 6 });
      if ((hash >> 9) % 7 < 2) b.prop('car', a + 2, c + roadH - 1.1, -Math.PI / 2, { colourIndex: (hash >> 11) % 6 });
      if (k % 5 === 0) {
        b.prop('lampPost', c - roadH - 0.8, a, Math.PI / 2, { baseY: kerb });
        b.prop('lampPost', a, c + roadH + 0.8, 0, { baseY: kerb });
      }
      // Wrecks and barriers mid-road: cover in the open.
      if (hash % 37 === 3) b.prop('carWreck', c + 1.5, a, 0.4 + (hash % 10) * 0.2, { colourIndex: hash % 6 });
      if (hash % 41 === 5) b.prop('barrier', a, c, Math.PI / 2 + 0.2);
    }
  }
}
