import * as THREE from 'three/webgpu';
import { DRONE } from '../config';
import { addThermalConst } from '../render/nodes';
import type { World } from '../world/world';
import type { SoftTarget } from './bullets';
import { type Effects, PKind } from './effects';
import type { Tank, Team } from './tank';
import { hyp2 } from '../core/mathx';

export type DroneState = 'stowed' | 'flying' | 'returning' | 'falling' | 'rearming';

const _v = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Small reconnaissance quadcopter carried on the tank. Flown from its gimbal camera; everything
 * the camera sees gets reported to the crew. Enemy MGs and riflemen can bring it down.
 */
export class Drone implements SoftTarget {
  readonly team: Team = 'player';
  readonly model = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  state: DroneState = 'stowed';
  camYaw = 0;
  camPitch = -0.35;
  battery = DRONE.battery;
  hp = DRONE.hp;
  spares = DRONE.spares;
  rearmT = 0;
  /** control demand: forward/right/up in -1..1 */
  input = { fwd: 0, right: 0, up: 0, boost: false };
  private rotors: THREE.Mesh[] = [];
  private spin = new THREE.Vector3();
  private body: THREE.Group;
  warning = '';

  constructor() {
    const grey = new THREE.MeshStandardNodeMaterial({ color: 0x6a6d71, roughness: 0.58 });
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x2b2b2d, roughness: 0.6 });
    const prop = new THREE.MeshStandardNodeMaterial({ color: 0x1c1c1c, roughness: 0.5, transparent: true, opacity: 0.35, depthWrite: false });
    const red = new THREE.MeshStandardNodeMaterial({ color: 0x300000, emissive: 0xff2010, emissiveIntensity: 4 });
    const green = new THREE.MeshStandardNodeMaterial({ color: 0x003000, emissive: 0x20ff30, emissiveIntensity: 4 });
    addThermalConst(grey, 0.9);
    addThermalConst(dark, 1.3);
    this.body = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.3), grey);
    this.body.add(hull);
    const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), dark);
    gimbal.position.set(0, -0.06, 0.12);
    this.body.add(gimbal);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.28), grey);
      arm.position.set(Math.sin(a) * 0.16, 0, Math.cos(a) * 0.16);
      arm.rotation.y = a;
      this.body.add(arm);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 10), dark);
      motor.position.set(Math.sin(a) * 0.29, 0.02, Math.cos(a) * 0.29);
      this.body.add(motor);
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.004, 20), prop);
      r.position.set(Math.sin(a) * 0.29, 0.05, Math.cos(a) * 0.29);
      this.body.add(r);
      this.rotors.push(r);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), i < 2 ? green : red);
      led.position.set(Math.sin(a) * 0.29, -0.01, Math.cos(a) * 0.29);
      this.body.add(led);
    }
    this.body.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.model.add(this.body);
    this.model.visible = false;
  }

  get alive(): boolean {
    return this.state === 'flying' || this.state === 'returning';
  }

  get airborne(): boolean {
    return this.state === 'flying' || this.state === 'returning' || this.state === 'falling';
  }

  reset(): void {
    this.state = 'stowed';
    this.spares = DRONE.spares;
    this.battery = DRONE.battery;
    this.hp = DRONE.hp;
    this.model.visible = false;
  }

  canLaunch(): boolean {
    return this.state === 'stowed' && this.spares > 0;
  }

  launch(tank: Tank): void {
    if (!this.canLaunch()) return;
    this.pos.copy(tank.pos).setY(tank.pos.y + 3.2);
    this.vel.set(0, 4, 0);
    this.camYaw = tank.yaw + tank.turretYaw;
    this.camPitch = -0.3;
    this.hp = DRONE.hp;
    this.state = 'flying';
    this.model.visible = true;
  }

  recall(): void {
    if (this.state === 'flying') this.state = 'returning';
  }

  hitTest(a: THREE.Vector3, b: THREE.Vector3): number {
    if (!this.alive) return -1;
    const r = 0.42;
    const d = _v.subVectors(b, a);
    const l2 = d.lengthSq();
    const t = Math.max(0, Math.min(1, ((this.pos.x - a.x) * d.x + (this.pos.y - a.y) * d.y + (this.pos.z - a.z) * d.z) / l2));
    const cx = a.x + d.x * t - this.pos.x;
    const cy = a.y + d.y * t - this.pos.y;
    const cz = a.z + d.z * t - this.pos.z;
    return cx * cx + cy * cy + cz * cz < r * r ? t : -1;
  }

  onBullet(_p: THREE.Vector3, dir: THREE.Vector3, damage: number): void {
    this.hp -= damage * 0.35;
    this.vel.addScaledVector(dir, 1.5);
    if (this.hp <= 0) this.shootDown();
  }

  shootDown(): void {
    if (!this.alive) return;
    this.state = 'falling';
    this.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8);
  }

  update(dt: number, world: World, tank: Tank, effects: Effects): void {
    this.warning = '';
    if (this.state === 'rearming') {
      this.rearmT -= dt;
      if (this.rearmT <= 0) {
        this.state = 'stowed';
        this.battery = DRONE.battery;
      }
      return;
    }
    if (this.state === 'stowed') {
      this.battery = Math.min(DRONE.battery, this.battery + dt * 2);
      return;
    }
    const ground = world.hf.heightAt(this.pos.x, this.pos.z);
    if (this.state === 'falling') {
      this.vel.y -= 9.81 * dt;
      this.vel.multiplyScalar(Math.exp(-dt * 0.3));
      this.pos.addScaledVector(this.vel, dt);
      this.body.rotation.x += this.spin.x * dt;
      this.body.rotation.y += this.spin.y * dt;
      this.body.rotation.z += this.spin.z * dt;
      if (Math.random() < dt * 30) effects.emit(PKind.Smoke, this.pos.x, this.pos.y, this.pos.z, 0, 0.5, 0, 0.4, 1.5, 0.15, 0.15, 0.15, 0.7, 3);
      if (this.pos.y <= ground + 0.1) {
        effects.explosionCore(this.pos.x, ground + 0.2, this.pos.z, 0.25);
        this.model.visible = false;
        this.spares--;
        this.state = 'rearming';
        this.rearmT = DRONE.rearm;
      }
      this.syncModel();
      return;
    }

    // battery and radio link
    const dist = hyp2(this.pos.x - tank.pos.x, this.pos.z - tank.pos.z);
    const speed = this.vel.length();
    this.battery -= dt * (1 + speed / DRONE.maxSpeed * 0.4);
    if (!tank.alive) this.warning = 'BRAK STACJI';
    if (dist > DRONE.range * 0.85) this.warning = 'SŁABY SYGNAŁ';
    if (this.battery < DRONE.battery * 0.15) this.warning = 'NISKA BATERIA';
    if ((dist > DRONE.range || this.battery < DRONE.battery * 0.1) && this.state === 'flying') this.state = 'returning';
    if (this.battery <= 0) {
      this.shootDown();
      return;
    }

    const want = _v;
    if (this.state === 'returning') {
      const home = tank.pos.clone().setY(tank.pos.y + 3.2);
      const d = home.clone().sub(this.pos);
      const flat = hyp2(d.x, d.z);
      const cruise = Math.max(ground + 25, home.y + 12);
      const targetY = flat > 25 ? cruise : home.y;
      want.set(d.x, 0, d.z).normalize().multiplyScalar(Math.min(DRONE.maxSpeed * 1.1, flat * 0.8));
      want.y = Math.max(-DRONE.climb, Math.min(DRONE.climb, (targetY - this.pos.y) * 0.8));
      this.camYaw = Math.atan2(d.x, d.z);
      if (d.length() < 2.5 || !tank.alive) {
        this.state = tank.alive ? 'stowed' : 'rearming';
        this.rearmT = DRONE.rearm;
        this.model.visible = false;
        return;
      }
    } else {
      const f = this.input.fwd;
      const r = this.input.right;
      const sp = DRONE.maxSpeed * (this.input.boost ? 1 : 0.6);
      want.set(Math.sin(this.camYaw) * f - Math.cos(this.camYaw) * r, 0, Math.cos(this.camYaw) * f + Math.sin(this.camYaw) * r).multiplyScalar(sp);
      want.y = this.input.up * DRONE.climb;
    }
    // first-order velocity response limited by the motors' thrust
    const dv = want.sub(this.vel);
    const maxDv = DRONE.accel * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    const accel = dv.clone().divideScalar(dt);
    this.vel.add(dv);
    this.pos.addScaledVector(this.vel, dt);
    // terrain, trees and ceiling
    const g2 = world.hf.heightAt(this.pos.x, this.pos.z);
    // over trees and roofs (the town's houses run to 35 m, the church spire to 60 m)
    const minY = Math.max(g2 + (world.vegetation.query(this.pos.x, this.pos.z, 4, []).length ? 16 : 1.5), world.roofAt(this.pos.x, this.pos.z) + 3);
    if (this.pos.y < minY) {
      this.pos.y = minY;
      this.vel.y = Math.max(0, this.vel.y);
    }
    if (this.pos.y > g2 + DRONE.ceiling) {
      this.pos.y = g2 + DRONE.ceiling;
      this.vel.y = Math.min(0, this.vel.y);
    }
    // body tilts into its acceleration, like a real multirotor
    const fwdA = accel.x * Math.sin(this.camYaw) + accel.z * Math.cos(this.camYaw);
    const sideA = accel.x * Math.cos(this.camYaw) - accel.z * Math.sin(this.camYaw);
    const tvx = this.vel.x * Math.sin(this.camYaw) + this.vel.z * Math.cos(this.camYaw);
    _e.set(Math.max(-0.5, Math.min(0.5, fwdA * 0.04 + tvx * 0.02)), this.camYaw, Math.max(-0.5, Math.min(0.5, sideA * 0.04)));
    this.body.quaternion.setFromEuler(_e);
    for (const rt of this.rotors) rt.rotation.y += dt * 90;
    this.syncModel();
  }

  private syncModel(): void {
    this.model.position.copy(this.pos);
  }

  cameraDir(out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.camPitch);
    return out.set(Math.sin(this.camYaw) * c, Math.sin(this.camPitch), Math.cos(this.camYaw) * c);
  }
}
