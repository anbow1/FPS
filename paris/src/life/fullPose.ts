import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { boneIndex, type MocapPose, tposeDirection } from '../render/mocap.ts';
import { solveTwoBone } from './body.ts';
import type { Joints } from './rig.ts';

// Posing for characters made in Blender with the full skeleton (tools/people,
// RIG_BONES): 21 bones, every one driven by its own bone of the motion capture
// — the lumbar spine and the chest apart, the neck, the collar bones, the toes
// — where the 15-bone rig folded the spine and collar bones into one stiff
// trunk and its arms grew out of the ribs.
//
// Retargeting: the capture gives each bone's world rotation relative to its
// T-pose (MocapPose.delta). A character from MPFB stands in an A-pose, arms
// ~45° down, its spine with its own curve: so each bone first turns from the
// character's rest direction onto the capture's T-pose direction (`align`, the
// shortest arc between the two, measured once from the joints and the capture
// skeleton), then by the capture's rotation. The joints follow by forward
// kinematics from the pelvis, each bone's skin matrix is T(posed joint) · R ·
// T(−rest joint), and the pelvis drops until the planted ankle is at its rest
// height. Sitting and cycling aim the limbs at targets instead (shortest arc
// from the rest direction), with two-bone IK where a hand or foot must reach.

export const FULL_BONES = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavicle.L', 'upperArm.L', 'forearm.L', 'hand.L', 'clavicle.R', 'upperArm.R', 'forearm.R', 'hand.R',
  'thigh.L', 'shin.L', 'foot.L', 'toe.L', 'thigh.R', 'shin.R', 'foot.R', 'toe.R',
] as const;
export type FullBone = (typeof FULL_BONES)[number];

interface Spec {
  bone: FullBone;
  parent: FullBone | null;
  /** The character's joint at the bone's root, and the one its direction points at (null: no direction). */
  joint: string;
  tip: string | null;
  /** The capture's bone that drives it, and the capture joint its T-pose direction points at. */
  mocap: string;
  mocapTip: string | null;
}

function specs(): Spec[] {
  const out: Spec[] = [
    { bone: 'pelvis', parent: null, joint: 'hip', tip: null, mocap: 'Hips', mocapTip: null },
    { bone: 'spine', parent: 'pelvis', joint: 'hip', tip: 'chest', mocap: 'Spine', mocapTip: 'Spine1' },
    { bone: 'chest', parent: 'spine', joint: 'chest', tip: 'neck', mocap: 'Spine1', mocapTip: 'Neck' },
    { bone: 'neck', parent: 'chest', joint: 'neck', tip: 'head', mocap: 'Neck', mocapTip: 'Head' },
    { bone: 'head', parent: 'neck', joint: 'head', tip: null, mocap: 'Head', mocapTip: null },
  ];
  for (const [s, M] of [
    ['L', 'Left'],
    ['R', 'Right'],
  ] as const) {
    out.push(
      { bone: `clavicle.${s}`, parent: 'chest', joint: `clavicle.${s}`, tip: `shoulder.${s}`, mocap: `${M}Shoulder`, mocapTip: `${M}Arm` },
      { bone: `upperArm.${s}`, parent: `clavicle.${s}`, joint: `shoulder.${s}`, tip: `elbow.${s}`, mocap: `${M}Arm`, mocapTip: `${M}ForeArm` },
      { bone: `forearm.${s}`, parent: `upperArm.${s}`, joint: `elbow.${s}`, tip: `wrist.${s}`, mocap: `${M}ForeArm`, mocapTip: `${M}Hand` },
      { bone: `hand.${s}`, parent: `forearm.${s}`, joint: `wrist.${s}`, tip: `fingers.${s}`, mocap: `${M}Hand`, mocapTip: `${M}FingerBase` },
      { bone: `thigh.${s}`, parent: 'pelvis', joint: `hip.${s}`, tip: `knee.${s}`, mocap: `${M}UpLeg`, mocapTip: `${M}Leg` },
      { bone: `shin.${s}`, parent: `thigh.${s}`, joint: `knee.${s}`, tip: `ankle.${s}`, mocap: `${M}Leg`, mocapTip: `${M}Foot` },
      { bone: `foot.${s}`, parent: `shin.${s}`, joint: `ankle.${s}`, tip: `toe.${s}`, mocap: `${M}Foot`, mocapTip: `${M}ToeBase` },
      { bone: `toe.${s}`, parent: `foot.${s}`, joint: `toe.${s}`, tip: null, mocap: `${M}ToeBase`, mocapTip: null },
    );
  }
  // Parents before children, in FULL_BONES order for the bone texture.
  return FULL_BONES.map((b) => out.find((x) => x.bone === b) as Spec);
}

const SPECS = specs();
const IDX = new Map<FullBone, number>(FULL_BONES.map((b, i) => [b, i]));
const at = (b: FullBone): number => IDX.get(b) as number;

export class FullPoser {
  /** Rest joint of each bone (game frame, metres) and its unit rest direction (null where it has none). */
  private readonly rest: Vector3[];
  private readonly restDir: (Vector3 | null)[];
  private readonly parent: number[];
  private align: Quaternion[] | null = null;
  private mocapIdx: number[] = [];
  readonly thigh: number;
  readonly shin: number;
  readonly upperArm: number;
  readonly forearm: number;
  readonly ankleY: number;
  private readonly hipY: number;
  // Per-pose scratch: world rotations and posed joints.
  private readonly R = FULL_BONES.map(() => new Quaternion());
  private readonly P = FULL_BONES.map(() => new Vector3());

  constructor(joints: Joints) {
    const v = (name: string): Vector3 => {
      const p = joints[name];
      if (!p) throw new Error(`character joints lack '${name}' (rebuild with the 21-bone builder)`);
      return new Vector3(p[0], p[1], p[2]);
    };
    this.rest = SPECS.map((s) => v(s.joint));
    this.restDir = SPECS.map((s) => (s.tip ? v(s.tip).sub(v(s.joint)).normalize() : null));
    this.parent = SPECS.map((s) => (s.parent ? at(s.parent) : -1));
    const len = (a: string, b: string): number => (v(`${a}.L`).distanceTo(v(`${b}.L`)) + v(`${a}.R`).distanceTo(v(`${b}.R`))) / 2;
    this.thigh = len('hip', 'knee');
    this.shin = len('knee', 'ankle');
    this.upperArm = len('shoulder', 'elbow');
    this.forearm = len('elbow', 'wrist');
    this.ankleY = (v('ankle.L').y + v('ankle.R').y) / 2;
    this.hipY = v('hip').y;
  }

  /** The A-to-T alignment of each bone (needs the capture's skeleton: computed on first use). */
  private aligned(): Quaternion[] {
    if (!this.align) {
      this.align = SPECS.map((s, i) => {
        const d = this.restDir[i];
        if (!d || !s.mocapTip) return new Quaternion();
        return new Quaternion().setFromUnitVectors(d, tposeDirection(s.mocap, s.mocapTip));
      });
      this.mocapIdx = SPECS.map((s) => boneIndex(s.mocap));
    }
    return this.align;
  }

  /** Walking or running as captured (`cap` solved), the head turned by `headYaw`; skin matrices into `out`. */
  walk(cap: MocapPose, headYaw: number, out: Matrix4[]): void {
    const A = this.aligned();
    SPECS.forEach((_, i) => (this.R[i] as Quaternion).copy(cap.delta[this.mocapIdx[i] as number] as Quaternion).multiply(A[i] as Quaternion));
    this.turnHead(headYaw);
    // The capture's hips, then dropped (or raised) until the lower ankle is at its rest height: the
    // planted foot on the ground whatever this character's leg length.
    this.fk(_hips.copy(cap.hips));
    const low = Math.min((this.P[at('foot.L')] as Vector3).y, (this.P[at('foot.R')] as Vector3).y);
    const dy = this.ankleY - low;
    for (const p of this.P) p.y += dy;
    this.matrices(out);
  }

  /** On a bistro chair (seat 0.46 m), feet on the ground, forearms toward the table. */
  seated(headYaw: number, out: Matrix4[]): void {
    const lean = -0.08;
    _q.setFromAxisAngle(X, lean);
    for (const b of ['pelvis', 'spine', 'chest', 'neck', 'head'] as const) (this.R[at(b)] as Quaternion).copy(_q);
    this.turnHead(headYaw);
    _hips.set(0, 0.54, 0.04);
    for (const s of ['L', 'R'] as const) {
      const sx = s === 'R' ? 1 : -1;
      this.restLike(`clavicle.${s}`, 'chest');
      // Thighs forward on the seat, shins down to the feet, the feet flat.
      this.aim(`thigh.${s}`, _d.set(sx * 0.02, -0.07, -1));
      this.aim(`shin.${s}`, _d.set(sx * 0.01, -1, -0.12));
      (this.R[at(`foot.${s}`)] as Quaternion).identity();
      (this.R[at(`toe.${s}`)] as Quaternion).identity();
      // Elbows by the sides, forearms forward and in toward the table's edge.
      this.aim(`upperArm.${s}`, _d.set(sx * 0.12, -0.9, -0.3));
      this.aim(`forearm.${s}`, _d.set(-sx * 0.1, 0.06, -1));
      this.aim(`hand.${s}`, _d.set(-sx * 0.1, 0, -1));
    }
    this.fk(_hips);
    this.matrices(out);
  }

  /**
   * On a bicycle (saddle 0.95 m, bars 1.0 m up and 0.47 m ahead, cranks 17 cm round a bracket 0.3 m up):
   * the back leaning forward, the feet on the pedals and the hands on the grips by two-bone IK.
   */
  riding(crankRad: number, out: Matrix4[]): void {
    _q.setFromAxisAngle(X, -0.45);
    for (const b of ['spine', 'chest'] as const) (this.R[at(b)] as Quaternion).copy(_q);
    (this.R[at('pelvis')] as Quaternion).setFromAxisAngle(X, -0.22);
    // The head up again, looking down the road.
    (this.R[at('neck')] as Quaternion).setFromAxisAngle(X, -0.15);
    (this.R[at('head')] as Quaternion).setFromAxisAngle(X, 0.05);
    for (const s of ['L', 'R'] as const) {
      this.restLike(`clavicle.${s}`, 'chest');
      for (const b of [`upperArm.${s}`, `forearm.${s}`, `hand.${s}`, `thigh.${s}`, `shin.${s}`] as const) this.restLike(b, 'chest');
      (this.R[at(`foot.${s}`)] as Quaternion).identity();
      (this.R[at(`toe.${s}`)] as Quaternion).identity();
    }
    _hips.set(0, 1.02, 0.2);
    // First pass: where the hips and shoulders are with this trunk; then the limbs by IK; then again.
    this.fk(_hips);
    for (const s of ['L', 'R'] as const) {
      const sx = s === 'R' ? 1 : -1;
      const crank = crankRad + (s === 'R' ? 0 : Math.PI);
      _foot.set(sx * 0.11, 0.3 + 0.17 * Math.cos(crank) + this.ankleY * 0.6, -0.17 * Math.sin(crank));
      solveTwoBone(this.P[at(`thigh.${s}`)] as Vector3, _foot, this.thigh, this.shin, _pole.set(sx * 0.1, 0.2, -1), _mid, _end);
      this.aim(`thigh.${s}`, _d.subVectors(_mid, this.P[at(`thigh.${s}`)] as Vector3));
      this.aim(`shin.${s}`, _d.subVectors(_end, _mid));
      _hand.set(sx * 0.25, 1.0, -0.47);
      solveTwoBone(this.P[at(`upperArm.${s}`)] as Vector3, _hand, this.upperArm, this.forearm, _pole.set(sx * 0.6, -1, 0.2), _mid, _end);
      this.aim(`upperArm.${s}`, _d.subVectors(_mid, this.P[at(`upperArm.${s}`)] as Vector3));
      this.aim(`forearm.${s}`, _d.subVectors(_end, _mid));
      this.aim(`hand.${s}`, _d.subVectors(_end, _mid));
    }
    this.fk(_hips);
    this.matrices(out);
  }

  /** The rest pose's height of the hips (for a person standing still with no capture yet). */
  get restHipY(): number {
    return this.hipY;
  }

  private turnHead(yaw: number): void {
    if (yaw === 0) return;
    _q.setFromAxisAngle(Y, yaw * 0.35);
    (this.R[at('neck')] as Quaternion).premultiply(_q);
    _q.setFromAxisAngle(Y, yaw * 0.65);
    (this.R[at('head')] as Quaternion).premultiply(_q);
  }

  /** The bone turned so its rest direction points along `dir` (world), the shortest way. */
  private aim(bone: FullBone, dir: Vector3): void {
    const i = at(bone);
    const d = this.restDir[i];
    const R = this.R[i] as Quaternion;
    if (!d || dir.lengthSq() < 1e-10) R.identity();
    else R.setFromUnitVectors(d, _n.copy(dir).normalize());
  }

  /** The bone keeps its rest orientation relative to `relative` (carried along by it). */
  private restLike(bone: FullBone, relative: FullBone): void {
    (this.R[at(bone)] as Quaternion).copy(this.R[at(relative)] as Quaternion);
  }

  /** Forward kinematics: posed joints from the pelvis at `hips` and the bones' world rotations. */
  private fk(hips: Vector3): void {
    SPECS.forEach((_, i) => {
      const p = this.parent[i] as number;
      const P = this.P[i] as Vector3;
      if (p < 0) P.copy(hips);
      else P.subVectors(this.rest[i] as Vector3, this.rest[p] as Vector3).applyQuaternion(this.R[p] as Quaternion).add(this.P[p] as Vector3);
    });
  }

  /** Skin matrices: T(posed joint) · R · T(−rest joint), in the actor's frame. */
  private matrices(out: Matrix4[]): void {
    SPECS.forEach((_, i) => {
      const R = this.R[i] as Quaternion;
      const m = out[i] as Matrix4;
      m.makeRotationFromQuaternion(R);
      _t.copy(this.rest[i] as Vector3).applyQuaternion(R);
      m.setPosition((this.P[i] as Vector3).x - _t.x, (this.P[i] as Vector3).y - _t.y, (this.P[i] as Vector3).z - _t.z);
    });
  }
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _hips = new Vector3();
const _d = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _foot = new Vector3();
const _hand = new Vector3();
const _pole = new Vector3();
const _mid = new Vector3();
const _end = new Vector3();
