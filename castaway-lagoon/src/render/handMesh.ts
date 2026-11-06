import { BufferAttribute, BufferGeometry, Quaternion, SRGBColorSpace, type Texture, TextureLoader, Vector3 } from 'three/webgpu';

// Hands and forearms from a real body: MakeHuman's CC0 base mesh with its
// default skeleton and skin weights (assets/hand/LICENSE.md), baked offline —
// the right forearm and hand cut from the body, one Catmull–Clark step
// smoother, in the hand frame the viewmodel poses (wrist at the origin,
// fingers along −Z, palm facing −Y, thumb toward −X), the forearm stretched to
// the game's 27 cm. Capsules and spheres read as a doll's hand however they
// were posed; this one has knuckles, tendons, nails and a thumb's ball.
//
// Bones: forearm (rest frame: its axis and the back of the hand), hand (the
// wrist), four metacarpals, and three phalanges for each finger, the thumb's
// first. Every bone's rest rotation is the identity in the hand frame, so a
// finger curls about an axis computed once from its rest direction.
//
// hand.bin: 'HND2', u32 vertices, u32 indices, u32 bones; f32 position[3n];
// i8 normal[4n]; u8 skinIndex[4n]; u8 skinWeight[4n] (sum 255); u8 region[4n]
// (bare skin in a fingerless glove, nail, forearm, 0); u16 uv[2n] (round the
// forearm from its back, along it per 0.3 m); u16 index[m].

export interface HandPose {
  /** Finger curl 0 (flat) … 1 (fist), index → pinky. */
  curl: [number, number, number, number];
  /** Thumb: 0 alongside the palm, 1 wrapped across it. */
  thumb: number;
  /** Finger spread 0..1. */
  spread: number;
}

export interface HandBone {
  name: string;
  parent: number;
  head: Vector3;
  tail: Vector3;
}

export interface HandData {
  /** position, normal, skinIndex, skinWeight, region (vec4), uv. */
  geometry: BufferGeometry;
  bones: HandBone[];
  /** The forearm's rest frame in the hand frame: its axis (toward the elbow) and up (the back of the arm). */
  forearmAxis: Vector3;
  forearmUp: Vector3;
}

interface HandJson {
  bones: { name: string; parent: number; head: [number, number, number]; tail: [number, number, number] }[];
  forearmAxis: [number, number, number];
  forearmUp: [number, number, number];
}

const BIN_URL = new URL('../assets/hand/hand.bin', import.meta.url).href;
/** The base mesh's own UVs for each vertex (tools/hand_skin_uv.py), for the photographed MakeHuman skin. */
const SKIN_UV_URL = new URL('../assets/hand/hand_skinuv.bin', import.meta.url).href;
const SKIN_URL = new URL('../assets/hand/skin_diffuse.jpg', import.meta.url).href;
const JSON_URL = new URL('../assets/hand/hand.json', import.meta.url).href;
const MAGIC = 0x32444e48; // 'HND2'

let right: HandData | null = null;
let skin: Texture | null = null;
let left: HandData | null = null;

/** Loads the hand; call once before the viewmodel is built. */
export async function loadHandMesh(): Promise<void> {
  if (right) return;
  const [buf, json, skinUv, tex] = await Promise.all([
    (await fetch(BIN_URL)).arrayBuffer(),
    (await fetch(JSON_URL)).json() as Promise<HandJson>,
    (await fetch(SKIN_UV_URL)).arrayBuffer(),
    new TextureLoader().loadAsync(SKIN_URL),
  ]);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  skin = tex;
  right = parse(buf, json, false, skinUv);
  left = parse(buf, json, true, skinUv);
}

/** The right hand, or the left: the right mirrored across x, its winding turned so it still faces out. */
export function handData(side: 1 | -1): HandData {
  const h = side === 1 ? right : left;
  if (!h) throw new Error('hand mesh requested before loadHandMesh() finished');
  return h;
}

/** The photographed skin (MakeHuman's, CC0) the hand's `skinUv` reads. */
export function handSkinTexture(): Texture {
  if (!skin) throw new Error('hand skin requested before loadHandMesh() finished');
  return skin;
}

function parse(buf: ArrayBuffer, json: HandJson, mirror: boolean, skinUvBuf: ArrayBuffer): HandData {
  const head = new DataView(buf, 0, 16);
  if (head.getUint32(0, true) !== MAGIC) throw new Error('not a hand mesh');
  const n = head.getUint32(4, true);
  const m = head.getUint32(8, true);
  let o = 16;
  const position = new Float32Array(buf.slice(o, o + n * 12));
  o += n * 12;
  const n8 = new Int8Array(buf, o, n * 4);
  o += n * 4;
  const skinIndex = new Uint16Array(new Uint8Array(buf, o, n * 4));
  o += n * 4;
  const w8 = new Uint8Array(buf, o, n * 4);
  o += n * 4;
  const r8 = new Uint8Array(buf, o, n * 4);
  o += n * 4;
  const uv16 = new Uint16Array(buf, o, n * 2);
  o += n * 4;
  const index = new Uint16Array(buf.slice(o, o + m * 2));
  const normal = new Float32Array(n * 3);
  const skinWeight = new Float32Array(n * 4);
  const region = new Float32Array(n * 4);
  const uv = new Float32Array(n * 2);
  const sx = mirror ? -1 : 1;
  for (let i = 0; i < n; i++) {
    position[i * 3] = (position[i * 3] as number) * sx;
    normal[i * 3] = ((n8[i * 4] as number) / 127) * sx;
    normal[i * 3 + 1] = (n8[i * 4 + 1] as number) / 127;
    normal[i * 3 + 2] = (n8[i * 4 + 2] as number) / 127;
    for (let k = 0; k < 4; k++) {
      skinWeight[i * 4 + k] = (w8[i * 4 + k] as number) / 255;
      region[i * 4 + k] = (r8[i * 4 + k] as number) / 255;
    }
    // Round the forearm the other way on the left, so its tattoo reads the same from outside.
    const u = (uv16[i * 2] as number) / 65535;
    uv[i * 2] = mirror ? 1 - u : u;
    uv[i * 2 + 1] = (uv16[i * 2 + 1] as number) / 65535;
  }
  if (mirror) {
    for (let t = 0; t < m; t += 3) {
      const a = index[t + 1] as number;
      index[t + 1] = index[t + 2] as number;
      index[t + 2] = a;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  g.setAttribute('region', new BufferAttribute(region, 4));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  // The same skin on both hands: the left is the right mirrored, its texture with it. OBJ's v runs up, as
  // the texture loader's flipped image does.
  const su = new Uint16Array(skinUvBuf);
  const skinUv = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) skinUv[i] = (su[i] as number) / 65535;
  g.setAttribute('skinUv', new BufferAttribute(skinUv, 2));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  const v = (a: [number, number, number]): Vector3 => new Vector3(a[0] * sx, a[1], a[2]);
  return {
    geometry: g,
    bones: json.bones.map((b) => ({ name: b.name, parent: b.parent, head: v(b.head), tail: v(b.tail) })),
    forearmAxis: v(json.forearmAxis),
    forearmUp: v(json.forearmUp),
  };
}

/** Per-segment share of a finger's curl (proximal, middle, distal), as a real grip bends them. */
const CURL_RAD = [1.45, 1.65, 1.1] as const;
/** Each finger's sideways swing at full spread (index → pinky), rad. */
const SPLAY_RAD = [0.1, 0, -0.08, -0.16] as const;
/** The thumb's joints at full wrap (CMC, MCP, IP), and how far its metacarpal turns under the palm. */
const THUMB_RAD = [0.35, 0.55, 0.75] as const;
const OPPOSE_RAD = 0.7;
/** Where the thumb wraps toward: the middle of the palm (hand frame). */
const PALM_CENTRE = new Vector3(0, -0.025, -0.06);
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);

/**
 * Each bone's rotation (relative to its parent, all rest rotations being the identity) for a pose. The
 * fingers curl about the axis that turns their rest direction toward the palm; the thumb turns its
 * metacarpal under the palm and bends toward its middle. The left hand is the right mirrored: its axes
 * come out mirrored from its own bones, and the two turns about fixed axes change sign.
 */
export function poseRotations(data: HandData, pose: HandPose, side: 1 | -1, out: Quaternion[]): void {
  const at = (name: string): number => data.bones.findIndex((b) => b.name === name);
  for (const q of out) q.identity();
  const dir = (b: HandBone): Vector3 => _d.subVectors(b.tail, b.head).normalize();
  for (let f = 2; f <= 5; f++) {
    for (let s = 1; s <= 3; s++) {
      const i = at(`finger${f}-${s}.R`);
      const b = data.bones[i] as HandBone;
      _axis.crossVectors(dir(b), DOWN).normalize();
      const q = (out[i] as Quaternion).setFromAxisAngle(_axis, (pose.curl[f - 2] as number) * (CURL_RAD[s - 1] as number));
      if (s === 1) q.premultiply(_q.setFromAxisAngle(UP, (SPLAY_RAD[f - 2] as number) * pose.spread * side));
    }
  }
  const meta = data.bones[at('metacarpal1.R')] as HandBone;
  const oppose = _oppose.subVectors(meta.tail, meta.head).normalize();
  for (let s = 1; s <= 3; s++) {
    const i = at(`finger1-${s}.R`);
    const b = data.bones[i] as HandBone;
    const d = dir(b);
    _toPalm.copy(PALM_CENTRE).sub(b.head);
    _toPalm.addScaledVector(d, -_toPalm.dot(d)).normalize();
    _axis.crossVectors(d, _toPalm).normalize();
    const q = (out[i] as Quaternion).setFromAxisAngle(_axis, pose.thumb * (THUMB_RAD[s - 1] as number));
    if (s === 1) q.premultiply(_q.setFromAxisAngle(oppose, -side * pose.thumb * OPPOSE_RAD));
  }
}

const _d = new Vector3();
const _axis = new Vector3();
const _toPalm = new Vector3();
const _oppose = new Vector3();
const _q = new Quaternion();
