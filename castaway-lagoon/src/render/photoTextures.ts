import { NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture, TextureLoader } from 'three/webgpu';

// Photographed surfaces: scanned PBR sets (colour, normal, roughness) where a
// procedural texture cannot reach — bark is the clearest case, its plates and
// fissures and lichen are what a scan has and noise does not. CC0, from
// ambientCG (assets/photo/LICENSE.md). Loaded once before the scene is built
// (view.ts), so every material and the impostors baked from them see the real
// images, never a blank first frame.

export type PhotoId = 'bark006' | 'bark007';

export interface PhotoSet {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
}

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

const sets = new Map<PhotoId, PhotoSet>();

/** Loads every set; call once, before any material asks for one. */
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
  await Promise.all(
    (Object.keys(URLS) as PhotoId[]).map(async (id) => {
      const u = URLS[id];
      const [map, normalMap, roughnessMap] = await Promise.all([load(u.map, true), load(u.normalMap, false), load(u.roughnessMap, false)]);
      sets.set(id, { map, normalMap, roughnessMap });
    }),
  );
}

export function photoSet(id: PhotoId): PhotoSet {
  const s = sets.get(id);
  if (!s) throw new Error(`photo texture set '${id}' requested before loadPhotoTextures() finished`);
  return s;
}
