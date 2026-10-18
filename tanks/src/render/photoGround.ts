// Photographed ground for the close-range layers: grass with its dead
// blades and roots, a stony dirt path, a rock face and mud churned by tracks,
// which the generated patterns only approximated. CC0 scans from Poly Haven
// (assets/photo/LICENSE.md), decoded to pixels once before the world is built
// (main.ts) and packed by groundTextures.ts into the same array textures as
// the generated layers: albedo with height in alpha, normal XY with AO.

export type GroundPhotoId = 'sparse_grass' | 'stony_dirt_path' | 'rock_face_03' | 'muddy_tracks';

/** The real size of one repeat (m), Poly Haven's measured dimensions. */
export const GROUND_PHOTO_M: Record<GroundPhotoId, number> = {
  sparse_grass: 2.0,
  stony_dirt_path: 2.17,
  rock_face_03: 2.7,
  muddy_tracks: 2.25,
};

export interface GroundPhoto {
  size: number;
  /** RGBA rows, row 0 = the image's bottom (v = 0) like the generated layers. */
  color: Uint8Array;
  normal: Uint8Array;
  orm: Uint8Array;
  height: Uint8Array;
}

// Vite copies each file into the build with a hashed name and rewrites these URLs.
const urls = (dir: GroundPhotoId): Record<'color' | 'normal' | 'orm' | 'height', string> => ({
  color: new URL(`../assets/photo/${dir}/color.jpg`, import.meta.url).href,
  normal: new URL(`../assets/photo/${dir}/normal.jpg`, import.meta.url).href,
  orm: new URL(`../assets/photo/${dir}/orm.jpg`, import.meta.url).href,
  height: new URL(`../assets/photo/${dir}/height.jpg`, import.meta.url).href,
});

const photos = new Map<GroundPhotoId, GroundPhoto>();

async function decode(url: string): Promise<{ size: number; data: Uint8Array }> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const { width, height } = bitmap;
  if (width !== height) throw new Error(`ground photo '${url}' is not square`);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable for decoding ground photos');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const src = ctx.getImageData(0, 0, width, height).data;
  // Flip: an image's first row is its top (v = 1). A normal map read upside down would invert its green.
  const data = new Uint8Array(width * height * 4);
  const row = width * 4;
  for (let y = 0; y < height; y++) data.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return { size: width, data };
}

/** Decodes every ground photo; call once before the world is built. */
export async function loadGroundPhotos(): Promise<void> {
  const ids: GroundPhotoId[] = ['sparse_grass', 'stony_dirt_path', 'rock_face_03', 'muddy_tracks'];
  await Promise.all(
    ids.map(async (id) => {
      const u = urls(id);
      const [c, n, o, h] = await Promise.all([decode(u.color), decode(u.normal), decode(u.orm), decode(u.height)]);
      if (n.size !== c.size || o.size !== c.size || h.size !== c.size) throw new Error(`ground photo '${id}': maps differ in size`);
      photos.set(id, { size: c.size, color: c.data, normal: n.data, orm: o.data, height: h.data });
    }),
  );
}

/** A decoded ground photo, or null before loadGroundPhotos() (tests build the world without them). */
export function groundPhoto(id: GroundPhotoId): GroundPhoto | null {
  return photos.get(id) ?? null;
}
