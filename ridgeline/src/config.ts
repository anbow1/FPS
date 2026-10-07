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
    tail: { armM: 10.4, heightM: 1.6, radiusM: 1.9, maxThrustN: 13_000, pitchLeft: 0.35, pitchRight: -1.0 },
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
    wheels: [
      [-1.25, -2.1, -2.4],
      [1.25, -2.1, -2.4],
      [0, -1.4, 9.8],
    ],
    gearStiffnessNm: 520_000,
    gearDampingNsM: 45_000,
    lengthM: 21.2,
    pilotEye: [0, 1.15, -2.6],
    gunnerEye: [0, 0.75, -4.3],
  },
};
