import { DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three/webgpu';

// Procedural texture sets, generated once at load. Every set is base colour
// (sRGB), a tangent-space normal map in OpenGL convention (green = +Y) and an
// ORM map (R = AO, G = roughness, B = metalness) — both linear data, NoColorSpace
// (rules §3.2). Patterns must tile: the sampler gets u, v in [0, 1).

export interface Texel {
  r: number; // sRGB 0..1
  g: number;
  b: number;
  height: number; // 0..1, drives the normal map
  ao: number;
  rough: number;
  metal: number;
  alpha: number;
}

export interface TextureSet {
  map: DataTexture;
  normalMap: DataTexture;
  ormMap: DataTexture;
}

export type TexelSampler = (u: number, v: number, out: Texel) => void;

let maxAnisotropy = 16;

/** Set once the renderer knows the GPU's limit (16 on the target machine). */
export function setMaxAnisotropy(value: number): void {
  maxAnisotropy = value;
}

/** `heightInOrmAlpha` stores the height field in the ORM map's alpha, for height-blended splatting. */
export function makeTextureSet(size: number, sample: TexelSampler, normalStrength: number, alphaCoverage = false, heightInOrmAlpha = false): TextureSet {
  if (!Number.isInteger(Math.log2(size))) throw new Error(`texture size ${size} must be a power of two for mips`);
  const n = size * size;
  const base = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const heights = new Float32Array(n);
  const t: Texel = { r: 0, g: 0, b: 0, height: 0, ao: 1, rough: 0.8, metal: 0, alpha: 1 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      t.alpha = 1;
      t.ao = 1;
      t.metal = 0;
      sample((x + 0.5) / size, (y + 0.5) / size, t);
      const i = y * size + x;
      base[i * 4] = to8(t.r);
      base[i * 4 + 1] = to8(t.g);
      base[i * 4 + 2] = to8(t.b);
      base[i * 4 + 3] = to8(t.alpha);
      orm[i * 4] = to8(t.ao);
      orm[i * 4 + 1] = to8(t.rough);
      orm[i * 4 + 2] = to8(t.metal);
      orm[i * 4 + 3] = heightInOrmAlpha ? to8(t.height) : 255;
      heights[i] = t.height;
    }
  }
  const normal = normalsFromHeight(heights, size, normalStrength);
  const map = alphaCoverage ? coverageTexture(base, size, 0.5) : dataTexture(base, size);
  map.colorSpace = SRGBColorSpace;
  const normalMap = dataTexture(normal, size);
  normalMap.colorSpace = NoColorSpace;
  const ormMap = dataTexture(orm, size);
  ormMap.colorSpace = NoColorSpace;
  return { map, normalMap, ormMap };
}

function to8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * A texture set from decoded pixels (RGBA, row 0 = v 0): photographed sets (photoTextures.ts) take the same
 * shape as the generated ones, so every material and the ground's array textures use them unchanged.
 */
export function textureSetFromPixels(width: number, height: number, base: Uint8Array, normal: Uint8Array, orm: Uint8Array): TextureSet {
  const map = dataTexture(base, width, height);
  map.colorSpace = SRGBColorSpace;
  const normalMap = dataTexture(normal, width, height);
  normalMap.colorSpace = NoColorSpace;
  const ormMap = dataTexture(orm, width, height);
  ormMap.colorSpace = NoColorSpace;
  return { map, normalMap, ormMap };
}

function dataTexture(data: Uint8Array, size: number, height = size): DataTexture {
  const tex = new DataTexture(data, size, height, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Sobel normals from a tiling height field. Data row 0 is v = 0, so +y in the array is +V. */
function normalsFromHeight(h: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => h[((y + size) % size) * size + ((x + size) % size)] as number;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      out[i] = to8(nx * 0.5 + 0.5);
      out[i + 1] = to8(ny * 0.5 + 0.5);
      out[i + 2] = to8(nz * 0.5 + 0.5);
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Alpha-tested foliage mips that keep their coverage (rules §3.5): each level
 * is a box downsample, then alpha is rescaled so the share of texels passing
 * the clip threshold matches level 0. Without this, pines go thin at range.
 */
function coverageTexture(level0: Uint8Array, size: number, threshold: number): DataTexture {
  const target = coverage(level0, threshold);
  const mipmaps: { data: Uint8Array; width: number; height: number }[] = [{ data: level0, width: size, height: size }];
  let prev = level0;
  let s = size;
  while (s > 1) {
    const ns = s / 2;
    const next = new Uint8Array(ns * ns * 4);
    for (let y = 0; y < ns; y++) {
      for (let x = 0; x < ns; x++) {
        for (let c = 0; c < 4; c++) {
          const a = prev[((2 * y) * s + 2 * x) * 4 + c] as number;
          const b = prev[((2 * y) * s + 2 * x + 1) * 4 + c] as number;
          const d = prev[((2 * y + 1) * s + 2 * x) * 4 + c] as number;
          const e = prev[((2 * y + 1) * s + 2 * x + 1) * 4 + c] as number;
          next[(y * ns + x) * 4 + c] = (a + b + d + e) >> 2;
        }
      }
    }
    rescaleAlpha(next, target, threshold);
    mipmaps.push({ data: next, width: ns, height: ns });
    prev = next;
    s = ns;
  }
  const tex = new DataTexture(level0, size, size, RGBAFormat, UnsignedByteType);
  tex.mipmaps = mipmaps;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function coverage(data: Uint8Array, threshold: number, scale = 1): number {
  let pass = 0;
  const n = data.length / 4;
  for (let i = 0; i < n; i++) if (((data[i * 4 + 3] as number) / 255) * scale >= threshold) pass++;
  return pass / n;
}

function rescaleAlpha(data: Uint8Array, target: number, threshold: number): void {
  let lo = 0.5;
  let hi = 8;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (coverage(data, threshold, mid) < target) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  for (let i = 3; i < data.length; i += 4) data[i] = Math.min(255, Math.round((data[i] as number) * k));
}

export interface TextureArraySet {
  map: DataArrayTexture;
  normalMap: DataArrayTexture;
  ormMap: DataArrayTexture;
}

/**
 * Stacks same-sized texture sets into three array textures (one per map
 * kind, one layer per set). A splat shader then binds 3 textures instead of
 * 3 per layer: WebGPU's default limit, and most phone GPUs, allow only 16
 * textures per shader, shadow maps and the environment probe included.
 */
export function makeTextureArray(sets: readonly TextureSet[]): TextureArraySet {
  if (sets.length === 0) throw new Error('makeTextureArray needs at least one texture set');
  const size = (sets[0] as TextureSet).map.image.width;
  const stack = (pick: (s: TextureSet) => DataTexture): DataArrayTexture => {
    const layerBytes = size * size * 4;
    const data = new Uint8Array(layerBytes * sets.length);
    sets.forEach((s, i) => {
      const t = pick(s);
      if (t.image.width !== size || t.image.height !== size) throw new Error(`texture array layer ${i} is ${t.image.width}×${t.image.height}; every layer must be ${size}×${size}`);
      data.set(t.image.data as Uint8Array, i * layerBytes);
    });
    const tex = new DataArrayTexture(data, size, size, sets.length);
    tex.format = RGBAFormat;
    tex.type = UnsignedByteType;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.anisotropy = maxAnisotropy;
    tex.needsUpdate = true;
    return tex;
  };
  const map = stack((s) => s.map);
  map.colorSpace = SRGBColorSpace;
  const normalMap = stack((s) => s.normalMap);
  normalMap.colorSpace = NoColorSpace;
  const ormMap = stack((s) => s.ormMap);
  ormMap.colorSpace = NoColorSpace;
  return { map, normalMap, ormMap };
}
