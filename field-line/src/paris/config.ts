// The Paris boulevard's dimensions, shared file for file in spirit with paris/src/config.ts
// (STREET, BUILDING): the Field Line 'boulevard' map is built from the same plan, so the
// street the AI fights over is the one the Paris scene renders.

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

