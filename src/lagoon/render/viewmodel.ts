import { Euler, Group, Mesh, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { clamp, damp, smoothstep } from '../../core/vec.ts';
import { STONE } from '../config.ts';
import type { LagoonGame } from '../game/game.ts';
import { Arm, copyPose, mixPose, POSES } from './arms.ts';
import { buildKnife, buildRifle, type KnifeModel, type RifleModel, stoneGeometry, WEAPON_MATERIALS } from './weaponModels.ts';

// The first-person rig: two IK arms and whatever the hands hold, in camera
// space, scaled down about the eye (VM_SCALE) so it sits inside the player's
// capsule and never pokes through a wall — the picture is identical. It stays
// in the world scene, so it receives the sun's shadows: step under the tarp
// and the hands go into shade.
//
// Every motion is a function of logic state (action, progress, stride, look)
// plus a few damped springs, so it is smooth at any frame rate.

export const VM_SCALE = 0.25;

type Key = readonly [t: number, x: number, y: number, z: number, rx: number, ry: number, rz: number];

interface Target {
  pos: Vector3;
  rot: Euler;
}

/** Piecewise smooth interpolation through keys sorted by t. */
function sample(keys: readonly Key[], t: number, out: Target): Target {
  let i = 0;
  while (i < keys.length - 2 && t > (keys[i + 1] as Key)[0]) i++;
  const a = keys[i] as Key;
  const b = keys[Math.min(keys.length - 1, i + 1)] as Key;
  const k = b[0] > a[0] ? smoothstep(0, 1, (t - a[0]) / (b[0] - a[0])) : 1;
  out.pos.set(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
  out.rot.set(a[4] + (b[4] - a[4]) * k, a[5] + (b[5] - a[5]) * k, a[6] + (b[6] - a[6]) * k);
  return out;
}

// Wrist targets (camera space) and hand orientations for each hold.
const REST_R: Key = [0, 0.2, -0.27, -0.38, 0.35, 0.25, -1.25];
const REST_L: Key = [0, -0.2, -0.28, -0.39, 0.35, -0.25, 1.25];
const STONE_HOLD: Key = [0, 0.16, -0.2, -0.33, 0.75, 0.15, -2.6];
const KNIFE_HOLD: Key = [0, 0.17, -0.2, -0.32, 0.55, 0.15, -1.35];
const RIFLE_HIP = { pos: new Vector3(0.1, -0.095, -0.26), rot: new Euler(0.0, 0.04, -0.06) };
const RIFLE_SPRINT = { pos: new Vector3(0.1, -0.24, -0.24), rot: new Euler(-0.45, 0.75, 0.3) };

const THROW: readonly Key[] = [
  [0, 0.3, 0.03, 0.0, -0.4, 0.1, -2.6], // released from the wind-up behind the shoulder
  [0.4, 0.1, -0.02, -0.62, 0.5, 0.0, -2.2], // arm forward, stone leaves the hand
  [0.7, -0.08, -0.34, -0.45, 1.0, -0.2, -1.6], // follow-through across the body
  [1, 0.2, -0.25, -0.37, 0.55, 0.15, -2.5],
];
const SLASH: readonly Key[] = [
  [0, 0.19, -0.24, -0.33, 0.35, 0.1, -1.35],
  [0.22, 0.33, -0.08, -0.22, -0.2, 0.7, -1.9], // cocked back high right
  [0.45, 0.03, -0.2, -0.56, 0.4, -0.3, -0.9], // blade through the centre
  [0.7, -0.24, -0.36, -0.38, 0.8, -0.9, -0.4], // finished low left
  [1, 0.19, -0.24, -0.33, 0.35, 0.1, -1.35],
];
const BACKHAND: readonly Key[] = [
  [0, 0.19, -0.24, -0.33, 0.35, 0.1, -1.35],
  [0.22, -0.12, -0.12, -0.3, 0.1, -0.7, -0.6],
  [0.45, 0.08, -0.22, -0.56, 0.3, 0.2, -1.6],
  [0.7, 0.34, -0.33, -0.36, 0.7, 0.8, -2.1],
  [1, 0.19, -0.24, -0.33, 0.35, 0.1, -1.35],
];
const REACH_R: readonly Key[] = [
  [0, 0.2, -0.27, -0.38, 0.35, 0.25, -1.25],
  [0.5, 0.06, -0.52, -0.55, 1.2, 0.1, -1.3],
  [0.62, 0.06, -0.5, -0.53, 1.2, 0.1, -1.3],
  [1, 0.2, -0.27, -0.38, 0.35, 0.25, -1.25],
];
const HARVEST_R: readonly Key[] = [
  [0, 0.2, -0.27, -0.38, 0.35, 0.25, -1.25],
  [0.45, 0.07, -0.54, -0.52, 1.3, 0.2, -1.1],
  [0.62, 0.07, -0.52, -0.5, 1.3, 0.2, -1.1],
  [0.78, 0.12, -0.36, -0.36, 0.8, 0.3, -1.4], // the tug
  [1, 0.2, -0.27, -0.38, 0.35, 0.25, -1.25],
];
const HARVEST_L: readonly Key[] = [
  [0, -0.2, -0.28, -0.39, 0.35, -0.25, 1.25],
  [0.45, -0.08, -0.55, -0.5, 1.2, -0.2, 1.1],
  [0.7, -0.1, -0.5, -0.46, 1.1, -0.2, 1.1],
  [1, -0.2, -0.28, -0.39, 0.35, -0.25, 1.25],
];
const CRATE_R: readonly Key[] = [
  [0, 0.2, -0.27, -0.38, 0.35, 0.25, -1.25],
  [0.3, 0.17, -0.42, -0.56, 1.35, 0.0, -0.1],
  [0.8, 0.16, -0.08, -0.62, -0.2, 0.0, -0.1],
  [1, 0.2, -0.27, -0.38, 0.35, 0.25, -1.25],
];

export class ViewModel {
  readonly root = new Group();
  private readonly pivot = new Group();
  readonly right = new Arm(1);
  readonly left = new Arm(-1);
  readonly rifle: RifleModel;
  readonly knife: KnifeModel;
  private readonly stone: Mesh;
  private readonly flashAnchor = new Object3D();
  private shown: 'hands' | 'rifle' | 'knife' | 'stone' = 'hands';
  private sprint = 0;
  private away = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  private breath = 0;
  private walkK = 0;
  private readonly poseR = copyPose(POSES.relaxed);
  private readonly poseL = copyPose(POSES.relaxed);
  private readonly tR: Target = { pos: new Vector3(), rot: new Euler() };
  private readonly tL: Target = { pos: new Vector3(), rot: new Euler() };
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly m = new Vector3();
  private readonly rot = new Euler();
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();
  private readonly dir = new Vector3();
  private static readonly GRIP_R = new Euler(0.4, 0, -Math.PI / 2);
  private static readonly GRIP_L = new Euler(0, -Math.PI / 2, Math.PI);

  constructor() {
    this.root.name = 'viewmodel';
    this.root.scale.setScalar(VM_SCALE);
    this.rifle = buildRifle();
    this.knife = buildKnife();
    this.stone = new Mesh(stoneGeometry(11), WEAPON_MATERIALS.stone);
    this.pivot.add(this.rifle.root);
    this.rifle.root.add(this.flashAnchor);
    this.flashAnchor.position.copy(this.rifle.muzzle);
    // The knife sits across the curled fingers, blade out past the thumb.
    this.knife.root.position.set(-0.004, -0.024, -0.058);
    this.knife.root.rotation.set(0, Math.PI / 2, 0);
    this.right.hand.root.add(this.knife.root);
    this.stone.position.set(0, -0.034, -0.058);
    this.right.hand.root.add(this.stone);
    this.root.add(this.pivot, this.right.root, this.left.root);
    this.root.traverse((o) => {
      if (o instanceof Mesh) {
        o.castShadow = false;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });
  }

  /** The rifle's muzzle, for the flash (child of the rifle, so it rides the recoil). */
  get muzzleAnchor(): Object3D {
    return this.flashAnchor;
  }

  update(game: LagoonGame, dt: number, lookYawRad: number, lookPitchRad: number): void {
    const eq = game.equipment;
    const a = eq.action;
    const p = game.player;
    const t = eq.progress;
    dt = Math.max(1e-4, dt);
    // During a switch the old tool lowers, then the new one rises.
    if (a.kind !== 'lower') this.shown = eq.slot;
    const handsBusy = a.kind === 'pickup' || a.kind === 'harvest' || a.kind === 'openCrate';
    this.away = damp(this.away, handsBusy ? 1 : 0, 9, dt);
    this.sprint = damp(this.sprint, p.sprinting ? 1 : 0, 7, dt);
    this.lagYaw = clamp(damp(this.lagYaw, lookYawRad * 0.9, 11, dt), -0.07, 0.07);
    this.lagPitch = clamp(damp(this.lagPitch, lookPitchRad * 0.9, 11, dt), -0.06, 0.06);
    this.breath += dt;
    this.walkK = damp(this.walkK, p.grounded ? Math.min(1.5, p.speedMs / 3.2) : 0.2, 8, dt);
    const ads = smoothstep(0, 1, eq.adsBlend);
    const phase = p.stridePhase;
    // Shared motion: breathing, stride bob, look lag.
    const bobX = Math.sin(phase) * 0.014 * this.walkK * (1 - ads * 0.85);
    const bobY = (Math.abs(Math.cos(phase)) - 0.5) * 0.016 * this.walkK * (1 - ads * 0.85) + Math.sin(this.breath * 1.7) * 0.0035 * (1 - ads * 0.7);
    const swayRx = this.lagPitch * (1 - ads * 0.6) + Math.sin(this.breath * 1.7 + 0.5) * 0.004;
    const swayRy = this.lagYaw * (1 - ads * 0.6);

    this.rifle.root.visible = this.shown === 'rifle' && this.away < 0.6;
    this.knife.root.visible = this.shown === 'knife' && this.away < 0.6;
    this.stone.visible = this.shown === 'stone' && (a.kind !== 'throw' || game.equipment.progress * (STONE.releaseSeconds + STONE.recoverSeconds) < STONE.releaseSeconds) && this.away < 0.6 && (game.inventory.has('stone') || a.kind === 'throw');

    // Raise / lower offsets for tool switching.
    let drop = 0;
    if (a.kind === 'lower') drop = t;
    else if (a.kind === 'raise') drop = 1 - t;
    drop = Math.max(drop, this.away);
    const dropY = -0.32 * smoothstep(0, 1, drop);
    const dropRx = -0.9 * smoothstep(0, 1, drop);

    if (this.shown === 'rifle' && this.away < 0.99) {
      this.poseRifle(game, ads, bobX, bobY + dropY, swayRx + dropRx, swayRy);
    } else {
      this.poseHands(game, bobX, bobY, swayRx, swayRy, dropY, dropRx);
    }
    this.right.hand.setPose(this.poseR);
    this.left.hand.setPose(this.poseL);
  }

  private poseRifle(game: LagoonGame, ads: number, bobX: number, bobY: number, swayRx: number, swayRy: number): void {
    const eq = game.equipment;
    const a = eq.action;
    const t = eq.progress;
    const r = this.rifle;
    const pos = this.v.copy(RIFLE_HIP.pos).lerp(this.m.set(0, 0, -r.eyeZ), ads);
    const rot = this.rot.set(RIFLE_HIP.rot.x * (1 - ads), RIFLE_HIP.rot.y * (1 - ads), RIFLE_HIP.rot.z * (1 - ads));
    pos.lerp(RIFLE_SPRINT.pos, this.sprint);
    rot.x += RIFLE_SPRINT.rot.x * this.sprint;
    rot.y += RIFLE_SPRINT.rot.y * this.sprint;
    rot.z += RIFLE_SPRINT.rot.z * this.sprint;
    pos.x += bobX;
    pos.y += bobY;
    rot.x += swayRx;
    rot.y += swayRy;
    // Visual kick: back, up, a little roll.
    pos.z += eq.kickM;
    rot.x += eq.kickM * 2.2;
    rot.z += eq.kickM * 0.6 * Math.sin(eq.shotsFired * 1.7);
    r.magazine.visible = true;
    r.magazine.position.y = -0.086;
    r.chargingHandle.position.z = -0.02;
    let leftOnMag = 0;
    let leftOnHandle = 0;
    if (a.kind === 'reload') {
      // Tilt the rifle, strip the magazine, seat a fresh one, rack the handle if it ran dry.
      const env = Math.sin(Math.PI * t);
      rot.z += 0.6 * env;
      rot.x += 0.12 * env;
      pos.y -= 0.03 * env;
      pos.x -= 0.03 * env;
      if (t > 0.12 && t < 0.3) leftOnMag = smoothstep(0.12, 0.22, t);
      if (t >= 0.22 && t < 0.36) r.magazine.position.y = -0.086 - (t - 0.22) * 2.2;
      else if (t >= 0.36 && t < 0.5) r.magazine.visible = false;
      else if (t >= 0.5 && t < 0.6) r.magazine.position.y = -0.086 - (0.6 - t) * 2;
      if (t >= 0.3 && t < 0.62) leftOnMag = 1;
      if (a.empty && t > 0.7 && t < 0.95) {
        leftOnHandle = Math.sin(((t - 0.7) / 0.25) * Math.PI);
        r.chargingHandle.position.z = -0.02 + (t > 0.8 && t < 0.88 ? 0.09 : 0);
      }
    }
    this.pivot.position.copy(pos);
    this.pivot.rotation.copy(rot);
    this.pivot.updateMatrix();
    // Right hand on the pistol grip: palm facing the grip, thumb over the top.
    this.gripTarget(r.gripRight, ViewModel.GRIP_R, this.tR);
    this.tR.pos.add(this.localDir(0.028, 0.012, 0.05));
    // Left hand under the handguard, or on the magazine / the charging handle during a reload.
    this.gripTarget(r.gripLeft, ViewModel.GRIP_L, this.tL);
    this.tL.pos.add(this.localDir(-0.05, -0.032, 0));
    if (leftOnMag > 0) {
      const magAt = this.v.set(0, r.magazine.position.y - 0.12, -0.05).applyMatrix4(this.pivot.matrix);
      this.tL.pos.lerp(r.magazine.visible ? magAt : magAt.add(this.m.set(-0.1, -0.25, 0.1)), leftOnMag);
    }
    if (leftOnHandle > 0) {
      const handle = this.m.set(0.06, -0.045, -0.02 + (r.chargingHandle.position.z + 0.02)).applyMatrix4(this.pivot.matrix);
      this.tL.pos.lerp(handle, leftOnHandle);
    }
    this.right.reach(this.tR.pos, this.q.setFromEuler(this.tR.rot));
    this.left.reach(this.tL.pos, this.q.setFromEuler(this.tL.rot));
    mixPose(POSES.trigger, POSES.grip, a.kind === 'reload' ? 1 : 0, this.poseR);
    mixPose(POSES.cradle, POSES.pinch, Math.max(leftOnMag, leftOnHandle), this.poseL);
  }

  /** A grip point on the rifle, in camera space, with the hand's orientation composed onto the rifle's. */
  private gripTarget(local: Vector3, handRot: Euler, out: Target): void {
    out.pos.copy(local).applyMatrix4(this.pivot.matrix);
    this.qa.setFromEuler(this.pivot.rotation).multiply(this.qb.setFromEuler(handRot));
    out.rot.setFromQuaternion(this.qa);
  }

  private localDir(x: number, y: number, z: number): Vector3 {
    return this.dir.set(x, y, z).applyEuler(this.pivot.rotation);
  }

  private poseHands(game: LagoonGame, bobX: number, bobY: number, swayRx: number, swayRy: number, dropY: number, dropRx: number): void {
    const eq = game.equipment;
    const a = eq.action;
    const t = eq.progress;
    const walk = Math.sin(game.player.stridePhase) * 0.02 * this.walkK;
    sample([REST_R], 0, this.tR);
    sample([REST_L], 0, this.tL);
    mixPose(POSES.relaxed, POSES.relaxed, 0, this.poseR);
    mixPose(POSES.relaxed, POSES.relaxed, 0, this.poseL);
    const holding = this.away < 0.5;
    if (this.shown === 'stone' && holding) {
      sample([STONE_HOLD], 0, this.tR);
      mixPose(POSES.cradle, POSES.grip, 0.35, this.poseR);
      if (a.kind === 'windup') {
        // Arm draws back behind the shoulder as the throw charges; the free arm points at the target.
        const c = smoothstep(0, 1, Math.min(1, a.elapsedSeconds / 0.28)) ;
        const charge = eq.charge;
        this.tR.pos.lerp(this.v.set(0.3, 0.03 + charge * 0.03, 0.0 + charge * 0.04), c);
        this.tR.rot.set(0.55 + (-0.4 - 0.55) * c, 0.15 + (0.1 - 0.15) * c, -2.5 + (-2.6 + 2.5) * c);
        this.tL.pos.lerp(this.v.set(-0.14, -0.13, -0.58), c);
        this.tL.rot.set(0.25 - c * 0.2, -0.25 + c * 0.2, 1.25 + c * 0.2);
        mixPose(POSES.relaxed, POSES.open, c, this.poseL);
      } else if (a.kind === 'throw') {
        sample(THROW, t, this.tR);
        const k = 1 - smoothstep(0.3, 1, t);
        this.tL.pos.lerp(this.v.set(-0.14, -0.13, -0.58), k);
        mixPose(POSES.cradle, POSES.open, smoothstep(0.3, 0.45, t) * (1 - smoothstep(0.8, 1, t)), this.poseR);
      }
    } else if (this.shown === 'knife' && holding) {
      sample([KNIFE_HOLD], 0, this.tR);
      mixPose(POSES.grip, POSES.grip, 0, this.poseR);
      if (a.kind === 'swing') sample(a.side === 1 ? SLASH : BACKHAND, t, this.tR);
    }
    if (a.kind === 'pickup') {
      sample(REACH_R, t, this.tR);
      mixPose(POSES.open, POSES.pinch, smoothstep(0.4, 0.55, t), this.poseR);
    } else if (a.kind === 'harvest') {
      sample(HARVEST_R, t, this.tR);
      sample(HARVEST_L, t, this.tL);
      const grab = smoothstep(0.4, 0.6, t);
      mixPose(POSES.open, POSES.grip, grab, this.poseR);
      mixPose(POSES.open, POSES.grip, grab, this.poseL);
    } else if (a.kind === 'openCrate') {
      sample(CRATE_R, t, this.tR);
      sample(CRATE_R, t, this.tL);
      this.tL.pos.x = -this.tL.pos.x;
      this.tL.rot.y = -this.tL.rot.y;
      this.tL.rot.z = -this.tL.rot.z;
      mixPose(POSES.relaxed, POSES.open, smoothstep(0, 0.3, t), this.poseR);
      mixPose(POSES.relaxed, POSES.open, smoothstep(0, 0.3, t), this.poseL);
    }
    const busy = a.kind === 'pickup' || a.kind === 'harvest' || a.kind === 'openCrate' || a.kind === 'windup' || a.kind === 'throw' || a.kind === 'swing';
    const tool = this.shown !== 'hands' && !busy ? 1 : 0;
    for (const [target, side] of [
      [this.tR, 1],
      [this.tL, -1],
    ] as const) {
      target.pos.x += bobX + (busy ? 0 : walk * side * 0.5);
      target.pos.y += bobY + (busy && a.kind !== 'lower' && a.kind !== 'raise' ? 0 : dropY * (side === 1 ? tool : 0.3));
      target.rot.x += swayRx + (side === 1 ? dropRx * tool : 0);
      target.rot.y += swayRy;
      target.pos.z += walk * side * -0.5;
    }
    this.right.reach(this.tR.pos, this.q.setFromEuler(this.tR.rot));
    this.left.reach(this.tL.pos, this.q.setFromEuler(this.tL.rot));
  }
}

