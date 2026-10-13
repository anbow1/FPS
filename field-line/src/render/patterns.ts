import { tileFbm, tileNoise } from '../core/noise.ts';
import type { Texel, TexelSampler } from './textures.ts';

// Surface patterns for the procedural texture sets. Base colours are the sRGB
// hex values of pbr-material-reference.png; variation stays inside the sheet's
// non-metal range (linear luminance 0.021–0.92). Each sampler tiles on [0, 1).

type Rgb = [number, number, number];

export function hex(h: number): Rgb {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

function put(t: Texel, c: Rgb, k: number): void {
  t.r = c[0] * k;
  t.g = c[1] * k;
  t.b = c[2] * k;
}

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Asphalt: aggregate speckle in a binder. Sheet: dry #3A3A3C rough 0.92. */
export function asphalt(colour: number, rough: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const blotch = tileFbm(u * 4, v * 4, 4, 3, 1);
    const grain = tileNoise(u * 96, v * 96, 96, 2);
    const stone = grain > 0.72 ? 1.25 : grain < 0.2 ? 0.85 : 1;
    put(t, c, (0.88 + blotch * 0.22) * stone);
    t.height = grain * 0.7 + blotch * 0.3;
    t.rough = rough + (stone > 1 ? -0.04 : 0.02);
    t.ao = 0.85 + grain * 0.15;
  };
}

/** Weathered concrete: blotches, pores. Sheet #8F8B85 rough 0.88. */
export function concrete(colour: number, rough: number, seed = 3): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const blotch = tileFbm(u * 3, v * 3, 3, 4, seed);
    const pore = tileNoise(u * 128, v * 128, 128, seed + 5);
    const stain = tileFbm(u * 2, v * 8, 2, 3, seed + 9);
    put(t, c, 0.84 + blotch * 0.26 - (stain > 0.62 ? 0.08 : 0) - (pore < 0.1 ? 0.12 : 0));
    t.height = blotch * 0.3 + (pore < 0.1 ? 0 : 0.6) + pore * 0.1;
    t.rough = rough;
    t.ao = pore < 0.1 ? 0.7 : 1;
  };
}

/** Pavement slabs, 4 × 4 per tile, with sunken seams. */
export function pavement(colour: number): TexelSampler {
  const base = concrete(colour, 0.85, 17);
  return (u, v, t) => {
    base(u, v, t);
    const fu = (u * 4) % 1;
    const fv = (v * 4) % 1;
    const seam = Math.min(fu, 1 - fu, fv, 1 - fv) < 0.012;
    const slab = hash2(Math.floor(u * 4), Math.floor(v * 4), 3);
    const k = seam ? 0.62 : 0.94 + slab * 0.1;
    t.r *= k;
    t.g *= k;
    t.b *= k;
    t.height = seam ? 0 : 0.7 + t.height * 0.3;
    t.ao = seam ? 0.55 : t.ao;
  };
}

/**
 * Running-bond brick. 4 bricks × 12 courses per tile, mapped to 1 m, which is
 * 0.25 × 0.083 m per brick with its joint — a tiling round-off of the real
 * 0.225 × 0.075 m module. Sheet: brick red #8A4B3A rough 0.80.
 */
/**
 * Brick in running bond, `cols` bricks across and `rows` courses up the tile (even, so the bond wraps).
 * A metre tile takes 4 × 12; a façade tile (one bay by one storey) takes real counts, about 13 × 38:
 * a course is 65 mm of brick and 10 mm of mortar, so a 3 m storey holds some 38–40 of them.
 */
export function brick(colour: number, mortar: number, cols = 4, rows = 12): TexelSampler {
  const c = hex(colour);
  const m = hex(mortar);
  // Both tilings put a brick at ~0.25 m and a course at ~0.08 m, so the joint shares (~10 mm) are the same.
  const jointU = 0.04;
  const jointV = 0.12;
  return (u, v, t) => {
    const row = Math.floor(v * rows);
    const shift = row % 2 === 0 ? 0 : 0.5;
    const bu = u * cols + shift;
    const col = Math.floor(bu);
    const fu = bu - col;
    const fv = v * rows - row;
    const joint = fu < jointU || fv < jointV;
    const noise = tileFbm(u * 16, v * 16, 16, 3, 7);
    if (joint) {
      put(t, m, 0.9 + noise * 0.15);
      t.height = 0.1;
      t.rough = 0.9;
      t.ao = 0.65;
      return;
    }
    const tone = hash2(col & 3, row, 11);
    put(t, c, 0.8 + tone * 0.35 + (noise - 0.5) * 0.12);
    t.height = 0.75 + noise * 0.25;
    t.rough = 0.78 + tone * 0.06;
  };
}

/** Painted render (plaster). Not on the sheet; kept at L ≈ 0.4, between concrete and road paint. */
export function plaster(colour: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const n = tileFbm(u * 24, v * 24, 24, 3, 21);
    const dirt = tileFbm(u * 2, v * 2, 2, 3, 22);
    put(t, c, 0.9 + n * 0.12 - Math.max(0, dirt - 0.55) * 0.5);
    t.height = n;
    t.rough = 0.85;
  };
}

/** Wood planks along U, 6 per tile. */
export function planks(colour: number, rough: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const plank = Math.floor(v * 6);
    const fv = v * 6 - plank;
    const offset = hash2(plank, 0, 31);
    const grain = tileFbm((u + offset) * 2, v * 60, 2, 3, 33 + plank);
    const seam = fv < 0.04 || ((u + offset * 0.5) * 2) % 1 < 0.006;
    put(t, c, seam ? 0.55 : 0.8 + grain * 0.35 + (offset - 0.5) * 0.15);
    t.height = seam ? 0 : 0.6 + grain * 0.4;
    t.rough = rough + (grain - 0.5) * 0.1;
    t.ao = seam ? 0.6 : 1;
  };
}

/** Floor tiles, 3 × 3 per tile, grouted. */
export function tiles(colour: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const fu = (u * 3) % 1;
    const fv = (v * 3) % 1;
    const grout = Math.min(fu, 1 - fu, fv, 1 - fv) < 0.02;
    const tone = hash2(Math.floor(u * 3), Math.floor(v * 3), 41);
    put(t, c, grout ? 0.7 : 0.94 + tone * 0.08);
    t.height = grout ? 0 : 1;
    t.rough = grout ? 0.9 : 0.42;
    t.ao = grout ? 0.7 : 1;
  };
}

/** Flat painted or finished surface with fine noise (paint, parkerised steel, rubber). */
export function finish(colour: number, rough: number, metal = 0, grainScale = 32): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const n = tileFbm(u * grainScale, v * grainScale, grainScale, 3, 51);
    put(t, c, 0.94 + n * 0.1);
    t.height = n;
    t.rough = rough + (n - 0.5) * 0.08;
    t.metal = metal;
  };
}

/** Dry-stone blocks in courses of varying height. Sheet granite #7A7672 rough 0.85. */
export function stoneBlocks(colour: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const row = Math.floor(v * 5);
    const fv = v * 5 - row;
    const count = 3 + Math.floor(hash2(row, 1, 61) * 3);
    const bu = u * count + hash2(row, 2, 61);
    const col = Math.floor(bu);
    const fu = bu - col;
    const bump = Math.sin(fu * Math.PI) * Math.sin(fv * Math.PI);
    const n = tileFbm(u * 20, v * 20, 20, 3, 63);
    const joint = bump < 0.18;
    put(t, c, joint ? 0.55 : 0.82 + hash2(col % count, row, 67) * 0.3 + (n - 0.5) * 0.15);
    t.height = joint ? 0 : Math.sqrt(bump) * 0.8 + n * 0.2;
    t.rough = 0.85;
    t.ao = joint ? 0.55 : 1;
  };
}

/** Woven fabric (sandbags, uniforms). Sheet uniform fabric #5A5E48 rough 0.90. */
export function fabric(colour: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const wu = Math.sin(u * Math.PI * 2 * 64);
    const wv = Math.sin(v * Math.PI * 2 * 64);
    const weave = (wu * (Math.floor(v * 128) % 2 === 0 ? 1 : -1) + wv) * 0.25 + 0.5;
    const n = tileFbm(u * 6, v * 6, 6, 3, 71);
    put(t, c, 0.86 + n * 0.2 + weave * 0.06);
    t.height = weave;
    t.rough = 0.9;
  };
}

/** Terrain layers. Sheet: fresh grass #4A6030, dry soil #6B5A47, granite #7A7672. */
/**
 * Short straight fibres scattered in every direction (dead grass, fallen needles), wrapping with the tile:
 * `cells` per side, `per` fibres in each, each `len` long and `width` wide (tile units). Returns the hit
 * fibre's shade 0…1 and a second random for its colour, or −1 where there is none. Directions are random
 * per fibre, so the litter tangles rather than weaves.
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
        // The fibre's centre, in this cell's neighbour copy (so fibres cross cell and tile edges).
        const fx = (cx + dx + h(1)) / cells;
        const fy = (cy + dy + h(2)) / cells;
        const a = h(3) * Math.PI;
        const l = len * (0.6 + h(4) * 0.8);
        const ox = u - fx;
        const oy = v - fy;
        const along = ox * Math.cos(a) + oy * Math.sin(a);
        const across = -ox * Math.sin(a) + oy * Math.cos(a);
        if (Math.abs(along) > l / 2 || Math.abs(across) > width) continue;
        // Later fibres lie on top: keep the highest-ordered hit.
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
 * Meadow ground under the grass blades (the blades themselves are geometry, grassField.ts): dark soil and
 * moss with a tangle of dead and green grass fibres lying in every direction. The old crossed anisotropic
 * noise wove it like a carpet.
 */
export function grass(): TexelSampler {
  const ground = hex(0x3b3f22);
  const moss = hex(0x4a6030);
  const green = hex(0x56702f);
  const dry = hex(0x8a8150);
  return (u, v, t) => {
    const patch = tileFbm(u * 3, v * 3, 3, 3, 83);
    const fine = tileFbm(u * 24, v * 24, 24, 3, 84);
    const base: Rgb = [ground[0] + (moss[0] - ground[0]) * fine, ground[1] + (moss[1] - ground[1]) * fine, ground[2] + (moss[2] - ground[2]) * fine];
    // Sparse enough that moss and earth show between them (three per cell read as a doormat).
    const [hit, r] = fibreAt(u, v, 36, 2, 0.05, 0.0026, 85);
    if (hit >= 0 && r > 0.25) {
      const dryK = Math.min(1, Math.max(0, patch * 1.5 - 0.3 + (r - 0.5) * 0.6));
      const c: Rgb = [green[0] + (dry[0] - green[0]) * dryK, green[1] + (dry[1] - green[1]) * dryK, green[2] + (dry[2] - green[2]) * dryK];
      put(t, c, 0.78 + hit * 0.15);
      t.height = 0.45 + hit * 0.25;
      t.ao = 1;
    } else {
      put(t, base, 0.7 + fine * 0.3);
      t.height = fine * 0.4;
      t.ao = 0.7;
    }
    t.rough = 0.9;
  };
}

/**
 * Bare earth, and the forest floor when `litter` is set: clods and a few pebbles, with fallen needles lying
 * in every direction in rusty browns (the needles were all streaked one way before).
 */
export function soil(colour = 0x6b5a47, litter = 0): TexelSampler {
  const c = hex(colour);
  const needle = hex(0x7a5232);
  const oldNeedle = hex(0x5a4430);
  return (u, v, t) => {
    const clod = tileFbm(u * 10, v * 10, 10, 4, 91);
    const pebble = tileFbm(u * 48, v * 48, 48, 2, 92);
    put(t, c, (0.78 + clod * 0.35) * (pebble > 0.72 ? 1.12 : 1));
    t.height = clod * 0.6 + (pebble > 0.72 ? (pebble - 0.72) * 1.5 : 0);
    t.rough = 0.95;
    if (litter > 0) {
      const [hit, r] = fibreAt(u, v, 48, 2, 0.032, 0.0018, 94);
      if (hit >= 0 && r < litter) {
        const k = (r / litter) * 0.8;
        put(t, [needle[0] + (oldNeedle[0] - needle[0]) * k, needle[1] + (oldNeedle[1] - needle[1]) * k, needle[2] + (oldNeedle[2] - needle[2]) * k], 0.85 + hit * 0.15);
        t.height = 0.55 + hit * 0.2;
      }
    }
  };
}

export function rock(colour = 0x7a7672): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const n = tileFbm(u * 6, v * 6, 6, 5, 101);
    const crack = Math.abs(tileFbm(u * 3, v * 3, 3, 3, 103) - 0.5) < 0.025;
    const lichen = tileFbm(u * 5, v * 5, 5, 3, 105) > 0.64;
    put(t, c, crack ? 0.5 : 0.78 + n * 0.4);
    if (lichen && !crack) {
      t.r *= 0.92;
      t.g *= 1.02;
      t.b *= 0.82;
    }
    t.height = crack ? 0 : n;
    t.rough = 0.85;
    t.ao = crack ? 0.5 : 1;
  };
}

/** Pine bark: deep vertical plates. Sheet #4A3B30 rough 0.93, high normal detail. */
export function bark(): TexelSampler {
  const c = hex(0x4a3b30);
  return (u, v, t) => {
    const plates = tileFbm(u * 8, v * 2, 8, 4, 111);
    const groove = Math.abs(((u * 8 + tileFbm(u * 2, v * 4, 2, 2, 112) * 2) % 1) - 0.5) < 0.08;
    put(t, c, groove ? 0.55 : 0.85 + plates * 0.35);
    t.height = groove ? 0 : 0.5 + plates * 0.5;
    t.rough = 0.93;
    t.ao = groove ? 0.5 : 1;
  };
}

/**
 * Façade bay: one window per tile (one bay by one storey), framed, over the
 * wall pattern. The glass is dark and glossy, so it reflects the sky probe.
 */
export function facade(wall: TexelSampler, frameColour: number): TexelSampler {
  const frame = hex(frameColour);
  const glass: Rgb = [0.16, 0.18, 0.19];
  return (u, v, t) => {
    const inX = u > 0.28 && u < 0.72;
    const inY = v > 0.3 && v < 0.8;
    if (inX && inY) {
      const onFrame = u < 0.3 || u > 0.7 || v < 0.32 || v > 0.78 || Math.abs(u - 0.5) < 0.008;
      if (onFrame) {
        put(t, frame, 1);
        t.rough = 0.5;
        t.height = 0.6;
      } else {
        const blind = hash2(Math.floor(u * 7), 0, 141) > 0.7 && v > 0.62;
        put(t, blind ? [0.55, 0.53, 0.5] : glass, 1);
        t.rough = blind ? 0.8 : 0.05;
        t.height = 0.2;
        t.ao = 0.8;
      }
      return;
    }
    wall(u, v, t);
    if (v > 0.26 && v < 0.3 && u > 0.25 && u < 0.75) {
      // Sill.
      t.r *= 1.15;
      t.g *= 1.15;
      t.b *= 1.15;
      t.height = 1;
    }
  };
}
