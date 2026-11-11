import { BufferAttribute, BufferGeometry, NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture, TextureLoader } from 'three/webgpu';

// Photoscanned models: a boulder's real lumps, cracks and lichen, and the
// understory's ferns and broad leaves, which no displaced sphere or card reaches. CC0 scans from Poly Haven (assets/scan/LICENSE.md),
// cut offline from 12–100 k triangles to ~2400 (boulders), ~900 (stones) or
// ~1500–1800 (plants; the ferns are under that already) with meshoptimizer, collapsing across the scans' UV seams where the UV and
// normal error stays small; the scan's own normal map carries the detail the
// triangles lost. Rocks are normalised (horizontal half-extent 1, base at
// y = 0) so a placement scales them in metres; plants keep their scanned size.
//
// mesh.bin: u32 magic 'SCN1', u32 vertexCount, u32 indexCount, u32 0, then
// f32 position[3n], f32 normal[3n], f32 uv[2n] (v up the image, as the
// textures load), u16 index[m] (u32 past 65 535 vertices).

export type ScanId =
  | 'boulder_01'
  | 'namaqualand_boulder_02'
  | 'namaqualand_boulder_04'
  | 'namaqualand_boulder_05'
  | 'rock_07'
  | 'rock_09'
  | 'fern_a'
  | 'fern_b'
  | 'fern_c'
  | 'fern_d'
  | 'calathea_a'
  | 'calathea_b'
  | 'calathea_c'
  | 'anthurium_a'
  | 'anthurium_b'
  | 'anthurium_c';
type TextureId = 'boulder_01' | 'namaqualand_boulder_02' | 'namaqualand_boulder_04' | 'namaqualand_boulder_05' | 'rock_07' | 'rock_09' | 'fern' | 'calathea' | 'anthurium';

export interface ScanTextures {
  map: Texture;
  normalMap: Texture;
  /** AO, roughness, metalness (Poly Haven's arm map). */
  ormMap: Texture;
}

export interface ScanModel extends ScanTextures {
  geometry: BufferGeometry;
  /**
   * Rocks only: the same shape with fewer triangles (1 % of its size in error for boulders, 2 % for
   * stones), drawn only by the sun's cascades (rocks.ts, layers.ts); tools/assets/shadow_mesh.mjs.
   */
  shadowGeometry: BufferGeometry | null;
  /** Height over the horizontal half-extent (rocks) or in metres (plants): how tall the scan stands. */
  heightRatio: number;
}

// Vite copies each file into the build with a hashed name and rewrites these URLs.
const MESHES: Record<ScanId, { mesh: string; shadow?: string; textures: TextureId }> = {
  boulder_01: {
    mesh: new URL('../assets/scan/boulder_01/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/boulder_01/mesh_shadow.bin', import.meta.url).href,
    textures: 'boulder_01',
  },
  namaqualand_boulder_02: {
    mesh: new URL('../assets/scan/namaqualand_boulder_02/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/namaqualand_boulder_02/mesh_shadow.bin', import.meta.url).href,
    textures: 'namaqualand_boulder_02',
  },
  namaqualand_boulder_04: {
    mesh: new URL('../assets/scan/namaqualand_boulder_04/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/namaqualand_boulder_04/mesh_shadow.bin', import.meta.url).href,
    textures: 'namaqualand_boulder_04',
  },
  namaqualand_boulder_05: {
    mesh: new URL('../assets/scan/namaqualand_boulder_05/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/namaqualand_boulder_05/mesh_shadow.bin', import.meta.url).href,
    textures: 'namaqualand_boulder_05',
  },
  rock_07: {
    mesh: new URL('../assets/scan/rock_07/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_07/mesh_shadow.bin', import.meta.url).href,
    textures: 'rock_07',
  },
  rock_09: {
    mesh: new URL('../assets/scan/rock_09/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_09/mesh_shadow.bin', import.meta.url).href,
    textures: 'rock_09',
  },
  fern_a: { mesh: new URL('../assets/scan/fern/mesh_a.bin', import.meta.url).href, textures: 'fern' },
  fern_b: { mesh: new URL('../assets/scan/fern/mesh_b.bin', import.meta.url).href, textures: 'fern' },
  fern_c: { mesh: new URL('../assets/scan/fern/mesh_c.bin', import.meta.url).href, textures: 'fern' },
  fern_d: { mesh: new URL('../assets/scan/fern/mesh_d.bin', import.meta.url).href, textures: 'fern' },
  calathea_a: { mesh: new URL('../assets/scan/calathea/mesh_a.bin', import.meta.url).href, textures: 'calathea' },
  calathea_b: { mesh: new URL('../assets/scan/calathea/mesh_b.bin', import.meta.url).href, textures: 'calathea' },
  calathea_c: { mesh: new URL('../assets/scan/calathea/mesh_c.bin', import.meta.url).href, textures: 'calathea' },
  anthurium_a: { mesh: new URL('../assets/scan/anthurium/mesh_a.bin', import.meta.url).href, textures: 'anthurium' },
  anthurium_b: { mesh: new URL('../assets/scan/anthurium/mesh_b.bin', import.meta.url).href, textures: 'anthurium' },
  anthurium_c: { mesh: new URL('../assets/scan/anthurium/mesh_c.bin', import.meta.url).href, textures: 'anthurium' },
};

const textureUrls = (dir: string): Record<'color' | 'normal' | 'orm', string> => ({
  color: new URL(`../assets/scan/${dir}/color.jpg`, import.meta.url).href,
  normal: new URL(`../assets/scan/${dir}/normal.jpg`, import.meta.url).href,
  orm: new URL(`../assets/scan/${dir}/orm.jpg`, import.meta.url).href,
});
const TEXTURES: Record<TextureId, Record<'color' | 'normal' | 'orm', string>> = {
  boulder_01: textureUrls('boulder_01'),
  namaqualand_boulder_02: textureUrls('namaqualand_boulder_02'),
  namaqualand_boulder_04: textureUrls('namaqualand_boulder_04'),
  namaqualand_boulder_05: textureUrls('namaqualand_boulder_05'),
  rock_07: textureUrls('rock_07'),
  rock_09: textureUrls('rock_09'),
  fern: textureUrls('fern'),
  calathea: textureUrls('calathea'),
  anthurium: textureUrls('anthurium'),
};

const models = new Map<ScanId, ScanModel>();

const MAGIC = 0x314e4353; // 'SCN1'

/** Parses mesh.bin (format above). */
export function parseScanMesh(buffer: ArrayBuffer): BufferGeometry {
  const head = new Uint32Array(buffer, 0, 4);
  if (head[0] !== MAGIC) throw new Error('not a scan mesh');
  const n = head[1] as number;
  const m = head[2] as number;
  let o = 16;
  const position = new Float32Array(buffer, o, n * 3);
  o += n * 12;
  const normal = new Float32Array(buffer, o, n * 3);
  o += n * 12;
  const uv = new Float32Array(buffer, o, n * 2);
  o += n * 8;
  const index = n > 65535 ? new Uint32Array(buffer, o, m) : new Uint16Array(buffer, o, m);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Loads every scanned model; call once, before the scene is built. */
export async function loadScanModels(): Promise<void> {
  if (models.size > 0) return;
  const loader = new TextureLoader();
  const tex = async (url: string, colour: boolean): Promise<Texture> => {
    const t = await loader.loadAsync(url);
    t.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  const sets = new Map<TextureId, ScanTextures>();
  await Promise.all(
    (Object.keys(TEXTURES) as TextureId[]).map(async (id) => {
      const u = TEXTURES[id];
      const [map, normalMap, ormMap] = await Promise.all([tex(u.color, true), tex(u.normal, false), tex(u.orm, false)]);
      sets.set(id, { map, normalMap, ormMap });
    }),
  );
  await Promise.all(
    (Object.keys(MESHES) as ScanId[]).map(async (id) => {
      const { mesh, shadow } = MESHES[id];
      const [geometry, shadowGeometry] = await Promise.all([
        fetch(mesh).then(async (r) => parseScanMesh(await r.arrayBuffer())),
        shadow ? fetch(shadow).then(async (r) => parseScanMesh(await r.arrayBuffer())) : Promise.resolve(null),
      ]);
      models.set(id, { geometry, shadowGeometry, heightRatio: geometry.boundingBox?.max.y ?? 1, ...(sets.get(MESHES[id].textures) as ScanTextures) });
    }),
  );
}

export function scanModel(id: ScanId): ScanModel {
  const s = models.get(id);
  if (!s) throw new Error(`scanned model '${id}' requested before loadScanModels() finished`);
  return s;
}
