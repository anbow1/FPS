import { NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture, TextureLoader } from 'three/webgpu';
import { type TextureSet, textureSetFromPixels } from './textureSet.ts';

// Photographed surfaces: scanned PBR sets where a procedural texture cannot
// reach — bark's plates and fissures and lichen, sand's grain, leaf litter,
// rock, weathered boards, a cloth's weave are what a scan has and noise does
// not. All CC0, from ambientCG and Poly Haven (assets/photo/LICENSE.md). Loaded once before the
// scene is built (view.ts), so every material and the impostors baked from
// them see the real images, never a blank first frame.
//
// Two kinds: `PhotoId` sets are plain textures sampled by their own materials
// (bark); `PhotoSetId` sets are decoded to pixels and packed like the generated
// texture sets (textureSet.ts: colour, normal, ORM with height in alpha), so
// the ground's array textures and the props' materials take them unchanged.

export type PhotoId = 'bark006' | 'bark007';

export interface PhotoSet {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
}

export type PhotoSetId = 'dense_sand' | 'leaves_forest_ground' | 'rock_face_03' | 'wood_planks_grey' | 'old_planks_02' | 'weathered_planks';

/** The real size of one repeat (m): Poly Haven's measured dimensions; boards along the grain. */
export const PHOTO_SIZE_M: Record<PhotoSetId, number> = {
  dense_sand: 1.8,
  leaves_forest_ground: 1.26,
  rock_face_03: 2.7,
  wood_planks_grey: 1.5,
  old_planks_02: 2.0,
  weathered_planks: 2.0,
};

// Vite copies each file into the build with a hashed name and rewrites these URLs.
const URLS: Record<PhotoId, Record<keyof PhotoSet, string>> = {
  bark006: {
    map: new URL('../assets/photo/bark006/color.jpg', import.meta.url).href,
    normalMap: new URL('../assets/photo/bark006/normal.jpg', import.meta.url).href,
    roughnessMap: new URL('../assets/photo/bark006/rough.jpg', import.meta.url).href,
  },
  bark007: {
    map: new URL('../assets/photo/bark007/color.jpg', import.meta.url).href,
    normalMap: new URL('../assets/photo/bark007/normal.jpg', import.meta.url).href,
    roughnessMap: new URL('../assets/photo/bark007/rough.jpg', import.meta.url).href,
  },
};

interface SetUrls {
  color: string;
  normal: string;
  orm: string;
  /** Ground sets: the height for height-blended splatting, packed into the ORM's alpha. */
  height?: string;
}

const SET_URLS: Record<PhotoSetId, SetUrls> = {
  dense_sand: {
    color: new URL('../assets/photo/dense_sand/color.jpg', import.meta.url).href,
    normal: new URL('../assets/photo/dense_sand/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/dense_sand/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/dense_sand/height.jpg', import.meta.url).href,
  },
  leaves_forest_ground: {
    color: new URL('../assets/photo/leaves_forest_ground/color.jpg', import.meta.url).href,
    normal: new URL('../assets/photo/leaves_forest_ground/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/leaves_forest_ground/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/leaves_forest_ground/height.jpg', import.meta.url).href,
  },
  rock_face_03: {
    color: new URL('../assets/photo/rock_face_03/color.jpg', import.meta.url).href,
    normal: new URL('../assets/photo/rock_face_03/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/rock_face_03/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/rock_face_03/height.jpg', import.meta.url).href,
  },
  wood_planks_grey: {
    color: new URL('../assets/photo/wood_planks_grey/color.jpg', import.meta.url).href,
    normal: new URL('../assets/photo/wood_planks_grey/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/wood_planks_grey/orm.jpg', import.meta.url).href,
  },
  old_planks_02: {
    color: new URL('../assets/photo/old_planks_02/color.jpg', import.meta.url).href,
    normal: new URL('../assets/photo/old_planks_02/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/old_planks_02/orm.jpg', import.meta.url).href,
  },
  weathered_planks: {
    color: new URL('../assets/photo/weathered_planks/color.jpg', import.meta.url).href,
    normal: new URL('../assets/photo/weathered_planks/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/weathered_planks/orm.jpg', import.meta.url).href,
  },
};

/**
 * A cloth's weave, as detail over a material's own colour and stains: Poly Haven's Rough Linen, a tight plain
 * weave like army canvas. `detail` packs R = the threads' albedo over its mean (× 0.5, linear), G = roughness,
 * B = AO; one repeat is `WEAVE_SIZE_M` across.
 */
export interface WeaveSet {
  detail: Texture;
  normalMap: Texture;
}

export const WEAVE_SIZE_M = 0.27;

const WEAVE_URLS: Record<keyof WeaveSet, string> = {
  detail: new URL('../assets/photo/rough_linen/weave.jpg', import.meta.url).href,
  normalMap: new URL('../assets/photo/rough_linen/normal.jpg', import.meta.url).href,
};

const sets = new Map<PhotoId, PhotoSet>();
const packed = new Map<PhotoSetId, TextureSet>();
let weave: WeaveSet | null = null;

interface Pixels {
  width: number;
  height: number;
  /** RGBA, row 0 = the image's bottom row (v = 0), as the generated sets are laid out. */
  data: Uint8Array;
}

async function decode(url: string): Promise<Pixels> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable for decoding photo textures');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const src = ctx.getImageData(0, 0, width, height).data;
  // Flip: an image's first row is its top (v = 1). A normal map read upside down would invert its green.
  const data = new Uint8Array(width * height * 4);
  const row = width * 4;
  for (let y = 0; y < height; y++) data.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return { width, height, data };
}

async function loadPacked(id: PhotoSetId): Promise<TextureSet> {
  const u = SET_URLS[id];
  const [color, normal, orm, height] = await Promise.all([decode(u.color), decode(u.normal), decode(u.orm), u.height ? decode(u.height) : Promise.resolve(null)]);
  const { width, height: h } = color;
  for (const p of [normal, orm, height]) if (p && (p.width !== width || p.height !== h)) throw new Error(`photo set '${id}': maps differ in size`);
  // Height into the ORM's alpha (ground sets); opaque elsewhere.
  for (let i = 3; i < orm.data.length; i += 4) orm.data[i] = height ? (height.data[i - 3] as number) : 255;
  return textureSetFromPixels(width, h, color.data, normal.data, orm.data);
}

/** Loads every photographed set; call once, before any material asks for one. */
export async function loadPhotoTextures(): Promise<void> {
  const loader = new TextureLoader();
  const load = async (url: string, colour: boolean): Promise<Texture> => {
    const t = await loader.loadAsync(url);
    t.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  await Promise.all([
    ...(Object.keys(URLS) as PhotoId[]).map(async (id) => {
      const u = URLS[id];
      const [map, normalMap, roughnessMap] = await Promise.all([load(u.map, true), load(u.normalMap, false), load(u.roughnessMap, false)]);
      sets.set(id, { map, normalMap, roughnessMap });
    }),
    ...(Object.keys(SET_URLS) as PhotoSetId[]).map(async (id) => packed.set(id, await loadPacked(id))),
    (async () => {
      const [detail, normalMap] = await Promise.all([load(WEAVE_URLS.detail, false), load(WEAVE_URLS.normalMap, false)]);
      weave = { detail, normalMap };
    })(),
  ]);
}

export function weaveSet(): WeaveSet {
  if (!weave) throw new Error('weave texture requested before loadPhotoTextures() finished');
  return weave;
}

export function photoSet(id: PhotoId): PhotoSet {
  const s = sets.get(id);
  if (!s) throw new Error(`photo texture set '${id}' requested before loadPhotoTextures() finished`);
  return s;
}

/** A photographed set packed like a generated one (textureSet.ts). */
export function photoTextureSet(id: PhotoSetId): TextureSet {
  const s = packed.get(id);
  if (!s) throw new Error(`photo texture set '${id}' requested before loadPhotoTextures() finished`);
  return s;
}
