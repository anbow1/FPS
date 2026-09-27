import { exp, float, floor, fract, Fn, hash, length, Loop, normalize, sin, uniformArray, vec2, vec3 } from 'three/tsl';
import { type Node, Vector4 } from 'three/webgpu';
import { WAVES } from '../config.ts';
import { U } from './uniforms.ts';

// Surface disturbances shared by the lagoon and by rain puddles: expanding
// rings from splashes (a small ring buffer of sources written by the effects
// system) and the dense, short-lived rings of raindrops.

type N2 = Node<'vec2'>;

/** x, z, start time (s), strength. Strength 0 = empty slot. */
export const rippleSources = uniformArray(
  Array.from({ length: WAVES.rippleSlots }, () => new Vector4(0, 0, -100, 0)),
  'vec4',
);

let nextSlot = 0;

export function addRipple(x: number, z: number, timeSeconds: number, strength: number): void {
  const v = rippleSources.array[nextSlot] as Vector4;
  v.set(x, z, timeSeconds, strength);
  nextSlot = (nextSlot + 1) % WAVES.rippleSlots;
}

/** Slope (d height / dx, dz) and a foam amount from every live splash ring. Returns vec3(slopeX, slopeZ, foam). */
export const splashRipples = Fn(([p]: [N2]) => {
  const slope = vec2(0).toVar();
  const foam = float(0).toVar();
  Loop(WAVES.rippleSlots, ({ i }) => {
    const r = rippleSources.element(i) as unknown as Node<'vec4'>; // typed as a generic element
    const age = U.time.sub(r.z);
    const alive = age.greaterThan(0).and(age.lessThan(WAVES.rippleLifeSeconds)).and(r.w.greaterThan(0));
    const off = p.sub(r.xy);
    const dist = length(off).max(1e-3);
    const front = age.mul(WAVES.rippleSpeedMs).add(0.05);
    const x = dist.sub(front);
    const fade = exp(age.mul(-0.9)).mul(r.w).mul(alive.select(float(1), float(0)));
    // A short packet of crests trailing the front (capillary–gravity ring train).
    const packet = exp(x.mul(x).mul(-6)).mul(sin(x.mul(22))).mul(fade).div(dist.mul(0.6).add(1));
    slope.addAssign(off.div(dist).mul(packet.mul(0.9)));
    foam.addAssign(exp(x.mul(x).mul(-30)).mul(fade).mul(0.5).add(exp(dist.mul(dist).mul(-6)).mul(exp(age.mul(-1.8))).mul(r.w)));
  });
  return vec3(slope.x, slope.y, foam);
});

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
