import { WATER_LEVEL_M } from '../config.ts';
import type { Rng } from '../core/rng.ts';
import { type CollisionWorld, newHit, type RayHit } from './colliders.ts';
import type { EventQueue, P3, ThreatKind } from './events.ts';
import type { Player } from './player.ts';
import { heightAt } from './terrain.ts';

// What the creatures and the guerrillas know about the world each step, and
// the senses and footing they share: line of sight through trunks and leaves,
// the ground or the water under a point, and the player as a target.

export interface ThreatContext {
  dt: number;
  timeS: number;
  rng: Rng;
  events: EventQueue;
  collision: CollisionWorld;
  player: Player;
  /** The player's eye and look direction (unit). */
  eye: P3;
  look: P3;
  /** Blacked out: nothing attacks a body on the ground. */
  playerDown: boolean;
  /** 0 day … 1 night. */
  night: number;
  /** The camp fire, if burning: animals keep away from it at night. */
  fire: P3 | null;
  lampLit: boolean;
  /** A loud noise this step (a gunshot) and how far it carries (m), or null. */
  noise: { pos: P3; radiusM: number } | null;
  /** Deals damage to the player. */
  hurtPlayer(amount: number, from: P3, cause: ThreatKind): void;
}

const hit: RayHit = newHit();
const dir: P3 = { x: 0, y: 0, z: 0 };

/** Water depth under a point (m); negative on dry land. */
export function depthAt(x: number, z: number): number {
  return WATER_LEVEL_M - heightAt(x, z);
}

/**
 * Line of sight from `a` to `b`: 0 blocked by terrain or a trunk, 1 clear, ½ through foliage (the
 * jungle hides as much as it shows).
 */
export function sightLine(collision: CollisionWorld, a: P3, b: P3): number {
  dir.x = b.x - a.x;
  dir.y = b.y - a.y;
  dir.z = b.z - a.z;
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 0.01) return 1;
  dir.x /= len;
  dir.y /= len;
  dir.z /= len;
  if (collision.raycast(a, dir, len, hit, false) && hit.distanceM < len - 0.4) return 0;
  return collision.leavesAlong(a, dir, len) ? 0.5 : 1;
}

/** Yaw that faces from (x, z) toward (tx, tz) (forward is −Z at yaw 0, as for the player). */
export function bearing(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - x), -(tz - z));
}

export function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Turns `yaw` toward `target` by at most `rate·dt`. */
export function turnToward(yaw: number, target: number, rate: number, dt: number): number {
  const d = wrapAngle(target - yaw);
  const step = rate * dt;
  return wrapAngle(yaw + Math.max(-step, Math.min(step, d)));
}

/**
 * Trunks ahead: a sideways push (−1 left … 1 right) away from the nearest tree trunk within `aheadM`
 * of a walker at (x, z) facing `yaw`, or 0. Cheap steering instead of a nav mesh: the jungle is open
 * between trunks.
 */
export function trunkAvoidance(collision: CollisionWorld, x: number, z: number, yaw: number, aheadM: number): number {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  let push = 0;
  let best = aheadM;
  for (const i of collision.query(x + fx * aheadM * 0.5, z + fz * aheadM * 0.5, aheadM)) {
    const c = collision.colliders[i];
    if (!c || c.kind !== 'cylinder') continue;
    const dx = c.x - x;
    const dz = c.z - z;
    const along = dx * fx + dz * fz;
    if (along < 0 || along > best) continue;
    const across = dx * -fz + dz * fx; // + to the right of the walker
    if (Math.abs(across) > c.radiusM + 0.7) continue;
    best = along;
    push = across >= 0 ? -1 : 1;
  }
  return push;
}
