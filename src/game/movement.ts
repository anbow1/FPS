import type { SurfaceKind } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import { type BoxCollider, type CollisionWorld, fromBoxLocalDir, toBoxLocal } from './collision.ts';

// Capsule character controller against the static world. The capsule is
// treated as an upright cylinder for walls (it never tilts), a flat foot for
// support, and a flat head for ceilings — exact for yaw boxes and cheap.

export interface CapsuleBody {
  position: Vec3; // feet, world
  velocity: Vec3;
  heightM: number;
  radiusM: number;
  grounded: boolean;
  groundSurface: SurfaceKind;
  groundNormal: Vec3;
}

export interface MoveResult {
  landed: boolean;
  impactSpeedMs: number; // vertical speed at landing, for fall damage
  hitCeiling: boolean;
}

const SNAP_DOWN_M = 0.45; // follows stairs and kerbs down without "floating" off
const SUPPORT_SHRINK = 0.5; // share of the radius that must be over a ledge to stand on it

const _near: BoxCollider[] = [];
const _local = new Vec3();
const _push = new Vec3();
const _result: MoveResult = { landed: false, impactSpeedMs: 0, hitCeiling: false };

export function moveCapsule(world: CollisionWorld, body: CapsuleBody, dtSeconds: number, stepUpM: number): MoveResult {
  _result.landed = false;
  _result.impactSpeedMs = 0;
  _result.hitCeiling = false;
  const wasGrounded = body.grounded;
  const verticalSpeedBefore = body.velocity.y;
  const p = body.position;
  // Substep so a 6 m/s sprint never tunnels through a 0.2 m wall.
  const travel = body.velocity.length() * dtSeconds;
  const substeps = Math.min(8, Math.max(1, Math.ceil(travel / (body.radiusM * 0.5))));
  const h = dtSeconds / substeps;
  for (let s = 0; s < substeps; s++) {
    p.addScaled(body.velocity, h);
    resolveWalls(world, body, stepUpM);
  }
  const supportY = supportHeight(world, p.x, p.z, body.radiusM * SUPPORT_SHRINK, p.y + stepUpM, body);
  const gap = p.y - supportY;
  if (gap <= 0.001 && body.velocity.y <= 0.01) {
    p.y = supportY;
    body.grounded = true;
  } else if (wasGrounded && gap < SNAP_DOWN_M && body.velocity.y <= 0.01) {
    p.y = supportY;
    body.grounded = true;
  } else {
    body.grounded = false;
  }
  if (body.grounded) {
    if (!wasGrounded) {
      _result.landed = true;
      _result.impactSpeedMs = -Math.min(verticalSpeedBefore, 0);
    }
    if (body.velocity.y < 0) body.velocity.y = 0;
  }
  resolveCeiling(world, body);
  return _result;
}

/** Highest standable surface under a disc, up to maxY. Terrain always counts. */
export function supportHeight(
  world: CollisionWorld,
  x: number,
  z: number,
  radiusM: number,
  maxY: number,
  bodyForSurface: CapsuleBody | null,
): number {
  let best = world.terrainHeight(x, z);
  let surface: SurfaceKind = world.terrain.surfaceAt(x, z);
  const boxes = world.queryBoxes(x - radiusM, z - radiusM, x + radiusM, z + radiusM, _near);
  for (const box of boxes) {
    if (!box.blocksMovement || box.maxY > maxY || box.maxY <= best) continue;
    toBoxLocal(box, x, z, _local);
    if (Math.abs(_local.x) <= box.halfExtents.x + radiusM && Math.abs(_local.z) <= box.halfExtents.z + radiusM) {
      best = box.maxY;
      surface = box.surface;
    }
  }
  if (bodyForSurface) {
    bodyForSurface.groundSurface = surface;
    world.terrainNormal(x, z, bodyForSurface.groundNormal);
  }
  return best;
}

function resolveWalls(world: CollisionWorld, body: CapsuleBody, stepUpM: number): void {
  const p = body.position;
  const r = body.radiusM;
  const feetClear = p.y + stepUpM; // anything lower is a step we will climb
  const head = p.y + body.heightM;
  for (let iteration = 0; iteration < 3; iteration++) {
    let moved = false;
    const boxes = world.queryBoxes(p.x - r, p.z - r, p.x + r, p.z + r, _near);
    for (const box of boxes) {
      if (!box.blocksMovement) continue;
      if (box.maxY <= feetClear || box.minY >= head - 0.05) continue;
      toBoxLocal(box, p.x, p.z, _local);
      const hx = box.halfExtents.x;
      const hz = box.halfExtents.z;
      const qx = Math.max(-hx, Math.min(hx, _local.x));
      const qz = Math.max(-hz, Math.min(hz, _local.z));
      let dx = _local.x - qx;
      let dz = _local.z - qz;
      const dist = Math.hypot(dx, dz);
      if (dist >= r) continue;
      let depth: number;
      if (dist > 1e-6) {
        dx /= dist;
        dz /= dist;
        depth = r - dist;
      } else {
        // Centre inside the footprint: leave through the nearest face.
        const px = hx - Math.abs(_local.x);
        const pz = hz - Math.abs(_local.z);
        if (px < pz) {
          dx = Math.sign(_local.x) || 1;
          dz = 0;
          depth = px + r;
        } else {
          dx = 0;
          dz = Math.sign(_local.z) || 1;
          depth = pz + r;
        }
      }
      fromBoxLocalDir(box, dx, dz, _push);
      p.x += _push.x * depth;
      p.z += _push.z * depth;
      const into = body.velocity.x * _push.x + body.velocity.z * _push.z;
      if (into < 0) {
        body.velocity.x -= _push.x * into;
        body.velocity.z -= _push.z * into;
      }
      moved = true;
    }
    if (!moved) break;
  }
}

function resolveCeiling(world: CollisionWorld, body: CapsuleBody): void {
  if (body.velocity.y <= 0 && body.grounded) return;
  const p = body.position;
  const r = body.radiusM * 0.7;
  const head = p.y + body.heightM;
  const boxes = world.queryBoxes(p.x - r, p.z - r, p.x + r, p.z + r, _near);
  for (const box of boxes) {
    if (!box.blocksMovement) continue;
    if (box.minY <= p.y + 0.3 || box.minY >= head) continue;
    toBoxLocal(box, p.x, p.z, _local);
    if (Math.abs(_local.x) > box.halfExtents.x + r || Math.abs(_local.z) > box.halfExtents.z + r) continue;
    p.y = box.minY - body.heightM;
    if (body.velocity.y > 0) body.velocity.y = 0;
    _result.hitCeiling = true;
  }
}

/** Free height above a point: how tall a capsule can stand here. */
export function headroomM(world: CollisionWorld, x: number, feetY: number, z: number, radiusM: number): number {
  let room = Infinity;
  const boxes = world.queryBoxes(x - radiusM, z - radiusM, x + radiusM, z + radiusM, _near);
  for (const box of boxes) {
    if (!box.blocksMovement || box.minY < feetY + 0.2) continue;
    toBoxLocal(box, x, z, _local);
    if (Math.abs(_local.x) > box.halfExtents.x + radiusM * 0.7 || Math.abs(_local.z) > box.halfExtents.z + radiusM * 0.7) continue;
    room = Math.min(room, box.minY - feetY);
  }
  return room;
}
