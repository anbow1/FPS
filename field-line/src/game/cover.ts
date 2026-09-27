import { Vec3 } from '../core/vec.ts';
import type { BoxCollider, CollisionWorld } from './collision.ts';
import type { NavGrid } from './nav.ts';

// Cover search. Any solid box between 0.8 m and 4 m tall is cover: cars,
// walls, barriers, rocks, trunks. We stand on the far side from the threat,
// hidden at the hide height, with a line of fire from the peek position.

export interface CoverSpot {
  pos: Vec3; // feet
  low: boolean; // crouch to hide, stand to fire
  leanSide: -1 | 0 | 1; // high cover: which side to lean out; 0 = pop up
  boxId: number;
}

const LOW_COVER_MAX_M = 1.35;
const HIDE_EYE_LOW_M = 0.95; // crouched eye behind low cover
const HIDE_EYE_HIGH_M = 1.6;
const PEEK_EYE_LOW_M = 1.55;
const LEAN_OFFSET_M = 0.55;

const _near: BoxCollider[] = [];
const _hideEye = new Vec3();
const _threatChest = new Vec3();
const _peek = new Vec3();
const _side = new Vec3();
const _tmp = new Vec3();

export interface CoverQuery {
  from: Vec3;
  threat: Vec3; // feet of the threat
  radiusM: number;
  /** Prefer spots further from the threat than this (fall back). */
  minThreatDistM: number;
  reserved: readonly Vec3[]; // squadmates' spots, keep 2.5 m apart
}

export function findCover(world: CollisionWorld, nav: NavGrid, q: CoverQuery): CoverSpot | null {
  const boxes = world.queryBoxes(q.from.x - q.radiusM, q.from.z - q.radiusM, q.from.x + q.radiusM, q.from.z + q.radiusM, _near);
  _threatChest.copy(q.threat);
  _threatChest.y += 1.3;
  let best: CoverSpot | null = null;
  let bestScore = -Infinity;
  for (const box of boxes) {
    if (!box.blocksMovement || !box.blocksVision) continue;
    const ground = world.terrainHeight(box.center.x, box.center.z);
    const heightM = box.maxY - ground;
    if (heightM < 0.8 || box.minY > ground + 0.3) continue;
    const footprint = Math.max(box.halfExtents.x, box.halfExtents.z);
    if (footprint > 12) continue; // a whole building: use its corners via smaller boxes
    // Behind = opposite the threat, just past the box's extent in that direction.
    _tmp.subVectors(box.center, q.threat);
    _tmp.y = 0;
    const threatDist = _tmp.length();
    if (threatDist < 4) continue;
    _tmp.scale(1 / threatDist);
    // Support distance of the box along that direction, in its own yaw frame.
    const ldx = box.cosYaw * _tmp.x - box.sinYaw * _tmp.z;
    const ldz = box.sinYaw * _tmp.x + box.cosYaw * _tmp.z;
    const extent = Math.abs(ldx) * box.halfExtents.x + Math.abs(ldz) * box.halfExtents.z + 0.55;
    const px = box.center.x + _tmp.x * extent;
    const pz = box.center.z + _tmp.z * extent;
    if (!nav.walkable(px, pz)) continue;
    if (q.reserved.some((r) => Math.hypot(r.x - px, r.z - pz) < 2.5)) continue;
    const feetY = world.terrainHeight(px, pz);
    const low = heightM < LOW_COVER_MAX_M;
    _hideEye.set(px, feetY + (low ? HIDE_EYE_LOW_M : HIDE_EYE_HIGH_M), pz);
    if (!world.lineBlocked(_hideEye, _threatChest, true)) continue; // not actually hidden
    let leanSide: -1 | 0 | 1 = 0;
    if (low) {
      _peek.set(px, feetY + PEEK_EYE_LOW_M, pz);
      if (world.lineBlocked(_peek, _threatChest, true)) continue;
    } else {
      _side.set(-_tmp.z, 0, _tmp.x);
      leanSide = 0;
      for (const s of [1, -1] as const) {
        _peek.set(px + _side.x * LEAN_OFFSET_M * s * 1.6, feetY + HIDE_EYE_HIGH_M, pz + _side.z * LEAN_OFFSET_M * s * 1.6);
        if (!world.lineBlocked(_peek, _threatChest, true)) {
          leanSide = s;
          break;
        }
      }
      if (leanSide === 0) continue;
    }
    const distFromMe = Math.hypot(px - q.from.x, pz - q.from.z);
    const distToThreat = Math.hypot(px - q.threat.x, pz - q.threat.z);
    let score = -distFromMe * 1.0;
    if (distToThreat < q.minThreatDistM) score -= (q.minThreatDistM - distToThreat) * 3;
    if (distToThreat < 10) score -= 20;
    if (low) score += 2; // low cover lets the whole body hide
    if (score > bestScore) {
      bestScore = score;
      best = { pos: new Vec3(px, feetY, pz), low, leanSide, boxId: box.id };
    }
  }
  return best;
}
