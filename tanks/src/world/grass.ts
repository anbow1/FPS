import * as THREE from 'three/webgpu';
import { HEIGHT_CELL, WATER_LEVEL, WORLD_SIZE } from '../config';
import { sampleWrap } from '../core/noise';
import { hyp2 } from '../core/mathx';
import { GrassField } from '../render/grassField.ts';
import { G, thermalOutput } from '../render/nodes';
import { linear, PBR } from '../render/palette';
import type { NoiseSet } from '../render/textures';
import { NOISE_SIZE } from '../render/textures';
import type { Heightfield } from './heightfield';
import { SITES } from './layout';

const MAX_PUSHERS = 10;
/** Density map cell (m): the field's own noise breaks it up below this. */
const DENSITY_CELL_M = 2;

/**
 * Grass: a field of real blades round the camera (render/grassField.ts, shared with anbow1/FPS),
 * rooted exactly on the terrain mesh's triangles. Where it grows follows the same rules the
 * terrain shader paints with: none on bare soil, rock, roads, near the water or in the villages;
 * dry meadows turn to paler, stiffer grass; sedge on the damp lake shores; darker under the forest.
 * Vehicles flatten it as they drive (a trampling map that recovers over ~9 s).
 */
export class Grass {
  readonly group = new THREE.Group();
  private field: GrassField | null = null;
  private readonly density: { data: Uint8Array; originX: number; originZ: number; cellM: number; size: number };
  private readonly heights: Float32Array;
  private readonly last: { x: number; z: number }[] = [];
  private bladesPerTile = 0;
  private radius = 0;

  constructor(
    private readonly hf: Heightfield,
    noise: NoiseSet,
    perChunk: number,
    radius: number,
  ) {
    this.heights = hf.heights;
    this.density = bakeDensity(hf, noise);
    for (let i = 0; i < MAX_PUSHERS; i++) this.last.push({ x: NaN, z: NaN });
    this.setDensity(perChunk, radius);
  }

  /** Quality change: rebuild the field (a menu action; the warm-up that follows compiles it). */
  setDensity(perChunk: number, radius: number): void {
    const blades = perChunk >= 3000 ? 420 : 200;
    const r = Math.min(radius, perChunk >= 3000 ? 45 : 26);
    if (blades === this.bladesPerTile && r === this.radius) return;
    this.bladesPerTile = blades;
    this.radius = r;
    if (this.field) this.group.remove(this.field.group);
    const green = linear(PBR.grassFresh.color);
    const dry = linear(PBR.grassDry.color);
    const hf = this.hf;
    this.field = new GrassField(
      { heights: this.heights, originX: -hf.half, originZ: -hf.half, cellM: HEIGHT_CELL, samplesX: hf.n, samplesZ: hf.n, split: 'bc' },
      this.density,
      {
        tileM: 4,
        bladesPerTile: blades,
        radiusM: r,
        // G.uWind is a direction with a gust scale of ~1; the field wants metres per second
        wind: G.uWind.mul(6),
        time: G.uTime,
        // seen from a tank's height: fewer, longer, broader blades read as grass, not as a fine carpet
        widthScale: 3.2,
        heightScale: 1.3,
        // leaning every which way: upright, they drew the meadow as vertical hatching from the turret
        leanScale: 1.9,
        // from a tank's height dark roots read as dashes on the ground: keep them almost as bright as the tips
        rootShade: 0.85,
        // the sheet colours are the terrain's base; its textured grass layer is ~1.7× brighter, and
        // blades darker than the ground under them read as stripes from a tank's height
        colours: {
          meadow: [green.r * 1.7, green.g * 1.7, green.b * 1.6],
          beach: [dry.r * 1.9, dry.g * 1.8, dry.b * 1.6],
          sedge: [green.r * 1.4, green.g * 1.5, green.b * 1.4],
          dry: [dry.r * 2.1, dry.g * 1.9, dry.b * 1.5],
        },
      },
    );
    thermalOutput(this.field.material, G.uDay.mul(0.08).add(0.07));
    this.group.add(this.field.group);
  }

  /** Vehicles flatten grass: xyz = position, r = radius. Called every frame per vehicle slot. */
  setPusher(i: number, x: number, _y: number, z: number, r: number): void {
    const last = this.last[i];
    if (!last || !this.field) return;
    const dx = Number.isNaN(last.x) ? 0 : x - last.x;
    const dz = Number.isNaN(last.z) ? 0 : z - last.z;
    last.x = x;
    last.z = z;
    if (r <= 0 || dx * dx + dz * dz < 1e-6) return;
    this.field.stamp(x, z, r, dx, dz, 0.6);
  }

  update(cam: THREE.Vector3, dtS = 1 / 60): void {
    // from the drone's altitude blades are sub-pixel: the field still follows, the view never sees it
    this.field?.update(cam, dtS, 60, window.innerHeight * window.devicePixelRatio);
  }

  /** Nothing to build ahead of time: the blades are placed by the GPU every frame. */
  warm(_cam: THREE.Vector3): void {}

  get material(): THREE.MeshStandardNodeMaterial | null {
    return this.field?.material ?? null;
  }
}

/** Meadow, beach (dry, pale) grass, sedge, canopy shade over the world on a 2 m grid. */
function bakeDensity(hf: Heightfield, noise: NoiseSet): { data: Uint8Array; originX: number; originZ: number; cellM: number; size: number } {
  const size = Math.round(WORLD_SIZE / DENSITY_CELL_M) + 1;
  const data = new Uint8Array(size * size * 4);
  const tn = { x: 0, y: 1, z: 0 };
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = -hf.half + i * DENSITY_CELL_M;
      const z = -hf.half + j * DENSITY_CELL_M;
      const macro = sampleWrap(noise.r, NOISE_SIZE, x / 1100, z / 1100);
      const macro2 = sampleWrap(noise.g, NOISE_SIZE, x / 380 + 0.3, z / 380 + 0.3);
      const mid = sampleWrap(noise.g, NOISE_SIZE, x / 64, z / 64);
      const dry = smooth(0.4, 0.66, macro * 0.7 + macro2 * 0.3 + (mid - 0.5) * 0.3);
      // grass thins before the patch's soil shows (terrain.ts: 0.78–0.93), a fringe of sparse blades
      const soil = smooth(0.74, 0.86, mid + dry * 0.06);
      const y = hf.heightAt(x, z);
      hf.normalAt(x, z, tn);
      const road = hf.roadAt(x, z);
      let keep = (1 - soil) * (1 - smooth(0.2, 0.33, 1 - tn.y)) * (1 - smooth(0.02, 0.2, road)) * smooth(WATER_LEVEL + 0.8, WATER_LEVEL + 1.4, y);
      for (const s of SITES) if (hyp2(x - s.x, z - s.z) < s.r * 0.35) keep *= 0.3;
      const damp = smooth(WATER_LEVEL + 0.4, WATER_LEVEL + 0.9, y) * (1 - smooth(WATER_LEVEL + 1.6, WATER_LEVEL + 3, y)) * (1 - smooth(0.2, 0.33, 1 - tn.y));
      const forest = sampleWrap(noise.g, NOISE_SIZE, x / 380 + 0.3, z / 380) * 0.7 + macro * 0.3;
      const o = (j * size + i) * 4;
      data[o] = Math.round(keep * (1 - dry * 0.7) * 255);
      data[o + 1] = Math.round(keep * dry * 0.7 * 255);
      data[o + 2] = Math.round(damp * 0.8 * 255);
      data[o + 3] = Math.round(smooth(0.5, 0.64, forest) * 255);
    }
  }
  return { data, originX: -hf.half, originZ: -hf.half, cellM: DENSITY_CELL_M, size };
}
