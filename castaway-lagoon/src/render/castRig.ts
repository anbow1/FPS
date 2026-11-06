import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { FULL_BONES, type FullBone, type Joints } from './mpfbCast.ts';

// Drives an MPFB character (21 bones, its own proportions, standing in an A-pose) from the posing the
// procedural man gets (guerrillas.ts here, actors.ts in Field Line: 15 segments, each placed as a frame — origin at its joint, +Y back
// toward its parent joint, −Z toward its "front": the elbow's or the knee's point for a limb, the thumb
// for a hand, the face for the head and trunk).
//
// The posing runs on this character's own measurements (Dims: limb lengths, hip and shoulder joints,
// ankle and hip heights), so its IK puts the joints where this body's joints are. Each bone then takes the
// rotation that turns its rest frame — built from the character's joints with the same meaning of up and
// front — onto its segment's posed frame; the spine and chest go with the trunk, the neck halfway to the
// head, the collar bones with the chest, the toes with the foot. The joints the posing does not place
// (chest, neck, head, collar bones, toes) follow by forward kinematics. Skin matrix: T(posed joint) · R ·
// T(−rest joint), so a vertex in the bind pose goes straight to the world.

/** The measurements the posing needs, in metres; `hipJoint` and `shoulder` for the right side. */
export interface Dims {
  thigh: number;
  shin: number;
  upperArm: number;
  forearm: number;
  ankleY: number;
  /** Hip height standing at ease, the knees just off straight. */
  standHip: number;
  /** Leg length over the procedural soldier's (crouched heights scale by it). */
  legScale: number;
  /** Right hip joint from the pelvis's origin, in the pelvis's frame. */
  hipJoint: Vector3;
  /** Right shoulder joint from the pelvis's origin, in the trunk's frame. */
  shoulder: Vector3;
}

/** The procedural soldier's segments, in actors.ts's bone order (side 0 left, 1 right). */
export const SEG = {
  pelvis: 0, torso: 1, head: 2,
  upperArmL: 3, forearmL: 4, handL: 5, upperArmR: 6, forearmR: 7, handR: 8,
  thighL: 9, shinL: 10, bootL: 11, thighR: 12, shinR: 13, bootR: 14,
} as const;

type Drive =
  /** Rotation of a segment; position from its origin. */
  | { seg: number; pos: 'seg' }
  /** Rotation of a segment; position by forward kinematics from the parent bone. */
  | { seg: number; pos: 'fk' }
  /** Halfway between two segments' rotations; position by forward kinematics. */
  | { seg: number; seg2: number; pos: 'fk' };

const DRIVE: Record<FullBone, Drive> = {
  pelvis: { seg: SEG.pelvis, pos: 'seg' },
  spine: { seg: SEG.torso, pos: 'fk' },
  chest: { seg: SEG.torso, pos: 'fk' },
  neck: { seg: SEG.torso, seg2: SEG.head, pos: 'fk' },
  head: { seg: SEG.head, pos: 'fk' },
  'clavicle.L': { seg: SEG.torso, pos: 'fk' },
  'upperArm.L': { seg: SEG.upperArmL, pos: 'seg' },
  'forearm.L': { seg: SEG.forearmL, pos: 'seg' },
  'hand.L': { seg: SEG.handL, pos: 'seg' },
  'clavicle.R': { seg: SEG.torso, pos: 'fk' },
  'upperArm.R': { seg: SEG.upperArmR, pos: 'seg' },
  'forearm.R': { seg: SEG.forearmR, pos: 'seg' },
  'hand.R': { seg: SEG.handR, pos: 'seg' },
  'thigh.L': { seg: SEG.thighL, pos: 'seg' },
  'shin.L': { seg: SEG.shinL, pos: 'seg' },
  'foot.L': { seg: SEG.bootL, pos: 'seg' },
  'toe.L': { seg: SEG.bootL, pos: 'fk' },
  'thigh.R': { seg: SEG.thighR, pos: 'seg' },
  'shin.R': { seg: SEG.shinR, pos: 'seg' },
  'foot.R': { seg: SEG.bootR, pos: 'seg' },
  'toe.R': { seg: SEG.bootR, pos: 'fk' },
};

const PARENT: Record<FullBone, FullBone | null> = {
  pelvis: null, spine: 'pelvis', chest: 'spine', neck: 'chest', head: 'neck',
  'clavicle.L': 'chest', 'upperArm.L': 'clavicle.L', 'forearm.L': 'upperArm.L', 'hand.L': 'forearm.L',
  'clavicle.R': 'chest', 'upperArm.R': 'clavicle.R', 'forearm.R': 'upperArm.R', 'hand.R': 'forearm.R',
  'thigh.L': 'pelvis', 'shin.L': 'thigh.L', 'foot.L': 'shin.L', 'toe.L': 'foot.L',
  'thigh.R': 'pelvis', 'shin.R': 'thigh.R', 'foot.R': 'shin.R', 'toe.R': 'foot.R',
};

/** The character's joint at each bone's root. */
const JOINT: Record<FullBone, string> = {
  pelvis: 'hip', spine: 'hip', chest: 'chest', neck: 'neck', head: 'head',
  'clavicle.L': 'clavicle.L', 'upperArm.L': 'shoulder.L', 'forearm.L': 'elbow.L', 'hand.L': 'wrist.L',
  'clavicle.R': 'clavicle.R', 'upperArm.R': 'shoulder.R', 'forearm.R': 'elbow.R', 'hand.R': 'wrist.R',
  'thigh.L': 'hip.L', 'shin.L': 'knee.L', 'foot.L': 'ankle.L', 'toe.L': 'toe.L',
  'thigh.R': 'hip.R', 'shin.R': 'knee.R', 'foot.R': 'ankle.R', 'toe.R': 'toe.R',
};

/** The limbs' rest frames: the joint the bone points at, and where its "front" points at rest. */
const LIMB: Partial<Record<FullBone, { tip: string; front: [number, number, number] }>> = {
  // A-pose arms: the elbow's point faces back; the hand's thumb forward.
  'upperArm.L': { tip: 'elbow.L', front: [0, 0, 1] },
  'forearm.L': { tip: 'wrist.L', front: [0, 0, 1] },
  'hand.L': { tip: 'fingers.L', front: [0, 0, -1] },
  'upperArm.R': { tip: 'elbow.R', front: [0, 0, 1] },
  'forearm.R': { tip: 'wrist.R', front: [0, 0, 1] },
  'hand.R': { tip: 'fingers.R', front: [0, 0, -1] },
  // Legs: the knee's point faces forward.
  'thigh.L': { tip: 'knee.L', front: [0, 0, -1] },
  'shin.L': { tip: 'ankle.L', front: [0, 0, -1] },
  'thigh.R': { tip: 'knee.R', front: [0, 0, -1] },
  'shin.R': { tip: 'ankle.R', front: [0, 0, -1] },
};

/** The procedural soldier's legs (thigh + shin), for scaling heights set for it. */
const PROC_LEG = 0.86;

export class CastRig {
  readonly dims: Dims;
  private readonly rest: Vector3[];
  /** Inverse rest frame (rotation) per bone: identity for the trunk, feet and toes. */
  private readonly unrest: Quaternion[];
  private readonly parent: number[];
  private readonly R = FULL_BONES.map(() => new Quaternion());
  private readonly P = FULL_BONES.map(() => new Vector3());

  constructor(joints: Joints) {
    const v = (name: string): Vector3 => {
      const p = joints[name];
      if (!p) throw new Error(`character joints lack '${name}'`);
      return new Vector3(p[0], p[1], p[2]);
    };
    this.rest = FULL_BONES.map((b) => v(JOINT[b]));
    this.parent = FULL_BONES.map((b) => {
      const p = PARENT[b];
      return p ? FULL_BONES.indexOf(p) : -1;
    });
    const m = new Matrix4();
    this.unrest = FULL_BONES.map((b) => {
      const limb = LIMB[b];
      if (!limb) return new Quaternion();
      const up = v(JOINT[b]).sub(v(limb.tip)).normalize();
      frameRotation(m, up, _a.set(...limb.front));
      return new Quaternion().setFromRotationMatrix(m).invert();
    });
    const both = (a: string, b: string): number => (v(`${a}.L`).distanceTo(v(`${b}.L`)) + v(`${a}.R`).distanceTo(v(`${b}.R`))) / 2;
    const hip = v('hip');
    const thigh = both('hip', 'knee');
    const shin = both('knee', 'ankle');
    const ankleY = (v('ankle.L').y + v('ankle.R').y) / 2;
    this.dims = {
      thigh,
      shin,
      upperArm: both('shoulder', 'elbow'),
      forearm: both('elbow', 'wrist'),
      ankleY,
      // The legs' reach under the hip joints, less 5 cm: soft knees, and the feet stand apart.
      standHip: hip.y - v('hip.R').y + ankleY + thigh + shin - 0.05,
      legScale: (thigh + shin) / PROC_LEG,
      hipJoint: v('hip.R').sub(hip),
      shoulder: v('shoulder.R').sub(hip),
    };
  }

  /**
   * The skin matrices for one soldier from his segments' posed world frames (`seg`, in actors.ts's bone
   * order), written through `set(bone, matrix)`.
   */
  skin(seg: readonly Matrix4[], set: (bone: number, m: Matrix4) => void): void {
    FULL_BONES.forEach((b, i) => {
      const d = DRIVE[b];
      const R = this.R[i] as Quaternion;
      R.setFromRotationMatrix(seg[d.seg] as Matrix4);
      if ('seg2' in d) R.slerp(_q.setFromRotationMatrix(seg[d.seg2] as Matrix4), 0.5);
      R.multiply(this.unrest[i] as Quaternion);
      const P = this.P[i] as Vector3;
      const p = this.parent[i] as number;
      if (d.pos === 'seg' || p < 0) P.setFromMatrixPosition(seg[d.seg] as Matrix4);
      else P.subVectors(this.rest[i] as Vector3, this.rest[p] as Vector3).applyQuaternion(this.R[p] as Quaternion).add(this.P[p] as Vector3);
      _m.makeRotationFromQuaternion(R);
      _a.copy(this.rest[i] as Vector3).applyQuaternion(R);
      _m.setPosition(P.x - _a.x, P.y - _a.y, P.z - _a.z);
      set(i, _m);
    });
  }
}

/** The rotation of a frame with +Y along `up` and −Z toward `front` (as actors.ts builds its segments). */
function frameRotation(out: Matrix4, up: Vector3, front: Vector3): Matrix4 {
  _y.copy(up).normalize();
  _z.copy(front).addScaledVector(_y, -front.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, -1).addScaledVector(_y, _y.z);
  _z.normalize().negate();
  _x.crossVectors(_y, _z);
  return out.makeBasis(_x, _y, _z);
}

const _m = new Matrix4();
const _q = new Quaternion();
const _a = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
