import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { tileFbm, tileNoise } from '../core/noise.ts';
import { makeTextureSet } from './textures.ts';
import type { TexelSampler } from './textures.ts';

// Procedural textures for the lake: wind ripples (the water's detail normals,
// also what the caustics are splatted from) and the surf-foam lace. Ported
// from Castaway Lagoon (render/patterns.ts, render/textures.ts).

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Wind ripples as a height field. Isotropic, with a domain warp: an earlier
 * pattern stretched 2:1 along one axis made the caustics it focuses look
 * blocky and axis-aligned.
 */
function waterRipples(): TexelSampler {
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
    t.ao = 1;
    t.metal = 0;
    t.alpha = 1;
  };
}

let ripples: DataTexture | null = null;

/** Normal map of the wind ripples (tile = RIPPLE_TILE_M.coarse). */
export function rippleNormalMap(): DataTexture {
  ripples ??= makeTextureSet(256, waterRipples(), 6).normalMap;
  return ripples;
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
 * only irregular strands and patches are left.
 *   R  "hole-ness": 0 where foam lasts longest, 1 where it clears first
 *   G  small bubbles where the foam is thin
 *   B  soft mottling
 *   A  a random value per cell
 */
function laceValue(u: number, v: number): [number, number, number, number] {
  const wrap = (x: number): number => ((x % 1) + 1) % 1;
  const wu = wrap(u + (tileFbm(u * 3, v * 3, 3, 4, 161) - 0.5) * 0.22);
  const wv = wrap(v + (tileFbm(u * 3 + 7, v * 3 + 3, 3, 4, 163) - 0.5) * 0.22);
  const big = roundHoles(wu, wv, 6, 171);
  const small = roundHoles(wrap(wu * 2), wrap(wv * 2), 7, 175);
  const tiny = roundHoles(wrap(wu * 4), wrap(wv * 4), 9, 181);
  const mottle = tileFbm(u * 5, v * 5, 5, 5, 177);
  const hole = Math.max(big, small * 0.85, tiny * 0.6);
  const r = Math.min(1, Math.max(0, hole * 0.8 + (mottle - 0.5) * 0.45 + 0.12));
  const bubbles = tileNoise(u * 96, v * 96, 96, 185) > 0.7 && r > 0.25 && r < 0.6 ? 1 : 0;
  return [r, bubbles, tileFbm(u * 3, v * 3, 3, 3, 187), hash2(Math.floor(wu * 6), Math.floor(wv * 6), 179)];
}

let lace: DataTexture | null = null;

/** Surf-foam lace, one tile = 3.5 m. */
export function laceMap(): DataTexture {
  if (lace) return lace;
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  const to8 = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = laceValue((x + 0.5) / size, (y + 0.5) / size);
      const i = (y * size + x) * 4;
      data[i] = to8(r);
      data[i + 1] = to8(g);
      data[i + 2] = to8(b);
      data[i + 3] = to8(a);
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.colorSpace = NoColorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  lace = t;
  return t;
}
