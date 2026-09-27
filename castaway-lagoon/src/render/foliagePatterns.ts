import { tileFbm, tileNoise } from '../core/noise.ts';
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

/** A cluster of glossy broad leaves on one card, stems meeting low in the middle. */
export function broadleafCluster(seed: number, base: number, alt: number): TexelSampler {
  const leaves: { cx: number; cy: number; a: number; len: number; w: number; shade: number }[] = [];
  for (let i = 0; i < 11; i++) {
    const a = -1.2 + (i / 10) * 2.4 + (hash2(i, 1, seed) - 0.5) * 0.35;
    const len = 0.28 + hash2(i, 2, seed) * 0.16;
    const r = 0.1 + hash2(i, 3, seed) * 0.12;
    leaves.push({ cx: 0.5 + Math.sin(a) * (r + len * 0.5), cy: 0.12 + Math.cos(a) * (r + len * 0.5), a, len, w: len * (0.34 + hash2(i, 4, seed) * 0.1), shade: hash2(i, 5, seed) });
  }
  const c0 = hex(base);
  const c1 = hex(alt);
  return (u, v, t) => {
    for (let i = leaves.length - 1; i >= 0; i--) {
      const L = leaves[i] as (typeof leaves)[number];
      const ox = u - L.cx;
      const oy = v - L.cy;
      const along = (ox * Math.sin(L.a) + oy * Math.cos(L.a)) / (L.len * 0.5); // −1 base … 1 tip
      const across = (ox * Math.cos(L.a) - oy * Math.sin(L.a)) / (L.w * 0.5);
      if (along < -1 || along > 1) continue;
      // Ovate outline with an acuminate tip.
      const s = (along + 1) / 2;
      const half = Math.sin(Math.PI * s ** 0.8) * (1 - Math.max(0, s - 0.85) * 3);
      if (Math.abs(across) > half) continue;
      const vein = Math.abs(across) < 0.05 ? 1 : Math.abs(((along * 4 + Math.abs(across) * 2) % 1) - 0.5) < 0.04 ? 0.5 : 0;
      const c = mix(c0, c1, L.shade * 0.7 + s * 0.2);
      set(t, mix(c, [c[0] * 1.3 + 0.03, c[1] * 1.25 + 0.03, c[2] * 1.1], vein * 0.6), 0.9 + (1 - Math.abs(across)) * 0.15);
      t.alpha = 1;
      t.height = (1 - Math.abs(across)) * 0.6 + vein * 0.2;
      t.rough = 0.42;
      t.ao = 0.7 + 0.3 * s;
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
    const fibre = tileNoise(u * 64, v * 8, 64, 43);
    const blotch = tileFbm(u * 2, v * 2, 2, 3, 45);
    const groove = ring > 0.46;
    set(t, mix(mix(c, dark, fibre * 0.3 + blotch * 0.35), dark, groove ? 0.22 : 0), 0.95 + (groove ? 0 : 0.06));
    t.height = groove ? 0.2 : 0.6 + fibre * 0.3 - ring * 0.3;
    t.rough = 0.9;
    t.ao = groove ? 0.55 : 1;
  };
}

/** Rainforest bark: smooth, pale grey with lichen blotches and fine vertical cracks. */
export function jungleBark(): TexelSampler {
  const c = hex(0x6f685d);
  const lichen = hex(0x8c9474);
  const moss = hex(0x415a24);
  return (u, v, t) => {
    const n = tileFbm(u * 4, v * 2, 4, 4, 51);
    const crack = Math.abs(((u * 10 + tileFbm(u * 2, v * 3, 2, 2, 53) * 3) % 1) - 0.5) < 0.04;
    const l = tileFbm(u * 6, v * 6, 6, 3, 55);
    const m = tileFbm(u * 3, v * 1.5, 3, 3, 57);
    let col = mix(c, lichen, Math.max(0, l - 0.55) * 3);
    col = mix(col, moss, Math.max(0, m - 0.6) * 3);
    set(t, col, crack ? 0.6 : 0.85 + n * 0.3);
    t.height = crack ? 0 : 0.5 + n * 0.5;
    t.rough = 0.88;
    t.ao = crack ? 0.6 : 1;
  };
}
