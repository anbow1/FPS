import { attribute, bumpMap, cameraPosition, float, int, length, max, mix, mx_noise_float, normalMap, normalWorld, positionWorld, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, type DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshStandardNodeMaterial, NoColorSpace, type Node, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { fbm2, tileFbm } from '../core/noise.ts';
import type { Heightfield } from '../game/collision.ts';
import type { MapData } from '../maps/types.ts';
import { RIM_M } from '../maps/forest.ts';
import { distanceToSegmentXZ, sampleHeight } from '../maps/terrain.ts';
import type { MaterialLibrary } from './materials.ts';
import { type Lake, lakeRadius } from '../maps/lake.ts';
import { type Caustics, causticAt } from './caustics.ts';
import type { ShoreField } from './shoreField.ts';
import { swash } from './shoreWaves.ts';
import { W } from './waterUniforms.ts';
import * as P from './patterns.ts';
import { makeTextureArray, makeTextureSet } from './textures.ts';
import { PHOTO_SIZE_M, photoSampler } from './photoTextures.ts';

// Terrain mesh and its splat material. Layers blend by per-vertex weights
// (grass, soil, rock, track), sharpened by each layer's own height so soil
// fills the gaps between stones instead of a soft linear fade (rules §3.4).
// Rock is triplanar so steep faces never stretch. A macro-variation texture
// breaks the tiling grid, and a detail layer fades in within ~10 m so the ground
// stays sharp at prone eye height (0.45 m).

const LAYER_TILE_M = { grass: 3, soil: 2.5, rock: 4, track: PHOTO_SIZE_M.forest_ground_04 } as const;
const DETAIL_TILE_M = 0.35;
const DETAIL_FADE_M = 10;
const MACRO_TILE_M = 220;

/** The lake's render pieces the terrain shader needs: its baked wave field and the caustics pass. */
export interface LakeFx {
  lake: Lake;
  field: ShoreField;
  caustics: Caustics;
}

export function buildTerrainMesh(map: MapData, lib: MaterialLibrary, lakeFx: LakeFx | null = null): Mesh {
  const geometry = heightfieldGeometry(
    map.terrain,
    map.id === 'city' ? null : (x, z) => splatWeights(map, x, z),
    (x, z) => 1 - Math.min(0.45, canopyAt(map, x, z) * 0.22),
  );
  const material = map.id === 'city' ? lib.get('asphalt') : splatMaterial(lakeFx);
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** Beyond the playable area: low-resolution hills out to the fog, so the horizon is land, not void. */
export function buildFarRing(map: MapData): Mesh {
  const inner = map.terrain.originX * -1;
  const outer = 2400;
  const rings = 24;
  const segments = 96;
  const positions: number[] = [];
  const splats: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const edgeHeight = (x: number, z: number): number => sampleHeight(map.terrain, Math.max(-inner, Math.min(inner, x)), Math.max(-inner, Math.min(inner, z)));
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const radius = inner * 1.0 + (outer - inner) * t * t;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      // Square at the inner edge (matches the heightfield), round further out.
      const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const k = Math.min(1, t * 4);
      const rr = radius * (sq * (1 - k) + k);
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const hills = map.id === 'city' ? 0 : fbm2(x / 500, z / 500, 4, 77) * 60 + 30 * t;
      const h = edgeHeight(x, z) * (1 - k) + hills * k;
      positions.push(x, h - (r === 0 ? 0.05 : 0), z);
      uvs.push(x, z);
      splats.push(0.6, 0.4, 0, 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * segments + s;
      const b = r * segments + ((s + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('splat', new BufferAttribute(new Float32Array(splats), 4));
  g.setAttribute('shade', new BufferAttribute(new Float32Array(splats.length / 4).fill(1), 1));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  const material = map.id === 'city' ? new MeshStandardNodeMaterial({ color: 0x3a3a3c, roughness: 0.92 }) : map.id === 'forest' ? farForestMaterial(inner) : splatMaterial(null);
  const mesh = new Mesh(g, material);
  mesh.receiveShadow = false;
  mesh.name = 'farRing';
  return mesh;
}

/**
 * The hills beyond the forest map, under forest themselves: dark conifer canopy with its clumps of crowns
 * (two scales of noise in colour, and in a bumped normal so the sun picks out the crowns' lit sides) and
 * the odd clearing, blending in from the map's edge. On the meadow material they read as bare grey domes.
 */
function farForestMaterial(innerM: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'far forest', roughness: 1, metalness: 0 });
  const p = positionWorld.xz;
  const crowns = mx_noise_float(p.div(9)).mul(0.5).add(0.5);
  const stands = mx_noise_float(p.div(70).add(13.1)).mul(0.5).add(0.5);
  const clearing = smoothstep(0.78, 0.86, mx_noise_float(p.div(160).add(41.7)).mul(0.5).add(0.5));
  const canopy = mix(vec3(0.018, 0.034, 0.014), vec3(0.04, 0.062, 0.026), crowns.mul(0.6).add(stands.mul(0.4)));
  const meadow = vec3(0.07, 0.09, 0.035);
  const edge = max(positionWorld.x.abs(), positionWorld.z.abs()).sub(innerM);
  const forestK = smoothstep(0, 60, edge).mul(float(1).sub(clearing));
  m.colorNode = mix(meadow, canopy, forestK);
  m.normalNode = bumpMap(crowns.mul(forestK), float(2.2));
  return m;
}

function heightfieldGeometry(t: Heightfield, splatAt: ((x: number, z: number) => [number, number, number, number]) | null, shadeAt: ((x: number, z: number) => number) | null = null): BufferGeometry {
  const nx = t.samplesX;
  const nz = t.samplesZ;
  const positions = new Float32Array(nx * nz * 3);
  // UV = world XZ: the normal-map tangent frame follows the same axes the layers are sampled on.
  const uvs = new Float32Array(nx * nz * 2);
  const splat = splatAt ? new Float32Array(nx * nz * 4) : null;
  const shade = splat ? new Float32Array(nx * nz).fill(1) : null;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const x = t.originX + ix * t.cellM;
      const z = t.originZ + iz * t.cellM;
      positions[i * 3] = x;
      positions[i * 3 + 1] = t.heightsM[i] as number;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x;
      uvs[i * 2 + 1] = z;
      if (splat && splatAt) splat.set(splatAt(x, z), i * 4);
      if (shade && shadeAt) shade[i] = shadeAt(x, z);
    }
  }
  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  if (splat) g.setAttribute('splat', new BufferAttribute(splat, 4));
  if (shade) g.setAttribute('shade', new BufferAttribute(shade, 1));
  g.setIndex(new BufferAttribute(indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Layer weights (grass, soil, rock, track) from slope, the track and a patch field. */
export function splatWeights(map: MapData, x: number, z: number): [number, number, number, number] {
  const t = map.terrain;
  const e = t.cellM;
  const slope = Math.hypot(sampleHeight(t, x + e, z) - sampleHeight(t, x - e, z), sampleHeight(t, x, z + e) - sampleHeight(t, x, z - e)) / (2 * e);
  // The forest map's rim hills are wooded slopes, however steep: rock there read as grey domes.
  const rim = map.id === 'forest' ? smooth(-10, 10, Math.max(Math.abs(x), Math.abs(z)) - (map.halfSizeM - RIM_M)) : 0;
  const rock = smooth(0.45, 0.85, slope) * (1 - rim * 0.9);
  let track = 0;
  for (let i = 0; i < map.track.length - 1; i++) {
    const a = map.track[i];
    const b = map.track[i + 1];
    if (!a || !b) continue;
    track = Math.max(track, 1 - smooth(1.8, 3.6, distanceToSegmentXZ(x, z, a.x, a.z, b.x, b.z)));
  }
  if (map.id === 'range' && Math.abs(x) < 1.6 && z < 0) track = Math.max(track, 0.8); // worn walking line downrange
  const patch = fbm2(x / 35, z / 35, 3, 9) * 0.5 + 0.5;
  // Under the pines the ground is needle litter, not lawn: canopy pushes grass out.
  const canopy = Math.min(1, canopyAt(map, x, z) * 0.9);
  const forestFloor = Math.max(canopy, map.id === 'forest' ? smooth(0.45, 0.7, patch) : smooth(0.62, 0.8, patch) * 0.6);
  let soil = forestFloor * (1 - rock);
  let grass = (1 - forestFloor) * (1 - rock);
  soil *= 1 - track;
  grass *= 1 - track;
  let r = rock * (1 - track);
  // The lake: a pebbly shore just above the water, darker compacted mud and gravel below it.
  if (map.lake) {
    const lr = lakeRadius(map.lake, x, z);
    if (lr < 1.16) {
      const shore = smooth(1.16, 1.06, lr);
      const bed = smooth(1.0, 0.94, lr);
      grass *= 1 - shore;
      r *= 1 - shore;
      soil = soil * (1 - shore) + shore * (1 - bed * 0.55);
      track = track * (1 - shore) + shore * bed * 0.55;
    }
  }
  const sum = grass + soil + r + track || 1;
  return [grass / sum, soil / sum, r / sum, track / sum];
}

type TreeBin = Map<number, { x: number; z: number; r2: number }[]>;
const treeBins = new WeakMap<MapData, TreeBin>();

/**
 * Crown cover over a ground point: a sum of Gaussians, one per tree, as wide
 * as its crown. ~1 under a single pine, 2–3 in a dense stand. Drives the
 * needle litter in the splat and the baked occlusion under the canopy (as in
 * the lagoon's jungle floor).
 */
function canopyAt(map: MapData, x: number, z: number): number {
  let bin = treeBins.get(map);
  if (!bin) {
    bin = new Map();
    for (const t of map.trees) {
      const key = Math.floor(t.pos.x / 10) * 65536 + Math.floor(t.pos.z / 10);
      const list = bin.get(key) ?? [];
      const r = t.heightM * 0.17;
      list.push({ x: t.pos.x, z: t.pos.z, r2: r * r });
      bin.set(key, list);
    }
    treeBins.set(map, bin);
  }
  let occ = 0;
  const cx = Math.floor(x / 10);
  const cz = Math.floor(z / 10);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = bin.get((cx + dx) * 65536 + cz + dz);
      if (!list) continue;
      for (const t of list) occ += Math.exp(-((x - t.x) ** 2 + (z - t.z) ** 2) / t.r2);
    }
  }
  return occ;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

let macroTexture: DataTexture | null = null;

function macroVariation(): DataTexture {
  if (macroTexture) return macroTexture;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = tileFbm((x / size) * 8, (y / size) * 8, 8, 4, 404);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(v * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  macroTexture = tex;
  return tex;
}

const splatMats = new Map<LakeFx | null, MeshStandardNodeMaterial>();

function splatMaterial(lakeFx: LakeFx | null): MeshStandardNodeMaterial {
  const cached = splatMats.get(lakeFx);
  if (cached) return cached;
  // One array texture per map kind, one layer per ground type: 3 bindings instead of 12, so
  // the shader stays inside the 16-texture limit of WebGPU and phone GPUs (shadow maps and the
  // environment probe count too). At 19 textures the terrain failed to draw on WebGPU.
  const layers = makeTextureArray([
    makeTextureSet(512, P.grass(), 1.2),
    makeTextureSet(512, P.needleLitter(), 2), // the forest floor: a mat of fallen needles, moss, twigs, cones
    makeTextureSet(512, P.rock(), 4),
    makeTextureSet(512, photoSampler('forest_ground_04'), 3), // the track: a photographed path of packed dirt, grit and stones
  ]);
  const GRASS = 0;
  const SOIL = 1;
  const ROCK = 2;
  const TRACK = 3;
  const at = (tex: DataArrayTexture, uv: Node<'vec2'>, layer: number): Node<'vec4'> => texture(tex, uv).depth(int(layer));
  const macro = macroVariation();

  const w = attribute('splat', 'vec4');
  const xz = positionWorld.xz;
  const uvG = xz.div(LAYER_TILE_M.grass);
  const uvS = xz.div(LAYER_TILE_M.soil);
  const uvT = xz.div(LAYER_TILE_M.track);
  // Rock is projected three ways so steep faces never stretch.
  const tri = normalWorld.abs().pow(vec3(4));
  const triW = tri.div(tri.x.add(tri.y).add(tri.z));
  const pr = positionWorld.div(LAYER_TILE_M.rock);
  const rockTri = (tex: DataArrayTexture): Node<'vec4'> => at(tex, pr.zy, ROCK).mul(triW.x).add(at(tex, pr.xz, ROCK).mul(triW.y)).add(at(tex, pr.xy, ROCK).mul(triW.z));
  const ormG = at(layers.ormMap, uvG, GRASS);
  const ormS = at(layers.ormMap, uvS, SOIL);
  const ormT = at(layers.ormMap, uvT, TRACK);
  // Height-blend: each weight is lifted by that layer's height (its AO channel), then sharpened.
  const hG = ormG.r;
  const hS = ormS.r;
  const hR = rockTri(layers.ormMap).r;
  const hT = ormT.r;
  const lifted = vec4(w.x.mul(hG.add(0.3)), w.y.mul(hS.add(0.3)), w.z.mul(hR.add(0.3)), w.w.mul(hT.add(0.3)));
  const peak = lifted.x.max(lifted.y).max(lifted.z).max(lifted.w);
  const sharp = lifted.sub(peak.sub(0.18)).max(0);
  const k = sharp.div(sharp.x.add(sharp.y).add(sharp.z).add(sharp.w).max(1e-4));

  const cG = at(layers.map, uvG, GRASS).rgb;
  const cS = at(layers.map, uvS, SOIL).rgb;
  const cR = rockTri(layers.map).rgb;
  const cT = at(layers.map, uvT, TRACK).rgb;
  let colour = cG.mul(k.x).add(cS.mul(k.y)).add(cR.mul(k.z)).add(cT.mul(k.w));

  // Detail layer within ~10 m: a high-frequency copy of the dominant texture.
  const dist = length(positionWorld.sub(cameraPosition));
  const near = float(1).sub(smoothstep(DETAIL_FADE_M * 0.5, DETAIL_FADE_M, dist));
  const uvD = xz.div(DETAIL_TILE_M);
  const detail = at(layers.map, uvD, SOIL).rgb.mul(k.y.add(k.w)).add(at(layers.map, uvD, GRASS).rgb.mul(k.x)).add(at(layers.map, uvD, ROCK).rgb.mul(k.z));
  const detailLum = detail.dot(vec3(0.2126, 0.7152, 0.0722));
  const baseLum = colour.dot(vec3(0.2126, 0.7152, 0.0722)).max(1e-3);
  colour = colour.mul(mix(float(1), detailLum.div(baseLum).clamp(0.6, 1.4), near.mul(0.6)));

  // Macro variation: ±12 % brightness at the 200 m scale kills the tiling grid.
  const macro1 = texture(macro, xz.div(MACRO_TILE_M)).r;
  const macro2 = texture(macro, xz.div(MACRO_TILE_M * 0.37).add(vec2(0.31, 0.77))).r;
  colour = colour.mul(macro1.add(macro2).mul(0.24).add(0.76));

  const nG = at(layers.normalMap, uvG, GRASS).xyz;
  const nS = at(layers.normalMap, uvS, SOIL).xyz;
  const nR = at(layers.normalMap, uvG.mul(LAYER_TILE_M.grass / LAYER_TILE_M.rock), ROCK).xyz;
  const nT = at(layers.normalMap, uvT, TRACK).xyz;
  const nBlend = nG.mul(k.x).add(nS.mul(k.y)).add(nR.mul(k.z)).add(nT.mul(k.w));
  const nDetail = at(layers.normalMap, uvD, SOIL).xyz;
  const n = mix(nBlend, nBlend.add(nDetail).sub(0.5), near.mul(0.5));

  let roughness: Node<'float'> = ormG.g.mul(k.x).add(ormS.g.mul(k.y)).add(float(0.85).mul(k.z)).add(ormT.g.mul(k.w));
  let nFinal: Node<'vec3'> = n;

  const m = new MeshStandardNodeMaterial({ name: lakeFx ? 'terrainSplatLake' : 'terrainSplat', metalness: 0 });
  if (lakeFx) {
    // The lake's edge (shoreWaves.ts): the swash of each wavelet runs up the bank and drains,
    // the ground stays wet as far as the recent ones reached and dries over ~20 s — darker, a
    // little more saturated, smoother. Below the water: a green-brown tint and caustics.
    // Only around this lake: elsewhere on the map ground at the same height stays dry.
    const L = lakeFx.lake;
    const lakeR = xz.sub(vec2(L.cx, L.cz)).div(vec2(L.rx, L.rz)).length();
    const y = lakeR.lessThan(1.35).select(positionWorld.y.sub(L.levelM), float(50));
    const sw = swash(lakeFx.field, xz, y);
    const lum = colour.dot(vec3(0.2126, 0.7152, 0.0722));
    colour = mix(vec3(lum), colour, float(1).add(sw.wet.mul(0.35)));
    colour = colour.mul(float(1).sub(sw.wet.mul(0.42)));
    const film = smoothstep(0.0, 0.01, sw.sheet);
    colour = mix(colour, colour.mul(vec3(0.72, 0.8, 0.76)), film.mul(0.6));
    const under = float(1).sub(smoothstep(-0.4, 0.0, y));
    colour = colour.mul(mix(vec3(1), vec3(0.72, 0.8, 0.68), under));
    colour = mix(colour, vec3(0.78, 0.8, 0.78), sw.foam);
    roughness = mix(mix(roughness, float(0.28), sw.wet.mul(0.9)), float(0.14), film);
    roughness = mix(roughness, float(0.8), sw.foam);
    nFinal = mix(n, vec3(0.5, 0.5, 1), max(film, sw.wet.mul(0.35)));
    // Caustics: the sun's direct light on the bed scaled by the light concentration.
    const depth = max(y.negate(), 0);
    const focus = causticAt(lakeFx.caustics, positionWorld, depth).sub(1);
    const sunOnBed = W.sunIrradiance.mul(max(normalWorld.dot(W.sunDir), 0));
    m.emissiveNode = colour.mul(sunOnBed).mul(focus.mul(smoothstep(0.03, 0.2, depth)).mul(depth.mul(-0.5).exp()).mul(1.2 / Math.PI));
  }
  m.colorNode = colour;
  m.normalNode = normalMap(nFinal);
  m.roughnessNode = roughness;
  // Texture occlusion × the canopy occlusion baked per vertex (indirect light only; the sun has real shadows).
  m.aoNode = mix(float(1), hG.mul(k.x).add(hS.mul(k.y)).add(hR.mul(k.z)).add(hT.mul(k.w)), 0.5).mul(attribute('shade', 'float'));
  splatMats.set(lakeFx, m);
  return m;
}
