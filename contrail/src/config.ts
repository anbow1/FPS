// Every tunable of Contrail in one place, with units (rules §1, §12). Aircraft
// numbers are public-spec level (size, mass, thrust class) or tuned by hand for
// feel; nothing here is engineering data. The two airframes are invented types
// of the two classes the brief names: a single-seat stealth fighter (the
// "V-17 Wraith", F-35 class) and a large twin-engine super-manoeuvrable fighter
// (the "K-27 Talon", Su-35 class). Dimensions from scale-reference.png.

export const PHYSICS = {
  /** Fixed logic step (rules §3). */
  stepSeconds: 1 / 60,
  /** The flight model integrates in substeps: the rate controllers are stiff and 60 Hz Euler rings at high dynamic pressure. */
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
  /** The model is valid to 20 km; the game's ceiling is ~18 km. */
  ceilingM: 20_000,
  gasConstantJKgK: 287.05,
  heatCapacityRatio: 1.4,
} as const;

export type AircraftId = 'wraith' | 'talon';

export interface AeroConfig {
  /** Reference wing area (m²). */
  wingAreaM2: number;
  /** Wing span (m), scale sheet. */
  spanM: number;
  /** Mean aerodynamic chord (m) ≈ S / b. */
  chordM: number;
  /** Polhamus vortex-lift constant: the strakes and LERX keep lift rising to high AoA. */
  vortexLiftK: number;
  /** Angle of attack where the vortices burst and lift breaks (rad). */
  stallAoaRad: number;
  /** Width of the stall break (rad). */
  stallWidthRad: number;
  /** Zero-lift drag below the drag rise. */
  cd0Subsonic: number;
  /** Extra zero-lift drag through the transonic rise (peak near Mach 1.1). */
  cd0WaveRise: number;
  /** Oswald efficiency for the induced drag factor k = 1 / (π e A). */
  oswald: number;
  /** Static pitch stability Cmα (1/rad); slightly stable so the jet still flies when the limiter is relaxed. */
  cmAlpha: number;
  /** Pitch damping Cmq (per q·c̄/2V). */
  cmq: number;
  /** Largest pitch moment coefficient the tailplanes can make. */
  cmControl: number;
  /** Roll damping Clp (per p·b/2V). */
  clp: number;
  /** Largest roll moment coefficient (ailerons + differential tails). */
  clControl: number;
  /** Dihedral effect Clβ (1/rad). */
  clBeta: number;
  /** Weathervane stability Cnβ (1/rad). */
  cnBeta: number;
  /** Yaw damping Cnr (per r·b/2V). */
  cnr: number;
  /** Largest yaw moment coefficient (rudders). */
  cnControl: number;
  /** Side force per sideslip CYβ (1/rad). */
  cyBeta: number;
}

export interface EngineConfig {
  engines: number;
  /** Sea-level static thrust per engine at military power, dry (N). */
  dryThrustN: number;
  /** Sea-level static thrust per engine in full afterburner (N). */
  wetThrustN: number;
  /** Thrust gain with Mach from ram pressure, dry and wet: T ∝ (1 + ram·M). */
  ramDry: number;
  ramWet: number;
  /** Mach where the inlet starts to choke the engine (fixed inlet earlier, variable later). */
  inletLimitMach: number;
  /** Time for the core to spool from idle to military (s). */
  spoolUpS: number;
  spoolDownS: number;
  /** Afterburner light-off delay (s). */
  lightOffS: number;
  /** Specific fuel consumption, dry and wet (kg per N per s). 0.88 and 1.95 lb/lbf/h, typical turbofan values. */
  tsfcDryKgNs: number;
  tsfcWetKgNs: number;
  /** Thrust vectoring: nozzle deflection (rad) and its moment arm from the centre of mass (m); 0 = fixed nozzle. */
  vectorRad: number;
  vectorArmM: number;
}

export interface MassConfig {
  emptyKg: number;
  internalFuelKg: number;
  /** Moments of inertia at the reference mass (kg·m²): roll, pitch, yaw (rules §5: per axis, per aircraft). */
  inertiaRollKgM2: number;
  inertiaPitchKgM2: number;
  inertiaYawKgM2: number;
  referenceMassKg: number;
}

export interface LimiterConfig {
  /** Positive and negative load-factor limits with the limiter engaged. */
  gMax: number;
  gMin: number;
  /** AoA limit with the limiter engaged (rad). */
  aoaMaxRad: number;
  /** Relaxed: the pilot can pull past these; the airframe complains (overstress warning). */
  relaxedGMax: number;
  relaxedAoaMaxRad: number;
  /** Commanded roll rate at full stick (rad/s). */
  rollRateMaxRadS: number;
  /** Pitch rate ceiling at low speed (rad/s). */
  pitchRateMaxRadS: number;
}

export interface GearLeg {
  /** Attachment in body axes (m); the wheel hangs `travelM` below it when the strut is extended. */
  x: number;
  y: number;
  z: number;
  travelM: number;
  /** Share of the aircraft's weight this leg carries at rest. */
  loadShare: number;
  nose: boolean;
}

export interface GearConfig {
  legs: GearLeg[];
  /** Strut compression at rest (m) — sets the spring rate. */
  staticCompressionM: number;
  /** Damping ratio of each strut. */
  dampingRatio: number;
  /** Sink rate above which the gear collapses (m/s). */
  maxSinkMs: number;
  /** Extra zero-lift drag with the gear down. */
  dragCd0: number;
  /** Seconds to retract or extend. */
  cycleS: number;
  /** Lift added by the automatic flaps with the gear down (ΔCL). */
  flapCl: number;
  /** Nose-wheel steering angle at full pedal (rad). */
  steerRad: number;
}

export interface AircraftConfig {
  id: AircraftId;
  name: string;
  /** Scale sheet: length, wingspan, height (m). */
  lengthM: number;
  heightM: number;
  aero: AeroConfig;
  engine: EngineConfig;
  mass: MassConfig;
  limiter: LimiterConfig;
  /** Radar cross-section factor, front / side (1 = ordinary fighter); used by the radar game abstraction later. */
  signatureFront: number;
  signatureSide: number;
  gear: GearConfig;
}

const DEG = Math.PI / 180;

export const AIRCRAFT: Record<AircraftId, AircraftConfig> = {
  wraith: {
    id: 'wraith',
    name: 'V-17 Wraith',
    lengthM: 15.7,
    heightM: 4.33,
    aero: {
      wingAreaM2: 42.7,
      spanM: 10.7,
      chordM: 4.0,
      vortexLiftK: 2.0,
      stallAoaRad: 38 * DEG,
      stallWidthRad: 4 * DEG,
      // Internal stores keep the clean drag low.
      cd0Subsonic: 0.021,
      cd0WaveRise: 0.026,
      oswald: 0.8,
      cmAlpha: -0.12,
      cmq: -4.0,
      cmControl: 0.3,
      clp: -0.35,
      clControl: 0.08,
      clBeta: -0.08,
      cnBeta: 0.12,
      cnr: -0.25,
      cnControl: 0.05,
      cyBeta: -0.8,
    },
    engine: {
      engines: 1,
      dryThrustN: 125_000,
      wetThrustN: 191_000,
      ramDry: 0.25,
      ramWet: 0.65,
      inletLimitMach: 1.55,
      spoolUpS: 3.0,
      spoolDownS: 2.0,
      lightOffS: 0.35,
      tsfcDryKgNs: 2.49e-5,
      tsfcWetKgNs: 5.52e-5,
      vectorRad: 0,
      vectorArmM: 0,
    },
    mass: {
      emptyKg: 13_300,
      internalFuelKg: 8_300,
      inertiaRollKgM2: 25_000,
      inertiaPitchKgM2: 140_000,
      inertiaYawKgM2: 160_000,
      referenceMassKg: 18_500,
    },
    limiter: {
      gMax: 9,
      gMin: -3,
      aoaMaxRad: 30 * DEG,
      relaxedGMax: 11,
      relaxedAoaMaxRad: 55 * DEG,
      rollRateMaxRadS: 220 * DEG,
      pitchRateMaxRadS: 30 * DEG,
    },
    // Tuned by hand: seen from ahead it is a fraction of an ordinary fighter; from the side it is ordinary.
    signatureFront: 0.12,
    signatureSide: 1,
    gear: {
      legs: [
        { x: 0, y: -1.65, z: -4.6, travelM: 0.6, loadShare: 0.12, nose: true },
        { x: 1.6, y: -1.55, z: 0.9, travelM: 0.6, loadShare: 0.44, nose: false },
        { x: -1.6, y: -1.55, z: 0.9, travelM: 0.6, loadShare: 0.44, nose: false },
      ],
      staticCompressionM: 0.14,
      dampingRatio: 0.55,
      maxSinkMs: 4.0,
      dragCd0: 0.018,
      cycleS: 6,
      flapCl: 0.35,
      steerRad: (30 * Math.PI) / 180,
    },
  },
  talon: {
    id: 'talon',
    name: 'K-27 Talon',
    lengthM: 21.9,
    heightM: 5.9,
    aero: {
      wingAreaM2: 62,
      spanM: 15.3,
      chordM: 4.05,
      vortexLiftK: 1.8,
      stallAoaRad: 40 * DEG,
      stallWidthRad: 5 * DEG,
      // External pylons and a bigger airframe: more parasitic drag.
      cd0Subsonic: 0.024,
      cd0WaveRise: 0.024,
      oswald: 0.82,
      cmAlpha: -0.1,
      cmq: -4.5,
      cmControl: 0.32,
      clp: -0.32,
      clControl: 0.075,
      clBeta: -0.09,
      cnBeta: 0.11,
      cnr: -0.25,
      cnControl: 0.055,
      cyBeta: -0.85,
    },
    engine: {
      engines: 2,
      dryThrustN: 86_000,
      wetThrustN: 142_000,
      ramDry: 0.25,
      ramWet: 0.7,
      // Variable inlets keep the engines fed to a higher Mach.
      inletLimitMach: 2.1,
      spoolUpS: 3.5,
      spoolDownS: 2.2,
      lightOffS: 0.4,
      tsfcDryKgNs: 2.6e-5,
      tsfcWetKgNs: 5.7e-5,
      // Thrust vectoring: the whole character of this aircraft at low speed.
      vectorRad: 15 * DEG,
      vectorArmM: 7.5,
    },
    mass: {
      emptyKg: 19_000,
      internalFuelKg: 11_500,
      inertiaRollKgM2: 55_000,
      inertiaPitchKgM2: 320_000,
      inertiaYawKgM2: 360_000,
      referenceMassKg: 25_300,
    },
    limiter: {
      gMax: 9,
      gMin: -3,
      // A looser limiter than the Wraith's.
      aoaMaxRad: 35 * DEG,
      relaxedGMax: 10,
      relaxedAoaMaxRad: 90 * DEG,
      rollRateMaxRadS: 200 * DEG,
      pitchRateMaxRadS: 28 * DEG,
    },
    signatureFront: 1.2,
    signatureSide: 1.4,
    gear: {
      legs: [
        { x: 0, y: -2.25, z: -6.2, travelM: 0.75, loadShare: 0.12, nose: true },
        { x: 2.2, y: -2.15, z: 1.6, travelM: 0.75, loadShare: 0.44, nose: false },
        { x: -2.2, y: -2.15, z: 1.6, travelM: 0.75, loadShare: 0.44, nose: false },
      ],
      staticCompressionM: 0.16,
      dampingRatio: 0.55,
      maxSinkMs: 4.0,
      dragCd0: 0.02,
      cycleS: 7,
      flapCl: 0.35,
      steerRad: (30 * Math.PI) / 180,
    },
  },
};

/** Pilot G tolerance (tuned by hand against the brief: grey-out above a sustained 7 G). */
export const G_TOLERANCE = {
  /** Above this the blood pool drains. */
  drainOnsetG: 5.5,
  /** Drain per second per G above onset. */
  drainPerGs: 0.055,
  /** Recovery per second below `recoverBelowG`. */
  recoverPerS: 0.12,
  recoverBelowG: 4,
  /** Negative G at which red-out starts building. */
  redOutOnsetG: -1.5,
  redOutPerGs: 0.18,
} as const;
