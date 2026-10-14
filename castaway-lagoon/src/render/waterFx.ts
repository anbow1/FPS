import { exp, float, floor, fract, Fn, hash, length, max, normalize, sin, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { WATER_LEVEL_M, WAVES } from '../config.ts';
import { hexToLinear } from './colour.ts';
import { heightAt } from '../game/terrain.ts';
import { RippleField } from './rippleField.ts';
import { WakeFoam } from './wakeFoam.ts';
import { U } from './uniforms.ts';

// Surface disturbances on the lagoon: splashes, bullets and wading legs push
// the ripple field (rippleField.ts, one texture read per water pixel: it
// replaced a loop over 24 analytic ring sources in every pixel, and adds
// wakes and rings that reflect off the shore), and raindrops ring in short,
// dense analytic cells.

type N2 = Node<'vec2'>;

let field: RippleField | null = null;
let foamField: WakeFoam | null = null;

/** The lagoon's ripple field, 32 m (High) or 24 m (Low) round the player; land cells stay still. */
export function createRipples(quality: 'high' | 'low'): RippleField {
  field = new RippleField({
    cells: quality === 'high' ? 128 : 96,
    cellM: 0.25,
    speedMps: 1.1,
    lifeS: 2.2,
    isWater: (x, z) => heightAt(x, z) < WATER_LEVEL_M - 0.02,
  });
  return field;
}

/**
 * The foam the boat and splashes leave (wakeFoam.ts), 96 m (High) or 64 m (Low) round the camera:
 * it lasts ~15 s, the trail widening as it thins.
 */
export function createWakeFoam(quality: 'high' | 'low'): WakeFoam {
  foamField = new WakeFoam({ cells: quality === 'high' ? 192 : 128, cellM: 0.5, lifeS: 9, spreadM2PerS: 0.05 });
  return foamField;
}

/** A splash of the given strength (≈ 0.2 knife … 1.75 heavy stone) at (x, z): rings, and a patch of bubbles. */
export function addRipple(x: number, z: number, strength: number): void {
  field?.disturb(x, z, 0.12 + strength * 0.15, 0.012 + strength * 0.04);
  foamField?.stamp(x, z, 0.25 + strength * 0.35, strength * 0.6);
}

/** Lasting foam (0–1) from the boat's wake and splashes. */
export function wakeFoam(p: N2): Node<'float'> {
  return foamField ? foamField.sample(p) : float(0);
}

/** Slope and agitation from the ripple field: vec3(∂h/∂x, ∂h/∂z, agitation). */
export function splashRipples(p: N2): Node<'vec3'> {
  return field ? field.sample(p) : vec3(0);
}

/**
 * Seen from under the surface: extinction per metre (the water's absorption plus
 * a little scattering by plankton and silt, so the far view fades to the water's
 * own colour instead of to black) and that colour, the in-scattered sun and sky.
 */
export const UNDERWATER_TURBIDITY_PER_M = 0.05;

export function underwaterExtinction(): Node<'vec3'> {
  const a = WAVES.absorptionPerM;
  const t = UNDERWATER_TURBIDITY_PER_M;
  return vec3(a.r + t, a.g + t, a.b + t);
}

export function underwaterTint(): Node<'vec3'> {
  const sc = hexToLinear(WAVES.scatterColour);
  const ambient = U.sunIrradiance.mul(max(U.sunDir.y, 0)).add(U.skyIrradiance).div(Math.PI);
  return vec3(sc.r, sc.g, sc.b).mul(ambient).mul(0.55);
}

/** Raindrop rings: two staggered layers of cells, each ringing once per cycle. Returns a slope. */
export const rainRings = Fn(([p]: [N2]) => {
  const slope = vec2(0).toVar();
  for (const [scale, rate, seed] of [
    [3.1, 1.7, 0],
    [4.3, 2.3, 17],
  ] as const) {
    const q = p.mul(scale).add(seed);
    const cell = floor(q);
    const h = hash(cell.x.add(cell.y.mul(57.0)).add(seed));
    const centre = vec2(hash(h.mul(13.1)), hash(h.mul(7.7))).mul(0.6).add(0.2);
    const local = fract(q).sub(centre);
    const t = fract(U.time.mul(rate).add(h));
    const d = length(local).max(1e-3);
    const x = d.sub(t.mul(0.42));
    const ring = sin(x.mul(55)).mul(exp(x.mul(x).mul(-350))).mul(float(1).sub(t));
    slope.addAssign(normalize(local).mul(ring.mul(0.45)));
  }
  return slope.mul(U.rain);
});
