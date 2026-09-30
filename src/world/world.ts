import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../config';
import { makeGroundLayers } from '../render/groundTextures';
import { makeNoiseSet, type NoiseSet } from '../render/textures';
import { buildBuildings, type Obb, segmentObb } from './buildings';
import { Decals } from './decals';
import { Grass } from './grass';
import { Heightfield } from './heightfield';
import { Terrain } from './terrain';
import { Vegetation } from './vegetation';
import { hyp3 } from '../core/mathx';

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  kind: 'terrain' | 'building' | 'none';
}

/** Static world: terrain, water, forests, buildings, ground decals, and the queries over them. */
export class World {
  readonly group = new THREE.Group();
  readonly hf: Heightfield;
  readonly noise: NoiseSet;
  readonly terrain: Terrain;
  readonly vegetation: Vegetation;
  readonly grass: Grass;
  readonly decals: Decals;
  readonly buildings: Obb[];

  constructor(seed: number, quality: QualityPreset) {
    this.hf = new Heightfield(seed);
    this.noise = makeNoiseSet(seed);
    this.terrain = new Terrain(this.hf, this.noise, makeGroundLayers(seed), quality.id === 'high');
    this.vegetation = new Vegetation(this.hf, this.noise, seed + 11, quality.id === 'low');
    this.grass = new Grass(this.hf, this.noise, quality.grassPerChunk, quality.grassRadius);
    this.decals = new Decals(this.hf);
    const b = buildBuildings(this.hf, seed + 5);
    this.buildings = b.colliders;
    this.group.add(this.terrain.group, this.vegetation.group, this.grass.group, this.decals.group, b.group);
  }

  /**
   * Segment cast against terrain and buildings. Terrain is marched in `step` metre increments
   * then refined by bisection.
   */
  raycast(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: RayHit, step = 3): RayHit {
    out.kind = 'none';
    out.t = 1;
    const len = hyp3(bx - ax, by - ay, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    let prevT = 0;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      if (y <= this.hf.heightAt(x, z)) {
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 10; i++) {
          const m = (lo + hi) / 2;
          const mx = ax + (bx - ax) * m;
          const my = ay + (by - ay) * m;
          const mz = az + (bz - az) * m;
          if (my <= this.hf.heightAt(mx, mz)) hi = m;
          else lo = m;
        }
        out.t = hi;
        out.kind = 'terrain';
        break;
      }
      prevT = t;
    }
    for (const c of this.buildings) {
      const t = segmentObb(c, ax, ay, az, bx, by, bz);
      if (t >= 0 && t < out.t) {
        out.t = t;
        out.kind = 'building';
      }
    }
    out.x = ax + (bx - ax) * out.t;
    out.y = ay + (by - ay) * out.t;
    out.z = az + (bz - az) * out.t;
    return out;
  }

  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    if (!this.hf.lineClear(ax, ay, az, bx, by, bz, 6)) return false;
    for (const c of this.buildings) if (segmentObb(c, ax, ay, az, bx, by, bz) >= 0) return false;
    return true;
  }

  update(dt: number, cam: THREE.Vector3): void {
    this.terrain.update(cam);
    this.grass.update(cam);
    this.vegetation.update(dt, cam);
  }
}
