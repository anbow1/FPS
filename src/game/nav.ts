import { Vec3 } from '../core/vec.ts';
import type { BoxCollider, CollisionWorld } from './collision.ts';

// Ground-level navigation grid + A*. AI walks outdoors and through ground
// floors; stairs and rooftops belong to the player (documented limitation).

const BODY_LOW_M = 0.45; // anything below this is a step
const BODY_HIGH_M = 1.7;
const MAX_SLOPE_RISE_PER_CELL = 0.9; // tuned by hand: blocks cliffs, allows the ridge path

export class NavGrid {
  readonly cells: Uint8Array; // 1 = walkable
  readonly size: number;
  private readonly gScore: Float32Array;
  private readonly parent: Int32Array;
  private readonly closedStamp: Uint32Array;
  private readonly openStamp: Uint32Array;
  private stamp = 1;
  private readonly heap: number[] = [];
  private readonly heapF: number[] = [];

  constructor(
    private readonly world: CollisionWorld,
    readonly halfSizeM: number,
    readonly cellM: number,
  ) {
    this.size = Math.ceil((halfSizeM * 2) / cellM);
    const n = this.size * this.size;
    this.cells = new Uint8Array(n);
    this.gScore = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.closedStamp = new Uint32Array(n);
    this.openStamp = new Uint32Array(n);
    this.build();
  }

  private build(): void {
    const near: BoxCollider[] = [];
    const r = this.cellM * 0.45;
    const local = new Vec3();
    for (let iz = 0; iz < this.size; iz++) {
      for (let ix = 0; ix < this.size; ix++) {
        const x = this.cellX(ix);
        const z = this.cellZ(iz);
        const g = this.world.terrainHeight(x, z);
        let ok = Math.abs(x) < this.halfSizeM - 2 && Math.abs(z) < this.halfSizeM - 2;
        if (ok) {
          const slope = Math.max(
            Math.abs(this.world.terrainHeight(x + this.cellM, z) - g),
            Math.abs(this.world.terrainHeight(x, z + this.cellM) - g),
          );
          if (slope > MAX_SLOPE_RISE_PER_CELL * this.cellM * 0.5) ok = false;
        }
        if (ok) {
          // Floor slabs raise the standing height a little; take the highest low box.
          let floor = g;
          for (const box of this.world.queryBoxes(x - r, z - r, x + r, z + r, near)) {
            if (!box.blocksMovement) continue;
            if (!insideXZ(box, x, z, r, local)) continue;
            if (box.maxY <= g + BODY_LOW_M && box.maxY > floor) floor = box.maxY;
          }
          for (const box of near) {
            if (!box.blocksMovement) continue;
            if (box.maxY <= floor + BODY_LOW_M || box.minY >= floor + BODY_HIGH_M) continue;
            if (insideXZ(box, x, z, r, local)) {
              ok = false;
              break;
            }
          }
        }
        this.cells[iz * this.size + ix] = ok ? 1 : 0;
      }
    }
  }

  cellX(ix: number): number {
    return -this.halfSizeM + (ix + 0.5) * this.cellM;
  }

  cellZ(iz: number): number {
    return -this.halfSizeM + (iz + 0.5) * this.cellM;
  }

  indexOf(x: number, z: number): number {
    const ix = Math.floor((x + this.halfSizeM) / this.cellM);
    const iz = Math.floor((z + this.halfSizeM) / this.cellM);
    if (ix < 0 || iz < 0 || ix >= this.size || iz >= this.size) return -1;
    return iz * this.size + ix;
  }

  walkable(x: number, z: number): boolean {
    const i = this.indexOf(x, z);
    return i >= 0 && this.cells[i] === 1;
  }

  /** Nearest walkable cell centre within a few cells, or null. */
  nearestWalkable(x: number, z: number, out: Vec3): Vec3 | null {
    const i0 = this.indexOf(x, z);
    if (i0 >= 0 && this.cells[i0] === 1) return out.set(x, 0, z);
    for (let ring = 1; ring < 8; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const px = x + dx * this.cellM;
          const pz = z + dz * this.cellM;
          if (this.walkable(px, pz)) return out.set(px, 0, pz);
        }
      }
    }
    return null;
  }

  /** Straight walkable line between two points (grid sampling). */
  lineWalkable(ax: number, az: number, bx: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / (this.cellM * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.walkable(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  /** A* from a to b. Returns a smoothed list of waypoints (without the start), or null. */
  findPath(from: Vec3, to: Vec3, maxExpansions = 25000): Vec3[] | null {
    const startPos = this.nearestWalkable(from.x, from.z, new Vec3());
    const goalPos = this.nearestWalkable(to.x, to.z, new Vec3());
    if (!startPos || !goalPos) return null;
    const start = this.indexOf(startPos.x, startPos.z);
    const goal = this.indexOf(goalPos.x, goalPos.z);
    if (start < 0 || goal < 0) return null;
    this.stamp++;
    const stamp = this.stamp;
    const size = this.size;
    const gx = goal % size;
    const gz = Math.floor(goal / size);
    this.heap.length = 0;
    this.heapF.length = 0;
    this.gScore[start] = 0;
    this.parent[start] = -1;
    this.openStamp[start] = stamp;
    this.push(start, heuristic(start % size, Math.floor(start / size), gx, gz));
    let expansions = 0;
    let found = false;
    while (this.heap.length > 0 && expansions++ < maxExpansions) {
      const current = this.pop();
      if (current === goal) {
        found = true;
        break;
      }
      if (this.closedStamp[current] === stamp) continue;
      this.closedStamp[current] = stamp;
      const cx = current % size;
      const cz = Math.floor(current / size);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
          const ni = nz * size + nx;
          if (this.cells[ni] !== 1 || this.closedStamp[ni] === stamp) continue;
          // No corner cutting.
          if (dx !== 0 && dz !== 0 && (this.cells[cz * size + nx] !== 1 || this.cells[nz * size + cx] !== 1)) continue;
          const g = (this.gScore[current] as number) + (dx !== 0 && dz !== 0 ? 1.4142 : 1);
          if (this.openStamp[ni] === stamp && g >= (this.gScore[ni] as number)) continue;
          this.openStamp[ni] = stamp;
          this.gScore[ni] = g;
          this.parent[ni] = current;
          this.push(ni, g + heuristic(nx, nz, gx, gz));
        }
      }
    }
    if (!found) return null;
    const raw: Vec3[] = [];
    for (let i = goal; i !== -1 && i !== start; i = this.parent[i] as number) {
      raw.push(new Vec3(this.cellX(i % size), 0, this.cellZ(Math.floor(i / size))));
    }
    raw.reverse();
    raw[raw.length - 1]?.set(goalPos.x, 0, goalPos.z);
    return this.smooth(from, raw);
  }

  private smooth(from: Vec3, raw: Vec3[]): Vec3[] {
    const out: Vec3[] = [];
    let anchorX = from.x;
    let anchorZ = from.z;
    let i = 0;
    while (i < raw.length) {
      let j = raw.length - 1;
      while (j > i && !this.lineWalkable(anchorX, anchorZ, (raw[j] as Vec3).x, (raw[j] as Vec3).z)) j--;
      const p = raw[j] as Vec3;
      out.push(p);
      anchorX = p.x;
      anchorZ = p.z;
      i = j + 1;
    }
    return out;
  }

  private push(index: number, f: number): void {
    const h = this.heap;
    const hf = this.heapF;
    h.push(index);
    hf.push(f);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((hf[p] as number) <= f) break;
      h[i] = h[p] as number;
      hf[i] = hf[p] as number;
      i = p;
    }
    h[i] = index;
    hf[i] = f;
  }

  private pop(): number {
    const h = this.heap;
    const hf = this.heapF;
    const top = h[0] as number;
    const lastI = h.pop() as number;
    const lastF = hf.pop() as number;
    if (h.length > 0) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        let mf = lastF;
        if (l < n && (hf[l] as number) < mf) {
          m = l;
          mf = hf[l] as number;
        }
        if (r < n && (hf[r] as number) < mf) m = r;
        if (m === i) break;
        h[i] = h[m] as number;
        hf[i] = hf[m] as number;
        i = m;
      }
      h[i] = lastI;
      hf[i] = lastF;
    }
    return top;
  }
}

function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
}

function insideXZ(box: BoxCollider, x: number, z: number, r: number, local: Vec3): boolean {
  const ox = x - box.center.x;
  const oz = z - box.center.z;
  local.set(box.cosYaw * ox - box.sinYaw * oz, 0, box.sinYaw * ox + box.cosYaw * oz);
  return Math.abs(local.x) <= box.halfExtents.x + r && Math.abs(local.z) <= box.halfExtents.z + r;
}
