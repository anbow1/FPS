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
/** Everything that flies: tank rounds plus the infantry rocket. */
export type ProjectileId = AmmoId | 'RPG';

export interface AmmoSpec {
  id: ProjectileId;
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
  /**
   * Size of what the round does beyond its penetration (blast against infantry, crater, flash, spall,
   * damage through the armour) relative to a tank gun's round: 1 when absent, ~0.25 for 30 mm.
   */
  scale?: number;
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

/** RPG-7 type rocket with a tandem-less HEAT warhead (~500 mm RHA), unguided, 295 m/s sustained. */
export const RPG_ROCKET: AmmoSpec = {
  id: 'RPG', label: 'RPG', v0: 295, k: 3.5e-4, pen0: 500, penLossPerKm: 0,
  damage: 0.26, ricochetDeg: 70, blastRadius: 2.5, tracer: [1.0, 0.55, 0.2],
};

/** Small-arms rounds (projectile sheet): 7.62 mm 838 m/s → 0.78 s @500 m; 5.56 mm 920 m/s → 0.77 s @500 m. */
export interface BulletSpec {
  v0: number;
  k: number;
  damage: number;
}
export const MG_762: BulletSpec = { v0: 838, k: 1.045e-3, damage: 70 };
export const RIFLE_556: BulletSpec = { v0: 920, k: 1.38e-3, damage: 55 };
export const HMG_127: BulletSpec = { v0: 890, k: 5.5e-4, damage: 140 };
/** The coax laid with its own ballistics (FCS "MG" mode). */
export const MG_AIM: AmmoSpec = {
  id: 'HE', label: 'KM 7,62', v0: MG_762.v0, k: MG_762.k, pen0: 0, penLossPerKm: 0, damage: 0, ricochetDeg: 0, blastRadius: 0, tracer: [1, 0.3, 0.2],
};

export const DRONE = {
  maxSpeed: 17, // m/s horizontal
  climb: 6, // m/s
  accel: 9,
  battery: 160, // s
  range: 1700, // m radio range from the tank
  ceiling: 220, // m above ground
  hp: 30,
  spares: 3,
  rearm: 40, // s to prepare the next airframe
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
  /** The gun's own rounds in place of the tank gun's (an IFV's autocannon), by the slot they load from. */
  rounds?: Partial<Record<AmmoId, AmmoSpec>>;
  /**
   * Hit points a penetration takes, relative to a tank's share (1 when absent): an IFV's thin hull holds
   * crew, ammunition and fuel close together, and a tank round through it is nearly always a kill.
   */
  vulnerability?: number;
  /** Rounds fired from one halt before relocating (an autocannon's burst); 2-3 aimed shots when absent. */
  burst?: number;
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

// 30 mm autocannon (the IFVs): APDS at ~1000 m/s goes through ~60 mm at 1000 m, a tank's side, rear
// and roof but not its front; HE-T bursts against crews, optics and tracks. 300-odd rounds a minute in
// bursts: one round every 0.25 s. Drag from the velocity lost over 1 km (v = v0·e^(-k·x)): APDS
// 1000 → 800 m/s, HE-T 960 → 700 m/s.
const AP30: AmmoSpec = {
  id: 'APFSDS', label: 'APDS 30 mm', v0: 1000, k: 2.2e-4, pen0: 75, penLossPerKm: 18,
  damage: 0.05, ricochetDeg: 70, blastRadius: 0, tracer: [1.0, 0.5, 0.25], scale: 0.25,
};
const HE30: AmmoSpec = {
  id: 'HE', label: 'HE-T 30 mm', v0: 960, k: 3.2e-4, pen0: 12, penLossPerKm: 0,
  damage: 0.03, ricochetDeg: 75, blastRadius: 1.8, tracer: [1.0, 0.45, 0.2], scale: 0.25,
};

/** Light tracked IFV, 30 mm gun: the enemy's (front-engined, aluminium and thin steel). */
export const ENEMY_IFV: TankSpec = {
  name: 'BWP-30', mass: 14300, maxFwd: 18.0, maxRev: 4.5, powerW: 224_000, maxAccel: 2.2,
  brakeDecel: 6.5, pivotRate: 40 * DEG, runRate: 15 * DEG, turretRate: 35 * DEG, gunRate: 20 * DEG,
  gunMin: -5 * DEG, gunMax: 60 * DEG, reload: 0.25, hp: 450,
  ammo: { APFSDS: 999, HEAT: 999, HE: 999 },
  armour: {
    hullFront: 30, hullSide: 18, hullRear: 16, hullTop: 10,
    turretFront: 30, turretSide: 20, turretRear: 15, turretTop: 10,
  },
  length: 6.7, width: 3.15, hullHeight: 0.95,
  rounds: { APFSDS: AP30, HEAT: HE30, HE: HE30 },
  vulnerability: 2.6,
  burst: 8,
};

/** The player's escort: a heavier IFV with spaced side armour; its 25 mm gun shares the 30 mm's ballistics. */
export const ALLY_IFV: TankSpec = {
  ...ENEMY_IFV,
  name: 'BWP-25', mass: 27600, maxFwd: 16.9, powerW: 450_000, turretRate: 40 * DEG,
  armour: {
    hullFront: 45, hullSide: 30, hullRear: 20, hullTop: 15,
    turretFront: 45, turretSide: 30, turretRear: 20, turretTop: 15,
  },
  length: 6.55, width: 3.6, hullHeight: 1.2,
  vulnerability: 2.2,
};

export interface QualityPreset {
  id: 'high' | 'low';
  /** Desktop ceiling on the device pixel ratio (phones always cap at 2). */
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowExtent: number;
  ao: boolean;
  bloom: boolean;
  grassPerChunk: number;
  grassRadius: number;
  /** Full tree meshes within this distance (m); impostors beyond (world/vegetation.ts). */
  treeNearDist: number;
  maxParticles: number;
  wreckShadow: boolean;
}

export const QUALITY: Record<'high' | 'low', QualityPreset> = {
  high: {
    // GTAO off: with the reversed depth buffer three r186's GTAO marks every face turned toward the camera
    // as fully occluded (a tank's rear, a trunk, a shaded wall rendered at a quarter of their light, near
    // black); the sky probe's ground bounce already lights shaded faces. Measured in docs/graphics-playbook.md §11.
    id: 'high', pixelRatioCap: 2, shadowMapSize: 4096, shadowExtent: 140, ao: false, bloom: true,
    grassPerChunk: 5200, grassRadius: 90, treeNearDist: 320, maxParticles: 5000, wreckShadow: true,
  },
  low: {
    id: 'low', pixelRatioCap: 1.5, shadowMapSize: 2048, shadowExtent: 110, ao: false, bloom: true,
    grassPerChunk: 1800, grassRadius: 55, treeNearDist: 200, maxParticles: 2500, wreckShadow: false,
  },
};

/** Perf budget ceilings from the performance reference sheet. */
export const BUDGET = {
  high: { drawCalls: 2500, trianglesM: 12 },
  low: { drawCalls: 1500, trianglesM: 4 },
  frameMs: 14,
};

/**
 * The town in the north third of the map (world/cityPlan.ts). A regular grid of streets with an
 * avenue every few lines, perimeter blocks of tenements, prefab estates, an industrial edge, parks
 * and a square; the street-lamp and storey numbers are typical of a Central European town.
 */
export const CITY = {
  /** Rectangle the blocks fill (m); the ring streets run on its edges. ~0.92 km², a third of the play area. */
  x0M: -820,
  x1M: 820,
  z0M: 270,
  z1M: 820,
  /** Blocks across x and z (grid pitch = size / count: 102.5 m × 78.6 m). */
  blocksX: 16,
  blocksZ: 7,
  /** Every n-th grid line is an avenue (counted from the west and south ring streets). */
  avenueEveryX: 4,
  avenueEveryZ: 3,
  /** Half the carriageway (m): two lanes plus a parking lane on a street, four lanes on an avenue. */
  streetHalfM: 5.5,
  avenueHalfM: 8,
  /** Pavement width on each side (m). */
  streetWalkM: 4,
  avenueWalkM: 5,
  /** Storey heights (m): tenement floor to floor, a shop ground floor, a prefab panel storey. */
  tenementFloorM: 3.3,
  shopGroundM: 4.4,
  prefabFloorM: 2.8,
  /** Window bay (m): one window and its pier. Frontages are even numbers of bays; tenements are four bays deep (13–16 m). */
  bayMinM: 3.3,
  bayMaxM: 3.9,
  /** The downtown centre; storeys fall off with distance from it. */
  centreX: 0,
  centreZ: 545,
  /** Street lamps: spacing along a kerb, mast height, peak intensity straight down, colour. */
  lampSpacingM: 32,
  lampHeightM: 8,
  lampIntensityCd: 2500,
  lampColourK: 3000,
  /** Luminance of a lit room seen through its window at night (cd/m²) and the share of rooms lit. */
  windowLuminanceCdM2: 25,
  windowsLitShare: 0.38,
  /** Luminance of a lamp's LED lens (cd/m²). */
  lampLensCdM2: 20000,
  /** Sky illuminance (lx) below which street lamps and room lights are on. */
  lightsOnSkyLux: 60,
  /**
   * Display ceilings (pre-exposed) for the windows and lenses: at night the scene's exposure puts a
   * lit room 200× over mid-grey, a white blob; the eye adapts locally and still sees it warm. Tuned
   * by eye against the night and moon presets. The light pools get the same treatment: under the
   * night preset's exposure a 39 lx pool is 20 000× the scene and bloomed the street white.
   */
  windowDisplayCap: 1.2,
  lensDisplayCap: 12,
  /** Ceiling on the lamps' pre-exposed intensity for the pools (cd × exposure): pavement peaks ~0.6. */
  poolDisplayCapCd: 340,
} as const;
