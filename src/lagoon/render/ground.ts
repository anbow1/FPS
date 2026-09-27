import { attribute, float, max, min, mix, normalMap, normalWorld, positionWorld, smoothstep, texture, triplanarTexture, vec2, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { fbm2 } from '../../core/noise.ts';
import { WATER_LEVEL_M } from '../config.ts';
import { beachWidth, cliffiness, heightAt, LAGOON_CENTRE, shoreDistance } from '../game/terrain.ts';
import type { LagoonWorld } from '../game/world.ts';
import { causticFoamMap, noiseMap, terrainSet } from './textures.ts';
import { U } from './uniforms.ts';

// The ground: a dense near mesh over the playable bay (1.25 m cells, with a
// skirt to hide the seam) and a coarse far mesh out to the volcano. One
// height-blended splat material (sand, grass, leaf litter, rock) driven by
// per-vertex weights, with a wet band at the waterline that follows the
// lapping waves, rain wetness and puddles, compacted dirt paths, and
// caustics on the lagoon floor.

const NEAR = { x0: -200, x1: 200, z0: -260, z1: 140, cellM: 1.25 } as const;
const FAR = { x0: -3000, x1: 3600, z0: -3600, z1: 1600, cellM: 20 } as const;

/** Trodden paths: shelter → beach, shelter → jungle, shelter → dock. */
export const PATHS: readonly (readonly [number, number])[][] = [
  [[-13.5, 9], [-9, 4.5], [-5, 1.2], [-2, -1.5]],
  [[-17.5, 16.8], [-20, 23], [-23.5, 31], [-25, 40], [-30, 52]],
  [[-11, 13.8], [-4, 13], [3, 10.5], [8.5, 4.5], [9, 2]],
];
const PATH_HALF_WIDTH_M = 0.9;

export function pathWeight(x: number, z: number): number {
  let best = 99;
  for (const path of PATHS) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i] as readonly [number, number];
      const b = path[i + 1] as readonly [number, number];
      const vx = b[0] - a[0];
      const vz = b[1] - a[1];
      const t = Math.min(1, Math.max(0, ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz)));
      best = Math.min(best, Math.hypot(x - a[0] - vx * t, z - a[1] - vz * t));
    }
  }
  const wobble = fbm2(x * 0.4, z * 0.4, 2, 61) * 0.35;
  return 1 - smooth(PATH_HALF_WIDTH_M * 0.5, PATH_HALF_WIDTH_M + wobble, best);
}

export function buildGround(world: LagoonWorld): Group {
  const material = groundMaterial();
  const group = new Group();
  group.name = 'ground';
  const trees = [...world.palms.map((p) => ({ x: p.x, z: p.z, r: 2.2 })), ...world.trees.map((t) => ({ x: t.x, z: t.z, r: t.heightM * 0.28 }))];
  const near = buildGrid(NEAR, trees, true);
  const far = buildGrid(FAR, [], false);
  for (const g of [near, far]) {
    const m = new Mesh(g, material);
    m.receiveShadow = true;
    m.castShadow = g === near; // the hills shade the bay at sunrise and sunset
    group.add(m);
  }
  return group;
}

interface GridSpec {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  cellM: number;
}

function buildGrid(spec: GridSpec, trees: { x: number; z: number; r: number }[], isNear: boolean): BufferGeometry {
  const nx = Math.round((spec.x1 - spec.x0) / spec.cellM) + 1;
  const nz = Math.round((spec.z1 - spec.z0) / spec.cellM) + 1;
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = heightAt(spec.x0 + i * spec.cellM, spec.z0 + j * spec.cellM);
  const h = (i: number, j: number): number => heights[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))] as number;
  const insideNear = (x: number, z: number, margin: number): boolean => x > NEAR.x0 + margin && x < NEAR.x1 - margin && z > NEAR.z0 + margin && z < NEAR.z1 - margin;

  const pos: number[] = [];
  const nor: number[] = [];
  const tan: number[] = [];
  const splat: number[] = [];
  const extra: number[] = [];
  const index: number[] = [];
  const vertexOf = new Int32Array(nx * nz).fill(-1);
  const bin = binTrees(trees);
  const vertex = (i: number, j: number, sinkM: number): number => {
    const x = spec.x0 + i * spec.cellM;
    const z = spec.z0 + j * spec.cellM;
    const y = h(i, j) - sinkM;
    const hx = (h(i + 1, j) - h(i - 1, j)) / (2 * spec.cellM);
    const hz = (h(i, j + 1) - h(i, j - 1)) / (2 * spec.cellM);
    const nl = Math.hypot(hx, 1, hz);
    const ny = 1 / nl;
    pos.push(x, y, z);
    nor.push(-hx / nl, ny, -hz / nl);
    const tl = Math.hypot(1, hx);
    tan.push(1 / tl, hx / tl, 0, 1);
    const w = splatAt(x, z, y, ny, isNear);
    splat.push(w.sand, w.grass, w.litter, w.rock);
    extra.push(w.path, isNear ? treeShade(bin, x, z) : farShade(x, z), canopyAt(x, z, y, ny));
    return pos.length / 3 - 1;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = spec.x0 + i * spec.cellM;
      const z = spec.z0 + j * spec.cellM;
      if (!isNear && insideNear(x, z, spec.cellM * 1.5)) continue;
      const sink = !isNear && insideNear(x, z, -1) ? 2.5 : 0;
      vertexOf[j * nx + i] = vertex(i, j, sink);
    }
  }
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = vertexOf[j * nx + i] as number;
      const b = vertexOf[j * nx + i + 1] as number;
      const c = vertexOf[(j + 1) * nx + i] as number;
      const d = vertexOf[(j + 1) * nx + i + 1] as number;
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      // Far sea floor that the ocean hides entirely: skip.
      if (!isNear && Math.max(pos[a * 3 + 1] as number, pos[b * 3 + 1] as number, pos[c * 3 + 1] as number, pos[d * 3 + 1] as number) < -14) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  if (isNear) addSkirt(nx, nz, vertexOf, pos, nor, tan, splat, extra, index);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('tangent', new BufferAttribute(new Float32Array(tan), 4));
  g.setAttribute('splat', new BufferAttribute(new Float32Array(splat), 4));
  g.setAttribute('extra', new BufferAttribute(new Float32Array(extra), 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** A 4 m curtain hanging from the near mesh's edge, so the far mesh never shows through a crack. */
function addSkirt(nx: number, nz: number, vertexOf: Int32Array, pos: number[], nor: number[], tan: number[], splat: number[], extra: number[], index: number[]): void {
  const ring: number[] = [];
  for (let i = 0; i < nx; i++) ring.push(vertexOf[i] as number);
  for (let j = 1; j < nz; j++) ring.push(vertexOf[j * nx + nx - 1] as number);
  for (let i = nx - 2; i >= 0; i--) ring.push(vertexOf[(nz - 1) * nx + i] as number);
  for (let j = nz - 2; j >= 0; j--) ring.push(vertexOf[j * nx] as number);
  const lower: number[] = [];
  for (const v of ring) {
    pos.push(pos[v * 3] as number, (pos[v * 3 + 1] as number) - 4, pos[v * 3 + 2] as number);
    nor.push(nor[v * 3] as number, nor[v * 3 + 1] as number, nor[v * 3 + 2] as number);
    tan.push(1, 0, 0, 1);
    splat.push(splat[v * 4] as number, splat[v * 4 + 1] as number, splat[v * 4 + 2] as number, splat[v * 4 + 3] as number);
    extra.push(0, extra[v * 3 + 1] as number, extra[v * 3 + 2] as number);
    lower.push(pos.length / 3 - 1);
  }
  for (let k = 0; k < ring.length - 1; k++) {
    const a = ring[k] as number;
    const b = ring[k + 1] as number;
    const c = lower[k] as number;
    const d = lower[k + 1] as number;
    index.push(a, b, c, b, d, c, a, c, b, b, c, d);
  }
}

interface Splat {
  sand: number;
  grass: number;
  litter: number;
  rock: number;
  path: number;
}

function splatAt(x: number, z: number, y: number, ny: number, isNear: boolean): Splat {
  const d = shoreDistance(x, z);
  const bw = beachWidth(x, z);
  const n = fbm2(x * 0.08, z * 0.08, 3, 51);
  const steep = 1 - smooth(0.62, 0.8, ny);
  const cliff = cliffiness(x, z);
  const far = Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z) > 260;
  // Sand lives near sea level: islets and the volcano rise out of it.
  let sand = (1 - smooth(bw - 1.5, bw + 2.5 + n * 3, d)) * (1 - smooth(1.4, 3.5, y));
  if (y < WATER_LEVEL_M) sand = Math.max(sand, 0.85);
  // Surf-washed rock at the foot of the cliffs, and anything steep.
  let rock = Math.max(steep, cliff > 0.55 && d > -4 && d < 6 ? (cliff - 0.55) * 2 * (0.6 + n) : 0);
  if (far && y > 180) rock = Math.max(rock, smooth(180, 320, y)); // bare volcanic slopes
  const inland = Math.max(0, d - bw);
  const aboveSea = smooth(1.4, 3.5, y) * (d < 0 ? 1 : 0); // islets and far shores
  const grassy = (1 - smooth(2, 8 + n * 5, inland)) * (1 - sand) + (far ? 0.7 : 0) + aboveSea;
  const grass = Math.max(0, grassy);
  const litter = Math.max(0, 1 - sand - grass);
  const path = isNear ? pathWeight(x, z) : 0;
  const sum = sand + grass + litter + rock + 1e-6;
  return { sand: sand / sum, grass: grass / sum, litter: litter / sum, rock: rock / sum, path };
}

type TreeBin = Map<number, { x: number; z: number; r: number }[]>;

function binTrees(trees: { x: number; z: number; r: number }[]): TreeBin {
  const bin: TreeBin = new Map();
  for (const t of trees) {
    const key = Math.floor(t.x / 10) * 10000 + Math.floor(t.z / 10);
    const list = bin.get(key) ?? [];
    list.push(t);
    bin.set(key, list);
  }
  return bin;
}

/** Baked occlusion under crowns: 1 open sky → ~0.55 under dense canopy. */
function treeShade(bin: TreeBin, x: number, z: number): number {
  let occ = 0;
  const cx = Math.floor(x / 10);
  const cz = Math.floor(z / 10);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = bin.get((cx + dx) * 10000 + cz + dz);
      if (!list) continue;
      for (const t of list) {
        const d2 = (x - t.x) ** 2 + (z - t.z) ** 2;
        occ += Math.exp(-d2 / (t.r * t.r));
      }
    }
  }
  return 1 - Math.min(0.45, occ * 0.22);
}

/**
 * How much of the ground is seen as the top of an unbroken jungle canopy:
 * the hills beyond the modelled trees, and the volcano's lower flanks.
 */
function canopyAt(x: number, z: number, y: number, ny: number): number {
  const r = Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z);
  const inland = shoreDistance(x, z) - beachWidth(x, z);
  const hills = smooth(5, 18, inland) * smooth(3, 10, y);
  const far = smooth(180, 300, r) * smooth(3, 10, y);
  const bare = smooth(260, 380, y) + (1 - smooth(0.55, 0.75, ny));
  return Math.max(0, Math.min(1, Math.max(hills, far) - bare));
}

/** Distant jungle reads as dark canopy from afar. */
function farShade(x: number, z: number): number {
  const r = Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z);
  return 1 - smooth(200, 400, r) * 0.35;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function groundMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'ground', roughness: 1, metalness: 0 });
  const sandT = terrainSet('sand');
  const grassT = terrainSet('grass');
  const litterT = terrainSet('litter');
  const rockT = terrainSet('rock');
  const noise = noiseMap();
  const cf = causticFoamMap();
  const p = positionWorld;
  // The tangent points +X and the bitangent −Z, so V runs along −Z.
  const base = vec2(p.x, p.z.negate());
  const uvS = base.div(3.2);
  const uvG = base.div(3.6);
  const uvL = base.div(3.0);
  const uvR = base.div(5.5);
  const w = attribute('splat', 'vec4');
  const extra = attribute('extra', 'vec3');
  const hS = texture(sandT.ormMap, uvS).a;
  const hG = texture(grassT.ormMap, uvG).a;
  const hL = texture(litterT.ormMap, uvL).a;
  const hR = texture(rockT.ormMap, uvR).a;
  // Height-blended splat: sand fills the gaps between leaves, rock pokes through turf.
  const aS = w.x.add(hS.mul(0.45));
  const aG = w.y.add(hG.mul(0.45));
  const aL = w.z.add(hL.mul(0.45));
  const aR = w.w.add(hR.mul(0.45));
  const top = max(max(aS, aG), max(aL, aR)).sub(0.22);
  const bS = max(aS.sub(top), 0);
  const bG = max(aG.sub(top), 0);
  const bL = max(aL.sub(top), 0);
  const bR = max(aR.sub(top), 0);
  const sum = bS.add(bG).add(bL).add(bR).add(1e-4);
  const kS = bS.div(sum);
  const kG = bG.div(sum);
  const kL = bL.div(sum);
  const kR = bR.div(sum);
  const blend = (s: Node<'vec4'>, g: Node<'vec4'>, l: Node<'vec4'>, r: Node<'vec4'>): Node<'vec4'> => s.mul(kS).add(g.mul(kG)).add(l.mul(kL)).add(r.mul(kR));
  // Rock is projected three ways so cliffs do not smear; the other layers lie flat.
  const rockColour = triplanarTexture(texture(rockT.map), null, null, float(1 / 5.5), positionWorld, normalWorld);
  let albedo: Node<'vec3'> = blend(texture(sandT.map, uvS), texture(grassT.map, uvG), texture(litterT.map, uvL), rockColour).rgb;
  const orm = blend(texture(sandT.ormMap, uvS), texture(grassT.ormMap, uvG), texture(litterT.ormMap, uvL), texture(rockT.ormMap, uvR));
  let nTex: Node<'vec3'> = blend(texture(sandT.normalMap, uvS), texture(grassT.normalMap, uvG), texture(litterT.normalMap, uvL), texture(rockT.normalMap, uvR)).xyz;

  // Macro variation kills the tile grid from a distance.
  const macro = texture(noise, p.xz.div(90)).r;
  albedo = albedo.mul(float(0.82).add(macro.mul(0.36)));
  // Compacted dirt paths.
  const path = extra.x.mul(float(1).sub(kS.mul(0.6)));
  albedo = mix(albedo, vec3(0.2, 0.15, 0.1).add(albedo.mul(0.25)), path.mul(0.75));
  // Unbroken canopy on the hills: clumped dark greens with sunlit crowns.
  const crowns = texture(noise, p.xz.div(14)).g.mul(0.6).add(texture(noise, p.xz.div(5)).b.mul(0.4));
  const canopyColour = mix(vec3(0.018, 0.04, 0.012), vec3(0.07, 0.13, 0.03), crowns).mul(float(0.8).add(macro.mul(0.4)));
  albedo = mix(albedo, canopyColour, extra.z);
  // Algae tint and darkening on the lagoon floor.
  const under = float(1).sub(smoothstep(-1.5, 0.0, p.y));
  albedo = albedo.mul(mix(vec3(1), vec3(0.8, 0.9, 0.84), under));

  // Wetness: a band that follows the lapping waves, everything under water, and rain.
  const lap = texture(noise, p.xz.div(25).add(U.time.mul(0.01))).g.sub(0.5).mul(0.25).add(0.05);
  const shoreWet = float(1).sub(smoothstep(0.0, 0.55, p.y.sub(lap))).mul(kS.add(kR.mul(0.6)));
  const wet = max(shoreWet, U.wetness.mul(0.95));
  const porous = kS.mul(0.5).add(kL.mul(0.45)).add(kG.mul(0.3)).add(kR.mul(0.3));
  albedo = albedo.mul(float(1).sub(wet.mul(porous)));
  const puddleNoise = texture(noise, p.xz.div(11)).r.add(normalWorld.y.sub(1).mul(8));
  const puddle = smoothstep(0.6, 0.66, puddleNoise).mul(smoothstep(0.5, 0.95, U.wetness)).mul(float(1).sub(kS)).mul(smoothstep(0.1, 0.4, p.y));
  albedo = mix(albedo, albedo.mul(0.35), puddle);
  const rough = mix(mix(mix(orm.g, float(0.9), extra.z), float(0.2), wet.mul(0.85)), float(0.03), puddle);
  nTex = mix(nTex, vec3(0.5, 0.5, 1), max(puddle, wet.mul(0.4)));

  m.colorNode = albedo;
  m.roughnessNode = rough;
  m.metalnessNode = float(0);
  m.normalNode = normalMap(nTex);
  // AO: texture cavities × baked canopy shade, indirect light only.
  m.aoNode = orm.r.mul(extra.y).mul(float(1).sub(extra.z.mul(0.4)));

  // Caustics on the lagoon floor: two drifting webs, their minimum is the sharp bright network.
  const depth = max(float(WATER_LEVEL_M).sub(p.y), 0);
  const c1 = texture(cf, p.xz.div(3.1).add(vec2(U.time.mul(0.021), U.time.mul(0.013)))).r;
  const c2 = texture(cf, p.xz.div(2.3).add(vec2(U.time.mul(-0.017), U.time.mul(0.019))).add(0.37)).r;
  const caustic = min(c1, c2).mul(3.2).mul(smoothstep(0.03, 0.3, depth)).mul(depth.mul(-0.22).exp()).mul(max(U.sunDir.y, 0));
  m.emissiveNode = albedo.mul(U.sunIrradiance).mul(caustic.div(Math.PI));
  return m;
}
