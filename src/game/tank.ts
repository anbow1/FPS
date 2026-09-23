import * as THREE from 'three';
import { AMMO, type AmmoId, type AmmoSpec, GRAVITY, PLAY_HALF, type TankSpec, WATER_LEVEL } from '../config';
import { pushOutObb } from '../world/buildings';
import type { World } from '../world/world';
import { type ArmourResult, MODULES, type ModuleDef, type ModuleId, moduleLayout, resolveArmour, segmentBox } from './damage';
import type { EngineVoice } from './audio';
import { buildTank, type TankModel, type TankStyle, updateWheels } from './tankModel';

export type Team = 'player' | 'enemy';

export interface HitInfo {
  t: number;
  part: 'hull' | 'turret' | 'gun';
  /** entry-face normal in the part frame */
  localNormal: THREE.Vector3;
  point: THREE.Vector3;
}

export interface DamageReport {
  outcome: 'ricochet' | 'nopen' | 'pen' | 'track' | 'gun' | 'kill';
  armour: ArmourResult | null;
  modules: ModuleId[];
  cookOff: boolean;
  fire: boolean;
  hpLoss: number;
}

const REPAIR_TIME: Record<ModuleId, number> = {
  engine: 22, trackL: 12, trackR: 12, gun: 15, turretDrive: 14, ammo: 999, fuel: 999,
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _tn = { x: 0, y: 1, z: 0 };
const _trees: number[] = [];

let nextId = 1;

export class Tank {
  readonly id = nextId++;
  readonly model: TankModel;
  readonly modules: Record<ModuleId, number>;
  readonly moduleDefs: ModuleDef[];
  private repairT: Record<ModuleId, number>;

  // ground-plane state
  readonly pos = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  yawRate = 0;
  // suspension
  pitch = 0;
  pitchV = 0;
  roll = 0;
  rollV = 0;
  heave = 0;
  heaveV = 0;
  private lastAccel = 0;
  // controls (set by player or AI)
  throttle = 0;
  steer = 0;
  readonly aimDir = new THREE.Vector3(0, 0, 1);
  // turret
  turretYaw = 0;
  gunPitch = 0;
  turretSpeed = 0;
  // combat
  hp: number;
  alive = true;
  ammo: Record<AmmoId, number>;
  selected: AmmoId = 'APFSDS';
  loaded: AmmoId | null = null;
  reloadLeft = 0;
  burning = 0;
  extinguishers = 2;
  barrelHeat = 0;
  deadTime = 0;
  kills = 0;
  shotsFired = 0;
  lastHitBy: Tank | null = null;
  lastShotTime = -99;
  // track animation
  distNeg = 0; // x<0 side (right)
  distPos = 0; // x>0 side (left)
  private markAcc = 0;
  engineVoice: EngineVoice | null = null;
  /** world velocity, for AI lead and FCS */
  readonly velocity = new THREE.Vector3();
  // render interpolation between fixed steps
  private readonly prevPos = new THREE.Vector3();
  private readonly curPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly curQuat = new THREE.Quaternion();
  private prevTurret = 0;
  private curTurret = 0;
  private prevGun = 0;
  private curGun = 0;
  // cook-off turret toss
  turretFlying: { vel: THREE.Vector3; spin: THREE.Vector3; landed: boolean } | null = null;

  constructor(
    readonly spec: TankSpec,
    readonly team: Team,
    style: TankStyle,
    seed: number,
  ) {
    this.model = buildTank(style, seed);
    this.moduleDefs = moduleLayout(style === 'west');
    this.modules = Object.fromEntries(MODULES.map((m) => [m, 1])) as Record<ModuleId, number>;
    this.repairT = Object.fromEntries(MODULES.map((m) => [m, 0])) as Record<ModuleId, number>;
    this.hp = spec.hp;
    this.ammo = { ...spec.ammo };
    this.reloadLeft = 1.5;
  }

  get ammoSpec(): AmmoSpec {
    return AMMO[this.loaded ?? this.selected];
  }

  get mobile(): boolean {
    return this.modules.engine > 0 && this.modules.trackL > 0 && this.modules.trackR > 0;
  }

  get reloadTime(): number {
    return this.spec.reload * (this.modules.gun < 0.5 ? 1.5 : 1);
  }

  place(x: number, z: number, yaw: number, world: World): void {
    this.pos.set(x, world.hf.heightAt(x, z), z);
    this.yaw = yaw;
    this.aimDir.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.updatePose(world, 0);
    this.capture();
    this.capture();
  }

  /** Shift current pose to previous and record the pose after this step. */
  private capture(): void {
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
    this.prevTurret = this.curTurret;
    this.prevGun = this.curGun;
    this.curPos.copy(this.model.root.position);
    this.curQuat.copy(this.model.root.quaternion);
    this.curTurret = this.turretYaw;
    this.curGun = this.gunPitch;
  }

  /** Blend the rendered pose between the last two physics steps (alpha in [0,1]). */
  interpolate(alpha: number): void {
    const r = this.model.root;
    r.position.lerpVectors(this.prevPos, this.curPos, alpha);
    r.quaternion.slerpQuaternions(this.prevQuat, this.curQuat, alpha);
    if (!this.turretFlying) {
      const d = Math.atan2(Math.sin(this.curTurret - this.prevTurret), Math.cos(this.curTurret - this.prevTurret));
      this.model.turret.rotation.y = this.prevTurret + d * alpha;
    }
    this.model.gun.rotation.x = -(this.prevGun + (this.curGun - this.prevGun) * alpha);
  }

  selectAmmo(id: AmmoId): void {
    if (this.selected === id) return;
    this.selected = id;
    // unload: the round goes back to the rack and the new one is rammed
    if (this.loaded && this.loaded !== id) {
      this.ammo[this.loaded]++;
      this.loaded = null;
      this.reloadLeft = this.reloadTime;
    }
  }

  // ------------------------------------------------------------------ simulation

  step(dt: number, world: World): void {
    this.stepInner(dt, world);
    this.capture();
  }

  private stepInner(dt: number, world: World): void {
    if (!this.alive) {
      const u = this.model.uniforms;
      u.uBurnt.value = Math.min(1, u.uBurnt.value + dt * 0.4);
      u.uHeatBase.value = Math.max(0.5, u.uHeatBase.value - dt * 0.01);
      u.uHeatEngine.value = 0;
      this.speed *= Math.exp(-dt * 3);
      this.yawRate = 0;
      this.integrateMotion(dt, world);
      this.updatePose(world, dt);
      this.stepTurretToss(dt, world);
      return;
    }
    const spec = this.spec;
    const engine = this.modules.engine <= 0 ? 0 : this.modules.engine < 0.5 ? 0.55 : 1;
    const mobile = this.mobile;

    // --- longitudinal: traction- and power-limited drive, grade, rolling resistance, brakes
    const thr = mobile ? this.throttle : 0;
    const want = thr >= 0 ? spec.maxFwd * thr * engine : spec.maxRev * thr * engine;
    const grade = GRAVITY * Math.sin(this.pitch); // resists forward motion uphill
    const roll = 0.35 * Math.sign(this.speed);
    const prev = this.speed;
    const driving = Math.abs(thr) > 0.05 && (Math.sign(want) === Math.sign(this.speed) || Math.abs(this.speed) < 0.5);
    if (driving) {
      const driveMax = Math.min(0.75 * GRAVITY, (spec.powerW * engine) / (spec.mass * Math.max(Math.abs(this.speed), 1)));
      // force needed to reach the demanded speed this step, then limited by traction/power
      let f = (want - this.speed) / dt + grade + roll;
      f = Math.max(-driveMax, Math.min(driveMax, f));
      // comfort limit on the net acceleration (not on the force fighting the slope)
      const net = Math.max(-spec.brakeDecel, Math.min(spec.maxAccel, f - grade - roll));
      this.speed += net * dt;
    } else {
      // braking or coasting; tracks and brakes hold the tank on slopes up to the traction limit
      const brake = Math.abs(thr) > 0.05 ? spec.brakeDecel : 2.2;
      if (Math.abs(this.speed) < 0.3 && Math.abs(grade) < 0.75 * GRAVITY) this.speed = 0;
      else this.speed -= (Math.sign(this.speed) * Math.min(brake, Math.abs(this.speed) / dt) + (Math.abs(grade) > 0.75 * GRAVITY ? grade : 0)) * dt;
    }
    this.lastAccel = (this.speed - prev) / dt;

    // wading: slows down, deep water stops the tank
    const depth = WATER_LEVEL - world.hf.heightAt(this.pos.x, this.pos.z);
    if (depth > 0.3) {
      this.speed *= Math.exp(-dt * depth * 0.9);
      const aheadDepth = WATER_LEVEL - world.hf.heightAt(this.pos.x + Math.sin(this.yaw) * Math.sign(this.speed) * 4, this.pos.z + Math.cos(this.yaw) * Math.sign(this.speed) * 4);
      if (aheadDepth > 1.4 && aheadDepth > depth) this.speed *= 0.5;
    }

    // --- turning
    const vFrac = Math.min(1, Math.abs(this.speed) / spec.maxFwd);
    const rate = (spec.pivotRate + (spec.runRate - spec.pivotRate) * vFrac) * (mobile ? engine : 0);
    const targetRate = -this.steer * rate;
    this.yawRate += (targetRate - this.yawRate) * Math.min(1, dt * 4);
    this.yaw += this.yawRate * dt;

    this.integrateMotion(dt, world);
    this.updatePose(world, dt);

    // --- turret + gun drives, stabilised in world space
    this.driveTurret(dt);

    // --- reload
    if (!this.loaded && this.modules.gun > 0) {
      if (this.ammo[this.selected] > 0) {
        this.reloadLeft -= dt;
        if (this.reloadLeft <= 0) {
          this.ammo[this.selected]--;
          this.loaded = this.selected;
          this.reloadLeft = 0;
        }
      }
    }

    // --- fire, repairs
    if (this.burning > 0) {
      this.burning -= dt;
      this.hp -= spec.hp * 0.025 * dt;
      if (this.hp <= 0) this.hp = 0;
    }
    for (const m of MODULES) {
      if (this.modules[m] <= 0 && this.burning <= 0) {
        this.repairT[m] += dt;
        if (this.repairT[m] >= REPAIR_TIME[m]) {
          this.modules[m] = 0.35;
          this.repairT[m] = 0;
        }
      }
    }
    this.barrelHeat = Math.max(0, this.barrelHeat - dt * 0.012);
    const u = this.model.uniforms;
    u.uHeatEngine.value = 0.6 + 0.5 * Math.abs(this.throttle) + (this.burning > 0 ? 1.2 : 0);
    u.uHeatTracks.value = Math.max(0.05, Math.min(0.5, u.uHeatTracks.value + (Math.abs(this.speed) * 0.003 - 0.006) * dt * 10));
    u.uHeatBarrel.value = this.barrelHeat;
  }

  private integrateMotion(dt: number, world: World): void {
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    this.pos.x += fx * this.speed * dt;
    this.pos.z += fz * this.speed * dt;
    // play-area wall
    const lim = PLAY_HALF + 40;
    if (Math.abs(this.pos.x) > lim) {
      this.pos.x = Math.sign(this.pos.x) * lim;
      this.speed *= 0.5;
    }
    if (Math.abs(this.pos.z) > lim) {
      this.pos.z = Math.sign(this.pos.z) * lim;
      this.speed *= 0.5;
    }
    // buildings and boulders: two circles along the hull
    const r = this.spec.width / 2 + 0.1;
    const off = this.spec.length * 0.28;
    let bumped = false;
    for (const s of [-1, 1]) {
      const c = { x: this.pos.x + fx * off * s, z: this.pos.z + fz * off * s };
      const ox = c.x;
      const oz = c.z;
      for (const b of world.buildings) {
        if (Math.abs(b.x - c.x) > 30 || Math.abs(b.z - c.z) > 30) continue;
        if (pushOutObb(b, c, r)) bumped = true;
      }
      for (const rk of world.vegetation.rocks) {
        const dx = c.x - rk.x;
        const dz = c.z - rk.z;
        const d = Math.hypot(dx, dz);
        const rr = r + rk.r;
        if (d < rr && d > 1e-4) {
          c.x = rk.x + (dx / d) * rr;
          c.z = rk.z + (dz / d) * rr;
          bumped = true;
        }
      }
      this.pos.x += c.x - ox;
      this.pos.z += c.z - oz;
    }
    if (bumped) this.speed *= Math.exp(-dt * 6);
    // trees go down in front of a moving tank
    if (Math.abs(this.speed) > 0.8) {
      const s = Math.sign(this.speed);
      const cx = this.pos.x + fx * this.spec.length * 0.45 * s;
      const cz = this.pos.z + fz * this.spec.length * 0.45 * s;
      for (const k of world.vegetation.query(cx, cz, r + 0.4, _trees)) {
        world.vegetation.knock(k, fx * s, fz * s);
        this.speed *= 0.8;
      }
    }
    this.velocity.set(fx * this.speed, 0, fz * this.speed);
  }

  /** Ground following: four contact points → pitch/roll targets, spring-damper on hull. */
  private updatePose(world: World, dt: number): void {
    const hf = world.hf;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const hl = this.spec.length * 0.42;
    const hw = this.model.trackX;
    // x>0 side is the left of the tank: side vector (cos yaw, 0, -sin yaw)
    const lx = Math.cos(this.yaw);
    const lz = -Math.sin(this.yaw);
    const sampleL = (f: number, s: number) => hf.heightAt(this.pos.x + fx * f + lx * s, this.pos.z + fz * f + lz * s);
    const fl = sampleL(hl, hw);
    const fr = sampleL(hl, -hw);
    const bl = sampleL(-hl, hw);
    const br = sampleL(-hl, -hw);
    const mid = sampleL(0, 0);
    const pitchT = Math.atan2((fl + fr) / 2 - (bl + br) / 2, hl * 2);
    const rollT = Math.atan2((fl + bl) / 2 - (fr + br) / 2, hw * 2);
    const yT = Math.max((fl + fr + bl + br) / 4, mid - 0.15);
    if (dt === 0) {
      this.pitch = pitchT;
      this.roll = rollT;
      this.pos.y = yT;
      this.heave = 0;
    } else {
      const k = 60;
      const c = 11;
      this.pitchV += (k * (pitchT - this.pitch) - c * this.pitchV + this.lastAccel * 0.02) * dt;
      this.pitch += this.pitchV * dt;
      this.rollV += (k * (rollT - this.roll) - c * this.rollV - this.yawRate * this.speed * 0.012) * dt;
      this.roll += this.rollV * dt;
      this.heaveV += (80 * (yT - this.pos.y) - 14 * this.heaveV) * dt;
      this.pos.y += this.heaveV * dt;
      if (this.pos.y < yT - 0.25) {
        this.pos.y = yT - 0.25;
        this.heaveV = Math.max(0, this.heaveV);
      }
    }
    const root = this.model.root;
    root.position.copy(this.pos);
    _e.set(-this.pitch, this.yaw, this.roll, 'YXZ');
    root.quaternion.setFromEuler(_e);
  }

  private driveTurret(dt: number): void {
    const spec = this.spec;
    // aim direction into the hull frame
    _q.copy(this.model.root.quaternion).invert();
    _v.copy(this.aimDir).applyQuaternion(_q);
    const wantYaw = Math.atan2(_v.x, _v.z);
    const wantPitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
    const drive = this.modules.turretDrive <= 0 ? 0.12 : this.modules.turretDrive < 0.5 ? 0.5 : 1;
    let d = wantYaw - this.turretYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const maxT = spec.turretRate * drive * dt;
    const stepT = Math.max(-maxT, Math.min(maxT, d));
    this.turretYaw += stepT;
    this.turretYaw = Math.atan2(Math.sin(this.turretYaw), Math.cos(this.turretYaw));
    this.turretSpeed = Math.abs(stepT) / Math.max(1e-6, maxT);
    const p = Math.max(spec.gunMin, Math.min(spec.gunMax, wantPitch));
    const maxG = spec.gunRate * dt * (this.modules.gun > 0 ? 1 : 0.3);
    this.gunPitch += Math.max(-maxG, Math.min(maxG, p - this.gunPitch));
    if (!this.turretFlying) this.model.turret.rotation.y = this.turretYaw;
    this.model.gun.rotation.x = -this.gunPitch;
  }

  /** Angle (rad) between where the gun points and where the controller wants it. */
  aimError(): number {
    this.gunDirection(_v);
    return Math.acos(Math.min(1, Math.max(-1, _v.dot(this.aimDir))));
  }

  gunDirection(out: THREE.Vector3): THREE.Vector3 {
    this.model.gun.updateWorldMatrix(true, false);
    return out.set(0, 0, 1).transformDirection(this.model.gun.matrixWorld);
  }

  muzzlePosition(out: THREE.Vector3): THREE.Vector3 {
    this.model.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.model.muzzle.matrixWorld);
  }

  sightPosition(out: THREE.Vector3): THREE.Vector3 {
    this.model.sight.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.model.sight.matrixWorld);
  }

  /** Centre of mass-ish aim point for AI and lead computing. */
  centre(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos).setY(this.pos.y + this.spec.hullHeight * 1.1);
  }

  canFire(): boolean {
    return this.alive && this.loaded !== null && this.modules.gun > 0;
  }

  /** Consumes the loaded round and starts the next reload. Recoil kicks the hull. */
  fire(time: number): AmmoSpec | null {
    if (!this.canFire()) return null;
    const ammo = AMMO[this.loaded!];
    this.loaded = null;
    this.reloadLeft = this.reloadTime;
    this.shotsFired++;
    this.lastShotTime = time;
    this.barrelHeat = Math.min(1.2, this.barrelHeat + 0.25);
    const k = 0.9;
    this.pitchV += Math.cos(this.turretYaw) * k;
    this.rollV += Math.sin(this.turretYaw) * k * 0.7;
    return ammo;
  }

  // ------------------------------------------------------------------ hits

  /** Segment test against hull, turret and gun boxes. Returns the nearest hit or null. */
  raycast(a: THREE.Vector3, b: THREE.Vector3, out: HitInfo): HitInfo | null {
    const m = this.model;
    // quick sphere reject
    const cx = this.pos.x;
    const cy = this.pos.y + 1.2;
    const cz = this.pos.z;
    _v.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const len2 = _v.lengthSq();
    const t = Math.max(0, Math.min(1, ((cx - a.x) * _v.x + (cy - a.y) * _v.y + (cz - a.z) * _v.z) / len2));
    const dx = a.x + _v.x * t - cx;
    const dy = a.y + _v.y * t - cy;
    const dz = a.z + _v.z * t - cz;
    if (dx * dx + dy * dy + dz * dz > 7 * 7) return null;
    let best = 2;
    const test = (obj: THREE.Object3D, c: THREE.Vector3, h: THREE.Vector3, part: HitInfo['part']) => {
      obj.updateWorldMatrix(true, false);
      _inv.copy(obj.matrixWorld).invert();
      _p0.copy(a).applyMatrix4(_inv);
      _p1.copy(b).applyMatrix4(_inv);
      const tt = segmentBox(_p0, _p1, c, h, _n);
      if (tt >= 0 && tt < best) {
        best = tt;
        out.t = tt;
        out.part = part;
        out.localNormal.copy(_n);
      }
    };
    test(m.hull, m.hullBox.c, m.hullBox.h, 'hull');
    if (!this.turretFlying) {
      test(m.turret, m.turretBox.c, m.turretBox.h, 'turret');
      test(m.gun, _gunC.set(0, 0, m.gunLength / 2), _gunH.set(0.14, 0.14, m.gunLength / 2 - 0.3), 'gun');
    }
    if (best > 1) return null;
    out.point.copy(a).lerp(b, out.t);
    return out;
  }

  /**
   * Resolve a shell strike. `dir` is the shell's world direction, `flown` its distance travelled.
   */
  takeHit(hit: HitInfo, dir: THREE.Vector3, ammo: AmmoSpec, flown: number, from: Tank | null): DamageReport {
    const rep: DamageReport = { outcome: 'nopen', armour: null, modules: [], cookOff: false, fire: false, hpLoss: 0 };
    if (!this.alive) return rep;
    this.lastHitBy = from;
    const m = this.model;
    const frameObj = hit.part === 'hull' ? m.hull : hit.part === 'turret' ? m.turret : m.gun;
    frameObj.updateWorldMatrix(true, false);
    _inv.copy(frameObj.matrixWorld).invert();
    const localDir = _v.copy(dir).transformDirection(_inv);
    const localPoint = _p0.copy(hit.point).applyMatrix4(_inv);

    if (hit.part === 'gun') {
      this.damageModule('gun', 0.6 + Math.random() * 0.4, rep);
      rep.outcome = 'gun';
      return rep;
    }
    const armour = resolveArmour(ammo, this.spec, hit.part, hit.localNormal, localDir, flown, Math.random());
    rep.armour = armour;
    rep.outcome = armour.outcome;

    // running gear: low side hits wreck the track even without a penetration
    if (hit.part === 'hull' && localPoint.y < 1.02 && Math.abs(localPoint.x) > 1.2 && armour.outcome !== 'ricochet') {
      this.damageModule(localPoint.x > 0 ? 'trackL' : 'trackR', 0.7 + Math.random() * 0.4, rep);
      if (armour.outcome === 'nopen') rep.outcome = 'track';
    }
    // blast damage outside the armour (HEAT, HE)
    if (ammo.blastRadius > 0 && armour.outcome !== 'ricochet') {
      _p1.copy(hit.point);
      for (const def of this.moduleDefs) {
        if (def.id !== 'trackL' && def.id !== 'trackR' && def.id !== 'gun') continue;
        const w = this.moduleWorld(def, _v2);
        const d = w.distanceTo(_p1);
        if (d < ammo.blastRadius * 0.6) this.damageModule(def.id, (1 - d / (ammo.blastRadius * 0.6)) * 0.9, rep);
      }
      if (armour.outcome !== 'pen') {
        const loss = this.spec.hp * (ammo.id === 'HE' ? 0.035 : 0.01);
        this.hp -= loss;
        rep.hpLoss += loss;
      }
    }

    if (armour.outcome === 'pen') {
      const loss = this.spec.hp * ammo.damage * (0.8 + Math.random() * 0.4);
      this.hp -= loss;
      rep.hpLoss += loss;
      // spall cone: modules near the shot line inside the vehicle
      const spallLen = ammo.id === 'APFSDS' ? 3.5 : 2.2;
      _p1.copy(hit.point).addScaledVector(dir, spallLen);
      for (const def of this.moduleDefs) {
        if (def.id === 'trackL' || def.id === 'trackR') continue; // tracks are outside the hull
        const w = this.moduleWorld(def, _v2);
        const d = distPointSegment(w, hit.point, _p1);
        if (d < def.r + 0.4) {
          this.damageModule(def.id, 0.45 + Math.random() * 0.6, rep);
          if (def.id === 'ammo') {
            // west: bustle rack behind blow-out panels; east: carousel under the crew
            const p = this.moduleDefs.find((q) => q.id === 'ammo')!.frame === 'turret' ? 0.18 : 0.55;
            if (Math.random() < p) rep.cookOff = true;
          }
          if (def.id === 'fuel' && Math.random() < 0.35) rep.fire = true;
          if (def.id === 'engine' && Math.random() < 0.2) rep.fire = true;
        }
      }
    }
    if (rep.fire) this.burning = Math.max(this.burning, 9);
    if (rep.cookOff) this.hp = 0;
    if (this.hp <= 0) {
      this.hp = 0;
      rep.outcome = 'kill';
    }
    return rep;
  }

  private damageModule(id: ModuleId, amount: number, rep: DamageReport): void {
    const before = this.modules[id];
    this.modules[id] = Math.max(0, this.modules[id] - amount);
    if (this.modules[id] < before && !rep.modules.includes(id)) rep.modules.push(id);
    if (this.modules[id] <= 0) this.repairT[id] = 0;
  }

  moduleWorld(def: ModuleDef, out: THREE.Vector3): THREE.Vector3 {
    const obj = def.frame === 'hull' ? this.model.hull : this.model.turret;
    obj.updateWorldMatrix(true, false);
    // turret module positions are given relative to the turret pivot frame
    return out.copy(def.pos).applyMatrix4(obj.matrixWorld);
  }

  repairProgress(id: ModuleId): number {
    return this.modules[id] > 0 ? 1 : this.repairT[id] / REPAIR_TIME[id];
  }

  extinguish(): boolean {
    if (this.burning <= 0 || this.extinguishers <= 0) return false;
    this.extinguishers--;
    this.burning = 0;
    return true;
  }

  kill(cookOff: boolean): void {
    this.alive = false;
    this.throttle = 0;
    this.steer = 0;
    this.loaded = null;
    this.burning = 0;
    this.model.uniforms.uHeatBase.value = 2.2;
    if (cookOff) {
      const up = 12 + Math.random() * 8;
      this.turretFlying = {
        vel: new THREE.Vector3((Math.random() - 0.5) * 5, up, (Math.random() - 0.5) * 5),
        spin: new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4),
        landed: false,
      };
      // detach turret into world space so it can fly
      const t = this.model.turret;
      t.updateWorldMatrix(true, false);
      t.matrixWorld.decompose(t.position, t.quaternion, t.scale);
      this.model.root.parent?.add(t);
    }
  }

  private stepTurretToss(dt: number, world: World): void {
    const f = this.turretFlying;
    if (!f || f.landed) return;
    const t = this.model.turret;
    f.vel.y -= GRAVITY * dt;
    t.position.addScaledVector(f.vel, dt);
    t.rotation.x += f.spin.x * dt;
    t.rotation.y += f.spin.y * dt;
    t.rotation.z += f.spin.z * dt;
    const g = world.hf.heightAt(t.position.x, t.position.z);
    if (t.position.y < g + 0.2 && f.vel.y < 0) {
      t.position.y = g + 0.2;
      world.hf.normalAt(t.position.x, t.position.z, _tn);
      t.rotation.set(Math.atan2(_tn.z, _tn.y) * 0.8 + (Math.random() - 0.5) * 0.5, t.rotation.y, -Math.atan2(_tn.x, _tn.y) * 0.8 + 0.4);
      f.landed = true;
    }
  }

  /** Animate wheels, sprockets and scroll track textures; returns distance moved this step. */
  animateRunningGear(dt: number): number {
    const vPos = this.speed - this.yawRate * this.model.trackX; // left side (x>0) inner on left turns
    const vNeg = this.speed + this.yawRate * this.model.trackX;
    this.distPos += vPos * dt;
    this.distNeg += vNeg * dt;
    updateWheels(this.model, this.distNeg, this.distPos);
    const moved = Math.max(Math.abs(vPos), Math.abs(vNeg)) * dt;
    this.markAcc += moved;
    return moved;
  }

  /** True every ~0.7 m of travel: time to lay a pair of track marks. */
  takeTrackMark(): boolean {
    if (this.markAcc > 0.7) {
      this.markAcc = 0;
      return true;
    }
    return false;
  }

  trackContact(side: 1 | -1, out: THREE.Vector3): THREE.Vector3 {
    const lx = Math.cos(this.yaw);
    const lz = -Math.sin(this.yaw);
    const back = -this.spec.length * 0.36;
    return out.set(this.pos.x + lx * this.model.trackX * side + Math.sin(this.yaw) * back, 0, this.pos.z + lz * this.model.trackX * side + Math.cos(this.yaw) * back);
  }

  dispose(): void {
    this.model.root.removeFromParent();
    if (this.turretFlying) this.model.turret.removeFromParent();
    this.model.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.model.materials) m.dispose();
  }
}

const _gunC = new THREE.Vector3();
const _gunH = new THREE.Vector3();

function distPointSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz)));
  return Math.hypot(a.x + abx * t - p.x, a.y + aby * t - p.y, a.z + abz * t - p.z);
}
