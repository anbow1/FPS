import { time, vec2 } from 'three/tsl';
import { type BufferGeometry, Color, CylinderGeometry, Group, type Material, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { GrassField } from './grassField.ts';
import { InstanceStream } from './instanceStream.ts';
import { fbm2 } from '../core/noise.ts';
import { Rng } from '../core/rng.ts';
import { sampleHeight } from '../maps/terrain.ts';
import { lakeRadius } from '../maps/lake.ts';
import type { MapData } from '../maps/types.ts';
import { addSway, swayingMaterial, windVector } from './foliage.ts';
import { splatWeights } from './ground.ts';
import type { MaterialLibrary } from './materials.ts';
import { card, foldedStrip, merge, rand, tube } from './meshkit.ts';

// Render-only ground cover, the forest's equivalent of the lagoon's jungle
// floor: a field of real grass blades wherever the ground is grass
// (grassField.ts; sedge in the lake margin), bracken in clumps under and
// between the pines, reeds at the waterline. It has no effect on play
// (concealment is the map's bushes), so it can be dense near the player and
// simply end further out: one streamed mesh per plant (instanceStream.ts)
// holds the plants around the camera, and within the last stretch they sink
// into the ground so they never pop out of view.

const CELL_M = 16;
const FIELD_CELL_M = 4;

type Quality = 'high' | 'low';

interface Kind {
  /** Plants per m² at full weight (High); Low draws a fraction. */
  densityPerM2: number;
  /** Sink from → to (m), and how deep (m). */
  fade: Record<Quality, [number, number]>;
  sinkM: number;
  scale: [number, number];
}

const FERN: Kind = { densityPerM2: 0.06, fade: { high: [60, 80], low: [30, 42] }, sinkM: 1.4, scale: [0.7, 1.4] };
const LOW_DENSITY = 0.3;

/** Forest-floor litter: cones and twigs close round the player, fallen branches a little further. */
const CONE: Kind = { densityPerM2: 0.5, fade: { high: [16, 22], low: [9, 12] }, sinkM: 0.1, scale: [0.8, 1.25] };
const TWIG: Kind = { densityPerM2: 0.25, fade: { high: [16, 22], low: [9, 12] }, sinkM: 0.1, scale: [0.7, 1.4] };
const BRANCH: Kind = { densityPerM2: 0.012, fade: { high: [40, 55], low: [24, 32] }, sinkM: 0.3, scale: [0.8, 1.3] };

/** A pine cone lying on its side: an ovoid of overlapping scales (ridged rings), ~8 cm. */
function coneGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const r = 0.012 + Math.sin(Math.PI * (0.15 + t * 0.75)) * 0.02;
    parts.push(new CylinderGeometry(r * 0.6, r, 0.024, 6).rotateZ(Math.PI / 2).translate(-0.036 + t * 0.072, r * 0.9, 0));
  }
  return merge(parts, 'cone');
}

/** A dead twig: a thin crooked stick with a side shoot, lying flat. */
function twigGeometry(seed: number): BufferGeometry {
  const len = 0.35 + rand(seed, 1) * 0.3;
  const bend = (rand(seed, 2) - 0.5) * 0.08;
  const main = tube([new Vector3(-len / 2, 0.008, 0), new Vector3(0, 0.012, bend), new Vector3(len / 2, 0.008, -bend * 0.5)], [0.008, 0.007, 0.004], 5, 1);
  const side = tube([new Vector3(0.02, 0.01, bend), new Vector3(0.1, 0.012, bend + 0.08)], [0.005, 0.003], 4, 1);
  return merge([main, side], 'twig');
}

/** A fallen branch: a crooked bough with two side limbs, ~2 m, resting on the ground. */
function branchGeometry(seed: number): BufferGeometry {
  const L = 1.6 + rand(seed, 1) * 0.8;
  const pts = [0, 0.33, 0.66, 1].map((t, k) => new Vector3(-L / 2 + t * L, 0.04 - t * 0.015, (rand(seed, 10 + k) - 0.5) * 0.18));
  const parts = [tube(pts, [0.05, 0.04, 0.03, 0.015], 7, 1)];
  for (let k = 0; k < 2; k++) {
    const from = pts[1 + k] as Vector3;
    const dir = rand(seed, 20 + k) > 0.5 ? 1 : -1;
    parts.push(tube([from, from.clone().add(new Vector3(0.25, 0.03, dir * 0.3)), from.clone().add(new Vector3(0.45, 0.02, dir * 0.6))], [0.022, 0.014, 0.006], 5, 1));
  }
  return merge(parts, 'branch');
}

const REED: Kind = { densityPerM2: 0, fade: { high: [70, 95], low: [40, 55] }, sinkM: 2.2, scale: [0.8, 1.25] };

/**
 * A clump of reeds: eight reed-bed cards (reedBed texture: stems of uneven height, leaves, plumes) of
 * different heights, fanned round the clump and leaning out a little, ~1.4–2.2 m high. Uneven cards in a
 * fan give the clump a ragged top and a soft edge; five equal cards read as a block of hedge.
 */
function reedGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const h = 1.5 + rand(29, i) * 0.7;
    const g = card(0.9, h);
    g.translate((rand(31, i) - 0.5) * 0.5, 0, (rand(37, i) - 0.5) * 0.5);
    g.rotateX((rand(19, i) - 0.5) * 0.3);
    g.rotateY((i / 8) * Math.PI + rand(23, i) * 0.5);
    parts.push(g);
  }
  const g = merge(parts, 'reeds');
  addSway(g);
  return g;
}

function fernGeometry(fronds: number, lengthM: number, seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rand(seed, f) * 0.5;
    const elev = 1.0 - rand(seed, f + 50) * 0.6;
    const L = lengthM * (0.75 + rand(seed, f + 90) * 0.4);
    const h = new Vector3(Math.cos(a), 0, Math.sin(a));
    const spine: Vector3[] = [];
    const sides: Vector3[] = [];
    const hw: number[] = [];
    const fold: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const s = i / 6;
      spine.push(new Vector3(h.x * L * s * Math.cos(elev), 0.05 + L * s * Math.sin(elev) - L * 0.7 * s * s, h.z * L * s * Math.cos(elev)));
      sides.push(new Vector3(-h.z, 0, h.x));
      hw.push(L * 0.22);
      fold.push(0.25);
    }
    parts.push(foldedStrip(spine, sides, hw, fold, new Vector3(0, 0.1, 0), 0.4));
  }
  const g = merge(parts, 'fern');
  addSway(g);
  return g;
}

interface Placement {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  scale: number;
  tint: number;
}

/** Real grass blades (grassField.ts): blades per 4 m tile and where the field ends, per quality. */
const GRASS_FIELD = { blades: { high: 700, low: 300 }, radiusM: { high: 40, low: 24 } } as const;

export class Undergrowth {
  readonly group = new Group();
  private readonly streams: InstanceStream[] = [];
  /** The blade field over the meadows (null on maps without undergrowth). */
  grass: GrassField | null = null;

  constructor(map: MapData, lib: MaterialLibrary, quality: Quality) {
    this.group.name = 'undergrowth';
    const area = map.undergrowth;
    if (!area) return;
    const [minX, minZ, maxX, maxZ] = area.bounds;
    const field = weightField(map, area.bounds);
    const blocked = obstacleTest(map);
    const mown = (x: number, z: number): boolean => area.mown.some(([a, b, c, d]) => x > a && x < c && z > b && z < d);
    const densityK = quality === 'high' ? 1 : LOW_DENSITY;
    const rng = new Rng(9091);
    // Nothing of this grows in the water or on the lake's pebbly shore (reeds do, below).
    const lake = map.lake;
    const inLake = (x: number, z: number): boolean => lake !== undefined && lakeRadius(lake, x, z) < 1.12;

    const scatter = (kind: Kind, weight: (x: number, z: number, w: readonly number[]) => number): Placement[] => {
      const out: Placement[] = [];
      const candidates = Math.round((maxX - minX) * (maxZ - minZ) * kind.densityPerM2 * densityK);
      for (let i = 0; i < candidates; i++) {
        const x = rng.range(minX, maxX);
        const z = rng.range(minZ, maxZ);
        const k = weight(x, z, field.at(x, z));
        if (k <= 0 || rng.next() > k || mown(x, z) || blocked(x, z) || inLake(x, z)) continue;
        out.push({ x, y: sampleHeight(map.terrain, x, z) - 0.04, z, yawRad: rng.range(0, Math.PI * 2), scale: rng.range(kind.scale[0], kind.scale[1]), tint: fbm2(x / 23, z / 23, 2, 5) });
      }
      return out;
    };
    // Weights: [grass, soil, rock, track]. Grass thins toward the forest floor; none on rock or the track.
    const grassWeight = (w: readonly number[]): number => ((w[0] ?? 0) - (w[3] ?? 0) * 3 - (w[2] ?? 0) * 2) * 1.1 + (w[1] ?? 0) * 0.06;
    this.grass = new GrassField(
      { heights: map.terrain.heightsM, originX: map.terrain.originX, originZ: map.terrain.originZ, cellM: map.terrain.cellM, samplesX: map.terrain.samplesX, samplesZ: map.terrain.samplesZ, split: 'bc' },
      grassDensity(area.bounds, (x, z) => {
        if (blocked(x, z)) return [0, 0, 0, 0];
        const w = field.at(x, z);
        // Mown ground is a lawn of short blades, not bare texture: the field's second kind (the
        // lagoon's beach grass; no Field Line map has a beach) is cut grass here. None on the track.
        if (mown(x, z)) return [0, Math.max(0, Math.min(1, 1 - (w[3] ?? 0) * 3 - (w[2] ?? 0) * 2)), 0, 0];
        // sedge in the damp margin round the lake, none in the water itself
        if (lake) {
          const r = lakeRadius(lake, x, z);
          if (r < 1.02) return [0, 0, 0, 0];
          if (r < 1.3) return [Math.max(0, grassWeight(w)) * 0.4, 0, (1.3 - r) / 0.28, w[1] ?? 0];
        }
        return [Math.max(0, Math.min(1, grassWeight(w))), 0, 0, Math.min(1, (w[1] ?? 0) * 1.4)];
      }),
      {
        tileM: 4,
        // As the ground's baked canopy occlusion (up to 0.45 under the crowns).
        shadeOcclusion: 0.45,
        bladesPerTile: GRASS_FIELD.blades[quality],
        radiusM: GRASS_FIELD.radiusM[quality],
        wind: vec2(windVector.x, windVector.z),
        time,
        colours: { meadow: [0.085, 0.15, 0.035], beach: [0.075, 0.14, 0.04], sedge: [0.06, 0.12, 0.045], dry: [0.36, 0.3, 0.12] },
        // Meadow, lawn (mown, 5–10 cm), sedge.
        kindHeightsM: [
          [0.24, 0.5],
          [0.05, 0.1],
          [0.4, 0.75],
        ],
      },
    );
    this.group.add(this.grass.group);
    const ferns = area.ferns
      ? scatter(FERN, (x, z, w) => {
          // Bracken grows in clumps on the forest floor and along its edge with the meadows.
          const clump = Math.max(0, fbm2(x / 28, z / 28, 3, 61) * 2.2 + 0.1);
          return ((w[1] ?? 0) + (w[0] ?? 0) * 0.35 - (w[2] ?? 0) - (w[3] ?? 0) * 3) * clump;
        })
      : [];

    const fernMat = swayingMaterial(lib.get('fern'), 0.04, [...FERN.fade[quality], FERN.sinkM]);
    // The forest floor's litter: cones and twigs where the needles lie, the odd fallen branch. Up close the
    // floor otherwise reads as bare earth.
    if (area.ferns) {
      const floor = (x: number, z: number, w: readonly number[]): number => ((w[1] ?? 0) * 1.2 + (w[0] ?? 0) * 0.15 - (w[2] ?? 0) - (w[3] ?? 0) * 3) * Math.max(0, fbm2(x / 17, z / 17, 3, 83) * 1.6 + 0.2);
      const lift = (list: Placement[], dy: number): Placement[] => list.map((p) => ({ ...p, y: p.y + 0.04 + dy }));
      const bark = lib.get('bark');
      const brown = (t: number, c: Color): Color => c.setRGB(0.62 + t * 0.2, 0.5 + t * 0.15, 0.42);
      this.add(lift(scatter(CONE, floor), 0), [coneGeometry()], bark, CONE.fade[quality][1], false, brown);
      this.add(lift(scatter(TWIG, floor), 0), [twigGeometry(3), twigGeometry(7), twigGeometry(11)], bark, TWIG.fade[quality][1], false, brown);
      this.add(lift(scatter(BRANCH, floor), 0), [branchGeometry(5), branchGeometry(9)], bark, BRANCH.fade[quality][1], quality === 'high', (t, c) => c.setRGB(0.55 + t * 0.2, 0.5 + t * 0.15, 0.45));
    }
    // No fern shadows: they would double the draw calls in every sun cascade for a few dark patches.
    this.add(ferns, [fernGeometry(9, 1.1, 3)], fernMat, FERN.fade[quality][1], false, (t, c) => c.setScalar(0.85 + t * 0.3));

    // Reeds in clumps along the waterline, from the wet margin into ankle-deep water.
    if (lake) {
      const reeds: Placement[] = [];
      const count = Math.round(lake.rx * lake.rz * 1.1 * densityK);
      for (let i = 0; i < count; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(0.9, 1.06);
        const x = lake.cx + Math.cos(a) * lake.rx * r;
        const z = lake.cz + Math.sin(a) * lake.rz * r;
        const clump = fbm2(x / 9, z / 9, 3, 71) * 2.4 - 0.2;
        const ground = sampleHeight(map.terrain, x, z);
        const depth = lake.levelM - ground;
        if (rng.next() > clump || depth > 0.35 || depth < -0.12) continue;
        reeds.push({ x, y: ground - 0.05, z, yawRad: rng.range(0, Math.PI * 2), scale: rng.range(0.8, 1.25), tint: fbm2(x / 13, z / 13, 2, 73) });
      }
      const reedMat = swayingMaterial(lib.get('reedBed'), 0.05, [...REED.fade[quality], REED.sinkM]);
      this.add(reeds, [reedGeometry()], reedMat, REED.fade[quality][1], quality === 'high', (t, c) => c.setRGB(0.72 + t * 0.12, 0.86 + t * 0.1, 0.62));
    }
  }

  private add(list: readonly Placement[], variants: BufferGeometry[], mat: Material, maxM: number, shadows: boolean, tint: (t: number, c: Color) => Color): void {
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    variants.forEach((geo, v) => {
      const placements = list
        .filter((_, i) => i % variants.length === v)
        .map((p) => ({ matrix: new Matrix4().compose(new Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.yawRad), new Vector3().setScalar(p.scale)), colour: tint(p.tint, new Color()) }));
      if (placements.length === 0) return;
      const stream = new InstanceStream(geo, mat, placements, { cellM: CELL_M, radiusM: maxM, castShadow: shadows });
      this.streams.push(stream);
      this.group.add(stream.mesh);
    });
  }

  /** Refills the plant sets around the camera when it crosses into another cell (the shader has sunk the outer ring by then). */
  update(camera: Vector3, dtS = 0, fovDeg = 60, heightPx = 1080): void {
    for (const s of this.streams) s.update(camera);
    this.grass?.update(camera, dtS, fovDeg, heightPx);
  }
}

/** Splat weights on a coarse grid, so scattering a few hundred thousand candidates stays quick. */
function weightField(map: MapData, bounds: [number, number, number, number]): { at: (x: number, z: number) => readonly number[] } {
  const [minX, minZ, maxX, maxZ] = bounds;
  const nx = Math.ceil((maxX - minX) / FIELD_CELL_M) + 1;
  const nz = Math.ceil((maxZ - minZ) / FIELD_CELL_M) + 1;
  const cells: (readonly number[])[] = [];
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) cells.push(splatWeights(map, minX + ix * FIELD_CELL_M, minZ + iz * FIELD_CELL_M));
  return {
    at: (x, z) => {
      const ix = Math.min(nx - 1, Math.max(0, Math.round((x - minX) / FIELD_CELL_M)));
      const iz = Math.min(nz - 1, Math.max(0, Math.round((z - minZ) / FIELD_CELL_M)));
      return cells[iz * nx + ix] as readonly number[];
    },
  };
}

/** True where a building, wall, rock, vehicle or tree trunk stands: nothing grows through them. */
function obstacleTest(map: MapData): (x: number, z: number) => boolean {
  const BIN_M = 16;
  const bins = new Map<number, { x: number; z: number; hx: number; hz: number; cos: number; sin: number }[]>();
  const add = (x: number, z: number, hx: number, hz: number, yawRad: number): void => {
    const r = Math.hypot(hx, hz);
    const o = { x, z, hx, hz, cos: Math.cos(yawRad), sin: Math.sin(yawRad) };
    for (let bx = Math.floor((x - r) / BIN_M); bx <= Math.floor((x + r) / BIN_M); bx++) {
      for (let bz = Math.floor((z - r) / BIN_M); bz <= Math.floor((z + r) / BIN_M); bz++) {
        const key = bx * 65536 + bz;
        const list = bins.get(key) ?? [];
        list.push(o);
        bins.set(key, list);
      }
    }
  };
  for (const b of map.boxes) {
    // Invisible boxes are colliders: tree trunks (added below from the trees) and foliage volumes.
    if (b.look === 'invisible' && b.surface !== 'wood') continue;
    if (b.size.x > 200 || b.size.z > 200) continue; // map-edge walls
    add(b.center.x, b.center.z, b.size.x / 2 + 0.3, b.size.z / 2 + 0.3, b.yawRad ?? 0);
  }
  for (const p of map.props) {
    if (p.kind === 'rangeSign' || p.kind === 'dummy') continue;
    add(p.pos.x, p.pos.z, 1.2 * p.scale, 1.2 * p.scale, 0);
  }
  return (x, z) => {
    const list = bins.get(Math.floor(x / BIN_M) * 65536 + Math.floor(z / BIN_M));
    if (!list) return false;
    for (const o of list) {
      const dx = x - o.x;
      const dz = z - o.z;
      // Into the box's own frame (yaw about +Y).
      const lx = dx * o.cos - dz * o.sin;
      const lz = dx * o.sin + dz * o.cos;
      if (Math.abs(lx) < o.hx && Math.abs(lz) < o.hz) return true;
    }
    return false;
  };
}

/** Grass density on a 1 m square grid over the undergrowth area: meadow, beach grass, sedge, canopy shade (0..1 each). */
function grassDensity(bounds: [number, number, number, number], at: (x: number, z: number) => [number, number, number, number]) {
  const [minX, minZ, maxX, maxZ] = bounds;
  const cellM = 1;
  const size = Math.ceil(Math.max(maxX - minX, maxZ - minZ) / cellM) + 1;
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = minX + i * cellM;
      const z = minZ + j * cellM;
      const inside = x <= maxX && z <= maxZ;
      const v = inside ? at(x, z) : [0, 0, 0, 0];
      const o = (j * size + i) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = Math.round(Math.max(0, Math.min(1, v[c] ?? 0)) * 255);
    }
  }
  return { data, originX: minX, originZ: minZ, cellM, size };
}
