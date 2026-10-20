import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../config';
import { makeGroundLayers } from '../render/groundTextures';
import { makeNoiseSet, type NoiseSet } from '../render/textures';
import { buildBuildings, type Obb, segmentObb } from './buildings';
import { BuildingIndex } from './buildingIndex';
import { buildCity } from './cityBuildings';
import { CityPlan, type Surface } from './cityPlan';
import { StreetLamps } from './cityProps';
import { makeBlockTexture } from '../render/cityGround';
import { Decals } from './decals';
import { Grass } from './grass';
import { Heightfield } from './heightfield';
import { Terrain } from './terrain';
import { Vegetation } from './vegetation';
import { hyp2, hyp3 } from '../core/mathx';

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  kind: 'terrain' | 'building' | 'none';
}

/** Grass cover by ground kind: none on paving, a little in the courtyards, full in the parks. */
const GRASS_COVER: Record<Surface, number> = { outside: 1, none: 1, park: 1, block: 0.35, street: 0, walk: 0, square: 0 };

/** Static world: terrain, water, forests, the village and the town, ground decals, and the queries over them. */
export class World {
  readonly group = new THREE.Group();
  readonly hf: Heightfield;
  readonly noise: NoiseSet;
  readonly terrain: Terrain;
  readonly vegetation: Vegetation;
  readonly grass: Grass;
  readonly decals: Decals;
  readonly buildings: Obb[];
  readonly city: CityPlan;
  readonly lamps: StreetLamps;
  private readonly index: BuildingIndex;
  private readonly hits: number[] = [];

  constructor(seed: number, quality: QualityPreset) {
    this.city = new CityPlan(seed + 31);
    this.hf = new Heightfield(seed, this.city);
    this.noise = makeNoiseSet(seed);
    this.terrain = new Terrain(this.hf, this.noise, makeGroundLayers(seed), quality.id === 'high', makeBlockTexture(this.city.blockTexels()));
    const city = this.city;
    // forests grow outside the town and on the lake shore; inside it only what the town plants
    const wild = (x: number, z: number): boolean => {
      const g = city.surfaceAt(x, z);
      return g === 'outside' || g === 'none';
    };
    this.vegetation = new Vegetation(this.hf, this.noise, seed + 11, quality.id === 'low', { wild, planted: city.trees });
    this.grass = new Grass(this.hf, this.noise, quality.grassPerChunk, quality.grassRadius, (x, z) => GRASS_COVER[city.surfaceAt(x, z)]);
    this.decals = new Decals(this.hf);
    const b = buildBuildings(this.hf, seed + 5);
    const town = buildCity(city, this.hf, quality.id === 'low');
    this.buildings = [...b.colliders, ...town.colliders];
    this.index = new BuildingIndex(this.buildings);
    this.lamps = new StreetLamps(city.lamps, this.hf);
    this.group.add(this.terrain.group, this.vegetation.group, this.grass.group, this.decals.group, b.group, town.group, this.lamps.group);
  }

  /** Indices of the building colliders that may lie within `r` of (x, z) (a superset; test each). */
  nearBuildings(x: number, z: number, r: number, out: number[]): number[] {
    return this.index.near(x, z, r, out);
  }

  /** True if (x, z) is inside a building's footprint grown by `marginM`. */
  insideBuilding(x: number, z: number, marginM: number): boolean {
    for (const k of this.index.near(x, z, marginM, this.hits)) if (obbDistance(this.buildings[k]!, x, z) < marginM) return true;
    return false;
  }

  /** Highest roof over (x, z), or −∞ where nothing is built (the drone's floor over the town). */
  roofAt(x: number, z: number): number {
    let top = -Infinity;
    for (const k of this.index.near(x, z, 0, this.hits)) {
      const c = this.buildings[k]!;
      if (obbDistance(c, x, z) <= 0) top = Math.max(top, c.y1);
    }
    return top;
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
    for (const k of this.index.alongSegment(ax, az, bx, bz, this.hits)) {
      const t = segmentObb(this.buildings[k]!, ax, ay, az, bx, by, bz);
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
    for (const k of this.index.alongSegment(ax, az, bx, bz, this.hits)) if (segmentObb(this.buildings[k]!, ax, ay, az, bx, by, bz) >= 0) return false;
    return true;
  }

  update(dt: number, cam: THREE.Vector3): void {
    this.terrain.update(cam);
    this.grass.update(cam, dt);
    this.vegetation.update(dt, cam);
    this.lamps.update(dt);
  }
}

/** Distance from (x, z) to an OBB's footprint (m); negative inside. */
export function obbDistance(c: Obb, x: number, z: number): number {
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const dx = x - c.x;
  const dz = z - c.z;
  const lx = Math.abs(dx * cos - dz * sin) - c.hw;
  const lz = Math.abs(dx * sin + dz * cos) - c.hd;
  if (lx <= 0 && lz <= 0) return Math.max(lx, lz);
  return hyp2(Math.max(lx, 0), Math.max(lz, 0));
}
