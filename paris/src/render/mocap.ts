import { Quaternion, Vector3 } from 'three/webgpu';

// Motion-captured movement (from Field Line): a real walk and run, from the
// CMU database (assets/mocap/LICENSE.md), baked offline onto one skeleton (trial 07_01's T-pose) at 30 fps. Here the clips are read,
// sampled between frames, blended, and run through forward kinematics to give
// every bone its world rotation relative to the T-pose — the rotation that
// turns a body part from the T-pose to the captured pose, whatever the body's
// own proportions (life/people.ts applies it to its own segments and lengths).
//
// clip.bin: u32 'MOC1', u16 bones, u16 frames, f32 fps, f32 speed (m/s of the
// stripped travel; 0 for one-shots), f32 hips[3·frames] (m), i16 quat[4·bones·frames]
// (local rotations ×32767, in skeleton.json's bone order).
// The capture faces +Z with its left on +X; the game's actors face −Z with their
// right on +X: a half turn about Y between the two (toActor).

export type ClipId = 'walk' | 'run';

interface Clip {
  frames: number;
  fps: number;
  /** Ground speed of a cycle, m/s (0 for a one-shot). */
  speed: number;
  hips: Float32Array;
  quats: Float32Array;
}

interface Skeleton {
  names: string[];
  parent: Int16Array;
  offset: Float32Array;
  /** World rotation of each bone in the T-pose, inverted. */
  unTpose: Quaternion[];
}

const URLS: Record<ClipId, string> = {
  walk: new URL('../assets/mocap/walk.bin', import.meta.url).href,
  run: new URL('../assets/mocap/run.bin', import.meta.url).href,
};
const SKELETON_URL = new URL('../assets/mocap/skeleton.json', import.meta.url).href;

const clips = new Map<ClipId, Clip>();
let skeleton: Skeleton | null = null;

interface SkeletonJson {
  bones: { name: string; parent: number; offset: [number, number, number]; q: [number, number, number, number] }[];
}

function parseClip(buf: ArrayBuffer, bones: number): Clip {
  const head = new DataView(buf, 0, 16);
  if (head.getUint32(0, true) !== 0x31434f4d) throw new Error('not a mocap clip');
  const nb = head.getUint16(4, true);
  const frames = head.getUint16(6, true);
  if (nb !== bones) throw new Error(`mocap clip has ${nb} bones, the skeleton ${bones}`);
  const hips = new Float32Array(buf.slice(16, 16 + frames * 12));
  const raw = new Int16Array(buf.slice(16 + frames * 12, 16 + frames * 12 + frames * nb * 8));
  const quats = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) quats[i] = (raw[i] as number) / 32767;
  return { frames, fps: head.getFloat32(8, true), speed: head.getFloat32(12, true), hips, quats };
}

/** Loads the skeleton and every clip; call once before the first frame. */
export async function loadMocap(): Promise<void> {
  if (skeleton) return;
  const json = (await (await fetch(SKELETON_URL)).json()) as SkeletonJson;
  const n = json.bones.length;
  const parent = new Int16Array(n);
  const offset = new Float32Array(n * 3);
  const local = json.bones.map((b, i) => {
    parent[i] = b.parent;
    offset.set(b.offset, i * 3);
    return new Quaternion(...b.q);
  });
  const world: Quaternion[] = [];
  local.forEach((q, i) => {
    const p = parent[i] as number;
    world.push(p < 0 ? q.clone() : (world[p] as Quaternion).clone().multiply(q));
  });
  const sk = { names: json.bones.map((b) => b.name), parent, offset, unTpose: world.map((q) => q.clone().invert()) };
  const entries = await Promise.all((Object.keys(URLS) as ClipId[]).map(async (id) => [id, parseClip(await (await fetch(URLS[id])).arrayBuffer(), n)] as const));
  for (const [id, c] of entries) clips.set(id, c);
  skeleton = sk;
}

export function mocapReady(): boolean {
  return skeleton !== null;
}

/** Seconds one cycle (or the one-shot) lasts. */
export function clipDuration(id: ClipId): number {
  const c = clips.get(id);
  return c ? c.frames / c.fps : 1;
}

/** Ground speed of one cycle of a gait clip, m/s. */
export function clipSpeed(id: ClipId): number {
  return clips.get(id)?.speed ?? 1;
}

export function boneIndex(name: string): number {
  return skeleton ? skeleton.names.indexOf(name) : -1;
}

/** A sampled pose: local rotations and the hips' position, in the capture's frame. */
export class MocapPose {
  readonly local: Quaternion[];
  readonly hips = new Vector3();
  /** World rotation relative to the T-pose, per bone, turned into the actor's frame (after `solve`). */
  readonly delta: Quaternion[];

  constructor() {
    const n = skeleton?.names.length ?? 0;
    this.local = Array.from({ length: n }, () => new Quaternion());
    this.delta = Array.from({ length: n }, () => new Quaternion());
  }

  /** Clip `id` at `t` seconds: looped for gaits, held at the last frame for one-shots. */
  sample(id: ClipId, t: number): this {
    const c = clips.get(id);
    if (!c || !skeleton) return this;
    const n = skeleton.names.length;
    const loop = c.speed > 0;
    let f = t * c.fps;
    if (loop) f = ((f % c.frames) + c.frames) % c.frames;
    else f = Math.min(Math.max(0, f), c.frames - 1);
    const f0 = Math.floor(f);
    const f1 = loop ? (f0 + 1) % c.frames : Math.min(c.frames - 1, f0 + 1);
    const w = f - f0;
    for (let b = 0; b < n; b++) {
      const q = this.local[b] as Quaternion;
      const o0 = (f0 * n + b) * 4;
      const o1 = (f1 * n + b) * 4;
      _qa.set(c.quats[o0] as number, c.quats[o0 + 1] as number, c.quats[o0 + 2] as number, c.quats[o0 + 3] as number);
      _qb.set(c.quats[o1] as number, c.quats[o1 + 1] as number, c.quats[o1 + 2] as number, c.quats[o1 + 3] as number);
      q.slerpQuaternions(_qa, _qb, w).normalize();
    }
    this.hips.set(lerp(c.hips[f0 * 3] as number, c.hips[f1 * 3] as number, w), lerp(c.hips[f0 * 3 + 1] as number, c.hips[f1 * 3 + 1] as number, w), lerp(c.hips[f0 * 3 + 2] as number, c.hips[f1 * 3 + 2] as number, w));
    return this;
  }

  /** This pose blended toward `other` by `w` (both sampled). */
  blend(other: MocapPose, w: number): this {
    this.local.forEach((q, i) => q.slerp(other.local[i] as Quaternion, w));
    this.hips.lerp(other.hips, w);
    return this;
  }

  /**
   * Forward kinematics: each bone's world rotation relative to the T-pose, turned into the actor's frame
   * (a half turn about Y). The hips' position turns with it.
   */
  solve(): this {
    if (!skeleton) return this;
    const n = skeleton.names.length;
    for (let b = 0; b < n; b++) {
      const p = skeleton.parent[b] as number;
      const w = _world[b] ?? (_world[b] = new Quaternion());
      w.copy(this.local[b] as Quaternion);
      if (p >= 0) w.premultiply(_world[p] as Quaternion);
      (this.delta[b] as Quaternion).copy(w).multiply(skeleton.unTpose[b] as Quaternion).premultiply(TO_ACTOR).multiply(FROM_ACTOR);
    }
    this.hips.set(-this.hips.x, this.hips.y, -this.hips.z);
    return this;
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const _qa = new Quaternion();
const _qb = new Quaternion();
const _world: Quaternion[] = [];
const TO_ACTOR = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
const FROM_ACTOR = TO_ACTOR.clone().invert();
