// Every tunable of the Paris street scene, in physical units. Sources are given
// where a number is measured rather than chosen.

const DEG = Math.PI / 180;

/** The boulevard: a Haussmann boulevard of ~30 m between facades (boulevard Haussmann itself is 30–33 m). */
export const STREET = {
  /** Half width of the carriageway, kerb face to kerb face. */
  carriageHalfM: 9,
  /** Half width between the facades: 6 m pavements either side. */
  facadeHalfM: 15,
  /** Kerb height (Paris granite kerbs stand 12–15 cm). */
  kerbM: 0.14,
  /** Width of the granite kerb stone on top. */
  kerbStoneM: 0.3,
  /** Lane centres from the axis (two 3.25 m lanes each way), and the parking lane's. */
  laneXM: [1.65, 4.9] as const,
  parkingXM: 7.8,
  /** How far the boulevard runs ahead of the camera, and behind it. */
  farZM: -820,
  nearZM: 60,
  /** Cross streets: centre z and width between facades. */
  crossings: [
    { zM: -64, widthM: 16 },
    { zM: -232, widthM: 14 },
    { zM: -420, widthM: 18 },
    { zM: -610, widthM: 14 },
  ] as const,
  /** Plane trees along both pavements: distance from the axis, spacing (Paris alignments: 8–10 m). */
  treeXM: 10.7,
  treeSpacingM: 9,
  /** Street lamps between the trees. */
  lampXM: 9.65,
  lampEveryTrees: 3,
} as const;

/** Haussmann blocks: storey heights after the 1859 and 1884 regulations, as built. */
export const BUILDING = {
  /** Ground floor (shops) and entresol, rusticated. */
  groundStoreyM: 4.4,
  entresolM: 3.0,
  /** The étage noble (2nd floor, continuous balcony), then 3rd and 4th, then the 5th with the second balcony. */
  nobleM: 3.5,
  upperM: 3.05,
  fifthM: 2.85,
  /** Cornice height: ~20 m on a 30 m boulevard (1859: 17.55 m to the cornice for streets over 20 m, raised in 1884). */
  /** Mansard: the steep lower slope (brisis) and the flatter top (terrasson). */
  mansardSteepRad: 72 * DEG,
  mansardRiseM: 3.4,
  mansardTopRiseM: 1.3,
  /** Window: a French window ~1.25 m wide, the bay ~3.1 m. */
  bayM: 3.1,
  windowWidthM: 1.25,
  /** How deep the window sits behind the face: limestone walls ~50 cm, the joinery at ~25 cm. */
  revealM: 0.24,
  /** Continuous balconies stand out this far. */
  balconyDepthM: 0.62,
  /** Lot widths (along the street). */
  lotMinM: 13,
  lotMaxM: 24,
} as const;

/** Golden hour in late October (sun ~12° up), the lighting sheet's golden preset with Paris haze. */
export const LIGHT = {
  ev100: 12.0,
  sunIlluminanceLux: 9000,
  skyIlluminanceLux: 3600,
  sunColourK: 3300,
  skyColourK: 9000,
  sunElevationRad: 11 * DEG,
  /** From +Z toward +X: the sun stands to the right of the view down the boulevard (−Z) and a little ahead. */
  sunAzimuthRad: 118 * DEG,
  turbidity: 4.5,
  /** Visibility ~9 km in evening city haze (β = 3.9 / V). */
  fogDensityPerM: 0.00043,
  fogHeightFalloffPerM: 0.006,
  /** Street lamps have just come on (LED, ~2000 K-ish sodium-look retrofit lanterns). */
  lampLanternCdM2: 3500,
  lampColourK: 2700,
} as const;

/** The camera and the clip. */
export const SHOT = {
  durationS: 10,
  fps: 25,
  /** Simulated before frame 0 so traffic and walkers are spread out. */
  prerollS: 6,
  /** TRAA warm-up frames rendered (not recorded) before frame 0. */
  warmFrames: 10,
  verticalFovDeg: 46,
  /** A slow dolly along the right-hand kerb at first-floor height, eased in and out (positions in m). */
  camFrom: [8.3, 3.1, 10] as const,
  camTo: [7.9, 3.5, -3] as const,
  lookFrom: [0.5, 5.5, -110] as const,
  lookTo: [-2.5, 6.5, -110] as const,
  nearM: 0.1,
  farM: 60000,
} as const;

export const PEOPLE = {
  /** Walkers per pavement. */
  walkersPerSide: 62,
  /** Preferred walking speeds, m/s (pedestrian studies: mean ~1.34, sd ~0.26). */
  walkSpeedMeanMs: 1.34,
  walkSpeedSdMs: 0.2,
  /** The band of pavement people walk in (from the axis): between the trees and the facades. */
  walkInnerXM: 11.6,
  walkOuterXM: 14.4,
  /** How far along the boulevard they are spread. */
  spanNearZM: 30,
  spanFarZM: -330,
  cyclists: 5,
} as const;

export const TRAFFIC = {
  /** Intelligent Driver Model (Treiber et al. 2000), city values. */
  desiredSpeedMs: 11.5,
  maxAccelMs2: 1.6,
  comfortDecelMs2: 2.2,
  minGapM: 2.2,
  timeHeadwayS: 1.3,
  /** Vehicles per lane at the start. */
  perLane: 22,
  /** The light on the first crossing: red for the boulevard until this time (s of the clip), then green. */
  greenAtS: 5.5,
} as const;
