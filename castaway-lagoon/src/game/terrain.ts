import { fbm2, ridged2 } from '../core/noise.ts';
import { WATER_LEVEL_M } from '../config.ts';

// The lagoon's landform as a pure height function, metres, Y up, sea level 0.
// +X is east, −Z is north. Composition follows the reference sheets the user
// supplied: a sheltered bay with a wide sand beach on its south shore, rocky
// cliffs and jungle hills on the east and west, a channel opening north to the
// sea, two palm islets in the water, and a volcanic peak across the sea to the
// north-east that fills the horizon above the lagoon.
//
// Everything that needs the ground (player, stones, bullets, vegetation
// placement, the terrain mesh, the water's depth texture) samples this one
// function, so they always agree.

export const LAGOON_CENTRE = { x: 0, z: -58 } as const;
const LAGOON_RX_M = 70;
const LAGOON_RZ_M = 55;
const CHANNEL_END = { x: 30, z: -430 } as const;
const CHANNEL_RADIUS_M = 30;
const ISLAND_CENTRE = { x: 0, z: 120 } as const;
const ISLAND_RADIUS_M = 470;

/** Clearing the shelter stands in: flattened so the floor sits level. */
export const OUTPOST_CENTRE = { x: -15, z: 13 } as const;
const OUTPOST_FLAT_RADIUS_M = 10;
const OUTPOST_FLAT_HEIGHT_M = 1.05;

interface Islet {
  x: number;
  z: number;
  radiusM: number;
  peakM: number;
}
export const ISLETS: readonly Islet[] = [
  { x: 34, z: -84, radiusM: 10, peakM: 3.2 },
  { x: -38, z: -102, radiusM: 13, peakM: 6.5 },
  { x: 58, z: -150, radiusM: 16, peakM: 9 },
];

const VOLCANO = { x: 420, z: -1250, heightM: 520, radiusM: 330 };

export type SurfaceKind = 'sand' | 'wetSand' | 'grass' | 'dirt' | 'rock' | 'wood' | 'water' | 'leaves' | 'metal' | 'fabric';

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const t = Math.min(1, Math.max(0, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - ax - vx * t, pz - az - vz * t);
}

/**
 * Signed horizontal distance to the lagoon's water edge, metres: negative in
 * the water, positive on land. Approximate (an ellipse metric), smooth.
 */
export function shoreDistance(x: number, z: number): number {
  const dx = (x - LAGOON_CENTRE.x) / LAGOON_RX_M;
  const dz = (z - LAGOON_CENTRE.z) / LAGOON_RZ_M;
  const wobble = fbm2(x * 0.018, z * 0.018, 3, 11) * 0.13;
  const lagoon = (Math.hypot(dx, dz) - 1 + wobble) * 0.5 * (LAGOON_RX_M + LAGOON_RZ_M);
  const channel = segmentDistance(x, z, LAGOON_CENTRE.x, LAGOON_CENTRE.z, CHANNEL_END.x, CHANNEL_END.z) - CHANNEL_RADIUS_M - fbm2(x * 0.03, z * 0.03, 2, 5) * 8;
  const islandEdge = ISLAND_RADIUS_M - Math.hypot(x - ISLAND_CENTRE.x, z - ISLAND_CENTRE.z) + fbm2(x * 0.006, z * 0.006, 3, 21) * 60;
  return smin(smin(lagoon, channel, 30), islandEdge, 60);
}

/** 0 on the soft south beach, 1 where the east and west shores turn to cliff. */
export function cliffiness(x: number, z: number): number {
  const south = smoothstep(-40, 0, z);
  const side = smoothstep(35, 70, Math.abs(x - LAGOON_CENTRE.x));
  return Math.min(1, Math.max(0, side * (1 - south * 0.8) + (1 - south) * 0.35 + fbm2(x * 0.02, z * 0.02, 2, 3) * 0.3));
}

/** Width of the sand beach from the waterline inland, metres. */
export function beachWidth(x: number, z: number): number {
  return 3 + 15 * (1 - cliffiness(x, z));
}

export function heightAt(x: number, z: number): number {
  const d = shoreDistance(x, z);
  let h: number;
  if (d < 0) {
    // Under water: a gentle shelf that steepens, then the lagoon floor; the open sea goes deep.
    const dd = -d;
    const sea = smoothstep(-200, -420, z);
    const cap = 6 + sea * 30;
    h = -Math.min(cap, 0.085 * dd + 0.0026 * dd * dd) + fbm2(x * 0.08, z * 0.08, 2, 7) * 0.15;
  } else {
    const bw = beachWidth(x, z);
    const cliff = cliffiness(x, z);
    const beach = Math.min(d, bw) * 0.06 + fbm2(x * 0.05, z * 0.05, 3, 9) * 0.12 * Math.min(1, d / 4);
    const inland = Math.max(0, d - bw);
    const hillAmp = 34 * (1 + 0.55 * fbm2(x * 0.004, z * 0.004, 3, 2)) + ridged2(x * 0.006, z * 0.006, 4, 4) * 30;
    const hillLen = 95 - 60 * cliff;
    // Jungle floor: a gentle first 20 m on the south shore, then the hills climb.
    const floorRamp = smoothstep(0, 22, inland) * (1 - cliff) + cliff;
    h = beach + hillAmp * (1 - Math.exp(-inland / hillLen)) * floorRamp + inland * 0.03;
    h += fbm2(x * 0.045, z * 0.045, 4, 13) * Math.min(1, inland / 10) * (0.6 + cliff * 1.8);
  }
  for (const islet of ISLETS) {
    const r = Math.hypot(x - islet.x, z - islet.z) / islet.radiusM;
    const bump = islet.peakM - (islet.peakM + 3.5) * r ** 1.4 + fbm2(x * 0.15, z * 0.15, 2, 17) * 0.6;
    h = Math.max(h, bump);
  }
  // Flatten the outpost clearing.
  const od = Math.hypot(x - OUTPOST_CENTRE.x, z - OUTPOST_CENTRE.z);
  const flat = 1 - smoothstep(OUTPOST_FLAT_RADIUS_M * 0.6, OUTPOST_FLAT_RADIUS_M, od);
  h += (OUTPOST_FLAT_HEIGHT_M - h) * flat;
  // The volcano across the sea to the north-east, and its skirt.
  const vr = Math.hypot(x - VOLCANO.x, z - VOLCANO.z);
  if (vr < VOLCANO.radiusM * 4) {
    const t = vr / VOLCANO.radiusM;
    const cone = VOLCANO.heightM * Math.exp(-(t ** 1.25)) * (1 + 0.1 * ridged2(x * 0.004, z * 0.004, 4, 8));
    const crater = 30 * Math.exp(-((vr / 45) ** 2));
    // Erosion: rain cuts gullies straight down a volcano's flanks, leaving radial ridges between them
    // (a smooth cone read as a placeholder). The noise is sampled round a circle, fast in angle and
    // slow in radius, so its features run downhill and there is no seam where the angle wraps.
    const ca = (x - VOLCANO.x) / Math.max(vr, 1);
    const sa = (z - VOLCANO.z) / Math.max(vr, 1);
    const flank = smoothstep(0.12, 0.45, t) * Math.exp(-t / 2.2);
    const spurs = ridged2(ca * 3 + t * 0.35, sa * 3 - t * 0.25, 3, 31) - 0.5;
    const gullies = ridged2(ca * 7 + t * 0.6, sa * 7 - t * 0.5, 3, 37) - 0.5;
    const eroded = cone + flank * (spurs * 70 + gullies * 38);
    h = Math.max(h, eroded - crater - 25);
  }
  return h;
}

/** Surface normal from central differences. */
export function normalAt(x: number, z: number, out: { x: number; y: number; z: number }): void {
  const e = 0.35;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx;
  const ny = 2 * e;
  const nz = -hz;
  const len = Math.hypot(nx, ny, nz);
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
}

/** What the ground is at a point: drives footsteps, impacts and the splat map. */
export function surfaceAt(x: number, z: number): SurfaceKind {
  const h = heightAt(x, z);
  if (h < WATER_LEVEL_M - 0.02) return 'water';
  const d = shoreDistance(x, z);
  const n = { x: 0, y: 1, z: 0 };
  normalAt(x, z, n);
  if (n.y < 0.72) return 'rock';
  const bw = beachWidth(x, z);
  if (d < 2.2) return 'wetSand';
  if (d < bw + 1.5 + fbm2(x * 0.1, z * 0.1, 2, 3) * 2) return 'sand';
  return 'grass';
}

/** Depth of water at a point, metres (0 on land). */
export function waterDepthAt(x: number, z: number): number {
  return Math.max(0, WATER_LEVEL_M - heightAt(x, z));
}
