import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three/webgpu';
import { tileFbm } from '../core/noise.ts';
import { Rng } from '../core/rng.ts';

// Close-range ground, generated once at load (tileable, after Tanks'
// groundTextures.ts and docs/graphics-playbook.md §2–3). The terrain shader
// keeps its colours from the air — the field plots, the heath, the strata — and
// takes from these layers only what a few metres show: grass blades and clover,
// clods and pebbles, cracks and lichen, needles and twigs. So each layer's
// albedo is used as a ratio to its own mean (`means`), which the mips average
// back to 1 at altitude: the land seen from 2 km is unchanged, the land seen
// from the pad is no longer a flat colour.
//
//   0 meadow   fresh and dead blades seen from above, clover, earth between
//   1 soil     ploughed or trodden earth: clods, furrow grit, pebbles
//   2 rock     granite: plates, cracks, grain, crustose lichen
//   3 litter   forest floor and heath: needles, twigs, moss cushions, leaves
//
// Albedo array: sRGB colour, alpha = height (for the height blend). Normal
// array: tangent-plane XY of the height's slope, B = cavity AO.

export interface GroundLayers {
  albedo: DataArrayTexture;
  normal: DataArrayTexture;
  /** Linear mean albedo of each layer (what the ratio divides by). */
  means: [number, number, number][];
  size: number;
}

type Layer = { rgb: Float32Array; h: Float32Array };

function srgbToLin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const col = (hex: number): [number, number, number] => [srgbToLin(((hex >> 16) & 255) / 255), srgbToLin(((hex >> 8) & 255) / 255), srgbToLin((hex & 255) / 255)];

function hashId(k: number, s: number): number {
  let h = Math.imul(k ^ Math.imul(s, 0x9e3779b1), 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A tileable fbm grid over `S`², `cells` lattice cells per side at the first octave. */
function fbmGrid(S: number, cells: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = tileFbm((x / S) * cells, (y / S) * cells, cells, octaves, seed) / (1 - 0.5 ** octaves);
  return out;
}

/** Tileable Worley: nearest and second-nearest distance (texels) and the nearest cell's id. */
function worley(S: number, cells: number, seed: number): { f1: Float32Array; f2: Float32Array; id: Int32Array } {
  const rng = new Rng(seed);
  const cs = S / cells;
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < pts.length; i++) pts[i] = rng.next();
  const f1 = new Float32Array(S * S);
  const f2 = new Float32Array(S * S);
  const id = new Int32Array(S * S);
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
          const k = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const d = Math.hypot((gx + pts[k * 2]!) * cs - x, (gy + pts[k * 2 + 1]!) * cs - y);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = k;
          } else if (d < d2) d2 = d;
        }
      }
      f1[y * S + x] = d1;
      f2[y * S + x] = d2;
      id[y * S + x] = best;
    }
  }
  return { f1, f2, id };
}

/** Draws a tapering stroke into the layer where it stands taller than what is there. */
function stroke(L: Layer, S: number, x0: number, y0: number, a: number, len: number, widthPx: number, height: number, c: readonly number[], k: number, droop = 0): void {
  const wrap = (v: number): number => ((v % S) + S) % S;
  for (let t = 0; t < len; t += 0.6) {
    const f = t / len;
    // A blade seen from above curves a little as it bends over.
    const ang = a + droop * f * f;
    const x = x0 + Math.cos(ang) * t;
    const y = y0 + Math.sin(ang) * t;
    const w = widthPx * (1 - f * 0.7);
    for (let o = -w; o <= w; o += 0.7) {
      const xi = wrap(Math.round(x - Math.sin(ang) * o));
      const yi = wrap(Math.round(y + Math.cos(ang) * o));
      const i = yi * S + xi;
      const ht = height * (1 - f * 0.45);
      if (ht <= L.h[i]!) continue;
      L.h[i] = ht;
      // Lit along the middle, darker toward the root (where it leaves the shade of the sward).
      const shade = k * (0.72 + 0.4 * f) * (1 - (Math.abs(o) / Math.max(w, 0.5)) * 0.15);
      L.rgb[i * 3] = c[0]! * shade;
      L.rgb[i * 3 + 1] = c[1]! * shade;
      L.rgb[i * 3 + 2] = c[2]! * shade;
    }
  }
}

function meadow(S: number, seed: number): Layer {
  const rng = new Rng(seed);
  const L: Layer = { rgb: new Float32Array(S * S * 3), h: new Float32Array(S * S) };
  const base = fbmGrid(S, 8, 4, seed);
  const fresh = col(0x4d6431);
  const lush = col(0x3f5a28);
  const dry = col(0x7a7a4a);
  const earth = col(0x564836);
  for (let i = 0; i < S * S; i++) {
    const m = 0.3 + 0.35 * base[i]!;
    for (let c = 0; c < 3; c++) L.rgb[i * 3 + c] = earth[c]! * (1 - m) + fresh[c]! * m * 0.8;
    L.h[i] = 0.2 * base[i]!;
  }
  // Blades seen from above: tens of thousands of short strokes in every direction, a third dead.
  const scale = S / 512;
  const blades = Math.round(30000 * scale * scale);
  for (let n = 0; n < blades; n++) {
    const x = rng.next() * S;
    const y = rng.next() * S;
    const dead = rng.next() < 0.28;
    const c = dead ? dry : rng.next() < 0.5 ? fresh : lush;
    stroke(L, S, x, y, rng.next() * Math.PI * 2, rng.range(5, 13) * scale, 0.9 * scale, rng.range(0.5, 1), c, rng.range(0.75, 1.35), rng.range(-0.6, 0.6));
  }
  // Clover and plantain rosettes: small round leaves in threes, a little bluer green.
  const clover = col(0x4a6a34);
  for (let n = 0; n < Math.round(700 * scale * scale); n++) {
    const cx = rng.next() * S;
    const cy = rng.next() * S;
    const r = rng.range(1.4, 2.6) * scale;
    for (let leaf = 0; leaf < 3; leaf++) {
      const a = (leaf / 3) * Math.PI * 2 + rng.next();
      const lx = cx + Math.cos(a) * r;
      const ly = cy + Math.sin(a) * r;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const d2 = (dx * dx + dy * dy) / (r * r);
          if (d2 > 1) continue;
          const i = ((((Math.round(ly + dy) % S) + S) % S) * S + (((Math.round(lx + dx) % S) + S) % S));
          const ht = 0.62 + 0.2 * (1 - d2);
          if (ht <= L.h[i]!) continue;
          L.h[i] = ht;
          const k = 0.85 + 0.3 * (1 - d2);
          for (let c = 0; c < 3; c++) L.rgb[i * 3 + c] = clover[c]! * k;
        }
      }
    }
  }
  return L;
}

function soil(S: number, seed: number): Layer {
  const L: Layer = { rgb: new Float32Array(S * S * 3), h: new Float32Array(S * S) };
  const base = fbmGrid(S, 12, 5, seed);
  const clod = fbmGrid(S, 40, 3, seed + 1);
  const w = worley(S, 22, seed + 2);
  const clods = worley(S, 60, seed + 4);
  const soilC = col(0x6b5642);
  const dark = col(0x4a3b2c);
  const stone = col(0x8c867c);
  for (let i = 0; i < S * S; i++) {
    // Clods: rounded lumps in a Worley lattice, their tops drier and paler than the hollows.
    const lump = Math.max(0, 1 - clods.f1[i]! / ((S / 60) * 0.75));
    const k = 0.75 + 0.45 * base[i]! + 0.18 * (clod[i]! - 0.5) + 0.15 * lump;
    const m = Math.min(1, Math.max(0, 0.5 - lump * 0.6 + (base[i]! - 0.5)));
    let r = (soilC[0] * (1 - m) + dark[0] * m) * k;
    let g = (soilC[1] * (1 - m) + dark[1] * m) * k;
    let b = (soilC[2] * (1 - m) + dark[2] * m) * k;
    let ht = 0.25 * base[i]! + 0.3 * lump + 0.1 * clod[i]!;
    // Pebbles: domes in some Worley cells, each its own tone.
    const idv = w.id[i]!;
    const pr = hashId(idv, seed) < 0.45 ? (S / 22) * (0.14 + 0.24 * hashId(idv, seed + 7)) : 0;
    const d = w.f1[i]!;
    if (d < pr) {
      const dome = Math.sqrt(1 - (d / pr) ** 2);
      const tone = 0.6 + 0.7 * hashId(idv, seed + 3);
      const warm = hashId(idv, seed + 5);
      r = stone[0] * tone * (1 + warm * 0.2) * (0.78 + 0.3 * dome);
      g = stone[1] * tone * (0.78 + 0.3 * dome);
      b = stone[2] * tone * (1 - warm * 0.15) * (0.78 + 0.3 * dome);
      ht = 0.5 + 0.5 * dome;
    }
    L.rgb[i * 3] = r;
    L.rgb[i * 3 + 1] = g;
    L.rgb[i * 3 + 2] = b;
    L.h[i] = ht;
  }
  return L;
}

function rock(S: number, seed: number): Layer {
  const L: Layer = { rgb: new Float32Array(S * S * 3), h: new Float32Array(S * S) };
  const big = fbmGrid(S, 4, 6, seed);
  const grain = fbmGrid(S, 96, 2, seed + 1);
  const lich = fbmGrid(S, 14, 4, seed + 2);
  const plates = worley(S, 7, seed + 3);
  const fine = worley(S, 26, seed + 5);
  const rc = col(0x7c7873);
  for (let i = 0; i < S * S; i++) {
    // Joints between plates (wide, deep) and a finer crack net inside them.
    const joint = Math.min(1, (plates.f2[i]! - plates.f1[i]!) / (S / 128));
    const crack = Math.min(1, (fine.f2[i]! - fine.f1[i]!) / (S / 400));
    const plateTone = 0.85 + 0.3 * hashId(plates.id[i]!, seed);
    const k = (0.62 + 0.55 * big[i]!) * (0.82 + 0.35 * grain[i]!) * (0.35 + 0.65 * joint) * (0.75 + 0.25 * crack) * plateTone;
    let r = rc[0] * k;
    let g = rc[1] * k;
    let b = rc[2] * k;
    const l = lich[i]!;
    if (l > 0.62 && joint > 0.5) {
      // Crustose lichen: pale grey-green rosettes, ochre where the stone is warmer.
      const t = Math.min(1, (l - 0.62) * 7);
      const ochre = big[i]! > 0.58;
      r = r * (1 - t) + (ochre ? 0.34 : 0.22) * t;
      g = g * (1 - t) + (ochre ? 0.27 : 0.25) * t;
      b = b * (1 - t) + (ochre ? 0.09 : 0.17) * t;
    }
    L.rgb[i * 3] = r;
    L.rgb[i * 3 + 1] = g;
    L.rgb[i * 3 + 2] = b;
    L.h[i] = (0.25 + 0.55 * big[i]!) * joint * (0.85 + 0.15 * crack) + 0.08 * grain[i]!;
  }
  return L;
}

function litter(S: number, seed: number): Layer {
  const rng = new Rng(seed);
  const L: Layer = { rgb: new Float32Array(S * S * 3), h: new Float32Array(S * S) };
  const base = fbmGrid(S, 6, 4, seed);
  const mossN = fbmGrid(S, 10, 4, seed + 1);
  const humus = col(0x3e3024);
  const moss = col(0x4b5a2a);
  for (let i = 0; i < S * S; i++) {
    const m = Math.min(1, Math.max(0, (mossN[i]! - 0.55) * 5));
    const k = 0.8 + 0.4 * base[i]!;
    for (let c = 0; c < 3; c++) L.rgb[i * 3 + c] = (humus[c]! * (1 - m) + moss[c]! * m) * k;
    L.h[i] = 0.15 * base[i]! + 0.35 * m;
  }
  const scale = S / 512;
  // Fallen needles: thin straight strokes, rust-brown to grey.
  const needle = col(0x7a5a3a);
  const old = col(0x5c5248);
  for (let n = 0; n < Math.round(16000 * scale * scale); n++) {
    const c = rng.next() < 0.6 ? needle : old;
    stroke(L, S, rng.next() * S, rng.next() * S, rng.next() * Math.PI * 2, rng.range(6, 12) * scale, 0.45 * scale, rng.range(0.4, 0.75), c, rng.range(0.7, 1.25));
  }
  // Twigs: longer, thicker, grey-brown, a few.
  const twig = col(0x5a4a3c);
  for (let n = 0; n < Math.round(160 * scale * scale); n++) {
    stroke(L, S, rng.next() * S, rng.next() * S, rng.next() * Math.PI * 2, rng.range(18, 45) * scale, 1.3 * scale, rng.range(0.75, 0.95), twig, rng.range(0.8, 1.15), rng.range(-0.4, 0.4));
  }
  // Dead leaves: small ovals, tan to brown.
  const leaf = col(0x8a6a40);
  for (let n = 0; n < Math.round(500 * scale * scale); n++) {
    const cx = rng.next() * S;
    const cy = rng.next() * S;
    const a = rng.next() * Math.PI;
    const rx = rng.range(3, 6) * scale;
    const ry = rx * 0.5;
    const tone = rng.range(0.6, 1.2);
    for (let dy = -rx; dy <= rx; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const u = (dx * Math.cos(a) + dy * Math.sin(a)) / rx;
        const v = (-dx * Math.sin(a) + dy * Math.cos(a)) / ry;
        const d2 = u * u + v * v;
        if (d2 > 1) continue;
        const i = ((((Math.round(cy + dy) % S) + S) % S) * S + (((Math.round(cx + dx) % S) + S) % S));
        const ht = 0.55 + 0.15 * (1 - d2);
        if (ht <= L.h[i]!) continue;
        L.h[i] = ht;
        const vein = Math.abs(v) < 0.12 ? 0.85 : 1;
        for (let c = 0; c < 3; c++) L.rgb[i * 3 + c] = leaf[c]! * tone * vein;
      }
    }
  }
  return L;
}

/** Bakes the four layers (yielding between them so the loading screen keeps drawing). */
export async function makeGroundLayers(size: number, seed = 5): Promise<GroundLayers> {
  const S = size;
  const makers = [meadow, soil, rock, litter];
  const strength = [1.4, 2.0, 2.6, 1.6];
  const n = makers.length;
  const alb = new Uint8Array(S * S * 4 * n);
  const nrm = new Uint8Array(S * S * 4 * n);
  const means: [number, number, number][] = [];
  const toSrgb = (v: number): number => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  };
  const wrap = (v: number): number => ((v % S) + S) % S;
  for (let li = 0; li < n; li++) {
    await new Promise((r) => setTimeout(r, 0));
    const L = makers[li]!(S, seed + li * 101);
    const off = li * S * S * 4;
    const sum = [0, 0, 0];
    // The height relief is in texels: scale the slope so the normal strength does not depend on the size.
    const k = S / 512;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const o = off + i * 4;
        for (let c = 0; c < 3; c++) {
          const v = Math.min(1, Math.max(0, L.rgb[i * 3 + c]!));
          sum[c]! += v;
          alb[o + c] = toSrgb(v);
        }
        alb[o + 3] = Math.round(Math.min(1, Math.max(0, L.h[i]!)) * 255);
        const hx = L.h[y * S + wrap(x + 1)]! - L.h[y * S + wrap(x - 1)]!;
        const hy = L.h[wrap(y + 1) * S + x]! - L.h[wrap(y - 1) * S + x]!;
        const nx = -hx * strength[li]! * k;
        const ny = -hy * strength[li]! * k;
        const l = Math.hypot(nx, ny, 1);
        nrm[o] = Math.round(((nx / l) * 0.5 + 0.5) * 255);
        nrm[o + 1] = Math.round(((ny / l) * 0.5 + 0.5) * 255);
        // Cavity AO from the local height against its neighbourhood.
        const r = Math.max(1, Math.round(2 * k));
        const avg = (L.h[y * S + wrap(x + r)]! + L.h[y * S + wrap(x - r)]! + L.h[wrap(y + r) * S + x]! + L.h[wrap(y - r) * S + x]!) / 4;
        nrm[o + 2] = Math.round(Math.min(1, Math.max(0, 0.78 + (L.h[i]! - avg) * 2.5)) * 255);
        nrm[o + 3] = 255;
      }
    }
    means.push([sum[0]! / (S * S), sum[1]! / (S * S), sum[2]! / (S * S)]);
  }
  const mk = (data: Uint8Array, srgb: boolean): DataArrayTexture => {
    const t = new DataArrayTexture(data, S, S, n);
    t.format = RGBAFormat;
    t.type = UnsignedByteType;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(alb, true), normal: mk(nrm, false), means, size: S };
}
