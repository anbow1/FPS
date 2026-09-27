import type { SurfaceKind } from '../config.ts';
import { Vec3 } from '../core/vec.ts';

// Static collision world: yaw-rotated boxes plus a heightfield. Colliders are
// simple shapes only (rules §5): boxes for walls, floors, stairs, cars, trunks.
// The tanks games shipped without a physics library, so neither does this one;
// a capsule vs yaw-box resolver is all the player and AI need.

export interface BoxCollider {
  id: number;
  center: Vec3;
  halfExtents: Vec3; // in the box's own yaw frame
  yawRad: number;
  cosYaw: number;
  sinYaw: number;
  surface: SurfaceKind;
  blocksVision: boolean;
  blocksMovement: boolean;
  /** AABB in world space, for the grid. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
  stamp: number;
}

export interface BoxSpec {
  center: Vec3;
  size: Vec3; // full extents, metres
  yawRad?: number;
  surface: SurfaceKind;
  blocksVision?: boolean;
  blocksMovement?: boolean;
}

export interface Heightfield {
  originX: number;
  originZ: number;
  cellM: number;
  samplesX: number;
  samplesZ: number;
  heightsM: Float32Array;
  surfaceAt: (x: number, z: number) => SurfaceKind;
}

export interface RayBoxHit {
  box: BoxCollider;
  entryM: number;
  exitM: number;
  normal: Vec3; // outward normal at entry
}

export interface RayTerrainHit {
  distanceM: number;
  normal: Vec3;
  surface: SurfaceKind;
}

const GRID_CELL_M = 8;

export class CollisionWorld {
  readonly boxes: BoxCollider[] = [];
  private readonly grid = new Map<number, BoxCollider[]>();
  private stampCounter = 1;

  constructor(public readonly terrain: Heightfield) {}

  addBox(spec: BoxSpec): BoxCollider {
    if (spec.size.x <= 0 || spec.size.y <= 0 || spec.size.z <= 0) {
      throw new Error(`box size must be positive, got ${spec.size.x}×${spec.size.y}×${spec.size.z} m`);
    }
    const yaw = spec.yawRad ?? 0;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const hx = spec.size.x / 2;
    const hz = spec.size.z / 2;
    const ex = Math.abs(c) * hx + Math.abs(s) * hz;
    const ez = Math.abs(s) * hx + Math.abs(c) * hz;
    const box: BoxCollider = {
      id: this.boxes.length,
      center: spec.center.clone(),
      halfExtents: new Vec3(hx, spec.size.y / 2, hz),
      yawRad: yaw,
      cosYaw: c,
      sinYaw: s,
      surface: spec.surface,
      blocksVision: spec.blocksVision ?? spec.surface !== 'glass',
      blocksMovement: spec.blocksMovement ?? true,
      minX: spec.center.x - ex,
      maxX: spec.center.x + ex,
      minZ: spec.center.z - ez,
      maxZ: spec.center.z + ez,
      minY: spec.center.y - spec.size.y / 2,
      maxY: spec.center.y + spec.size.y / 2,
      stamp: 0,
    };
    this.boxes.push(box);
    const gx0 = Math.floor(box.minX / GRID_CELL_M);
    const gx1 = Math.floor(box.maxX / GRID_CELL_M);
    const gz0 = Math.floor(box.minZ / GRID_CELL_M);
    const gz1 = Math.floor(box.maxZ / GRID_CELL_M);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = cellKey(gx, gz);
        let list = this.grid.get(key);
        if (!list) {
          list = [];
          this.grid.set(key, list);
        }
        list.push(box);
      }
    }
    return box;
  }

  /** Disables a box (broken glass). It stays in the grid but stops colliding. */
  removeBox(box: BoxCollider): void {
    box.blocksMovement = false;
    box.blocksVision = false;
    box.surface = 'foliage';
    box.halfExtents.set(0, 0, 0);
  }

  terrainHeight(x: number, z: number): number {
    const t = this.terrain;
    const fx = clampIndex((x - t.originX) / t.cellM, t.samplesX - 1.001);
    const fz = clampIndex((z - t.originZ) / t.cellM, t.samplesZ - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const u = fx - ix;
    const v = fz - iz;
    const i = iz * t.samplesX + ix;
    const h = t.heightsM;
    const h00 = h[i] as number;
    const h10 = h[i + 1] as number;
    const h01 = h[i + t.samplesX] as number;
    const h11 = h[i + t.samplesX + 1] as number;
    return h00 + (h10 - h00) * u + (h01 - h00) * v + (h00 - h10 - h01 + h11) * u * v;
  }

  terrainNormal(x: number, z: number, out: Vec3): Vec3 {
    const e = this.terrain.cellM * 0.5;
    const dx = this.terrainHeight(x + e, z) - this.terrainHeight(x - e, z);
    const dz = this.terrainHeight(x, z + e) - this.terrainHeight(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /** Boxes whose world AABB overlaps the given XZ rectangle. Deduplicated. */
  queryBoxes(minX: number, minZ: number, maxX: number, maxZ: number, out: BoxCollider[]): BoxCollider[] {
    out.length = 0;
    const stamp = this.stampCounter++;
    const gx0 = Math.floor(minX / GRID_CELL_M);
    const gx1 = Math.floor(maxX / GRID_CELL_M);
    const gz0 = Math.floor(minZ / GRID_CELL_M);
    const gz1 = Math.floor(maxZ / GRID_CELL_M);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = this.grid.get(cellKey(gx, gz));
        if (!list) continue;
        for (const box of list) {
          if (box.stamp === stamp) continue;
          box.stamp = stamp;
          if (box.maxX < minX || box.minX > maxX || box.maxZ < minZ || box.minZ > maxZ) continue;
          out.push(box);
        }
      }
    }
    return out;
  }

  /**
   * All boxes the ray passes through within maxDistM, sorted by entry distance.
   * Walks the grid with a 2D DDA so a 800 m sniper ray only touches its cells.
   */
  raycastBoxes(origin: Vec3, dir: Vec3, maxDistM: number, out: RayBoxHit[]): RayBoxHit[] {
    out.length = 0;
    const stamp = this.stampCounter++;
    let gx = Math.floor(origin.x / GRID_CELL_M);
    let gz = Math.floor(origin.z / GRID_CELL_M);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const invX = Math.abs(dir.x) > 1e-9 ? 1 / Math.abs(dir.x) : Infinity;
    const invZ = Math.abs(dir.z) > 1e-9 ? 1 / Math.abs(dir.z) : Infinity;
    const nextBoundaryX = (dir.x > 0 ? (gx + 1) * GRID_CELL_M - origin.x : origin.x - gx * GRID_CELL_M) * invX;
    const nextBoundaryZ = (dir.z > 0 ? (gz + 1) * GRID_CELL_M - origin.z : origin.z - gz * GRID_CELL_M) * invZ;
    let tMaxX = nextBoundaryX;
    let tMaxZ = nextBoundaryZ;
    const tDeltaX = GRID_CELL_M * invX;
    const tDeltaZ = GRID_CELL_M * invZ;
    let t = 0;
    let guard = 0;
    while (t <= maxDistM && guard++ < 4096) {
      const list = this.grid.get(cellKey(gx, gz));
      if (list) {
        for (const box of list) {
          if (box.stamp === stamp) continue;
          box.stamp = stamp;
          const hit = rayBox(origin, dir, box, maxDistM);
          if (hit) out.push(hit);
        }
      }
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        gx += stepX;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        gz += stepZ;
      }
    }
    out.sort((a, b) => a.entryM - b.entryM);
    return out;
  }

  /** First terrain intersection by marching then bisecting. Null if none. */
  raycastTerrain(origin: Vec3, dir: Vec3, maxDistM: number): RayTerrainHit | null {
    const stepM = Math.max(0.5, this.terrain.cellM * 0.5);
    let prevT = 0;
    let prevAbove = origin.y - this.terrainHeight(origin.x, origin.z);
    if (prevAbove < 0) return null; // starts under the ground: ignore, not our case
    for (let t = stepM; t <= maxDistM + stepM; t += stepM) {
      const tt = Math.min(t, maxDistM);
      const x = origin.x + dir.x * tt;
      const y = origin.y + dir.y * tt;
      const z = origin.z + dir.z * tt;
      const above = y - this.terrainHeight(x, z);
      if (above < 0) {
        let lo = prevT;
        let hi = tt;
        for (let i = 0; i < 10; i++) {
          const mid = 0.5 * (lo + hi);
          const my = origin.y + dir.y * mid;
          const mx = origin.x + dir.x * mid;
          const mz = origin.z + dir.z * mid;
          if (my - this.terrainHeight(mx, mz) < 0) hi = mid;
          else lo = mid;
        }
        const hx = origin.x + dir.x * hi;
        const hz = origin.z + dir.z * hi;
        return { distanceM: hi, normal: this.terrainNormal(hx, hz, new Vec3()), surface: this.terrain.surfaceAt(hx, hz) };
      }
      prevT = tt;
      prevAbove = above;
      if (tt >= maxDistM) break;
    }
    return null;
  }

  /** True when an opaque box or the terrain sits between a and b. */
  lineBlocked(a: Vec3, b: Vec3, forVision: boolean): boolean {
    _dir.subVectors(b, a);
    const dist = _dir.length();
    if (dist < 1e-6) return false;
    _dir.scale(1 / dist);
    const hits = this.raycastBoxes(a, _dir, dist, _hits);
    for (const h of hits) {
      if (forVision ? h.box.blocksVision : h.box.blocksMovement) return true;
    }
    return this.raycastTerrain(a, _dir, dist) !== null;
  }
}

const _dir = new Vec3();
const _hits: RayBoxHit[] = [];

function cellKey(gx: number, gz: number): number {
  return (gx + 4096) * 8192 + (gz + 4096);
}

function clampIndex(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v;
}

const _slab = { tNear: 0, tFar: 0, axis: 0, sign: 1 };

/** One slab of the ray/box test; false when the ray misses. No allocation. */
function slab(oi: number, di: number, hi: number, axisIndex: number): boolean {
  if (Math.abs(di) < 1e-12) return oi >= -hi && oi <= hi;
  let t1 = (-hi - oi) / di;
  let t2 = (hi - oi) / di;
  let s = -1;
  if (t1 > t2) {
    const tmp = t1;
    t1 = t2;
    t2 = tmp;
    s = 1;
  }
  if (t1 > _slab.tNear) {
    _slab.tNear = t1;
    _slab.axis = axisIndex;
    _slab.sign = s;
  }
  if (t2 < _slab.tFar) _slab.tFar = t2;
  return _slab.tNear <= _slab.tFar;
}

/** Slab test in the box's yaw frame. Returns entry/exit and the entry normal. */
export function rayBox(origin: Vec3, dir: Vec3, box: BoxCollider, maxDistM: number): RayBoxHit | null {
  if (box.halfExtents.x === 0) return null;
  const ox = origin.x - box.center.x;
  const oz = origin.z - box.center.z;
  // World → local is a rotation by -yaw about Y.
  const lox = box.cosYaw * ox - box.sinYaw * oz;
  const loz = box.sinYaw * ox + box.cosYaw * oz;
  const loy = origin.y - box.center.y;
  const ldx = box.cosYaw * dir.x - box.sinYaw * dir.z;
  const ldz = box.sinYaw * dir.x + box.cosYaw * dir.z;
  const ldy = dir.y;
  _slab.tNear = -Infinity;
  _slab.tFar = Infinity;
  _slab.axis = 0;
  _slab.sign = 1;
  if (!slab(lox, ldx, box.halfExtents.x, 0)) return null;
  if (!slab(loy, ldy, box.halfExtents.y, 1)) return null;
  if (!slab(loz, ldz, box.halfExtents.z, 2)) return null;
  const tNear = _slab.tNear;
  const tFar = _slab.tFar;
  const axis = _slab.axis;
  const sign = _slab.sign;
  if (tFar < 0 || tNear > maxDistM) return null;
  // Local normal → world.
  let nx = axis === 0 ? sign : 0;
  const ny = axis === 1 ? sign : 0;
  let nz = axis === 2 ? sign : 0;
  const wx = box.cosYaw * nx + box.sinYaw * nz;
  const wz = -box.sinYaw * nx + box.cosYaw * nz;
  nx = wx;
  nz = wz;
  return { box, entryM: Math.max(0, tNear), exitM: tFar, normal: new Vec3(nx, ny, nz) };
}

/** World point → box-local XZ, written into out (x, z). */
export function toBoxLocal(box: BoxCollider, x: number, z: number, out: Vec3): Vec3 {
  const ox = x - box.center.x;
  const oz = z - box.center.z;
  return out.set(box.cosYaw * ox - box.sinYaw * oz, 0, box.sinYaw * ox + box.cosYaw * oz);
}

/** Box-local XZ direction → world. */
export function fromBoxLocalDir(box: BoxCollider, lx: number, lz: number, out: Vec3): Vec3 {
  return out.set(box.cosYaw * lx + box.sinYaw * lz, 0, -box.sinYaw * lx + box.cosYaw * lz);
}
