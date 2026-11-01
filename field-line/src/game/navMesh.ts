import { init, type NavMesh as RecastNavMesh, NavMeshQuery } from '@recast-navigation/core';
import { generateTiledNavMesh } from '@recast-navigation/generators';
import { Vec3 } from '../core/vec.ts';
import type { CollisionWorld } from './collision.ts';
import type { Navigation } from './nav.ts';

// A navigation mesh for the city maps, built at load with Recast (recastnavigation, via
// recast-navigation-js, MIT) from the same colliders the bodies collide with. Unlike the
// ground grid (nav.ts) it has floors over floors: the AI goes up the stairs of an enterable
// building, through its rooms and out onto a balcony, and Detour's paths cut corners exactly
// along the walls instead of along grid cells.
//
// The agent is the soldier's capsule, 1.7 m tall, climbing steps up to the 0.42 m the capsule
// controller steps (movement.ts). The mesh keeps 0.25 m (one voxel) off the walls, less than the
// capsule's 0.35 m: the controller slides the body along a wall on its own, and a full radius off
// both sides would close a 1.4 m stair flight and a 0.9 m door to the mesh.

const CELL_M = 0.25;
const CELL_H_M = 0.1;
const AGENT_RADIUS_M = 0.25;
const AGENT_HEIGHT_M = 1.7;
const AGENT_CLIMB_M = 0.42;
/** Tiles of 48 voxels (12 m): each built alone, so memory stays small on a 400 m map. */
const TILE_VX = 48;
/** How far above and below a point a query looks for the mesh (m): a storey's reach, not two. */
const QUERY_HALF = { x: 1.5, y: 1.2, z: 1.5 };
/** Searches allowed per 60 Hz step across all soldiers (as the grid's, nav.ts). */
const SEARCHES_PER_STEP = 2;

let ready: Promise<void> | null = null;

/** Loads the Recast module (WASM inlined in the package); await once before building a NavMesh. */
export function initNavMesh(): Promise<void> {
  ready ??= init();
  return ready;
}

export class NavMesh implements Navigation {
  readonly layered = true;
  private readonly mesh: RecastNavMesh;
  private readonly query: NavMeshQuery;
  private searchesLeft = SEARCHES_PER_STEP;

  constructor(
    private readonly world: CollisionWorld,
    readonly halfSizeM: number,
  ) {
    const { positions, indices } = collisionTriangles(world, halfSizeM);
    const vx = (m: number): number => Math.ceil(m / CELL_M);
    const vy = (m: number): number => Math.ceil(m / CELL_H_M);
    const result = generateTiledNavMesh(positions, indices, {
      cs: CELL_M,
      ch: CELL_H_M,
      tileSize: TILE_VX,
      walkableSlopeAngle: 46,
      walkableHeight: vy(AGENT_HEIGHT_M),
      walkableClimb: Math.floor(AGENT_CLIMB_M / CELL_H_M),
      walkableRadius: vx(AGENT_RADIUS_M),
      maxEdgeLen: vx(12),
      maxSimplificationError: 1.3,
      minRegionArea: 8,
      mergeRegionArea: 20,
      maxVertsPerPoly: 6,
      detailSampleDist: CELL_M * 6,
      detailSampleMaxError: CELL_H_M,
      bounds: [
        [-halfSizeM, -2, -halfSizeM],
        [halfSizeM, 40, halfSizeM],
      ],
    });
    if (!result.success) throw new Error(`navigation mesh: ${result.error}`);
    this.mesh = result.navMesh;
    this.query = new NavMeshQuery(this.mesh);
    this.query.defaultQueryHalfExtents = QUERY_HALF;
  }

  beginStep(): void {
    this.searchesLeft = SEARCHES_PER_STEP;
  }

  reserveSearch(): boolean {
    if (this.searchesLeft <= 0) return false;
    this.searchesLeft--;
    return true;
  }

  /** On the mesh at ground level here (cover spots are chosen on the ground, cover.ts). */
  walkable(x: number, z: number): boolean {
    const y = this.world.terrainHeight(x, z);
    const r = this.query.findClosestPoint({ x, y, z }, { halfExtents: { x: 0.2, y: 0.6, z: 0.2 } });
    return r.success && r.isPointOverPoly && Math.abs(r.point.x - x) < 0.05 && Math.abs(r.point.z - z) < 0.05;
  }

  /** The nearest point of the mesh to (x, z) at ground level, within a few metres, or null. */
  nearestWalkable(x: number, z: number, out: Vec3): Vec3 | null {
    const y = this.world.terrainHeight(x, z);
    const r = this.query.findClosestPoint({ x, y, z }, { halfExtents: { x: 4, y: 1.0, z: 4 } });
    if (!r.success || r.polyRef === 0) return null;
    return out.set(r.point.x, r.point.y, r.point.z);
  }

  /** A straight path along the mesh from `from` to `to` (without the start), or null. */
  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    const r = this.query.computePath({ x: from.x, y: from.y, z: from.z }, { x: to.x, y: to.y, z: to.z });
    if (!r.success || r.path.length === 0) return null;
    const out = r.path.slice(1).map((p) => new Vec3(p.x, p.y, p.z));
    return out.length > 0 ? out : [new Vec3(to.x, to.y, to.z)];
  }

  dispose(): void {
    this.query.destroy();
    this.mesh.destroy();
  }
}

/**
 * Every collider as triangles for Recast: the terrain within the map (two per height sample cell)
 * and each box that blocks movement (its eight corners turned by its yaw). Recast marks what an
 * agent can stand on and erodes it by the radius round everything else.
 */
function collisionTriangles(world: CollisionWorld, halfSizeM: number): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  const t = world.terrain;
  const x0 = Math.max(t.originX, -halfSizeM - t.cellM);
  const z0 = Math.max(t.originZ, -halfSizeM - t.cellM);
  const x1 = Math.min(t.originX + (t.samplesX - 1) * t.cellM, halfSizeM + t.cellM);
  const z1 = Math.min(t.originZ + (t.samplesZ - 1) * t.cellM, halfSizeM + t.cellM);
  const nx = Math.round((x1 - x0) / t.cellM);
  const nz = Math.round((z1 - z0) / t.cellM);
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * t.cellM;
      const z = z0 + j * t.cellM;
      pos.push(x, world.terrainHeight(x, z), z);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      // Wound so (c − a) × (b − a) points up: Recast walks only on faces whose normal does.
      idx.push(a, c, b, b, c, d);
    }
  }
  // Box faces: corner k has bits (x, y, z) = (k & 1, k & 2, k & 4). What matters is the top's
  // winding: Recast takes (v1 − v0) × (v2 − v0) as the normal and walks only on faces whose normal
  // points up, so the top runs 2 → 6 → 7 → 3. The sides are vertical (never walkable) either way.
  const faces = [
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [0, 4, 5, 1],
    [2, 6, 7, 3],
    [0, 1, 3, 2],
    [4, 6, 7, 5],
  ] as const;
  for (const box of world.boxes) {
    if (!box.blocksMovement) continue;
    if (box.maxX < -halfSizeM - 2 || box.minX > halfSizeM + 2 || box.maxZ < -halfSizeM - 2 || box.minZ > halfSizeM + 2) continue;
    const base = pos.length / 3;
    const h = box.halfExtents;
    for (let k = 0; k < 8; k++) {
      const lx = k & 1 ? h.x : -h.x;
      const ly = k & 2 ? h.y : -h.y;
      const lz = k & 4 ? h.z : -h.z;
      // The same turn as the collision world's (collision.ts: local → world by cos/sin of yaw).
      pos.push(box.center.x + lx * box.cosYaw + lz * box.sinYaw, box.center.y + ly, box.center.z - lx * box.sinYaw + lz * box.cosYaw);
    }
    for (const [a, b, c, d] of faces) idx.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
