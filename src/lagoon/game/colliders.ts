import { WATER_LEVEL_M } from '../config.ts';
import type { P3 } from './events.ts';
import { heightAt, normalAt, type SurfaceKind, surfaceAt } from './terrain.ts';

// Static collision: the terrain height field, plus simple shapes (rules §5 —
// boxes, vertical cylinders and spheres; never a render mesh). A uniform XZ
// grid keeps queries local. Ray casts serve bullets, the knife and
// interaction; the player uses the push-out and ground queries.

export interface BoxCollider {
  kind: 'box';
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yawRad: number;
  surface: SurfaceKind;
}

export interface CylinderCollider {
  kind: 'cylinder';
  x: number;
  z: number;
  radiusM: number;
  y0: number;
  y1: number;
  surface: SurfaceKind;
}

export interface SphereCollider {
  kind: 'sphere';
  x: number;
  y: number;
  z: number;
  radiusM: number;
  surface: SurfaceKind;
}

export type Collider = BoxCollider | CylinderCollider | SphereCollider;

export interface RayHit {
  distanceM: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  surface: SurfaceKind;
  /** Index into the collider list; −1 terrain, −2 water surface. */
  colliderIndex: number;
}

export const TERRAIN_HIT = -1;
export const WATER_HIT = -2;
const CELL_M = 8;

export function newHit(): RayHit {
  return { distanceM: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, surface: 'sand', colliderIndex: TERRAIN_HIT };
}

export class CollisionWorld {
  readonly colliders: Collider[] = [];
  /** Leaf volumes: bullets pass through, but a hit sheds leaves. */
  readonly leaves: SphereCollider[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly seen = new Set<number>();
  private readonly nearby: number[] = [];
  private readonly tested = new Set<number>();

  add(c: Collider): number {
    const index = this.colliders.length;
    this.colliders.push(c);
    const r = boundRadius(c);
    const cx = c.x;
    const cz = c.z;
    for (let gx = Math.floor((cx - r) / CELL_M); gx <= Math.floor((cx + r) / CELL_M); gx++) {
      for (let gz = Math.floor((cz - r) / CELL_M); gz <= Math.floor((cz + r) / CELL_M); gz++) {
        const key = cellKey(gx, gz);
        let list = this.grid.get(key);
        if (!list) {
          list = [];
          this.grid.set(key, list);
        }
        list.push(index);
      }
    }
    return index;
  }

  /** Collider indices whose cells touch the XZ box around (x, z). */
  query(x: number, z: number, radiusM: number): readonly number[] {
    this.nearby.length = 0;
    this.seen.clear();
    for (let gx = Math.floor((x - radiusM) / CELL_M); gx <= Math.floor((x + radiusM) / CELL_M); gx++) {
      for (let gz = Math.floor((z - radiusM) / CELL_M); gz <= Math.floor((z + radiusM) / CELL_M); gz++) {
        const list = this.grid.get(cellKey(gx, gz));
        if (!list) continue;
        for (const i of list) {
          if (this.seen.has(i)) continue;
          this.seen.add(i);
          this.nearby.push(i);
        }
      }
    }
    return this.nearby;
  }

  /**
   * Height of whatever the feet would stand on at (x, z): the terrain, or the
   * top of a box within one step of the current feet height.
   */
  groundAt(x: number, z: number, feetY: number, stepM: number, out?: { surface: SurfaceKind }): number {
    let best = heightAt(x, z);
    let surface: SurfaceKind | null = null;
    for (const i of this.query(x, z, 0.5)) {
      const c = this.colliders[i] as Collider;
      if (c.kind !== 'box') continue;
      const top = c.y + c.hy;
      if (top > feetY + stepM || top <= best) continue;
      const lx = localX(c, x, z);
      const lz = localZ(c, x, z);
      if (Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz) {
        best = top;
        surface = c.surface;
      }
    }
    if (out) out.surface = surface ?? surfaceAt(x, z);
    return best;
  }

  /** Pushes a vertical capsule (as a circle over a height span) out of every shape it overlaps. */
  pushOut(pos: P3, radiusM: number, bottomY: number, topY: number): void {
    for (const i of this.query(pos.x, pos.z, radiusM + 1)) {
      const c = this.colliders[i] as Collider;
      if (c.kind === 'cylinder') {
        if (c.y1 < bottomY || c.y0 > topY) continue;
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const d = Math.hypot(dx, dz);
        const min = c.radiusM + radiusM;
        if (d < min && d > 1e-6) {
          pos.x = c.x + (dx / d) * min;
          pos.z = c.z + (dz / d) * min;
        }
      } else if (c.kind === 'sphere') {
        const cy = Math.min(topY, Math.max(bottomY, c.y));
        const dy = cy - c.y;
        if (Math.abs(dy) >= c.radiusM) continue;
        const r = Math.sqrt(c.radiusM * c.radiusM - dy * dy);
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const d = Math.hypot(dx, dz);
        const min = r + radiusM;
        if (d < min && d > 1e-6) {
          pos.x = c.x + (dx / d) * min;
          pos.z = c.z + (dz / d) * min;
        }
      } else {
        if (c.y + c.hy < bottomY || c.y - c.hy > topY) continue;
        const lx = localX(c, pos.x, pos.z);
        const lz = localZ(c, pos.x, pos.z);
        const qx = Math.max(-c.hx, Math.min(c.hx, lx));
        const qz = Math.max(-c.hz, Math.min(c.hz, lz));
        let dx = lx - qx;
        let dz = lz - qz;
        let d = Math.hypot(dx, dz);
        let nlx: number;
        let nlz: number;
        if (d < 1e-6) {
          // Centre inside the footprint: leave along the shallowest face.
          const px = c.hx - Math.abs(lx);
          const pz = c.hz - Math.abs(lz);
          if (px < pz) {
            nlx = c.hx * Math.sign(lx || 1) + Math.sign(lx || 1) * radiusM;
            nlz = lz;
          } else {
            nlx = lx;
            nlz = c.hz * Math.sign(lz || 1) + Math.sign(lz || 1) * radiusM;
          }
        } else if (d < radiusM) {
          dx /= d;
          dz /= d;
          d = radiusM;
          nlx = qx + dx * d;
          nlz = qz + dz * d;
        } else continue;
        const cos = Math.cos(c.yawRad);
        const sin = Math.sin(c.yawRad);
        pos.x = c.x + nlx * cos + nlz * sin;
        pos.z = c.z - nlx * sin + nlz * cos;
      }
    }
  }

  /**
   * Nearest hit along a ray against terrain, shapes and (optionally) the
   * water surface. `dir` must be unit length.
   */
  raycast(o: P3, dir: P3, maxDistM: number, out: RayHit, hitWater = true): boolean {
    let best = maxDistM;
    let found = false;
    if (raycastTerrain(o, dir, best, out)) {
      best = out.distanceM;
      found = true;
    }
    if (hitWater && dir.y < -1e-6 && o.y > WATER_LEVEL_M) {
      const t = (WATER_LEVEL_M - o.y) / dir.y;
      if (t < best) {
        best = t;
        found = true;
        setHit(out, o, dir, t, 0, 1, 0, 'water', WATER_HIT);
      }
    }
    // Shapes near the ray: walk the grid along it in cell-size strides.
    const strides = Math.ceil(best / CELL_M) + 1;
    const tested = this.tested;
    tested.clear();
    for (let s = 0; s <= strides; s++) {
      const t = Math.min(best, s * CELL_M);
      for (const i of this.query(o.x + dir.x * t, o.z + dir.z * t, CELL_M)) {
        if (tested.has(i)) continue;
        tested.add(i);
        const c = this.colliders[i] as Collider;
        const hitT = rayShape(c, o, dir, best, _n);
        if (hitT !== null && hitT < best) {
          best = hitT;
          found = true;
          setHit(out, o, dir, hitT, _n.x, _n.y, _n.z, c.surface, i);
        }
      }
      if (s * CELL_M > best) break;
    }
    return found;
  }

  /** First leaf volume crossed before `maxDistM`, for bullet leaf shedding. */
  leavesAlong(o: P3, dir: P3, maxDistM: number): P3 | null {
    let best = maxDistM;
    let hit: P3 | null = null;
    for (const s of this.leaves) {
      const t = raySphere(s.x, s.y, s.z, s.radiusM, o, dir);
      if (t !== null && t < best) {
        best = t;
        hit = { x: o.x + dir.x * t, y: o.y + dir.y * t, z: o.z + dir.z * t };
      }
    }
    return hit;
  }
}

const _n = { x: 0, y: 1, z: 0 };

function cellKey(gx: number, gz: number): number {
  return (gx + 4096) * 8192 + (gz + 4096);
}

function boundRadius(c: Collider): number {
  if (c.kind === 'box') return Math.hypot(c.hx, c.hz);
  return c.radiusM;
}

function localX(c: BoxCollider, x: number, z: number): number {
  const dx = x - c.x;
  const dz = z - c.z;
  return dx * Math.cos(c.yawRad) - dz * Math.sin(c.yawRad);
}

function localZ(c: BoxCollider, x: number, z: number): number {
  const dx = x - c.x;
  const dz = z - c.z;
  return dx * Math.sin(c.yawRad) + dz * Math.cos(c.yawRad);
}

function setHit(out: RayHit, o: P3, d: P3, t: number, nx: number, ny: number, nz: number, surface: SurfaceKind, index: number): void {
  out.distanceM = t;
  out.x = o.x + d.x * t;
  out.y = o.y + d.y * t;
  out.z = o.z + d.z * t;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.surface = surface;
  out.colliderIndex = index;
}

/** Adaptive march over the height field, then bisection to ~1 cm. */
export function raycastTerrain(o: P3, d: P3, maxDistM: number, out: RayHit): boolean {
  let t = 0;
  let prevT = 0;
  let above = o.y - heightAt(o.x, o.z);
  if (above < 0) return false;
  while (t < maxDistM) {
    const step = Math.min(6, Math.max(0.2, above * 0.6));
    prevT = t;
    t = Math.min(maxDistM, t + step);
    const x = o.x + d.x * t;
    const z = o.z + d.z * t;
    const y = o.y + d.y * t;
    above = y - heightAt(x, z);
    if (above <= 0) {
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const my = o.y + d.y * mid;
        if (my - heightAt(o.x + d.x * mid, o.z + d.z * mid) > 0) lo = mid;
        else hi = mid;
      }
      const hx = o.x + d.x * hi;
      const hz = o.z + d.z * hi;
      normalAt(hx, hz, _n);
      setHit(out, o, d, hi, _n.x, _n.y, _n.z, surfaceAt(hx, hz), TERRAIN_HIT);
      if (out.surface === 'water') out.surface = 'sand'; // the lagoon floor under the surface
      return true;
    }
    if (t >= maxDistM) break;
  }
  return false;
}

function raySphere(cx: number, cy: number, cz: number, r: number, o: P3, d: P3): number | null {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  return null; // starting inside counts as no hit: the ray is leaving
}

function rayShape(c: Collider, o: P3, d: P3, maxT: number, n: { x: number; y: number; z: number }): number | null {
  if (c.kind === 'sphere') {
    const t = raySphere(c.x, c.y, c.z, c.radiusM, o, d);
    if (t === null || t > maxT) return null;
    const len = c.radiusM;
    n.x = (o.x + d.x * t - c.x) / len;
    n.y = (o.y + d.y * t - c.y) / len;
    n.z = (o.z + d.z * t - c.z) / len;
    return t;
  }
  if (c.kind === 'cylinder') {
    const ox = o.x - c.x;
    const oz = o.z - c.z;
    const a = d.x * d.x + d.z * d.z;
    if (a < 1e-9) return null;
    const b = ox * d.x + oz * d.z;
    const cc = ox * ox + oz * oz - c.radiusM * c.radiusM;
    const disc = b * b - a * cc;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t < 0 || t > maxT) return null;
    const y = o.y + d.y * t;
    if (y < c.y0 || y > c.y1) return null;
    n.x = (ox + d.x * t) / c.radiusM;
    n.y = 0;
    n.z = (oz + d.z * t) / c.radiusM;
    return t;
  }
  // Oriented box: slab test in the box's frame.
  const cos = Math.cos(c.yawRad);
  const sin = Math.sin(c.yawRad);
  const px = o.x - c.x;
  const pz = o.z - c.z;
  const lo = [px * cos - pz * sin, o.y - c.y, px * sin + pz * cos];
  const ld = [d.x * cos - d.z * sin, d.y, d.x * sin + d.z * cos];
  const h = [c.hx, c.hy, c.hz];
  let tMin = 0;
  let tMax = maxT;
  let axis = -1;
  let sign = 1;
  for (let k = 0; k < 3; k++) {
    const ok = lo[k] as number;
    const dk = ld[k] as number;
    const hk = h[k] as number;
    if (Math.abs(dk) < 1e-9) {
      if (ok < -hk || ok > hk) return null;
      continue;
    }
    let t1 = (-hk - ok) / dk;
    let t2 = (hk - ok) / dk;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = k;
      sign = s;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (axis < 0) return null; // origin inside the box
  const lnx = axis === 0 ? sign : 0;
  const lny = axis === 1 ? sign : 0;
  const lnz = axis === 2 ? sign : 0;
  n.x = lnx * cos + lnz * sin;
  n.y = lny;
  n.z = -lnx * sin + lnz * cos;
  return tMin;
}
