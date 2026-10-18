import { BufferAttribute, BufferGeometry, NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture, TextureLoader } from 'three/webgpu';

// Photoscanned models: a boulder's real lumps, cracks and lichen, which no
// displaced sphere reaches. CC0 scans from Poly Haven (assets/scan/LICENSE.md),
// cut offline from 12–100 k triangles to ~2400 (boulders) or ~900 (stones)
// with meshoptimizer, collapsing across the scans' UV seams where the UV and
// normal error stays small; the scan's own normal map carries the detail the
// triangles lost. Each mesh is normalised: horizontal half-extent 1, base at
// y = 0, so a placement scales it in metres.
//
// mesh.bin: u32 magic 'SCN1', u32 vertexCount, u32 indexCount, u32 0, then
// f32 position[3n], f32 normal[3n], f32 uv[2n] (v up the image, as the
// textures load), u16 index[m] (u32 past 65 535 vertices).

export type ScanId = 'boulder_01' | 'namaqualand_boulder_02' | 'namaqualand_boulder_04' | 'namaqualand_boulder_05' | 'rock_07' | 'rock_09';

export interface ScanModel {
  geometry: BufferGeometry;
  map: Texture;
  normalMap: Texture;
  /** AO, roughness, metalness (Poly Haven's arm map). */
  ormMap: Texture;
  /** Height over the horizontal half-extent: how tall the scan stands. */
  heightRatio: number;
}

// Vite copies each file into the build with a hashed name and rewrites these URLs.
const URLS: Record<ScanId, Record<'mesh' | 'color' | 'normal' | 'orm', string>> = {
  boulder_01: {
    mesh: new URL('../assets/scan/boulder_01/mesh.bin', import.meta.url).href,
    color: new URL('../assets/scan/boulder_01/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/boulder_01/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/boulder_01/orm.jpg', import.meta.url).href,
  },
  namaqualand_boulder_02: {
    mesh: new URL('../assets/scan/namaqualand_boulder_02/mesh.bin', import.meta.url).href,
    color: new URL('../assets/scan/namaqualand_boulder_02/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/namaqualand_boulder_02/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/namaqualand_boulder_02/orm.jpg', import.meta.url).href,
  },
  namaqualand_boulder_04: {
    mesh: new URL('../assets/scan/namaqualand_boulder_04/mesh.bin', import.meta.url).href,
    color: new URL('../assets/scan/namaqualand_boulder_04/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/namaqualand_boulder_04/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/namaqualand_boulder_04/orm.jpg', import.meta.url).href,
  },
  namaqualand_boulder_05: {
    mesh: new URL('../assets/scan/namaqualand_boulder_05/mesh.bin', import.meta.url).href,
    color: new URL('../assets/scan/namaqualand_boulder_05/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/namaqualand_boulder_05/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/namaqualand_boulder_05/orm.jpg', import.meta.url).href,
  },
  rock_07: {
    mesh: new URL('../assets/scan/rock_07/mesh.bin', import.meta.url).href,
    color: new URL('../assets/scan/rock_07/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/rock_07/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/rock_07/orm.jpg', import.meta.url).href,
  },
  rock_09: {
    mesh: new URL('../assets/scan/rock_09/mesh.bin', import.meta.url).href,
    color: new URL('../assets/scan/rock_09/color.jpg', import.meta.url).href,
    normal: new URL('../assets/scan/rock_09/normal.jpg', import.meta.url).href,
    orm: new URL('../assets/scan/rock_09/orm.jpg', import.meta.url).href,
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

/** Loads every scanned model; call once, before the scene is built. */
export async function loadScanModels(): Promise<void> {
  const loader = new TextureLoader();
  const tex = async (url: string, colour: boolean): Promise<Texture> => {
    const t = await loader.loadAsync(url);
    t.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  await Promise.all(
    (Object.keys(URLS) as ScanId[]).map(async (id) => {
      if (models.has(id)) return;
      const u = URLS[id];
      const [buffer, map, normalMap, ormMap] = await Promise.all([fetch(u.mesh).then((r) => r.arrayBuffer()), tex(u.color, true), tex(u.normal, false), tex(u.orm, false)]);
      const geometry = parseScanMesh(buffer);
      models.set(id, { geometry, map, normalMap, ormMap, heightRatio: geometry.boundingBox?.max.y ?? 1 });
    }),
  );
}

export function scanModel(id: ScanId): ScanModel {
  const s = models.get(id);
  if (!s) throw new Error(`scanned model '${id}' requested before loadScanModels() finished`);
  return s;
}
