// A shallow lake carved into a map's height function (pure data and maths, no
// THREE: logic, collision and rendering all read the same basin). The basin
// is an ellipse: a gentle pebbly shore, a bowl at most `depthM` deep, and
// banks that always rise above the water out to 1.3 radii, so the water never
// spills beyond the ellipse the render draws it in.

export interface Lake {
  cx: number;
  cz: number;
  /** Semi-axes of the waterline ellipse (m). */
  rx: number;
  rz: number;
  /** Still water surface (m). */
  levelM: number;
  /** Deepest point (m below the surface), at the centre. */
  depthM: number;
}

/** Bank rise per unit of normalised radius beyond the waterline (m). */
const BANK_RISE_M = 4.5;
/** Out to this normalised radius the basin replaces the terrain; beyond it blends back. */
const BASIN_R = 1.3;
const BLEND_R = 1.75;

/** Normalised elliptical radius: 1 on the still waterline. */
export function lakeRadius(lake: Lake, x: number, z: number): number {
  return Math.hypot((x - lake.cx) / lake.rx, (z - lake.cz) / lake.rz);
}

/** The basin's own height at normalised radius r (bottom inside, rising bank outside). */
function basinHeight(lake: Lake, r: number): number {
  if (r < 1) return lake.levelM - lake.depthM * (1 - r * r);
  return lake.levelM + (r - 1) * BANK_RISE_M;
}

/**
 * The terrain with the lake carved in: the basin alone out to BASIN_R, then a
 * blend back to the original ground, never below the basin's rising bank (so
 * nothing near the lake dips under the water).
 */
export function carveLake(lake: Lake, x: number, z: number, ground: number): number {
  const r = lakeRadius(lake, x, z);
  if (r >= BLEND_R) return ground;
  const basin = basinHeight(lake, r);
  if (r <= BASIN_R) return basin;
  const t = (r - BASIN_R) / (BLEND_R - BASIN_R);
  const k = t * t * (3 - 2 * t);
  return basin + (Math.max(ground, basin) - basin) * k;
}

/** Water depth (m) over a ground point at height groundY, 0 on dry land. */
export function waterDepth(lake: Lake | undefined, x: number, z: number, groundY: number): number {
  if (!lake || lakeRadius(lake, x, z) > BASIN_R) return 0;
  return Math.max(0, lake.levelM - groundY);
}

/**
 * The still level for a basin centred here: a little under the lowest ground
 * on its rim, so the carved banks meet the terrain without a cliff.
 */
export function lakeLevelFor(cx: number, cz: number, rx: number, rz: number, ground: (x: number, z: number) => number): number {
  let lowest = Infinity;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    lowest = Math.min(lowest, ground(cx + Math.cos(a) * rx * BLEND_R, cz + Math.sin(a) * rz * BLEND_R));
  }
  return lowest - 0.6;
}
