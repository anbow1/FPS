import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { attribute, dot, float, instancedBufferAttribute, max, mix, normalWorld, texture, uv, vec3 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import cargoInfo from '../../../shared/vehicles/cargo_truck/cargo_truck.json';
import staffInfo from '../../../shared/vehicles/staff_car/staff_car.json';
import { WATER_LEVEL } from '../config';
import { Rng } from '../core/rng';
import type { Audio } from '../game/audio';
import { type Effects, PKind } from '../game/effects';
import { G, thermalOutput } from '../render/nodes';
import type { Obb } from './buildings';
import type { Decals } from './decals';
import type { Heightfield } from './heightfield';
import { PLAYER_SPAWN, ROADS, SITES } from './layout';

// Soft-skinned vehicles left about the map: a six-wheeled cargo lorry and a staff car (shared/vehicles,
// CC BY; prepared by paris/tools/vehicles/prepare_truck.py, their real insignia painted out). Scenery, not
// combatants: parked along the roads and in the farmyards, they stop tanks and bullets as the houses do
// (their boxes join the building colliders, so collisions, the AI's probes, cover and lines of sight
// treat them alike), and burn when hit. A tank gun's round, a few 30 mm shells or a long machine-gun burst
// set one alight; HE nearby does too; a tank driving into one flattens it.

type Kind = 'cargo' | 'staff';

interface TruckInfo {
  size: number[];
  box: { min: number[]; max: number[] };
  albedo: number;
}

const INFO: Record<Kind, TruckInfo> = { cargo: cargoInfo, staff: staffInfo };
const URLS: Record<Kind, string> = {
  cargo: new URL('../../../shared/vehicles/cargo_truck/cargo_truck.glb', import.meta.url).href,
  staff: new URL('../../../shared/vehicles/staff_car/staff_car.glb', import.meta.url).href,
};

/** As the tanks' (importedTank.ts): the textures were painted dark for engines with light of their own. */
const PAINT_ALBEDO = 0.12;
const MAX_GAIN = 6;
/** Hit points: a 7.62 mm round takes ~1.4, a tank gun's round all of them. */
const HP = 100;
/** Seconds a wreck burns, and how long its steel stays warm in the thermal sight after. */
const BURN_S = 75;
const COOL_S = 240;

export type TruckState = 'parked' | 'burnt' | 'crushed';

export interface Truck {
  kind: Kind;
  x: number;
  y: number;
  z: number;
  /** Heading as the tanks': forward is (sin yaw, cos yaw). */
  yaw: number;
  pitch: number;
  roll: number;
  /** The roll it was parked at (a wreck leans further). */
  roll0: number;
  hp: number;
  state: TruckState;
  /** Seconds since it was wrecked. */
  wreckT: number;
  /** Its entry among the world's building colliders (its top drops when it burns or is flattened). */
  obb: Obb;
  top: number;
}

/** Where the lorries stand: beside the roads (pulled onto the verge) and in the farm and village yards. */
export function placeTrucks(hf: Pick<Heightfield, 'heightAt'>, blocked: (x: number, z: number, margin: number) => boolean, seed: number): Truck[] {
  const rng = new Rng(seed);
  const out: Truck[] = [];
  const tryPlace = (kind: Kind, x: number, z: number, yaw: number): boolean => {
    const info = INFO[kind];
    const hw = (info.size[0] ?? 2.5) / 2;
    const hd = (info.size[2] ?? 7) / 2;
    if (Math.hypot(x - PLAYER_SPAWN.x, z - PLAYER_SPAWN.z) < 90) return false;
    if (out.some((t) => Math.hypot(t.x - x, t.z - z) < 14)) return false;
    if (blocked(x, z, hd + 2)) return false;
    // The file faces -Z; the game's +Z forward is a half turn of it.
    const rot = yaw + Math.PI;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const at = (lx: number, lz: number): number => hf.heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
    const front = (at(-hw * 0.8, -hd * 0.8) + at(hw * 0.8, -hd * 0.8)) / 2;
    const back = (at(-hw * 0.8, hd * 0.8) + at(hw * 0.8, hd * 0.8)) / 2;
    const left = (at(-hw * 0.8, -hd * 0.8) + at(-hw * 0.8, hd * 0.8)) / 2;
    const right = (at(hw * 0.8, -hd * 0.8) + at(hw * 0.8, hd * 0.8)) / 2;
    const lowest = Math.min(front, back, left, right);
    // Not in the lakes, not on a bank steeper than a lorry would be left on.
    if (lowest < WATER_LEVEL + 1 || Math.abs(front - back) > hd * 0.35 || Math.abs(left - right) > hw * 0.3) return false;
    const y = (front + back) / 2 - 0.04;
    const top = y + (info.box.max[1] ?? 3);
    const obb: Obb = { x, z, y0: lowest - 0.3, y1: top, hw: hw * 0.92, hd, rot };
    const roll = Math.asin(Math.max(-1, Math.min(1, (right - left) / (hw * 1.6))));
    out.push({
      kind, x, y, z, yaw,
      pitch: Math.asin(Math.max(-1, Math.min(1, (front - back) / (hd * 1.6)))),
      roll, roll0: roll,
      hp: HP, state: 'parked', wreckT: 0, obb, top,
    });
    return true;
  };
  // Along the roads, every ~110 m by chance, pulled onto the verge, facing either way down it.
  for (const road of ROADS) {
    for (let i = 0; i + 1 < road.length; i++) {
      const [ax, az] = road[i]!;
      const [bx, bz] = road[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      for (let d = rng.range(20, 90); d < len - 20; d += rng.range(90, 160)) {
        if (rng.next() > 0.5) continue;
        const side = rng.next() < 0.5 ? -1 : 1;
        const off = rng.range(5.5, 8) * side;
        const yaw = Math.atan2(dx, dz) + (rng.next() < 0.5 ? 0 : Math.PI) + rng.range(-0.12, 0.12);
        tryPlace(rng.next() < 0.6 ? 'cargo' : 'staff', ax + dx * d - dz * off, az + dz * d + dx * off, yaw);
      }
    }
  }
  // A few in the yards: the farm's and the village's, at any heading.
  for (const site of SITES) {
    let placed = 0;
    for (let k = 0; k < 40 && placed < 3; k++) {
      const a = rng.range(0, Math.PI * 2);
      const r = site.r * rng.range(0.25, 0.85);
      if (tryPlace(rng.next() < 0.5 ? 'cargo' : 'staff', site.x + Math.cos(a) * r, site.z + Math.sin(a) * r, rng.range(0, Math.PI * 2))) placed++;
    }
  }
  return out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** The lorries: their state, colliders and instanced meshes; hits, blasts and rams wreck them. */
export class Trucks {
  readonly group = new THREE.Group();
  readonly list: Truck[];
  private meshes: { kind: Kind; mesh: THREE.InstancedMesh; index: number[] }[] = [];
  /** Per instance: 0 parked … 1 burnt out (the paint chars, glass goes), and its heat. */
  private burn = new Map<Kind, THREE.InstancedBufferAttribute>();
  private heat = new Map<Kind, THREE.InstancedBufferAttribute>();
  private fx: { effects: Effects; audio: Audio; decals: Decals } | null = null;
  private dirty = true;

  constructor(list: Truck[]) {
    this.list = list;
  }

  get colliders(): Obb[] {
    return this.list.map((t) => t.obb);
  }

  /** The game's effects and sound, for the fires and blasts. */
  bind(effects: Effects, audio: Audio, decals: Decals): void {
    this.fx = { effects, audio, decals };
  }

  /** Builds the instanced meshes from the loaded models (the colliders stand without them). */
  attach(models: Map<Kind, THREE.Group>): void {
    for (const kind of ['cargo', 'staff'] as Kind[]) {
      const scene = models.get(kind);
      const ids = this.list.map((t, i) => (t.kind === kind ? i : -1)).filter((i) => i >= 0);
      if (!scene || ids.length === 0) continue;
      const n = ids.length;
      const burn = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
      const heat = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(0.12), 1);
      this.burn.set(kind, burn);
      this.heat.set(kind, heat);
      const gain = Math.min(MAX_GAIN, Math.max(1, PAINT_ALBEDO / Math.max(INFO[kind].albedo, 1e-3)));
      scene.updateMatrixWorld(true);
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
        const src = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.MeshStandardMaterial;
        const mesh = new THREE.InstancedMesh(g, materialFor(src, gain, burn, heat), n);
        mesh.castShadow = !src.name.toLowerCase().includes('glass');
        mesh.receiveShadow = true;
        this.meshes.push({ kind, mesh, index: ids });
        this.group.add(mesh);
      });
    }
    this.dirty = true;
  }

  /** The lorry whose box holds the point (grown by `margin`), or -1. */
  at(p: THREE.Vector3, margin: number): number {
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i]!;
      if (p.y > t.obb.y1 + margin || p.y < t.obb.y0 - margin) continue;
      if (obbDistanceOf(t.obb, p.x, p.z) < margin) return i;
    }
    return -1;
  }

  /** Damage to lorry `i` at `p`; true when this set it alight. */
  damage(i: number, amount: number, p: THREE.Vector3): boolean {
    const t = this.list[i];
    if (!t || t.state === 'burnt') return false;
    if (t.state === 'parked') {
      t.hp -= amount;
      if (t.hp > 0) return false;
    }
    this.ignite(t, p);
    return true;
  }

  /** HE within `radius` of `p`: the blast and fragments, falling off with distance. */
  blast(p: THREE.Vector3, radius: number, scale: number): void {
    for (const t of this.list) {
      if (t.state === 'burnt') continue;
      const d = Math.max(0, obbDistanceOf(t.obb, p.x, p.z));
      if (d < radius) this.damage(this.list.indexOf(t), 140 * scale * (1 - d / radius), p);
    }
  }

  /**
   * A tank driving into lorry `i`: a parked one is flattened (its cab and body folded down, no fire), a
   * wreck crumples a little more. True if it gave way.
   */
  crush(i: number): boolean {
    const t = this.list[i];
    if (!t || t.state === 'crushed') return false;
    const wasParked = t.state === 'parked';
    t.state = 'crushed';
    t.hp = 0;
    if (wasParked) t.wreckT = BURN_S + COOL_S;
    t.roll += (Math.random() - 0.5) * 0.12;
    t.obb.y1 = t.y + (t.top - t.y) * 0.5;
    this.dirty = true;
    if (this.fx) {
      _p.set(t.x, t.y + 1, t.z);
      this.fx.audio.clang(_p, 1.4, false, false);
      for (let k = 0; k < 14; k++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * 5;
        this.fx.effects.emit(PKind.Debris, t.x, t.y + 1.2, t.z, Math.cos(a) * sp, 2 + Math.random() * 4, Math.sin(a) * sp, 0.15, 0.8 + Math.random() * 0.6, 0.15, 0.15, 0.14, 1, 1);
      }
    }
    return true;
  }

  private ignite(t: Truck, p: THREE.Vector3): void {
    t.state = 'burnt';
    t.hp = 0;
    t.wreckT = 0;
    // The tyres burn away and the canvas with them: it settles and the cargo bed's frame is all that stands.
    t.y -= 0.18;
    t.roll += (Math.random() - 0.5) * 0.06;
    t.obb.y1 = t.y + (t.top - t.y) * 0.8;
    this.dirty = true;
    if (!this.fx) return;
    const { effects, audio, decals } = this.fx;
    _p.set(t.x, t.y + 1.2, t.z);
    // The fuel tank goes up: a smaller fireball than a tank's ammunition, then a long diesel fire.
    effects.explosionCore(t.x, t.y + 1.2, t.z, 1.4);
    effects.addFire(t.x, t.y + 1.4, t.z, BURN_S, 0.9);
    audio.explosion(_p.lerp(p, 0.3), 1.6);
    decals.addScorch(t.x, t.z, 6);
  }

  /** Every lorry back as it was parked (a new battle). */
  reset(): void {
    for (const t of this.list) {
      if (t.state === 'burnt') t.y += 0.18;
      t.state = 'parked';
      t.roll = t.roll0;
      t.hp = HP;
      t.wreckT = 0;
      t.obb.y1 = t.top;
    }
    this.dirty = true;
  }

  update(dt: number): void {
    let warm = false;
    for (const t of this.list) {
      if (t.state === 'parked') continue;
      if (t.wreckT < BURN_S + COOL_S) {
        t.wreckT += dt;
        warm = true;
      }
    }
    if (warm || this.dirty) this.writeInstances();
  }

  private writeInstances(): void {
    for (const { kind, mesh, index } of this.meshes) {
      const burn = this.burn.get(kind);
      const heat = this.heat.get(kind);
      index.forEach((i, k) => {
        const t = this.list[i]!;
        if (this.dirty) {
          _e.set(t.pitch, t.yaw + Math.PI, t.roll);
          _q.setFromEuler(_e);
          _s.set(1, t.state === 'crushed' ? 0.55 : 1, 1);
          mesh.setMatrixAt(k, _m.compose(_p.set(t.x, t.y, t.z), _q, _s));
        }
        if (burn && heat) {
          burn.setX(k, t.state === 'burnt' ? Math.min(1, t.wreckT / 8) : t.state === 'crushed' ? 0.15 : 0);
          heat.setX(k, heatOf(t));
        }
      });
      if (this.dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    }
    for (const a of this.burn.values()) a.needsUpdate = true;
    for (const a of this.heat.values()) a.needsUpdate = true;
    this.dirty = false;
  }
}

/** Distance from (x, z) to a box's footprint (m), negative inside (as world.ts's, which imports this file). */
function obbDistanceOf(c: Obb, x: number, z: number): number {
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const lx = Math.abs((x - c.x) * cos - (z - c.z) * sin) - c.hw;
  const lz = Math.abs((x - c.x) * sin + (z - c.z) * cos) - c.hd;
  if (lx <= 0 && lz <= 0) return Math.max(lx, lz);
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
}

/** Thermal-sight heat: a cold parked lorry; a burning one white hot, then its steel cooling for minutes. */
function heatOf(t: Truck): number {
  if (t.state === 'parked') return 0.12;
  if (t.state === 'crushed' && t.wreckT >= BURN_S + COOL_S) return 0.12;
  if (t.wreckT < BURN_S) return 2.2;
  return 0.12 + 1.6 * Math.max(0, 1 - (t.wreckT - BURN_S) / COOL_S);
}

/**
 * The model's own textures, lifted to a real paint's albedo; the occlusion prepare_truck.py cast dims the
 * sky and bounce light. A burning lorry's paint chars to black and its glass goes; its heat (per
 * instance) drives the thermal sight.
 */
function materialFor(
  src: THREE.MeshStandardMaterial,
  gain: number,
  burnAttr: THREE.InstancedBufferAttribute,
  heatAttr: THREE.InstancedBufferAttribute,
): THREE.MeshStandardNodeMaterial {
  const burn = instancedBufferAttribute(burnAttr, 'float') as Node<'float'>;
  const glass = src.name.toLowerCase().includes('glass');
  const m = new THREE.MeshStandardNodeMaterial({ name: `truck ${src.name}` });
  const base = src.map ? texture(src.map, uv()).rgb.mul(glass ? 1 : gain) : vec3(src.color.r, src.color.g, src.color.b);
  m.colorNode = mix(base, vec3(0.025, 0.022, 0.02), burn.mul(0.92));
  m.roughnessNode = mix(float(glass ? 0.08 : 0.72), float(0.95), burn);
  m.metalnessNode = float(0);
  if (src.normalMap) {
    m.normalMap = src.normalMap;
    m.normalScale.copy(src.normalScale);
  }
  m.aoNode = attribute('color_1', 'vec3').x;
  if (glass) {
    // Glass: dark and glossy, gone once it burns.
    m.transparent = true;
    m.depthWrite = false;
    m.colorNode = vec3(0.02, 0.025, 0.028);
    m.opacityNode = float(0.6).mul(float(1).sub(burn));
  } else if (src.name.toLowerCase().includes('grill') && src.map) {
    // The radiator guard's picture is its mesh as a mask (white wire on black): dark steel wire, open between.
    m.colorNode = mix(vec3(0.05, 0.055, 0.045), vec3(0.025, 0.022, 0.02), burn);
    m.opacityNode = texture(src.map, uv()).r;
    m.alphaTest = 0.5;
  } else if (src.transparent || src.alphaTest > 0) {
    // Windows cut into a body texture's alpha: holes onto the modelled cab.
    m.alphaTest = 0.5;
    if (src.map) m.opacityNode = texture(src.map, uv()).a;
  }
  const heat = instancedBufferAttribute(heatAttr, 'float') as Node<'float'>;
  thermalOutput(m, heat.add(G.uDay.mul(0.06).mul(max(dot(normalWorld, G.uSunDir), 0))));
  return m;
}

/** Loads both models; a failure leaves the lorries as bare colliders (logged, not thrown). */
export async function loadTruckModels(): Promise<Map<Kind, THREE.Group>> {
  const loader = new GLTFLoader();
  const out = new Map<Kind, THREE.Group>();
  await Promise.all(
    (Object.keys(URLS) as Kind[]).map(async (kind) => {
      try {
        out.set(kind, (await loader.loadAsync(URLS[kind])).scene);
      } catch (err) {
        console.warn(`truck model ${kind} did not load:`, err);
      }
    }),
  );
  return out;
}
