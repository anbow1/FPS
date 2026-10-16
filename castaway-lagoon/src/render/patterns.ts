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
    // One fragment per 5 cm cell at most: a rotated, soft-edged ellipse placed and sized at
    // random inside it. Filling the whole cell drew the fragments as little squares.
    const cellX = Math.floor(u * 64);
    const cellY = Math.floor(v * 64);
    const h = hash2(cellX, cellY, 17);
    const isShell = h > 0.985;
    let fragment = 0;
    if (isShell || h < 0.012) {
      const dx = u * 64 - cellX - (0.3 + 0.4 * hash2(cellX, cellY, 23));
      const dy = v * 64 - cellY - (0.3 + 0.4 * hash2(cellX, cellY, 29));
      const angle = hash2(cellX, cellY, 31) * Math.PI;
      const along = dx * Math.cos(angle) + dy * Math.sin(angle);
      const across = (dy * Math.cos(angle) - dx * Math.sin(angle)) * (isShell ? 1.9 : 1.2);
      const radius = (isShell ? 0.2 : 0.12) + 0.16 * hash2(cellX, cellY, 37);
      const d = Math.sqrt(along * along + across * across) / radius;
      fragment = Math.min(1, Math.max(0, (1 - d) * 4));
    }
    const sandColour = mixRgb(base, warm, patch);
    const c = mixRgb(sandColour, isShell ? shell : speck, fragment);
    const k = 0.93 + grain * 0.12 + ripple * 0.03;
    put(t, c, k + (1 - k) * fragment);
    t.height = ripple * 0.22 + grain * 0.4 + (isShell ? 0.25 * fragment : 0);
    t.rough = 0.93 - grain * 0.04;
    t.ao = 0.85 + ripple * 0.15;
  };
}

/**
 * Jungle floor: a mosaic of fallen leaves over dark soil. Four layers, oldest at the bottom (small,
 * dark, half rotted, spotted) to freshest on top (larger, lighter, some still olive), each leaf a
 * pointed lens 6–15 cm long with a midrib and side veins, its edges curled up, and a few bleached
 * twigs over everything. (Three layers of plain 30–50 cm ovals read as paving slabs: the size of the
 * pieces is what makes a floor read as litter.)
 */
export function leafLitter(): TexelSampler {
  const soil = hex(0x34281c);
  const soilDark = hex(0x221810);
  const fresh: Rgb[] = [hex(0x8f6e3c), hex(0x7a5530), hex(0x9a7a44), hex(0x6e6a34), hex(0x6b4a2a), hex(0xa07c46)];
  const old: Rgb[] = [hex(0x5a3d22), hex(0x4a3420), hex(0x3c2a1a), hex(0x5c4428), hex(0x463a26)];
  const twigC = hex(0x655a4a);
  // Cells per 3 m tile, leaf half-length and half-width in cells, chance of a leaf in a cell, how rotted.
  const layers = [
    { g: 60, hl: 0.72, hw: 0.26, p: 1.0, decay: 0.75 },
    { g: 46, hl: 0.74, hw: 0.27, p: 0.95, decay: 0.5 },
    { g: 34, hl: 0.76, hw: 0.28, p: 0.85, decay: 0.25 },
    { g: 24, hl: 0.78, hw: 0.27, p: 0.6, decay: 0.05 },
  ];
  return (u, v, t) => {
    const grain = tileNoise(u * 300, v * 300, 300, 23);
    let colour: Rgb = mixRgb(soil, soilDark, tileFbm(u * 12, v * 12, 12, 3, 21));
    let height = tileFbm(u * 8, v * 8, 8, 3, 21) * 0.15;
    let found = false;
    let rough = 0.95;
    let ao = 0.55;
    // Twigs on top: thin bleached rods, a cell in eight.
    {
      const g = 14;
      const cx = Math.floor(u * g);
      const cy = Math.floor(v * g);
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const ix = (((cx + dx) % g) + g) % g;
          const iy = (((cy + dy) % g) + g) % g;
          if (hash2(ix, iy, 501) > 0.13) continue;
          const px = (cx + dx + hash2(ix, iy, 502)) / g;
          const py = (cy + dy + hash2(ix, iy, 503)) / g;
          const a = hash2(ix, iy, 504) * Math.PI;
          const ox = u - px;
          const oy = v - py;
          const lx = (ox * Math.cos(a) + oy * Math.sin(a)) * g;
          // A gentle bend along its length, and a little thinner toward the tip.
          const ly = (-ox * Math.sin(a) + oy * Math.cos(a)) * g - (lx * lx - 1) * (hash2(ix, iy, 506) - 0.5) * 0.12;
          const w = (0.022 + hash2(ix, iy, 505) * 0.018) * (1 - lx * 0.25);
          if (Math.abs(lx) < 1.1 && Math.abs(ly) < w) {
            const round = 1 - (ly / w) ** 2;
            put(t, twigC, (0.6 + round * 0.35) * (0.85 + grain * 0.3));
            height = 1.25 + round * 0.12;
            rough = 0.85;
            ao = 1;
            found = true;
          }
        }
      }
    }
    for (let L = layers.length - 1; L >= 0 && !found; L--) {
      const { g, hl, hw, p, decay } = layers[L] as (typeof layers)[number];
      const cx = Math.floor(u * g);
      const cy = Math.floor(v * g);
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const ix = (((cx + dx) % g) + g) % g;
          const iy = (((cy + dy) % g) + g) % g;
          if (hash2(ix, iy, 13 + L) > p) continue;
          const r1 = hash2(ix, iy, 31 + L);
          const r2 = hash2(ix, iy, 47 + L);
          const a = hash2(ix, iy, 59 + L) * Math.PI * 2;
          const size = 0.8 + hash2(ix, iy, 61 + L) * 0.45;
          const px = (cx + dx + 0.15 + r1 * 0.7) / g;
          const py = (cy + dy + 0.15 + r2 * 0.7) / g;
          const ox = u - px;
          const oy = v - py;
          const lx = ((ox * Math.cos(a) + oy * Math.sin(a)) * g) / size;
          const ly = ((-ox * Math.sin(a) + oy * Math.cos(a)) * g) / size;
          const along = lx / hl;
          if (Math.abs(along) >= 1) continue;
          // A pointed lens: widest a little below the middle, tapering to tip and stalk.
          const half = hw * Math.pow(1 - along * along, 0.8) * (1 - 0.15 * along);
          const across = Math.abs(ly) / Math.max(half, 1e-4);
          if (across >= 1) continue;
          const pal = decay > 0.4 ? old : fresh;
          let c = pal[Math.floor(hash2(ix, iy, 71 + L) * pal.length)] as Rgb;
          // Rot: dark blotches and a greyer, darker leaf the older the layer.
          const spots = tileNoise(u * g * 1.7, v * g * 1.7, g * 1.7, 90 + L);
          if (spots > 1 - decay * 0.55) c = mixRgb(c, soilDark, 0.7);
          c = mixRgb(c, soil, decay * 0.35);
          // Midrib, side veins running out to the edge, the margin a little darker.
          const midrib = Math.abs(ly) < 0.012 ? 0.82 : 1;
          const vein = Math.abs(((lx * 5 + Math.abs(ly) * 7) % 1 + 1) % 1 - 0.5) < 0.05 ? 0.92 : 1;
          const margin = across > 0.85 ? 0.85 : 1;
          put(t, c, (0.82 + grain * 0.12) * midrib * vein * margin);
          // Curled up at the edges, bent along the length.
          height = 0.3 + L * 0.16 + across * across * 0.18 + (1 - along * along) * 0.05;
          rough = 0.7 + decay * 0.2;
          ao = 0.85 + L * 0.05;
          found = true;
        }
      }
    }
    if (!found) put(t, colour, 0.8 + height + grain * 0.15);
    t.height = height;
    t.rough = rough;
    t.ao = ao;
  };
}

/**
 * Short fibres scattered per cell in random directions (each texel checks its 3 × 3 cells): the top one
 * covering (u, v), as [crossness 0…1, the fibre's own random], or [-1, 0] (Field Line `patterns.ts`).
 */
function fibreAt(u: number, v: number, cells: number, per: number, len: number, width: number, seed: number): [number, number] {
  const cx = Math.floor(u * cells);
  const cy = Math.floor(v * cells);
  let best: [number, number] = [-1, 0];
  let bestTop = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = (((cx + dx) % cells) + cells) % cells;
      const gy = (((cy + dy) % cells) + cells) % cells;
      for (let k = 0; k < per; k++) {
        const h = (n: number): number => hash2(gx * 7 + k, gy * 13 + n, seed);
        const fx = (cx + dx + h(1)) / cells;
        const fy = (cy + dy + h(2)) / cells;
        const a = h(3) * Math.PI;
        const l = len * (0.6 + h(4) * 0.8);
        const ox = u - fx;
        const oy = v - fy;
        const along = ox * Math.cos(a) + oy * Math.sin(a);
        const across = -ox * Math.sin(a) + oy * Math.cos(a);
        if (Math.abs(along) > l / 2 || Math.abs(across) > width) continue;
        const top = h(5);
        if (top > bestTop) {
          bestTop = top;
          best = [1 - Math.abs(across) / width, h(6)];
        }
      }
    }
  }
  return best;
}

/**
 * Tropical turf (3.6 m tile): blades 6–15 cm lying every which way in three layers over dark soil, greens
 * and yellow-greens with dry straw in patches, thinning to sand where the turf is bare. (Two stretched
 * noises crossed at 90° wove it like a knitted carpet: playbook §6g.)
 */
export function tropicalGrass(): TexelSampler {
  const soil = hex(0x3a3220);
  const sandC = hex(0xbfae88);
  const greens: Rgb[] = [hex(0x3f6a22), hex(0x4a7428), hex(0x34581c), hex(0x5f7a2c)];
  const straw = hex(0x8a8150);
  const layers = [
    { cells: 34, per: 1, seed: 811, shade: 1.0, height: 0.85 },
    { cells: 46, per: 2, seed: 812, shade: 0.85, height: 0.6 },
    { cells: 58, per: 2, seed: 813, shade: 0.68, height: 0.35 },
  ];
  return (u, v, t) => {
    const patch = tileFbm(u * 3, v * 3, 3, 3, 83);
    const bare = tileFbm(u * 5, v * 5, 5, 3, 85);
    // How much of the ground the blades cover: thin where the turf is bare.
    const cover = 1 - Math.min(1, Math.max(0, (bare - 0.6) / 0.12)) * 0.75;
    const dryK = Math.max(0, patch * 1.5 - 0.6);
    t.rough = 0.86;
    for (const L of layers) {
      const [hit, r] = fibreAt(u, v, L.cells, L.per, 0.03, 0.0011, L.seed);
      if (hit < 0 || r > cover) continue;
      let c = greens[Math.floor(r * 7.3) % greens.length] as Rgb;
      if (hash2(Math.floor(r * 1e6), 0, 817) < dryK) c = straw;
      put(t, c, (0.75 + hit * 0.3) * L.shade);
      t.height = L.height + hit * 0.15;
      t.ao = 0.6 + L.shade * 0.4;
      return;
    }
    put(t, mixRgb(soil, sandC, Math.min(1, Math.max(0, (bare - 0.55) / 0.15))), 0.85 + patch * 0.2);
    t.height = 0.1;
    t.ao = 0.55;
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
/**
 * Wind ripples as a height field. Isotropic, with a domain warp: the earlier
 * pattern was stretched 2:1 along one axis, and the caustics splatted from it
 * (caustics.ts) came out blocky and axis-aligned.
 */
export function waterRipples(): TexelSampler {
  return (u, v, t) => {
    t.r = 0.5;
    t.g = 0.5;
    t.b = 0.5;
    const wu = tileFbm(u * 3, v * 3, 3, 2, 5) * 0.35;
    const wv = tileFbm(u * 3 + 5, v * 3 + 2, 3, 2, 7) * 0.35;
    const a = tileFbm((u + wu) * 6, (v + wv) * 6, 6, 5, 131);
    const b = tileFbm(u * 13 + a * 0.6, v * 13, 13, 4, 133);
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

/**
 * Tileable round holes on a g × g jittered grid, each with its own radius:
 * 1 at a hole's centre, falling to 0 at its rim, 0 between holes.
 */
function roundHoles(u: number, v: number, g: number, seed: number): number {
  const cx = Math.floor(u * g);
  const cy = Math.floor(v * g);
  let best = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ix = (((cx + dx) % g) + g) % g;
      const iy = (((cy + dy) % g) + g) % g;
      const px = (cx + dx + 0.1 + hash2(ix, iy, seed) * 0.8) / g;
      const py = (cy + dy + 0.1 + hash2(ix, iy, seed + 1) * 0.8) / g;
      const radius = 0.3 + hash2(ix, iy, seed + 2) * 0.5; // in cell units
      const d = (Math.hypot(u - px, v - py) * g) / radius;
      best = Math.max(best, 1 - d);
    }
  }
  return Math.max(0, best);
}

/**
 * Surf-foam lace (after Tidewater's lace texture, Dan Greenheck, MIT), one
 * tile = 3.5 m. Thresholding R by the foam amount gives a dense mat when the
 * foam is fresh; as it thins, round holes of many sizes open and merge until
 * only irregular strands and patches are left — foam, not a honeycomb (a net
 * of Worley cell edges read as regular paving stones).
 *   R  "hole-ness": 0 where foam lasts longest, 1 where it clears first
 *   G  small bubbles clustered where the foam is thin
 *   B  soft mottling (density variation)
 *   A  a random value per cell (staggers when stranded foam pops)
 */
export function laceValue(u: number, v: number): [number, number, number, number] {
  const wrap = (x: number): number => ((x % 1) + 1) % 1;
  // A strong warp so holes are never round-in-a-grid.
  const wu = wrap(u + (tileFbm(u * 3, v * 3, 3, 4, 161) - 0.5) * 0.22);
  const wv = wrap(v + (tileFbm(u * 3 + 7, v * 3 + 3, 3, 4, 163) - 0.5) * 0.22);
  const big = roundHoles(wu, wv, 6, 171);
  const small = roundHoles(wrap(wu * 2), wrap(wv * 2), 7, 175);
  const tiny = roundHoles(wrap(wu * 4), wrap(wv * 4), 9, 181);
  const mottle = tileFbm(u * 5, v * 5, 5, 5, 177);
  const hole = Math.max(big, small * 0.85, tiny * 0.6);
  const r = Math.min(1, Math.max(0, hole * 0.8 + (mottle - 0.5) * 0.45 + 0.12));
  const bubbles = tileNoise(u * 96, v * 96, 96, 185) > 0.7 && r > 0.25 && r < 0.6 ? 1 : 0;
  const cellRand = hash2(Math.floor(wu * 6), Math.floor(wv * 6), 179);
  return [r, bubbles, tileFbm(u * 3, v * 3, 3, 3, 187), cellRand];
}
