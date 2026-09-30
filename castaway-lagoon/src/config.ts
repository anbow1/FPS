// Every tunable for the lagoon, in SI units, with its source. Logic and render
// both read from here; nothing else holds a magic number that a designer would
// want to change (rules §10).

const DEG = Math.PI / 180;

export const WATER_LEVEL_M = 0;

export const PHYSICS = {
  stepSeconds: 1 / 60, // fixed 60 Hz step, rules §5
  maxStepsPerFrame: 5, // after a long stall we drop time instead of spiralling
  gravityMs2: 9.81,
  airDensityKgM3: 1.225, // ISA sea level
  speedOfSoundMs: 343, // air at ~20 °C
} as const;

export const LAGOON_PLAYER = {
  eyeHeightM: 1.68, // scale sheet: 1.83 m soldier, eye ~0.15 m below the crown
  radiusM: 0.32,
  walkSpeedMs: 3.2, // brisk walk on sand; the FPS jog is 3.5
  sprintSpeedMs: 6.0, // scale sheet sprint
  wadeSpeedFactor: 0.55, // knee-deep water roughly halves walking pace
  maxWadeDepthM: 1.25, // stones lost deeper than ~0.9 m of this are gone for good
  // Swimming (game/player.ts). Deeper than swimDepthM the walker floats, eye just above the chop.
  swimDepthM: 1.5,
  floatEyeAboveWaterM: 0.12,
  swimSpeedMs: 1.0, // breaststroke
  swimSprintMs: 1.6, // front crawl
  diveSpeedMs: 1.1,
  ascendSpeedMs: 1.3,
  swimResponse: 2.5, // 1/s: water drag, velocity settles in ~0.4 s
  swimStrokeSeconds: 1.1,
  breathSeconds: 45, // a relaxed breath-hold
  breathRecoveryPerS: 6, // seconds of air regained per second at the surface
  // Soft world border: past borderStartM from the lagoon's centre a current pushes you back.
  borderStartM: 165,
  borderEndM: 190,
  borderCurrentMs: 2.2,
  groundAccelMs2: 30, // tuned by hand: reaches walk speed in ~0.1 s, no instant stop
  groundFrictionMs2: 22,
  airAccelMs2: 4,
  jumpSpeedMs: 4.2, // ~0.9 m apex, a standing jump
  stepHeightM: 0.45, // stairs, the shelter floor and dock steps
  strideM: 1.5, // one footstep sound per stride at walk speed
  interactRangeM: 2.3,
  mouseRadPerPixel: 0.0022,
  maxPitchRad: 1.45,
} as const;

/** Stone: a beach pebble about 5 cm across. */
export const STONE = {
  radiusM: 0.028,
  massKg: 0.12,
  minThrowSpeedMs: 9, // a lob
  maxThrowSpeedMs: 24, // a hard overarm throw by an adult, ~85 km/h
  chargeSeconds: 0.75, // time to full wind-up
  releaseSeconds: 0.12, // wind-up release → stone leaves the hand
  recoverSeconds: 0.45,
  dragCoefficient: 0.47, // sphere
  restitution: 0.35, // pebble on packed sand, tuned by hand
  groundFriction: 0.55,
  skipMaxAngleRad: 20 * DEG, // stones skip below ~20° entry (Clanet et al., Nature 2004)
  skipMinSpeedMs: 7,
  skipSpeedKeep: 0.7,
  sinkSpeedMs: 0.9,
  restSpeedMs: 0.25, // below this on land it rests and can be picked up again
  maxLive: 24,
} as const;

/** AK-pattern rifle, 7.62×39 mm. Public figures only (rules §11). */
export const RIFLE = {
  magazineRounds: 30,
  startReserveRounds: 60,
  roundsPerMinute: 600,
  muzzleVelocityMs: 715,
  dragPerM: 0.0012, // quadratic drag factor k in a = −k·v·|v|, rough for a 7.62×39 ball round
  reloadSeconds: 2.6,
  reloadEmptySeconds: 3.1, // plus working the charging handle
  equipSeconds: 0.55,
  recoilPitchRad: 0.018,
  recoilYawRad: 0.006,
  recoilRecoverRatePerS: 7,
  hipSpreadRad: 0.012,
  adsSpreadRad: 0.0025,
  adsSeconds: 0.22,
  maxRangeM: 900,
  shellEjectSpeedMs: 3.5,
} as const;

export const KNIFE = {
  swingSeconds: 0.42,
  hitAtFraction: 0.45, // the blade crosses the centre of view here
  reachM: 1.6,
  equipSeconds: 0.35,
} as const;

export const INTERACT = {
  pickupSeconds: 0.5,
  harvestSeconds: 0.9,
  crateOpenSeconds: 1.1,
  /** Lying down, the night passing under a fade to black, and getting up (game.ts). */
  sleepSeconds: 4.5,
  examineMaxAngleRad: 0.2,
} as const;

export type TimeOfDayId = 'morning' | 'noon' | 'sunset' | 'night';
export type WeatherId = 'clear' | 'cloudy' | 'rain' | 'storm';

export const TIME_ORDER: readonly TimeOfDayId[] = ['morning', 'noon', 'sunset', 'night'];
export const WEATHER_ORDER: readonly WeatherId[] = ['clear', 'cloudy', 'rain', 'storm'];

export const TIME_OF_DAY: Record<TimeOfDayId, { label: string; hour: number }> = {
  morning: { label: 'Early morning', hour: 7.5 },
  noon: { label: 'Tropical noon', hour: 12.4 },
  sunset: { label: 'Golden hour', hour: 17.95 },
  night: { label: 'Night', hour: 22.5 },
};

export interface WeatherSpec {
  label: string;
  cloudCover: number; // 0..1
  sunTransmittance: number; // share of direct sun through the cloud deck
  skyFactor: number; // share of clear-sky diffuse illuminance (overcast skies are dimmer and flatter)
  rainRate: number; // 0..1 visual/audio intensity
  windMs: number;
  fogDensityPerM: number; // ground-level extinction for aerial perspective
}

// Transmittances from overcast illuminance ratios on the lighting sheet
// (overcast 8000 lx vs clear 100 000 lx); rain shafts and storms are darker still.
export const WEATHER: Record<WeatherId, WeatherSpec> = {
  clear: { label: 'Clear', cloudCover: 0.22, sunTransmittance: 1, skyFactor: 1, rainRate: 0, windMs: 3, fogDensityPerM: 0.0011 },
  cloudy: { label: 'Cloudy', cloudCover: 0.72, sunTransmittance: 0.3, skyFactor: 0.75, rainRate: 0, windMs: 5.5, fogDensityPerM: 0.0018 },
  rain: { label: 'Tropical rain', cloudCover: 0.93, sunTransmittance: 0.06, skyFactor: 0.5, rainRate: 0.5, windMs: 7, fogDensityPerM: 0.005 },
  storm: { label: 'Heavy rain', cloudCover: 1, sunTransmittance: 0.015, skyFactor: 0.32, rainRate: 1, windMs: 12, fogDensityPerM: 0.011 },
};

export const ENVIRONMENT = {
  timeTransitionSeconds: 5, // the clock sweeps to the new hour, so shadows visibly swing
  weatherTransitionSeconds: 7,
  wetUpSeconds: 25, // surfaces soak in about half a minute of tropical rain
  dryOffSeconds: 90, // and dry slowly in the heat
  puddleThreshold: 0.55, // wetness above which puddles start to form
  lightningMinGapSeconds: 7,
  lightningMaxGapSeconds: 22,
  // Sun path: rises east-south-east over the cliffs, sets west-north-west beside the lagoon mouth.
  sunriseHour: 6.1,
  sunsetHour: 18.4,
  sunriseAzimuthRad: 110 * DEG, // compass-style: 0 = −Z (north), 90° = +X (east)
  sunPathTiltRad: 20 * DEG, // peak elevation 70°: latitude ~ 15° in the dry season
  moonDirection: { x: 0.35, y: 0.62, z: -0.7 }, // high over the lagoon so it glitters on the water
} as const;

/** Physical light for the time-of-day model (lighting sheet; Kasten & Young 1989 air mass). */
export const DAYLIGHT = {
  solarConstantLux: 128000, // extraterrestrial illuminance, normal incidence
  clearOpticalDepth: 0.3, // broadband, humid tropical air
  clearSkyPeakLux: 16000, // sheet noon sky 15 000 lx
  skyElevationExponent: 0.7,
  twilightSkyLux: 400, // sky just after sunset
  moonLux: 0.3, // full moon at 40°
  nightSkyLux: 0.06, // moon-lit sky plus airglow
  nightExposureBiasEv: -2.2, // night reads as night: keep the adapted image ~2 stops under a grey card
  sunColourNoonK: 5500,
  sunColourLowK: 2400,
  skyColourK: 10000,
  moonColourK: 7600, // rendered bluish: the Purkinje shift of scotopic vision
  lampFluxLm: 250, // kerosene hurricane lantern
  lampColourK: 1900,
  fireFluxLm: 3500, // small camp fire
  fireColourK: 1800,
} as const;

export const LAGOON_EXPOSURE = {
  meterConstantK: 12.5,
  adaptDarkenSeconds: 2.0, // rules §2.2
  adaptBrightenSeconds: 0.5,
  minEvBelowAnchor: 3.5, // step into the shelter: about three stops of opening up
  maxEvAboveAnchor: 6, // at night the eye stops down hard for the camp fire and the lantern
  compensationEv: 0.6, // ACES in three.js wants a slightly brighter input than a grey card
  histogramWidth: 64,
  histogramHeight: 36,
  histogramLowPercentile: 0.5, // ignore the darkest half, as UE does
  histogramHighPercentile: 0.95, // and the sun
} as const;

export const LAGOON_CAMERA = {
  verticalFovDeg: 68,
  viewmodelFovDeg: 55, // hands drawn with their own, narrower FOV feel (rules §6)
  nearM: 0.03,
  farM: 6000, // the volcano sits ~1 km out, the sea horizon ~5 km
  bobAmplitudeM: 0.028,
  headRollRad: 0.004,
} as const;

export const WAVES = {
  // Gerstner components for a sheltered lagoon: wavelength m, amplitude m, direction (deg from +X), steepness.
  components: [
    { wavelengthM: 9.0, amplitudeM: 0.07, directionDeg: 250, steepness: 0.45 },
    { wavelengthM: 5.3, amplitudeM: 0.045, directionDeg: 225, steepness: 0.4 },
    { wavelengthM: 3.1, amplitudeM: 0.025, directionDeg: 280, steepness: 0.35 },
    { wavelengthM: 17.0, amplitudeM: 0.12, directionDeg: 240, steepness: 0.3 },
  ],
  stormAmplitudeScale: 2.6,
  // Beer–Lambert absorption of clear sea water, per metre, linear RGB (Pope & Fry 1997, broadband).
  absorptionPerM: { r: 0.45, g: 0.07, b: 0.045 },
  scatterColour: 0x0f7f86, // in-scattered turquoise over white sand
  deepColour: 0x03243a,
  /**
   * Wind sea on open water (render/ocean.ts, a Tessendorf FFT shared with Tanks): detail normals
   * where the lagoon is deeper than a few metres, faded out over the shallows, whose ripples must
   * stay the ones the caustics are splatted from. Two copies of the patch at different scales and
   * a rotation keep it from tiling visibly.
   */
  openSea: { patchM: 64, peakWavelengthM: 6.5, rmsSlope: 0.11, directionDeg: 240, fullDepthM: 10 },
} as const;

/**
 * Shoreline waves (render/shoreField.ts, render/shoreWaves.ts). The swell comes in from the open
 * sea to the north through the channel; its phase comes from a travel-time field solved over the
 * real seabed, so crests slow, shorten and bend to the depth contours, grow in the shallows
 * (Green's law) and break where they get too tall for the depth, then run up the beach.
 */
export const SHORE = {
  periodS: 3.6,
  /** Direction the swell travels (+Z is south: from the sea into the lagoon). */
  swellDir: { x: 0.12, z: 1 },
  /** Offshore amplitude (m) before the channel's losses and shoaling; ×U.waveScale in a storm. */
  amplitudeM: 0.1,
  /** Waves break once height H = 2A exceeds γ × depth (depth-limited breaking, γ ≈ 0.78). */
  breakerIndex: 0.78,
  /** Energy lost per metre travelled per metre of depth: the long shallow channel calms the lagoon. */
  channelLossPerM: 0.0055,
  /** Vertical run-up ≈ runupK × A on this gentle beach. */
  runupK: 2.1,
  /** Fractions of the period spent running up, then draining back (the rest the sheet rests). */
  swashUp: 0.4,
  swashDown: 0.55,
  /** Sand left by the swash dries over about this long (s). */
  dryTimeS: 28,
  /** Foam left behind a breaking wave fades over this long (s): well inside one period, so a calm
   * lagoon's surf zone clears between waves instead of staying white. */
  foamLifeS: 1.8,
  /** Field solve: depth range for the wave speed (m), resolution. */
  maxDepthM: 12,
  minDepthM: 0.25,
  res: 512,
} as const;

export const GRAPHICS = {
  shadowMapPx: { high: 4096, low: 1024 }, // low: phones and laptops (Mali / Adreno fill rate)
  shadowRangeM: { high: 90, low: 55 },
  grassDensity: { high: 1, low: 0.2 },
  rainDrops: { high: 14000, low: 5000 },
} as const;
