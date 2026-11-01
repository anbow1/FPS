import { attribute, cameraPosition, cos, float, fwidth, int, length, max, mix, normalMap, normalWorld, positionWorld, sin, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, type DataArrayTexture, Group, Mesh, MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { fbm2 } from '../core/noise.ts';
import { WATER_LEVEL_M } from '../config.ts';
import { beachWidth, cliffiness, heightAt, LAGOON_CENTRE, normalAt, shoreDistance } from '../game/terrain.ts';
import type { LagoonWorld } from '../game/world.ts';
import { noiseMap, terrainArray } from './textures.ts';
import { PHOTO_SIZE_M } from './photoTextures.ts';
import { shorePhase, swash } from './shoreWaves.ts';
import { type Caustics, causticAt } from './caustics.ts';
import { U } from './uniforms.ts';
import { rainRings } from './waterFx.ts';

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

export function buildGround(world: LagoonWorld, caustics: Caustics): Group {
  const material = groundMaterial(caustics);
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
    const shade = isNear ? treeShade(bin, x, z) : farShade(x, z);
    // Under the crowns the floor is leaf litter, not turf: grass needs the light the canopy takes.
    if (isNear) {
      const moved = w.grass * smooth(0.95, 0.72, shade) * 0.85;
      w.grass -= moved;
      w.litter += moved;
    }
    splat.push(w.sand, w.grass, w.litter, w.rock);
    extra.push(w.path, shade, canopyAt(x, z, y, ny));
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
  // Inland, a tropical slope is grown over up to ~60°: only true cliffs (and the beach's steep banks)
  // show bare rock. With bare rock from 37° on, the bay's hillsides read as brown scree between the trees.
  const inlandM = Math.max(0, d - bw);
  const grown = smooth(1, 5, inlandM);
  const steep = 1 - smooth(0.62 - 0.2 * grown, 0.8 - 0.2 * grown, ny);
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
  // Down to the back of the beach: in the island shooter we compared against the green comes right down
  // to the sand, and a band of bare litter at the foot of the hills read as a brown scar from the bay.
  const hills = smooth(1, 8, inland) * smooth(1, 4, y);
  const far = smooth(180, 300, r) * smooth(3, 10, y);
  const bare = smooth(260, 380, y) + (1 - smooth(0.35, 0.55, ny));
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

function groundMaterial(caustics: Caustics): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'ground', roughness: 1, metalness: 0 });
  // One array texture per map kind, one layer per ground type (sand, grass, litter, rock):
  // 3 bindings instead of 12, so the shader stays inside the 16-texture limit of WebGPU and phones.
  const layers = terrainArray();
  const LAYER = { sand: 0, grass: 1, litter: 2, rock: 3 } as const;
  const at = (tex: DataArrayTexture, uv: Node<'vec2'>, layer: number): Node<'vec4'> => texture(tex, uv).depth(int(layer));
  const noise = noiseMap();
  const p = positionWorld;
  // The tangent points +X and the bitangent −Z, so V runs along −Z.
  const base = vec2(p.x, p.z.negate());
  // Photographed layers repeat at their measured size (photoTextures.ts PHOTO_SIZE_M); the leaf litter a
  // little larger than life, as its 1.26 m repeat showed on the jungle floor.
  const uvS = base.div(PHOTO_SIZE_M.dense_sand);
  const uvG = base.div(3.6);
  const uvL = base.div(PHOTO_SIZE_M.leaves_forest_ground * 1.25);
  const uvR = base.div(PHOTO_SIZE_M.rock_face_03);
  const w = attribute('splat', 'vec4');
  const extra = attribute('extra', 'vec3');
  const ormS = at(layers.ormMap, uvS, LAYER.sand);
  const ormG = at(layers.ormMap, uvG, LAYER.grass);
  // The litter scan's AO (mean 0.68) is deep for a floor that also takes the canopy's occlusion (×0.55):
  // together they left the jungle floor black beside lit trunks. Keep half of its contrast.
  const ormLRaw = at(layers.ormMap, uvL, LAYER.litter);
  const ormL = vec4(ormLRaw.r.mul(0.5).add(0.5), ormLRaw.g, ormLRaw.b, ormLRaw.a);
  const ormR = at(layers.ormMap, uvR, LAYER.rock);
  // Height-blended splat: sand fills the gaps between leaves, rock pokes through turf.
  const aS = w.x.add(ormS.a.mul(0.45));
  const aG = w.y.add(ormG.a.mul(0.45));
  const aL = w.z.add(ormL.a.mul(0.45));
  const aR = w.w.add(ormR.a.mul(0.45));
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
  const tri = normalWorld.abs().pow(vec3(4));
  const triW = tri.div(tri.x.add(tri.y).add(tri.z));
  const rs = float(1 / PHOTO_SIZE_M.rock_face_03);
  const rockColour = at(layers.map, p.zy.mul(rs), LAYER.rock).mul(triW.x).add(at(layers.map, p.xz.mul(rs), LAYER.rock).mul(triW.y)).add(at(layers.map, p.xy.mul(rs), LAYER.rock).mul(triW.z));
  let albedo: Node<'vec3'> = blend(at(layers.map, uvS, LAYER.sand), at(layers.map, uvG, LAYER.grass), at(layers.map, uvL, LAYER.litter), rockColour).rgb;
  const orm = blend(ormS, ormG, ormL, ormR);
  let nTex: Node<'vec3'> = blend(at(layers.normalMap, uvS, LAYER.sand), at(layers.normalMap, uvG, LAYER.grass), at(layers.normalMap, uvL, LAYER.litter), at(layers.normalMap, uvR, LAYER.rock)).xyz;

  // Macro variation kills the tile grid from a distance.
  const macro = texture(noise, p.xz.div(90)).r;
  albedo = albedo.mul(float(0.82).add(macro.mul(0.36)));
  // Compacted dirt paths.
  const path = extra.x.mul(float(1).sub(kS.mul(0.6)));
  albedo = mix(albedo, vec3(0.2, 0.15, 0.1).add(albedo.mul(0.25)), path.mul(0.75));
  // Unbroken canopy on the hills: clumped dark greens with sunlit crowns.
  const crowns = texture(noise, p.xz.div(14)).g.mul(0.6).add(texture(noise, p.xz.div(5)).b.mul(0.4));
  const canopyColour = mix(vec3(0.018, 0.04, 0.012), vec3(0.07, 0.13, 0.03), crowns).mul(float(0.8).add(macro.mul(0.4)));
  // Only from afar: this paint stands for tree tops and dense understory, and up close, where the real
  // trees stand on the hill, it turned the jungle floor under them green (the litter's leaves tinted as
  // crowns). Past ~45 m the floor between trunks is hidden by shrubs in a real jungle: green, not litter.
  const canopyFar = smoothstep(18, 45, length(p.sub(cameraPosition)));
  albedo = mix(albedo, canopyColour, extra.z.mul(canopyFar));
  // Algae tint and darkening on the lagoon floor.
  const under = float(1).sub(smoothstep(-1.5, 0.0, p.y));
  albedo = albedo.mul(mix(vec3(1), vec3(0.8, 0.9, 0.84), under));

  // Wetness: the swash of the recent waves drying over half a minute (shoreWaves.ts), everything
  // under water, and rain. Wet sand is darker, a little more saturated, smoother and glossier.
  const sw = swash(p.xz, p.y.sub(WATER_LEVEL_M));
  const shoreWet = sw.wet.mul(kS.add(kR.mul(0.6)));
  const wet = max(shoreWet, U.wetness.mul(0.95));
  const porous = kS.mul(0.5).add(kL.mul(0.45)).add(kG.mul(0.3)).add(kR.mul(0.3));
  const lum = albedo.dot(vec3(0.2126, 0.7152, 0.0722));
  albedo = mix(vec3(lum), albedo, float(1).add(wet.mul(porous).mul(0.6)));
  albedo = albedo.mul(float(1).sub(wet.mul(porous)));
  const puddleNoise = texture(noise, p.xz.div(11)).r.add(normalWorld.y.sub(1).mul(8));
  const puddle = smoothstep(0.6, 0.66, puddleNoise).mul(smoothstep(0.5, 0.95, U.wetness)).mul(float(1).sub(kS)).mul(smoothstep(0.1, 0.4, p.y));
  albedo = mix(albedo, albedo.mul(0.35), puddle);
  // The swash sheet itself: a film of water a few centimetres thick with foam at its
  // leading edge and streaks as it drains. Not a mirror: the film is thin and rippled, so
  // it stays fairly rough and the sand shows through, a little darker and greener.
  const film = smoothstep(0.0, 0.02, sw.sheet);
  albedo = mix(albedo, albedo.mul(vec3(0.72, 0.8, 0.78)), film.mul(0.7));
  const foamy = sw.foam.mul(kS.add(kR));
  albedo = mix(albedo, vec3(0.78, 0.8, 0.78), foamy);
  let rough: Node<'float'> = mix(mix(mix(orm.g, float(0.9), extra.z), float(0.2), wet.mul(0.85)), float(0.03), puddle);
  rough = mix(rough, float(0.14), film);
  rough = mix(rough, float(0.75), foamy);
  // Submerged, the floor is not a glossy wet surface: rock under water reflects with the
  // water/rock index ratio (F0 ≈ 0.004, a tenth of in air), so its sun specular is nearly gone.
  // Left glossy (the wetness above), the normal maps' sub-pixel facets sparkled as single
  // white pixels across every patch of weed and rock seen through the lagoon.
  const submerged = float(1).sub(smoothstep(WATER_LEVEL_M - 0.4, WATER_LEVEL_M - 0.05, p.y));
  rough = mix(rough, float(0.95), submerged);
  nTex = mix(nTex, vec3(0.5, 0.5, 1), max(max(puddle, film), wet.mul(0.4)));
  // Rain rings on the puddles (the same rings as on the lagoon, waterFx.ts), near the camera only.
  const rings = rainRings(p.xz).mul(puddle).mul(smoothstep(25, 6, length(cameraPosition.sub(p))));
  nTex = nTex.add(vec3(rings.x, rings.y, 0).mul(0.5));

  // Wave-formed ripples on the shallow sand, after ClearWater6.1's sand_relief (SamG-Coder,
  // MIT): crests run across the swell (shoreField's propagation direction) about 20 cm apart,
  // wandering where a slow noise bends the phase, with a weaker oblique family that breaks them
  // into ladder ripples. Height h = A(cos φ + 0.18 cos(2φ + 0.6)), sharp crests over flat
  // troughs; the normal comes from its analytic slope, not a texture, so it never tiles. Only
  // where the swell's orbital motion reaches the bed (exposed, 0.1–4 m deep), and faded out
  // where a pixel spans a good part of a ripple, so it cannot shimmer in the distance.
  const depth = max(float(WATER_LEVEL_M).sub(p.y), 0);
  const ph = shorePhase(p.xz);
  const across = vec2(ph.dir.y.negate(), ph.dir.x);
  const oblique = ph.dir.mul(0.9).add(across.mul(0.44));
  const bend = texture(noise, p.xz.div(9)).g.mul(7);
  const RIPPLE_K = 31; // rad/m: 0.2 m wavelength
  const OBLIQUE_K = 26;
  const RIPPLE_AMP_M = 0.014;
  const phi1 = p.xz.dot(ph.dir).mul(RIPPLE_K).add(bend);
  const phi2 = p.xz.dot(oblique).mul(OBLIQUE_K).add(bend.mul(0.6)).add(1.7);
  /** dh/dφ of one ripple family, per metre of amplitude. */
  const ridgeSlope = (phi: Node<'float'>): Node<'float'> => sin(phi).add(sin(phi.mul(2).add(0.6)).mul(0.36)).negate();
  const footprintM = max(length(fwidth(p.xz)), 1e-4);
  const ripple = kS
    .mul(smoothstep(0.1, 0.4, depth))
    .mul(float(1).sub(smoothstep(3, 6, depth)))
    .mul(smoothstep(0.05, 0.5, ph.exposure))
    .mul(float(1).div(footprintM.mul(footprintM).mul(600).add(1)));
  const gradH = ph.dir.mul(ridgeSlope(phi1).mul(RIPPLE_K)).add(oblique.mul(ridgeSlope(phi2).mul(OBLIQUE_K * 0.35))).mul(RIPPLE_AMP_M);
  // Tangent space: x along +X, y along −Z, so the normal tilts by (−∂h/∂x, +∂h/∂z).
  nTex = nTex.add(vec3(gradH.x.negate(), gradH.y, 0).mul(ripple.mul(0.5)));
  // Darker shell grit and heavy minerals settle in the troughs.
  const crest = cos(phi1).add(cos(phi1.mul(2).add(0.6)).mul(0.18));
  albedo = albedo.mul(float(1).sub(float(1).sub(crest).mul(0.06).mul(ripple)));

  m.colorNode = albedo;
  m.roughnessNode = rough;
  m.metalnessNode = float(0);
  m.normalNode = normalMap(nTex);
  // AO: texture cavities × baked canopy shade, indirect light only.
  m.aoNode = orm.r.mul(extra.y).mul(float(1).sub(extra.z.mul(0.4)));

  // Caustics on the lagoon floor, splatted from the water's own ripples (caustics.ts): the
  // sun's direct light on the floor is scaled by the light concentration, fading with depth.
  const focus = causticAt(caustics, p, depth).sub(1);
  // The ripples tilt the facets the focused light falls on, so the caustics take their slope too.
  const floorN = normalWorld.sub(vec3(gradH.x, 0, gradH.y).mul(ripple)).normalize();
  const sunOnFloor = U.sunIrradiance.mul(max(floorN.dot(U.sunDir), 0)).mul(float(1).sub(U.cloudCover.mul(0.8)));
  const caustic = focus.mul(smoothstep(0.03, 0.3, depth)).mul(depth.mul(-0.22).exp()).mul(1.25);
  m.emissiveNode = albedo.mul(sunOnFloor).mul(caustic.div(Math.PI));
  return m;
}

/**
 * Inputs of the blade field (grassField.ts): the near ground mesh's own height grid (same split as
 * the mesh, so blades root exactly on it) and a 1 m density map — meadow grass where the ground
 * turns from sand to soil, stiff pale beach grass in clumps on the upper beach, darker under the
 * crowns; none on paths, in the shelter's clearing or in the water.
 */
export function grassInputs(world: LagoonWorld, clear: (x: number, z: number) => boolean) {
  const nx = Math.round((NEAR.x1 - NEAR.x0) / NEAR.cellM) + 1;
  const nz = Math.round((NEAR.z1 - NEAR.z0) / NEAR.cellM) + 1;
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = heightAt(NEAR.x0 + i * NEAR.cellM, NEAR.z0 + j * NEAR.cellM);
  const bin = binTrees([...world.palms.map((p) => ({ x: p.x, z: p.z, r: 2.2 })), ...world.trees.map((t) => ({ x: t.x, z: t.z, r: t.heightM * 0.28 }))]);
  const cellM = 1;
  const size = Math.ceil(Math.max(NEAR.x1 - NEAR.x0, NEAR.z1 - NEAR.z0) / cellM) + 1;
  const data = new Uint8Array(size * size * 4);
  const n = { x: 0, y: 1, z: 0 };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = NEAR.x0 + i * cellM;
      const z = NEAR.z0 + j * cellM;
      if (x > NEAR.x1 || z > NEAR.z1 || !clear(x, z)) continue;
      const y = heightAt(x, z);
      if (y < WATER_LEVEL_M + 0.5) continue;
      normalAt(x, z, n);
      const w = splatAt(x, z, y, n.y, true);
      const open = 1 - w.path * 2 - w.rock * 1.5;
      if (open <= 0) continue;
      const shade = 1 - (treeShade(bin, x, z) - 0.55) / 0.45;
      const d = shoreDistance(x, z);
      const bw = beachWidth(x, z);
      // beach grass: clumps on the dry upper beach, where the sand meets the soil
      const clump = smooth(0.55, 0.7, fbm2(x * 0.35, z * 0.35, 2, 91));
      const upper = smooth(bw * 0.45, bw * 0.8, d);
      // ...and lone tufts over the upper beach between them (dune grass): one cell in six or so at half
      // density, so the blades bunch into tufts a metre apart instead of standing alone like hairs.
      const cellHash = (((Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1) + 1) % 1;
      const scatter = cellHash > 0.84 ? 0.55 * smooth(bw * 0.3, bw * 0.65, d) : 0;
      const beach = w.sand * Math.max(upper * clump, scatter) * open;
      const meadow = w.grass * open * (1 - shade * 0.5);
      const o = (j * size + i) * 4;
      data[o] = Math.round(Math.min(1, meadow * 1.2) * 255);
      data[o + 1] = Math.round(Math.min(1, beach * 1.4) * 255);
      data[o + 3] = Math.round(Math.max(0, Math.min(1, shade)) * 255);
    }
  }
  return {
    ground: { heights, originX: NEAR.x0, originZ: NEAR.z0, cellM: NEAR.cellM, samplesX: nx, samplesZ: nz, split: 'bc' as const },
    density: { data, originX: NEAR.x0, originZ: NEAR.z0, cellM, size },
  };
}
