import { BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, CylinderGeometry, LatheGeometry, Matrix4, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three/webgpu';
import { merge } from '../render/meshkit.ts';

// Passers-by, built and skinned the way Field Line builds its soldiers
// (render/actors.ts, the playbook's §6s): every body part a segment with its
// own bone, the parts lathed through measured profiles in clothes, all of it
// one mesh in a bind pose (standing straight, arms a little out) whose
// vertices near a joint take both bones, so knees and elbows bend as one
// skin. Here in town clothes for an October evening: long coats and short
// jackets, trousers and jeans, a skirt over tights; bare heads with hair,
// scarves, a shoulder bag.
//
// Four builds share the rig: a man and a woman in long coats, a man in a
// jacket, a woman in a jacket and skirt. Colours are not in the mesh: every
// vertex carries a `part` (skin, hair, top, bottom, shoes, accent, legs) and
// the material colours it from the person's own palette (people.ts).

export const L_UPPER_ARM = 0.29;
export const L_FOREARM = 0.25;
export const L_THIGH = 0.43;
export const L_SHIN = 0.42;
export const ANKLE_Y = 0.08;
export const SPINE_M = 0.5;
export const SHOULDER_HALF = 0.18;
export const HIP_Y = 0.92;

export const PART = { skin: 0, hair: 1, top: 2, bottom: 3, shoes: 4, accent: 5, legs: 6 } as const;

export type Segment = 'pelvis' | 'torso' | 'head' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'shoe';
const PAIRED: Record<Segment, boolean> = { pelvis: false, torso: false, head: false, upperArm: true, forearm: true, hand: true, thigh: true, shin: true, shoe: true };

/** Bones, one per segment and side, parents first. */
export const BONES: readonly { seg: Segment; side: 0 | 1; parent: number }[] = [
  { seg: 'pelvis', side: 0, parent: -1 },
  { seg: 'torso', side: 0, parent: 0 },
  { seg: 'head', side: 0, parent: 1 },
  { seg: 'upperArm', side: 0, parent: 1 },
  { seg: 'forearm', side: 0, parent: 3 },
  { seg: 'hand', side: 0, parent: 4 },
  { seg: 'upperArm', side: 1, parent: 1 },
  { seg: 'forearm', side: 1, parent: 6 },
  { seg: 'hand', side: 1, parent: 7 },
  { seg: 'thigh', side: 0, parent: 0 },
  { seg: 'shin', side: 0, parent: 9 },
  { seg: 'shoe', side: 0, parent: 10 },
  { seg: 'thigh', side: 1, parent: 0 },
  { seg: 'shin', side: 1, parent: 12 },
  { seg: 'shoe', side: 1, parent: 13 },
];
export const boneOf = (seg: Segment, side: 0 | 1): number => BONES.findIndex((b) => b.seg === seg && (PAIRED[seg] ? b.side === side : true));

export type Build = 'coatMan' | 'coatWoman' | 'jacketMan' | 'skirtWoman';
export const BUILDS: readonly Build[] = ['coatMan', 'coatWoman', 'jacketMan', 'skirtWoman'];

/**
 * A segment's frame: origin, its local +Y along `up` and its local −Z toward `front`. No mirroring for the
 * left side: paired segments are built symmetric, and a mirrored frame would flip the skin's winding.
 */
export function frame(out: Matrix4, origin: Vector3, up: Vector3, front: Vector3): Matrix4 {
  _y.copy(up).normalize();
  _z.copy(front).addScaledVector(_y, -front.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, -1).addScaledVector(_y, _y.z);
  _z.normalize().negate();
  _x.crossVectors(_y, _z);
  return out.makeBasis(_x, _y, _z).setPosition(origin);
}

/** The bind pose: standing straight, legs under the hips, arms hanging a little out (an A-pose). */
export function bindFrames(): Matrix4[] {
  const hip = new Vector3(0, HIP_Y, 0);
  const fwd = new Vector3(0, 0, -1);
  const up = new Vector3(0, 1, 0);
  return BONES.map(({ seg, side }) => {
    const sx = side === 1 ? 1 : -1;
    const m = new Matrix4();
    const armDir = new Vector3(sx * 0.17, -1, 0).normalize();
    const shoulder = new Vector3(sx * SHOULDER_HALF, hip.y + SPINE_M - 0.06, 0);
    const hipJoint = new Vector3(sx * 0.095, hip.y - 0.02, 0);
    const down = new Vector3(0, -1, 0);
    switch (seg) {
      case 'pelvis':
      case 'torso':
        return frame(m, hip, up, fwd);
      case 'head':
        return frame(m, new Vector3(0, hip.y + SPINE_M + 0.14, 0), up, fwd);
      case 'upperArm':
        return frame(m, shoulder, armDir.clone().negate(), fwd);
      case 'forearm':
        return frame(m, shoulder.clone().addScaledVector(armDir, L_UPPER_ARM), armDir.clone().negate(), fwd);
      case 'hand':
        return frame(m, shoulder.clone().addScaledVector(armDir, L_UPPER_ARM + L_FOREARM), armDir.clone().negate(), fwd);
      case 'thigh':
        return frame(m, hipJoint, up, fwd);
      case 'shin':
        return frame(m, hipJoint.clone().addScaledVector(down, L_THIGH), up, fwd);
      case 'shoe':
        return frame(m, hipJoint.clone().addScaledVector(down, L_THIGH + L_SHIN), up, fwd);
    }
  });
}

/**
 * Two-bone IK: the joint between `root` and `target` for bones `l1` and `l2`, bent toward `pole`; out of
 * reach, the limb straightens toward the target. Writes the joint to `mid` and the reached end to `end`.
 */
export function solveTwoBone(root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, mid: Vector3, end: Vector3): void {
  const u = _ikU.subVectors(target, root);
  const raw = u.length();
  if (raw < 1e-6) u.set(0, -1, 0);
  else u.multiplyScalar(1 / raw);
  const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, raw));
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const v = _ikV.copy(pole).addScaledVector(u, -pole.dot(u));
  if (v.lengthSq() < 1e-8) v.set(u.y, -u.x, 0);
  v.normalize();
  mid.copy(root).addScaledVector(u, l1 * cosA).addScaledVector(v, l1 * sinA);
  end.copy(root).addScaledVector(u, dist);
}

export const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How much of a vertex of `bone` (at p in its frame) goes with its neighbours: half at the joint, fading either side. */
function shares(bone: number, p: Vector3): [number, number][] {
  const { seg } = BONES[bone] as (typeof BONES)[number];
  const y = p.y;
  const parent = (BONES[bone] as (typeof BONES)[number]).parent;
  const child = BONES.findIndex((b) => b.parent === bone && PAIRED[b.seg] === PAIRED[seg]);
  switch (seg) {
    case 'pelvis':
      return [[boneOf('torso', 0), 0.5 * smooth(0, 0.12, y)]];
    case 'torso': {
      const out: [number, number][] = [
        [parent, 0.5 * (1 - smooth(0.02, 0.15, y))],
        [boneOf('head', 0), 0.5 * smooth(SPINE_M - 0.04, SPINE_M + 0.05, y)],
      ];
      for (const s of [0, 1] as const) {
        const d = Math.hypot(p.x - (s === 1 ? SHOULDER_HALF : -SHOULDER_HALF), y - (SPINE_M - 0.06), p.z);
        out.push([boneOf('upperArm', s), 0.45 * (1 - smooth(0.04, 0.1, d))]);
      }
      return out;
    }
    case 'head':
      return [[parent, 0.5 * (1 - smooth(-0.15, -0.07, y))]];
    case 'upperArm':
      return [
        [parent, 0.5 * smooth(-0.1, 0, y)],
        [child, 0.5 * smooth(-L_UPPER_ARM + 0.07, -L_UPPER_ARM, y)],
      ];
    case 'forearm':
      return [
        [parent, 0.5 * smooth(-0.07, 0, y)],
        [child, 0.5 * smooth(-L_FOREARM + 0.04, -L_FOREARM, y)],
      ];
    case 'hand':
      return [[parent, 0.5 * smooth(-0.04, 0, y)]];
    case 'thigh':
      return [
        [parent, 0.5 * smooth(-0.12, 0, y)],
        [child, 0.5 * smooth(-L_THIGH + 0.08, -L_THIGH, y)],
      ];
    case 'shin':
      return [
        [parent, 0.5 * smooth(-0.08, 0, y)],
        [child, 0.5 * smooth(-L_SHIN + 0.05, -L_SHIN, y)],
      ];
    case 'shoe':
      return [[parent, 0.5 * smooth(0.02, 0.1, y)]];
  }
}

/**
 * The hem of a coat or skirt hangs from the hips but must follow the legs: a vertex below the hips goes
 * partly with the thigh on its own side, more the lower it is and the further out to that side.
 */
function hemShares(p: Vector3): [number, number][] {
  const below = smooth(-0.05, -0.45, p.y);
  const side: 0 | 1 = p.x >= 0 ? 1 : 0;
  const out = Math.min(1, Math.abs(p.x) / 0.12);
  return [[boneOf('thigh', side), 0.75 * below * out]];
}

interface Part {
  bone: number;
  geo: BufferGeometry;
  hem?: boolean;
}

/** One build as a skinned mesh in the bind pose: up to four bones and weights per vertex (skinning.ts). */
/** `coarse`: the far version (~1/5 of the triangles: fewer rings and sides, no ears), same rig and parts. */
export function buildBody(build: Build, coarse = false): BufferGeometry {
  const bind = bindFrames();
  const parts: Part[] = [];
  const add = (seg: Segment, side: 0 | 1, geo: BufferGeometry, hem = false): void => {
    parts.push({ bone: boneOf(seg, side), geo, hem });
  };
  DETAIL = coarse ? COARSE : FINE;
  const parts0 = segments(build);
  for (const b of BONES) {
    for (const g of parts0[b.seg]) add(b.seg, b.side, g);
  }
  for (const g of parts0.hem) add('pelvis', 0, g, true);
  const pos: BufferGeometry[] = [];
  const idx: number[] = [];
  const wgt: number[] = [];
  const v = new Vector3();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    const at = g.getAttribute('position');
    for (let i = 0; i < at.count; i++) {
      v.set(at.getX(i), at.getY(i), at.getZ(i));
      const others = (p.hem ? hemShares(v) : shares(p.bone, v))
        .filter(([b, w]) => b >= 0 && w > 1e-4)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      const rest = Math.max(0, 1 - others.reduce((a, [, w]) => a + w, 0));
      const list: [number, number][] = [[p.bone, rest], ...others];
      while (list.length < 4) list.push([p.bone, 0]);
      const sum = list.reduce((a, [, w]) => a + w, 0) || 1;
      for (const [b, w] of list) {
        idx.push(b);
        wgt.push(w / sum);
      }
    }
    g.applyMatrix4(bind[p.bone] as Matrix4);
    pos.push(g);
  }
  const partIds: number[] = [];
  for (const g of pos) partIds.push(...(g.getAttribute('part').array as Float32Array));
  const out = merge(pos, `body-${build}${coarse ? '-coarse' : ''}`);
  out.setAttribute('part', new BufferAttribute(new Float32Array(partIds), 1));
  out.setAttribute('skinIdx', new BufferAttribute(new Float32Array(idx), 4));
  out.setAttribute('skinWgt', new BufferAttribute(new Float32Array(wgt), 4));
  return out;
}

// ------------------------------------------------------------------ geometry

/** Tessellation: lathe sides and rings, sphere segments. */
interface Detail {
  sides: number;
  rings: number;
  sphere: number;
}
const FINE: Detail = { sides: 9, rings: 7, sphere: 14 };
const COARSE: Detail = { sides: 5, rings: 3, sphere: 6 };
/** The detail the builders below use (set by buildBody for the build in hand). */
let DETAIL: Detail = FINE;
/** A segment count for the current detail: halved (at least 3) on the coarse build. */
const seg = (n: number): number => (DETAIL === COARSE ? Math.max(3, Math.round(n / 2)) : n);

function tag(g: BufferGeometry, part: number): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  n.setAttribute('part', new BufferAttribute(new Float32Array(n.getAttribute('position').count).fill(part), 1));
  return n;
}

/** A limb along −Y: a lathe through [fraction, radius] pairs, its section `depth` times as deep as wide, domed ends. */
function limb(length: number, profile: readonly [number, number][], depth: number, part: number): BufferGeometry {
  const radiusAt = (t: number): number => {
    for (let k = 1; k < profile.length; k++) {
      const [t1, r1] = profile[k] as [number, number];
      const [t0, r0] = profile[k - 1] as [number, number];
      if (t <= t1) {
        const u = (t - t0) / Math.max(1e-6, t1 - t0);
        return r0 + (r1 - r0) * u * u * (3 - 2 * u);
      }
    }
    return (profile[profile.length - 1] as [number, number])[1];
  };
  const pts: Vector2[] = [new Vector2(0.001, radiusAt(0) * 0.6)];
  pts.push(new Vector2(radiusAt(0) * 0.8, radiusAt(0) * 0.45));
  const R = DETAIL.rings;
  for (let k = 0; k <= R; k++) pts.push(new Vector2(radiusAt(k / R), -(k / R) * length));
  pts.push(new Vector2(radiusAt(1) * 0.75, -length - radiusAt(1) * 0.45), new Vector2(0.001, -length - radiusAt(1) * 0.6));
  // LatheGeometry runs bottom to top in its points' order; ours run top down, so reverse for outward normals.
  return tag(new LatheGeometry(pts.reverse(), DETAIL.sides).scale(1, 1, depth), part);
}

/** A lofted body section through rings (y, half-width, half-depth, z offset), closed at both ends. */
function loft(rings: readonly [number, number, number, number][], part: number): BufferGeometry {
  const SEG = DETAIL.sides + 5;
  const pos: number[] = [];
  const all: [number, number, number, number][] = [[(rings[0] as number[])[0] as number, 0.001, 0.001, 0], ...rings, [(rings[rings.length - 1] as number[])[0] as number, 0.001, 0.001, 0]];
  const ring = (k: number, j: number): Vector3 => {
    const [y, rx, rz, z] = all[k] as [number, number, number, number];
    const th = (j / SEG) * Math.PI * 2;
    return new Vector3(Math.cos(th) * rx, y, z + Math.sin(th) * rz);
  };
  for (let k = 0; k < all.length - 1; k++) {
    for (let j = 0; j < SEG; j++) {
      const a = ring(k, j);
      const b = ring(k, j + 1);
      const c = ring(k + 1, j + 1);
      const d = ring(k + 1, j);
      // Rings run top down: a, d, c / a, c, b faces outward.
      pos.push(a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.computeVertexNormals();
  return tag(g, part);
}

/** A face: brow, nose, cheekbones and jaw pressed into a sphere (front −Z). */
function headGeometry(): BufferGeometry {
  const g = new SphereGeometry(0.098, DETAIL.sphere, Math.round(DETAIL.sphere * 0.7)).scale(0.8, 1.08, 0.95);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  const bump = (p: Vector3, x: number, y: number, z: number, r: number): number => Math.exp(-((p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2) / (r * r));
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const front = Math.max(0, -v.z / 0.093);
    const out = 0.017 * bump(v, 0, -0.014, -0.093, 0.02) + 0.006 * bump(v, 0, 0.028, -0.086, 0.034) + 0.004 * (bump(v, -0.044, 0.0, -0.07, 0.024) + bump(v, 0.044, 0.0, -0.07, 0.024)) - 0.006 * (bump(v, -0.031, 0.018, -0.086, 0.017) + bump(v, 0.031, 0.018, -0.086, 0.017));
    const jaw = v.y < -0.03 ? 1 - Math.min(0.2, (-0.03 - v.y) * 2.4) * (1 - front) : 1;
    pos.setXYZ(i, v.x * jaw, v.y, v.z - out * front);
  }
  g.computeVertexNormals();
  return tag(g, PART.skin);
}

/**
 * Hair as a shell a little outside the skull, open over the face (below the hairline in front, the shell is
 * pulled inside the head where it cannot show), falling to the nape — and for longer hair to the shoulders.
 */
function hairGeometry(long: boolean): BufferGeometry {
  const g = new SphereGeometry(0.106, DETAIL.sphere, Math.round(DETAIL.sphere * 0.7)).scale(0.84, 1.08, 1.0);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const front = -v.z / 0.106;
    // The hairline: high on the forehead, down to the temples, behind the ears at the sides.
    const line = front > 0.55 ? 0.035 : front > 0 ? 0.035 - (0.55 - front) * 0.09 : -0.02 - Math.min(1, -front) * 0.04;
    if (v.y < line) {
      if (long && front < 0.35) {
        // Long hair keeps going down behind and beside the face, to the shoulders.
        const drop = Math.min(1, (line - v.y) / 0.1);
        v.y -= drop * 0.1;
        v.x *= 1 + drop * 0.12;
        v.z += drop * 0.015;
      } else v.multiplyScalar(0.86);
    }
    pos.setXYZ(i, v.x, v.y + 0.008, v.z + 0.004);
  }
  g.computeVertexNormals();
  return tag(g, PART.hair);
}

/** A shoe from its side: sole and upper, toe forward (−Z), ~27 cm long. */
function shoe(woman: boolean): BufferGeometry[] {
  const upper = new SphereGeometry(1, seg(12), seg(8)).scale(0.045, 0.045, 0.125).translate(0, -0.035, -0.06);
  const heel = new CylinderGeometry(0.04, 0.042, 0.08, seg(10)).translate(0, -0.035, 0.03);
  const sole = new BoxGeometry(0.085, 0.02, 0.27).translate(0, woman ? -0.072 : -0.075, -0.045);
  return [tag(upper, PART.shoes), tag(heel, PART.shoes), tag(sole, PART.shoes)];
}

/** Every segment's parts in its own frame, and the hem (coat or skirt) hung from the pelvis. */
function segments(build: Build): Record<Segment, BufferGeometry[]> & { hem: BufferGeometry[] } {
  const woman = build === 'coatWoman' || build === 'skirtWoman';
  const coat = build === 'coatMan' || build === 'coatWoman';
  const skirt = build === 'skirtWoman';
  const w = woman ? 0.92 : 1;
  const legPart = skirt ? PART.legs : PART.bottom;
  const torsoProfile: [number, number][] = woman
    ? [[0.001, -0.02], [0.14, 0.0], [0.13, 0.16], [0.155, 0.3], [0.16, 0.4], [0.13, 0.47], [0.055, 0.52]]
    : [[0.001, -0.02], [0.15, 0.0], [0.15, 0.18], [0.175, 0.36], [0.17, 0.45], [0.13, 0.49], [0.055, 0.52]];
  const torso: BufferGeometry[] = [
    tag(new LatheGeometry(torsoProfile.map(([r, y]) => new Vector2(r, y)), DETAIL.sides + 5).scale(1, 1, coat ? 0.68 : 0.62), PART.top),
    tag(new SphereGeometry(0.068 * w, seg(10), seg(8)).scale(1, 0.9, 1).translate(-SHOULDER_HALF, SPINE_M - 0.06, 0), PART.top),
    tag(new SphereGeometry(0.068 * w, seg(10), seg(8)).scale(1, 0.9, 1).translate(SHOULDER_HALF, SPINE_M - 0.06, 0), PART.top),
    tag(new CylinderGeometry(0.052, 0.06, 0.11, seg(10)).translate(0, 0.53, 0), PART.skin),
  ];
  if (coat) {
    // Collar standing round the neck and the lapels' edge down the front.
    torso.push(tag(new CylinderGeometry(0.075, 0.095, 0.08, seg(12), 1, true).translate(0, 0.5, 0.0), PART.top));
    torso.push(tag(new BoxGeometry(0.02, 0.3, 0.02).translate(0, 0.28, -0.115), PART.top));
  }
  if (woman || build === 'coatMan') torso.push(tag(new TorusGeometry(0.07, 0.028, seg(6), seg(12)).rotateX(Math.PI / 2).translate(0, 0.5, -0.005), PART.accent)); // scarf
  if (woman) {
    // A shoulder bag on the right hip, its strap across the chest.
    torso.push(tag(new BoxGeometry(0.07, 0.2, 0.26).translate(0.19, 0.02, 0.02), PART.accent));
    torso.push(tag(new BoxGeometry(0.03, 0.62, 0.015).rotateZ(0.62).translate(0.0, 0.27, -0.13), PART.accent));
  }
  const pelvis: BufferGeometry[] = [
    loft(
      [
        [0.1, 0.15 * w, 0.11, 0],
        [0.03, 0.17 * w, 0.12, 0.005],
        [-0.04, 0.175 * w, 0.125, 0.01],
        [-0.1, 0.15 * w, 0.11, 0.01],
        [-0.14, 0.08, 0.07, 0.0],
      ],
      skirt ? PART.bottom : coat ? PART.top : PART.bottom,
    ),
  ];
  const hem: BufferGeometry[] = [];
  if (coat || skirt) {
    // Hangs to the knee (coat) or just above it (skirt), flaring a little.
    const len = coat ? 0.5 : 0.4;
    const flare = coat ? 0.06 : 0.05;
    hem.push(
      loft(
        [
          [0.0, 0.175 * w, 0.13, 0.01],
          [-len * 0.4, 0.185 * w + flare * 0.4, 0.14 + flare * 0.3, 0.01],
          [-len, 0.19 * w + flare, 0.145 + flare * 0.6, 0.015],
        ],
        coat ? PART.top : PART.bottom,
      ),
    );
  }
  const head: BufferGeometry[] = [headGeometry(), hairGeometry(woman)];
  if (DETAIL !== COARSE) for (const sx of [-1, 1]) head.push(tag(new SphereGeometry(0.018, seg(6), seg(5)).scale(0.6, 1.2, 1).translate(sx * 0.079, -0.005, 0.005), PART.skin));
  const sleeve = coat ? 0.06 : 0.056;
  return {
    pelvis,
    hem,
    torso,
    head,
    upperArm: [limb(L_UPPER_ARM, [[0, sleeve * w], [0.3, 0.056 * w], [1, 0.047 * w]], 0.92, PART.top)],
    forearm: [limb(L_FOREARM, [[0, 0.048 * w], [0.4, 0.046 * w], [0.85, 0.04 * w], [1, 0.041 * w]], 0.85, PART.top)],
    hand: [
      tag(new SphereGeometry(1, seg(10), seg(7)).scale(0.038 * w, 0.048 * w, 0.02).translate(0, -0.045, 0), PART.skin),
      tag(new CapsuleGeometry(0.013 * w, 0.05, 2, seg(6)).translate(0, -0.1, 0), PART.skin),
    ],
    thigh: [limb(L_THIGH, woman ? [[0, 0.088], [0.5, 0.068], [1, 0.05]] : [[0, 0.09], [0.5, 0.074], [1, 0.058]], 0.95, legPart)],
    shin: [limb(L_SHIN, woman ? [[0, 0.05], [0.3, 0.052], [0.85, 0.034], [1, 0.032]] : [[0, 0.058], [0.3, 0.058], [0.85, 0.05], [1, 0.05]], 0.95, legPart)],
    shoe: shoe(woman),
  };
}

const _ikU = new Vector3();
const _ikV = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
