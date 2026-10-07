// Hand-authored map layout: lakes, flattened building sites and dirt roads.
// Everything else (hills, forests, rocks) is procedural from the seed.

export interface Lake { x: number; z: number; r: number; depth: number }
export interface Site { x: number; z: number; r: number }
export type Road = ReadonlyArray<readonly [number, number]>;

export const LAKES: Lake[] = [
  { x: -360, z: 250, r: 190, depth: 5 },
  { x: 430, z: -400, r: 130, depth: 4 },
];

export const SITES: Site[] = [
  { x: 60, z: -40, r: 120 }, // village
  { x: -500, z: -430, r: 55 }, // farm SW
  { x: 540, z: 380, r: 55 }, // farm NE
  { x: -620, z: 560, r: 45 }, // barn NW
];

export const ROADS: Road[] = [
  [[-900, 120], [-640, 60], [-420, -10], [-160, -70], [60, -40], [260, 60], [420, 220], [540, 380], [700, 560], [900, 640]],
  [[60, -40], [0, -240], [-160, -360], [-500, -430], [-660, -640], [-760, -900]],
  [[60, -40], [240, -200], [300, -560], [240, -900]],
  [[-420, -10], [-520, 250], [-620, 560], [-560, 900]],
];

export const PLAYER_SPAWN = { x: -250, z: -620, yaw: 0.6 };
