import { tileFbm, tileNoise } from '../core/noise.ts';
import { hex } from './patterns.ts';
import type { Texel, TexelSampler } from './textures.ts';

// Alpha-cut plant cards for the forest and the range margins, drawn the way
// the lagoon's jungle cards are: whole leaves, fronds and needle tufts with
// soft rounded height (so the normal map gives them volume), darker toward
// the stem, lighter at sunlit tips. Stem at v = 0. Colours from the PBR
// sheet's foliage range (pine #3C4A2E, fresh leaf #4A6030, dry tips #9A9A50).

type Rgb = [number, number, number];

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function mix(a: Rgb, b: Rgb, k: number): Rgb {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function set(t: Texel, c: Rgb, k: number, height: number, rough: number, ao: number): void {
  t.r = c[0] * k;
  t.g = c[1] * k;
  t.b = c[2] * k;
  t.alpha = 1;
  t.height = height;
  t.rough = rough;
  t.ao = ao;
  t.metal = 0;
}

/** Transparent texel: colour kept near the leaf's so mip filtering never bleeds a halo. */
function clear(t: Texel, c: Rgb): void {
  t.r = c[0];
  t.g = c[1];
  t.b = c[2];
  t.alpha = 0;
  t.height = 0;
  t.rough = 0.8;
  t.ao = 1;
  t.metal = 0;
}

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  radius: number;
}

/**
 * Pine branch spray, seen from above: a main twig up the card with side twigs
 * angled toward the tip, each one a bottlebrush of needles. The needle mass
 * is a rounded tube around every twig with a ragged edge, not individual
 * strands: strands a few texels wide alias into moiré stripes at range, while
 * tufts keep their shape down the mip chain.
 */
export function pineSpray(): TexelSampler {
  const inner: Rgb = hex(0x243220);
  const outer: Rgb = hex(0x4f6136);
  const twig: Rgb = hex(0x4a3b30);
  const segs: Segment[] = [{ ax: 0.5, ay: 0.02, bx: 0.5, by: 0.93, radius: 0.1 }];
  for (let i = 0; i < 12; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const v0 = 0.08 + i * 0.066;
    const len = 0.36 * (1 - v0 * 0.62) * (0.85 + hash2(i, 1, 7) * 0.3);
    const ang = 0.75 + (hash2(i, 2, 7) - 0.5) * 0.3; // from the main twig, toward the tip
    segs.push({ ax: 0.5, ay: v0, bx: 0.5 + side * Math.sin(ang) * len, by: v0 + Math.cos(ang) * len, radius: 0.075 * (1 - v0 * 0.4) });
  }
  return (u, v, t) => {
    let best = 1e9;
    let bestR = 0.1;
    let along = 0;
    for (const s of segs) {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const k = Math.max(0, Math.min(1, ((u - s.ax) * dx + (v - s.ay) * dy) / (dx * dx + dy * dy)));
      // Needles thin out toward each twig's tip.
      const r = s.radius * (1 - k * 0.45);
      const d = Math.hypot(u - s.ax - dx * k, v - s.ay - dy * k) / r;
      if (d < best) {
        best = d;
        bestR = r;
        along = k;
      }
    }
    // Ragged edge: needle tips at a few different lengths.
    const ragged = 0.78 + tileNoise(u * 48, v * 48, 48, 211) * 0.3 + tileNoise(u * 13, v * 13, 13, 212) * 0.12;
    if (best > ragged) return clear(t, inner);
    if (best * bestR < 0.009) return set(t, twig, 0.9, 0.9, 0.9, 0.7);
    const edge = best / ragged; // 0 at the twig, 1 at the needle tips
    const grain = tileNoise(u * 96, v * 96, 96, 213);
    const c = mix(inner, outer, Math.min(1, edge * 0.8 + along * 0.25 + grain * 0.15));
    set(t, c, 0.85 + grain * 0.3, Math.sqrt(Math.max(0, 1 - edge * edge)), 0.82, 0.55 + edge * 0.45);
  };
}

/** Bracken / fern frond: pinnae in opposite pairs, lobed, tapering to the tip. */
export function fernFrond(): TexelSampler {
  const c: Rgb = hex(0x46652a);
  const tip: Rgb = hex(0x7d8c3a);
  const stem: Rgb = hex(0x6b6a34);
  const pairs = 20;
  return (u, v, t) => {
    const dx = Math.abs(u - 0.5) * 2;
    if (dx < 0.03 && v < 0.98) return set(t, stem, 1, 1, 0.7, 0.9);
    const v0 = v - dx * 0.08;
    const env = Math.sin(Math.PI * Math.min(1, Math.max(0, v0)) ** 0.9) * 0.95;
    if (v0 < 0.03 || dx > env) return clear(t, c);
    const k = v0 * pairs;
    const f = k - Math.floor(k);
    const lobes = 0.5 + 0.5 * Math.cos(dx * 40);
    const w = 0.38 * (1 - (dx / env) ** 1.5) + 0.05 + lobes * 0.08;
    if (Math.abs(f - 0.5) > w) return clear(t, c);
    set(t, mix(c, tip, v * 0.7 + dx * 0.2), 0.85 + lobes * 0.2, lobes, 0.62, 0.7 + v * 0.3);
  };
}

/** A tuft of meadow grass: blades rising from the bottom edge, some gone to straw. */
export function grassTuft(): TexelSampler {
  const blades: { x: number; lean: number; h: number; w: number; shade: number; dry: boolean }[] = [];
  for (let i = 0; i < 26; i++) {
    blades.push({ x: 0.08 + hash2(i, 1, 5) * 0.84, lean: (hash2(i, 2, 5) - 0.5) * 0.55, h: 0.5 + hash2(i, 3, 5) * 0.48, w: 0.016 + hash2(i, 4, 5) * 0.016, shade: hash2(i, 5, 5), dry: hash2(i, 6, 5) > 0.8 });
  }
  const base: Rgb = hex(0x3f5a24);
  const tip: Rgb = hex(0x8d9a48);
  const straw: Rgb = hex(0xa89c62);
  return (u, v, t) => {
    for (const b of blades) {
      if (v > b.h) continue;
      const s = v / b.h;
      const cx = b.x + b.lean * s * s;
      const w = b.w * (1 - s ** 1.6);
      if (Math.abs(u - cx) > w) continue;
      const c = b.dry ? mix(base, straw, 0.4 + s * 0.6) : mix(base, tip, s * 0.7 + b.shade * 0.3);
      set(t, c, 0.72 + s * 0.38, 1 - Math.abs(u - cx) / Math.max(1e-4, w), 0.6, 0.5 + 0.5 * s);
      return;
    }
    clear(t, base);
  };
}

/**
 * A slice of reed bed (common reed): thin stems of uneven height — so the top of the bed is ragged, not a
 * hedge — each with a couple of long leaves arching off it and, on most, a feathery purple-brown plume.
 * The card is tall: u across, v up; stems rise from the bottom edge.
 */
export function reedBed(): TexelSampler {
  const stems: { x: number; h: number; lean: number; shade: number; plume: boolean; leaves: { at: number; side: number; len: number }[] }[] = [];
  for (let i = 0; i < 34; i++) {
    const h = 0.48 + hash2(i, 1, 41) * 0.5;
    const leaves = [0, 1, 2].filter((k) => hash2(i, 10 + k, 41) > 0.3).map((k) => ({ at: 0.25 + k * 0.22 + hash2(i, 20 + k, 41) * 0.1, side: hash2(i, 30 + k, 41) > 0.5 ? 1 : -1, len: 0.12 + hash2(i, 40 + k, 41) * 0.12 }));
    stems.push({ x: 0.04 + hash2(i, 2, 41) * 0.92, h, lean: (hash2(i, 3, 41) - 0.5) * 0.12, shade: hash2(i, 4, 41), plume: hash2(i, 5, 41) > 0.35, leaves });
  }
  const stemLow: Rgb = hex(0x4a5e2c);
  const stemHigh: Rgb = hex(0x9a9658);
  const leaf: Rgb = hex(0x5e7436);
  const plumeC: Rgb = hex(0x7a5a46);
  return (u, v, t) => {
    for (const st of stems) {
      const s = v / st.h;
      // Plume: a slim, drooping, fuzzy panicle above the stem's tip.
      if (st.plume && v > st.h - 0.02 && v < st.h + 0.11) {
        const k = (v - (st.h - 0.02)) / 0.13;
        const cx = st.x + st.lean + k * k * 0.03;
        const w = 0.016 * Math.sin(Math.PI * Math.min(1, k * 1.1)) + 0.002;
        const fuzz = tileNoise(u * 256, v * 256, 256, 43);
        if (Math.abs(u - cx) < w * (0.7 + fuzz * 0.6)) {
          set(t, mix(plumeC, stemHigh, fuzz * 0.4), 0.85 + fuzz * 0.3, 0.6, 0.8, 0.8);
          return;
        }
      }
      if (s > 1) continue;
      const cx = st.x + st.lean * s * s;
      if (Math.abs(u - cx) < 0.0045) {
        set(t, mix(stemLow, stemHigh, s * 0.8 + st.shade * 0.2), 0.8 + s * 0.3, 1, 0.55, 0.5 + 0.5 * s);
        return;
      }
      for (const lf of st.leaves) {
        // A leaf leaves the stem at `at` of its height, arches outward and droops at the end.
        const y0 = lf.at * st.h;
        const dy = v - y0;
        if (dy < -0.02 || dy > lf.len) continue;
        const k = Math.max(0, dy) / lf.len;
        const lx = cx + lf.side * (k * lf.len * 0.55 + k * k * 0.04);
        const w = 0.006 * (1 - k * 0.8);
        if (Math.abs(u - lx) < w) {
          set(t, mix(leaf, stemHigh, k * 0.5 + st.shade * 0.2), 0.8 + k * 0.3, 0.7, 0.6, 0.55 + 0.45 * s);
          return;
        }
      }
    }
    clear(t, leaf);
  };
}

/** A spray of ovate leaves on a twig (hazel, alder buckthorn): the broadleaf undergrowth card. */
export function broadleafCluster(seed: number, base: number, alt: number): TexelSampler {
  const leaves: { cx: number; cy: number; a: number; len: number; w: number; shade: number }[] = [];
  for (let i = 0; i < 11; i++) {
    const a = -1.2 + (i / 10) * 2.4 + (hash2(i, 1, seed) - 0.5) * 0.35;
    const len = 0.28 + hash2(i, 2, seed) * 0.16;
    const r = 0.1 + hash2(i, 3, seed) * 0.12;
    leaves.push({ cx: 0.5 + Math.sin(a) * (r + len * 0.5), cy: 0.12 + Math.cos(a) * (r + len * 0.5), a, len, w: len * (0.42 + hash2(i, 4, seed) * 0.12), shade: hash2(i, 5, seed) });
  }
  const c0: Rgb = hex(base);
  const c1: Rgb = hex(alt);
  return (u, v, t) => {
    for (let i = leaves.length - 1; i >= 0; i--) {
      const L = leaves[i] as (typeof leaves)[number];
      const ox = u - L.cx;
      const oy = v - L.cy;
      const along = (ox * Math.sin(L.a) + oy * Math.cos(L.a)) / (L.len * 0.5); // −1 base … 1 tip
      const across = (ox * Math.cos(L.a) - oy * Math.sin(L.a)) / (L.w * 0.5);
      if (along < -1 || along > 1) continue;
      const s = (along + 1) / 2;
      const half = Math.sin(Math.PI * s ** 0.8) * (1 - Math.max(0, s - 0.85) * 3);
      // Serrated margin.
      const teeth = 1 - Math.abs(((s * 14) % 1) - 0.5) * 0.12;
      if (Math.abs(across) > half * teeth) continue;
      const vein = Math.abs(across) < 0.05 ? 1 : Math.abs(((along * 4 + Math.abs(across) * 2) % 1) - 0.5) < 0.04 ? 0.5 : 0;
      const c = mix(c0, c1, L.shade * 0.7 + s * 0.2);
      set(t, mix(c, [c[0] * 1.3 + 0.03, c[1] * 1.25 + 0.03, c[2] * 1.1], vein * 0.5), 0.9 + (1 - Math.abs(across)) * 0.15, (1 - Math.abs(across)) * 0.6 + vein * 0.2, 0.5, 0.7 + 0.3 * s);
      return;
    }
    clear(t, c0);
  };
}

/** Moss and lichen on the tops of boulders. */
export function moss(): TexelSampler {
  const deep: Rgb = hex(0x33461f);
  const bright: Rgb = hex(0x6b7f35);
  return (u, v, t) => {
    const clump = tileFbm(u * 6, v * 6, 6, 4, 221);
    const fuzz = tileNoise(u * 128, v * 128, 128, 222);
    set(t, mix(deep, bright, clump * 0.8 + fuzz * 0.2), 0.8 + fuzz * 0.35, clump * 0.7 + fuzz * 0.3, 0.95, 0.6 + clump * 0.4);
  };
}
