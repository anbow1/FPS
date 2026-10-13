import type { SurfaceKind } from '../config.ts';
import { fbm2, noise2, ridged2 } from '../core/noise.ts';
import { Vec3 } from '../core/vec.ts';
import type { Heightfield } from '../game/collision.ts';
import { MapBuilder } from './builder.ts';
import { distanceToSegmentXZ, makeHeightfield, sampleHeight } from './terrain.ts';
import { carveLake, type Lake, lakeLevelFor, lakeRadius } from './lake.ts';
import type { MapData, TreeInstance } from './types.ts';

// Pine forest ridge, 800 × 800 m (brief). A ridge runs east–west north of the
// centre with a saddle the dirt track climbs through; meadows and a ruined farm
// open sightlines of 100–700 m across the valley and from the crest, so the
// sniper rifle earns its place. The heightfield gets a thermal-erosion pass so
// slopes settle at a believable talus angle instead of raw noise.

const HALF_M = 400;
/** Width of the rim hills that close the map (render/ground.ts keeps them under forest, not rock). */
export const RIM_M = 100;
const CELL_M = 2;
const RIDGE_Z_M = -120;
const SADDLE_X_M = 60;
const FARM = new Vec3(-110, 0, 160);

const TRACK: readonly Vec3[] = [
  new Vec3(0, 0, 395),
  new Vec3(-30, 0, 290),
  new Vec3(-85, 0, 205),
  new Vec3(-95, 0, 150),
  new Vec3(-50, 0, 60),
  new Vec3(20, 0, -30),
  new Vec3(SADDLE_X_M, 0, RIDGE_Z_M),
  new Vec3(45, 0, -215),
  new Vec3(0, 0, -300),
  new Vec3(-10, 0, -395),
];

function trackDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < TRACK.length - 1; i++) {
    const a = TRACK[i] as Vec3;
    const c = TRACK[i + 1] as Vec3;
    best = Math.min(best, distanceToSegmentXZ(x, z, a.x, a.z, c.x, c.z));
  }
  return best;
}

function baseHeight(x: number, z: number): number {
  const rolling = fbm2(x / 180, z / 180, 5, 11) * 9;
  // Ridge profile across Z: gentle south face, steeper north face.
  const dz = z - (RIDGE_Z_M + noise2(x / 220, 3.1, 5) * 30);
  const across = dz > 0 ? Math.exp(-((dz / 110) ** 2)) : Math.exp(-((dz / 60) ** 2));
  const crest = 26 + ridged2(x / 140, 0.37, 4, 23) * 22;
  const saddle = 1 - 0.55 * Math.exp(-(((x - SADDLE_X_M) / 70) ** 2));
  let h = rolling + across * crest * saddle;
  // Rim hills close the map edge: forested slopes rising over the last 100 m (steeper, they came out as
  // bare rock domes on the skyline).
  const edge = Math.max(Math.abs(x), Math.abs(z)) - (HALF_M - RIM_M);
  if (edge > 0) h += (edge / RIM_M) ** 2 * 28;
  // The track is cut into the slope: pull it toward a smoothed grade.
  const td = trackDistance(x, z);
  if (td < 12) {
    const smooth = fbm2(x / 400, z / 400, 2, 11) * 9 + across * crest * saddle * 0.92;
    const k = 1 - td / 12;
    // At most 0.8 m of cut or fill: a worn forest track sits a little below the ground, not in a trench.
    h += Math.max(-0.8, Math.min(0.8, (smooth - h) * 0.8)) * k * k;
  }
  // Farm meadow is levelled.
  const fd = Math.hypot(x - FARM.x, z - FARM.z);
  if (fd < 45) {
    const flat = fbm2(FARM.x / 180, FARM.z / 180, 5, 11) * 9;
    const k = 1 - fd / 45;
    h += (flat - h) * Math.min(1, k * 1.6);
  }
  return h;
}

/** Thermal erosion: move material downhill wherever the slope beats the talus angle. */
function erode(t: Heightfield, iterations: number): void {
  const n = t.samplesX;
  const h = t.heightsM;
  const talus = Math.tan((34 * Math.PI) / 180) * t.cellM; // loose rock and soil
  for (let it = 0; it < iterations; it++) {
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const i = iz * n + ix;
        const hi = h[i] as number;
        for (const j of [i + 1, i - 1, i + n, i - n]) {
          const d = hi - (h[j] as number);
          if (d > talus) {
            const move = (d - talus) * 0.25;
            h[i] = (h[i] as number) - move;
            h[j] = (h[j] as number) + move;
          }
        }
      }
    }
  }
}

// A shallow lake in the south-east meadows, between the spawn and the eastern
// patrol route: wadeable (at most 1.3 m deep), clear of the track and the farm.
const LAKE_SHAPE = { cx: 190, cz: 240, rx: 72, rz: 48, depthM: 1.3 } as const;
let lakeCache: Lake | null = null;

function lake(): Lake {
  lakeCache ??= { ...LAKE_SHAPE, levelM: lakeLevelFor(LAKE_SHAPE.cx, LAKE_SHAPE.cz, LAKE_SHAPE.rx, LAKE_SHAPE.rz, baseHeight) };
  return lakeCache;
}

function rawHeight(x: number, z: number): number {
  return carveLake(lake(), x, z, baseHeight(x, z));
}

export function buildForest(): MapData {
  let terrainRef: Heightfield | null = null;
  const surfaceAt = (x: number, z: number): SurfaceKind => {
    if (!terrainRef) return 'soil';
    const e = CELL_M;
    const slope = Math.hypot(sampleHeight(terrainRef, x + e, z) - sampleHeight(terrainRef, x - e, z), sampleHeight(terrainRef, x, z + e) - sampleHeight(terrainRef, x, z - e)) / (2 * e);
    if (lakeRadius(lake(), x, z) < 1.15) return 'soil'; // pebbly shore and lake bed
    return slope > 0.75 ? 'rock' : 'soil';
  };
  const terrain = makeHeightfield(HALF_M + 10, CELL_M, rawHeight, surfaceAt);
  erode(terrain, 6);
  terrainRef = terrain;
  const b = new MapBuilder(terrain, 7307);
  const rng = b.rng;

  ruinedFarm(b);

  // Rock outcrops along the crest and on steep ground.
  const rocks: Vec3[] = [];
  for (let i = 0; i < 70; i++) {
    const x = rng.range(-360, 360);
    const z = RIDGE_Z_M + rng.gauss() * 35;
    if (trackDistance(x, z) < 8 || lakeRadius(lake(), x, z) < 1.25) continue;
    const cluster = rng.int(1, 4);
    for (let j = 0; j < cluster; j++) {
      const rx = x + rng.range(-6, 6);
      const rz = z + rng.range(-6, 6);
      b.prop('rock', rx, rz, rng.range(0, Math.PI * 2), { scale: rng.range(1.0, 2.8), baseY: b.ground(rx, rz) - 0.4 });
      rocks.push(new Vec3(rx, 0, rz));
    }
  }
  for (let i = 0; i < 90; i++) {
    const x = rng.range(-370, 370);
    const z = rng.range(-370, 370);
    if (surfaceAt(x, z) !== 'rock' || trackDistance(x, z) < 8 || lakeRadius(lake(), x, z) < 1.25) continue;
    b.prop('rock', x, z, rng.range(0, 6.3), { scale: rng.range(0.8, 2.0), baseY: b.ground(x, z) - 0.3 });
    rocks.push(new Vec3(x, 0, z));
  }

  // Pines on a jittered grid, thinned by a density field: stands, meadows, a
  // sparse crest, clear along the track and round the farm.
  const trees: TreeInstance[] = [];
  const bushes: TreeInstance[] = [];
  const spacingM = 6.5;
  for (let gz = -HALF_M + 8; gz < HALF_M - 8; gz += spacingM) {
    for (let gx = -HALF_M + 8; gx < HALF_M - 8; gx += spacingM) {
      const x = gx + rng.range(-2.6, 2.6);
      const z = gz + rng.range(-2.6, 2.6);
      const stand = fbm2(x / 130, z / 130, 3, 91) + 0.12;
      const crestK = Math.exp(-(((z - RIDGE_Z_M) / 25) ** 2));
      let p = stand > 0.02 ? 0.85 : stand > -0.12 ? 0.2 : 0;
      p *= 1 - crestK * 0.75;
      if (trackDistance(x, z) < 6 || Math.hypot(x - FARM.x, z - FARM.z) < 42) p = 0;
      // Open water and a pebbly shore: no trees, and no bushes below the bank.
      const lakeR = lakeRadius(lake(), x, z);
      if (lakeR < 1.4) p = 0;
      if (surfaceAt(x, z) === 'rock') p *= 0.3;
      // The rim hills are forest to the skyline.
      if (Math.max(Math.abs(x), Math.abs(z)) > HALF_M - RIM_M + 20) p = Math.max(p, 0.8);
      if (rng.next() >= p) {
        if (stand > -0.2 && rng.next() < 0.18 && trackDistance(x, z) > 4 && lakeR > 1.3) bushes.push(plant(b, x, z, rng.range(0.7, 1.4), rng.next()));
        continue;
      }
      if (rocks.some((r) => Math.abs(r.x - x) < 3 && Math.abs(r.z - z) < 3)) continue;
      const tree = plant(b, x, z, rng.range(14, 27), rng.next());
      trees.push(tree);
      // Trunk collider to 6 m: stops rounds and blocks sight; the canopy above does not matter for play.
      b.boxOnBase('invisible', x, tree.pos.y - 0.3, z, 0.45, 6.3, 0.45, tree.yawRad, { surface: 'wood' });
      if (rng.next() < 0.25) bushes.push(plant(b, x + rng.range(-2.5, 2.5), z + rng.range(-2.5, 2.5), rng.range(0.6, 1.2), rng.next()));
    }
  }
  // Undergrowth conceals: it blocks AI vision rays but not movement or much of a bullet's energy.
  for (const bush of bushes) {
    const s = bush.heightM;
    b.boxOnBase('invisible', bush.pos.x, bush.pos.y, bush.pos.z, 1.5 * s, 1.0 * s, 1.5 * s, bush.yawRad, { surface: 'foliage', blocksMovement: false, blocksVision: true });
  }

  for (const [x, z, sx, sz] of [[0, -398, 800, 1], [0, 398, 800, 1], [-398, 0, 1, 800], [398, 0, 1, 800]] as const) {
    b.boxOnBase('invisible', x, -20, z, sx, 200, sz);
  }

  const at = (x: number, z: number): Vec3 => new Vec3(x, b.ground(x, z), z);
  const patrol = (...pts: [number, number][]): Vec3[] => pts.map(([x, z]) => at(x, z));
  return {
    id: 'forest',
    label: 'Forest ridge',
    halfSizeM: HALF_M,
    terrain,
    boxes: b.boxes,
    props: b.props,
    trees,
    bushes,
    roads: [],
    track: TRACK.map((p) => at(p.x, p.z)),
    playerSpawn: { pos: at(4, 330), yawRad: 0 },
    squadSpawns: [
      { pos: at(SADDLE_X_M - 10, RIDGE_Z_M + 10), patrol: patrol([SADDLE_X_M - 80, RIDGE_Z_M], [SADDLE_X_M + 90, RIDGE_Z_M + 5]) },
      { pos: at(FARM.x + 12, FARM.z - 20), patrol: patrol([FARM.x + 30, FARM.z], [FARM.x - 20, FARM.z + 30], [FARM.x - 30, FARM.z - 30]) },
      { pos: at(200, 40), patrol: patrol([200, 120], [150, -40], [260, -20]) },
      { pos: at(-220, -200), patrol: patrol([-120, -220], [-260, -120]) },
    ],
    reinforcementSpawns: [at(-40, -330), at(250, -250), at(-280, -260)],
    interiors: b.interiors,
    bulbs: b.bulbs,
    pickups: [
      { kind: 'medKit', pos: at(FARM.x + 2, FARM.z + 1) },
      { kind: 'ammoPack', pos: at(FARM.x - 3, FARM.z - 2) },
      { kind: 'grenade', pos: at(SADDLE_X_M + 6, RIDGE_Z_M + 20) },
      { kind: 'medKit', pos: at(20, -28) },
    ],
    extraction: { hold: at(SADDLE_X_M, RIDGE_Z_M), exit: at(-8, -370) },
    rangeTargets: [],
    groundSurface: 'soil',
    wetDefault: false,
    undergrowth: { bounds: [-HALF_M + 12, -HALF_M + 12, HALF_M - 12, HALF_M - 12], mown: [], ferns: true },
    lake: lake(),
  };
}

function plant(b: MapBuilder, x: number, z: number, heightM: number, r: number): TreeInstance {
  return { pos: new Vec3(x, b.ground(x, z), z), heightM, yawRad: r * Math.PI * 2, seed: Math.floor(r * 1e6) };
}

/** Stone farmhouse with no roof, walls broken to uneven heights, a paddock wall and hay. */
function ruinedFarm(b: MapBuilder): void {
  const cx = FARM.x;
  const cz = FARM.z;
  const y = b.ground(cx, cz) - 0.2;
  const rng = b.rng;
  const W = 12;
  const D = 9;
  const t = 0.5;
  const ruin = (x0: number, z0: number, x1: number, z1: number, gaps: [number, number][]): void => {
    const alongX = Math.abs(z1 - z0) < 1e-6;
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const sign = alongX ? Math.sign(x1 - x0) : Math.sign(z1 - z0);
    for (let s = 0; s < len - 0.01; s += 1.5) {
      const e = Math.min(len, s + 1.5);
      const mid = (s + e) / 2;
      if (gaps.some(([g0, g1]) => mid > g0 && mid < g1)) continue;
      const h = rng.next() < 0.15 ? 0.6 : rng.range(1.2, 4.2);
      const px = alongX ? x0 + sign * mid : x0;
      const pz = alongX ? z0 : z0 + sign * mid;
      b.boxOnBase('stone', px, y, pz, alongX ? e - s : t, h + 0.2, alongX ? t : e - s, 0, { interior: false });
    }
  };
  ruin(cx - W / 2, cz + D / 2, cx + W / 2, cz + D / 2, [[4.5, 6.0]]); // door gap
  ruin(cx - W / 2, cz - D / 2, cx + W / 2, cz - D / 2, [[2.0, 3.5], [8.5, 10]]);
  ruin(cx - W / 2, cz - D / 2, cx - W / 2, cz + D / 2, [[3.5, 5.0]]);
  ruin(cx + W / 2, cz - D / 2, cx + W / 2, cz + D / 2, []);
  // Interior wall stub, fallen roof beams, a crate stack.
  b.boxOnBase('stone', cx + 1, y, cz - 1, t, 2.2, 4);
  b.prop('beam', cx - 2, cz + 1, 0.4, { baseY: y + 0.2 });
  b.prop('beam', cx + 3, cz - 2, 1.9, { baseY: y + 0.2, scale: 0.8 });
  b.prop('crate', cx - 4, cz - 2.5, 0.3, { baseY: y + 0.2 });
  // Paddock: a knee-to-waist dry-stone wall east of the house.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    if (i === 4 || i === 12) continue; // gates
    const px = cx + 22 + Math.cos(a) * 14;
    const pz = cz + Math.sin(a) * 11;
    b.boxOnBase('stone', px, b.ground(px, pz) - 0.2, pz, 5.2, 1.15, 0.6, -a + Math.PI / 2);
  }
  for (const [dx, dz, yaw] of [[18, 3, 0.2], [20, 5, 1.4], [26, -4, 0.8], [-14, 10, 0.1]] as const) {
    b.prop('hayBale', cx + dx, cz + dz, yaw);
  }
}
