import type { Game } from '../game/game.ts';
import { sampleHeight } from '../maps/terrain.ts';
import type { MapData } from '../maps/types.ts';

// Fixed benchmark views per map (docs/graphics-playbook.md §9): the same spots
// every run, so draw calls, triangles and frame times compare before/after a
// change. Each looks where the frame is heaviest: across the map, at the
// squads' ground, over the lake.

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

export function benchSpots(map: MapData): BenchSpot[] {
  const s = map.playerSpawn;
  const spots: BenchSpot[] = [
    { name: 'spawn', x: s.pos.x, y: s.pos.y, z: s.pos.z, yawRad: s.yawRad, pitchRad: 0 },
    { name: 'spawn-back', x: s.pos.x, y: s.pos.y, z: s.pos.z, yawRad: s.yawRad + Math.PI, pitchRad: 0 },
  ];
  const squad = map.squadSpawns[0];
  if (squad) spots.push({ name: 'squad', x: squad.pos.x, y: squad.pos.y, z: squad.pos.z, yawRad: yawToward(squad.pos.x, squad.pos.z, s.pos.x, s.pos.z), pitchRad: 0 });
  if (map.id !== 'range') {
    const h = map.extraction.hold;
    spots.push({ name: 'extraction', x: h.x, y: h.y, z: h.z, yawRad: yawToward(h.x, h.z, s.pos.x, s.pos.z), pitchRad: 0 });
  }
  const lake = map.lake;
  if (lake) {
    // On the west bank, looking east across the water: surface, caustics, swash and far shore in one view.
    const x = lake.cx - lake.rx * 1.12;
    spots.push({ name: 'lake', x, y: sampleHeight(map.terrain, x, lake.cz), z: lake.cz, yawRad: yawToward(x, lake.cz, lake.cx, lake.cz), pitchRad: -0.12 });
  }
  return spots;
}

/** Puts the player at a spot, standing still: interpolation sees no motion, the view settles. */
export function placePlayer(game: Game, spot: BenchSpot): void {
  const p = game.player;
  p.body.position.set(spot.x, spot.y, spot.z);
  p.body.velocity.set(0, 0, 0);
  p.prevPosition.copy(p.body.position);
  p.yawRad = spot.yawRad;
  p.pitchRad = spot.pitchRad;
}
