// Every tunable in the game lives here, in SI units, with a source or a
// "tuned by hand" note. Systems import from this file; they hold no magic numbers.

export const PHYSICS = {
  stepSeconds: 1 / 60, // fixed 60 Hz step, rules §5
  maxStepsPerFrame: 5, // after a long stall we drop time instead of spiralling
  gravityMs2: 9.81,
  airDensityKgM3: 1.225, // ISA sea level
  speedOfSoundMs: 340.3, // ISA 15 °C, matches the ballistics sheet generator
} as const;

export const PLAYER = {
  heightStandM: 1.83, // scale sheet: infantry soldier H 1.83 m
  heightCrouchM: 1.25,
  heightProneM: 0.55,
  radiusM: 0.35,
  massKg: 80,
  eyeStandM: 1.7, // scale sheet eye heights
  eyeCrouchM: 1.15,
  eyeProneM: 0.45,
  walkSpeedMs: 1.4,
  jogSpeedMs: 3.5,
  sprintSpeedMs: 6.0,
  crouchSpeedMs: 1.6, // tuned by hand: a crouched jog
  proneSpeedMs: 0.45, // tuned by hand: a steady crawl
  // Force model: drive force = mass · accel toward the target speed; ground
  // friction decelerates when there is no input. Values tuned by hand for a
  // ~0.35 s ramp to jog and a ~0.25 s stop, which reads as "weight" at 60 fps.
  groundAccelMs2: 11,
  groundFrictionMs2: 14,
  airAccelMs2: 1.5,
  jumpSpeedMs: 3.6, // ~0.66 m hop with gear on
  stepUpM: 0.42, // climbs a kerb (0.15 m) and a stair riser (0.17 m) with margin
  stanceChangeSeconds: 0.35,
  slideMinSpeedMs: 5.0, // crouch above this speed starts a slide
  slideFrictionMs2: 3.2, // tuned by hand: ~1.6 s slide from sprint speed
  staminaMaxSeconds: 9, // sprint time from full
  staminaRecoverPerSecond: 0.8, // standing still, relative to drain
  staminaRecoverSeatedMultiplier: 2.2, // crouch or prone recover faster
  staminaMinToSprint: 1.5,
  fallDamageStartM: 4,
  fallBrokenLegM: 8,
  fallDamagePerM: 12, // health points per metre above the threshold
  brokenLegSeconds: 20,
  limpSpeedMultiplier: 0.55,
  /** Water this deep (m) halves the movement speed; shallower water slows proportionally. */
  wadeDepthForHalfSpeedM: 1.0,
  /** Deeper water than this (m) forbids going prone. */
  maxProneWaterM: 0.15,
  breathHoldSeconds: 6,
  breathRecoverPenaltySeconds: 3,
  breathPenaltySwayMultiplier: 2,
  // Hearing radii of the player's own noise (for AI perception), metres.
  noiseRadiusSprintM: 35,
  noiseRadiusJogM: 18,
  noiseRadiusWalkM: 8,
  noiseRadiusCrouchM: 4,
  noiseRadiusProneM: 1.5,
} as const;

export const HEALTH = {
  permanentMax: 100,
  bufferMax: 25, // small regenerating layer on top of the permanent pool
  bufferRegenDelaySeconds: 5,
  bufferRegenPerSecond: 6,
  bleedBelowPermanent: 40, // bleeding starts under this many permanent HP
  bleedPerSecond: 0.8,
  medKitHeal: 50,
  medKitSeconds: 6,
  medKitCarriedMax: 2,
  ammoPackSeconds: 4,
  ammoPackCarriedMax: 1,
  armourPlateHits: 3,
  armourAbsorbFraction: 0.85, // share of chest damage the plate stops while intact
} as const;

// Body-part multipliers and effects (damage model brief).
export const HITBOX = {
  headMultiplier: 4.0,
  chestMultiplier: 1.0,
  abdomenMultiplier: 1.1,
  armMultiplier: 0.6,
  legMultiplier: 0.65,
  legLimpSeconds: 8,
  armSwaySeconds: 10,
  armSwayMultiplier: 2.2,
} as const;

// Penetration: energy (J) a round loses per metre of material it passes through.
// Tuned by hand so a 5.56 round (~1700 J) passes 2 cm of sheet steel, a door and
// a plywood wall, but stops in 20 cm of concrete. Not engineering data.
export const MATERIAL_PENETRATION_J_PER_M: Record<SurfaceKind, number> = {
  concrete: 60000,
  brick: 45000,
  asphalt: 80000,
  soil: 25000,
  rock: 90000,
  wood: 2500,
  sheetMetal: 40000,
  glass: 200,
  fabric: 400,
  foliage: 30,
  flesh: 4000,
  armourPlate: 1e9,
};

export type SurfaceKind =
  | 'concrete'
  | 'brick'
  | 'asphalt'
  | 'soil'
  | 'rock'
  | 'wood'
  | 'sheetMetal'
  | 'glass'
  | 'fabric'
  | 'foliage'
  | 'flesh'
  | 'armourPlate';

export interface RoundSpec {
  name: string;
  muzzleVelocityMs: number;
  g7BallisticCoefficient: number; // lb/in² — public ammunition data, as on the sheet
  bulletMassKg: number;
  zeroRangeM: number;
  sightHeightM: number;
  damage: number; // health points at muzzle energy; scales with energy retained
}

// Values copied from references/_generate_references.py ROUNDS table.
export const ROUND_556: RoundSpec = {
  name: '5.56 mm',
  muzzleVelocityMs: 920,
  g7BallisticCoefficient: 0.151,
  bulletMassKg: 0.004,
  zeroRangeM: 300,
  sightHeightM: 0.065,
  damage: 38,
};

export const ROUND_MAGNUM: RoundSpec = {
  name: 'magnum',
  muzzleVelocityMs: 880,
  g7BallisticCoefficient: 0.31,
  bulletMassKg: 0.0162,
  zeroRangeM: 300,
  sightHeightM: 0.065,
  damage: 120,
};

export const ROUND_PISTOL: RoundSpec = {
  name: '9 mm',
  muzzleVelocityMs: 370, // public spec class for a 9 mm pistol round
  g7BallisticCoefficient: 0.07,
  bulletMassKg: 0.008,
  zeroRangeM: 25,
  sightHeightM: 0.02,
  damage: 26,
};

export type WeaponId = 'rifle' | 'sniper' | 'pistol';

export interface WeaponSpec {
  id: WeaponId;
  displayName: string;
  round: RoundSpec;
  magazineSize: number;
  magazinesCarriedMax: number;
  roundsPerMinute: number;
  autoCapable: boolean;
  boltAction: boolean;
  boltCycleSeconds: number;
  tacticalReloadSeconds: number;
  emptyReloadSeconds: number;
  adsSeconds: number;
  recoilPitchRad: number; // aim kick per shot
  recoilYawRad: number; // max horizontal component, seeded
  recoilRecoverRadS: number; // recovery speed toward original point of aim
  visualKickM: number; // viewmodel slide back per shot (separate from aim kick)
  hipSpreadRad: number; // base hip cone half-angle
  hipSpreadMoveRad: number; // added at sprint speed
  hipSpreadPerShotRad: number;
  adsSpreadRad: number;
  swayRad: number; // idle breathing sway amplitude while ADS
  hearingRadiusM: number; // AI hears a shot within this distance
  suppressedHearingRadiusM: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  rifle: {
    id: 'rifle',
    displayName: 'AR-5 carbine',
    round: ROUND_556,
    magazineSize: 30,
    magazinesCarriedMax: 6,
    roundsPerMinute: 750,
    autoCapable: true,
    boltAction: false,
    boltCycleSeconds: 0,
    tacticalReloadSeconds: 2.2,
    emptyReloadSeconds: 2.9,
    adsSeconds: 0.22,
    recoilPitchRad: 0.0075,
    recoilYawRad: 0.0035,
    recoilRecoverRadS: 0.09,
    visualKickM: 0.035,
    hipSpreadRad: 0.012,
    hipSpreadMoveRad: 0.035,
    hipSpreadPerShotRad: 0.004,
    adsSpreadRad: 0.0006, // ~2 MOA mechanical + ammo dispersion
    swayRad: 0.0012,
    hearingRadiusM: 250,
    suppressedHearingRadiusM: 60,
  },
  sniper: {
    id: 'sniper',
    displayName: 'LR-9 bolt rifle',
    round: ROUND_MAGNUM,
    magazineSize: 5,
    magazinesCarriedMax: 5,
    roundsPerMinute: 40,
    autoCapable: false,
    boltAction: true,
    boltCycleSeconds: 1.05,
    tacticalReloadSeconds: 3.0,
    emptyReloadSeconds: 3.6,
    adsSeconds: 0.38,
    recoilPitchRad: 0.035,
    recoilYawRad: 0.006,
    recoilRecoverRadS: 0.12,
    visualKickM: 0.07,
    hipSpreadRad: 0.03,
    hipSpreadMoveRad: 0.06,
    hipSpreadPerShotRad: 0,
    adsSpreadRad: 0.00015, // ~0.5 MOA
    swayRad: 0.0022,
    hearingRadiusM: 450,
    suppressedHearingRadiusM: 90,
  },
  pistol: {
    id: 'pistol',
    displayName: 'P-17 pistol',
    round: ROUND_PISTOL,
    magazineSize: 17,
    magazinesCarriedMax: 3,
    roundsPerMinute: 400,
    autoCapable: false,
    boltAction: false,
    boltCycleSeconds: 0,
    tacticalReloadSeconds: 1.5,
    emptyReloadSeconds: 1.9,
    adsSeconds: 0.15,
    recoilPitchRad: 0.012,
    recoilYawRad: 0.005,
    recoilRecoverRadS: 0.12,
    visualKickM: 0.03,
    hipSpreadRad: 0.018,
    hipSpreadMoveRad: 0.03,
    hipSpreadPerShotRad: 0.005,
    adsSpreadRad: 0.002,
    swayRad: 0.002,
    hearingRadiusM: 120,
    suppressedHearingRadiusM: 30,
  },
};

export const SCOPE = {
  magnifications: [4, 10] as const,
  eyeReliefM: 0.085, // distance from eye to ocular lens when ADS
  // Eye-relief penalty: shadow ring closes as the eye leaves the exit pupil.
  exitPupilRadiusM: 0.0045,
  renderScale: 0.5, // ≤ ½ resolution, budget sheet game-specific slot
  milDotSpacingRad: 0.001,
  redDotRadiusRad: 0.00058, // 2 MOA dot
} as const;

export type GrenadeKind = 'frag' | 'smoke' | 'flash';

export const GRENADES = {
  fuseFragSeconds: 4.5,
  fuseSmokeSeconds: 1.8,
  fuseFlashSeconds: 1.6,
  throwSpeedMs: 16,
  throwUpBiasRad: 0.12,
  massKg: 0.4,
  restitution: 0.3,
  fragLethalRadiusM: 5,
  fragMaxRadiusM: 14,
  fragMaxDamage: 180,
  smokeDurationSeconds: 45,
  smokeGrowSeconds: 6,
  smokeMaxRadiusM: 7,
  flashRadiusM: 18,
  flashBlindSeconds: 5,
  flashConeCos: 0.5, // AI must be facing within ~60° to be blinded
  startCount: { frag: 2, smoke: 2, flash: 1 } as Record<GrenadeKind, number>,
  cookPreviewSteps: 120,
} as const;

export const AI = {
  squadSize: 4,
  visionRangeM: 180,
  visionHalfAngleRad: 1.05, // ~120° cone
  visionFalloffStartM: 40, // detection builds slower past this
  detectionSecondsAtNear: 0.35,
  detectionSecondsAtFar: 3.0,
  proneDetectionMultiplier: 0.35, // prone player is harder to see
  crouchDetectionMultiplier: 0.65,
  alertSearchSeconds: 25,
  engageLoseSightSeconds: 6,
  burstRounds: [3, 6] as const,
  burstPauseSeconds: [0.6, 1.6] as const,
  firstBurstSpreadRad: 0.05, // miss believably, then tighten
  settledSpreadRad: 0.012,
  spreadTightenSeconds: 6,
  reactionSeconds: 0.45,
  grenadeCampSeconds: 8, // player stays within campRadius for this long → grenade
  campRadiusM: 3,
  grenadeCooldownSeconds: 14,
  flankDelaySeconds: 3,
  coverSearchRadiusM: 30,
  leanSeconds: 1.6,
  hideSeconds: 1.8,
  walkSpeedMs: 1.5,
  runSpeedMs: 4.2,
  health: 100,
  armourHits: 2,
  rifleDamageScale: 0.55, // AI rounds tuned by hand for a fair fight
} as const;

export const MODES = {
  extractionHoldSeconds: 60,
  extractionRadiusM: 10,
  extractionWaveSeconds: 35,
  rangeTargetDistancesM: [100, 200, 300, 400, 500, 600, 700, 800] as const,
} as const;

// Lighting presets, straight from lighting-reference.png. Sun and sky are
// split so that sun + sky ≈ the sheet's ground illuminance.
export type LightingPresetId = 'noon' | 'overcast' | 'golden';

export interface LightingPreset {
  id: LightingPresetId;
  label: string;
  groundIlluminanceLux: number;
  ev100: number;
  sunIlluminanceLux: number;
  skyIlluminanceLux: number;
  sunColourK: number;
  skyColourK: number;
  sunElevationRad: number;
  sunAzimuthRad: number;
  turbidity: number;
  cloudCover: number; // 0..1
  fogDensityPerM: number; // at ground level
  fogHeightFalloffPerM: number;
  shadowSoftness: number; // PCF radius multiplier; overcast has no hard key
}

const DEG = Math.PI / 180;

export const LIGHTING: Record<LightingPresetId, LightingPreset> = {
  noon: {
    id: 'noon',
    label: 'Clear noon',
    groundIlluminanceLux: 1e5,
    ev100: 15.3,
    sunIlluminanceLux: 85000,
    skyIlluminanceLux: 15000,
    sunColourK: 5500,
    skyColourK: 10000,
    sunElevationRad: 65 * DEG, // sheet: 60–75°
    sunAzimuthRad: 150 * DEG,
    turbidity: 2.2,
    cloudCover: 0.25,
    fogDensityPerM: 0.00006,
    fogHeightFalloffPerM: 0.006,
    shadowSoftness: 1,
  },
  overcast: {
    id: 'overcast',
    label: 'Overcast',
    groundIlluminanceLux: 8000,
    ev100: 11.6,
    sunIlluminanceLux: 600, // sheet: no direct key; a trace keeps form readable
    skyIlluminanceLux: 7400,
    sunColourK: 6500,
    skyColourK: 7000,
    sunElevationRad: 50 * DEG,
    sunAzimuthRad: 170 * DEG,
    turbidity: 9,
    cloudCover: 1,
    fogDensityPerM: 0.0004,
    fogHeightFalloffPerM: 0.004,
    shadowSoftness: 6,
  },
  golden: {
    id: 'golden',
    label: 'Golden hour',
    groundIlluminanceLux: 12000,
    ev100: 12.2,
    sunIlluminanceLux: 8500,
    skyIlluminanceLux: 3500,
    sunColourK: 3200,
    skyColourK: 9000,
    sunElevationRad: 7 * DEG, // long shadows, warm rim
    sunAzimuthRad: 250 * DEG,
    turbidity: 4,
    cloudCover: 0.3,
    fogDensityPerM: 0.00015,
    fogHeightFalloffPerM: 0.005,
    shadowSoftness: 1.4,
  },
};

export const EXPOSURE = {
  // Standard reflected-light meter constant K = 12.5 (ISO 2720).
  meterConstantK: 12.5,
  // Eye adaptation speeds (rules §2.2): bright→dark slow, dark→bright fast.
  adaptDarkenSeconds: 2.0,
  adaptBrightenSeconds: 0.5,
  // EV100 clamp per map, relative to the preset EV — an interior can drop
  // ~6 stops below the street, never above it.
  minEvBelowPreset: 7,
  maxEvAbovePreset: 1,
  // Named tuning factor on top of the physical exposure: ACES in three.js
  // expects a slightly brighter input than a grey card to land mid-grey.
  compensationEv: 0.6,
  histogramWidth: 64,
  histogramHeight: 36,
  histogramLowPercentile: 0.5, // ignore the darkest half, as UE does
  histogramHighPercentile: 0.95,
} as const;

export const LOCAL_LIGHTS = {
  muzzleFlashCd: 60000, // lighting sheet: rifle muzzle flash peak, 2400 K
  muzzleFlashK: 2400,
  muzzleFlashSeconds: 0.03, // ~2 frames at 60 fps
  interiorBulbCd: 80, // lighting sheet: 1000 lm ≈ 80 cd, 2700 K
  interiorBulbK: 2700,
  explosionCd: 400000, // tuned by hand, frag flash for ~3 frames
  flashbangCd: 2000000,
} as const;

export const CAMERA = {
  verticalFovDeg: 70, // rules §6: 60–75°
  // The viewmodel is drawn at 1/4 scale about the eye (render/viewmodel.ts), which puts the
  // scope ocular 2.1 cm away; a reversed depth buffer keeps 1 cm → 2.6 km precise.
  nearM: 0.01,
  farM: 2600,
  mouseRadPerPixel: 0.0022,
  shakeIntensity: 1, // player-adjustable global scale
} as const;

/**
 * The forest lake's wind waves and water (render/shoreField.ts, shoreWaves.ts, water.ts).
 * Short, fetch-limited waves that slow and steepen on the gentle shore, lap up the bank and
 * drain back; foam only where they break at the very edge. Values for a small lake.
 */
export const LAKE_WAVES = {
  periodS: 1.7,
  /** Amplitude (m) per m/s of wind, at full fetch; the forest wind gives ~4.5 cm. */
  amplitudePerWindMs: 0.009,
  /** Fetch (m) at which the waves have grown to full height (height ∝ √fetch below it). */
  fullFetchM: 90,
  breakerIndex: 0.78,
  runupK: 2.1,
  swashUp: 0.4,
  swashDown: 0.55,
  dryTimeS: 20,
  foamLifeS: 1.1,
  maxDepthM: 2,
  minDepthM: 0.08,
  res: 256,
  /** Clear forest lake water, a little tea-coloured: absorption per metre (linear RGB). */
  absorptionPerM: { r: 0.42, g: 0.16, b: 0.34 },
  scatterColour: 0x2f5a44,
  deepColour: 0x0d1f18,
} as const;

export const WORLD_WIND: Record<'city' | 'forest' | 'range', { speedMs: number; directionRad: number }> = {
  city: { speedMs: 2.5, directionRad: 0.6 },
  forest: { speedMs: 5.0, directionRad: 1.9 },
  range: { speedMs: 3.0, directionRad: Math.PI / 2 },
};
