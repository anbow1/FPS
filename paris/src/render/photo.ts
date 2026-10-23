import { texture, vec2, vec3 } from 'three/tsl';
import { type Node, SRGBColorSpace, type Texture, TextureLoader, RepeatWrapping, LinearSRGBColorSpace } from 'three/webgpu';

// Scanned surfaces where a procedural pattern falls short (CC0 from Poly Haven,
// assets/photo/LICENSE.md): a road's real aggregate and cracks, the setts of a
// gutter, poured asphalt, the flaking bark of a London plane. Each set is a
// colour map and a `surface` map packing roughness (R) and height (G), 1k,
// sampled in world metres at the scan's measured size. The materials keep
// their own physical colours: a scan's colour divided by its mean is a
// detail factor around 1, so a darker or warmer street keeps its tone. A dressed
// sandstone face lends the limestone its pores, tool marks and stains.

export type PhotoId = 'asphalt_02' | 'cobblestone_05' | 'clean_asphalt' | 'bark_platanus' | 'old_sandstone_02';

interface PhotoSpec {
  /** Real size of the scan, m (Poly Haven's measured dimensions). */
  sizeM: number;
  /** Mean colour of the scan, linear (precomputed from color.jpg). */
  mean: [number, number, number];
}

export const PHOTO: Record<PhotoId, PhotoSpec> = {
  asphalt_02: { sizeM: 3, mean: [0.1034, 0.1011, 0.0908] },
  cobblestone_05: { sizeM: 2.4, mean: [0.195, 0.1641, 0.109] },
  clean_asphalt: { sizeM: 2.1, mean: [0.0587, 0.0609, 0.0627] },
  bark_platanus: { sizeM: 1.5, mean: [0.0933, 0.0636, 0.045] },
  old_sandstone_02: { sizeM: 1.53, mean: [0.2498, 0.1399, 0.0489] },
};

const URLS: Record<PhotoId, { color: string; surface: string }> = {
  asphalt_02: { color: new URL('../assets/photo/asphalt_02/color.jpg', import.meta.url).href, surface: new URL('../assets/photo/asphalt_02/surface.jpg', import.meta.url).href },
  cobblestone_05: { color: new URL('../assets/photo/cobblestone_05/color.jpg', import.meta.url).href, surface: new URL('../assets/photo/cobblestone_05/surface.jpg', import.meta.url).href },
  clean_asphalt: { color: new URL('../assets/photo/clean_asphalt/color.jpg', import.meta.url).href, surface: new URL('../assets/photo/clean_asphalt/surface.jpg', import.meta.url).href },
  bark_platanus: { color: new URL('../assets/photo/bark_platanus/color.jpg', import.meta.url).href, surface: new URL('../assets/photo/bark_platanus/surface.jpg', import.meta.url).href },
  old_sandstone_02: { color: new URL('../assets/photo/old_sandstone_02/color.jpg', import.meta.url).href, surface: new URL('../assets/photo/old_sandstone_02/surface.jpg', import.meta.url).href },
};

const loaded = new Map<PhotoId, { color: Texture; surface: Texture }>();

/** Loads every scan; call once before building the materials that use them. */
export async function loadPhotos(): Promise<void> {
  const loader = new TextureLoader();
  await Promise.all(
    (Object.keys(URLS) as PhotoId[]).map(async (id) => {
      const [color, surface] = await Promise.all([loader.loadAsync(URLS[id].color), loader.loadAsync(URLS[id].surface)]);
      color.colorSpace = SRGBColorSpace;
      surface.colorSpace = LinearSRGBColorSpace;
      for (const t of [color, surface]) {
        t.wrapS = t.wrapT = RepeatWrapping;
        t.anisotropy = 8;
      }
      loaded.set(id, { color, surface });
    }),
  );
}

export interface PhotoSample {
  /** Scan colour / its mean: a detail factor around 1. */
  detail: Node<'vec3'>;
  /** The scan's own colour (linear). */
  colour: Node<'vec3'>;
  roughness: Node<'float'>;
  /** Height 0…1. */
  height: Node<'float'>;
}

/** Samples a scan at `uvM` (metres in the surface's plane). */
export function photo(id: PhotoId, uvM: Node<'vec2'>): PhotoSample {
  const t = loaded.get(id);
  if (!t) throw new Error(`photo '${id}' not loaded: call loadPhotos() before building materials`);
  const uv = uvM.div(PHOTO[id].sizeM);
  const c = texture(t.color, uv).rgb;
  const s = texture(t.surface, uv);
  return { detail: c.div(vec3(...PHOTO[id].mean)), colour: c, roughness: s.r, height: s.g };
}

/** A second, rotated and offset tap of the same scan, to break its repeat across a large surface. */
export function photoRotated(id: PhotoId, uvM: Node<'vec2'>): PhotoSample {
  const r = vec2(uvM.x.mul(0.8).sub(uvM.y.mul(0.6)), uvM.x.mul(0.6).add(uvM.y.mul(0.8))).add(vec2(17.3, 5.1));
  return photo(id, r);
}
