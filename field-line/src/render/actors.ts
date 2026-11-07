import { attribute, float, mix, mx_noise_float, positionGeometry, smoothstep, step, texture, uv, vec3 } from 'three/tsl';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  MeshPhysicalNodeMaterial,
  type Node,
  Shape,
  SphereGeometry,
  type Texture,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { Soldier } from '../game/soldier.ts';
import { merge } from './meshkit.ts';
import { coarseParts } from './gunkit.ts';
import { buildRifle } from './weaponModels.ts';
import { BoneTexture, skinnedPosition } from './skinning.ts';
import { boneIndex, clipDuration, clipSpeed, MocapPose, mocapReady } from './mocap.ts';
import { CastRig, type Dims } from './castRig.ts';
import { type CastCharacter, FULL_BONES } from './mpfbCast.ts';

// Enemy infantry: a body of segments (pelvis, torso, head, upper arms,
// forearms, hands, thighs, shins, boots) skinned as one mesh shared by every
// soldier (skinning.ts: the skin near a joint takes both bones), and the
// rifle, posed per frame:
//
//   - walking, running and moving crouched as motion-captured (mocap.ts): the
//     hips, spine and legs from the capture, the cycle advanced by ground
//     speed so the feet do not slide; still, a stance with the feet apart;
//   - kneeling still and prone built by hand, the hips and the line of the
//     spine matching the hitbox layout the bullets test against
//     (game/actor.ts), the legs reaching planted feet by two-bone IK;
//   - the rifle sits in the right shoulder pocket along the aim (lowered on
//     patrol), and both arms reach its grips by two-bone IK, elbows out;
//   - the dead fall as captured, turning away from the shot as they go, the
//     rifle leaving the hand as they hit the ground. No gore.
//
// Kit: plate carrier with magazine pouches and a radio, assault pack, battle
// belt, high-cut helmet with ear defenders and a night-vision mount, knee and
// elbow pads, gloves, boots. One material for all of it: per-vertex colour and
// a kind (0 hard, 1 plain fabric, 2 camouflage fabric) that sets roughness,
// sheen and a procedural four-colour camouflage, a `shade` that darkens the
// creases of the cloth, and `grime` where mud and dust collect (boots, trouser
// bottoms, knees). Sheet values: uniform #5A5E48 rough 0.9 sheen 0.4, NATO
// green #4B5340, khaki #5C5B3E, rubber.
//
// Bodies are built as a man in loose combat clothes, not as a jointed doll:
// limbs are lathed through measured profiles (a thigh in trousers is ~18 cm
// across at the top, the knee 12), their sections oval, with the cloth's
// folds pressed in where it bunches — behind the knee, at the elbow, over the
// boot. Thin cylinders with balls at the joints read as a robot however good
// the kit on them.

const MAX_SOLDIERS = 96;

const L_UPPER_ARM = 0.29;
const L_FOREARM = 0.26;
const L_THIGH = 0.43;
const L_SHIN = 0.43;
const ANKLE_Y = 0.09;
const SPINE_M = 0.52;
const SHOULDER_HALF = 0.19;

/** The procedural soldier's measurements (castRig.ts: an MPFB character brings its own). */
const PROC_DIMS: Dims = {
  thigh: L_THIGH,
  shin: L_SHIN,
  upperArm: L_UPPER_ARM,
  forearm: L_FOREARM,
  ankleY: ANKLE_Y,
  standHip: 0.93,
  legScale: 1,
  hipJoint: new Vector3(0.1, -0.02, 0),
  shoulder: new Vector3(SHOULDER_HALF, SPINE_M - 0.06, 0),
};
/** The measurements of the man being posed (set per soldier in ActorView.update). */
let DIM: Dims = PROC_DIMS;
/** Beyond this distance a soldier is drawn from his far level of detail. */
const NEAR_M = 24;

/** One MPFB character's instanced draws: near and far levels, each with its own bone rows. */
interface CastView {
  rig: CastRig;
  lods: { mesh: InstancedMesh; bones: BoneTexture; far: boolean; n: number }[];
}

type Kind = 0 | 1 | 2 | 3 | 4;
const HARD: Kind = 0;
const PLAIN: Kind = 1;
const CAMO: Kind = 2;
/** The helmet's cover: the man's kit colour. */
const COVER: Kind = 3;
/** Recognition tape round the upper arms. */
const TAPE: Kind = 4;

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

export class ActorView {
  readonly group = new Group();
  private readonly body: InstancedMesh;
  private readonly rifle: InstancedMesh;
  private readonly bones = new BoneTexture(BONES.length, MAX_SOLDIERS);
  /** Inverse bind matrix per bone: the segment's frame in the bind pose (bindFrames). */
  private readonly unbind: Matrix4[];
  private readonly prevFeet: Vector3[] = [];
  private readonly currFeet: Vector3[] = [];
  private readonly walkPhase: number[] = [];
  /** Where each man is in his captured gait cycle, 0…1 (mocap.ts); 0 and ½ are the feet planted apart. */
  private readonly gait: number[] = [];
  private mocapA: MocapPose | null = null;
  private mocapB: MocapPose | null = null;
  /** The MPFB soldiers, when loaded (useCast): they replace the procedural body; the rifle stays. */
  private readonly cast: CastView[] = [];
  /** The current man's segments, posed, in the world (cast mode: retargeted by castRig.ts). */
  private readonly segW = BONES.map(() => new Matrix4());

  constructor() {
    this.group.name = 'actors';
    const geos = segmentGeometries();
    const bind = bindFrames();
    this.unbind = bind.map((m) => m.clone().invert());
    // Each man's kit (soldierMaterial): his camouflage, the colour of his carrier and pouches, how faded.
    const kit = (per: number): InstancedBufferAttribute => {
      const a = new Float32Array(MAX_SOLDIERS * per * 4);
      for (let i = 0; i < MAX_SOLDIERS * per; i++) a.set(kitFor(Math.floor(i / per)), i * 4);
      return new InstancedBufferAttribute(a, 4);
    };
    const bodyGeo = skinnedBody(geos, bind);
    bodyGeo.setAttribute('kit', kit(1));
    const skinned = soldierMaterial();
    skinned.positionNode = skinnedPosition(this.bones);
    this.body = new InstancedMesh(bodyGeo, skinned, MAX_SOLDIERS);
    // The rifle stays rigid: one more instanced mesh, placed from the same pose.
    geos.rifle.setAttribute('kit', kit(1));
    this.rifle = new InstancedMesh(geos.rifle, soldierMaterial(), MAX_SOLDIERS);
    for (const [mesh, name] of [[this.body, 'soldier-body'], [this.rifle, 'soldier-rifle']] as const) {
      mesh.name = name;
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // the men move every frame; bounds would go stale
      this.group.add(mesh);
    }
    for (let i = 0; i < MAX_SOLDIERS; i++) {
      this.prevFeet.push(new Vector3());
      this.currFeet.push(new Vector3());
      this.walkPhase.push(0);
      this.gait.push(0);
    }
  }

  /**
   * Draws the soldiers as the MPFB characters (mpfbCast.ts) from now on, each man always the same one of
   * them; with none, the procedural body stays.
   */
  useCast(characters: readonly CastCharacter[]): void {
    for (const c of characters) {
      const lods: CastView['lods'] = [];
      for (const [lod, far] of [
        [c.full, false],
        [c.far, true],
      ] as const) {
        if (!lod) continue;
        const bones = new BoneTexture(FULL_BONES.length, MAX_SOLDIERS);
        const mesh = new InstancedMesh(lod.geometry, castMaterial(lod.atlas, bones), MAX_SOLDIERS);
        mesh.name = `soldier-${c.name}${far ? '-far' : ''}`;
        mesh.count = 0;
        mesh.visible = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.group.add(mesh);
        lods.push({ mesh, bones, far, n: 0 });
      }
      this.cast.push({ rig: new CastRig(c.joints), lods });
    }
    if (this.cast.length) {
      this.body.visible = false;
      // Replaced for good: never drawn, so never warmed up either. It carries ten vertex attributes, more
      // vertex buffers than WebGPU's minimum of eight: the warm-up revealing it built a pipeline that failed.
      this.body.userData['noWarmup'] = true;
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

  /** Poses every soldier for this frame; `eye` (the camera) picks each MPFB soldier's level of detail. */
  update(soldiers: readonly Soldier[], alpha: number, frameSeconds: number, eye?: Vector3): void {
    const n = Math.min(soldiers.length, MAX_SOLDIERS);
    this.body.count = n;
    this.rifle.count = n;
    for (const cv of this.cast) for (const l of cv.lods) l.n = 0;
    for (let i = 0; i < n; i++) {
      const s = soldiers[i] as Soldier;
      const prev = this.prevFeet[i] as Vector3;
      const curr = (this.currFeet[i] as Vector3).set(s.body.position.x, s.body.position.y, s.body.position.z);
      _feet.copy(prev).lerp(curr, alpha);
      const moving = s.alive && s.stance !== 'prone';
      if (moving) this.walkPhase[i] = ((this.walkPhase[i] as number) + s.speedMs * frameSeconds * (s.stance === 'crouch' ? 4.2 : 3.2)) % (Math.PI * 2);
      _actor.makeRotationY(s.yawRad).setPosition(_feet);
      // Where the round went, in the man's own frame: the dead turn away from it as they fall.
      _deathLocal.set(s.deathDir.x, 0, s.deathDir.z).applyAxisAngle(_yAxis, -s.yawRad);
      const cv = this.cast.length ? (this.cast[Math.abs(s.id) % this.cast.length] as CastView) : null;
      DIM = cv ? cv.rig.dims : PROC_DIMS;
      if (moving) this.gait[i] = advanceGait(this.gait[i] as number, s, frameSeconds);
      this.pose(s, i, this.walkPhase[i] as number, this.gait[i] as number);
      if (cv) {
        const near = !eye || eye.distanceTo(_feet) < NEAR_M;
        const lod = (cv.lods.find((l) => l.far !== near) ?? cv.lods[cv.lods.length - 1]) as CastView['lods'][number];
        const row = lod.n++;
        cv.rig.skin(this.segW, (b, m) => lod.bones.set(row, b, m));
      }
    }
    DIM = PROC_DIMS;
    this.rifle.instanceMatrix.needsUpdate = true;
    if (this.cast.length) {
      for (const cv of this.cast) {
        for (const l of cv.lods) {
          l.mesh.count = l.n;
          l.mesh.visible = l.n > 0;
          if (l.n > 0) l.bones.commit();
        }
      }
    } else this.bones.commit();
  }

  // ---------------------------------------------------------------- posing (actor frame: −Z forward, +X right)

  /**
   * The captured gait (mocap.ts) for the hips, spine, head and legs: standing (walking and running blended
   * by speed, held with the feet apart when still) and moving crouched. Null where the pose stays built by
   * hand: kneeling still, prone, and before the clips have loaded.
   */
  private captured(s: Soldier, gait: number): MocapPose | null {
    if (!mocapReady()) return null;
    if (!this.mocapA || !this.mocapB) {
      this.mocapA = new MocapPose();
      this.mocapB = new MocapPose();
    }
    if (!s.alive) return this.mocapA.sample('fall', s.deathSeconds).solve();
    if (s.stance === 'prone' || (s.stance === 'crouch' && s.speedMs < 0.3)) return null;
    if (s.stance === 'crouch') return this.mocapA.sample('crouch', gait * clipDuration('crouch')).solve();
    this.mocapA.sample('walk', gait * clipDuration('walk'));
    const run = smooth(1.9, 2.9, s.speedMs);
    if (run > 0) this.mocapA.blend(this.mocapB.sample('run', gait * clipDuration('run')), run);
    return this.mocapA.solve();
  }

  private pose(s: Soldier, i: number, phase: number, gait: number): void {
    const cap = this.captured(s, gait);
    if (cap) {
      this.poseCaptured(s, i, cap);
      return;
    }
    const stance = s.alive ? s.stance : 'stand';
    const stride = s.alive && stance !== 'prone' ? Math.min(1, s.speedMs / 3) * (stance === 'crouch' ? 0.2 : 0.34) : 0;
    // Standing still the feet take a stance — apart, the left forward, the knees soft — fading into the
    // stride as he moves: both feet together and the legs locked read as a mannequin.
    const still = s.alive && stance === 'stand' ? 1 - Math.min(1, s.speedMs / 0.6) : 0;
    const stagger = still * (s.state === 'patrol' ? 0.5 : 1);
    // Hips and spine for the stance (hitbox layout: chest 1.30 / 0.82 / 0.18 m, head 1.62 / 1.10 / 0.30 m).
    if (stance === 'stand') {
      _hip.set(0, DIM.standHip - stride * 0.06 * Math.abs(Math.sin(phase)) - still * 0.035, 0);
      _up.set(0, 1, -0.09 - stride * 0.25).normalize();
    } else if (stance === 'crouch') {
      _hip.set(0, 0.5 * DIM.legScale, 0.03);
      _up.set(0, 1, -0.32).normalize();
    } else {
      _hip.set(0, 0.17, 0.08);
      _up.set(0, 0.1, -1).normalize();
    }
    _right.set(1, 0, 0);
    _front.crossVectors(_up, _right).normalize();
    // Fall: the whole pose tips forward about the feet over ~0.7 s, gathering speed, and lies prone.
    _fall.identity();
    if (!s.alive) {
      const t = Math.min(1, s.deathSeconds / 0.7);
      const a = t * t * (Math.PI / 2 - 0.08);
      _fall.makeTranslation(0, 0.1 * t, 0).multiply(_rot.makeRotationX(-a));
    }

    this.place('pelvis', i, 0, _hip, _up, _front);
    _pelvisQ.setFromRotationMatrix(frame(_rotM, _hip, _up, _front));
    this.armsAndRifle(s, i, stance);

    // Legs.
    for (const side of [0, 1] as const) {
      const sx = side === 1 ? 1 : -1;
      hipJointOf(_hip, _pelvisQ, side, _hipJoint);
      _bootFront.set(0, 0, -1);
      _bootUp.set(0, 1, 0);
      if (stance === 'prone') {
        _foot.set(sx * 0.17, 0.1, 0.95);
        _pole.set(0, -1, 0.2);
        _bootFront.set(0, -1, 0.3).normalize();
        _bootUp.set(0, 0.3, 1).normalize();
      } else if (stance === 'crouch') {
        if (side === 0) {
          _foot.set(-0.14, DIM.ankleY, -0.34);
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
        _foot.set(sx * (0.11 + 0.05 * still), DIM.ankleY + lift, -swing * stride + (side === 0 ? -0.2 : 0.15) * stagger);
        _pole.set(0, 0.1, -1);
        // The rear foot turned out, as it is in a shooting stance.
        _bootFront.set(side === 1 ? 0.55 * stagger : -0.1 * stagger, lift * 0.8, -1).normalize();
      }
      this.limb('thigh', 'shin', i, side, _hipJoint, _foot, DIM.thigh, DIM.shin, _pole);
      this.place('boot', i, side, _end, _bootUp, _bootFront);
    }
  }

  /**
   * Torso, head, rifle and arms on the hips and spine already set (`_hip`, `_up`, `_right`, `_front`): the
   * head and rifle on the aim (low ready on patrol), the torso bladed behind the rifle, the hands reaching
   * its grips by two-bone IK.
   */
  private armsAndRifle(s: Soldier, i: number, stance: Soldier['stance']): void {
    // Aim: the head and the rifle follow it; on patrol the rifle hangs at low ready.
    const pitch = s.alive ? s.pitchRad : 0;
    _aim.set(0, Math.sin(pitch), -Math.cos(pitch));
    const lowReady = s.alive && s.state === 'patrol';
    if (lowReady) _rifleDir.set(0.25, -0.62, -0.75).normalize();
    else _rifleDir.copy(_aim);

    // Holding a rifle the torso is bladed: turned ~35° to bring the left shoulder forward, so the support
    // hand reaches the handguard (less at low ready, none prone).
    const blade = stance === 'prone' ? 0 : lowReady ? 0.25 : 0.6;
    _tRight.copy(_right).applyAxisAngle(_up, blade);
    _tFront.crossVectors(_up, _tRight).normalize();
    this.place('torso', i, 0, _hip, _up, _tFront);
    _neck.copy(_hip).addScaledVector(_up, SPINE_M);
    _headUp.set(0, 1, 0).addScaledVector(_aim, -_aim.y).normalize();
    _head.copy(_neck).addScaledVector(_up, 0.1).addScaledVector(_headUp, 0.04);
    this.place('head', i, 0, _head, _headUp, _aim);

    // Rifle: butt in the right shoulder pocket, along the aim.
    _torsoQ.setFromRotationMatrix(frame(_rotM, _hip, _up, _tFront));
    shoulderOf(_hip, _torsoQ, 1, _shoulderR);
    shoulderOf(_hip, _torsoQ, 0, _shoulderL);
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
    this.limb('upperArm', 'forearm', i, 1, _shoulderR, _gripR, DIM.upperArm, DIM.forearm, _pole);
    this.placeHand(i, 1, _gripR, _rifleDir);
    _pole.copy(_tRight).multiplyScalar(-0.9).addScaledVector(_up, -1);
    this.limb('upperArm', 'forearm', i, 0, _shoulderL, _gripL, DIM.upperArm, DIM.forearm, _pole);
    this.placeHand(i, 0, _gripL, _rifleDir);

  }

  /**
   * A pose from the capture: the hips, spine and legs as captured (each body part turned from the bind
   * pose by its bone's rotation from the T-pose, on this body's own lengths, the planted foot on the
   * ground), the head and the rifle on the aim and the arms reaching the rifle by IK as before. The dead
   * fall as captured, arms too, the rifle still in the right hand.
   */
  private poseCaptured(s: Soldier, i: number, cap: MocapPose): void {
    const D = (name: string): Quaternion => cap.delta[boneIndex(name)] as Quaternion;
    _fall.identity();
    if (!s.alive) {
      // The capture falls back. Turned toward where the round went (at most a quarter turn), over the
      // first moments, as a hit spins a man: shot from the side he twists and goes down sideways.
      const a = Math.max(-1.6, Math.min(1.6, Math.atan2(_deathLocal.x, _deathLocal.z)));
      _fall.makeRotationY(a * smooth(0, 0.45, s.deathSeconds));
    }
    // The legs first, at the captured hip height, to find how far the planted foot sits off the ground.
    const legs = (hip: Vector3): number => {
      let low = Infinity;
      for (const side of [0, 1] as const) {
        const L = side === 0 ? 'Left' : 'Right';
        hipJointOf(hip, D('Hips'), side, _hipJoint);
        _dir.set(0, -1, 0).applyQuaternion(D(`${L}UpLeg`));
        _mid.copy(_hipJoint).addScaledVector(_dir, DIM.thigh);
        _dir.set(0, -1, 0).applyQuaternion(D(`${L}Leg`));
        _end.copy(_mid).addScaledVector(_dir, DIM.shin);
        low = Math.min(low, _end.y);
      }
      return low;
    };
    _hip.copy(cap.hips);
    if (s.alive) _hip.y += DIM.ankleY - legs(_hip);
    else _hip.y += 0.04; // the capture's floor sits 4 cm under its toes' origin
    for (const side of [0, 1] as const) {
      const L = side === 0 ? 'Left' : 'Right';
      hipJointOf(_hip, D('Hips'), side, _hipJoint);
      _dir.set(0, -1, 0).applyQuaternion(D(`${L}UpLeg`));
      _mid.copy(_hipJoint).addScaledVector(_dir, DIM.thigh);
      this.place('thigh', i, side, _hipJoint, _tmpUp.copy(_dir).negate(), _front.set(0, 0, -1).applyQuaternion(D(`${L}UpLeg`)));
      _dir.set(0, -1, 0).applyQuaternion(D(`${L}Leg`));
      _end.copy(_mid).addScaledVector(_dir, DIM.shin);
      this.place('shin', i, side, _mid, _tmpUp.copy(_dir).negate(), _front.set(0, 0, -1).applyQuaternion(D(`${L}Leg`)));
      this.place('boot', i, side, _end, _bootUp.set(0, 1, 0).applyQuaternion(D(`${L}Foot`)), _bootFront.set(0, 0, -1).applyQuaternion(D(`${L}Foot`)));
    }
    this.place('pelvis', i, 0, _hip, _up.set(0, 1, 0).applyQuaternion(D('Hips')), _front.set(0, 0, -1).applyQuaternion(D('Hips')));
    // Torso from the chest's rotation.
    _up.set(0, 1, 0).applyQuaternion(D('Spine1'));
    _right.set(1, 0, 0).applyQuaternion(D('Spine1'));
    if (!s.alive) {
      _front.crossVectors(_up, _right).normalize();
      this.place('torso', i, 0, _hip, _up, _front);
      _neck.copy(_hip).addScaledVector(_up, SPINE_M + 0.1);
      _headUp.set(0, 1, 0).applyQuaternion(D('Head'));
      this.place('head', i, 0, _head.copy(_neck).addScaledVector(_headUp, 0.04), _headUp, _aim.set(0, 0, -1).applyQuaternion(D('Head')));
      // Arms as captured: the T-pose arm points out to its side, so its segment's +Y points back in.
      for (const side of [0, 1] as const) {
        const L = side === 0 ? 'Left' : 'Right';
        const sx = side === 1 ? 1 : -1;
        const shoulder = side === 1 ? _shoulderR : _shoulderL;
        shoulderOf(_hip, D('Spine1'), side, shoulder);
        let at = shoulder;
        for (const [seg, bone, len] of [['upperArm', 'Arm', DIM.upperArm], ['forearm', 'ForeArm', DIM.forearm], ['hand', 'Hand', 0]] as const) {
          _tmpUp.set(-sx, 0, 0).applyQuaternion(D(`${L}${bone}`));
          // A segment's front is its elbow's point (back, in the capture's T-pose) or the hand's thumb
          // (forward); the procedural tubes do not show the difference, the MPFB arms would twist.
          const front = this.cast.length && seg !== 'hand' ? 1 : -1;
          this.place(seg, i, side, at, _tmpUp, _bootFront.set(0, 0, front).applyQuaternion(D(`${L}${bone}`)));
          at = (seg === 'upperArm' ? _mid : _end).copy(at).addScaledVector(_tmpUp, -len);
        }
        if (side === 1) _gripR.copy(_end);
      }
      // The rifle goes down in the right hand, along the forearm, and leaves it as he hits the ground: the
      // capture ends with the forearms raised, and a rifle still along one stood up off the body.
      _rifleDir.set(1, 0, 0).applyQuaternion(D('RightForeArm'));
      _rifleUp.set(0, 1, 0).applyQuaternion(D('RightHand'));
      _rifleO.copy(_gripR).addScaledVector(_rifleUp, 0.17).addScaledVector(_rifleDir, 0.18);
      const drop = smooth(0.3, 0.75, s.deathSeconds);
      _rifleO.lerp(DROPPED_O, drop);
      _rifleDir.lerp(DROPPED_DIR, drop);
      _rifleUp.lerp(DROPPED_UP, drop);
      this.place('rifle', i, 0, _rifleO, _rifleUp, _rifleDir);
      return;
    }
    _front.crossVectors(_up, _right).normalize();
    this.armsAndRifle(s, i, s.stance);
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
    const b = boneOf(seg, side);
    // An MPFB soldier: the frame itself, retargeted onto his skeleton after the whole pose (castRig.ts).
    if (this.cast.length) {
      (this.segW[b] as Matrix4).copy(_m);
      return;
    }
    // The segment's frame is its bone: world × inverse bind takes the bind-pose skin to here.
    this.bones.set(i, b, _m.multiply(this.unbind[b] as Matrix4));
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

/** The hip joint of `side` on the pelvis at `hip` turned by `pelvis` (the actor's frame). */
function hipJointOf(hip: Vector3, pelvis: Quaternion, side: 0 | 1, out: Vector3): Vector3 {
  const h = DIM.hipJoint;
  return out.set(side === 1 ? h.x : -h.x, h.y, h.z).applyQuaternion(pelvis).add(hip);
}

/** The shoulder joint of `side` on the trunk at `hip` turned by `trunk` (the actor's frame). */
function shoulderOf(hip: Vector3, trunk: Quaternion, side: 0 | 1, out: Vector3): Vector3 {
  const s = DIM.shoulder;
  return out.set(side === 1 ? s.x : -s.x, s.y, s.z).applyQuaternion(trunk).add(hip);
}

/**
 * An MPFB soldier's material: his atlas (mpfbCast.ts) with the hair's cut-out, the baked occlusion on the
 * indirect light, each piece's roughness, a sheen on cloth, and mud on the boots and trouser legs as on
 * the procedural men (field soldiers are never clean below the knee).
 */
function castMaterial(atlas: Texture, bones: BoneTexture): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'soldier-cast', metalness: 0, side: DoubleSide });
  const t = texture(atlas, uv());
  const y = positionGeometry.y;
  const mud = smoothstep(0.42, 0.04, y).mul(0.55).mul(smoothstep(0.35, 0.65, mx_noise_float(positionGeometry.mul(7)).mul(0.5).add(0.5)).mul(0.6).add(0.4));
  const colour = mix(t.rgb, vec3(0.11, 0.09, 0.065), mud);
  m.colorNode = colour;
  m.opacityNode = t.a;
  m.alphaTest = 0.5;
  m.roughnessNode = mix(attribute('rough', 'float'), float(0.95), mud);
  m.aoNode = attribute('ao', 'float');
  m.sheenNode = colour.mul(attribute('cloth', 'float').mul(0.4));
  m.sheenRoughness = 0.7;
  m.positionNode = skinnedPosition(bones);
  return m;
}

/**
 * The next point in a man's captured gait cycle (0…1): on at his ground speed over the cycle's stride
 * (walk and run strides blended as their poses are), so the feet do not slide. Stopping, he walks on to
 * the next moment both feet are planted apart (0 or ½) and holds it — a stance, not a frozen mid-stride.
 */
function advanceGait(g: number, s: Soldier, dt: number): number {
  if (!mocapReady()) return g;
  const v = s.speedMs;
  if (s.stance === 'crouch') return v < 0.3 ? g : (g + (dt * v) / (clipSpeed('crouch') * clipDuration('crouch'))) % 1;
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
 * the neck and the shoulders bends with both bones instead of two capsules sliding through each other.
 */
function shares(bone: number, p: Vector3): [number, number][] {
  const { seg, side } = BONES[bone] as (typeof BONES)[number];
  const y = p.y;
  const parent = (BONES[bone] as (typeof BONES)[number]).parent;
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
  void side;
}

/** Every segment in the bind pose as one skin: up to four bones and weights per vertex (skinning.ts). */
function skinnedBody(geos: Record<Segment, BufferGeometry>, bind: readonly Matrix4[]): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const idx: number[][] = [];
  const wgt: number[][] = [];
  const v = new Vector3();
  BONES.forEach(({ seg }, bone) => {
    const g = (geos[seg] as BufferGeometry).clone();
    const pos = g.getAttribute('position');
    const bi = new Float32Array(pos.count * 4);
    const bw = new Float32Array(pos.count * 4);
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
      list.forEach(([b, w], k) => {
        bi[i * 4 + k] = b;
        bw[i * 4 + k] = w / sum;
      });
    }
    g.applyMatrix4(bind[bone] as Matrix4);
    parts.push(g);
    idx.push(Array.from(bi));
    wgt.push(Array.from(bw));
  });
  const out = joined(parts, 'soldier body');
  out.setAttribute('skinIdx', new BufferAttribute(new Float32Array(idx.flat()), 4));
  out.setAttribute('skinWgt', new BufferAttribute(new Float32Array(wgt.flat()), 4));
  return out;
}

// ------------------------------------------------------------------ material

/**
 * One man's kit, from his slot: [camouflage scheme 0…4, kit colour 0…3, unused, fading 0…1]. A squad of
 * identical men in one woodland pattern read as clones, and as a dark green smear against a city.
 */
function kitFor(i: number): [number, number, number, number] {
  const h = (k: number): number => {
    let x = Math.imul(i * 374761393 + k * 668265263, 1274126177);
    x ^= x >>> 15;
    return ((x >>> 0) % 10000) / 10000;
  };
  return [Math.floor(h(1) * CAMO_SCHEMES.length), Math.floor(h(2) * KIT_COLOURS.length), 0, h(3)];
}

type Rgb = [number, number, number];
/** Camouflage schemes (linear): base, second, dark, light — woodland, multi-terrain, urban, arid, plain green. */
const CAMO_SCHEMES: [Rgb, Rgb, Rgb, Rgb][] = [
  [
    [0.1, 0.11, 0.065],
    [0.13, 0.12, 0.07],
    [0.045, 0.05, 0.035],
    [0.19, 0.17, 0.11],
  ],
  [
    [0.22, 0.18, 0.12],
    [0.12, 0.09, 0.06],
    [0.09, 0.1, 0.055],
    [0.32, 0.29, 0.22],
  ],
  [
    [0.16, 0.16, 0.16],
    [0.27, 0.27, 0.26],
    [0.035, 0.035, 0.04],
    [0.4, 0.4, 0.38],
  ],
  [
    [0.3, 0.25, 0.17],
    [0.24, 0.19, 0.13],
    [0.17, 0.13, 0.09],
    [0.38, 0.33, 0.24],
  ],
  [
    [0.065, 0.075, 0.05],
    [0.075, 0.085, 0.055],
    [0.05, 0.06, 0.04],
    [0.085, 0.09, 0.06],
  ],
];
/** Plate carrier, pouches and helmet cover (linear): ranger green, coyote, black, olive drab. */
const KIT_COLOURS: Rgb[] = [
  [0.06, 0.075, 0.05],
  [0.24, 0.18, 0.11],
  [0.03, 0.03, 0.033],
  [0.14, 0.13, 0.08],
];

/** The entry of `list` at index `i` (a float node holding a whole number), by a chain of steps. */
function pickRgb(i: Node<'float'>, list: readonly Rgb[]): Node<'vec3'> {
  let out: Node<'vec3'> = vec3(...(list[0] as Rgb));
  for (let k = 1; k < list.length; k++) out = mix(out, vec3(...(list[k] as Rgb)), step(k - 0.5, i));
  return out;
}

function soldierMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'soldier', metalness: 0, sheenRoughness: 0.8 });
  const tint = attribute('tint', 'vec3');
  const kind = attribute('kind', 'float');
  const kit = attribute('kit', 'vec4');
  const is = (k: number): Node<'float'> => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const camo = is(CAMO);
  const fabric = is(PLAIN).add(camo).add(is(COVER));
  // Blotches in each segment's own space: positionGeometry, as positionLocal is already instanced and the
  // pattern would crawl as he moves. The scheme is the man's own (kitFor), faded a little or a lot.
  const p = positionGeometry.mul(6.5);
  const n1 = mx_noise_float(p);
  const n2 = mx_noise_float(p.mul(1.7).add(vec3(3.1, 7.7, 1.3)));
  const pick = (k: number): Node<'vec3'> => pickRgb(kit.x, CAMO_SCHEMES.map((s) => s[k] as Rgb));
  const fade = kit.w.mul(0.3).add(0.85);
  const pattern = mix(mix(mix(pick(0), pick(1), step(0.18, n1)), pick(2), step(0.32, n2)), pick(3), step(0.42, n1.mul(-1))).mul(fade);
  // Carrier, pouches, webbing and pack in the man's kit colour, each keeping its own shade of it; the
  // helmet cover too.
  const kitColour = pickRgb(kit.y, KIT_COLOURS);
  const lum = (c: Node<'vec3'>): Node<'float'> => c.dot(vec3(0.2126, 0.7152, 0.0722));
  const plain = kitColour.mul(lum(tint).div(0.075).clamp(0.45, 1.6));
  // Recognition tape: a faded red, as forces in the field wrap round their arms to tell friend from foe.
  const tape = vec3(0.34, 0.035, 0.03);
  let base: Node<'vec3'> = mix(tint, pattern, camo);
  base = mix(base, plain, is(PLAIN));
  base = mix(base, kitColour, is(COVER));
  base = mix(base, tape, is(TAPE));
  // Mud and dust where they collect, in blotches: dried light dust over darker wet mud.
  const grime = attribute('grime', 'float');
  const blot = smoothstep(-0.2, 0.45, mx_noise_float(positionGeometry.mul(23)).add(grime.mul(0.9).sub(0.45)));
  const mud = mix(vec3(0.07, 0.055, 0.04), vec3(0.2, 0.17, 0.13), smoothstep(0.1, 0.6, mx_noise_float(positionGeometry.mul(9))));
  const colour = mix(base, mud, blot.mul(grime)).mul(attribute('shade', 'float'));
  m.colorNode = colour;
  m.roughnessNode = mix(float(0.6), float(0.9), fabric.max(blot.mul(grime)));
  // Sheen colour × intensity (three's sheenNode is the product): cloth only.
  m.sheenNode = colour.mul(fabric.mul(0.4));
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

function segmentGeometries(): Record<Segment, BufferGeometry> {
  const pelvis = joined(
    [
      // Hips and seat of the trousers: wide at the hip joints, the seat behind, narrowing to the crotch.
      tag(
        loft([
          [0.1, 0.155, 0.115, 0],
          [0.03, 0.18, 0.13, 0.005],
          [-0.04, 0.185, 0.135, 0.012],
          [-0.1, 0.16, 0.12, 0.01],
          [-0.14, 0.09, 0.08, 0.0],
        ]),
        C.uniform,
        CAMO,
      ),
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
      tag(new SphereGeometry(0.074, 12, 9).scale(1, 0.9, 1).translate(-SHOULDER_HALF, SPINE_M - 0.06, 0), C.uniform, CAMO),
      tag(new SphereGeometry(0.074, 12, 9).scale(1, 0.9, 1).translate(SHOULDER_HALF, SPINE_M - 0.06, 0), C.uniform, CAMO),
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
      tag(headGeometry(), C.balaclava, PLAIN),
      tag(helmet, C.khaki, COVER),
      // High cut over the ears: the shell's rim, side rails and the NVG mount on the front.
      tag(new CylinderGeometry(0.122, 0.124, 0.012, 18, 1, true).scale(0.95, 1, 1.05).translate(0, 0.022, 0.005), C.khaki, COVER),
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
  // Sleeves: the upper arm full at the deltoid and biceps, the forearm tapering to a cuff over the glove.
  const upperArm = joined(
    [
      tag(
        clothLimb(
          L_UPPER_ARM,
          [
            [0, 0.066],
            [0.25, 0.062],
            [0.7, 0.053],
            [1, 0.048],
          ],
          0.92,
          [
            [0.12, 0.08, 0.004],
            [0.92, 0.07, 0.006],
          ],
          1,
        ),
        C.uniform,
        CAMO,
      ),
      // Recognition tape wound round the arm below the shoulder.
      tag(new CylinderGeometry(0.0655, 0.064, 0.038, 14, 1, true).scale(1, 1, 0.93).translate(0, -L_UPPER_ARM * 0.28, 0), 0x000000, TAPE),
    ],
    'upperArm',
  );
  const forearm = joined(
    [
      tag(
        clothLimb(
          L_FOREARM,
          [
            [0, 0.052],
            [0.3, 0.051],
            [0.85, 0.041],
            [1, 0.04],
          ],
          0.85,
          [
            [0.08, 0.08, 0.005],
            [0.88, 0.06, 0.004],
          ],
          2,
        ),
        C.uniform,
        CAMO,
      ),
      tag(new SphereGeometry(1, 10, 6).scale(0.048, 0.052, 0.032).translate(0, -0.015, -0.04), C.rubber, HARD, 0.3),
      tag(new CylinderGeometry(0.041, 0.038, 0.045, 12).translate(0, -L_FOREARM + 0.012, 0), C.glove, HARD),
    ],
    'forearm',
  );
  const hand = joined(
    [
      // Gloved: the palm and knuckles, the curled fingers as one roll across the front, the thumb along the side.
      tag(new SphereGeometry(1, 12, 8).scale(0.043, 0.052, 0.025).translate(0, -0.046, 0), C.glove, HARD),
      tag(new CapsuleGeometry(0.016, 0.054, 3, 8).rotateZ(Math.PI / 2).translate(0, -0.09, -0.013), C.glove, HARD),
      tag(new CapsuleGeometry(0.012, 0.036, 2, 6).rotateZ(0.5).translate(-0.037, -0.05, -0.022), C.glove, HARD),
    ],
    'hand',
  );
  // Trousers: loose, full at the top of the thigh, folds at the crotch and behind the knee. Cargo pockets on
  // both sides: the left thigh is the same mesh as the right one.
  const thighGrime = (y: number): number => Math.max(0, (-y - L_THIGH * 0.7) / (L_THIGH * 0.3)) * 0.45;
  const thigh = joined(
    [
      tag(
        clothLimb(
          L_THIGH,
          [
            [0, 0.095],
            [0.15, 0.092],
            [0.55, 0.079],
            [0.88, 0.066],
            [1, 0.064],
          ],
          0.94,
          [
            [0.1, 0.07, 0.005],
            [0.92, 0.07, 0.007],
          ],
          3,
        ),
        C.uniform,
        CAMO,
        thighGrime,
      ),
      ...[-1, 1].map((sx) => tag(new BoxGeometry(0.035, 0.15, 0.13).translate(sx * 0.082, -0.23, 0.0), C.uniform, CAMO)),
      ...[-1, 1].map((sx) => tag(new BoxGeometry(0.04, 0.03, 0.135).translate(sx * 0.084, -0.15, 0.0), C.uniform, CAMO)),
    ],
    'thigh',
  );
  // The shin: the trouser leg bunched ("bloused") over the boot top, mud splashed up from it.
  const shinGrime = (y: number): number => 0.25 + Math.max(0, (-y - L_SHIN * 0.45) / (L_SHIN * 0.55)) * 0.75;
  const shin = joined(
    [
      tag(
        clothLimb(
          L_SHIN,
          [
            [0, 0.067],
            [0.3, 0.068],
            [0.7, 0.06],
            [0.86, 0.063],
            [1, 0.058],
          ],
          0.95,
          [
            [0.06, 0.07, 0.005],
            [0.84, 0.08, 0.008],
          ],
          4,
        ),
        C.uniform,
        CAMO,
        shinGrime,
      ),
      tag(new SphereGeometry(1, 12, 8).scale(0.06, 0.075, 0.038).translate(0, -0.035, -0.055), C.rubber, HARD, 0.55), // knee pad
      tag(new CylinderGeometry(0.06, 0.064, 0.11, 14).translate(0, -L_SHIN + 0.045, 0), C.boot, HARD, 0.8), // boot top
    ],
    'shin',
  );
  const [bootUpper, sole] = bootGeometry() as [BufferGeometry, BufferGeometry];
  const boot = joined([tag(bootUpper, C.boot, HARD, (y) => 0.55 + Math.max(0, -y) * 4), tag(sole, C.rubber, HARD, 0.9)], 'boot');
  return { pelvis, torso, head, upperArm, forearm, hand, thigh, shin, boot, rifle: rifleGeometry() };
}

/**
 * The player's carbine (weaponModels.ts) merged into one dark geometry, without its optic glass, cut without
 * bevels (gunkit.ts): every soldier carries one, and at their distance a bevel is under a pixel.
 */
function rifleGeometry(): BufferGeometry {
  const model = coarseParts(() => buildRifle({ procedural: true }));
  model.root.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  model.root.traverse((o) => {
    if (!(o instanceof Mesh) || o === model.dotLens || o.name === 'optic front') return;
    parts.push(tag(o.geometry.clone().applyMatrix4(o.matrixWorld), o.name === 'furniture' || o.name === 'magazine' ? 0x262628 : C.rifle, HARD));
  });
  return joined(parts, 'soldier rifle');
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
const _rotM = new Matrix4();
const _pelvisQ = new Quaternion();
const _torsoQ = new Quaternion();
const _rot = new Matrix4();
const _m = new Matrix4();
const _feet = new Vector3();
const _deathLocal = new Vector3();
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
