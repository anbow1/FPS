import { CITY } from '../config';
import { lineX, lineZ } from '../world/cityPlan';
import { LAKES, PLAYER_SPAWN, SITES } from '../world/layout';

// Fixed benchmark views (docs/graphics-playbook.md §9 in anbow1/FPS): the same
// spots every run, so draw calls, triangles and frame times compare before and
// after a change. The tank stands at the spot, the chase camera looks along its
// hull: spawn both ways, the village from the fields, across the big lake, and
// down the southern road, and the town: up its main avenue and from its edge.

export interface BenchSpot {
  name: string;
  x: number;
  z: number;
  /** Hull yaw: the tank faces (sin yaw, cos yaw). */
  yawRad: number;
}

/** Yaw that faces from (x, z) toward (tx, tz). */
function yawToward(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(tx - x, tz - z);
}

function spot(name: string, x: number, z: number, tx: number, tz: number): BenchSpot {
  return { name, x, z, yawRad: yawToward(x, z, tx, tz) };
}

export function benchSpots(): BenchSpot[] {
  const s = PLAYER_SPAWN;
  const village = SITES[0]!;
  const lake = LAKES[0]!;
  return [
    { name: 'spawn', x: s.x, z: s.z, yawRad: s.yaw },
    { name: 'spawn-back', x: s.x, z: s.z, yawRad: s.yaw + Math.PI },
    spot('village', village.x - 170, village.z - 120, village.x, village.z),
    spot('lake', lake.x + lake.r + 25, lake.z, lake.x, lake.z),
    spot('road', 0, -240, -500, -430),
    spot('town', lineX(CITY.blocksX / 2), lineZ(1) + 12, lineX(CITY.blocksX / 2), CITY.z1M),
    spot('town-edge', 60, CITY.z0M - 90, 0, CITY.centreZ),
  ];
}
