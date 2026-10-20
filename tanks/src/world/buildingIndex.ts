import { WORLD_SIZE } from '../config';
import type { Obb } from './buildings';

/** Cell of the grid (m): about one tenement frontage, so a query touches a handful of houses. */
const CELL_M = 32;
const CELLS = Math.ceil(WORLD_SIZE / CELL_M);
const HALF = WORLD_SIZE / 2;

/**
 * A uniform grid over the building colliders. With the town there are over a thousand of them, and
 * every shell, bullet, line of sight, tank and AI probe used to test them all. Each collider is
 * entered in every cell its rotated footprint's bounding box covers; a query visits only the cells
 * its circle or segment crosses and returns each collider once.
 */
export class BuildingIndex {
  private readonly cells: number[][] = Array.from({ length: CELLS * CELLS }, () => []);
  /** Per-collider query stamp: a collider already returned by the current query is skipped. */
  private stamp: Uint32Array;
  private query = 0;

  constructor(readonly items: readonly Obb[]) {
    this.stamp = new Uint32Array(items.length);
    items.forEach((c, k) => {
      const ex = Math.abs(Math.cos(c.rot)) * c.hw + Math.abs(Math.sin(c.rot)) * c.hd;
      const ez = Math.abs(Math.sin(c.rot)) * c.hw + Math.abs(Math.cos(c.rot)) * c.hd;
      const i0 = cellOf(c.x - ex);
      const i1 = cellOf(c.x + ex);
      const j0 = cellOf(c.z - ez);
      const j1 = cellOf(c.z + ez);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * CELLS + i]!.push(k);
    });
  }

  /** Colliders whose cells a circle of radius `r` around (x, z) touches (a superset of those it overlaps). */
  near(x: number, z: number, r: number, out: number[]): number[] {
    out.length = 0;
    const q = this.next();
    const i0 = cellOf(x - r);
    const i1 = cellOf(x + r);
    const j0 = cellOf(z - r);
    const j1 = cellOf(z + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.collect(j * CELLS + i, q, out);
    return out;
  }

  /** Colliders in the cells a segment's ground track crosses (Amanatides & Woo grid walk). */
  alongSegment(ax: number, az: number, bx: number, bz: number, out: number[]): number[] {
    out.length = 0;
    const q = this.next();
    let i = cellOf(ax);
    let j = cellOf(az);
    const iEnd = cellOf(bx);
    const jEnd = cellOf(bz);
    const dx = bx - ax;
    const dz = bz - az;
    const stepI = dx > 0 ? 1 : -1;
    const stepJ = dz > 0 ? 1 : -1;
    const fx = (ax + HALF) / CELL_M;
    const fz = (az + HALF) / CELL_M;
    const tDeltaX = dx !== 0 ? Math.abs(CELL_M / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(CELL_M / dz) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? Math.floor(fx) + 1 - fx : fx - Math.floor(fx)) * tDeltaX : Infinity;
    let tMaxZ = dz !== 0 ? (dz > 0 ? Math.floor(fz) + 1 - fz : fz - Math.floor(fz)) * tDeltaZ : Infinity;
    // bounded by the cell count either way, so a segment that leaves the grid cannot loop forever
    for (let guard = 0; guard < CELLS * 2 + 2; guard++) {
      this.collect(j * CELLS + i, q, out);
      if (i === iEnd && j === jEnd) break;
      if (tMaxX < tMaxZ) {
        if (tMaxX > 1) break;
        tMaxX += tDeltaX;
        i += stepI;
      } else {
        if (tMaxZ > 1) break;
        tMaxZ += tDeltaZ;
        j += stepJ;
      }
      if (i < 0 || j < 0 || i >= CELLS || j >= CELLS) break;
    }
    return out;
  }

  private next(): number {
    this.query = (this.query + 1) >>> 0;
    if (this.query === 0) {
      this.stamp.fill(0);
      this.query = 1;
    }
    return this.query;
  }

  private collect(cell: number, q: number, out: number[]): void {
    const list = this.cells[cell];
    if (!list) return;
    for (const k of list) {
      if (this.stamp[k] === q) continue;
      this.stamp[k] = q;
      out.push(k);
    }
  }
}

function cellOf(v: number): number {
  return Math.min(CELLS - 1, Math.max(0, Math.floor((v + HALF) / CELL_M)));
}
