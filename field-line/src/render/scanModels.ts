import { BufferAttribute, BufferGeometry, NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture, TextureLoader } from 'three/webgpu';

// Photoscanned models for the forest: mossy rocks, sawn stumps and a fallen
// trunk, with the cracks, roots and bark a displaced sphere or a tube does not
// have. CC0 scans from Poly Haven (assets/scan/LICENSE.md), cut offline from
// 5–100 k triangles to 1500–2500 with meshoptimizer, collapsing across the
// scans' UV seams where the UV and normal error stays small; the scan's own
// normal map carries the detail the triangles lost. Rocks are normalised
// (horizontal half-extent 1, base at y = 0) so a placement scales them like
// the old procedural rock; stumps and the trunk keep their size in metres.
//
// mesh.bin: u32 magic 'SCN1', u32 vertexCount, u32 indexCount, u32 0, then
// f32 position[3n], f32 normal[3n], f32 uv[2n] (v up the image, as the
// textures load), u16 index[m] (u32 past 65 535 vertices).

export type ScanId = 'rock_moss_01' | 'rock_moss_02' | 'rock_moss_03' | 'rock_moss_04' | 'rock_moss_05' | 'rock_moss_06' | 'tree_stump_01' | 'tree_stump_02' | 'dead_tree_trunk';
type TextureId = 'rock_moss' | 'tree_stump_01' | 'tree_stump_02' | 'dead_tree_trunk';

export interface ScanTextures {
  map: Texture;
  normalMap: Texture;
  /** AO, roughness, metalness (Poly Haven's arm map). */
  ormMap: Texture;
}

export interface ScanModel extends ScanTextures {
  geometry: BufferGeometry;
  /**
   * The same shape at ~1/4 the triangles (2 % of its size in error), drawn only by the sun's cascades
   * (props.ts, layers.ts): made by tools/assets/shadow_mesh.mjs from mesh.bin as `<name>_shadow.bin`.
   */
  shadowGeometry: BufferGeometry;
}

// Vite copies each file into the build with a hashed name and rewrites these URLs.
const MESHES: Record<ScanId, { mesh: string; shadow: string; textures: TextureId }> = {
  rock_moss_01: { mesh: new URL('../assets/scan/rock_moss/mesh_01.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_moss/mesh_01_shadow.bin', import.meta.url).href,
    textures: 'rock_moss' },
  rock_moss_02: { mesh: new URL('../assets/scan/rock_moss/mesh_02.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_moss/mesh_02_shadow.bin', import.meta.url).href,
    textures: 'rock_moss' },
  rock_moss_03: { mesh: new URL('../assets/scan/rock_moss/mesh_03.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_moss/mesh_03_shadow.bin', import.meta.url).href,
    textures: 'rock_moss' },
  rock_moss_04: { mesh: new URL('../assets/scan/rock_moss/mesh_04.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_moss/mesh_04_shadow.bin', import.meta.url).href,
    textures: 'rock_moss' },
  rock_moss_05: { mesh: new URL('../assets/scan/rock_moss/mesh_05.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_moss/mesh_05_shadow.bin', import.meta.url).href,
    textures: 'rock_moss' },
  rock_moss_06: { mesh: new URL('../assets/scan/rock_moss/mesh_06.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/rock_moss/mesh_06_shadow.bin', import.meta.url).href,
    textures: 'rock_moss' },
  tree_stump_01: { mesh: new URL('../assets/scan/tree_stump_01/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/tree_stump_01/mesh_shadow.bin', import.meta.url).href,
    textures: 'tree_stump_01' },
  tree_stump_02: { mesh: new URL('../assets/scan/tree_stump_02/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/tree_stump_02/mesh_shadow.bin', import.meta.url).href,
    textures: 'tree_stump_02' },
  dead_tree_trunk: { mesh: new URL('../assets/scan/dead_tree_trunk/mesh.bin', import.meta.url).href,
    shadow: new URL('../assets/scan/dead_tree_trunk/mesh_shadow.bin', import.meta.url).href,
    textures: 'dead_tree_trunk' },
};

const TEXTURES: Record<TextureId, Record<'color' | 'normal' | 'orm', string>> = {
  rock_moss: {
    color: new URL('../assets/scan/rock_moss/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/rock_moss/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/rock_moss/orm.jpg', import.meta.url).href,
  },
  tree_stump_01: {
    color: new URL('../assets/scan/tree_stump_01/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/tree_stump_01/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/tree_stump_01/orm.jpg', import.meta.url).href,
  },
  tree_stump_02: {
    color: new URL('../assets/scan/tree_stump_02/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/tree_stump_02/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/tree_stump_02/orm.jpg', import.meta.url).href,
  },
  dead_tree_trunk: {
    color: new URL('../assets/scan/dead_tree_trunk/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/dead_tree_trunk/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/dead_tree_trunk/orm.jpg', import.meta.url).href,
  },
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

/** Loads every scanned model; call once, before the props are built. */
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
      const [geometry, shadowGeometry] = await Promise.all([MESHES[id].mesh, MESHES[id].shadow].map(async (url) => parseScanMesh(await (await fetch(url)).arrayBuffer())));
      models.set(id, { geometry: geometry as BufferGeometry, shadowGeometry: shadowGeometry as BufferGeometry, ...(sets.get(MESHES[id].textures) as ScanTextures) });
    }),
  );
}

export function scanModel(id: ScanId): ScanModel {
  const s = models.get(id);
  if (!s) throw new Error(`scanned model '${id}' requested before loadScanModels() finished`);
  return s;
}
