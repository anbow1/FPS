import * as THREE from 'three/webgpu';
import { PLAY_HALF, RIFLE_556, RPG_ROCKET, WATER_LEVEL } from '../config';
import { Rng } from '../core/rng';
import { attribute, mix } from 'three/tsl';
import { UNIFORM_COLOURS, bootGeometry, handGeometry, headGeometry, helmetGeometry, launcherGeometry, limb as clothLimb, rifleGeometry, torsoGeometry, warheadGeometry } from '../render/infantryModel';
import { addThermalConst } from '../render/nodes';
import { pushOutObb } from '../world/buildings';
import type { World } from '../world/world';
import type { Audio } from './audio';
import { aimDirection, timeOfFlight } from './ballistics';
import type { Bullets, SoftTarget } from './bullets';
import type { Effects } from './effects';
import { PKind } from './effects';
import type { Projectiles } from './projectiles';
import type { Tank, Team } from './tank';
import { hyp2 } from '../core/mathx';

type Role = 'rpg' | 'rifle';
type State = 'hidden' | 'aim' | 'reload' | 'flee' | 'dead';

/** Anything the infantry can shoot at besides the tank (the recon drone). */
export interface AirTarget {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _dir = { x: 0, y: 0, z: 1 };
const _near: number[] = [];

export class Soldier implements SoftTarget {
  alive = true;
  readonly team: Team = 'enemy';
  readonly pos = new THREE.Vector3();
  yaw = 0;
  hp = 100;
  state: State = 'hidden';
  timer = 0;
  burst = 0;
  deadT = 0;
  fallDir = 0;
  fall = 0;
  runPhase = 0;
  alert = false;
  /** last time anything of ours saw this soldier (drone, gunner) */
  spottedUntil = -1;
  constructor(
    readonly role: Role,
    readonly squad: number,
    private readonly onKilled: (s: Soldier, how: string) => void,
  ) {}

  /** Vertical capsule test, shrinks when kneeling or lying. */
  hitTest(a: THREE.Vector3, b: THREE.Vector3): number {
    if (!this.alive) return -1;
    const top = this.state === 'hidden' || this.state === 'reload' ? 1.2 : 1.75;
    const r = 0.32;
    // closest approach between the segment and the soldier's axis, in xz plus a height check
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const fx = a.x - this.pos.x;
    const fz = a.z - this.pos.z;
    const aa = dx * dx + dz * dz;
    if (aa < 1e-9) return -1;
    const t = Math.max(0, Math.min(1, -(fx * dx + fz * dz) / aa));
    const cx = fx + dx * t;
    const cz = fz + dz * t;
    if (cx * cx + cz * cz > r * r) return -1;
    const y = a.y + (b.y - a.y) * t - this.pos.y;
    if (y < 0 || y > top) return -1;
    return t;
  }

  onBullet(_p: THREE.Vector3, dir: THREE.Vector3, damage: number): void {
    this.hp -= damage * (0.7 + Math.random() * 0.6);
    this.alert = true;
    if (this.hp <= 0) this.die(Math.atan2(dir.x, dir.z), 'bullet');
  }

  die(dir: number, how: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'dead';
    this.fallDir = dir;
    this.deadT = 0;
    this.onKilled(this, how);
  }
}

/**
 * Enemy infantry: AT ambush squads (RPG gunner + riflemen) dug in along the approach.
 * Rendering is one instanced mesh per body part (thighs, shins, torso, head, helmet, arms,
 * rifle, launcher), posed every frame from simple joint positions.
 */
export class Infantry {
  readonly group = new THREE.Group();
  readonly soldiers: Soldier[] = [];
  private rng = new Rng(4242);
  private parts: Record<string, THREE.InstancedMesh> = {};
  private squadCount = 0;
  kills = 0;
  onKill: (s: Soldier, how: string) => void = () => {};

  private readonly cap = 48;

  constructor() {
    // Clothes, kit and boots: per-vertex colour, darkened in the cloth's creases (render/infantryModel.ts).
    const uniform = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    // The uniform in each man's own colour (a per-instance `kit`), so a squad does not read as clones.
    uniform.colorNode = mix(attribute('color', 'vec3'), attribute('kit', 'vec3'), attribute('camo', 'float')).mul(attribute('shade', 'float'));
    const helmet = new THREE.MeshStandardNodeMaterial({ color: 0x5c5b3e, roughness: 0.7 });
    const skin = new THREE.MeshStandardNodeMaterial({ color: 0x9c7a62, roughness: 0.75 });
    const gun = new THREE.MeshStandardNodeMaterial({ color: 0x3c3c3e, roughness: 0.62 });
    const tube = new THREE.MeshStandardNodeMaterial({ color: 0x4b5340, roughness: 0.7 });
    // soldiers are warm bodies in the thermal sight
    addThermalConst(uniform, 1.5);
    addThermalConst(skin, 2.0);
    addThermalConst(helmet, 0.9);
    addThermalConst(gun, 0.3);
    addThermalConst(tube, 0.3);
    const defs: [string, THREE.BufferGeometry, THREE.Material, number][] = [
      // Trousers loose and full at the thigh, bunched behind the knee and over the boot; sleeves at the elbow.
      [
        'thigh',
        clothLimb(
          0.45,
          [
            [0, 0.094],
            [0.15, 0.09],
            [0.6, 0.077],
            [1, 0.064],
          ],
          0.94,
          [
            [0.1, 0.07, 0.005],
            [0.92, 0.07, 0.007],
          ],
          3,
        ),
        uniform,
        2,
      ],
      [
        'shin',
        clothLimb(
          0.47,
          [
            [0, 0.066],
            [0.3, 0.067],
            [0.75, 0.059],
            [0.9, 0.062],
            [1, 0.057],
          ],
          0.95,
          [
            [0.06, 0.07, 0.005],
            [0.86, 0.08, 0.008],
          ],
          4,
        ),
        uniform,
        2,
      ],
      [
        'upperArm',
        clothLimb(
          L_UPPER_ARM,
          [
            [0, 0.064],
            [0.25, 0.06],
            [1, 0.048],
          ],
          0.92,
          [
            [0.12, 0.08, 0.004],
            [0.92, 0.07, 0.006],
          ],
          1,
        ),
        uniform,
        2,
      ],
      [
        'forearm',
        clothLimb(
          L_FOREARM,
          [
            [0, 0.051],
            [0.3, 0.05],
            [1, 0.04],
          ],
          0.85,
          [[0.08, 0.08, 0.005]],
          2,
        ),
        uniform,
        2,
      ],
      ['hand', handGeometry(), uniform, 2],
      ['boot', bootGeometry(), uniform, 2],
      ['torso', torsoGeometry(), uniform, 1],
      ['head', headGeometry(), skin, 1],
      ['helmet', helmetGeometry(), helmet, 1],
      ['rifle', rifleGeometry(), gun, 1],
      ['rpg', launcherGeometry(), tube, 1],
      ['warhead', warheadGeometry(), gun, 1],
    ];
    for (const [name, g, m, per] of defs) {
      g.setAttribute('kit', new THREE.InstancedBufferAttribute(new Float32Array(this.cap * per * 3), 3));
      const im = new THREE.InstancedMesh(g, m, this.cap * per);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.parts[name] = im;
      this.group.add(im);
    }
  }

  clear(): void {
    this.soldiers.length = 0;
    this.squadCount = 0;
  }

  /** Place an ambush squad in cover somewhere between `from` and `towards`. */
  spawnSquad(world: World, from: THREE.Vector3, towards: THREE.Vector3): void {
    const rng = this.rng;
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let a = 0; a < 60; a++) {
      const t = rng.range(0.25, 0.75);
      const side = rng.range(-220, 220);
      const dx = towards.x - from.x;
      const dz = towards.z - from.z;
      const d = hyp2(dx, dz) || 1;
      const x = from.x + dx * t + (-dz / d) * side;
      const z = from.z + dz * t + (dx / d) * side;
      if (Math.abs(x) > PLAY_HALF - 40 || Math.abs(z) > PLAY_HALF - 40) continue;
      const y = world.hf.heightAt(x, z);
      if (y < WATER_LEVEL + 1) continue;
      if (hyp2(x - from.x, z - from.z) < 280) continue;
      // cover: trees or a building nearby, road in view
      const trees = world.vegetation.query(x, z, 14, []).length;
      if (world.insideBuilding(x, z, 2)) continue;
      const house = world.insideBuilding(x, z, 12);
      const road = world.hf.roadAt(x, z) > 0.1 ? -3 : 0;
      const score = Math.min(trees, 5) + (house ? 4 : 0) + road + rng.next();
      if (score > bestScore) {
        bestScore = score;
        best = [x, z];
      }
    }
    if (!best) return;
    const squad = this.squadCount++;
    const n = 3 + rng.int(0, 1);
    const face = Math.atan2(from.x - best[0], from.z - best[1]);
    for (let i = 0; i < n && this.soldiers.length < this.cap; i++) {
      const s = new Soldier(i === 0 || (i === 3 && rng.next() < 0.5) ? 'rpg' : 'rifle', squad, (x, how) => this.killed(x, how));
      const ang = face + (i - n / 2) * 0.9 + rng.range(-0.3, 0.3);
      const r = 3 + rng.next() * 6;
      let x = best[0] + Math.cos(ang) * r;
      let z = best[1] + Math.sin(ang) * r;
      // a man who would stand inside a house waits at the squad's spot instead
      if (world.insideBuilding(x, z, 0.6)) {
        x = best[0];
        z = best[1];
      }
      s.pos.set(x, world.hf.heightAt(x, z), z);
      s.yaw = face + rng.range(-0.3, 0.3);
      s.timer = rng.range(0, 2);
      this.soldiers.push(s);
    }
  }

  private killed(s: Soldier, how: string): void {
    this.kills++;
    this.onKill(s, how);
  }

  /** Kill or wound everybody near an explosion. */
  blast(p: THREE.Vector3, radius: number): void {
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      const d = s.pos.distanceTo(p);
      if (d < radius) {
        s.hp -= 160 * (1 - d / radius) + 30;
        s.alert = true;
        if (s.hp <= 0) s.die(Math.atan2(s.pos.x - p.x, s.pos.z - p.z), 'blast');
      }
    }
  }

  update(
    dt: number, time: number, world: World, player: Tank, drone: AirTarget | null,
    projectiles: Projectiles, bullets: Bullets, effects: Effects, audio: Audio,
  ): void {
    const pp = player.centre(_w).clone();
    for (const s of this.soldiers) {
      if (!s.alive) {
        s.deadT += dt;
        s.fall = Math.min(1, s.fall + dt * 2.5);
        continue;
      }
      // tanks crush anybody who does not get out of the way
      const dxp = s.pos.x - player.pos.x;
      const dzp = s.pos.z - player.pos.z;
      const dist = hyp2(dxp, dzp);
      if (player.alive && dist < 2.4 && Math.abs(player.speed) > 0.5) {
        s.die(player.yaw, 'crushed');
        continue;
      }
      s.timer -= dt;
      const head = _v.copy(s.pos).setY(s.pos.y + 1.3);
      const seesTank = player.alive && dist < 520 && world.lineOfSight(head.x, head.y, head.z, pp.x, pp.y + 0.8, pp.z);
      if (seesTank && dist < 420) s.alert = true;
      if (player.alive && time - player.lastShotTime < 1 && dist < 700) s.alert = true;
      const seesDrone = !!drone && drone.alive && s.pos.distanceTo(drone.pos) < 300 && world.lineOfSight(head.x, head.y, head.z, drone.pos.x, drone.pos.y, drone.pos.z);

      if (dist < 30 && player.alive && s.state !== 'flee') {
        s.state = 'flee';
        s.timer = 6;
      }
      switch (s.state) {
        case 'hidden':
          if (s.alert && s.timer <= 0) {
            if (s.role === 'rpg' && seesTank && dist < 330) {
              s.state = 'aim';
              s.timer = 2.2 + Math.random();
            } else if (s.role === 'rifle' && (seesDrone || (seesTank && dist < 450))) {
              s.state = 'aim';
              s.timer = 0.6;
              s.burst = 3 + Math.floor(Math.random() * 3);
            }
          }
          if (seesTank) s.yaw = turnTo(s.yaw, Math.atan2(-dxp, -dzp), dt * 2);
          break;
        case 'aim': {
          const target = s.role === 'rifle' && seesDrone ? drone!.pos : pp;
          s.yaw = turnTo(s.yaw, Math.atan2(target.x - s.pos.x, target.z - s.pos.z), dt * 3);
          if (s.timer > 0) break;
          const muzzle = _v.copy(s.pos).setY(s.pos.y + 1.45);
          if (s.role === 'rpg') {
            if (!seesTank || dist > 360) {
              s.state = 'hidden';
              s.timer = 1;
              break;
            }
            // lead the tank with the rocket's time of flight, plus aiming error
            const tof = timeOfFlight(RPG_ROCKET, dist);
            const aim = pp.clone().addScaledVector(player.velocity, tof * 0.8);
            aimDirection(RPG_ROCKET, muzzle, aim, _dir);
            const d = new THREE.Vector3(_dir.x, _dir.y, _dir.z);
            const err = 0.012 + dist * 0.00002;
            d.x += (Math.random() - 0.5) * err * 2;
            d.y += (Math.random() - 0.5) * err;
            d.z += (Math.random() - 0.5) * err * 2;
            d.normalize();
            projectiles.fireRocket(RPG_ROCKET, muzzle, d);
            // back-blast behind the gunner
            for (let k = 0; k < 16; k++) {
              effects.emit(PKind.Smoke, muzzle.x - d.x * 1.2, muzzle.y, muzzle.z - d.z * 1.2, -d.x * (4 + Math.random() * 8) + (Math.random() - 0.5) * 3, Math.random() * 2, -d.z * (4 + Math.random() * 8) + (Math.random() - 0.5) * 3,
                1.2, 2 + Math.random() * 2, 0.6, 0.58, 0.55, 0.45, 3);
            }
            effects.flash(muzzle, 1.5e5, 0.05);
            audio.rocketLaunch(muzzle);
            s.state = 'reload';
            s.timer = 9 + Math.random() * 3;
          } else {
            // short bursts; tracers every third round
            const tgt = seesDrone ? drone!.pos.clone().addScaledVector(drone!.vel, s.pos.distanceTo(drone!.pos) / RIFLE_556.v0) : pp;
            const dir = tgt.clone().sub(muzzle).normalize();
            // a small drone is a hard target for a rifleman: wide spread, worse with range
            const spread = seesDrone ? 0.03 + s.pos.distanceTo(tgt) * 0.00008 : 0.012;
            dir.x += (Math.random() - 0.5) * spread;
            dir.y += (Math.random() - 0.5) * spread;
            dir.z += (Math.random() - 0.5) * spread;
            dir.normalize();
            dir.y += (s.pos.distanceTo(tgt) * 9.81) / (2 * RIFLE_556.v0 * RIFLE_556.v0); // crude holdover
            bullets.fire(RIFLE_556, 'enemy', muzzle, dir.normalize(), s.burst % 3 === 0);
            audio.rifle(muzzle);
            s.burst--;
            s.timer = 0.11;
            if (s.burst <= 0) {
              s.state = 'hidden';
              s.timer = 1.2 + Math.random() * 1.5;
              s.alert = seesDrone || seesTank;
            }
          }
          break;
        }
        case 'reload':
          if (s.timer <= 0) s.state = 'hidden';
          break;
        case 'flee': {
          // run away from the tank towards the nearest trees
          const away = Math.atan2(dxp, dzp);
          s.yaw = turnTo(s.yaw, away, dt * 5);
          const sp = 4.2;
          s.pos.x += Math.sin(s.yaw) * sp * dt;
          s.pos.z += Math.cos(s.yaw) * sp * dt;
          // walls stop a runner: slide along them
          for (const k of world.nearBuildings(s.pos.x, s.pos.z, 1, _near)) pushOutObb(world.buildings[k]!, s.pos, 0.4);
          s.pos.y = world.hf.heightAt(s.pos.x, s.pos.z);
          s.runPhase += dt * 9;
          if (s.timer <= 0 && dist > 45) {
            s.state = 'hidden';
            s.timer = 1;
          }
          break;
        }
        case 'dead':
          break;
      }
    }
  }

  /** Units visible to us for the HUD / minimap. */
  spotted(time: number): Soldier[] {
    return this.soldiers.filter((s) => s.alive && s.spottedUntil > time);
  }

  // ---------------------------------------------------------------- rendering
  private counts: Record<string, number> = {};
  /** The uniform colour of the man being posed. */
  private kit: readonly number[] = UNIFORM_COLOURS[0]!;
  private put(name: string, m: THREE.Matrix4): void {
    const im = this.parts[name]!;
    const i = this.counts[name] ?? 0;
    if (i >= im.instanceMatrix.count) return;
    im.setMatrixAt(i, m);
    (im.geometry.getAttribute('kit').array as Float32Array).set(this.kit, i * 3);
    this.counts[name] = i + 1;
  }

  render(camPos: THREE.Vector3): void {
    this.counts = {};
    this.soldiers.forEach((s, k) => {
      if (s.deadT > 40) return;
      if (s.pos.distanceTo(camPos) > 700) return;
      this.kit = UNIFORM_COLOURS[(k * 7 + s.squad * 3) % UNIFORM_COLOURS.length]!;
      this.pose(s);
    });
    for (const [name, im] of Object.entries(this.parts)) {
      im.count = this.counts[name] ?? 0;
      im.instanceMatrix.needsUpdate = true;
      im.geometry.getAttribute('kit').needsUpdate = true;
    }
  }

  private pose(s: Soldier): void {
    const root = _root.makeRotationY(s.yaw).setPosition(s.pos);
    if (!s.alive) {
      // fall over in the hit direction
      const ax = _ax.set(Math.cos(s.fallDir), 0, -Math.sin(s.fallDir));
      _rot.makeRotationAxis(ax, (s.fall * Math.PI) / 2 * 0.95);
      root.copy(_rot.premultiply(_tr.makeTranslation(s.pos.x, s.pos.y + 0.12 * s.fall, s.pos.z)).multiply(_tr.makeRotationY(s.yaw)));
    }
    const kneel = s.alive && (s.state === 'hidden' || s.state === 'reload' || (s.state === 'aim' && s.role === 'rifle'));
    const running = s.state === 'flee';
    const hip = kneel ? 0.55 : 0.95;
    const ph = s.runPhase;
    // leg joints (local space, +z forward)
    const legs: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
    for (const side of [-1, 1]) {
      const hx = side * 0.1;
      let knee: THREE.Vector3;
      let foot: THREE.Vector3;
      if (kneel) {
        if (side < 0) {
          knee = new THREE.Vector3(hx, 0.1, -0.05);
          foot = new THREE.Vector3(hx, 0.06, -0.5);
        } else {
          knee = new THREE.Vector3(hx, 0.48, 0.42);
          foot = new THREE.Vector3(hx, 0.02, 0.45);
        }
      } else {
        const swing = running ? Math.sin(ph + (side > 0 ? 0 : Math.PI)) * 0.6 : 0;
        knee = new THREE.Vector3(hx, hip - 0.45 * Math.cos(swing), 0.45 * Math.sin(swing));
        foot = knee.clone().add(new THREE.Vector3(0, -0.47, running ? -0.2 * Math.max(0, -Math.sin(ph + (side > 0 ? 0 : Math.PI))) : 0));
      }
      legs.push([new THREE.Vector3(hx, hip, 0), knee, foot]);
    }
    for (const [h, k, f] of legs) {
      this.put('thigh', this.seg(root, h, k));
      this.put('shin', this.seg(root, k, f));
      this.put('boot', _t2.multiplyMatrices(root, _m2.makeTranslation(f.x, f.y, f.z)));
    }
    const lean = running ? 0.35 : s.state === 'aim' ? 0.08 : 0.12;
    _m.makeRotationX(lean).setPosition(0, hip, 0);
    const torso = _tm.multiplyMatrices(root, _m);
    this.put('torso', torso);
    const neck = new THREE.Vector3(0, 0.62, 0).applyMatrix4(_m);
    _m2.makeTranslation(neck.x, neck.y + 0.08, neck.z);
    this.put('head', _t2.multiplyMatrices(root, _m2));
    this.put('helmet', _t2.multiplyMatrices(root, _m2.makeTranslation(neck.x, neck.y + 0.1, neck.z)));
    // arms and weapon
    const shoulderY = new THREE.Vector3(0, 0.5, 0).applyMatrix4(_m).y;
    const rpgUp = s.role === 'rpg' && s.state === 'aim';
    const gunPos = rpgUp ? new THREE.Vector3(0.12, shoulderY + 0.12, 0.05) : new THREE.Vector3(0.05, shoulderY - 0.05, 0.25);
    for (const side of [-1, 1]) {
      const sh = new THREE.Vector3(side * 0.21, shoulderY, Math.sin(lean) * 0.5);
      const hand = gunPos.clone().add(new THREE.Vector3(side * 0.05, -0.05, side > 0 ? 0.05 : 0.35));
      // Elbows out and down, by two-bone IK: a straight stick from shoulder to grip read as a mannequin.
      const elbow = elbowFor(sh, hand, _pole.set(side * 0.8, -1, -0.25));
      this.put('upperArm', this.seg(root, sh, elbow));
      this.put('forearm', this.seg(root, elbow, hand));
      // The hand hangs from the wrist along the forearm.
      _d.subVectors(elbow, hand).normalize();
      _q.setFromUnitVectors(_up, _d);
      _m3.compose(hand, _q, _one);
      this.put('hand', _out.multiplyMatrices(root, _m3));
    }
    _m2.makeRotationX(rpgUp ? 0 : running ? 0.9 : s.state === 'aim' ? 0 : 0.5).setPosition(gunPos);
    const w = _t2.multiplyMatrices(root, _m2);
    if (s.role === 'rpg') {
      this.put('rpg', w);
      this.put('warhead', w);
    } else this.put('rifle', w);
  }

  private seg(root: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
    const d = _d.subVectors(b, a);
    const len = d.length();
    _q.setFromUnitVectors(_up, d.divideScalar(len || 1));
    _sc.set(1, len, 1);
    _m3.compose(a, _q, _sc);
    return _out.multiplyMatrices(root, _m3);
  }
}

const L_UPPER_ARM = 0.29;
const L_FOREARM = 0.27;

/** The elbow between `shoulder` and `hand` for the arm's two bones, bent toward `pole`; straight when out of reach. */
function elbowFor(shoulder: THREE.Vector3, hand: THREE.Vector3, pole: THREE.Vector3): THREE.Vector3 {
  const u = _ikU.subVectors(hand, shoulder);
  const raw = u.length();
  if (raw < 1e-6) u.set(0, -1, 0);
  else u.multiplyScalar(1 / raw);
  const l1 = L_UPPER_ARM;
  const l2 = L_FOREARM;
  const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, raw));
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const v = _ikV.copy(pole).addScaledVector(u, -pole.dot(u));
  if (v.lengthSq() < 1e-8) v.set(u.y, -u.x, 0);
  v.normalize();
  return new THREE.Vector3().copy(shoulder).addScaledVector(u, l1 * cosA).addScaledVector(v, l1 * sinA);
}

function turnTo(a: number, b: number, rate: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + Math.max(-rate, Math.min(rate, d));
}

const _root = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _tr = new THREE.Matrix4();
const _ax = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _tm = new THREE.Matrix4();
const _t2 = new THREE.Matrix4();
const _out = new THREE.Matrix4();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);
const _pole = new THREE.Vector3();
const _ikU = new THREE.Vector3();
const _ikV = new THREE.Vector3();
