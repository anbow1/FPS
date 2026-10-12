import { attribute, float, mix, mx_noise_float, positionLocal, step, vec3 } from 'three/tsl';
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshPhysicalNodeMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { Soldier } from '../game/soldier.ts';
import { merge } from './meshkit.ts';
import { buildRifle } from './weaponModels.ts';

// Enemy infantry: an articulated figure of rigid segments (pelvis, torso,
// head, upper arms, forearms, hands, thighs, shins, boots and the rifle),
// each one InstancedMesh shared by every soldier, posed per frame:
//
//   - the stance sets the hips and the line of the spine (standing, kneeling
//     on one knee, prone on the elbows) to match the hitbox layout the bullets
//     test against (game/actor.ts), so what you see is what you can hit;
//   - the rifle sits in the right shoulder pocket along the aim (lowered on
//     patrol), and both arms reach its grips by two-bone IK, elbows out;
//   - the legs reach planted feet by two-bone IK: a stride with ground speed,
//     knees forward, the swinging foot lifted;
//   - the dead fall forward about their feet and lie prone. No gore.
//
// Kit: plate carrier with magazine pouches and a radio, assault pack, battle
// belt, high-cut helmet with ear defenders and a night-vision mount, knee and
// elbow pads, gloves, boots. One material for all of it: per-vertex colour and
// a kind (0 hard, 1 plain fabric, 2 camouflage fabric) that sets roughness,
// sheen and a procedural four-colour camouflage. Sheet values: uniform
// #5A5E48 rough 0.9 sheen 0.4, NATO green #4B5340, khaki #5C5B3E, rubber.

const MAX_SOLDIERS = 96;

const L_UPPER_ARM = 0.29;
const L_FOREARM = 0.26;
const L_THIGH = 0.43;
const L_SHIN = 0.43;
const ANKLE_Y = 0.09;
const SPINE_M = 0.52;
const SHOULDER_HALF = 0.19;

type Kind = 0 | 1 | 2;
const HARD: Kind = 0;
const PLAIN: Kind = 1;
const CAMO: Kind = 2;

type Segment = 'pelvis' | 'torso' | 'head' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'boot' | 'rifle';
const PAIRED: Record<Segment, boolean> = { pelvis: false, torso: false, head: false, upperArm: true, forearm: true, hand: true, thigh: true, shin: true, boot: true, rifle: false };

export class ActorView {
  readonly group = new Group();
  private readonly meshes = new Map<Segment, InstancedMesh>();
  private readonly prevFeet: Vector3[] = [];
  private readonly currFeet: Vector3[] = [];
  private readonly walkPhase: number[] = [];

  constructor() {
    this.group.name = 'actors';
    const material = soldierMaterial();
    const geos = segmentGeometries();
    for (const seg of Object.keys(PAIRED) as Segment[]) {
      const mesh = new InstancedMesh(geos[seg], material, MAX_SOLDIERS * (PAIRED[seg] ? 2 : 1));
      mesh.name = `soldier-${seg}`;
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // instances move every frame; bounds would go stale
      this.meshes.set(seg, mesh);
      this.group.add(mesh);
    }
    for (let i = 0; i < MAX_SOLDIERS; i++) {
      this.prevFeet.push(new Vector3());
      this.currFeet.push(new Vector3());
      this.walkPhase.push(0);
    }
  }

  /** Call once before each logic step, to keep the previous positions for interpolation. */
  beforeStep(soldiers: readonly Soldier[]): void {
    const n = Math.min(soldiers.length, MAX_SOLDIERS);
    for (let i = 0; i < n; i++) {
      const s = soldiers[i] as Soldier;
      (this.prevFeet[i] as Vector3).set(s.body.position.x, s.body.position.y, s.body.position.z);
    }
  }

  update(soldiers: readonly Soldier[], alpha: number, frameSeconds: number): void {
    const n = Math.min(soldiers.length, MAX_SOLDIERS);
    for (const [seg, mesh] of this.meshes) mesh.count = n * (PAIRED[seg] ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const s = soldiers[i] as Soldier;
      const prev = this.prevFeet[i] as Vector3;
      const curr = (this.currFeet[i] as Vector3).set(s.body.position.x, s.body.position.y, s.body.position.z);
      _feet.copy(prev).lerp(curr, alpha);
      const moving = s.alive && s.stance !== 'prone';
      if (moving) this.walkPhase[i] = ((this.walkPhase[i] as number) + s.speedMs * frameSeconds * (s.stance === 'crouch' ? 4.2 : 3.2)) % (Math.PI * 2);
      _actor.makeRotationY(s.yawRad).setPosition(_feet);
      this.pose(s, i, this.walkPhase[i] as number);
    }
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- posing (actor frame: −Z forward, +X right)

  private pose(s: Soldier, i: number, phase: number): void {
    const stance = s.alive ? s.stance : 'stand';
    const stride = s.alive && stance !== 'prone' ? Math.min(1, s.speedMs / 3) * (stance === 'crouch' ? 0.2 : 0.34) : 0;
    // Hips and spine for the stance (hitbox layout: chest 1.30 / 0.82 / 0.18 m, head 1.62 / 1.10 / 0.30 m).
    if (stance === 'stand') {
      _hip.set(0, 0.93 - stride * 0.06 * Math.abs(Math.sin(phase)), 0);
      _up.set(0, 1, -0.09 - stride * 0.25).normalize();
    } else if (stance === 'crouch') {
      _hip.set(0, 0.5, 0.03);
      _up.set(0, 1, -0.32).normalize();
    } else {
      _hip.set(0, 0.17, 0.08);
      _up.set(0, 0.1, -1).normalize();
    }
    _right.set(1, 0, 0);
    _front.crossVectors(_up, _right).normalize();
    // Aim: the head and the rifle follow it; on patrol the rifle hangs at low ready.
    const pitch = s.alive ? s.pitchRad : 0;
    _aim.set(0, Math.sin(pitch), -Math.cos(pitch));
    const lowReady = s.alive && s.state === 'patrol';
    if (lowReady) _rifleDir.set(0.25, -0.62, -0.75).normalize();
    else _rifleDir.copy(_aim);

    // Fall: the whole pose tips forward about the feet over ~0.7 s, gathering speed, and lies prone.
    _fall.identity();
    if (!s.alive) {
      const t = Math.min(1, s.deathSeconds / 0.7);
      const a = t * t * (Math.PI / 2 - 0.08);
      _fall.makeTranslation(0, 0.1 * t, 0).multiply(_rot.makeRotationX(-a));
    }

    // Torso and pelvis. Holding a rifle the torso is bladed: turned ~35° to bring the left shoulder
    // forward, so the support hand reaches the handguard (less at low ready, none prone).
    this.place('pelvis', i, 0, _hip, _up, _front);
    const blade = stance === 'prone' ? 0 : lowReady ? 0.25 : 0.6;
    _tRight.copy(_right).applyAxisAngle(_up, blade);
    _tFront.crossVectors(_up, _tRight).normalize();
    this.place('torso', i, 0, _hip, _up, _tFront);
    _neck.copy(_hip).addScaledVector(_up, SPINE_M);
    _headUp.set(0, 1, 0).addScaledVector(_aim, -_aim.y).normalize();
    _head.copy(_neck).addScaledVector(_up, 0.1).addScaledVector(_headUp, 0.04);
    this.place('head', i, 0, _head, _headUp, _aim);

    // Rifle: butt in the right shoulder pocket, along the aim.
    _shoulderR.copy(_hip).addScaledVector(_up, SPINE_M - 0.06).addScaledVector(_tRight, SHOULDER_HALF);
    _shoulderL.copy(_hip).addScaledVector(_up, SPINE_M - 0.06).addScaledVector(_tRight, -SHOULDER_HALF);
    _rifleUp.set(0, 1, 0).addScaledVector(_rifleDir, -_rifleDir.y).normalize();
    // Rifle frame: −Z = rifleDir. Butt plate at local (0, −0.107, +0.44).
    _butt.copy(_shoulderR).addScaledVector(_tFront, 0.04).addScaledVector(_tRight, -0.06);
    if (lowReady) _butt.addScaledVector(_up, -0.12).addScaledVector(_front, -0.06);
    _rifleO.copy(_butt).addScaledVector(_rifleUp, 0.107).addScaledVector(_rifleDir, 0.44);
    this.place('rifle', i, 0, _rifleO, _rifleUp, _rifleDir);
    // Grips in the rifle frame: pistol grip (0, −0.18, +0.18); the support hand under the handguard
    // (0, −0.12, −0.15), or at the magazine well when prone on the elbows.
    _gripR.copy(_rifleO).addScaledVector(_rifleUp, -0.17).addScaledVector(_rifleDir, -0.18);
    _gripL.copy(_rifleO).addScaledVector(_rifleUp, -0.12).addScaledVector(_rifleDir, stance === 'prone' ? 0.02 : 0.15);
    // Arms: elbows out and down.
    _pole.copy(_tRight).multiplyScalar(0.8).addScaledVector(_up, -1).addScaledVector(_tFront, -0.3);
    this.limb('upperArm', 'forearm', i, 1, _shoulderR, _gripR, L_UPPER_ARM, L_FOREARM, _pole);
    this.placeHand(i, 1, _gripR, _rifleDir);
    _pole.copy(_tRight).multiplyScalar(-0.9).addScaledVector(_up, -1);
    this.limb('upperArm', 'forearm', i, 0, _shoulderL, _gripL, L_UPPER_ARM, L_FOREARM, _pole);
    this.placeHand(i, 0, _gripL, _rifleDir);

    // Legs.
    for (const side of [0, 1] as const) {
      const sx = side === 1 ? 1 : -1;
      _hipJoint.copy(_hip).addScaledVector(_right, sx * 0.1).addScaledVector(_up, -0.02);
      _bootFront.set(0, 0, -1);
      _bootUp.set(0, 1, 0);
      if (stance === 'prone') {
        _foot.set(sx * 0.17, 0.1, 0.95);
        _pole.set(0, -1, 0.2);
        _bootFront.set(0, -1, 0.3).normalize();
        _bootUp.set(0, 0.3, 1).normalize();
      } else if (stance === 'crouch') {
        if (side === 0) {
          _foot.set(-0.14, ANKLE_Y, -0.34);
          _pole.set(0, 0.2, -1);
        } else {
          // Kneeling on the right knee, the boot on its toes.
          _foot.set(0.14, 0.13, 0.4);
          _pole.set(0, -1, -0.5);
          _bootFront.set(0, -0.6, -1).normalize();
          _bootUp.set(0, 1, -0.6).normalize();
        }
      } else {
        // Stride: the feet swing opposite each other; the forward-swinging foot lifts.
        const swing = Math.sin(phase + (side === 0 ? 0 : Math.PI));
        const lift = Math.max(0, Math.cos(phase + (side === 0 ? 0 : Math.PI))) * stride * 0.4;
        _foot.set(sx * 0.11, ANKLE_Y + lift, -swing * stride);
        _pole.set(0, 0.1, -1);
        _bootFront.set(0, lift * 0.8, -1).normalize();
      }
      this.limb('thigh', 'shin', i, side, _hipJoint, _foot, L_THIGH, L_SHIN, _pole);
      this.place('boot', i, side, _end, _bootUp, _bootFront);
    }
  }

  /** Two segments from `root` toward `target`, bent toward `pole`. Leaves the reached end in `_end`. */
  private limb(upper: Segment, lower: Segment, i: number, side: 0 | 1, root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3): void {
    solveTwoBone(root, target, l1, l2, pole, _mid, _end);
    _dir.subVectors(_mid, root).normalize();
    _tmpUp.copy(_dir).negate();
    this.place(upper, i, side, root, _tmpUp, pole);
    _dir.subVectors(_end, _mid).normalize();
    _tmpUp.copy(_dir).negate();
    this.place(lower, i, side, _mid, _tmpUp, pole);
  }

  private placeHand(i: number, side: 0 | 1, at: Vector3, along: Vector3): void {
    _dir.subVectors(at, _mid).normalize();
    _tmpUp.copy(_dir).negate();
    this.place('hand', i, side, _end, _tmpUp, along);
  }

  /** One segment instance: origin, its local +Y and the direction its local −Z (front) should face. */
  private place(seg: Segment, i: number, side: 0 | 1, origin: Vector3, up: Vector3, front: Vector3): void {
    const mesh = this.meshes.get(seg);
    if (!mesh) return;
    _y.copy(up).normalize();
    _z.copy(front).addScaledVector(_y, -front.dot(_y));
    if (_z.lengthSq() < 1e-8) _z.set(0, 0, -1).addScaledVector(_y, _y.z);
    _z.normalize().negate();
    _x.crossVectors(_y, _z);
    // No mirroring for the left side: a mirrored instance matrix flips the winding, and instanced
    // draws cull per mesh, not per instance. Paired segments are built symmetric instead.
    _m.makeBasis(_x, _y, _z).setPosition(origin);
    _m.premultiply(_fall).premultiply(_actor);
    mesh.setMatrixAt(PAIRED[seg] ? i * 2 + side : i, _m);
  }
}

/**
 * Two-bone IK: the joint between `root` and `target` for bones `l1` and `l2`, bent toward `pole`.
 * Out of reach, the limb straightens toward the target. Writes the joint to `mid` and the reached end to `end`.
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

// ------------------------------------------------------------------ material

function soldierMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'soldier', metalness: 0, sheenRoughness: 0.8 });
  const tint = attribute('tint', 'vec3');
  const kind = attribute('kind', 'float');
  const camo = step(1.5, kind);
  const fabric = step(0.5, kind);
  // Four-colour woodland-style blotches in each segment's own space (sheet uniform #5A5E48 as the base).
  const p = positionLocal.mul(6.5);
  const n1 = mx_noise_float(p);
  const n2 = mx_noise_float(p.mul(1.7).add(vec3(3.1, 7.7, 1.3)));
  const base = vec3(0.1, 0.11, 0.065); // #5A5E48 in linear
  const olive = vec3(0.13, 0.12, 0.07);
  const dark = vec3(0.045, 0.05, 0.035);
  const sand = vec3(0.19, 0.17, 0.11);
  const pattern = mix(mix(mix(base, olive, step(0.18, n1)), dark, step(0.32, n2)), sand, step(0.42, n1.mul(-1)));
  const colour = mix(tint, pattern, camo);
  m.colorNode = colour;
  m.roughnessNode = mix(float(0.6), float(0.9), fabric);
  // Sheen colour × intensity (three's sheenNode is the product): cloth only.
  m.sheenNode = colour.mul(fabric.mul(0.4));
  return m;
}

// ------------------------------------------------------------------ geometry (each segment in its own frame)

function linear(hex: number): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

/** Tags a geometry with its colour and kind for the shared material. */
function tag(g: BufferGeometry, hex: number, kind: Kind): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  const count = n.getAttribute('position').count;
  const [r, gr, b] = linear(hex);
  const tint = new Float32Array(count * 3);
  const k = new Float32Array(count).fill(kind);
  for (let i = 0; i < count; i++) tint.set([r, gr, b], i * 3);
  n.setAttribute('tint', new BufferAttribute(tint, 3));
  n.setAttribute('kind', new BufferAttribute(k, 1));
  return n;
}

function joined(parts: BufferGeometry[], name: string): BufferGeometry {
  // meshkit.merge keeps only position/normal/uv; carry the tags across by merging them here.
  const tints: number[] = [];
  const kinds: number[] = [];
  for (const p of parts) {
    tints.push(...(p.getAttribute('tint').array as Float32Array));
    kinds.push(...(p.getAttribute('kind').array as Float32Array));
  }
  const g = merge(parts, name);
  g.setAttribute('tint', new BufferAttribute(new Float32Array(tints), 3));
  g.setAttribute('kind', new BufferAttribute(new Float32Array(kinds), 1));
  return g;
}

const C = {
  uniform: 0x5a5e48,
  armour: 0x4b5340,
  khaki: 0x5c5b3e,
  webbing: 0x50503a,
  balaclava: 0x3c3c3e,
  rubber: 0x2b2b2d,
  boot: 0x3a332b,
  glove: 0x3e3328,
  lens: 0x1a1b1d,
  rifle: 0x2e2f31,
} as const;

const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry => new BoxGeometry(sx, sy, sz).translate(x, y, z);

/** A tapered limb along −Y from the origin, rounded at both ends so joints never show a gap. */
function limbGeo(length: number, r0: number, r1: number): BufferGeometry {
  return merge([new CylinderGeometry(r0, r1, length, 12, 1, true).translate(0, -length / 2, 0), new SphereGeometry(r0, 12, 8), new SphereGeometry(r1, 12, 8).translate(0, -length, 0)], 'limb');
}

function segmentGeometries(): Record<Segment, BufferGeometry> {
  const pelvis = joined(
    [
      tag(new SphereGeometry(1, 16, 10).scale(0.17, 0.13, 0.12).translate(0, -0.02, 0), C.uniform, CAMO),
      tag(box(0.36, 0.06, 0.26, 0, 0.06, 0), C.webbing, PLAIN), // battle belt
      tag(box(0.09, 0.1, 0.05, -0.16, 0.03, -0.06), C.khaki, PLAIN), // pouches on the belt
      tag(box(0.09, 0.1, 0.05, 0.16, 0.03, -0.06), C.khaki, PLAIN),
      tag(box(0.14, 0.09, 0.06, 0, 0.04, 0.14), C.khaki, PLAIN), // dump pouch
    ],
    'pelvis',
  );
  const torso = joined(
    [
      tag(new LatheGeometry([new Vector2(0.001, 0), new Vector2(0.15, 0.02), new Vector2(0.155, 0.2), new Vector2(0.19, 0.38), new Vector2(0.17, 0.48), new Vector2(0.06, 0.52)], 14).scale(1, 1, 0.62), C.uniform, CAMO),
      tag(new SphereGeometry(0.065, 10, 8).translate(-SHOULDER_HALF, SPINE_M - 0.06, 0), C.uniform, CAMO),
      tag(new SphereGeometry(0.065, 10, 8).translate(SHOULDER_HALF, SPINE_M - 0.06, 0), C.uniform, CAMO),
      // Plate carrier: front and back plates, cummerbund, shoulder straps.
      tag(box(0.29, 0.31, 0.05, 0, 0.3, -0.105), C.armour, PLAIN),
      tag(box(0.29, 0.33, 0.05, 0, 0.31, 0.105), C.armour, PLAIN),
      tag(box(0.35, 0.16, 0.2, 0, 0.2, 0), C.armour, PLAIN),
      tag(box(0.06, 0.03, 0.24, -0.1, 0.47, 0), C.armour, PLAIN),
      tag(box(0.06, 0.03, 0.24, 0.1, 0.47, 0), C.armour, PLAIN),
      // Three rifle magazine pouches and an admin pouch on the front, a radio on the back.
      tag(box(0.075, 0.1, 0.04, -0.085, 0.19, -0.145), C.khaki, PLAIN),
      tag(box(0.075, 0.1, 0.04, 0, 0.19, -0.145), C.khaki, PLAIN),
      tag(box(0.075, 0.1, 0.04, 0.085, 0.19, -0.145), C.khaki, PLAIN),
      tag(box(0.17, 0.08, 0.03, 0, 0.34, -0.14), C.khaki, PLAIN),
      // Assault pack.
      tag(box(0.27, 0.33, 0.13, 0, 0.27, 0.19), C.khaki, PLAIN),
      tag(box(0.23, 0.1, 0.04, 0, 0.18, 0.27), C.webbing, PLAIN),
      tag(box(0.06, 0.12, 0.05, -0.15, 0.4, 0.15), C.rubber, HARD), // radio
      tag(new CylinderGeometry(0.004, 0.004, 0.3, 5).translate(-0.17, 0.6, 0.16), C.rubber, HARD), // antenna
      tag(new CylinderGeometry(0.06, 0.07, 0.1, 10).translate(0, 0.53, 0), C.balaclava, PLAIN), // neck
    ],
    'torso',
  );
  const helmet = new SphereGeometry(0.127, 18, 9, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(0.95, 0.85, 1.05).translate(0, 0.02, 0.005);
  const head = joined(
    [
      tag(new SphereGeometry(0.1, 14, 10).scale(0.82, 1.05, 0.95), C.balaclava, PLAIN),
      tag(helmet, C.khaki, HARD),
      // High cut over the ears: the shell's rim, side rails and the NVG mount on the front.
      tag(new CylinderGeometry(0.122, 0.124, 0.012, 18, 1, true).scale(0.95, 1, 1.05).translate(0, 0.022, 0.005), C.khaki, HARD),
      tag(box(0.01, 0.024, 0.1, -0.119, 0.035, 0.005), C.rubber, HARD),
      tag(box(0.01, 0.024, 0.1, 0.119, 0.035, 0.005), C.rubber, HARD),
      tag(box(0.05, 0.035, 0.024, 0, 0.075, -0.125), C.rubber, HARD),
      // Ear defenders, the band over the helmet's sides, protective glasses.
      tag(new CylinderGeometry(0.038, 0.038, 0.035, 12).rotateZ(Math.PI / 2).translate(-0.098, -0.02, 0.005), C.rubber, HARD),
      tag(new CylinderGeometry(0.038, 0.038, 0.035, 12).rotateZ(Math.PI / 2).translate(0.098, -0.02, 0.005), C.rubber, HARD),
      tag(box(0.15, 0.032, 0.03, 0, 0.012, -0.088), C.lens, HARD),
      tag(box(0.07, 0.01, 0.06, 0, -0.105, -0.02), C.webbing, PLAIN), // chin strap
    ],
    'head',
  );
  const upperArm = joined([tag(limbGeo(L_UPPER_ARM, 0.055, 0.045), C.uniform, CAMO)], 'upperArm');
  const forearm = joined([tag(limbGeo(L_FOREARM, 0.046, 0.034), C.uniform, CAMO), tag(new SphereGeometry(1, 10, 6).scale(0.045, 0.05, 0.03).translate(0, -0.015, -0.035), C.rubber, HARD), tag(new CylinderGeometry(0.038, 0.036, 0.04, 10).translate(0, -L_FOREARM + 0.01, 0), C.glove, HARD)], 'forearm');
  const hand = joined([tag(new SphereGeometry(1, 10, 8).scale(0.042, 0.055, 0.028).translate(0, -0.05, 0), C.glove, HARD), tag(new CapsuleGeometry(0.012, 0.03, 2, 6).translate(0, -0.05, -0.03), C.glove, HARD)], 'hand');
  // Cargo pockets on both sides: the left thigh is the same mesh as the right one.
  const thigh = joined([tag(limbGeo(L_THIGH, 0.078, 0.06), C.uniform, CAMO), tag(box(0.17, 0.12, 0.09, 0, -0.22, 0), C.uniform, CAMO)], 'thigh');
  const shin = joined(
    [
      tag(limbGeo(L_SHIN, 0.058, 0.045), C.uniform, CAMO),
      tag(new SphereGeometry(1, 12, 8).scale(0.055, 0.07, 0.035).translate(0, -0.035, -0.05), C.rubber, HARD), // knee pad
      tag(new CylinderGeometry(0.058, 0.062, 0.12, 12).translate(0, -L_SHIN + 0.05, 0), C.boot, HARD), // boot collar
    ],
    'shin',
  );
  const boot = joined(
    [
      tag(new CapsuleGeometry(0.05, 0.16, 4, 10).rotateX(Math.PI / 2).scale(1, 0.9, 1).translate(0, -0.035, -0.055), C.boot, HARD),
      tag(box(0.105, 0.025, 0.28, 0, -0.08, -0.055), C.rubber, HARD),
    ],
    'boot',
  );
  return { pelvis, torso, head, upperArm, forearm, hand, thigh, shin, boot, rifle: rifleGeometry() };
}

/** The player's carbine (weaponModels.ts) merged into one dark geometry, without its optic glass. */
function rifleGeometry(): BufferGeometry {
  const model = buildRifle();
  model.root.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  model.root.traverse((o) => {
    if (!(o instanceof Mesh) || o === model.dotLens || o.name === 'optic front') return;
    parts.push(tag(o.geometry.clone().applyMatrix4(o.matrixWorld), o.name === 'furniture' || o.name === 'magazine' ? 0x262628 : C.rifle, HARD));
  });
  return joined(parts, 'soldier rifle');
}

const _actor = new Matrix4();
const _fall = new Matrix4();
const _rot = new Matrix4();
const _m = new Matrix4();
const _feet = new Vector3();
const _hip = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _front = new Vector3();
const _tRight = new Vector3();
const _tFront = new Vector3();
const _aim = new Vector3();
const _rifleDir = new Vector3();
const _rifleUp = new Vector3();
const _rifleO = new Vector3();
const _butt = new Vector3();
const _neck = new Vector3();
const _head = new Vector3();
const _headUp = new Vector3();
const _shoulderL = new Vector3();
const _shoulderR = new Vector3();
const _gripL = new Vector3();
const _gripR = new Vector3();
const _pole = new Vector3();
const _hipJoint = new Vector3();
const _foot = new Vector3();
const _bootFront = new Vector3();
const _bootUp = new Vector3();
const _mid = new Vector3();
const _end = new Vector3();
const _dir = new Vector3();
const _tmpUp = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _ikU = new Vector3();
const _ikV = new Vector3();
