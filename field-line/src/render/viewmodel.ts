import { CylinderGeometry, Euler, Group, Mesh, type MeshStandardNodeMaterial, type Object3D, Quaternion, type Scene, type Texture, Vector3, type WebGPURenderer } from 'three/webgpu';
import { SCOPE, type WeaponId } from '../config.ts';
import { clamp, damp, smoothstep } from '../core/vec.ts';
import type { Game } from '../game/game.ts';
import { RedDot, Scope } from './optics.ts';
import { BOLT_REST, buildAmmoPouch, buildFrag, buildHand, buildMedKit, buildPistol, buildRifle, buildSniper, MAG_REST_Y, type PistolModel, type RifleModel, type SniperModel, VM_MATERIALS } from './weaponModels.ts';

// First-person weapon. The whole rig is scaled down about the eye (VM_SCALE):
// the picture is identical, but the gun sits inside the player's capsule and
// never pokes through a wall. It stays in the world scene, so it receives the
// sun's cascades — step under a roof and it falls into shadow (acceptance) —
// and its ambient follows the interior factor instead of the outdoor sky.
//
// Aim down sights moves the model until its sight line meets the eye. Visual
// kick (slide back, muzzle rise, roll) is separate from aim kick, which lives
// in the weapon system and moves the camera.

export const VM_SCALE = 0.25;
// Bolt handle at rest angles down beside the stock; it lifts ~75° to unlock.
export const VIEWMODEL_LAYER = 1;

interface Pose {
  pos: Vector3;
  rot: Euler;
}

const HIP: Record<WeaponId, Pose> = {
  rifle: { pos: new Vector3(0.14, -0.13, -0.24), rot: new Euler(0.02, 0.05, -0.04) },
  sniper: { pos: new Vector3(0.16, -0.14, -0.2), rot: new Euler(0.02, 0.05, -0.05) },
  pistol: { pos: new Vector3(0.1, -0.1, -0.4), rot: new Euler(0.02, 0.06, -0.02) },
};
const SPRINT: Pose = { pos: new Vector3(0.18, -0.2, -0.18), rot: new Euler(-0.55, 0.75, 0.3) };

export class ViewModel {
  readonly root = new Group();
  private readonly pivot = new Group();
  private readonly rifle: RifleModel;
  private readonly sniper: SniperModel;
  private readonly pistol: PistolModel;
  readonly redDot = new RedDot();
  /** The pistol's reflex sight: its own dot, on its own axis. */
  readonly pistolDot = new RedDot();
  readonly scope: Scope;
  private readonly handL = buildHand(-1);
  private readonly handR = buildHand(1);
  private readonly frag = buildFrag();
  private readonly medKit = buildMedKit();
  private readonly ammoPouch = buildAmmoPouch();
  private readonly suppressors: Mesh[] = [];
  private sprintBlend = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  private shown: WeaponId = 'rifle';
  private readonly tmpPos = new Vector3();
  private readonly tmpRot = new Euler();
  private throwT = 1;
  /** 0..1: how far the eye sits behind the scope's exit pupil (1 = centred and settled). */
  scopeSettle = 0;

  constructor(scopeSidePx: number, scopeLike: ConstructorParameters<typeof Scope>[2] = null) {
    this.root.name = 'viewmodel';
    this.root.scale.setScalar(VM_SCALE);
    this.root.add(this.pivot);
    this.rifle = buildRifle();
    this.sniper = buildSniper();
    this.pistol = buildPistol();
    this.rifle.dotLens.material = this.redDot.material;
    this.pistol.dotLens.material = this.pistolDot.material;
    this.scope = new Scope(this.sniper.ocularRadiusM, scopeSidePx, scopeLike);
    this.sniper.ocular.material = this.scope.material;
    this.scope.setMagnification(SCOPE.magnifications[0]);
    // A model's own suppressor when it has one, else a can drawn round the point it gives.
    for (const [gun, r] of [[this.rifle, 0.018], [this.sniper, 0.021]] as const) {
      const s = gun.suppressor ?? buildSuppressor(r);
      if (!gun.suppressor) {
        s.position.copy(gun.suppressorAt);
        gun.root.add(s);
      }
      this.suppressors.push(s);
    }
    this.pivot.add(this.rifle.root, this.sniper.root, this.pistol.root, this.handL, this.handR, this.frag, this.medKit, this.ammoPouch);
    this.root.traverse((o) => o.layers.set(VIEWMODEL_LAYER));
  }

  /** Ambient for the rig: the sky probe outdoors, scaled down indoors. */
  setEnvironment(env: Texture | null, intensity: number): void {
    for (const m of Object.values(VM_MATERIALS) as MeshStandardNodeMaterial[]) {
      m.envMap = env;
      m.envMapIntensity = intensity;
    }
  }

  update(game: Game, frameSeconds: number, lookYawRad: number, lookPitchRad: number, pixelAngleRad: number): void {
    const w = game.weapons;
    const p = game.player;
    const a = w.action;
    const dt = Math.max(1e-4, frameSeconds);
    // During a switch the old weapon lowers, then the new one rises.
    if (a.kind !== 'switch' || a.elapsedSeconds / a.durationSeconds >= 0.5) this.shown = w.current;
    this.rifle.root.visible = this.shown === 'rifle';
    this.sniper.root.visible = this.shown === 'sniper';
    this.pistol.root.visible = this.shown === 'pistol';
    const st = w.weapons[this.shown];
    (this.suppressors[0] as Mesh).visible = w.weapons.rifle.suppressed;
    (this.suppressors[1] as Mesh).visible = w.weapons.sniper.suppressed;

    this.sprintBlend = damp(this.sprintBlend, p.isSprinting ? 1 : 0, 8, dt);
    // Weapon lag: the gun trails the mouse a little, then catches up.
    this.lagYaw = clamp(damp(this.lagYaw, lookYawRad * 0.9, 12, dt), -0.06, 0.06);
    this.lagPitch = clamp(damp(this.lagPitch, lookPitchRad * 0.9, 12, dt), -0.05, 0.05);

    const ads = smoothstep(0, 1, w.adsBlend);
    const eyeZ = this.shown === 'rifle' ? this.rifle.eyeZ : this.shown === 'sniper' ? this.sniper.eyeZ : this.pistol.eyeZ;
    const hip = HIP[this.shown];
    // Aimed, the eye sits on the sight line: through the pistol's red dot window, above its irons.
    const sightY = this.shown === 'pistol' ? this.pistol.sightY : 0;
    const pos = this.tmpPos.copy(hip.pos).add(this.gun().hipOffset).lerp(_ads.set(0, -sightY, -eyeZ), ads);
    const rot = this.tmpRot.set(hip.rot.x * (1 - ads), hip.rot.y * (1 - ads), hip.rot.z * (1 - ads));
    pos.lerp(SPRINT.pos, this.sprintBlend);
    rot.x += SPRINT.rot.x * this.sprintBlend;
    rot.y += SPRINT.rot.y * this.sprintBlend;
    rot.z += SPRINT.rot.z * this.sprintBlend;

    // Bob from the player's stride; mostly gone when aimed.
    const speed = Math.hypot(p.body.velocity.x, p.body.velocity.z);
    const bobK = Math.min(1, speed / 3.5) * (1 - ads * 0.85) * (p.body.grounded ? 1 : 0.2);
    pos.x += Math.sin(p.headBobPhase) * 0.012 * bobK;
    pos.y += Math.abs(Math.cos(p.headBobPhase)) * 0.014 * bobK;
    rot.x += this.lagPitch * (1 - ads * 0.6);
    rot.y += this.lagYaw * (1 - ads * 0.6);

    // Visual kick, separate from the aim kick.
    pos.z += w.visualKickM;
    rot.x += w.visualKickM * 2.4;
    rot.z += w.visualKickRollRad;

    this.animateAction(game, pos, rot, dt);
    this.animateHands(game);

    this.pivot.position.copy(pos);
    this.pivot.rotation.copy(rot);

    // Pistol slide travels back with the kick.
    this.pistol.slide.position.z = Math.min(0.03, w.visualKickM * 1.2);
    if (st.spec.boltAction) this.scope.setMagnification(w.scopeMagnification);

    // Eye behind the scope: settled when fully aimed and still; moving or turning pulls it off axis.
    const shake = Math.min(1, speed / 2 + Math.abs(this.lagYaw) * 20 + Math.abs(this.lagPitch) * 20);
    const target = this.shown === 'sniper' ? smoothstep(0.85, 1, w.adsBlend) * (1 - shake * 0.6) : 0;
    this.scopeSettle = damp(this.scopeSettle, target, 6, dt);
    this.scope.settle.value = this.scopeSettle;
    this.scope.eyeOffset.value.set(-this.lagYaw * 12 + Math.sin(p.headBobPhase) * speed * 0.08, this.lagPitch * 12 - w.visualKickM * 6);
    this.redDot.pixelAngleRad.value = pixelAngleRad;
    this.pistolDot.pixelAngleRad.value = pixelAngleRad;
  }

  /** Parents a marker to the weapon on screen (for the muzzle flash position). */
  /** The weapon in hand. */
  private gun(): RifleModel | SniperModel | PistolModel {
    return this.shown === 'rifle' ? this.rifle : this.shown === 'sniper' ? this.sniper : this.pistol;
  }

  /** The muzzle of the weapon in hand, in its frame (view.ts puts the flash there). */
  muzzle(): Vector3 {
    return this.gun().muzzle;
  }

  attachMuzzle(marker: Object3D): void {
    const root = this.shown === 'rifle' ? this.rifle.root : this.shown === 'sniper' ? this.sniper.root : this.pistol.root;
    if (marker.parent !== root) root.add(marker);
  }

  /** The dot sits on the optic's axis at infinity: feed that axis, in world space, to the lens shader. */
  aimRedDot(): void {
    this.rifle.root.getWorldQuaternion(_q);
    this.redDot.axis.value.set(0, 0, -1).applyQuaternion(_q);
    this.pistol.slide.getWorldQuaternion(_q);
    this.pistolDot.axis.value.set(0, 0, -1).applyQuaternion(_q);
  }

  renderScope(renderer: WebGPURenderer, scene: Scene, eye: Vector3): void {
    this.sniper.root.getWorldQuaternion(_q);
    this.scope.render(renderer, scene, eye, _q);
  }

  private animateAction(game: Game, pos: Vector3, rot: Euler, dt: number): void {
    const w = game.weapons;
    const a = w.action;
    const p = game.player;
    const t = a.durationSeconds > 0 ? clamp(a.elapsedSeconds / a.durationSeconds, 0, 1) : 1;
    const mag = this.shown === 'rifle' ? this.rifle.magazine : this.shown === 'sniper' ? this.sniper.magazine : this.pistol.magazine;
    mag.visible = true;
    mag.position.y = MAG_REST_Y[this.shown];
    this.sniper.bolt.rotation.z = BOLT_REST.downRad;
    this.sniper.bolt.position.z = BOLT_REST.z;
    this.frag.visible = false;
    this.medKit.visible = false;
    this.ammoPouch.visible = false;
    if (a.kind === 'reload') {
      // Tilt the gun, drop the old magazine, seat the new one; empty reloads end on the bolt release.
      const env = Math.sin(Math.PI * t);
      rot.z += 0.55 * env;
      rot.x += 0.18 * env;
      pos.y -= 0.03 * env;
      const base = mag.position.y;
      if (t > 0.18 && t < 0.3) mag.position.y = base - (t - 0.18) * 1.6;
      else if (t >= 0.3 && t < 0.45) mag.visible = false;
      else if (t >= 0.45 && t < 0.6) mag.position.y = base - (0.6 - t) * 1.2;
      if (a.empty && t > 0.84 && t < 0.92) rot.x -= 0.05 * Math.sin(((t - 0.84) / 0.08) * Math.PI);
    } else if (a.kind === 'bolt') {
      // Up, back, forward, down.
      const b = this.sniper.bolt;
      const lift = t < 0.2 ? t / 0.2 : t < 0.8 ? 1 : (1 - t) / 0.2;
      b.rotation.z = BOLT_REST.downRad + lift * 1.3;
      b.position.z = BOLT_REST.z + (t < 0.2 ? 0 : t < 0.5 ? ((t - 0.2) / 0.3) * 0.08 : t < 0.8 ? ((0.8 - t) / 0.3) * 0.08 : 0);
      rot.z += 0.08 * Math.sin(Math.PI * t);
    } else if (a.kind === 'switch') {
      const k = t < 0.5 ? t / 0.5 : (1 - t) / 0.5;
      pos.y -= 0.25 * k;
      rot.x -= 0.9 * k;
    } else if (a.kind === 'suppressor') {
      const env = Math.sin(Math.PI * t);
      rot.y += 0.6 * env;
      rot.z -= 0.3 * env;
      pos.x += 0.05 * env;
    } else if (a.kind === 'busy') {
      pos.y -= 0.22;
      rot.x -= 0.7;
    }
    if (game.grenades.cooking) {
      this.throwT = 0;
      this.frag.visible = true;
      this.frag.position.set(0.02, 0.12, 0.1);
      pos.y -= 0.2;
      rot.x -= 0.6;
    } else if (this.throwT < 1) {
      this.throwT = Math.min(1, this.throwT + dt / 0.35);
      pos.y -= 0.2 * (1 - this.throwT);
      rot.x -= 0.6 * (1 - this.throwT);
    }
    if (p.itemInUse) {
      pos.y -= 0.24;
      rot.x -= 0.8;
      const item = p.itemInUse.kind === 'medKit' ? this.medKit : this.ammoPouch;
      item.visible = true;
      item.position.set(-0.02, 0.2 + Math.sin(game.timeSeconds * 3) * 0.01, 0.02);
      item.rotation.set(0.9, 0.2, 0);
    }
  }

  /** Hands follow the current weapon's grips (and the magazine during a reload). */
  private animateHands(game: Game): void {
    const gun = this.gun();
    this.handR.position.copy(gun.gripRight);
    // Forearms run back, down and out toward the shoulders, never straight at the eye.
    this.handR.rotation.set(0.95, 0.45, -0.2);
    const reloading = game.weapons.action.kind === 'reload';
    if (this.shown === 'pistol') this.handL.position.copy(gun.gripLeft);
    else if (reloading) {
      const mag = this.shown === 'rifle' ? this.rifle.magazine : this.sniper.magazine;
      this.handL.position.set(-0.03, mag.visible ? mag.position.y - 0.08 : -0.3, mag.position.z + 0.01);
    } else this.handL.position.copy(gun.gripLeft);
    this.handL.rotation.set(0.55, -0.55, 0.4);
  }
}

function buildSuppressor(radiusM: number): Mesh {
  const m = new Mesh(new CylinderGeometry(radiusM, radiusM, 0.16, 16).rotateX(Math.PI / 2), VM_MATERIALS.parkerised);
  m.name = 'suppressor';
  m.receiveShadow = true;
  return m;
}

const _ads = new Vector3();
const _q = new Quaternion();
