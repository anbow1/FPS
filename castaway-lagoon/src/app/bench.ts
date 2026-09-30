import type { LagoonGame } from '../game/game.ts';
import { DECK_TOP_Y, OUTPOST } from '../game/outpost.ts';
import { heightAt, ISLETS, LAGOON_CENTRE, shoreDistance } from '../game/terrain.ts';

// Fixed benchmark views (docs/graphics-playbook.md §9): the same spots every
// run, so draw calls, triangles and frame times compare before/after a change.
// Each looks where the frame is heaviest: the bay from the beach, the jungle,
// the outpost interior, open water from the islet.

export interface BenchSpot {
  name: string;
  x: number;
  y: number;
  z: number;
  yawRad: number;
  pitchRad: number;
}

/** Yaw that looks from (x, z) toward (tx, tz): the camera looks down −Z at yaw 0. */
function yawToward(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - x), -(tz - z));
}

function spot(name: string, x: number, z: number, tx: number, tz: number, pitchRad = 0, y = heightAt(x, z)): BenchSpot {
  return { name, x, y, z, yawRad: yawToward(x, z, tx, tz), pitchRad };
}

export function benchSpots(game: LagoonGame): BenchSpot[] {
  const s = game.world.spawn;
  const c = LAGOON_CENTRE;
  // The waterline straight down the beach from the spawn: walk toward the lagoon until 2 m from the water.
  let shoreZ = s.pos.z;
  while (shoreDistance(s.pos.x, shoreZ) > 2 && shoreZ > c.z) shoreZ -= 0.5;
  const islet = ISLETS[0];
  const spots: BenchSpot[] = [
    { name: 'spawn', x: s.pos.x, y: s.pos.y, z: s.pos.z, yawRad: s.yawRad, pitchRad: -0.04 },
    { name: 'spawn-back', x: s.pos.x, y: s.pos.y, z: s.pos.z, yawRad: s.yawRad + Math.PI, pitchRad: 0 },
    spot('shore', s.pos.x, shoreZ, c.x, c.z, -0.12),
    spot('jungle', s.pos.x + 12, s.pos.z + 34, c.x, c.z),
    spot('outpost', OUTPOST.x, OUTPOST.z, c.x, c.z, -0.05, DECK_TOP_Y),
  ];
  if (islet) spots.push(spot('islet', islet.x, islet.z, c.x, c.z - 300, -0.05));
  return spots;
}

/** Puts the player at a spot, standing still: interpolation sees no motion, the view settles. */
export function placePlayer(game: LagoonGame, spot: BenchSpot): void {
  const p = game.player;
  p.pos.x = p.prev.x = spot.x;
  p.pos.y = p.prev.y = spot.y;
  p.pos.z = p.prev.z = spot.z;
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.yawRad = spot.yawRad;
  p.pitchRad = spot.pitchRad;
}
