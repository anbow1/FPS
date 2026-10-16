import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { tileFbm, tileNoise } from '../core/noise.ts';
import { makeTextureArray, makeTextureSet, type TextureArraySet, type TextureSet } from './textureSet.ts';
import * as P from './patterns.ts';

// Lazily generated texture sets for the lagoon, built once at load behind the
// progress bar (rules §9). Base colour sRGB; normal, ORM and data maps linear.

const sets = new Map<string, TextureSet>();
const maps = new Map<string, DataTexture>();

export type TerrainLayer = 'sand' | 'litter' | 'grass' | 'rock' | 'moss';

export function terrainSet(layer: TerrainLayer): TextureSet {
  let s = sets.get(layer);
  if (!s) {
    const sampler = layer === 'sand' ? P.sand() : layer === 'litter' ? P.leafLitter() : layer === 'grass' ? P.tropicalGrass() : layer === 'rock' ? P.coastRock() : P.moss();
    const strength = layer === 'rock' ? 5 : layer === 'litter' ? 2.6 : layer === 'moss' ? 3 : 2.5;
    s = makeTextureSet(layer === 'moss' ? 256 : 512, sampler, strength, false, true);
    sets.set(layer, s);
  }
  return s;
}

let groundArray: TextureArraySet | null = null;

/** The ground's four layers — sand, grass, litter, rock, in that order — as array textures. */
export function terrainArray(): TextureArraySet {
  groundArray ??= makeTextureArray([terrainSet('sand'), terrainSet('grass'), terrainSet('litter'), terrainSet('rock')]);
  return groundArray;
}

export function waterNormalMap(): DataTexture {
  let s = sets.get('water');
  if (!s) {
    s = makeTextureSet(256, P.waterRipples(), 6);
    sets.set('water', s);
  }
  return s.normalMap;
}

function dataMap(key: string, size: number, fill: (u: number, v: number, out: Uint8Array, i: number) => void): DataTexture {
  let t = maps.get(key);
  if (t) return t;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) fill((x + 0.5) / size, (y + 0.5) / size, data, (y * size + x) * 4);
  }
  t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.colorSpace = NoColorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  maps.set(key, t);
  return t;
}

const to8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** R: caustic web, G: foam. */
export function causticFoamMap(): DataTexture {
  return dataMap('causticFoam', 256, (u, v, d, i) => {
    d[i] = to8(P.causticValue(u, v));
    d[i + 1] = to8(P.foamValue(u, v));
    d[i + 2] = 0;
    d[i + 3] = 255;
  });
}

/** Surf-foam lace, one tile = 3.5 m (see P.laceValue). */
export function laceMap(): DataTexture {
  return dataMap('lace', 512, (u, v, d, i) => {
    const [r, g, b, a] = P.laceValue(u, v);
    d[i] = to8(r);
    d[i + 1] = to8(g);
    d[i + 2] = to8(b);
    d[i + 3] = to8(a);
  });
}

/** R: broad fbm, G: mid fbm, B: value noise, A: fine noise. Macro variation and puddle masks. */
export function noiseMap(): DataTexture {
  return dataMap('noise', 256, (u, v, d, i) => {
    d[i] = to8(tileFbm(u * 4, v * 4, 4, 4, 201));
    d[i + 1] = to8(tileFbm(u * 16, v * 16, 16, 3, 203));
    d[i + 2] = to8(tileNoise(u * 32, v * 32, 32, 205));
    d[i + 3] = to8(tileNoise(u * 128, v * 128, 128, 207));
  });
}
