import { attribute, cameraPosition, float, int, length, mix, normalMap, normalWorld, positionWorld, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, type DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshStandardNodeMaterial, NoColorSpace, type Node, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { fbm2, tileFbm } from '../core/noise.ts';
import type { Heightfield } from '../game/collision.ts';
import type { MapData } from '../maps/types.ts';
import { distanceToSegmentXZ, sampleHeight } from '../maps/terrain.ts';
import type { MaterialLibrary } from './materials.ts';
import * as P from './patterns.ts';
import { makeTextureArray, makeTextureSet } from './textures.ts';

// Terrain mesh and its splat material. Layers blend by per-vertex weights
// (grass, soil, rock, track), sharpened by each layer's own height so soil
// fills the gaps between stones instead of a soft linear fade (rules §3.4).
// Rock is triplanar so steep faces never stretch. A macro-variation texture
// breaks the tiling grid, and a detail layer fades in within ~10 m so the ground
// stays sharp at prone eye height (0.45 m).

const LAYER_TILE_M = { grass: 3, soil: 2.5, rock: 4, track: 2 } as const;
const DETAIL_TILE_M = 0.35;
const DETAIL_FADE_M = 10;
const MACRO_TILE_M = 220;

export function buildTerrainMesh(map: MapData, lib: MaterialLibrary): Mesh {
  const geometry = heightfieldGeometry(map.terrain, map.id === 'city' ? null : (x, z) => splatWeights(map, x, z));
  const material = map.id === 'city' ? lib.get('asphalt') : splatMaterial();
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
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  const mesh = new Mesh(g, map.id === 'city' ? new MeshStandardNodeMaterial({ color: 0x3a3a3c, roughness: 0.92 }) : splatMaterial());
  mesh.receiveShadow = false;
  mesh.name = 'farRing';
  return mesh;
}

function heightfieldGeometry(t: Heightfield, splatAt: ((x: number, z: number) => [number, number, number, number]) | null): BufferGeometry {
  const nx = t.samplesX;
  const nz = t.samplesZ;
  const positions = new Float32Array(nx * nz * 3);
  // UV = world XZ: the normal-map tangent frame follows the same axes the layers are sampled on.
  const uvs = new Float32Array(nx * nz * 2);
  const splat = splatAt ? new Float32Array(nx * nz * 4) : null;
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
  g.setIndex(new BufferAttribute(indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Layer weights (grass, soil, rock, track) from slope, the track and a patch field. */
function splatWeights(map: MapData, x: number, z: number): [number, number, number, number] {
  const t = map.terrain;
  const e = t.cellM;
  const slope = Math.hypot(sampleHeight(t, x + e, z) - sampleHeight(t, x - e, z), sampleHeight(t, x, z + e) - sampleHeight(t, x, z - e)) / (2 * e);
  const rock = smooth(0.45, 0.85, slope);
  let track = 0;
  for (let i = 0; i < map.track.length - 1; i++) {
    const a = map.track[i];
    const b = map.track[i + 1];
    if (!a || !b) continue;
    track = Math.max(track, 1 - smooth(1.8, 3.6, distanceToSegmentXZ(x, z, a.x, a.z, b.x, b.z)));
  }
  if (map.id === 'range' && Math.abs(x) < 1.6 && z < 0) track = Math.max(track, 0.8); // worn walking line downrange
  const patch = fbm2(x / 35, z / 35, 3, 9) * 0.5 + 0.5;
  const forestFloor = map.id === 'forest' ? smooth(0.45, 0.7, patch) : smooth(0.62, 0.8, patch) * 0.6;
  let soil = forestFloor * (1 - rock);
  let grass = (1 - forestFloor) * (1 - rock);
  soil *= 1 - track;
  grass *= 1 - track;
  const r = rock * (1 - track);
  const sum = grass + soil + r + track || 1;
  return [grass / sum, soil / sum, r / sum, track / sum];
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

let splatMat: MeshStandardNodeMaterial | null = null;

function splatMaterial(): MeshStandardNodeMaterial {
  if (splatMat) return splatMat;
  // One array texture per map kind, one layer per ground type: 3 bindings instead of 12, so
  // the shader stays inside the 16-texture limit of WebGPU and phone GPUs (shadow maps and the
  // environment probe count too). At 19 textures the terrain failed to draw on WebGPU.
  const layers = makeTextureArray([
    makeTextureSet(512, P.grass(), 2),
    makeTextureSet(512, P.soil(), 3),
    makeTextureSet(512, P.rock(), 4),
    makeTextureSet(512, P.soil(0x5a4a3a), 3), // compacted, darker dirt on the track
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

  const roughness = ormG.g.mul(k.x).add(ormS.g.mul(k.y)).add(float(0.85).mul(k.z)).add(ormT.g.mul(k.w));

  const m = new MeshStandardNodeMaterial({ name: 'terrainSplat', metalness: 0 });
  m.colorNode = colour;
  m.normalNode = normalMap(n);
  m.roughnessNode = roughness;
  m.aoNode = mix(float(1), hG.mul(k.x).add(hS.mul(k.y)).add(hR.mul(k.z)).add(hT.mul(k.w)), 0.5);
  splatMat = m;
  return m;
}
