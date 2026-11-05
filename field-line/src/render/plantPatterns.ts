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
 * Spruce branch, seen from above: one card is a whole branch (up to ~5 m on the lower whorls), so it is
 * drawn as one: the axis, side branches leaving it alternately and raked toward its tip, and along each
 * of those the shoots, ~15 cm needle bottlebrushes every ~10 cm, with sky between them. Drawn with only
 * the side twigs as needle tubes, the card read as one giant fern frond with 30 cm "needles" (photo critic
 * loop). Needles themselves are 1–2 cm, a texel or two: they live in the tubes' ragged edges and relief,
 * not as strokes, which alias into moiré at range.
 */
export function pineSpray(): TexelSampler {
  const inner: Rgb = hex(0x1f2b1b);
  const outer: Rgb = hex(0x4a5c33);
  const young: Rgb = hex(0x667a3e);
  const wood: Rgb = hex(0x4a3b30);
  interface Shoot extends Segment {
    order: number; // 0 axis, 1 side branch, 2 shoot
    id: number;
  }
  const segs: Shoot[] = [];
  const axisTip = 0.95;
  segs.push({ ax: 0.5, ay: 0.02, bx: 0.5, by: axisTip, radius: 0.016, order: 0, id: 0 });
  const perSide = 16;
  for (let i = 0; i < perSide * 2; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const v0 = 0.04 + (i / (perSide * 2)) * 0.86;
    // The card is a trapezoid, half-width 0.5 at the stem narrowing to 0.35 at the tip.
    const room = 0.48 - v0 * 0.14;
    const len = room * (1 - v0 * 0.55) * (0.8 + hash2(i, 1, 9) * 0.35);
    const ang = 0.95 + (hash2(i, 2, 9) - 0.5) * 0.35; // from the axis, toward the tip
    const bx = 0.5 + side * Math.sin(ang) * len;
    const by = Math.min(0.99, v0 + Math.cos(ang) * len);
    segs.push({ ax: 0.5, ay: v0, bx, by, radius: 0.02, order: 1, id: i + 1 });
    // Shoots along the side branch, alternating, shorter toward its tip.
    const steps = Math.max(2, Math.floor(len / 0.026));
    for (let k = 1; k <= steps; k++) {
      const f = k / (steps + 0.5);
      const x0 = 0.5 + (bx - 0.5) * f;
      const y0 = v0 + (by - v0) * f;
      const sideK = k % 2 === 0 ? 1 : -1;
      const dirA = Math.atan2(bx - 0.5, by - v0) + sideK * (0.7 + (hash2(i, k, 11) - 0.5) * 0.4);
      const sl = 0.066 * (1 - f * 0.5) * (0.75 + hash2(i, k, 12) * 0.5);
      segs.push({ ax: x0, ay: y0, bx: x0 + Math.sin(dirA) * sl, by: y0 + Math.cos(dirA) * sl, radius: 0.018 * (1 - f * 0.3), order: 2, id: (i + 1) * 64 + k });
    }
  }
  // A coarse grid of the segments that can reach each cell, so a texel tests a handful, not ~350.
  const G = 32;
  const cells: Shoot[][] = Array.from({ length: G * G }, () => []);
  for (const sg of segs) {
    const reach = sg.radius * 1.4;
    const x0 = Math.max(0, Math.floor((Math.min(sg.ax, sg.bx) - reach) * G));
    const x1 = Math.min(G - 1, Math.floor((Math.max(sg.ax, sg.bx) + reach) * G));
    const y0 = Math.max(0, Math.floor((Math.min(sg.ay, sg.by) - reach) * G));
    const y1 = Math.min(G - 1, Math.floor((Math.max(sg.ay, sg.by) + reach) * G));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) (cells[y * G + x] as Shoot[]).push(sg);
  }
  return (u, v, t) => {
    const cell = cells[Math.min(G - 1, Math.floor(v * G)) * G + Math.min(G - 1, Math.floor(u * G))] as Shoot[];
    let best = 1e9;
    let hit: Shoot | null = null;
    let along = 0;
    let woodD = 1e9;
    for (const sg of cell) {
      const dx = sg.bx - sg.ax;
      const dy = sg.by - sg.ay;
      const len2 = dx * dx + dy * dy;
      const k = Math.max(0, Math.min(1, ((u - sg.ax) * dx + (v - sg.ay) * dy) / len2));
      const d = Math.hypot(u - sg.ax - dx * k, v - sg.ay - dy * k);
      if (sg.order < 2) woodD = Math.min(woodD, d);
      // Needle tubes taper to each shoot's tip; the bare axis wood carries few needles of its own.
      const r = sg.radius * (1 - k * 0.5) * (sg.order === 0 ? 0.6 : 1);
      if (d / r < best) {
        best = d / r;
        hit = sg;
        along = k;
      }
    }
    // Ragged needle edge: fine noise (a needle is about a texel) over a coarser lumpiness.
    const ragged = 0.72 + tileNoise(u * 160, v * 160, 160, 221) * 0.32 + tileNoise(u * 40, v * 40, 40, 222) * 0.16;
    // The needles hide the wood; it shows only where they leave it bare (the old axis near the trunk).
    if (!hit || best > ragged) return woodD < 0.0035 ? set(t, wood, 0.9, 0.85, 0.9, 0.6) : clear(t, inner);
    const edge = best / ragged; // 0 at the twig, 1 at the needle tips
    // Needle grain in the relief and colour, not as strokes.
    const grain = tileNoise(u * 300, v * 300, 300, 223);
    const tone = hash2(hit.id, 3, 224);
    let c = mix(inner, outer, Math.min(1, edge * 0.7 + tone * 0.25 + grain * 0.15));
    // This year's growth at the shoot tips is lighter.
    if (hit.order === 2 && along > 0.7) c = mix(c, young, (along - 0.7) * 1.6 * (0.4 + tone * 0.6));
    set(t, c, 0.8 + grain * 0.35, (1 - edge * edge) * (0.6 + grain * 0.4), 0.8, 0.45 + edge * 0.55);
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
