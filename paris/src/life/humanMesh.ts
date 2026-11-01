import { BufferAttribute, BufferGeometry, LinearSRGBColorSpace, SRGBColorSpace, type Texture, TextureLoader } from 'three/webgpu';
import { FULL_BONES, FullPoser } from './fullPose.ts';
import { type Joints, type Rig, rigFromJoints } from './rig.ts';

// Characters made in Blender from MPFB and the MakeHuman assets
// (tools/people/build_people_mpfb.py): real clothes, hair and skin with their
// textures, skinned to the game's 15 bones, ambient occlusion baked into the
// vertices. Each character comes as <name>_full and <name>_far (.bin + .json)
// with its textures in assets/people/tex. If the folder is empty the crowd
// keeps its procedural builds (body.ts).
//
// .bin, format 2: 'PPL2', u32 vertices n, u32 indices m, u32 groups; f32
// pos[3n], f32 nor[3n], f32 uv[2n], u8 bones[4n], u8 weights[4n], u8 ao[n],
// padding to 4, u32 index[m]. The .json names, per index range, its kind and
// textures.

export type PieceKind = 'skin' | 'eyes' | 'eyebrows' | 'eyelashes' | 'hair' | 'clothes' | 'shoes' | 'hat';

export interface PieceMaterial {
  kind: PieceKind;
  start: number;
  count: number;
  albedo: Texture | null;
  normal: Texture | null;
  /** Linear colour where there is no texture. */
  colour: [number, number, number];
  roughness: number;
  /** Alpha-tested (hair cards, brows, lashes). */
  clip: boolean;
}

export interface CharacterLod {
  geometry: BufferGeometry;
  pieces: PieceMaterial[];
}

export interface Character {
  name: string;
  /** 1 = male (MakeHuman's gender macro). */
  gender: number;
  rig: Rig;
  /** The 21-bone posing, for characters built with the full skeleton (null: the 15-bone rig of rig.ts). */
  poser: FullPoser | null;
  full: CharacterLod;
  far: CharacterLod;
}

interface CharacterJson {
  format: number;
  /** The skeleton's bone names, in the order the .bin's bone indices count (absent: the 15-bone rig). */
  bones?: string[];
  joints: Joints;
  cast: { name: string; gender: number };
  groups: { start: number; count: number; kind: PieceKind; albedo: string | null; normal: string | null; colour: [number, number, number]; roughness: number; alpha: string | null }[];
}

// Vite: every character file's URL (none in the repository until a set is built on a PC with Blender).
const JSON_URLS = import.meta.glob<string>('../assets/people/*.json', { eager: true, query: '?url', import: 'default' });
const BIN_URLS = import.meta.glob<string>('../assets/people/*.bin', { eager: true, query: '?url', import: 'default' });
const TEX_URLS = import.meta.glob<string>('../assets/people/tex/*', { eager: true, query: '?url', import: 'default' });

const byName = (urls: Record<string, string>): Map<string, string> => new Map(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

/** Every character in assets/people (none if no set has been built). */
export async function loadCharacters(): Promise<Character[]> {
  const jsons = byName(JSON_URLS);
  const bins = byName(BIN_URLS);
  const texs = byName(TEX_URLS);
  const names = [...jsons.keys()].filter((f) => f.endsWith('_full.json')).map((f) => f.slice(0, -'_full.json'.length)).sort();
  const loader = new TextureLoader();
  const textures = new Map<string, Promise<Texture>>();
  const tex = (file: string | null, colour: boolean): Promise<Texture | null> => {
    if (!file) return Promise.resolve(null);
    const url = texs.get(file.slice(file.lastIndexOf('/') + 1));
    if (!url) return Promise.resolve(null);
    let t = textures.get(url);
    if (!t) {
      t = loader.loadAsync(url).then((loaded) => {
        loaded.colorSpace = colour ? SRGBColorSpace : LinearSRGBColorSpace;
        // The exporter wrote glTF-style uvs (v down the image).
        loaded.flipY = false;
        loaded.anisotropy = 4;
        return loaded;
      });
      textures.set(url, t);
    }
    return t;
  };
  const lod = async (base: string): Promise<{ lod: CharacterLod; json: CharacterJson }> => {
    const jsonUrl = jsons.get(`${base}.json`);
    const binUrl = bins.get(`${base}.bin`);
    if (!jsonUrl || !binUrl) throw new Error(`character '${base}' lacks its .json or .bin`);
    const [json, bin] = await Promise.all([fetch(jsonUrl).then((r) => r.json() as Promise<CharacterJson>), fetch(binUrl).then((r) => r.arrayBuffer())]);
    if (json.format !== 2) throw new Error(`character '${base}': format ${json.format}, expected 2`);
    const pieces = await Promise.all(
      json.groups.map(async (g) => ({
        kind: g.kind,
        start: g.start,
        count: g.count,
        albedo: await tex(g.albedo, true),
        normal: await tex(g.normal, false),
        colour: g.colour,
        roughness: g.roughness,
        clip: g.alpha === 'clip',
      })),
    );
    return { lod: { geometry: parseBin(bin, base, pieces), pieces }, json };
  };
  return Promise.all(
    names.map(async (name) => {
      const [full, far] = await Promise.all([lod(`${name}_full`), lod(`${name}_far`)]);
      const bones = full.json.bones;
      if (bones && (bones.length !== FULL_BONES.length || bones.some((b, i) => b !== FULL_BONES[i]))) throw new Error(`character '${name}': unknown skeleton ${bones.join(',')}`);
      return { name, gender: full.json.cast.gender, rig: rigFromJoints(full.json.joints), poser: bones ? new FullPoser(full.json.joints) : null, full: full.lod, far: far.lod };
    }),
  );
}

function parseBin(buf: ArrayBuffer, name: string, pieces: readonly PieceMaterial[]): BufferGeometry {
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
  // skinning.ts reads float bone indices and weights.
  g.setAttribute('skinIdx', new BufferAttribute(Float32Array.from(bones), 4));
  g.setAttribute('skinWgt', new BufferAttribute(Float32Array.from(weights, (w) => w / 255), 4));
  g.setAttribute('ao', new BufferAttribute(Float32Array.from(ao, (a) => a / 255), 1));
  g.setIndex(new BufferAttribute(index, 1));
  pieces.forEach((p, i) => g.addGroup(p.start, p.count, i));
  g.computeBoundingSphere();
  return g;
}
