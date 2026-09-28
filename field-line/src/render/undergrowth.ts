import { Color, type BufferGeometry, Group, InstancedMesh, type Material, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { fbm2 } from '../core/noise.ts';
import { Rng } from '../core/rng.ts';
import { sampleHeight } from '../maps/terrain.ts';
import type { MapData } from '../maps/types.ts';
import { addSway, swayingMaterial } from './foliage.ts';
import { splatWeights } from './ground.ts';
import type { MaterialLibrary } from './materials.ts';
import { card, foldedStrip, merge, rand } from './meshkit.ts';

// Render-only ground cover, the forest's equivalent of the lagoon's jungle
// floor: grass tufts wherever the ground is grass, bracken in clumps under and
// between the pines. It has no effect on play (concealment is the map's
// bushes), so it can be dense near the player and simply end further out:
// each 40 m chunk is dropped beyond its draw distance, and within the last
// stretch the plants sink into the ground so they never pop out of view.

const CHUNK_M = 40;
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

const GRASS: Kind = { densityPerM2: 0.7, fade: { high: [34, 48], low: [18, 26] }, sinkM: 0.8, scale: [0.6, 1.15] };
const FERN: Kind = { densityPerM2: 0.06, fade: { high: [60, 80], low: [30, 42] }, sinkM: 1.4, scale: [0.7, 1.4] };
const LOW_DENSITY = 0.3;

function grassGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) parts.push(card(0.8, 0.6).rotateY((i * Math.PI) / 3 + 0.3));
  const g = merge(parts, 'grass tuft');
  // Blades lit as if they faced up: the tuft reads as a lawn, not as dark vertical cards.
  const n = g.getAttribute('normal');
  const p = g.getAttribute('position');
  const d = new Vector3();
  for (let i = 0; i < n.count; i++) {
    d.set(p.getX(i) * 0.5, 1, p.getZ(i) * 0.5).normalize();
    n.setXYZ(i, d.x, d.y, d.z);
  }
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

export class Undergrowth {
  readonly group = new Group();
  private readonly chunks: { x: number; z: number; maxM: number; mesh: InstancedMesh }[] = [];

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

    const scatter = (kind: Kind, weight: (x: number, z: number, w: readonly number[]) => number): Placement[] => {
      const out: Placement[] = [];
      const candidates = Math.round((maxX - minX) * (maxZ - minZ) * kind.densityPerM2 * densityK);
      for (let i = 0; i < candidates; i++) {
        const x = rng.range(minX, maxX);
        const z = rng.range(minZ, maxZ);
        const k = weight(x, z, field.at(x, z));
        if (k <= 0 || rng.next() > k || mown(x, z) || blocked(x, z)) continue;
        out.push({ x, y: sampleHeight(map.terrain, x, z) - 0.04, z, yawRad: rng.range(0, Math.PI * 2), scale: rng.range(kind.scale[0], kind.scale[1]), tint: fbm2(x / 23, z / 23, 2, 5) });
      }
      return out;
    };
    // Weights: [grass, soil, rock, track]. Grass thins toward the forest floor; none on rock or the track.
    const grass = scatter(GRASS, (_x, _z, w) => ((w[0] ?? 0) - (w[3] ?? 0) * 3 - (w[2] ?? 0) * 2) * 1.1 + (w[1] ?? 0) * 0.06);
    const ferns = area.ferns
      ? scatter(FERN, (x, z, w) => {
          // Bracken grows in clumps on the forest floor and along its edge with the meadows.
          const clump = Math.max(0, fbm2(x / 28, z / 28, 3, 61) * 2.2 + 0.1);
          return ((w[1] ?? 0) + (w[0] ?? 0) * 0.35 - (w[2] ?? 0) - (w[3] ?? 0) * 3) * clump;
        })
      : [];

    const grassMat = swayingMaterial(lib.get('grassTuft'), 0.06, [...GRASS.fade[quality], GRASS.sinkM]);
    const fernMat = swayingMaterial(lib.get('fern'), 0.04, [...FERN.fade[quality], FERN.sinkM]);
    // Straw-yellow and lush patches across the meadows.
    const dry = new Color(1.18, 1.08, 0.72);
    const lush = new Color(0.85, 1.0, 0.85);
    const tint = (t: number, c: Color): Color => c.copy(lush).lerp(dry, Math.min(1, Math.max(0, t * 1.6 + 0.45)));
    this.add(grass, [grassGeometry()], grassMat, GRASS.fade[quality][1], false, tint);
    this.add(ferns, [fernGeometry(8, 1.0, 3), fernGeometry(10, 1.2, 8)], fernMat, FERN.fade[quality][1], quality === 'high', (t, c) => c.setScalar(0.85 + t * 0.3));
  }

  private add(list: readonly Placement[], variants: BufferGeometry[], mat: Material, maxM: number, shadows: boolean, tint: (t: number, c: Color) => Color): void {
    const bins = new Map<string, Placement[]>();
    list.forEach((p, i) => {
      const key = `${Math.floor(p.x / CHUNK_M)},${Math.floor(p.z / CHUNK_M)},${i % variants.length}`;
      const b = bins.get(key) ?? [];
      b.push(p);
      bins.set(key, b);
    });
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const s = new Vector3();
    const pos = new Vector3();
    const c = new Color();
    for (const [key, b] of bins) {
      const [cx, cz, v] = key.split(',').map(Number) as [number, number, number];
      const mesh = new InstancedMesh(variants[v] as BufferGeometry, mat, b.length);
      b.forEach((p, i) => {
        q.setFromAxisAngle(up, p.yawRad);
        m.compose(pos.set(p.x, p.y, p.z), q, s.setScalar(p.scale));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, tint(p.tint, c));
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.chunks.push({ x: (cx + 0.5) * CHUNK_M, z: (cz + 0.5) * CHUNK_M, maxM, mesh });
    }
  }

  /** Drops chunks past their draw distance (the shader has sunk them by then). */
  update(camera: Vector3): void {
    const half = CHUNK_M * 0.71;
    for (const c of this.chunks) c.mesh.visible = Math.hypot(c.x - camera.x, c.z - camera.z) - half < c.maxM;
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
