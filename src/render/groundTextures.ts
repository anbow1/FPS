import * as THREE from 'three';
import { tileableFbm } from '../core/noise';
import { Rng } from '../core/rng';
import { hyp2, hyp3 } from '../core/mathx';

/**
 * Close-range ground layers, generated once at load (tileable, 512²):
 *   0 meadow floor (fresh + dead grass, clover), 1 dry soil with pebbles,
 *   2 granite with cracks and lichen, 3 wet mud.
 * Albedo is centred on the sheet colours; alpha holds a height used for height-blending and
 * the second array holds tangent-space XY normals derived from that height.
 */
export const GROUND_SIZE = 512;

export interface GroundLayers {
  albedo: THREE.DataArrayTexture; // rgb albedo (sRGB), a height
  normal: THREE.DataArrayTexture; // rg normal xy, b ao
}

type Layer = { rgb: Float32Array; h: Float32Array };

const S = GROUND_SIZE;
const wrap = (v: number) => ((v % S) + S) % S;

/** Tileable Worley: nearest and second-nearest feature distance (in pixels) and the nearest id. */
function worley(cells: number, seed: number): { f1: Float32Array; f2: Float32Array; id: Float32Array } {
  const rng = new Rng(seed);
  const cs = S / cells;
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = rng.next();
    pts[i * 2 + 1] = rng.next();
  }
  const f1 = new Float32Array(S * S);
  const f2 = new Float32Array(S * S);
  const id = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const cy = Math.floor(y / cs);
    for (let x = 0; x < S; x++) {
      const cx = Math.floor(x / cs);
      let d1 = 1e9;
      let d2 = 1e9;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          const wx = ((gx % cells) + cells) % cells;
          const wy = ((gy % cells) + cells) % cells;
          const k = wy * cells + wx;
          const px = (gx + pts[k * 2]!) * cs;
          const py = (gy + pts[k * 2 + 1]!) * cs;
          const d = hyp2(px - x, py - y);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = k;
          } else if (d < d2) d2 = d;
        }
      }
      const i = y * S + x;
      f1[i] = d1;
      f2[i] = d2;
      id[i] = best;
    }
  }
  return { f1, f2, id };
}

const hashId = (k: number, s: number) => {
  let h = Math.imul(k ^ s, 2654435761);
  h ^= h >>> 15;
  return ((h >>> 0) % 10000) / 10000;
};

function srgbToLin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const col = (hex: number): [number, number, number] => [srgbToLin(((hex >> 16) & 255) / 255), srgbToLin(((hex >> 8) & 255) / 255), srgbToLin((hex & 255) / 255)];

function meadow(seed: number): Layer {
  const rng = new Rng(seed);
  const rgb = new Float32Array(S * S * 3);
  const h = new Float32Array(S * S);
  const base = tileableFbm(S, 8, 4, seed);
  const fresh = col(0x4a6030);
  const dry = col(0x6d7343);
  const earth = col(0x5a4a38);
  for (let i = 0; i < S * S; i++) {
    const b = base[i]!;
    const m = 0.35 + 0.3 * b;
    rgb[i * 3] = earth[0] * (1 - m) + fresh[0] * m;
    rgb[i * 3 + 1] = earth[1] * (1 - m) + fresh[1] * m;
    rgb[i * 3 + 2] = earth[2] * (1 - m) + fresh[2] * m;
    h[i] = 0.25 * b;
  }
  // grass blades seen from above: short strokes, fresh and dead, some clover dots
  const strokes = 26000;
  for (let n = 0; n < strokes; n++) {
    const x0 = rng.next() * S;
    const y0 = rng.next() * S;
    const a = rng.next() * Math.PI * 2;
    const len = rng.range(4, 11);
    const deadBlade = rng.next() < 0.3;
    const c = deadBlade ? dry : fresh;
    const k = rng.range(0.7, 1.45);
    const height = rng.range(0.55, 1);
    for (let t = 0; t < len; t += 0.7) {
      const x = wrap(Math.round(x0 + Math.cos(a) * t));
      const y = wrap(Math.round(y0 + Math.sin(a) * t));
      const i = y * S + x;
      const ht = height * (1 - (t / len) * 0.5);
      if (ht > h[i]!) {
        h[i] = ht;
        rgb[i * 3] = c[0] * k * (0.8 + 0.4 * (t / len));
        rgb[i * 3 + 1] = c[1] * k * (0.8 + 0.4 * (t / len));
        rgb[i * 3 + 2] = c[2] * k * (0.8 + 0.4 * (t / len));
      }
    }
  }
  for (let n = 0; n < 900; n++) {
    const x0 = rng.next() * S;
    const y0 = rng.next() * S;
    const r = rng.range(1.5, 3);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const i = wrap(Math.round(y0 + dy)) * S + wrap(Math.round(x0 + dx));
        h[i] = Math.max(h[i]!, 0.7);
        rgb[i * 3] = fresh[0] * 0.9;
        rgb[i * 3 + 1] = fresh[1] * 1.15;
        rgb[i * 3 + 2] = fresh[2] * 0.8;
      }
    }
  }
  return { rgb, h };
}

function soil(seed: number): Layer {
  const rgb = new Float32Array(S * S * 3);
  const h = new Float32Array(S * S);
  const base = tileableFbm(S, 16, 5, seed);
  const clod = tileableFbm(S, 32, 3, seed + 1);
  const w = worley(24, seed + 2);
  const soilC = col(0x6b5a47);
  const stone = col(0x8a857c);
  for (let i = 0; i < S * S; i++) {
    const k = 0.72 + 0.5 * base[i]! + 0.15 * (clod[i]! - 0.5);
    let r = soilC[0] * k;
    let g = soilC[1] * k;
    let b = soilC[2] * k;
    let ht = 0.3 * base[i]! + 0.15 * clod[i]!;
    // pebbles: domes inside Worley cells with a random radius, some cells empty
    const idv = w.id[i]!;
    const pr = hashId(idv, seed) < 0.55 ? (S / 24) * (0.18 + 0.28 * hashId(idv, seed + 7)) : 0;
    const d = w.f1[i]!;
    if (d < pr) {
      const dome = Math.sqrt(1 - (d / pr) ** 2);
      const tone = 0.6 + 0.7 * hashId(idv, seed + 3);
      const warm = hashId(idv, seed + 5);
      r = stone[0] * tone * (1 + warm * 0.2) * (0.8 + 0.3 * dome);
      g = stone[1] * tone * (0.8 + 0.3 * dome);
      b = stone[2] * tone * (1 - warm * 0.15) * (0.8 + 0.3 * dome);
      ht = 0.45 + 0.55 * dome;
    }
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    h[i] = ht;
  }
  return { rgb, h };
}

function rock(seed: number): Layer {
  const rgb = new Float32Array(S * S * 3);
  const h = new Float32Array(S * S);
  const big = tileableFbm(S, 4, 6, seed);
  const grain = tileableFbm(S, 64, 2, seed + 1);
  const lich = tileableFbm(S, 16, 4, seed + 2);
  const w = worley(9, seed + 3);
  const rc = col(0x7a7672);
  for (let i = 0; i < S * S; i++) {
    const crack = Math.min(1, (w.f2[i]! - w.f1[i]!) / 3.5);
    const k = (0.65 + 0.55 * big[i]!) * (0.85 + 0.3 * grain[i]!) * (0.45 + 0.55 * crack);
    let r = rc[0] * k;
    let g = rc[1] * k;
    let b = rc[2] * k;
    const l = lich[i]!;
    if (l > 0.64) {
      // crustose lichen: pale grey-green and ochre spots
      const t = Math.min(1, (l - 0.64) * 8);
      const ochre = big[i]! > 0.55;
      r = r * (1 - t) + (ochre ? 0.32 : 0.2) * t;
      g = g * (1 - t) + (ochre ? 0.26 : 0.24) * t;
      b = b * (1 - t) + (ochre ? 0.08 : 0.16) * t;
    }
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    h[i] = 0.3 + 0.5 * big[i]! * crack + 0.1 * grain[i]!;
  }
  return { rgb, h };
}

function mud(seed: number): Layer {
  const rgb = new Float32Array(S * S * 3);
  const h = new Float32Array(S * S);
  const base = tileableFbm(S, 8, 5, seed);
  const fine = tileableFbm(S, 64, 2, seed + 1);
  const mc = col(0x3e3328);
  for (let i = 0; i < S * S; i++) {
    const k = 0.75 + 0.45 * base[i]! + 0.1 * fine[i]!;
    rgb[i * 3] = mc[0] * k;
    rgb[i * 3 + 1] = mc[1] * k;
    rgb[i * 3 + 2] = mc[2] * k;
    h[i] = 0.2 + 0.5 * base[i]! + 0.08 * fine[i]!;
  }
  return { rgb, h };
}

export function makeGroundLayers(seed: number): GroundLayers {
  const layers = [meadow(seed + 1), soil(seed + 2), rock(seed + 3), mud(seed + 4)];
  const n = layers.length;
  const alb = new Uint8Array(S * S * 4 * n);
  const nrm = new Uint8Array(S * S * 4 * n);
  const toSrgb = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  };
  const strength = [1.2, 1.8, 2.4, 0.8];
  layers.forEach((L, li) => {
    const off = li * S * S * 4;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const o = off + i * 4;
        alb[o] = toSrgb(L.rgb[i * 3]!);
        alb[o + 1] = toSrgb(L.rgb[i * 3 + 1]!);
        alb[o + 2] = toSrgb(L.rgb[i * 3 + 2]!);
        alb[o + 3] = Math.round(Math.min(1, Math.max(0, L.h[i]!)) * 255);
        const hx = L.h[y * S + wrap(x + 1)]! - L.h[y * S + wrap(x - 1)]!;
        const hy = L.h[wrap(y + 1) * S + x]! - L.h[wrap(y - 1) * S + x]!;
        const nx = -hx * strength[li]!;
        const ny = -hy * strength[li]!;
        const l = hyp3(nx, ny, 1);
        nrm[o] = Math.round((nx / l * 0.5 + 0.5) * 255);
        nrm[o + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
        // cavity AO from local height
        const avg = (L.h[y * S + wrap(x + 2)]! + L.h[y * S + wrap(x - 2)]! + L.h[wrap(y + 2) * S + x]! + L.h[wrap(y - 2) * S + x]!) / 4;
        nrm[o + 2] = Math.round(Math.min(1, Math.max(0, 0.75 + (L.h[i]! - avg) * 2.5)) * 255);
        nrm[o + 3] = 255;
      }
    }
  });
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataArrayTexture(data, S, S, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(alb, true), normal: mk(nrm, false) };
}
