import { tileFbm, tileNoise } from '../core/noise.ts';
import type { Texel, TexelSampler } from './textureSet.ts';

// Surface patterns for the lagoon's procedural texture sets. Base colours are
// sRGB and stay inside the PBR sheet's non-metal range (linear luminance
// 0.021–0.92); coral-white sand sits near the top of it, wet leaf litter near
// the bottom. Every sampler tiles on [0, 1).

type Rgb = [number, number, number];

export function hex(h: number): Rgb {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

function put(t: Texel, c: Rgb, k: number): void {
  t.r = c[0] * k;
  t.g = c[1] * k;
  t.b = c[2] * k;
}

function mixRgb(a: Rgb, b: Rgb, k: number): Rgb {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Coral sand: wind ripples, grains, shell fragments and dark mineral specks. */
export function sand(): TexelSampler {
  const base = hex(0xd3c6a6);
  const warm = hex(0xc9b791);
  const shell = hex(0xf0ebdf);
  const speck = hex(0x6e665c);
  return (u, v, t) => {
    const warp = tileFbm(u * 3, v * 3, 3, 3, 7);
    const ripple = 0.5 + 0.5 * Math.sin((v * 11 + warp * 2.2 + tileFbm(u * 6, v * 6, 6, 2, 9) * 0.6) * Math.PI * 2);
    const patch = tileFbm(u * 2, v * 2, 2, 3, 11);
    const grain = tileNoise(u * 256, v * 256, 256, 13);
    const cellX = Math.floor(u * 64);
    const cellY = Math.floor(v * 64);
    const h = hash2(cellX, cellY, 17);
    let c = mixRgb(base, warm, patch);
    let k = 0.93 + grain * 0.12 + ripple * 0.03;
    if (h > 0.985) {
      c = shell;
      k = 1;
    } else if (h < 0.012) {
      c = speck;
      k = 1;
    }
    put(t, c, k);
    t.height = ripple * 0.22 + grain * 0.4 + (h > 0.985 ? 0.25 : 0);
    t.rough = 0.93 - grain * 0.04;
    t.ao = 0.85 + ripple * 0.15;
  };
}

/** Jungle floor: layered fallen leaves over dark soil. */
export function leafLitter(): TexelSampler {
  const soil = hex(0x3d3022);
  const palette: Rgb[] = [hex(0x6b4a2a), hex(0x43301f), hex(0x8a6a36), hex(0x4f5a2c), hex(0x5a3f24), hex(0x746238)];
  const layers = [7, 10, 14];
  return (u, v, t) => {
    let colour: Rgb = soil;
    let height = tileFbm(u * 8, v * 8, 8, 3, 21) * 0.2;
    let found = false;
    for (let L = layers.length - 1; L >= 0 && !found; L--) {
      const g = layers[L] as number;
      const cx = Math.floor(u * g);
      const cy = Math.floor(v * g);
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const ix = (((cx + dx) % g) + g) % g;
          const iy = (((cy + dy) % g) + g) % g;
          const r1 = hash2(ix, iy, 31 + L);
          const r2 = hash2(ix, iy, 47 + L);
          const r3 = hash2(ix, iy, 59 + L);
          const px = (cx + dx + 0.2 + r1 * 0.6) / g;
          const py = (cy + dy + 0.2 + r2 * 0.6) / g;
          const a = r3 * Math.PI * 2;
          const ox = u - px;
          const oy = v - py;
          const lx = (ox * Math.cos(a) + oy * Math.sin(a)) * g;
          const ly = (-ox * Math.sin(a) + oy * Math.cos(a)) * g;
          const e = (lx / 0.62) ** 2 + (ly / 0.28) ** 2;
          if (e < 1) {
            const vein = Math.abs(ly) < 0.02 ? 0.8 : 1;
            colour = palette[Math.floor(hash2(ix, iy, 71 + L) * palette.length)] as Rgb;
            put(t, colour, (0.8 + (1 - e) * 0.25) * vein);
            height = 0.4 + L * 0.2 + (1 - e) * 0.1;
            found = true;
          }
        }
      }
    }
    if (!found) put(t, colour, 0.85 + height);
    t.height = height;
    t.rough = found ? 0.78 : 0.95;
    t.ao = found ? 1 : 0.6;
  };
}

/** Tropical grass turf with sand showing through. */
export function tropicalGrass(): TexelSampler {
  const lush = hex(0x3f6a22);
  const yellow = hex(0x5f7a2c);
  const dark = hex(0x2c4a18);
  const sandC = hex(0xbfae88);
  return (u, v, t) => {
    const blade = tileNoise(u * 180, v * 45, 180, 81) * 0.6 + tileNoise(u * 45, v * 180, 45, 82) * 0.4;
    const patch = tileFbm(u * 3, v * 3, 3, 3, 83);
    const bare = tileFbm(u * 5, v * 5, 5, 3, 85);
    let c = mixRgb(mixRgb(dark, lush, blade), yellow, Math.max(0, patch * 1.5 - 0.55));
    if (bare > 0.66 && blade < 0.45) c = mixRgb(c, sandC, 0.7);
    put(t, c, 0.8 + blade * 0.35);
    t.height = blade;
    t.rough = 0.86;
    t.ao = 0.7 + blade * 0.3;
  };
}

/** Beach and cliff rock: pale weathered limestone with dark pits. */
export function coastRock(): TexelSampler {
  const c = hex(0x8e867a);
  const dark = hex(0x5d574f);
  return (u, v, t) => {
    const n = tileFbm(u * 6, v * 6, 6, 5, 101);
    const strata = 0.5 + 0.5 * Math.sin((v * 9 + tileFbm(u * 2, v * 2, 2, 3, 107) * 2.5) * Math.PI * 2);
    const pit = tileNoise(u * 48, v * 48, 48, 109);
    const crack = Math.abs(tileFbm(u * 3, v * 3, 3, 3, 103) - 0.5) < 0.02;
    const col = mixRgb(c, dark, Math.max(0, 0.6 - n) + (pit < 0.12 ? 0.5 : 0));
    put(t, col, crack ? 0.55 : 0.8 + n * 0.35 + strata * 0.06);
    t.height = crack ? 0 : n * 0.7 + strata * 0.2 - (pit < 0.12 ? 0.2 : 0);
    t.rough = 0.82;
    t.ao = crack ? 0.45 : pit < 0.12 ? 0.7 : 1;
  };
}

/** Thick moss: soft, fuzzy, yellow-green tips. */
export function moss(): TexelSampler {
  const deep = hex(0x3b5520);
  const tip = hex(0x6f8a30);
  return (u, v, t) => {
    const fuzz = tileNoise(u * 128, v * 128, 128, 121);
    const clump = tileFbm(u * 8, v * 8, 8, 4, 123);
    put(t, mixRgb(deep, tip, fuzz * 0.6 + clump * 0.4), 0.85 + fuzz * 0.2);
    t.height = clump * 0.6 + fuzz * 0.4;
    t.rough = 0.95;
    t.ao = 0.7 + clump * 0.3;
  };
}

/** Grey water-rippled height field for the water's detail normals (the colour is unused). */
export function waterRipples(): TexelSampler {
  return (u, v, t) => {
    t.r = 0.5;
    t.g = 0.5;
    t.b = 0.5;
    const a = tileFbm(u * 4 + tileFbm(u * 2, v * 2, 2, 2, 5) * 0.8, v * 8, 4, 5, 131);
    const b = tileFbm(u * 9, v * 5 + a * 0.5, 9, 4, 133);
    t.height = a * 0.65 + b * 0.35;
    t.rough = 0.05;
  };
}

/** Voronoi F2−F1 network: the bright web of focused sunlight on a sandy floor. */
export function causticValue(u: number, v: number): number {
  const g = 7;
  const cx = Math.floor(u * g);
  const cy = Math.floor(v * g);
  let f1 = 9;
  let f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ix = (((cx + dx) % g) + g) % g;
      const iy = (((cy + dy) % g) + g) % g;
      const px = (cx + dx + hash2(ix, iy, 141)) / g;
      const py = (cy + dy + hash2(ix, iy, 143)) / g;
      const d = Math.hypot(u - px, v - py) * g;
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  const edge = f2 - f1;
  return Math.max(0, 1 - edge * 3.2) ** 2.4;
}

/** Foam: bubbly cells with thin connecting streaks. */
export function foamValue(u: number, v: number): number {
  const cells = 1 - causticValue(u * 2 % 1, v * 2 % 1) * 0.6;
  const streak = tileFbm(u * 6, v * 3, 6, 4, 151);
  const bubbles = tileNoise(u * 64, v * 64, 64, 153);
  return Math.min(1, Math.max(0, streak * 1.3 - 0.25 + (bubbles > 0.7 ? 0.25 : 0) - cells * 0.15));
}
