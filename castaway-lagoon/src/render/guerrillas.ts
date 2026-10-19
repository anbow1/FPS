import { attribute, float, floor, mix, mx_noise_float, positionGeometry, positionLocal, smoothstep, step, vec3 } from 'three/tsl';
import { BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, Color, CylinderGeometry, ExtrudeGeometry, Group, InstancedBufferAttribute, InstancedMesh, LatheGeometry, Matrix4, Mesh, MeshPhysicalNodeMaterial, type Node, Quaternion, Shape, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three/webgpu';
import type { Guerrilla } from '../game/guerrillas.ts';
import { coarseParts } from './gunkit.ts';
import { merge } from './meshkit.ts';
import { boneIndex, clipDuration, clipSpeed, MocapPose, mocapReady } from './mocap.ts';
import { BoneTexture, skinnedPosition } from './skinning.ts';
import { buildRifle } from './weaponModels.ts';

// The guerrillas: a body of segments (pelvis, torso, head, upper arms,
// forearms, hands, thighs, shins, boots) skinned as one mesh shared by every
// man, and the AK, posed per frame — after Field Line's soldiers
// (docs/graphics-playbook.md §6c, §6s), in irregulars' kit:
//
//   - walking and running as motion-captured (mocap.ts): the hips, spine and
//     legs from the capture, walk and run blended by speed, the cycle advanced
//     by ground speed so the feet do not slide; still, a stance with the feet
//     apart;
//   - down on one knee to shoot, built by hand; the AK in the right shoulder
//     along the aim (low ready on patrol), both hands on its grips by two-bone
//     IK, elbows out;
//   - the dead fall as captured, turning away from the shot as they go. No gore.
//
// Each segment is a bone (skinning.ts): the skin near a joint takes both
// bones, so a knee or an elbow bends as one sleeve instead of two capsules
// sliding through each other.
//
// Kit: faded tiger-stripe shirt, olive trousers, a khaki chest rig with three
// magazine pouches, a bandana or a boonie hat, a canvas bag, boots. One
// material: per-vertex colour and a kind (0 hard, 1 plain cloth, 2 patterned
// cloth) that sets roughness, sheen and the stripe pattern, a `shade` for the
// cloth's creases and the face's hollows, and `grime` for mud and dust.
//
// Bodies as Field Line builds them (its render/actors.ts): men in loose
// clothes lathed through measured profiles with the folds pressed in, not
// cylinders with balls at the joints. Here the face shows: brow, nose,
// cheekbones and jaw in the head, eyes in shadowed sockets, brows, and a
// week's stubble; sleeves rolled over bare, muscled forearms.

const MAX_MEN = 24;

const L_UPPER_ARM = 0.29;
const L_FOREARM = 0.26;
const L_THIGH = 0.43;
const L_SHIN = 0.43;
const ANKLE_Y = 0.09;
const SPINE_M = 0.52;
const SHOULDER_HALF = 0.19;

type Kind = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const HARD: Kind = 0;
const PLAIN: Kind = 1;
/** The shirt: tiger stripe, or the man's own plain colour (kitFor). */
const STRIPE: Kind = 2;
const TROUSERS: Kind = 3;
const HAT: Kind = 4;
const BANDANA: Kind = 5;
const SKIN: Kind = 6;

type Segment = 'pelvis' | 'torso' | 'head' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'boot' | 'rifle';
const PAIRED: Record<Segment, boolean> = { pelvis: false, torso: false, head: false, upperArm: true, forearm: true, hand: true, thigh: true, shin: true, boot: true, rifle: false };

/** The body's bones, one per segment and side, parents first: a man is one skinned mesh (skinning.ts). */
const BONES: readonly { seg: Exclude<Segment, 'rifle'>; side: 0 | 1; parent: number }[] = [
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
  { seg: 'boot', side: 0, parent: 10 },
  { seg: 'thigh', side: 1, parent: 0 },
  { seg: 'shin', side: 1, parent: 12 },
  { seg: 'boot', side: 1, parent: 13 },
];
const boneOf = (seg: Segment, side: 0 | 1): number => BONES.findIndex((b) => b.seg === seg && (PAIRED[seg] ? b.side === side : true));

export class GuerrillaView {
  readonly group = new Group();
  private readonly body: InstancedMesh;
  private readonly rifle: InstancedMesh;
  private readonly bones = new BoneTexture(BONES.length, MAX_MEN);
  /** Inverse bind matrix per bone: the segment's frame in the bind pose (bindFrames). */
  private readonly unbind: Matrix4[];
  /** Where each man (by id) is in his captured gait cycle, 0…1 (mocap.ts); 0 and ½ are the feet planted apart. */
  private readonly gait = new Map<number, number>();
  /** The man whose kit each instance slot holds: the dead are dropped from the band, so slots shift. */
  private readonly slotId = new Int32Array(MAX_MEN).fill(-1);
  private mocapA: MocapPose | null = null;
  private mocapB: MocapPose | null = null;

  constructor() {
    this.group.name = 'guerrillas';
    const geos = segmentGeometries();
    const bind = bindFrames();
    this.unbind = bind.map((m) => m.clone().invert());
    // Each man's own clothes (kitMaterial): shirt, trousers, skin, hat and bandana; written per slot in update().
    const bodyGeo = skinnedBody(geos, bind);
    bodyGeo.setAttribute('kit', new InstancedBufferAttribute(new Float32Array(MAX_MEN * 4), 4));
    this.body = new InstancedMesh(bodyGeo, kitMaterial(skinnedPosition(this.bones)), MAX_MEN);
    // The AK stays rigid: one more instanced mesh, placed from the same pose.
    geos.rifle.setAttribute('kit', new InstancedBufferAttribute(new Float32Array(MAX_MEN * 4), 4));
    this.rifle = new InstancedMesh(geos.rifle, kitMaterial(positionLocal), MAX_MEN);
    for (const [mesh, name] of [[this.body, 'guerrilla-body'], [this.rifle, 'guerrilla-ak']] as const) {
      mesh.name = name;
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // the men move every frame; bounds would go stale
      this.group.add(mesh);
    }
  }

  /** Puts man `id`'s clothes on instance slot `i`. */
  private dress(i: number, id: number): void {
    this.slotId[i] = id;
    const kit = kitFor(id);
    for (const mesh of [this.body, this.rifle]) {
      const attr = mesh.geometry.getAttribute('kit') as InstancedBufferAttribute;
      (attr.array as Float32Array).set(kit, i * 4);
      attr.needsUpdate = true;
    }
  }

  update(men: readonly Guerrilla[], alpha: number, frameSeconds: number): void {
    const n = Math.min(men.length, MAX_MEN);
    this.body.count = n;
    this.rifle.count = n;
    for (let i = 0; i < n; i++) {
      const g = men[i] as Guerrilla;
      if (this.slotId[i] !== g.id) this.dress(i, g.id);
      _feet.set(g.prev.x + (g.pos.x - g.prev.x) * alpha, g.prev.y + (g.pos.y - g.prev.y) * alpha, g.prev.z + (g.pos.z - g.prev.z) * alpha);
      // Each man starts at his own point in the cycle, so a file of them does not step in time.
      let gait = this.gait.get(g.id) ?? ((g.id * 0.37) % 1);
      if (g.alive) gait = advanceGait(gait, g, frameSeconds);
      this.gait.set(g.id, gait);
      const yaw = g.prevYawRad + wrap(g.yawRad - g.prevYawRad) * alpha;
      _actor.makeRotationY(yaw).setPosition(_feet);
      // Where the round went, in the man's own frame: the dead turn away from it as they fall.
      _deathLocal.set(g.deathDir.x, 0, g.deathDir.z).applyAxisAngle(_yAxis, -yaw);
      this.pose(g, i, gait);
    }
    this.rifle.instanceMatrix.needsUpdate = true;
    this.bones.commit();
    if (this.gait.size > MAX_MEN * 4) this.gait.clear();
  }

  // ---------------------------------------------------------------- posing (actor frame: −Z forward, +X right)

  /**
   * The captured movement (mocap.ts) for the hips, spine and legs: walking and running blended by speed,
   * held with the feet apart when still, and the fall. Null where the pose stays built by hand: down on
   * one knee, and before the clips have loaded.
   */
  private captured(g: Guerrilla, gait: number): MocapPose | null {
    if (!mocapReady()) return null;
    if (!this.mocapA || !this.mocapB) {
      this.mocapA = new MocapPose();
      this.mocapB = new MocapPose();
    }
    if (!g.alive) return this.mocapA.sample('fall', g.deathS).solve();
    if (g.crouch > 0.5) return null;
    this.mocapA.sample('walk', gait * clipDuration('walk'));
    const run = smooth(1.9, 2.9, g.speedMs);
    if (run > 0) this.mocapA.blend(this.mocapB.sample('run', gait * clipDuration('run')), run);
    return this.mocapA.solve();
  }

  private pose(g: Guerrilla, i: number, gait: number): void {
    const cap = this.captured(g, gait);
    if (cap) {
      this.poseCaptured(g, i, cap);
      return;
    }
    // By hand: down on the right knee to shoot (or standing, before the clips load).
    const kneel = g.alive && g.crouch > 0.5;
    const phase = gait * Math.PI * 2;
    const stride = g.alive && !kneel ? Math.min(1, g.speedMs / 3) * 0.34 : 0;
    const still = g.alive && !kneel ? 1 - Math.min(1, g.speedMs / 0.6) : 0;
    const stagger = still * (g.rifleUp ? 1 : 0.5);
    if (!kneel) {
      _hip.set(0, 0.93 - stride * 0.06 * Math.abs(Math.sin(phase)) - still * 0.035, 0);
      _up.set(0, 1, -0.07 - stride * 0.25).normalize();
    } else {
      _hip.set(0, 0.5, 0.03);
      _up.set(0, 1, -0.3).normalize();
    }
    _right.set(1, 0, 0);
    _front.crossVectors(_up, _right).normalize();

    // Fall (only before the clips load): the pose tips away from the shot about the feet and lies there.
    _fall.identity();
    if (!g.alive) {
      const t = Math.min(1, g.deathS / 0.7);
      const a = t * t * (Math.PI / 2 - 0.08);
      _axis.set(_deathLocal.z, 0, -_deathLocal.x);
      if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
      _axis.normalize();
      _fall.makeTranslation(0, 0.1 * t, 0).multiply(_rot.makeRotationAxis(_axis, a));
    }

    this.place('pelvis', i, 0, _hip, _up, _front);
    this.armsAndRifle(g, i);

    for (const side of [0, 1] as const) {
      const sx = side === 1 ? 1 : -1;
      _hipJoint.copy(_hip).addScaledVector(_right, sx * 0.1).addScaledVector(_up, -0.02);
      _bootFront.set(0, 0, -1);
      _bootUp.set(0, 1, 0);
      if (kneel) {
        if (side === 0) {
          _foot.set(-0.14, ANKLE_Y, -0.34);
          _pole.set(0, 0.2, -1);
        } else {
          _foot.set(0.14, 0.13, 0.4);
          _pole.set(0, -1, -0.5);
          _bootFront.set(0, -0.6, -1).normalize();
          _bootUp.set(0, 1, -0.6).normalize();
        }
      } else {
        const swing = Math.sin(phase + (side === 0 ? 0 : Math.PI));
        const lift = Math.max(0, Math.cos(phase + (side === 0 ? 0 : Math.PI))) * stride * 0.4;
        _foot.set(sx * (0.11 + 0.05 * still), ANKLE_Y + lift, -swing * stride + (side === 0 ? -0.2 : 0.15) * stagger);
        _pole.set(0, 0.1, -1);
        // The rear foot turned out, as it is in a shooting stance.
        _bootFront.set(side === 1 ? 0.55 * stagger : -0.1 * stagger, lift * 0.8, -1).normalize();
      }
      this.limb('thigh', 'shin', i, side, _hipJoint, _foot, L_THIGH, L_SHIN, _pole);
      this.place('boot', i, side, _end, _bootUp, _bootFront);
    }
  }

  /**
   * Torso, head, AK and arms on the hips and spine already set (`_hip`, `_up`, `_right`, `_front`): the head
   * and the AK on the aim (low ready on patrol), the torso bladed behind it, the hands reaching its grips by
   * two-bone IK.
   */
  private armsAndRifle(g: Guerrilla, i: number): void {
    const pitch = g.alive ? g.pitchRad : 0;
    _aim.set(0, Math.sin(pitch), -Math.cos(pitch));
    const lowReady = g.alive && !g.rifleUp;
    if (lowReady) _rifleDir.set(0.3, -0.55, -0.78).normalize();
    else _rifleDir.copy(_aim);

    const blade = lowReady ? 0.25 : 0.6;
    _tRight.copy(_right).applyAxisAngle(_up, blade);
    _tFront.crossVectors(_up, _tRight).normalize();
    this.place('torso', i, 0, _hip, _up, _tFront);
    _neck.copy(_hip).addScaledVector(_up, SPINE_M);
    _headUp.set(0, 1, 0).addScaledVector(_aim, -_aim.y).normalize();
    _head.copy(_neck).addScaledVector(_up, 0.1).addScaledVector(_headUp, 0.04);
    this.place('head', i, 0, _head, _headUp, _aim);

    // AK: butt in the right shoulder pocket, along the aim. Model frame: −Z forward, sight line y = 0,
    // butt plate near (0, −0.09, +0.47).
    _shoulderR.copy(_hip).addScaledVector(_up, SPINE_M - 0.06).addScaledVector(_tRight, SHOULDER_HALF);
    _shoulderL.copy(_hip).addScaledVector(_up, SPINE_M - 0.06).addScaledVector(_tRight, -SHOULDER_HALF);
    _rifleUp.set(0, 1, 0).addScaledVector(_rifleDir, -_rifleDir.y).normalize();
    _butt.copy(_shoulderR).addScaledVector(_tFront, 0.04).addScaledVector(_tRight, -0.06);
    if (lowReady) _butt.addScaledVector(_up, -0.12).addScaledVector(_front, -0.06);
    _rifleO.copy(_butt).addScaledVector(_rifleUp, 0.09).addScaledVector(_rifleDir, 0.47);
    this.place('rifle', i, 0, _rifleO, _rifleUp, _rifleDir);
    // Grips: the pistol grip, and the support hand under the handguard.
    _gripR.copy(_rifleO).addScaledVector(_rifleUp, -0.15).addScaledVector(_rifleDir, -0.12);
    _gripL.copy(_rifleO).addScaledVector(_rifleUp, -0.08).addScaledVector(_rifleDir, 0.26);
    _pole.copy(_tRight).multiplyScalar(0.8).addScaledVector(_up, -1).addScaledVector(_tFront, -0.3);
    this.limb('upperArm', 'forearm', i, 1, _shoulderR, _gripR, L_UPPER_ARM, L_FOREARM, _pole);
    this.placeHand(i, 1, _gripR, _rifleDir);
    _pole.copy(_tRight).multiplyScalar(-0.9).addScaledVector(_up, -1);
    this.limb('upperArm', 'forearm', i, 0, _shoulderL, _gripL, L_UPPER_ARM, L_FOREARM, _pole);
    this.placeHand(i, 0, _gripL, _rifleDir);
  }

  /**
   * A pose from the capture: the hips, spine and legs as captured (each body part turned from the bind pose
   * by its bone's rotation from the T-pose, on this body's own lengths, the planted foot on the ground), the
   * head and the AK on the aim and the arms reaching it by IK as before. The dead fall as captured, arms
   * too, the AK still in the right hand.
   */
  private poseCaptured(g: Guerrilla, i: number, cap: MocapPose): void {
    const D = (name: string): Quaternion => cap.delta[boneIndex(name)] as Quaternion;
    _fall.identity();
    if (!g.alive) {
      // The capture falls back. Turned toward where the round went (at most a quarter turn), over the
      // first moments, as a hit spins a man: shot from the side he twists and goes down sideways.
      const a = Math.max(-1.6, Math.min(1.6, Math.atan2(_deathLocal.x, _deathLocal.z)));
      _fall.makeRotationY(a * smooth(0, 0.45, g.deathS));
    }
    // The legs first, at the captured hip height, to find how far the planted foot sits off the ground.
    const legs = (hip: Vector3): number => {
      let low = Infinity;
      for (const side of [0, 1] as const) {
        const L = side === 0 ? 'Left' : 'Right';
        hipJointOf(hip, D('Hips'), side, _hipJoint);
        _dir.set(0, -1, 0).applyQuaternion(D(`${L}UpLeg`));
        _mid.copy(_hipJoint).addScaledVector(_dir, L_THIGH);
        _dir.set(0, -1, 0).applyQuaternion(D(`${L}Leg`));
        _end.copy(_mid).addScaledVector(_dir, L_SHIN);
        low = Math.min(low, _end.y);
      }
      return low;
    };
    _hip.copy(cap.hips);
    if (g.alive) _hip.y += ANKLE_Y - legs(_hip);
    else _hip.y += 0.04; // the capture's floor sits 4 cm under its toes' origin
    for (const side of [0, 1] as const) {
      const L = side === 0 ? 'Left' : 'Right';
      hipJointOf(_hip, D('Hips'), side, _hipJoint);
      _dir.set(0, -1, 0).applyQuaternion(D(`${L}UpLeg`));
      _mid.copy(_hipJoint).addScaledVector(_dir, L_THIGH);
      this.place('thigh', i, side, _hipJoint, _tmpUp.copy(_dir).negate(), _front.set(0, 0, -1).applyQuaternion(D(`${L}UpLeg`)));
      _dir.set(0, -1, 0).applyQuaternion(D(`${L}Leg`));
      _end.copy(_mid).addScaledVector(_dir, L_SHIN);
      this.place('shin', i, side, _mid, _tmpUp.copy(_dir).negate(), _front.set(0, 0, -1).applyQuaternion(D(`${L}Leg`)));
      this.place('boot', i, side, _end, _bootUp.set(0, 1, 0).applyQuaternion(D(`${L}Foot`)), _bootFront.set(0, 0, -1).applyQuaternion(D(`${L}Foot`)));
    }
    this.place('pelvis', i, 0, _hip, _up.set(0, 1, 0).applyQuaternion(D('Hips')), _front.set(0, 0, -1).applyQuaternion(D('Hips')));
    // Torso from the chest's rotation.
    _up.set(0, 1, 0).applyQuaternion(D('Spine1'));
    _right.set(1, 0, 0).applyQuaternion(D('Spine1'));
    _front.crossVectors(_up, _right).normalize();
    if (g.alive) {
      this.armsAndRifle(g, i);
      return;
    }
    this.place('torso', i, 0, _hip, _up, _front);
    _neck.copy(_hip).addScaledVector(_up, SPINE_M + 0.1);
    _headUp.set(0, 1, 0).applyQuaternion(D('Head'));
    this.place('head', i, 0, _head.copy(_neck).addScaledVector(_headUp, 0.04), _headUp, _aim.set(0, 0, -1).applyQuaternion(D('Head')));
    // Arms as captured: the T-pose arm points out to its side, so its segment's +Y points back in.
    for (const side of [0, 1] as const) {
      const L = side === 0 ? 'Left' : 'Right';
      const sx = side === 1 ? 1 : -1;
      const shoulder = side === 1 ? _shoulderR : _shoulderL;
      shoulder.copy(_hip).addScaledVector(_up, SPINE_M - 0.06).addScaledVector(_right, sx * SHOULDER_HALF);
      let at = shoulder;
      for (const [seg, bone, len] of [
        ['upperArm', 'Arm', L_UPPER_ARM],
        ['forearm', 'ForeArm', L_FOREARM],
        ['hand', 'Hand', 0],
      ] as const) {
        _tmpUp.set(-sx, 0, 0).applyQuaternion(D(`${L}${bone}`));
        this.place(seg, i, side, at, _tmpUp, _bootFront.set(0, 0, -1).applyQuaternion(D(`${L}${bone}`)));
        at = (seg === 'upperArm' ? _mid : _end).copy(at).addScaledVector(_tmpUp, -len);
      }
      if (side === 1) _gripR.copy(_end);
    }
    // The AK goes down in the right hand, along the forearm, and leaves it as he hits the ground: the
    // capture ends with the forearms raised, and a rifle still along one stood up off the body.
    _rifleDir.set(1, 0, 0).applyQuaternion(D('RightForeArm'));
    _rifleUp.set(0, 1, 0).applyQuaternion(D('RightHand'));
    _rifleO.copy(_gripR).addScaledVector(_rifleUp, 0.15).addScaledVector(_rifleDir, 0.12);
    const drop = smooth(0.3, 0.75, g.deathS);
    _rifleO.lerp(DROPPED_O, drop);
    _rifleDir.lerp(DROPPED_DIR, drop);
    _rifleUp.lerp(DROPPED_UP, drop);
    this.place('rifle', i, 0, _rifleO, _rifleUp, _rifleDir);
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
    frame(_m, origin, up, front);
    _m.premultiply(_fall).premultiply(_actor);
    if (seg === 'rifle') {
      this.rifle.setMatrixAt(i, _m);
      return;
    }
    // The segment's frame is its bone: world × inverse bind takes the bind-pose skin to here.
    const b = boneOf(seg, side);
    this.bones.set(i, b, _m.multiply(this.unbind[b] as Matrix4));
  }
}

function wrap(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Two-bone IK: the joint between `root` and `target` for bones `l1`, `l2`, bent toward `pole`. */
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

/** The hip joint of `side` on the pelvis at `hip` turned by `pelvis` (the actor's frame). */
function hipJointOf(hip: Vector3, pelvis: Quaternion, side: 0 | 1, out: Vector3): Vector3 {
  return out.set(side === 1 ? 0.1 : -0.1, -0.02, 0).applyQuaternion(pelvis).add(hip);
}

/**
 * The next point in a man's captured gait cycle (0…1): on at his ground speed over the cycle's stride
 * (walk and run strides blended as their poses are), so the feet do not slide. Stopping, he walks on to
 * the next moment both feet are planted apart (0 or ½) and holds it — a stance, not a frozen mid-stride.
 */
function advanceGait(g: number, man: Guerrilla, dt: number): number {
  if (!mocapReady()) return (g + (dt * man.speedMs) / 1.4) % 1;
  if (man.crouch > 0.5) return g;
  const v = man.speedMs;
  if (v > 0.25) {
    const run = smooth(1.9, 2.9, v);
    const stride = (1 - run) * clipSpeed('walk') * clipDuration('walk') + run * clipSpeed('run') * clipDuration('run');
    return (g + (dt * v) / stride) % 1;
  }
  const into = g % 0.5;
  if (into < 1e-3) return g;
  const target = g - into + 0.5;
  const next = g + dt * 0.8;
  return next >= target ? target % 1 : next;
}

/**
 * A segment's frame: origin, its local +Y along `up` and its local −Z toward `front`. No mirroring for the
 * left side: paired segments are built symmetric, and a mirrored frame would flip the skin's winding.
 */
function frame(out: Matrix4, origin: Vector3, up: Vector3, front: Vector3): Matrix4 {
  _y.copy(up).normalize();
  _z.copy(front).addScaledVector(_y, -front.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, -1).addScaledVector(_y, _y.z);
  _z.normalize().negate();
  _x.crossVectors(_y, _z);
  return out.makeBasis(_x, _y, _z).setPosition(origin);
}

/**
 * The bind pose, in which the skin is weighted and from which every bone moves: standing straight, the legs
 * under the hips, the arms hanging a little out from the sides (an A-pose), each segment in the frame the
 * posing gives it. Straight limbs make the blend at a bent joint fold the way a sleeve does.
 */
function bindFrames(): Matrix4[] {
  const hip = new Vector3(0, 0.93, 0);
  const fwd = new Vector3(0, 0, -1);
  const up = new Vector3(0, 1, 0);
  return BONES.map(({ seg, side }) => {
    const sx = side === 1 ? 1 : -1;
    const m = new Matrix4();
    const armDir = new Vector3(sx * 0.17, -1, 0).normalize();
    const shoulder = new Vector3(sx * SHOULDER_HALF, hip.y + SPINE_M - 0.06, 0);
    const hipJoint = new Vector3(sx * 0.1, hip.y - 0.02, 0);
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
      case 'boot':
        return frame(m, hipJoint.clone().addScaledVector(down, L_THIGH + L_SHIN), up, fwd);
    }
  });
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How much of a vertex of `bone` (at `p` in its segment's frame) goes with its neighbours: half at the
 * joint, fading over a few centimetres either side, so the skin round a knee, an elbow, a wrist, the hips,
 * the neck and the shoulders bends with both bones.
 */
function shares(bone: number, p: Vector3): [number, number][] {
  const { seg, parent } = BONES[bone] as (typeof BONES)[number];
  const y = p.y;
  const child = BONES.findIndex((b) => b.parent === bone && PAIRED[b.seg] === PAIRED[seg]);
  switch (seg) {
    case 'pelvis':
      return [[boneOf('torso', 0), 0.5 * smooth(0, 0.12, y)]];
    case 'torso': {
      const out: [number, number][] = [
        [parent, 0.5 * (1 - smooth(0.02, 0.15, y))],
        [boneOf('head', 0), 0.5 * smooth(SPINE_M - 0.05, SPINE_M + 0.05, y)],
      ];
      // The shoulder caps go with the arms.
      for (const s of [0, 1] as const) {
        const d = Math.hypot(p.x - (s === 1 ? SHOULDER_HALF : -SHOULDER_HALF), y - (SPINE_M - 0.06), p.z);
        out.push([boneOf('upperArm', s), 0.45 * (1 - smooth(0.04, 0.11, d))]);
      }
      return out;
    }
    case 'head':
      return [[parent, 0.5 * (1 - smooth(-0.15, -0.06, y))]];
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
        [child, 0.5 * smooth(-L_SHIN + 0.06, -L_SHIN, y)],
      ];
    case 'boot':
      // The boot's shaft above the ankle laces round the shin.
      return [[parent, 0.6 * smooth(0.02, 0.12, y)]];
  }
}

/** Every segment in the bind pose as one skin: up to four bones and weights per vertex (skinning.ts). */
function skinnedBody(geos: Record<Segment, BufferGeometry>, bind: readonly Matrix4[]): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const idx: number[] = [];
  const wgt: number[] = [];
  const v = new Vector3();
  BONES.forEach(({ seg }, bone) => {
    const g = geos[seg].clone();
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const others = shares(bone, v)
        .filter(([b, w]) => b >= 0 && w > 1e-4)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      const rest = Math.max(0, 1 - others.reduce((a, [, w]) => a + w, 0));
      const list: [number, number][] = [[bone, rest], ...others];
      while (list.length < 4) list.push([bone, 0]);
      const sum = list.reduce((a, [, w]) => a + w, 0) || 1;
      for (const [b, w] of list) {
        idx.push(b);
        wgt.push(w / sum);
      }
    }
    parts.push(g.applyMatrix4(bind[bone] as Matrix4));
  });
  const out = joined(parts, 'guerrilla body');
  out.setAttribute('skinIdx', new BufferAttribute(new Float32Array(idx), 4));
  out.setAttribute('skinWgt', new BufferAttribute(new Float32Array(wgt), 4));
  return out;
}

// ------------------------------------------------------------------ material

type Rgb = [number, number, number];
/** Shirts after the tiger stripe (linear): faded olive, washed-out black, maroon, khaki. */
const SHIRTS: Rgb[] = [
  [0.09, 0.1, 0.06],
  [0.04, 0.04, 0.042],
  [0.17, 0.045, 0.035],
  [0.24, 0.21, 0.13],
];
/** Trousers: olive, faded denim, khaki, black. */
const TROUSER_COLOURS: Rgb[] = [
  [0.07, 0.07, 0.035],
  [0.06, 0.08, 0.13],
  [0.2, 0.17, 0.1],
  [0.035, 0.035, 0.038],
];
const HATS: Rgb[] = [
  [0.1, 0.1, 0.05],
  [0.22, 0.19, 0.12],
  [0.03, 0.03, 0.03],
  [0.07, 0.085, 0.06],
];
const BANDANAS: Rgb[] = [
  [0.15, 0.025, 0.02],
  [0.03, 0.03, 0.035],
  [0.08, 0.08, 0.04],
  [0.03, 0.05, 0.14],
];

/**
 * One man's clothes, by his id: [shirt 0 = tiger stripe or 1…4 a plain one, trousers 0…3, skin tone
 * 0…1, headgear = what × 4 + colour 0…3, what 0 a boonie hat, 1 a headband, 2 bare-headed, 3 both].
 * Irregulars wear what they have: a band in one uniform read as a platoon of clones.
 */
function kitFor(i: number): [number, number, number, number] {
  const h = (k: number): number => {
    let x = Math.imul(i * 374761393 + k * 668265263, 1274126177);
    x ^= x >>> 15;
    return ((x >>> 0) % 10000) / 10000;
  };
  const what = h(6) < 0.35 ? 0 : h(6) < 0.65 ? 1 : h(6) < 0.85 ? 2 : 3;
  return [h(1) < 0.4 ? 0 : 1 + Math.floor(h(2) * SHIRTS.length), Math.floor(h(3) * TROUSER_COLOURS.length), h(4), what * 4 + Math.floor(h(5) * HATS.length)];
}

/** The entry of `list` at index `i` (a float node holding a whole number), by a chain of steps. */
function pickRgb(i: Node<'float'>, list: readonly Rgb[]): Node<'vec3'> {
  let out: Node<'vec3'> = vec3(...(list[0] as Rgb));
  for (let k = 1; k < list.length; k++) out = mix(out, vec3(...(list[k] as Rgb)), step(k - 0.5, i));
  return out;
}

/** The kit's material, its vertices placed by `position` (the skinned body's, or the rigid AK's own). */
function kitMaterial(position: Node<'vec3'>): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'guerrilla', metalness: 0, sheenRoughness: 0.8 });
  const tint = attribute('tint', 'vec3');
  const kind = attribute('kind', 'float');
  const kit = attribute('kit', 'vec4');
  const is = (k: number): Node<'float'> => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const cloth = is(PLAIN).add(is(STRIPE)).add(is(TROUSERS)).add(is(HAT)).add(is(BANDANA));
  // Faded tiger stripe: dark brush strokes running round the body over a sun-bleached green.
  // Pre-instance space, so the pattern stays on the cloth as the man moves (positionLocal is instanced).
  const p = positionGeometry;
  const warp = mx_noise_float(p.mul(4.3)).mul(0.6);
  const strokes = mx_noise_float(vec3(p.x.mul(3), p.y.mul(18).add(warp.mul(3)), p.z.mul(3)));
  const patches = mx_noise_float(p.mul(7.1).add(vec3(2.1, 5.3, 0.7)));
  const pattern = mix(mix(vec3(0.13, 0.13, 0.07), vec3(0.09, 0.07, 0.04), step(0.25, patches)), vec3(0.025, 0.028, 0.02), step(0.3, strokes));
  // Plain cloth is faded unevenly: sun on the shoulders, sweat and wear in patches.
  const mottle = mx_noise_float(p.mul(5.3).add(vec3(1.7, 0.3, 4.1))).mul(0.12).add(0.95);
  const shirt = mix(pattern, pickRgb(kit.x.sub(1), SHIRTS).mul(mottle), step(0.5, kit.x));
  const skin = mix(vec3(0.3, 0.15, 0.085), vec3(0.11, 0.055, 0.03), kit.z);
  let base: Node<'vec3'> = tint;
  base = mix(base, shirt, is(STRIPE));
  base = mix(base, pickRgb(kit.y, TROUSER_COLOURS).mul(mottle), is(TROUSERS));
  const gear = floor(kit.w.div(4));
  const gearColour = kit.w.sub(gear.mul(4));
  base = mix(base, pickRgb(gearColour, HATS).mul(mottle), is(HAT));
  base = mix(base, pickRgb(gearColour, BANDANAS), is(BANDANA));
  base = mix(base, skin, is(SKIN));
  // Mud and dust where they collect, in blotches: dried light dust over darker wet mud.
  const grime = attribute('grime', 'float');
  const blot = smoothstep(-0.2, 0.45, mx_noise_float(positionGeometry.mul(23)).add(grime.mul(0.9).sub(0.45)));
  const mud = mix(vec3(0.08, 0.06, 0.04), vec3(0.24, 0.2, 0.15), smoothstep(0.1, 0.6, mx_noise_float(positionGeometry.mul(9))));
  const colour = mix(base, mud, blot.mul(grime)).mul(attribute('shade', 'float'));
  m.colorNode = colour;
  // Headgear a man does not wear collapses to a point (a zero-area triangle).
  const hat = step(gear, 0.5).add(step(2.5, gear));
  const band = step(0.5, gear).mul(step(gear, 1.5)).add(step(2.5, gear));
  const hidden = is(HAT).mul(float(1).sub(hat)).add(is(BANDANA).mul(float(1).sub(band)));
  m.positionNode = position.mul(float(1).sub(hidden));
  m.roughnessNode = mix(float(0.55), float(0.9), cloth.max(blot.mul(grime)));
  m.sheenNode = colour.mul(cloth.mul(0.35));
  return m;
}

// ------------------------------------------------------------------ geometry (each segment in its own frame)

function linear(hex: number): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

/**
 * Tags a geometry with its colour and kind for the shared material, and its grime: a constant, or by the
 * vertex's height in the segment's frame. A `shade` already on the geometry (cloth creases) is kept.
 */
function tag(g: BufferGeometry, hex: number, kind: Kind, grime: number | ((y: number) => number) = 0): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  const pos = n.getAttribute('position');
  const count = pos.count;
  const [r, gr, b] = linear(hex);
  const tint = new Float32Array(count * 3);
  const k = new Float32Array(count).fill(kind);
  const dirt = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    tint.set([r, gr, b], i * 3);
    dirt[i] = typeof grime === 'number' ? grime : Math.min(1, Math.max(0, grime(pos.getY(i))));
  }
  n.setAttribute('tint', new BufferAttribute(tint, 3));
  n.setAttribute('kind', new BufferAttribute(k, 1));
  n.setAttribute('grime', new BufferAttribute(dirt, 1));
  if (!n.getAttribute('shade')) n.setAttribute('shade', new BufferAttribute(new Float32Array(count).fill(1), 1));
  return n;
}

const TAGS: [string, number][] = [
  ['tint', 3],
  ['kind', 1],
  ['shade', 1],
  ['grime', 1],
];

function joined(parts: BufferGeometry[], name: string): BufferGeometry {
  // meshkit.merge keeps only position/normal/uv; carry the tags across by merging them here.
  // Copied into one typed array per tag: spreading a big part into push() overflows the call stack.
  const total = parts.reduce((n, p) => n + p.getAttribute('position').count, 0);
  const lists = TAGS.map(([, size]) => new Float32Array(total * size));
  let at = 0;
  for (const p of parts) {
    TAGS.forEach(([key, size], k) => (lists[k] as Float32Array).set(p.getAttribute(key).array as Float32Array, at * size));
    at += p.getAttribute('position').count;
  }
  const g = merge(parts, name);
  TAGS.forEach(([key, size], k) => g.setAttribute(key, new BufferAttribute(lists[k] as Float32Array, size)));
  return g;
}

/** A cloth fold: where along the limb (0 top … 1 bottom), how wide a band, how deep (m). */
type Fold = [centre: number, width: number, depthM: number];

/**
 * A clothed limb along −Y from the origin: a lathe through `profile` ([fraction of the length, radius] pairs,
 * top to bottom, eased between), its section `depth` times as deep front to back as it is wide, closed by
 * domes so a bent joint never shows a gap, and the cloth's folds pressed in — rings that wander round the
 * limb, strongest where the cloth bunches. Creases carry a darker `shade` (the light they do not get).
 */
function clothLimb(length: number, profile: readonly [number, number][], depth: number, folds: readonly Fold[], seed: number): BufferGeometry {
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
  const r0 = radiusAt(0);
  const r1 = radiusAt(1);
  // Rings: a dome over the top, the body, a dome under the bottom. (y, radius, t for folds, or −1 on the domes.)
  const rings: [number, number, number][] = [];
  const DOME = 4;
  for (let k = 0; k < DOME; k++) {
    const a = (Math.PI / 2) * (1 - k / DOME);
    rings.push([Math.sin(a) * r0 * 0.7, Math.cos(a) * r0, -1]);
  }
  const BODY = 22;
  for (let k = 0; k <= BODY; k++) {
    const t = k / BODY;
    rings.push([-t * length, radiusAt(t), t]);
  }
  for (let k = 1; k <= DOME; k++) {
    const a = (Math.PI / 2) * (k / DOME);
    rings.push([-length - Math.sin(a) * r1 * 0.7, Math.cos(a) * r1, -1]);
  }
  const SEG = 14;
  const pos: number[] = [];
  const uvs: number[] = [];
  const shade: number[] = [];
  rings.forEach(([y, r, t], k) => {
    for (let j = 0; j <= SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      let d = 0;
      if (t >= 0) {
        for (const [c, w, amp] of folds) {
          const env = Math.exp(-(((t - c) / w) ** 2));
          // Rings ~5 cm apart, tilted and wandering round the limb.
          d += amp * env * Math.sin(((t * length) / 0.05) * Math.PI * 2 + 1.6 * Math.sin(th * 2 + seed) + Math.cos(th) * 0.8 + seed);
        }
      }
      const rr = Math.max(0.005, r + d);
      pos.push(Math.cos(th) * rr, y, Math.sin(th) * rr * depth);
      uvs.push(j / SEG, k / (rings.length - 1));
      const deepest = folds.reduce((m, f) => Math.max(m, f[2]), 1e-6);
      shade.push(1 + Math.min(0, d / deepest) * 0.28);
    }
  });
  const idx: number[] = [];
  for (let k = 0; k < rings.length - 1; k++) {
    for (let j = 0; j < SEG; j++) {
      const a = k * (SEG + 1) + j;
      const b = a + SEG + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('shade', new BufferAttribute(new Float32Array(shade), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A body section lofted through rings of (y, half-width, half-depth, z offset), closed at both ends. */
function loft(rings: readonly [number, number, number, number][]): BufferGeometry {
  const SEG = 18;
  const pos: number[] = [];
  const uvs: number[] = [];
  const all: [number, number, number, number][] = [[(rings[0] as number[])[0] as number, 0.001, 0.001, 0], ...rings, [(rings[rings.length - 1] as number[])[0] as number, 0.001, 0.001, 0]];
  all.forEach(([y, rx, rz, z], k) => {
    for (let j = 0; j <= SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      pos.push(Math.cos(th) * rx, y, z + Math.sin(th) * rz);
      uvs.push(j / SEG, k / (all.length - 1));
    }
  });
  const idx: number[] = [];
  for (let k = 0; k < all.length - 1; k++) {
    for (let j = 0; j < SEG; j++) {
      const a = k * (SEG + 1) + j;
      const b = a + SEG + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A head in a balaclava: brow, nose, cheekbones and jaw pressed into a sphere (front is −Z). */
function headGeometry(): BufferGeometry {
  const g = new SphereGeometry(0.1, 20, 14).scale(0.8, 1.06, 0.95);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  const bump = (p: Vector3, x: number, y: number, z: number, r: number): number => Math.exp(-((p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2) / (r * r));
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const front = Math.max(0, -v.z / 0.095);
    // Nose, brow ridge, cheekbones out; the eye sockets and under the cheekbones in; the jaw narrower at the back.
    const out =
      0.016 * bump(v, 0, -0.012, -0.095, 0.022) +
      0.006 * bump(v, 0, 0.03, -0.088, 0.035) +
      0.005 * (bump(v, -0.045, 0.0, -0.07, 0.025) + bump(v, 0.045, 0.0, -0.07, 0.025)) -
      0.006 * (bump(v, -0.032, 0.018, -0.088, 0.018) + bump(v, 0.032, 0.018, -0.088, 0.018)) -
      0.005 * (bump(v, -0.05, -0.045, -0.06, 0.03) + bump(v, 0.05, -0.045, -0.06, 0.03));
    const jaw = v.y < -0.03 ? 1 - Math.min(0.18, (-0.03 - v.y) * 2.2) * (1 - front) : 1;
    pos.setXYZ(i, v.x * jaw, v.y, v.z - out * front);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * The face's darks on the head: eye sockets in shadow, and a week's stubble over the jaw, chin and upper
 * lip (the head's frame, front −Z), as `shade`.
 */
function faceShade(g: BufferGeometry): BufferGeometry {
  const pos = g.getAttribute('position');
  const shade = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const front = Math.max(0, -z / 0.095);
    const socket = Math.exp(-(((Math.abs(x) - 0.032) / 0.016) ** 2 + ((y - 0.016) / 0.012) ** 2)) * front;
    const jaw = Math.min(1, Math.max(0, (-0.028 - y) / 0.02)) * Math.min(1, front * 1.6 + Math.max(0, -y - 0.06) * 8);
    const lip = Math.exp(-((x / 0.025) ** 2 + ((y + 0.03) / 0.007) ** 2)) * front;
    shade[i] = 1 - socket * 0.55 - Math.min(1, jaw + lip) * 0.22;
  }
  g.setAttribute('shade', new BufferAttribute(shade, 1));
  return g;
}

/** A combat boot from its side profile (z forward is −, y up from the ankle), the sole a darker band. */
function bootGeometry(): BufferGeometry[] {
  const s = new Shape();
  s.moveTo(0.075, -0.088);
  s.lineTo(0.08, 0.02);
  s.quadraticCurveTo(0.075, 0.1, 0.045, 0.11);
  s.lineTo(-0.03, 0.11);
  s.quadraticCurveTo(-0.055, 0.04, -0.09, 0.0);
  s.quadraticCurveTo(-0.17, -0.025, -0.195, -0.06);
  s.quadraticCurveTo(-0.205, -0.085, -0.185, -0.088);
  s.lineTo(0.075, -0.088);
  const upper = new ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.016, bevelSize: 0.014, bevelSegments: 3, curveSegments: 8 });
  // Shape (u, v) → boot (z = u, y = v), extruded across x and centred; up 2 cm so the sole meets the ground.
  upper.rotateY(-Math.PI / 2).translate(0.035, 0.02, 0);
  const sole = new ExtrudeGeometry(
    (() => {
      const o = new Shape();
      o.moveTo(0.09, -0.11);
      o.lineTo(0.09, -0.086);
      o.lineTo(-0.2, -0.086);
      o.quadraticCurveTo(-0.215, -0.095, -0.2, -0.11);
      o.lineTo(0.09, -0.11);
      return o;
    })(),
    { depth: 0.1, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 1 },
  );
  sole.rotateY(-Math.PI / 2).translate(0.05, 0.02, 0);
  return [upper, sole];
}

const C = {
  trousers: 0x4a4a32,
  rig: 0x6e6448,
  webbing: 0x4f4a36,
  skin: 0x8a5a3c,
  hair: 0x1c1712,
  eye: 0x2a1e18,
  bandana: 0x6a2420,
  hat: 0x5c5a3c,
  boot: 0x2f2a24,
  sole: 0x1e1d1c,
  bag: 0x5a5236,
  steel: 0x2b2c2e,
  wood: 0x6a3a20,
} as const;

const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry => new BoxGeometry(sx, sy, sz).translate(x, y, z);

function segmentGeometries(): Record<Segment, BufferGeometry> {
  const pelvis = joined(
    [
      // Hips and the seat of the trousers, narrowing to the crotch.
      tag(
        loft([
          [0.1, 0.15, 0.11, 0],
          [0.03, 0.175, 0.125, 0.005],
          [-0.04, 0.18, 0.13, 0.012],
          [-0.1, 0.155, 0.115, 0.01],
          [-0.14, 0.09, 0.08, 0.0],
        ]),
        C.trousers,
        TROUSERS,
      ),
      tag(box(0.35, 0.045, 0.25, 0, 0.06, 0), C.webbing, PLAIN), // belt
      tag(box(0.1, 0.12, 0.06, 0.15, 0.0, 0.1), C.bag, PLAIN, 0.2), // a canvas bag on the hip
    ],
    'pelvis',
  );
  const torso = joined(
    [
      tag(new LatheGeometry([new Vector2(0.001, 0), new Vector2(0.15, 0.02), new Vector2(0.152, 0.2), new Vector2(0.18, 0.38), new Vector2(0.165, 0.48), new Vector2(0.06, 0.52)], 14).scale(1, 1, 0.6), 0x000000, STRIPE),
      tag(new SphereGeometry(0.072, 12, 9).scale(1, 0.9, 1).translate(-SHOULDER_HALF, SPINE_M - 0.06, 0), 0x000000, STRIPE),
      tag(new SphereGeometry(0.072, 12, 9).scale(1, 0.9, 1).translate(SHOULDER_HALF, SPINE_M - 0.06, 0), 0x000000, STRIPE),
      // Chest rig: a panel across the belly with three AK magazine pouches, straps over the shoulders.
      tag(box(0.3, 0.17, 0.05, 0, 0.2, -0.11), C.rig, PLAIN, 0.15),
      tag(box(0.075, 0.13, 0.05, -0.085, 0.21, -0.145), C.rig, PLAIN, 0.15),
      tag(box(0.075, 0.13, 0.05, 0, 0.21, -0.145), C.rig, PLAIN, 0.15),
      tag(box(0.075, 0.13, 0.05, 0.085, 0.21, -0.145), C.rig, PLAIN, 0.15),
      tag(box(0.05, 0.025, 0.24, -0.1, 0.45, 0), C.webbing, PLAIN),
      tag(box(0.05, 0.025, 0.24, 0.1, 0.45, 0), C.webbing, PLAIN),
      tag(box(0.05, 0.3, 0.025, -0.1, 0.32, 0.1), C.webbing, PLAIN),
      tag(box(0.05, 0.3, 0.025, 0.1, 0.32, 0.1), C.webbing, PLAIN),
      // A rolled blanket across the back, and the neck.
      tag(new CylinderGeometry(0.06, 0.06, 0.3, 10).rotateZ(Math.PI / 2).translate(0, 0.42, 0.14), C.bag, PLAIN, 0.2),
      tag(new CylinderGeometry(0.055, 0.065, 0.1, 10).translate(0, 0.53, 0), C.skin, SKIN),
    ],
    'torso',
  );
  const head = joined(
    [
      tag(faceShade(headGeometry()), C.skin, SKIN),
      // Hair: the cap tilted back so the hairline is high on the forehead and low at the nape.
      tag(new SphereGeometry(0.102, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45).rotateX(0.35).scale(0.84, 1.0, 0.98).translate(0, 0.01, 0.01), C.hair, PLAIN),
      // A headband across the forehead above the brows, knotted at the back, and a boonie hat's brim and
      // crown; each man wears his own (kitFor), the rest collapse in the vertex stage (kitMaterial).
      tag(new CylinderGeometry(0.058, 0.076, 0.035, 16, 1, true).scale(1, 1, 1.18).translate(0, 0.0625, 0.002), C.bandana, BANDANA),
      tag(box(0.04, 0.03, 0.03, 0, 0.06, 0.085), C.bandana, BANDANA),
      tag(new CylinderGeometry(0.095, 0.1, 0.07, 16).translate(0, 0.09, 0.005), C.hat, HAT),
      tag(new TorusGeometry(0.115, 0.022, 4, 20).rotateX(Math.PI / 2).scale(1, 1, 1.1).translate(0, 0.062, 0.005), C.hat, HAT),
      // Ears; eyes in the sockets; brows.
      tag(new SphereGeometry(1, 8, 6).scale(0.012, 0.026, 0.018).translate(-0.08, -0.005, 0.005), C.skin, SKIN),
      tag(new SphereGeometry(1, 8, 6).scale(0.012, 0.026, 0.018).translate(0.08, -0.005, 0.005), C.skin, SKIN),
      ...[-1, 1].map((sx) => tag(new SphereGeometry(0.0085, 8, 6).translate(sx * 0.031, 0.017, -0.074), C.eye, HARD)),
      ...[-1, 1].map((sx) => tag(new BoxGeometry(0.026, 0.006, 0.01).rotateZ(sx * -0.12).translate(sx * 0.032, 0.033, -0.086), C.hair, PLAIN)),
    ],
    'head',
  );
  // Sleeve over the upper arm, full at the deltoid and biceps, bunched at the roll above the elbow.
  const upperArm = joined(
    [
      tag(
        clothLimb(
          L_UPPER_ARM,
          [
            [0, 0.064],
            [0.25, 0.06],
            [0.75, 0.052],
            [1, 0.05],
          ],
          0.92,
          [
            [0.12, 0.08, 0.004],
            [0.9, 0.07, 0.006],
          ],
          1,
        ),
        0x000000,
        STRIPE,
      ),
    ],
    'upperArm',
  );
  // Sleeves rolled to the elbow: a thick roll of cloth, then a bare forearm, full below the elbow
  // and tapering to the wrist.
  const forearm = joined(
    [
      tag(new TorusGeometry(0.047, 0.016, 8, 16).rotateX(Math.PI / 2).scale(1, 1.2, 0.9).translate(0, -0.012, 0), 0x000000, STRIPE),
      tag(
        clothLimb(
          L_FOREARM,
          [
            [0, 0.044],
            [0.25, 0.046],
            [0.7, 0.034],
            [1, 0.029],
          ],
          0.8,
          [],
          2,
        ),
        C.skin,
        SKIN,
      ),
    ],
    'forearm',
  );
  const hand = joined(
    [
      // Palm and knuckles, the curled fingers as one roll across the front, the thumb along the side.
      tag(new SphereGeometry(1, 12, 8).scale(0.04, 0.05, 0.022).translate(0, -0.045, 0), C.skin, SKIN),
      tag(new CapsuleGeometry(0.014, 0.05, 3, 8).rotateZ(Math.PI / 2).translate(0, -0.088, -0.012), C.skin, SKIN),
      tag(new CapsuleGeometry(0.011, 0.035, 2, 6).rotateZ(0.5).translate(-0.035, -0.05, -0.02), C.skin, SKIN),
    ],
    'hand',
  );
  const thigh = joined(
    [
      tag(
        clothLimb(
          L_THIGH,
          [
            [0, 0.093],
            [0.15, 0.09],
            [0.55, 0.077],
            [0.88, 0.065],
            [1, 0.063],
          ],
          0.94,
          [
            [0.1, 0.07, 0.005],
            [0.92, 0.07, 0.007],
          ],
          3,
        ),
        C.trousers,
        TROUSERS,
        (y) => Math.max(0, (-y - L_THIGH * 0.7) / (L_THIGH * 0.3)) * 0.4,
      ),
      ...[-1, 1].map((sx) => tag(new BoxGeometry(0.035, 0.15, 0.13).translate(sx * 0.08, -0.23, 0.0), C.trousers, TROUSERS)),
    ],
    'thigh',
  );
  const shin = joined(
    [
      tag(
        clothLimb(
          L_SHIN,
          [
            [0, 0.066],
            [0.3, 0.067],
            [0.7, 0.059],
            [0.86, 0.062],
            [1, 0.057],
          ],
          0.95,
          [
            [0.06, 0.07, 0.005],
            [0.84, 0.08, 0.008],
          ],
          4,
        ),
        C.trousers,
        TROUSERS,
        (y) => 0.2 + Math.max(0, (-y - L_SHIN * 0.45) / (L_SHIN * 0.55)) * 0.8,
      ),
      tag(new CylinderGeometry(0.058, 0.062, 0.11, 14).translate(0, -L_SHIN + 0.045, 0), C.boot, HARD, 0.8),
    ],
    'shin',
  );
  const [bootUpper, sole] = bootGeometry() as [BufferGeometry, BufferGeometry];
  const boot = joined([tag(bootUpper, C.boot, HARD, (y) => 0.6 + Math.max(0, -y) * 4), tag(sole, C.sole, HARD, 0.9)], 'boot');
  return { pelvis, torso, head, upperArm, forearm, hand, thigh, shin, boot, rifle: rifleGeometry() };
}

/** The player's AK (weaponModels.ts) merged into one geometry: wood furniture, dark steel. */
function rifleGeometry(): BufferGeometry {
  // Cut without bevels (gunkit.ts): every man carries one, and at their distance a bevel is under a pixel.
  const model = coarseParts(() => buildRifle());
  model.root.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  model.root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    parts.push(tag(o.geometry.clone().applyMatrix4(o.matrixWorld), o.name === 'furniture' ? C.wood : C.steel, HARD));
  });
  return joined(parts, 'guerrilla ak');
}

/**
 * Where a dead man's rifle comes to rest (actor frame, before the fall's turn): on its side by his right
 * hand, the muzzle toward his feet — the captured fall lands him on his back, head where he stood.
 */
const DROPPED_O = new Vector3(0.52, 0.04, -0.05);
const DROPPED_DIR = new Vector3(0.15, 0, -1).normalize();
const DROPPED_UP = new Vector3(1, 0, 0.15).normalize();
const _actor = new Matrix4();
const _fall = new Matrix4();
const _rot = new Matrix4();
const _m = new Matrix4();
const _feet = new Vector3();
const _deathLocal = new Vector3();
const _axis = new Vector3();
const _yAxis = new Vector3(0, 1, 0);
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
