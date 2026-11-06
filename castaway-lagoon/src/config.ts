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

/**
 * The dinghy (game/boat.ts): a 3.6 m aluminium open boat with a 6 hp outboard, rider included in
 * the mass. Drag and thrust are tuned by hand for ~5.5 m/s (11 kn) flat out and a turning circle of
 * a few boat lengths; the hydrostatics (waterplane, ρ·g) are physical.
 */
export const BOAT = {
  // A riveted aluminium runabout of 4.6 m (render/skiffModel.ts) with a 25 hp outboard, fuel and gear aboard.
  lengthM: 4.62,
  beamM: 1.62,
  massKg: 300,
  /** Share of length × beam that is waterplane (a fine bow, the chines out of the water forward). */
  waterplaneFraction: 0.56,
  /** From the reference point (still waterline) down to the keel when floating level… */
  keelBelowRefM: 0.08,
  /** …and how deep the hull is: buoyancy stops growing past this immersion. */
  hullDepthM: 0.6,
  heaveDamping: 5900, // N·s/m, all points together: as the dinghy's against the stiffer waterplane
  angularDamping: 2.2, // 1/s on pitch and roll rates
  maxThrustN: 1100,
  propSpeedMs: 9,
  reverseFraction: 0.4,
  surgeDragNs2m2: 11,
  surgeDragNsm: 25,
  swayDragNs2m2: 600,
  swayDragNsm: 300,
  yawDamping: 420,
  rudderNmPerMs2: 45,
  maxTillerRad: 0.6,
  squatNmPerKgMs: 0.35,
  /** The helm seat behind the windscreen, to port: along, up (above the reference point), across. */
  seat: { along: -0.15, up: 0.35, across: -0.35 },
  /** Over the seat: the eye just clears the low windscreen's top. */
  seatedEyeM: 0.88,
} as const;

/**
 * The old jeep (game/jeep.ts): a short-wheelbase 4×4 of about 1.1 t and 60 hp. Rolling resistance
 * and grip are typical of soft beach sand against firm turf; the rest is tuned by hand.
 */
export const JEEP = {
  lengthM: 3.4,
  widthM: 1.6,
  wheelbaseM: 2.1,
  trackM: 1.3,
  massKg: 1100,
  powerW: 45000,
  peakTractionN: 5500,
  brakeN: 9000,
  maxSpeedMs: 17,
  maxReverseMs: 4,
  rollingSand: 0.09,
  rollingFirm: 0.03,
  gripSand: 0.6,
  gripFirm: 0.85,
  aeroNs2m2: 1.2,
  maxSteerRad: 0.6,
  /** From the ground to the body's reference point (the floor, roughly over the axles). */
  rideHeightM: 0.62,
  wheelRadiusM: 0.36,
  leanPerMs2: 0.012,
  /** Water deeper than this at the nose would reach the air intake. */
  maxWadeM: 0.55,
  /** Driver's seat (left-hand drive): along, up from the reference point, across (+ right). */
  seat: { along: -0.2, up: 0.12, across: -0.38 },
  seatedEyeM: 0.8,
  /** Each headlight's peak intensity (cd): an old sealed-beam lamp on high beam. */
  headlightCd: 20000,
} as const;

/** Firewood: a split log ~45 cm long, thrown two-handed (game/bodies.ts). */
export const LOG = {
  radiusM: 0.07,
  lengthM: 0.45,
  massKg: 1.6,
  minThrowSpeedMs: 4,
  maxThrowSpeedMs: 10,
  restitution: 0.15,
} as const;

/** The camp fire's fuel, in seconds of burning (game/fire.ts). Game time, not real hardwood rates. */
export const FIRE = {
  startFuelS: 300,
  logBurnS: 150,
  maxFuelS: 600,
  /** Fuel at which the fire is at full size. */
  fullFuelS: 300,
  /** Heavy rain burns fuel this much faster (on top of 1). */
  rainBurnFactor: 0.8,
  /** A log landing this close to the pit's centre (beyond its radius) goes on the fire. */
  catchM: 0.35,
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
  // Ground-level extinction for aerial perspective. Clear humid tropical air sees 15–20 km
  // (Koschmieder 3.9 / β); at 0.0011 (3.5 km) the volcano a kilometre out was a flat sky-coloured cone.
  fogDensityPerM: number;
}

// Transmittances from overcast illuminance ratios on the lighting sheet
// (overcast 8000 lx vs clear 100 000 lx); rain shafts and storms are darker still.
export const WEATHER: Record<WeatherId, WeatherSpec> = {
  clear: { label: 'Clear', cloudCover: 0.22, sunTransmittance: 1, skyFactor: 1, rainRate: 0, windMs: 3, fogDensityPerM: 0.00025 },
  cloudy: { label: 'Cloudy', cloudCover: 0.72, sunTransmittance: 0.3, skyFactor: 0.75, rainRate: 0, windMs: 5.5, fogDensityPerM: 0.0006 },
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
  // By day the anchor is an incident reading (a grey card under this sky), which already exposes a
  // bright beach right; metering the sand and sky and stopping down further turned noon grey, the
  // sand mid-tone and the clouds no brighter than it (photo critic loop).
  maxEvAboveAnchorDay: 0.25,
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

/**
 * The player's body (game/game.ts). Hit points, not physiology: a full 100, and wounds that heal by
 * themselves only up to a point — beyond it a herb, food or a field dressing does it (Q).
 */
export const HEALTH = {
  max: 100,
  /** Without fresh damage for this long, health comes back by itself… */
  regenDelayS: 8,
  regenPerS: 1.5,
  /** …but only up to here. */
  regenCapFraction: 0.5,
  /** Healing over time from one treatment (hit points, seconds): crushed herb, aloe gel, food, a dressing. */
  treatments: [
    { item: 'medkit', hp: 60, seconds: 4, verb: 'You dress the wound' },
    { item: 'herb', hp: 30, seconds: 6, verb: 'You crush a herb onto the wound' },
    { item: 'aloe', hp: 18, seconds: 5, verb: 'You spread aloe gel on the cuts' },
    { item: 'beans', hp: 15, seconds: 8, verb: 'You eat the beans' },
    { item: 'coconut', hp: 10, seconds: 6, verb: 'You drink the coconut' },
  ],
  /** A blackout: the screen goes dark this long before waking at the shelter. */
  blackoutS: 4,
  /** Wake with this much. */
  respawnFraction: 0.6,
  /** Falling this fast onto the ground hurts (m/s at impact, damage per m/s beyond). */
  fallSafeMs: 9,
  fallDamagePerMs: 9,
} as const;

/** What a creature is, per species (game/fauna.ts). Speeds and weights are real orders of magnitude; damage is game balance. */
export interface SpeciesSpec {
  label: string;
  health: number;
  /** Bullet damage multiplier on the body (hide, scutes); the head always takes full. */
  armour: number;
  /** Ground or water speeds (m/s): wandering, stalking or circling, and flat out. */
  walkMs: number;
  stalkMs: number;
  runMs: number;
  turnRadS: number;
  /** Sight range by day and night (m), and a gunshot heard within this range (m). */
  sightM: number;
  nightSightM: number;
  hearM: number;
  /** Attack: reach (m), damage, seconds between attacks. */
  reachM: number;
  damage: number;
  cooldownS: number;
  /** Below this share of health it flees. */
  fleeFraction: number;
  /** Seconds before a dead or lost one is replaced, out of sight. */
  respawnS: number;
  /** Size scale of the model and the hit volume (1 = an adult). */
  scale: number;
}

export const SPECIES = {
  // Bengal-sized tiger: ~200 kg, sprints at ~15 m/s over short distances (here 11), ambushes from 10–20 m.
  tiger: { label: 'Tiger', health: 170, armour: 1, walkMs: 1.5, stalkMs: 1.1, runMs: 11, turnRadS: 3.2, sightM: 45, nightSightM: 60, hearM: 220, reachM: 2.2, damage: 34, cooldownS: 2.2, fleeFraction: 0.25, respawnS: 240, scale: 1 },
  // Wild boar: ~80 kg, charges at ~10 m/s (here 7.5), tusk slash.
  boar: { label: 'Wild boar', health: 80, armour: 1, walkMs: 0.9, stalkMs: 1.4, runMs: 7.5, turnRadS: 2.4, sightM: 18, nightSightM: 14, hearM: 120, reachM: 1.3, damage: 17, cooldownS: 1.4, fleeFraction: 0.3, respawnS: 150, scale: 1 },
  // Saltwater crocodile: 4 m, swims ~4 m/s in bursts, lunges ~10 m/s over a body length.
  croc: { label: 'Crocodile', health: 200, armour: 0.55, walkMs: 0.8, stalkMs: 1.2, runMs: 9, turnRadS: 2, sightM: 22, nightSightM: 22, hearM: 60, reachM: 2.4, damage: 40, cooldownS: 3, fleeFraction: 0.3, respawnS: 300, scale: 1 },
  // Reef/bull shark: 2.5–3 m, cruises at ~1.5 m/s, attacks at ~8 m/s.
  shark: { label: 'Shark', health: 140, armour: 0.8, walkMs: 1.4, stalkMs: 2.4, runMs: 8, turnRadS: 1.8, sightM: 35, nightSightM: 35, hearM: 0, reachM: 1.8, damage: 42, cooldownS: 5, fleeFraction: 0.2, respawnS: 240, scale: 1 },
} as const satisfies Record<string, SpeciesSpec>;

export type SpeciesId = keyof typeof SPECIES;

/**
 * Guerrillas (game/guerrillas.ts): irregulars in a jungle camp west of the beach, with AKs. Their
 * aim is deliberately human: a cone that tightens while they hold still on a target they can see.
 */
export const GUERRILLA = {
  health: 100,
  walkMs: 1.4,
  runMs: 4.2,
  sightM: 70,
  nightSightM: 28,
  /** A lit lamp or the camp fire shows the player at night from this far. */
  litSightM: 60,
  fovRad: 2.1,
  hearM: 160,
  /** Seconds of clear sight before they shoot (shorter once alerted). */
  noticeS: 1.4,
  engageMinM: 12,
  engageMaxM: 45,
  burstMin: 2,
  burstMax: 5,
  roundsPerMinute: 600,
  burstPauseS: [0.9, 2.2] as const,
  /** Aim error (rad, standard deviation) at first sight, and the floor it settles to. */
  spreadStartRad: 0.07,
  spreadFloorRad: 0.012,
  spreadSettleS: 2.5,
  /** Damage per hit on the player (torso), and the head multiplier. */
  damage: 13,
  headMultiplier: 2,
  magazineRounds: 30,
  reloadS: 2.8,
  /** Damage on them per part, as a multiplier of the player's AK round (RIFLE_DAMAGE). */
  partMultiplier: { head: 3, torso: 1, limb: 0.6 },
  /** Patrol size and how many at the camp. */
  patrolSize: 2,
  campSize: 3,
  respawnS: 200,
  /** A raid on the shelter every so often (s), while the player is near it. */
  raidEveryS: [240, 420] as const,
  raidSize: 3,
} as const;

/** The player's 7.62 round on a body (hit points), and the knife and a thrown stone. */
export const WEAPON_DAMAGE = {
  rifle: 42,
  knife: 45,
  stone: 6,
} as const;
