import { BufferAttribute, BufferGeometry, CanvasTexture, SRGBColorSpace, type Texture } from 'three/webgpu';

// The soldiers made in Blender from MPFB and the MakeHuman assets
// (paris/tools/people/build_people_mpfb.py --cast fieldline): photographed skin, clothes, kit and hair,
// skinned to the 21-bone skeleton, ambient occlusion baked into the vertices. Each comes as
// <name>_full and <name>_far (.bin + .json) with its textures in assets/people/tex.
//
// A character arrives as up to ten pieces (skin, eyes, brows, lashes, hair, shirt, trousers, vest, boots,
// helmet), each with its own texture: drawn as they come that is a draw call per piece, per character,
// per level of detail and per shadow cascade, and this game is bound by its draw calls. So the pieces'
// textures are packed into one atlas per character and level at load time, the uvs moved into it, and a
// character is one instanced draw. Roughness and whether a piece is cloth ride along per vertex.
//
// .bin, format 2: 'PPL2', u32 vertices n, u32 indices m, u32 groups; f32 pos[3n], f32 nor[3n],
// f32 uv[2n], u8 bones[4n], u8 weights[4n], u8 ao[n], padding to 4, u32 index[m].

export type Joints = Record<string, [number, number, number]>;

export const FULL_BONES = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavicle.L', 'upperArm.L', 'forearm.L', 'hand.L', 'clavicle.R', 'upperArm.R', 'forearm.R', 'hand.R',
  'thigh.L', 'shin.L', 'foot.L', 'toe.L', 'thigh.R', 'shin.R', 'foot.R', 'toe.R',
] as const;
export type FullBone = (typeof FULL_BONES)[number];

type PieceKind = 'skin' | 'eyes' | 'eyebrows' | 'eyelashes' | 'hair' | 'clothes' | 'shoes' | 'hat';

interface GroupJson {
  start: number;
  count: number;
  kind: PieceKind;
  albedo: string | null;
  colour: [number, number, number];
  roughness: number;
  alpha: string | null;
}

interface CharacterJson {
  format: number;
  bones?: string[];
  joints: Joints;
  groups: GroupJson[];
}

/** One level of detail: skinned geometry (attributes skinIdx, skinWgt, ao, rough, cloth) and its atlas. */
export interface CastLod {
  geometry: BufferGeometry;
  atlas: Texture;
}

export interface CastCharacter {
  name: string;
  joints: Joints;
  /** Null on Low: the far level serves near too. */
  full: CastLod | null;
  far: CastLod;
}

/** Atlas edge per level: the near one keeps the skin at 1024 texels, the far one at 256. */
const ATLAS = { full: 2048, far: 512 } as const;

export function castUrls(json: Record<string, string>, bin: Record<string, string>, tex: Record<string, string>): CastSources {
  const byName = (urls: Record<string, string>): Map<string, string> => new Map(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
  return { json: byName(json), bin: byName(bin), tex: byName(tex) };
}

export interface CastSources {
  json: Map<string, string>;
  bin: Map<string, string>;
  tex: Map<string, string>;
}

/**
 * Every character in the sources (none when the folder is empty: the procedural soldiers stay). On Low only
 * the far level is fetched. A character that fails to load is left out (logged).
 */
export async function loadCast(src: CastSources, quality: 'high' | 'low'): Promise<CastCharacter[]> {
  const names = [...src.json.keys()].filter((f) => f.endsWith('_far.json')).map((f) => f.slice(0, -'_far.json'.length)).sort();
  const images = new Map<string, Promise<ImageBitmap | null>>();
  const image = (file: string | null): Promise<ImageBitmap | null> => {
    if (!file) return Promise.resolve(null);
    const url = src.tex.get(file.slice(file.lastIndexOf('/') + 1));
    if (!url) return Promise.resolve(null);
    let p = images.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b))
        .catch(() => null);
      images.set(url, p);
    }
    return p;
  };
  const lod = async (base: string, edge: number): Promise<{ lod: CastLod; json: CharacterJson }> => {
    const jsonUrl = src.json.get(`${base}.json`);
    const binUrl = src.bin.get(`${base}.bin`);
    if (!jsonUrl || !binUrl) throw new Error(`character '${base}' lacks its .json or .bin`);
    const [json, bin] = await Promise.all([fetch(jsonUrl).then((r) => r.json() as Promise<CharacterJson>), fetch(binUrl).then((r) => r.arrayBuffer())]);
    if (json.format !== 2) throw new Error(`character '${base}': format ${json.format}, expected 2`);
    if (!json.bones || json.bones.length !== FULL_BONES.length || json.bones.some((b, i) => b !== FULL_BONES[i])) throw new Error(`character '${base}': not the 21-bone skeleton`);
    const pictures = await Promise.all(json.groups.map((g) => image(g.albedo)));
    const geometry = parseBin(bin, base);
    const atlas = packAtlas(geometry, json.groups, pictures, edge);
    return { lod: { geometry, atlas }, json };
  };
  const out: CastCharacter[] = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        const far = await lod(`${name}_far`, ATLAS.far);
        const full = quality === 'high' && src.json.has(`${name}_full.json`) ? (await lod(`${name}_full`, ATLAS.full)).lod : null;
        out.push({ name, joints: far.json.joints, full, far: far.lod });
      } catch (err) {
        console.warn(`character ${name} did not load; it is left out of the cast:`, err);
      }
    }),
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parseBin(buf: ArrayBuffer, name: string): BufferGeometry {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'PPL2') throw new Error(`character '${name}': not a PPL2 file`);
  const head = new DataView(buf);
  const n = head.getUint32(4, true);
  const m = head.getUint32(8, true);
  let at = 16;
  const f32 = (count: number): Float32Array => {
    const out = new Float32Array(buf.slice(at, at + count * 4));
    at += count * 4;
    return out;
  };
  const u8 = (count: number): Uint8Array => {
    const out = new Uint8Array(buf, at, count);
    at += count;
    return out;
  };
  const pos = f32(3 * n);
  const nor = f32(3 * n);
  const uv = f32(2 * n);
  const bones = u8(4 * n);
  const weights = u8(4 * n);
  const ao = u8(n);
  at += (4 - (at % 4)) % 4;
  const index = new Uint32Array(buf.slice(at, at + m * 4));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('skinIdx', new BufferAttribute(Float32Array.from(bones), 4));
  g.setAttribute('skinWgt', new BufferAttribute(Float32Array.from(weights, (w) => w / 255), 4));
  g.setAttribute('ao', new BufferAttribute(Float32Array.from(ao, (a) => a / 255), 1));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** Share of the atlas edge a piece's tile takes: the skin most (face and hands are looked at), eyes least. */
function tileShare(kind: PieceKind): number {
  if (kind === 'skin') return 1 / 2;
  if (kind === 'eyes' || kind === 'eyebrows' || kind === 'eyelashes') return 1 / 8;
  return 1 / 4;
}

interface Tile {
  x: number;
  y: number;
  size: number;
}

/**
 * Packs the pieces' textures into one square atlas (power-of-two tiles in a quadtree: they always fit, the
 * shares above sum to at most the whole), moves each piece's uvs into its tile and adds the per-vertex
 * roughness and cloth flag the material reads. Pieces without a texture get a tile of their flat colour.
 */
function packAtlas(g: BufferGeometry, groups: readonly GroupJson[], pictures: readonly (ImageBitmap | null)[], edge: number): Texture {
  const order = groups.map((_, i) => i).sort((a, b) => tileShare((groups[b] as GroupJson).kind) - tileShare((groups[a] as GroupJson).kind));
  const free: Tile[] = [{ x: 0, y: 0, size: edge }];
  const tiles: Tile[] = new Array(groups.length);
  for (const i of order) {
    const want = Math.max(16, edge * tileShare((groups[i] as GroupJson).kind));
    // The smallest free square that holds it, split down to its size.
    free.sort((a, b) => a.size - b.size);
    const k = free.findIndex((f) => f.size >= want);
    const t = k >= 0 ? (free.splice(k, 1)[0] as Tile) : { x: 0, y: 0, size: 16 };
    let cur = t;
    while (cur.size > want) {
      const h = cur.size / 2;
      free.push({ x: cur.x + h, y: cur.y, size: h }, { x: cur.x, y: cur.y + h, size: h }, { x: cur.x + h, y: cur.y + h, size: h });
      cur = { x: cur.x, y: cur.y, size: h };
    }
    tiles[i] = cur;
  }

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(edge, edge) : Object.assign(document.createElement('canvas'), { width: edge, height: edge });
  // In memory, not on the GPU: the atlas is drawn once and copied into a WebGPU texture, and copying a GPU
  // canvas reads it back across contexts (eight seconds per 2048² atlas on a software GPU; in memory it is
  // a plain upload).
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  groups.forEach((grp, i) => {
    const t = tiles[i] as Tile;
    const pic = pictures[i];
    const clip = grp.alpha === 'clip';
    ctx.clearRect(t.x, t.y, t.size, t.size);
    if (!clip || !pic) {
      // Opaque pieces: a solid ground under the picture, so the atlas's alpha (the hair's cut-out) is 1 here.
      const c = grp.colour.map((v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)));
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(t.x, t.y, t.size, t.size);
    }
    if (pic) ctx.drawImage(pic, t.x, t.y, t.size, t.size);
  });

  // Uvs into the tiles (inset half a texel against the neighbour's colour), roughness and cloth per vertex.
  const uv = g.getAttribute('uv') as BufferAttribute;
  const index = g.index as BufferAttribute;
  const n = uv.count;
  const piece = new Int16Array(n).fill(-1);
  groups.forEach((grp, i) => {
    for (let k = grp.start; k < grp.start + grp.count; k++) piece[index.getX(k)] = i;
  });
  const rough = new Float32Array(n);
  const cloth = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const i = piece[v] as number;
    if (i < 0) continue;
    const t = tiles[i] as Tile;
    const grp = groups[i] as GroupJson;
    const inset = 0.5;
    const u = Math.min(1, Math.max(0, uv.getX(v)));
    const w = Math.min(1, Math.max(0, uv.getY(v)));
    uv.setXY(v, (t.x + inset + u * (t.size - 2 * inset)) / edge, (t.y + inset + w * (t.size - 2 * inset)) / edge);
    rough[v] = grp.roughness;
    cloth[v] = grp.kind === 'clothes' || grp.kind === 'hat' ? 1 : 0;
  }
  g.setAttribute('rough', new BufferAttribute(rough, 1));
  g.setAttribute('cloth', new BufferAttribute(cloth, 1));

  const tex = new CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = SRGBColorSpace;
  // The exporter wrote glTF-style uvs (v down the image), as the canvas is.
  tex.flipY = false;
  tex.anisotropy = 4;
  return tex;
}
