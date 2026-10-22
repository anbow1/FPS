import { Matrix4, Vector3 } from 'three/webgpu';
import { ANKLE_Y, bindFrames, BONES, frame, HIP_Y, L_FOREARM, L_SHIN, L_THIGH, L_UPPER_ARM, SHOULDER_HALF, SPINE_M } from './body.ts';

// The measurements the posing needs (people.ts), for one body: limb lengths,
// where the shoulders, hips, neck and head sit off the root, and the bind
// frames the skin was weighted in. The procedural builds share one set
// (body.ts); a character made in Blender (tools/people) brings its own joints,
// so a tall man's stride and a short woman's reach are their own and the skin
// follows bones that sit where its joints are.

export interface Rig {
  thigh: number;
  shin: number;
  upperArm: number;
  forearm: number;
  /** Ankle height above the sole, m. */
  ankleY: number;
  /** Root (hip centre) to the shoulder line, along the spine. */
  spine: number;
  shoulderHalf: number;
  /** Root to the base of the neck, and the neck to the head joint. */
  neck: number;
  headUp: number;
  /** Hip joints off the root: half the spread, and how far below it. */
  hipHalf: number;
  hipDrop: number;
  /** Bind frames, one per bone (BONES), and their inverses. */
  bind: Matrix4[];
  unbind: Matrix4[];
  /** A character's own size: the crowd's random scale is not applied. */
  ownSize: boolean;
}

function finish(r: Omit<Rig, 'unbind'>): Rig {
  return { ...r, unbind: r.bind.map((m) => m.clone().invert()) };
}

/** The procedural builds' rig (body.ts). */
export const BODY_RIG: Rig = finish({
  thigh: L_THIGH,
  shin: L_SHIN,
  upperArm: L_UPPER_ARM,
  forearm: L_FOREARM,
  ankleY: ANKLE_Y,
  spine: SPINE_M - 0.06,
  shoulderHalf: SHOULDER_HALF,
  neck: SPINE_M + 0.1,
  headUp: 0.04,
  hipHalf: 0.095,
  hipDrop: 0.02,
  bind: bindFrames(),
  ownSize: false,
});

export type Joints = Record<string, [number, number, number]>;

/**
 * A character's rig from its joints (game frame: Y up, facing −Z, its right at +X; tools/people's .json).
 * Bind frames follow body.ts's convention: each segment's origin at its joint, +Y back toward its parent
 * (up the limb), −Z toward the front; the pelvis and torso at the root, the head at the head joint.
 */
export function rigFromJoints(j: Joints): Rig {
  const v = (name: string): Vector3 => {
    const p = j[name];
    if (!p) throw new Error(`character joints lack '${name}'`);
    return new Vector3(p[0], p[1], p[2]);
  };
  const side = (s: 0 | 1): string => (s === 1 ? 'R' : 'L');
  const hip = v('hip');
  const fwd = new Vector3(0, 0, -1);
  const up = new Vector3(0, 1, 0);
  const dir = (from: Vector3, to: Vector3): Vector3 => new Vector3().subVectors(from, to).normalize();
  const bind = BONES.map(({ seg, side: s }) => {
    const m = new Matrix4();
    const S = side(s);
    switch (seg) {
      case 'pelvis':
      case 'torso':
        return frame(m, hip, up, fwd);
      case 'head':
        return frame(m, v('head'), up, fwd);
      case 'upperArm':
        return frame(m, v(`shoulder.${S}`), dir(v(`shoulder.${S}`), v(`elbow.${S}`)), fwd);
      case 'forearm':
        return frame(m, v(`elbow.${S}`), dir(v(`elbow.${S}`), v(`wrist.${S}`)), fwd);
      case 'hand':
        return frame(m, v(`wrist.${S}`), dir(v(`elbow.${S}`), v(`wrist.${S}`)), fwd);
      case 'thigh':
        return frame(m, v(`hip.${S}`), dir(v(`hip.${S}`), v(`knee.${S}`)), fwd);
      case 'shin':
        return frame(m, v(`knee.${S}`), dir(v(`knee.${S}`), v(`ankle.${S}`)), fwd);
      case 'shoe':
        return frame(m, v(`ankle.${S}`), up, fwd);
    }
  });
  const mean = (a: string, b: string): Vector3 => v(a).add(v(b)).multiplyScalar(0.5);
  const len = (a: string, b: string): number => (v(`${a}.L`).distanceTo(v(`${b}.L`)) + v(`${a}.R`).distanceTo(v(`${b}.R`))) / 2;
  const shoulders = mean('shoulder.L', 'shoulder.R');
  const hips = mean('hip.L', 'hip.R');
  return finish({
    thigh: len('hip', 'knee'),
    shin: len('knee', 'ankle'),
    upperArm: len('shoulder', 'elbow'),
    forearm: len('elbow', 'wrist'),
    ankleY: (v('ankle.L').y + v('ankle.R').y) / 2,
    spine: shoulders.y - hip.y,
    shoulderHalf: Math.abs(v('shoulder.R').x - v('shoulder.L').x) / 2,
    neck: v('neck').y - hip.y,
    headUp: v('head').y - v('neck').y,
    hipHalf: Math.abs(v('hip.R').x - v('hip.L').x) / 2,
    hipDrop: hip.y - hips.y,
    bind,
    ownSize: true,
  });
}

/** The root's height in a rig's bind pose (the procedural builds' is HIP_Y). */
export const bindHipY = (r: Rig): number => (r.bind[0] as Matrix4).elements[13] ?? HIP_Y;
