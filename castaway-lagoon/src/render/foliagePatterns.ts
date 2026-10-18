import { tileFbm, tileNoise, tileNoiseXY } from '../core/noise.ts';
import type { Texel, TexelSampler } from './textureSet.ts';
import { hash2, hex } from './patterns.ts';

// Alpha-cut foliage cards and barks. Cards are laid out with the stem at
// v = 0; alpha 0 outside the leaf. Colours follow the PBR sheet's foliage
// range (fresh leaf ~#4A6030, sun-bleached tips toward #9A9A50).

type Rgb = [number, number, number];

function mix(a: Rgb, b: Rgb, k: number): Rgb {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function set(t: Texel, c: Rgb, k = 1): void {
  t.r = c[0] * k;
  t.g = c[1] * k;
  t.b = c[2] * k;
}

function clear(t: Texel): void {
  t.alpha = 0;
  t.r = 0.2;
  t.g = 0.28;
  t.b = 0.1;
  t.height = 0;
}

/**
 * Coconut-palm frond: u across (rachis at u = 0.5), v from base to tip.
 * Leaflets leave the rachis angled toward the tip and hang in two ranks.
 */
export function palmFrond(): TexelSampler {
  const green = hex(0x4d6e22);
  const deep = hex(0x35521a);
  const yellow = hex(0x9c9a3e);
  const rachisC = hex(0xa0a453);
  const count = 46;
  return (u, v, t) => {
    const side = u - 0.5;
    const dx = Math.abs(side) * 2; // 0 at the rachis, 1 at the card edge
    if (dx < 0.028 && v > 0.02) {
      set(t, rachisC, 0.9);
      t.alpha = 1;
      t.height = 1;
      t.rough = 0.6;
      return;
    }
    const slant = 0.2;
    const v0 = v - dx * slant; // where this leaflet leaves the rachis
    if (v0 < 0.04 || v0 > 0.995) return clear(t);
    const envelope = Math.sin(Math.PI * Math.min(1, v0 * 1.05) ** 0.75) * 0.96 + 0.02;
    if (dx > envelope) return clear(t);
    const k = v0 * count + (side < 0 ? 0.5 : 0);
    const idx = Math.floor(k);
    const f = k - idx;
    const jitter = hash2(idx, side < 0 ? 1 : 2, 11);
    const width = 0.42 * (1 - (dx / envelope) ** 2.2) + 0.08;
    if (Math.abs(f - 0.5) > width * 0.5) return clear(t);
    // Leaflet shading: a crease along its length, a tip that bleaches and browns.
    const across = (f - 0.5) / (width * 0.5);
    const tip = dx / envelope;
    let c = mix(green, deep, jitter * 0.6 + Math.abs(across) * 0.3);
    c = mix(c, yellow, Math.max(0, tip - 0.72) * 2.2 * (0.5 + jitter));
    set(t, c, 0.85 + 0.2 * (1 - Math.abs(across)));
    t.alpha = 1;
    t.height = 1 - Math.abs(across);
    t.rough = 0.55;
    t.ao = 0.75 + 0.25 * (1 - tip * 0.3);
  };
}

/**
 * A cluster of glossy broad leaves on one card, stems meeting low in the middle. Each leaf its own: a
 * midrib that curves, one half a little wider than the other, a wavy margin, pinnate veins that sweep
 * toward the tip, mottling across the blade, and its age — a few leaves yellowing, browned at the
 * margin and tip and holed by insects. Veins are faint and sunk into the blade, as on a real leaf's upper
 * side: drawn as bright ridges, every leaf repeated the same ladder and the bushes read as cut-outs.
 */
export function broadleafCluster(seed: number, base: number, alt: number): TexelSampler {
  const leaves: { cx: number; cy: number; a: number; len: number; w: number; shade: number; bend: number; skew: number; veins: number; age: number }[] = [];
  for (let i = 0; i < 11; i++) {
    const a = -1.2 + (i / 10) * 2.4 + (hash2(i, 1, seed) - 0.5) * 0.35;
    const len = 0.28 + hash2(i, 2, seed) * 0.16;
    const r = 0.1 + hash2(i, 3, seed) * 0.12;
    leaves.push({
      cx: 0.5 + Math.sin(a) * (r + len * 0.5),
      cy: 0.12 + Math.cos(a) * (r + len * 0.5),
      a,
      len,
      w: len * (0.3 + hash2(i, 4, seed) * 0.14),
      shade: hash2(i, 5, seed),
      bend: (hash2(i, 6, seed) - 0.5) * 0.6,
      skew: (hash2(i, 9, seed) - 0.5) * 0.24,
      veins: 6 + Math.floor(hash2(i, 7, seed) * 4),
      age: hash2(i, 8, seed),
    });
  }
  const c0 = hex(base);
  const c1 = hex(alt);
  const yellow = hex(0x9c9a40);
  const brown = hex(0x6a5232);
  return (u, v, t) => {
    for (let i = leaves.length - 1; i >= 0; i--) {
      const L = leaves[i] as (typeof leaves)[number];
      const ox = u - L.cx;
      const oy = v - L.cy;
      const along = (ox * Math.sin(L.a) + oy * Math.cos(L.a)) / (L.len * 0.5); // −1 base … 1 tip
      if (along < -1 || along > 1) continue;
      const s = (along + 1) / 2;
      // The midrib bows to one side, more toward the tip.
      const across = (ox * Math.cos(L.a) - oy * Math.sin(L.a)) / (L.w * 0.5) - L.bend * s * s;
      // Ovate outline with an acuminate tip, one half wider, the margin gently waved.
      const half = Math.sin(Math.PI * s ** 0.8) * (1 - Math.max(0, s - 0.85) * 3) * (across < 0 ? 1 - L.skew : 1 + L.skew) * (1 + 0.035 * Math.sin(s * 38 + i * 1.7));
      if (Math.abs(across) > half) continue;
      // Old leaves are holed by insects: the leaf behind shows through.
      if (L.age > 0.66 && tileNoise(u * 110, v * 110, 110, 71 + seed) > 0.93 - (L.age - 0.66) * 0.12) continue;
      const ax = Math.abs(across) / Math.max(1e-3, half); // 0 midrib … 1 margin
      const midrib = Math.abs(across) < 0.035 + (1 - s) * 0.03 ? 1 : 0;
      // Pinnate veins leave the midrib and sweep forward toward the margin.
      const phase = s * L.veins - ax * 0.75;
      const vein = midrib ? 0 : Math.max(0, 1 - Math.abs((((phase % 1) + 1) % 1) - 0.5) / (0.045 * (1 - ax * 0.6)));
      const mottle = tileFbm(u * 14, v * 14, 14, 3, 61 + seed);
      let c = mix(c0, c1, L.shade * 0.7 + s * 0.15);
      c = mix(c, yellow, Math.max(0, L.age - 0.78) * 2.2 * (0.6 + mottle));
      // Margin and tip browned on the older leaves.
      const burn = Math.min(1, (Math.max(0, ax - 0.88) * 6 + Math.max(0, s - 0.92) * 8) * L.age);
      c = mix(c, brown, burn);
      c = mix(c, [c[0] * 1.2 + 0.03, c[1] * 1.2 + 0.035, c[2] * 1.05 + 0.01], midrib * 0.6 + vein * 0.3);
      // The blade bulges between the veins and curls away from the light at its margin.
      set(t, c, (0.84 + mottle * 0.26) * (0.94 + (1 - ax) * 0.1));
      t.alpha = 1;
      t.height = 0.45 + (1 - ax * ax) * 0.35 - vein * 0.12 - midrib * 0.1;
      t.rough = 0.4 + mottle * 0.12 + burn * 0.3;
      t.ao = (0.72 + 0.28 * s) * (1 - vein * 0.08);
      return;
    }
    clear(t);
  };
}

/** Fern frond: pinnae in opposite pairs, lobed, tapering to the tip. */
export function fernFrond(): TexelSampler {
  const c = hex(0x46692a);
  const tipC = hex(0x6d8a33);
  const pairs = 22;
  return (u, v, t) => {
    const dx = Math.abs(u - 0.5) * 2;
    if (dx < 0.03 && v < 0.98) {
      set(t, hex(0x5b6b2c));
      t.alpha = 1;
      t.height = 1;
      return;
    }
    const v0 = v - dx * 0.08;
    const env = Math.sin(Math.PI * Math.min(1, Math.max(0, v0)) ** 0.9) * 0.95;
    if (v0 < 0.03 || dx > env) return clear(t);
    const k = v0 * pairs;
    const f = k - Math.floor(k);
    const lobes = 0.5 + 0.5 * Math.cos(dx * 40);
    const w = 0.38 * (1 - (dx / env) ** 1.5) + 0.05 + lobes * 0.08;
    if (Math.abs(f - 0.5) > w) return clear(t);
    set(t, mix(c, tipC, v * 0.8), 0.85 + lobes * 0.2);
    t.alpha = 1;
    t.height = lobes;
    t.rough = 0.6;
  };
}

/** A tuft of grass blades rising from the bottom edge. */
export function grassTuft(): TexelSampler {
  const blades: { x: number; lean: number; h: number; w: number; shade: number }[] = [];
  for (let i = 0; i < 22; i++) blades.push({ x: 0.1 + hash2(i, 1, 5) * 0.8, lean: (hash2(i, 2, 5) - 0.5) * 0.5, h: 0.55 + hash2(i, 3, 5) * 0.43, w: 0.018 + hash2(i, 4, 5) * 0.016, shade: hash2(i, 5, 5) });
  const base = hex(0x4e6f27);
  const tip = hex(0x9aa04a);
  return (u, v, t) => {
    for (const b of blades) {
      if (v > b.h) continue;
      const s = v / b.h;
      const cx = b.x + b.lean * s * s;
      const w = b.w * (1 - s ** 1.6);
      if (Math.abs(u - cx) > w) continue;
      set(t, mix(base, tip, s * 0.7 + b.shade * 0.3), 0.75 + s * 0.35);
      t.alpha = 1;
      t.height = 1 - Math.abs(u - cx) / Math.max(1e-4, w);
      t.rough = 0.6;
      t.ao = 0.55 + 0.45 * s;
      return;
    }
    clear(t);
  };
}

/** Banana / elephant-ear leaf: midrib, fine parallel veins, wind tears along the margins. */
export function bananaLeaf(): TexelSampler {
  const c = hex(0x517d25);
  const pale = hex(0x86a23a);
  return (u, v, t) => {
    const dx = Math.abs(u - 0.5) * 2;
    const env = Math.sin(Math.PI * Math.min(1, v * 1.02) ** 0.7) * 0.97;
    if (v < 0.015 || dx > env) return clear(t);
    const vein = Math.abs((((v - dx * 0.35) * 60) % 1) - 0.5) < 0.08;
    // Tears: slits running from the margin toward the midrib.
    const tearRow = Math.floor((v - dx * 0.35) * 18);
    const torn = hash2(tearRow, u > 0.5 ? 1 : 2, 23) > 0.72 && Math.abs((((v - dx * 0.35) * 18) % 1) - 0.5) < 0.035 && dx > 0.25;
    if (torn) return clear(t);
    if (dx < 0.035) {
      set(t, pale, 1.05);
      t.alpha = 1;
      t.height = 1;
      return;
    }
    set(t, mix(c, pale, tileFbm(u * 3, v * 3, 3, 2, 29) * 0.4 + (vein ? 0.15 : 0)), 0.9);
    t.alpha = 1;
    t.height = vein ? 0.6 : 0.3;
    t.rough = 0.38;
    t.ao = 0.8 + 0.2 * v;
  };
}

/** Coconut-palm bark: leaf-scar rings over grey-brown fibre. u around, v up (one tile ≈ 0.6 m). */
export function palmBark(): TexelSampler {
  const c = hex(0x877d6d);
  const dark = hex(0x5a5146);
  return (u, v, t) => {
    const ringPhase = v * 5 + tileNoise(u * 4, v * 4, 4, 41) * 0.35 + tileFbm(u, v * 2, 1, 2, 47) * 0.5;
    const ring = Math.abs((ringPhase % 1) - 0.5);
    const fibre = tileNoiseXY(u * 64, v * 8, 64, 8, 43);
    const blotch = tileFbm(u * 2, v * 2, 2, 3, 45);
    const groove = ring > 0.46;
    set(t, mix(mix(c, dark, fibre * 0.3 + blotch * 0.35), dark, groove ? 0.22 : 0), 0.95 + (groove ? 0 : 0.06));
    t.height = groove ? 0.2 : 0.6 + fibre * 0.3 - ring * 0.3;
    t.rough = 0.9;
    t.ao = groove ? 0.55 : 1;
  };
}
