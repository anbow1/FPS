// Every tunable of Ridgeline in one place, with units (rules §1, §12). The two
// helicopters are invented types of the classes the brief names: a two-seat
// western attack helicopter (the "AH-7 Warden", AH-64 class) and a heavier
// eastern one (the "M-38 Bulat", Mi-28 class). Sizes follow scale-reference.png
// and public-spec magnitudes (mass, rotor size, power class); everything else is
// tuned for feel. Nothing here is engineering data.

export const PHYSICS = {
  /** Fixed logic step (rules §3). */
  stepSeconds: 1 / 60,
  /** Substeps per step: the flapping lag (~0.07 s) and the gear springs need ~240 Hz. */
  substeps: 4,
  maxStepsPerFrame: 6,
  gravityMs2: 9.81,
} as const;

/** International Standard Atmosphere (ISO 2533), troposphere and lower stratosphere. */
export const ISA = {
  seaLevelTemperatureK: 288.15,
  seaLevelPressurePa: 101_325,
  seaLevelDensityKgM3: 1.225,
  lapseRateKPerM: 0.0065,
  tropopauseM: 11_000,
  ceilingM: 20_000,
  gasConstantJKgK: 287.05,
  heatCapacityRatio: 1.4,
} as const;

/**
 * Stability augmentation as an attack helicopter's flight control computer
 * provides it (attitude hold in pitch and roll, heading hold in yaw), sized
 * for a game where the stick is a mouse, a thumb or a tilted phone.
 */
export const SAS = {
  /** Attitude at full cyclic deflection (rad): the stick commands an attitude and the computer holds it. */
  pitchMaxRad: 0.35,
  rollMaxRad: 0.5,
  /** Yaw rate at full pedal (rad/s); centred pedals hold the heading. */
  yawRateMaxRadS: 0.8,
  /** Attitude error → rate demand (1/s), and rate error → cyclic (per rad/s). */
  attitudeGain: 2.2,
  pitchRateGain: 1.0,
  rollRateGain: 0.9,
  /** Integral of the attitude error (cyclic per rad·s) and its limit: holds the attitude against speed and CG trim changes. */
  attitudeIntegral: 0.7,
  integralLimit: 1,
  /** Yaw: rate error → pedal (per rad/s), and its integral (the heading hold). */
  yawRateGain: 2.5,
  yawIntegral: 3,
  /** Below ~12 m/s the attitude reference leans against the drift (rad per m/s, at most), so a centred stick settles into a hover. */
  driftGainRadPerMs: 0.03,
  driftMaxRad: 0.13,
  /** Ground speed a full stick asks for at hover speeds (m/s): the lean is measured from it. */
  stickSpeedMs: 20,
  /**
   * Height hold: with SAS on the collective lever is a vertical-speed command with a neutral detent in the
   * middle — below it descend, at it hold the height, above it climb (m/s at the stops).
   */
  climbMaxMs: 8,
  descentMaxMs: 5,
  /** The most it descends straight down at hover speeds (m/s): under the vortex ring's onset. */
  verticalDescentMs: 2.5,
  leverDetent: 0.08,
  /** Vertical-speed error → collective, and its integral (which finds the hover collective by itself). */
  vsGain: 0.07,
  vsIntegral: 0.04,
  /** How fast the computer may move the collective (lever travel per second), and the torque it stays under (%). */
  collectiveRatePerS: 0.5,
  torqueLimitPct: 98,
  /** Close to the ground the commanded descent eases off to this rate per metre of height (soft touchdowns). */
  flareRatePerM: 0.35,
} as const;

export type HeliId = 'warden' | 'bulat';

export interface RotorConfig {
  radiusM: number;
  blades: number;
  chordM: number;
  /** Rotor speed at 100 % (rad/s). */
  omegaRadS: number;
  /** Blade lift-curve slope (1/rad). */
  liftSlope: number;
  /** Blade profile drag coefficient. */
  cd0: number;
  /** Collective pitch at the 3/4-radius station, bottom and top of the lever (rad). */
  collectiveMinRad: number;
  collectiveMaxRad: number;
  /** Disc tilt per full cyclic, longitudinal and lateral (rad). */
  cyclicLongRad: number;
  cyclicLatRad: number;
  /** Flapping time constant: how far the disc lags the stick and the body (s). */
  flapLagS: number;
  /** Hub moment per radian of disc tilt (N·m/rad): offset hinges make the rotor stiffer than a teeter. */
  hubStiffnessNmRad: number;
  /** Hub above the centre of gravity (m). */
  hubHeightM: number;
  /** Rotor polar moment of inertia (kg·m²): what carries the rotor through a power loss. */
  inertiaKgM2: number;
  /** +1 counter-clockwise seen from above (western), −1 clockwise (eastern): sets the torque's direction. */
  direction: 1 | -1;
  /** Induced-power factor over ideal momentum theory. */
  inducedFactor: number;
}

export interface TailRotorConfig {
  /** Behind the centre of gravity (m), +z aft. */
  armM: number;
  heightM: number;
  radiusM: number;
  /** Thrust at full pitch, 100 % rotor speed, sea level (N). */
  maxThrustN: number;
  /** Pitch range as a fraction of full: left pedal to right pedal. */
  pitchLeft: number;
  pitchRight: number;
}

export interface HeliConfig {
  id: HeliId;
  name: string;
  emptyMassKg: number;
  fuelKg: number;
  /** Mass of the loaded stores (kg). */
  storesKg: number;
  /** Moments of inertia about body x (pitch), y (yaw), z (roll) (kg·m²). */
  inertiaKgM2: [number, number, number];
  rotor: RotorConfig;
  tail: TailRotorConfig;
  /** Engines: count, maximum power each at sea level (W), response time (s). */
  engines: number;
  enginePowerW: number;
  engineLagS: number;
  /** Transmission rating: torque 100 % is this power at 100 % rotor speed (W). */
  transmissionW: number;
  /** Specific fuel consumption (kg per J). */
  sfcKgJ: number;
  /** Equivalent flat-plate drag areas along body x (side), y (vertical), z (forward) (m²). */
  dragAreaM2: [number, number, number];
  /** Fin: area (m²), arm aft (m), cambered side lift that unloads the tail rotor at speed. */
  finAreaM2: number;
  finArmM: number;
  finCamber: number;
  /** Horizontal stabilator: area (m²), arm aft (m). */
  stabAreaM2: number;
  stabArmM: number;
  /** Never-exceed speed, about where retreating blade stall starts (m/s). */
  vneMs: number;
  /** Wheels in body coordinates (m): left main, right main, tail. */
  wheels: [number, number, number][];
  gearStiffnessNm: number;
  gearDampingNsM: number;
  /** Length overall with rotors turning (m), for the cameras. */
  lengthM: number;
  /** Pilot's eye (rear seat) and gunner's eye (front seat) in body coordinates (m). */
  pilotEye: [number, number, number];
  gunnerEye: [number, number, number];
}

export const HELICOPTERS: Record<HeliId, HeliConfig> = {
  warden: {
    id: 'warden',
    name: 'AH-7 Warden',
    emptyMassKg: 5300,
    fuelKg: 1100,
    storesKg: 900,
    inertiaKgM2: [40_000, 38_000, 9000],
    rotor: {
      radiusM: 7.3,
      blades: 4,
      chordM: 0.53,
      omegaRadS: 30.4,
      liftSlope: 5.73,
      cd0: 0.0095,
      collectiveMinRad: 0.0,
      collectiveMaxRad: 0.33,
      cyclicLongRad: 0.17,
      cyclicLatRad: 0.13,
      flapLagS: 0.075,
      hubStiffnessNmRad: 160_000,
      hubHeightM: 1.9,
      inertiaKgM2: 6400,
      direction: 1,
      inducedFactor: 1.12,
    },
    tail: { armM: 9.0, heightM: 1.2, radiusM: 1.4, maxThrustN: 9500, pitchLeft: 1.0, pitchRight: -0.35 },
    engines: 2,
    enginePowerW: 1_300_000,
    engineLagS: 0.35,
    transmissionW: 2_000_000,
    sfcKgJ: 0.3 / 3.6e6,
    dragAreaM2: [16, 28, 3.2],
    finAreaM2: 3.2,
    finArmM: 8.6,
    finCamber: 0.25,
    stabAreaM2: 3.4,
    stabArmM: 8.2,
    vneMs: 84,
    wheels: [
      [-1.05, -1.75, -1.6],
      [1.05, -1.75, -1.6],
      [0, -1.15, 8.4],
    ],
    gearStiffnessNm: 380_000,
    gearDampingNsM: 32_000,
    lengthM: 17.8,
    pilotEye: [0, 0.95, -2.1],
    gunnerEye: [0, 0.6, -3.6],
  },
  bulat: {
    id: 'bulat',
    name: 'M-38 Bulat',
    emptyMassKg: 8100,
    fuelKg: 1400,
    storesKg: 1200,
    inertiaKgM2: [62_000, 58_000, 14_000],
    rotor: {
      radiusM: 8.6,
      blades: 5,
      chordM: 0.6,
      omegaRadS: 25.4,
      liftSlope: 5.73,
      cd0: 0.01,
      collectiveMinRad: 0.0,
      collectiveMaxRad: 0.33,
      cyclicLongRad: 0.15,
      cyclicLatRad: 0.11,
      flapLagS: 0.09,
      hubStiffnessNmRad: 190_000,
      hubHeightM: 2.2,
      inertiaKgM2: 11_000,
      direction: -1,
      inducedFactor: 1.14,
    },
    tail: { armM: 10.4, heightM: 1.6, radiusM: 1.9, maxThrustN: 16_000, pitchLeft: 0.35, pitchRight: -1.0 },
    engines: 2,
    enginePowerW: 1_660_000,
    engineLagS: 0.45,
    transmissionW: 2_600_000,
    sfcKgJ: 0.32 / 3.6e6,
    dragAreaM2: [22, 38, 3.8],
    finAreaM2: 4.2,
    finArmM: 10,
    finCamber: -0.25,
    stabAreaM2: 4,
    stabArmM: 9.5,
    vneMs: 90,
    // Where the downloaded model's wheels stand (shared/vehicles/heli_bulat): the mains just ahead of the
    // mast, the tail wheel under the boom, all three on the ground at rest.
    wheels: [
      [-1.3, -2.1, -0.5],
      [1.3, -2.1, -0.5],
      [0, -2.1, 9.45],
    ],
    gearStiffnessNm: 520_000,
    gearDampingNsM: 45_000,
    lengthM: 21.2,
    pilotEye: [0, 1.15, -2.6],
    gunnerEye: [0, 0.75, -4.3],
  },
};

/**
 * Weapons as game abstractions (brief: "weapons that behave like weapons
 * instead of hitscans" — every shot flies; no real ballistics, seeker or
 * fuzing data). Masses are per round, so the stores lighten as they go.
 */
export const WEAPONS = {
  gun: {
    rounds: 1200,
    muzzleMs: 805,
    roundsPerS: 10,
    /** Dispersion cone half-angle (rad): a burst lands as a pattern, not a point. */
    dispersionRad: 0.0045,
    /** Drag factor (1/m at sea level): deceleration = k·v². */
    dragPerM: 0.00022,
    /** Heat per round and cooling per second, as fractions of the limit: ~10 s bursts, then it must cool. */
    heatPerRound: 0.02,
    coolPerS: 0.09,
    /** Below this heat an overheated gun fires again. */
    resumeHeat: 0.45,
    /** Turret limits in body axes (rad): azimuth either side, elevation up and down. */
    azimuthRad: 1.9,
    elevationUpRad: 0.19,
    elevationDownRad: 1.05,
    slewRadS: 2.2,
    directDamage: 0.25,
    splashM: 3,
    massKg: 0.3,
  },
  rockets: {
    count: 38,
    ripples: [1, 4, 8] as const,
    rippleIntervalS: 0.09,
    launchMs: 45,
    burnS: 1.05,
    thrustMs2: 640,
    dragPerM: 0.0004,
    dispersionRad: 0.009,
    /** Pods are fixed: rockets leave along the shaft line, a little nose-down. */
    podDownRad: 0.035,
    directDamage: 1.8,
    splashM: 9,
    splashDamage: 0.9,
    massKg: 6.5,
  },
  /** How close to a vehicle the laser spot must fall to mark it (m). */
  laserMarkM: 18,
  missile: {
    count: 8,
    launchMs: 25,
    burnS: 3.5,
    thrustMs2: 110,
    dragPerM: 0.00011,
    /** Lateral acceleration limit (m/s²). */
    maxAccelMs2: 450,
    /** Lock: within this cone of the crew's line of sight, this range, and in clear line of sight. */
    lockConeRad: 0.1,
    lockRangeM: 8000,
    /** Top attack: climbs towards a point over the target (60 m + this share of the range, at most
     *  `loftMaxM`) and pitches over to dive onto it at about `diveRad`. */
    loftPerM: 0.3,
    loftMaxM: 350,
    diveRad: 0.96,
    fuseM: 3.5,
    damage: 4,
    splashM: 8,
    massKg: 36,
  },
} as const;

export type TargetKind = 'tank' | 'apc' | 'truck';

/**
 * Ground targets: strength in "hits", armour by aspect (damage factor for a direct hit), and how much a
 * near miss's blast and fragments do on top of that (armour shrugs them off; a truck does not).
 */
export const TARGETS: Record<TargetKind, { health: number; armour: { front: number; side: number; rear: number; top: number }; splash: number; speedMs: number }> = {
  tank: { health: 3, armour: { front: 0.08, side: 0.45, rear: 0.8, top: 1 }, splash: 0.12, speedMs: 4.5 },
  apc: { health: 1.5, armour: { front: 0.45, side: 0.85, rear: 1, top: 1 }, splash: 0.6, speedMs: 6 },
  truck: { health: 0.6, armour: { front: 1, side: 1, rear: 1, top: 1 }, splash: 1, speedMs: 7 },
};
