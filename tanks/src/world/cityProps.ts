import * as THREE from 'three/webgpu';
import { CITY } from '../config';
import { CITY_LIGHT } from '../render/cityMaterial';
import { LAMP_COLOUR } from '../render/cityGround';
import { box, cyl, mergeParts } from '../render/geom';
import { stdMat } from '../render/palette';
import { addThermalConst } from '../render/nodes';
import type { Spot } from './cityPlan';
import type { Heightfield } from './heightfield';

interface Lamp {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  /** 0 standing … 1 lying on the ground */
  fall: number;
  fallDirRad: number;
  falling: boolean;
}

const CELL_M = 16;

/**
 * Street lamps: a tapered steel mast, an arm over the carriageway and a flat LED head whose lens
 * lights at night. Two instanced draws for the whole town. A tank that drives into one folds it
 * over (the light pool painted on the paving stays: the shader's lamps are analytic).
 */
export class StreetLamps {
  readonly group = new THREE.Group();
  private readonly lamps: Lamp[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly posts: THREE.InstancedMesh;
  private readonly lenses: THREE.InstancedMesh;
  private dirty = false;

  constructor(spots: readonly Spot[], hf: Heightfield) {
    const H = CITY.lampHeightM;
    const post = mergeParts([
      cyl(0.1, 0.065, H, 8, 'y', 0, H / 2, 0),
      cyl(0.16, 0.15, 0.9, 8, 'y', 0, 0.45, 0),
      box(0.06, 0.06, 1.5, 0, H - 0.05, 0.72),
      box(0.36, 0.1, 0.66, 0, H - 0.05, 1.7),
    ]);
    const lens = mergeParts([box(0.28, 0.02, 0.54, 0, H - 0.11, 1.7)]);
    const steel = stdMat('parkerised', { roughness: 0.5 });
    addThermalConst(steel, 0.08);
    const glow = stdMat('windowGlass', { color: 0xd8d8d0, roughness: 0.2 });
    // the lens's luminance at night (pre-exposed, capped for display; game.ts sets it)
    glow.emissiveNode = LAMP_COLOUR.mul(CITY_LIGHT.lamp);
    addThermalConst(glow, 0.2);
    this.posts = new THREE.InstancedMesh(post, steel, Math.max(1, spots.length));
    this.lenses = new THREE.InstancedMesh(lens, glow, Math.max(1, spots.length));
    this.posts.castShadow = true;
    this.posts.receiveShadow = true;
    spots.forEach((s, k) => {
      const lamp: Lamp = { x: s.x, y: hf.heightAt(s.x, s.z), z: s.z, yawRad: s.yawRad, fall: 0, fallDirRad: 0, falling: false };
      this.lamps.push(lamp);
      const key = cellKey(s.x, s.z);
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(k);
      this.write(k);
    });
    this.posts.count = this.lenses.count = spots.length;
    this.posts.computeBoundingSphere();
    this.lenses.computeBoundingSphere();
    this.group.add(this.posts, this.lenses);
  }

  /** Standing lamps within `r` of (x, z). */
  query(x: number, z: number, r: number, out: number[]): number[] {
    out.length = 0;
    for (let i = Math.floor((x - r) / CELL_M); i <= Math.floor((x + r) / CELL_M); i++) {
      for (let j = Math.floor((z - r) / CELL_M); j <= Math.floor((z + r) / CELL_M); j++) {
        const list = this.grid.get(i * 100003 + j);
        if (!list) continue;
        for (const k of list) {
          const l = this.lamps[k]!;
          if (l.fall === 0 && !l.falling && (l.x - x) ** 2 + (l.z - z) ** 2 < r * r) out.push(k);
        }
      }
    }
    return out;
  }

  /** Fold a lamp over in the direction it is pushed. */
  knock(k: number, dx: number, dz: number): void {
    const l = this.lamps[k];
    if (!l || l.falling || l.fall > 0) return;
    l.falling = true;
    l.fallDirRad = Math.atan2(dx, dz);
  }

  update(dt: number): void {
    for (let k = 0; k < this.lamps.length; k++) {
      const l = this.lamps[k]!;
      if (!l.falling) continue;
      l.fall = Math.min(1, l.fall + dt * (0.5 + l.fall * 3));
      if (l.fall >= 1) l.falling = false;
      this.write(k);
    }
    if (this.dirty) {
      this.posts.instanceMatrix.needsUpdate = true;
      this.lenses.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }

  private write(k: number): void {
    const l = this.lamps[k]!;
    _q.setFromAxisAngle(_up, l.yawRad);
    if (l.fall > 0) {
      _axis.set(Math.cos(l.fallDirRad), 0, -Math.sin(l.fallDirRad));
      _q2.setFromAxisAngle(_axis, l.fall * Math.PI * 0.48);
      _q.premultiply(_q2);
    }
    _m.compose(_p.set(l.x, l.y, l.z), _q, _s);
    this.posts.setMatrixAt(k, _m);
    this.lenses.setMatrixAt(k, _m);
    this.dirty = true;
  }
}

function cellKey(x: number, z: number): number {
  return Math.floor(x / CELL_M) * 100003 + Math.floor(z / CELL_M);
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
