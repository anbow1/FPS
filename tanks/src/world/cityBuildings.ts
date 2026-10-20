import * as THREE from 'three/webgpu';
import { type CityKind, cityMaterial, makeBuildingData } from '../render/cityMaterial';
import { Rng } from '../core/rng';
import type { Obb } from './buildings';
import { type CityPlan, type Lot, WINDOWS } from './cityPlan';
import type { Heightfield } from './heightfield';

/** Chunk size for culling (m): a chunk's meshes are skipped by every view and cascade that misses it. */
const CHUNK_M = 256;
const KINDS: readonly CityKind[] = ['plaster', 'brick', 'concrete', 'metal', 'tiles', 'roof', 'frame'];

/**
 * Indexed triangles for one material in one chunk, with the facade shader's building index per
 * vertex. Boxes are written straight into growable typed arrays: the town has some forty thousand
 * of them, and a BufferGeometry each would take seconds to build and merge.
 */
class MeshBuffer {
  pos = new Float32Array(4096 * 3);
  nrm = new Float32Array(4096 * 3);
  ids = new Float32Array(4096);
  idx = new Uint32Array(8192);
  verts = 0;
  tris = 0;

  private grow(v: number, i: number): void {
    if (this.verts + v > this.ids.length) {
      const n = Math.max(this.ids.length * 2, this.verts + v);
      this.pos = resize(this.pos, n * 3);
      this.nrm = resize(this.nrm, n * 3);
      this.ids = resize(this.ids, n);
    }
    if (this.tris * 3 + i > this.idx.length) {
      const n = Math.max(this.idx.length * 2, this.tris * 3 + i);
      const next = new Uint32Array(n);
      next.set(this.idx);
      this.idx = next;
    }
  }

  /** A planar polygon (convex, counter-clockwise seen from the front), already in world space. */
  poly(points: readonly THREE.Vector3[], n: THREE.Vector3, id: number): void {
    this.grow(points.length, (points.length - 2) * 3);
    const v0 = this.verts;
    for (const p of points) {
      const o = this.verts * 3;
      this.pos[o] = p.x;
      this.pos[o + 1] = p.y;
      this.pos[o + 2] = p.z;
      this.nrm[o] = n.x;
      this.nrm[o + 1] = n.y;
      this.nrm[o + 2] = n.z;
      this.ids[this.verts] = id;
      this.verts++;
    }
    for (let k = 1; k < points.length - 1; k++) {
      const o = this.tris * 3;
      this.idx[o] = v0;
      this.idx[o + 1] = v0 + k;
      this.idx[o + 2] = v0 + k + 1;
      this.tris++;
    }
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.tris === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.verts * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.verts * 3), 3));
    g.setAttribute('aId', new THREE.BufferAttribute(this.ids.slice(0, this.verts), 1));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.tris * 3), 1));
    g.computeBoundingSphere();
    return g;
  }
}

function resize(a: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(n);
  next.set(a);
  return next;
}

/** Writes one building's parts in its own frame (x frontage, z depth, y world height). */
class Writer {
  private cos = 1;
  private sin = 0;
  private cx = 0;
  private cz = 0;
  private readonly p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly n = new THREE.Vector3();

  constructor(private readonly target: (kind: CityKind) => MeshBuffer) {}

  frame(lot: Lot): void {
    this.cos = Math.cos(lot.rotRad);
    this.sin = Math.sin(lot.rotRad);
    this.cx = lot.x;
    this.cz = lot.z;
  }

  private world(out: THREE.Vector3, x: number, y: number, z: number): THREE.Vector3 {
    // local → world: a turn by yaw about +y (makeRotationY), then the lot's centre
    return out.set(this.cx + x * this.cos + z * this.sin, y, this.cz - x * this.sin + z * this.cos);
  }

  private dir(out: THREE.Vector3, x: number, y: number, z: number): THREE.Vector3 {
    return out.set(x * this.cos + z * this.sin, y, -x * this.sin + z * this.cos);
  }

  /** Quad from four local corners (counter-clockwise from the front) with a local normal. */
  quad(kind: CityKind, id: number, c: readonly (readonly [number, number, number])[], nx: number, ny: number, nz: number): void {
    const pts = c.map((q, k) => this.world(this.p[k]!, q[0], q[1], q[2]));
    this.target(kind).poly(pts, this.dir(this.n, nx, ny, nz).normalize(), id);
  }

  /** Axis-aligned box in the local frame; the bottom face is left out (it is never seen). */
  box(kind: CityKind, id: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, top = true): void {
    this.quad(kind, id, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 0, 0, 1);
    this.quad(kind, id, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], 0, 0, -1);
    this.quad(kind, id, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], 1, 0, 0);
    this.quad(kind, id, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], -1, 0, 0);
    if (top) this.quad(kind, id, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 0, 1, 0);
  }

  /** A gable roof over [x0,x1]×[z0,z1] at eaves height y, ridge along x (or along z), slopes of `kind`. */
  gable(kind: CityKind, gableKind: CityKind, id: number, x0: number, x1: number, z0: number, z1: number, y: number, rise: number, alongX: boolean, over: number): void {
    const t = -Math.abs(id);
    if (alongX) {
      const zm = (z0 + z1) / 2;
      const ry = y + rise;
      const half = (z1 - z0) / 2 + over;
      const s = Math.hypot(half, rise);
      const ny = half / s;
      const nz = rise / s;
      const yo = y - (over * rise) / ((z1 - z0) / 2);
      this.quad(kind, t, [[x0 - over, yo, z1 + over], [x1 + over, yo, z1 + over], [x1 + over, ry, zm], [x0 - over, ry, zm]], 0, ny, nz);
      this.quad(kind, t, [[x1 + over, yo, z0 - over], [x0 - over, yo, z0 - over], [x0 - over, ry, zm], [x1 + over, ry, zm]], 0, ny, -nz);
      this.tri(gableKind, t, [x1, y, z1], [x1, y, z0], [x1, ry, zm], 1, 0, 0);
      this.tri(gableKind, t, [x0, y, z0], [x0, y, z1], [x0, ry, zm], -1, 0, 0);
    } else {
      const xm = (x0 + x1) / 2;
      const ry = y + rise;
      const half = (x1 - x0) / 2 + over;
      const s = Math.hypot(half, rise);
      const ny = half / s;
      const nx = rise / s;
      const yo = y - (over * rise) / ((x1 - x0) / 2);
      this.quad(kind, t, [[x1 + over, yo, z1 + over], [x1 + over, yo, z0 - over], [xm, ry, z0 - over], [xm, ry, z1 + over]], nx, ny, 0);
      this.quad(kind, t, [[x0 - over, yo, z0 - over], [x0 - over, yo, z1 + over], [xm, ry, z1 + over], [xm, ry, z0 - over]], -nx, ny, 0);
      this.tri(gableKind, t, [x0, y, z1], [x1, y, z1], [xm, ry, z1], 0, 0, 1);
      this.tri(gableKind, t, [x1, y, z0], [x0, y, z0], [xm, ry, z0], 0, 0, -1);
    }
  }

  tri(kind: CityKind, id: number, a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number], nx: number, ny: number, nz: number): void {
    const pts = [this.world(this.p[0]!, a[0], a[1], a[2]), this.world(this.p[1]!, b[0], b[1], b[2]), this.world(this.p[2]!, c[0], c[1], c[2])];
    this.target(kind).poly(pts, this.dir(this.n, nx, ny, nz).normalize(), id);
  }

  /** A square pyramid (a spire) over a w × w base centred on the frame's origin. */
  pyramid(kind: CityKind, id: number, w: number, y: number, rise: number): void {
    const h = w / 2;
    const s = Math.hypot(h, rise);
    const a = rise / s;
    const b = h / s;
    const apex = [0, y + rise, 0] as const;
    this.tri(kind, id, [-h, y, h], [h, y, h], apex, 0, b, a);
    this.tri(kind, id, [h, y, h], [h, y, -h], apex, a, b, 0);
    this.tri(kind, id, [h, y, -h], [-h, y, -h], apex, 0, b, -a);
    this.tri(kind, id, [-h, y, -h], [-h, y, h], apex, -a, b, 0);
  }

  /** An upright tapering cylinder (a works chimney) at local (x, z). */
  stack(kind: CityKind, id: number, x: number, z: number, r0: number, r1: number, y0: number, y1: number): void {
    const seg = 12;
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2;
      const a1 = ((k + 1) / seg) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      this.quad(
        kind,
        id,
        [
          [x + Math.sin(a0) * r0, y0, z + Math.cos(a0) * r0],
          [x + Math.sin(a1) * r0, y0, z + Math.cos(a1) * r0],
          [x + Math.sin(a1) * r1, y1, z + Math.cos(a1) * r1],
          [x + Math.sin(a0) * r1, y1, z + Math.cos(a0) * r1],
        ],
        Math.sin(am),
        (r0 - r1) / (y1 - y0),
        Math.cos(am),
      );
    }
  }
}

export interface CityBuildings {
  group: THREE.Group;
  colliders: Obb[];
  /** The facade materials, for the shader warm-up. */
  materials: THREE.MeshStandardNodeMaterial[];
}

/**
 * The town's buildings from the plan: walls with the facade shader's windows, plinths, cornices,
 * parapets and flat roofs with their stair houses and chimneys, or gable roofs; balconies on some
 * fronts; the church with its tower and spire; works with a chimney stack. Merged per material in
 * 256 m chunks. `lite` (the Low preset) leaves out the balconies and roof clutter.
 */
export function buildCity(plan: CityPlan, hf: Heightfield, lite: boolean): CityBuildings {
  const chunks = new Map<number, Map<CityKind, MeshBuffer>>();
  let current = new Map<CityKind, MeshBuffer>();
  const writer = new Writer((kind) => {
    let b = current.get(kind);
    if (!b) current.set(kind, (b = new MeshBuffer()));
    return b;
  });
  const rows: number[][] = [];
  const colliders: Obb[] = [];
  const rng = new Rng(4111);

  for (const lot of plan.lots) {
    const key = Math.floor(lot.x / CHUNK_M) * 1000 + Math.floor(lot.z / CHUNK_M);
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = new Map()));
    current = c;
    writer.frame(lot);
    // ground under the four corners: a plinth reaches down to the lowest, the floor sits on the highest
    let lo = Infinity;
    let hi = -Infinity;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const wx = lot.x + (sx * lot.w * Math.cos(lot.rotRad)) / 2 + (sz * lot.d * Math.sin(lot.rotRad)) / 2;
      const wz = lot.z - (sx * lot.w * Math.sin(lot.rotRad)) / 2 + (sz * lot.d * Math.cos(lot.rotRad)) / 2;
      const y = hf.heightAt(wx, wz);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    if (hi - lo > 4) continue; // too steep for a street front (only ever at the edge of the levelled ground)
    const floorY = hi + 0.15;
    const index = rows.length;
    rows.push([lot.x, lot.z, lot.rotRad, floorY, lot.seed, lot.floorM, lot.groundM, lot.bayM, lot.windows, lot.openLeft ? 1 : 0, lot.openRight ? 1 : 0, 0]);
    const win = index + 1;
    const trim = -(index + 1);
    const hw = lot.w / 2;
    const hd = lot.d / 2;
    const top = floorY + lot.wallM;
    const wall = lot.wall;
    // trims (cornices, parapets, gables) take the wall's own surface, without windows
    const trimKind: CityKind = wall;
    // plinth from below the lowest ground to just above the floor
    writer.box('concrete', trim, -hw - 0.06, hw + 0.06, lo - 0.6, floorY + 0.45, -hd - 0.06, hd + 0.06, false);
    writer.box(wall, win, -hw, hw, floorY + 0.45, top, -hd, hd, false);
    let roofTop = top;
    const tenementLike = lot.windows === WINDOWS.tenement || lot.windows === WINDOWS.shops;
    if (tenementLike) {
      // the band over the ground floor and the cornice under the eaves
      writer.box(trimKind, trim, -hw - 0.12, hw + 0.12, floorY + lot.groundM - 0.25, floorY + lot.groundM + 0.1, -hd - 0.12, hd + 0.12);
      writer.box(trimKind, trim, -hw - 0.3, hw + 0.3, top - 0.45, top, -hd - 0.3, hd + 0.3);
    }
    if (lot.roof === 'flat') {
      // parapet round a tarred roof
      const p = 0.28;
      const ph = lot.windows === WINDOWS.prefab ? 0.6 : 0.95;
      writer.box(trimKind, trim, -hw, hw, top, top + ph, hd - p, hd);
      writer.box(trimKind, trim, -hw, hw, top, top + ph, -hd, -hd + p);
      writer.box(trimKind, trim, -hw, -hw + p, top, top + ph, -hd + p, hd - p);
      writer.box(trimKind, trim, hw - p, hw, top, top + ph, -hd + p, hd - p);
      writer.box('roof', trim, -hw + p, hw - p, top, top + 0.12, -hd + p, hd - p);
      roofTop = top + ph;
      if (!lite && lot.windows !== WINDOWS.church) {
        // a stair house, and chimneys on the tenements (lift motor room on the tall prefabs)
        const sx = rng.range(-hw * 0.5, hw * 0.5);
        const tall = lot.windows === WINDOWS.prefab && lot.wallM > 20;
        writer.box('concrete', trim, sx - 1.6, sx + 1.6, top, top + (tall ? 3.6 : 2.6), -2.2, 2.2);
        roofTop = Math.max(roofTop, top + (tall ? 3.6 : 2.6));
        if (tenementLike) {
          for (let k = 0; k < 3; k++) {
            const cxp = -hw + (k + 0.5) * (lot.w / 3) + rng.range(-1, 1);
            writer.box('brick', trim, cxp - 0.35, cxp + 0.35, top, top + 1.7, -hd * 0.2 - 0.6, -hd * 0.2 + 0.6);
          }
        }
      }
    } else {
      // pitched roof over the longer side; steep on the church, low on the sheds
      const alongX = lot.w >= lot.d;
      const span = alongX ? lot.d : lot.w;
      const pitch = lot.windows === WINDOWS.church ? 0.9 : lot.windows === WINDOWS.industrial ? 0.26 : 0.62;
      const rise = (span / 2) * Math.tan(pitch);
      const roofKind: CityKind = lot.windows === WINDOWS.industrial ? 'metal' : 'tiles';
      writer.gable(roofKind, trimKind, trim, -hw, hw, -hd, hd, top, rise, alongX, 0.45);
      roofTop = top + rise;
      if (tenementLike && !lite) {
        for (let k = 0; k < 2; k++) {
          const cxp = -hw + (k + 0.5) * (lot.w / 2);
          writer.box('brick', trim, cxp - 0.35, cxp + 0.35, top + rise * 0.5, top + rise + 0.9, -0.6, 0.6);
        }
      }
    }
    if (lot.extra === 'spire') {
      writer.box(trimKind, trim, -hw - 0.35, hw + 0.35, top - 0.6, top, -hd - 0.35, hd + 0.35);
      writer.pyramid('metal', trim, lot.w, roofTop, 16);
      roofTop += 16;
    }
    if (lot.extra === 'chimney') {
      const zc = hd + 6;
      writer.stack('brick', trim, -hw * 0.5, zc, 1.4, 0.95, lo - 0.5, floorY + 36);
      const wx = lot.x + -hw * 0.5 * Math.cos(lot.rotRad) + zc * Math.sin(lot.rotRad);
      const wz = lot.z + hw * 0.5 * Math.sin(lot.rotRad) + zc * Math.cos(lot.rotRad);
      colliders.push({ x: wx, z: wz, y0: lo - 0.5, y1: floorY + 36, hw: 1.3, hd: 1.3, rot: 0 });
    }
    if (lot.balconies && !lite) {
      // every other bay of the street front from the first floor up: slab, railing, its two sides
      const storeys = Math.round((lot.wallM - lot.groundM) / lot.floorM);
      const bays = Math.round(lot.w / lot.bayM);
      const phase = rng.int(0, 1);
      for (let f = 0; f < storeys; f++) {
        const y = floorY + lot.groundM + f * lot.floorM;
        for (let b = phase; b < bays; b += 2) {
          const xc = -hw + (b + 0.5) * lot.bayM;
          const half = lot.bayM * 0.38;
          writer.box('concrete', trim, xc - half, xc + half, y - 0.16, y, hd, hd + 1.15);
          writer.box('frame', trim, xc - half, xc + half, y, y + 1.0, hd + 1.1, hd + 1.15);
          writer.box('frame', trim, xc - half, xc - half + 0.05, y, y + 1.0, hd, hd + 1.1, false);
          writer.box('frame', trim, xc + half - 0.05, xc + half, y, y + 1.0, hd, hd + 1.1, false);
        }
      }
    }
    colliders.push({ x: lot.x, z: lot.z, y0: lo - 0.6, y1: roofTop, hw, hd, rot: lot.rotRad });
  }

  const data = makeBuildingData(rows);
  const materials = new Map<CityKind, THREE.MeshStandardNodeMaterial>();
  for (const k of KINDS) materials.set(k, cityMaterial(k, data));
  const group = new THREE.Group();
  group.name = 'town';
  for (const c of chunks.values()) {
    for (const [kind, buf] of c) {
      const g = buf.geometry();
      if (!g) continue;
      const mesh = new THREE.Mesh(g, materials.get(kind)!);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  return { group, colliders, materials: [...materials.values()] };
}
