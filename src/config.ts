// All gameplay tuning in one place. Units: metres, seconds, kilograms, radians unless noted.

export const PHYS_HZ = 60;
export const PHYS_DT = 1 / PHYS_HZ;
export const GRAVITY = 9.81;

/** Size of the simulated heightfield (square, centred on origin). */
export const WORLD_SIZE = 2048;
/** Heightfield cell size. Visual LOD0 vertices land exactly on these samples. */
export const HEIGHT_CELL = 2;
/** Tanks are kept inside this half-extent; mountains rise beyond it. */
export const PLAY_HALF = 860;
export const WATER_LEVEL = 0;

export type AmmoId = 'APFSDS' | 'HEAT' | 'HE';

export interface AmmoSpec {
  id: AmmoId;
  label: string;
  /** muzzle velocity m/s */
  v0: number;
  /** quadratic drag constant: a = -k |v| v  (1/m) */
  k: number;
  /** RHA penetration (mm) at the muzzle */
  pen0: number;
  /** penetration lost per km flown (mm) — kinetic rounds only */
  penLossPerKm: number;
  /** fraction of max HP removed on a penetration */
  damage: number;
  /** impact angle from the plate normal above which the round ricochets */
  ricochetDeg: number;
  /** blast radius for splash damage to modules and dirt (0 = none) */
  blastRadius: number;
  tracer: [number, number, number];
}

// APFSDS matches the reference sheet: 0.32 s @500 m, 0.64 s @1000 m, 1.30 s @2000 m, 2.0 s @3000 m.
export const AMMO: Record<AmmoId, AmmoSpec> = {
  APFSDS: {
    id: 'APFSDS', label: 'APFSDS', v0: 1575, k: 3.4e-5, pen0: 640, penLossPerKm: 30,
    damage: 0.36, ricochetDeg: 78, blastRadius: 0, tracer: [1.0, 0.55, 0.25],
  },
  HEAT: {
    id: 'HEAT', label: 'HEAT-FS', v0: 1140, k: 1.6e-4, pen0: 480, penLossPerKm: 0,
    damage: 0.3, ricochetDeg: 72, blastRadius: 3, tracer: [1.0, 0.45, 0.2],
  },
  HE: {
    id: 'HE', label: 'HE-FRAG', v0: 880, k: 2.4e-4, pen0: 60, penLossPerKm: 0,
    damage: 0.18, ricochetDeg: 80, blastRadius: 9, tracer: [1.0, 0.4, 0.15],
  },
};

/** The gun sight is zeroed at 1000 m (0 mil holdover at 1000 m, as on the reference sheet). */
export const SIGHT_ZERO_M = 1000;

export interface TankSpec {
  name: string;
  mass: number;
  maxFwd: number; // m/s
  maxRev: number;
  powerW: number;
  maxAccel: number;
  brakeDecel: number;
  pivotRate: number; // rad/s at standstill
  runRate: number; // rad/s at max speed
  turretRate: number; // rad/s
  gunRate: number; // rad/s
  gunMin: number; // rad (negative = depression)
  gunMax: number;
  reload: number; // s
  hp: number;
  ammo: Record<AmmoId, number>;
  /** nominal armour, mm RHA equivalent (before impact-angle effect) */
  armour: {
    hullFront: number; hullSide: number; hullRear: number; hullTop: number;
    turretFront: number; turretSide: number; turretRear: number; turretTop: number;
  };
  length: number; width: number; hullHeight: number;
}

const DEG = Math.PI / 180;

export const PLAYER_TANK: TankSpec = {
  name: 'KT-2A', mass: 57000, maxFwd: 19.4, maxRev: 8.3, powerW: 1_100_000, maxAccel: 2.4,
  brakeDecel: 6.5, pivotRate: 34 * DEG, runRate: 13 * DEG, turretRate: 40 * DEG, gunRate: 7 * DEG,
  gunMin: -9 * DEG, gunMax: 20 * DEG, reload: 6.0, hp: 1000,
  ammo: { APFSDS: 22, HEAT: 12, HE: 8 },
  armour: {
    hullFront: 520, hullSide: 90, hullRear: 40, hullTop: 35,
    turretFront: 700, turretSide: 260, turretRear: 90, turretTop: 45,
  },
  length: 7.7, width: 3.7, hullHeight: 1.25,
};

export const ENEMY_TANK: TankSpec = {
  name: 'T-7X', mass: 46000, maxFwd: 16.7, maxRev: 4.8, powerW: 840_000, maxAccel: 2.0,
  brakeDecel: 6.0, pivotRate: 30 * DEG, runRate: 11 * DEG, turretRate: 24 * DEG, gunRate: 5 * DEG,
  gunMin: -5 * DEG, gunMax: 14 * DEG, reload: 8.0, hp: 850,
  ammo: { APFSDS: 99, HEAT: 99, HE: 99 },
  armour: {
    hullFront: 480, hullSide: 80, hullRear: 40, hullTop: 30,
    turretFront: 600, turretSide: 220, turretRear: 70, turretTop: 40,
  },
  length: 7.0, width: 3.6, hullHeight: 1.1,
};

export interface QualityPreset {
  id: 'high' | 'low';
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowExtent: number;
  ao: boolean;
  bloom: boolean;
  grassPerChunk: number;
  grassRadius: number;
  treeNearDist: number;
  maxParticles: number;
  wreckShadow: boolean;
}

export const QUALITY: Record<'high' | 'low', QualityPreset> = {
  high: {
    id: 'high', pixelRatioCap: 1.5, shadowMapSize: 4096, shadowExtent: 140, ao: true, bloom: true,
    grassPerChunk: 5200, grassRadius: 90, treeNearDist: 420, maxParticles: 5000, wreckShadow: true,
  },
  low: {
    id: 'low', pixelRatioCap: 1, shadowMapSize: 2048, shadowExtent: 110, ao: false, bloom: true,
    grassPerChunk: 1800, grassRadius: 55, treeNearDist: 250, maxParticles: 2500, wreckShadow: false,
  },
};

/** Perf budget ceilings from the performance reference sheet. */
export const BUDGET = {
  high: { drawCalls: 2500, trianglesM: 12 },
  low: { drawCalls: 1500, trianglesM: 4 },
  frameMs: 14,
};
