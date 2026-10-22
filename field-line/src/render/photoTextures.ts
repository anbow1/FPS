import type { TexelSampler } from './textures.ts';

// Photographed surfaces where a procedural pattern falls short: brick with its
// chipped arrises, uneven courses and lime-streaked mortar, a dirt track's
// grit and stones; the road's cracked asphalt, paving slabs, weathered render,
// floorboards and planks, slate walls, rust and a container's chipped paint.
// CC0 scans from Poly Haven (assets/photo/LICENSE.md),
// decoded once before the materials are built (view.ts) and read through a
// TexelSampler, so they go through makeTextureSet like every generated set:
// colour and ORM straight from the scan, the normals from its height.

export type PhotoId =
  | 'red_brick_03'
  | 'brick_wall_02'
  | 'concrete_floor_worn_001'
  | 'forest_ground_04'
  | 'asphalt_02'
  | 'concrete_pavement_02'
  | 'grey_plaster_02'
  | 'old_wood_floor'
  | 'weathered_planks'
  | 'castle_wall_slates'
  | 'rust_coarse_01'
  | 'green_metal_rust'
  | 'tarred_gravel';

/** The real size of one photograph (m), Poly Haven's measured dimensions. */
export const PHOTO_SIZE_M: Record<PhotoId, number> = {
  red_brick_03: 1,
  brick_wall_02: 2,
  concrete_floor_worn_001: 3,
  forest_ground_04: 3.15,
  asphalt_02: 3,
  concrete_pavement_02: 1.8,
  grey_plaster_02: 1,
  old_wood_floor: 3,
  weathered_planks: 2,
  castle_wall_slates: 2.5,
  rust_coarse_01: 2.2,
  green_metal_rust: 1,
  tarred_gravel: 2.2,
};

interface Pixels {
  width: number;
  height: number;
  /** RGBA, row 0 = the image's bottom row (v = 0), as makeTextureSet samples. */
  data: Uint8Array;
}

interface Photo {
  color: Pixels;
  orm: Pixels;
  height: Pixels;
  /** Mean colour (sRGB 0..1), for matching a look's palette. */
  mean: [number, number, number];
}

// Vite copies each file into the build with a hashed name and rewrites these URLs.
const URLS: Record<PhotoId, Record<'color' | 'orm' | 'height', string>> = {
  red_brick_03: {
    color: new URL('../assets/photo/red_brick_03/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/red_brick_03/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/red_brick_03/height.jpg', import.meta.url).href,
  },
  brick_wall_02: {
    color: new URL('../assets/photo/brick_wall_02/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/brick_wall_02/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/brick_wall_02/height.jpg', import.meta.url).href,
  },
  concrete_floor_worn_001: {
    color: new URL('../assets/photo/concrete_floor_worn_001/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/concrete_floor_worn_001/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/concrete_floor_worn_001/height.jpg', import.meta.url).href,
  },
  forest_ground_04: {
    color: new URL('../assets/photo/forest_ground_04/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/forest_ground_04/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/forest_ground_04/height.jpg', import.meta.url).href,
  },
  asphalt_02: {
    color: new URL('../assets/photo/asphalt_02/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/asphalt_02/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/asphalt_02/height.jpg', import.meta.url).href,
  },
  concrete_pavement_02: {
    color: new URL('../assets/photo/concrete_pavement_02/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/concrete_pavement_02/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/concrete_pavement_02/height.jpg', import.meta.url).href,
  },
  grey_plaster_02: {
    color: new URL('../assets/photo/grey_plaster_02/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/grey_plaster_02/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/grey_plaster_02/height.jpg', import.meta.url).href,
  },
  old_wood_floor: {
    color: new URL('../assets/photo/old_wood_floor/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/old_wood_floor/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/old_wood_floor/height.jpg', import.meta.url).href,
  },
  weathered_planks: {
    color: new URL('../assets/photo/weathered_planks/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/weathered_planks/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/weathered_planks/height.jpg', import.meta.url).href,
  },
  castle_wall_slates: {
    color: new URL('../assets/photo/castle_wall_slates/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/castle_wall_slates/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/castle_wall_slates/height.jpg', import.meta.url).href,
  },
  rust_coarse_01: {
    color: new URL('../assets/photo/rust_coarse_01/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/rust_coarse_01/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/rust_coarse_01/height.jpg', import.meta.url).href,
  },
  green_metal_rust: {
    color: new URL('../assets/photo/green_metal_rust/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/green_metal_rust/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/green_metal_rust/height.jpg', import.meta.url).href,
  },
  tarred_gravel: {
    color: new URL('../assets/photo/tarred_gravel/color.jpg', import.meta.url).href,
    orm: new URL('../assets/photo/tarred_gravel/orm.jpg', import.meta.url).href,
    height: new URL('../assets/photo/tarred_gravel/height.jpg', import.meta.url).href,
  },
};

const photos = new Map<PhotoId, Photo>();

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
  // Flip: an image's first row is its top (v = 1); the normals derived from the height must not invert.
  const data = new Uint8Array(width * height * 4);
  const row = width * 4;
  for (let y = 0; y < height; y++) data.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return { width, height, data };
}

/** Loads every photographed set; call once, before any material asks for one. */
export async function loadPhotoTextures(): Promise<void> {
  await Promise.all(
    (Object.keys(URLS) as PhotoId[]).map(async (id) => {
      if (photos.has(id)) return;
      const u = URLS[id];
      const [color, orm, height] = await Promise.all([decode(u.color), decode(u.orm), decode(u.height)]);
      for (const p of [orm, height]) if (p.width !== color.width || p.height !== color.height) throw new Error(`photo set '${id}': maps differ in size`);
      const mean: [number, number, number] = [0, 0, 0];
      const n = color.width * color.height;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] = (mean[c] as number) + (color.data[i * 4 + c] as number) / 255 / n;
      photos.set(id, { color, orm, height, mean });
    }),
  );
}

/**
 * The photograph as a TexelSampler, `repeatU` × `repeatV` times over the texture
 * (whole numbers, so it still tiles). `match` (0xRRGGBB, sRGB) scales the
 * photo's mean colour to a look's own, keeping the scan's detail and contrast.
 */
export function photoSampler(id: PhotoId, repeatU = 1, repeatV = 1, match?: number): TexelSampler {
  const p = photos.get(id);
  if (!p) throw new Error(`photo texture '${id}' requested before loadPhotoTextures() finished`);
  const { width: w, height: h } = p.color;
  const gain = match === undefined ? [1, 1, 1] : [(match >> 16) & 255, (match >> 8) & 255, match & 255].map((c, i) => c / 255 / (p.mean[i] as number));
  // Bilinear, wrapping: the output texture is rarely the photo's own size.
  const sample = (img: Pixels, x: number, y: number, c: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (xi: number, yi: number): number => img.data[((((yi % h) + h) % h) * w + (((xi % w) + w) % w)) * 4 + c] as number;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return (top * (1 - fy) + bottom * fy) / 255;
  };
  return (u, v, t) => {
    const x = u * repeatU * w - 0.5;
    const y = v * repeatV * h - 0.5;
    t.r = sample(p.color, x, y, 0) * (gain[0] as number);
    t.g = sample(p.color, x, y, 1) * (gain[1] as number);
    t.b = sample(p.color, x, y, 2) * (gain[2] as number);
    t.ao = sample(p.orm, x, y, 0);
    t.rough = sample(p.orm, x, y, 1);
    t.metal = sample(p.orm, x, y, 2);
    t.height = sample(p.height, x, y, 0);
  };
}
