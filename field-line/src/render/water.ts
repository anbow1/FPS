import { attribute, cameraPosition, clamp, dot, exp, float, length, max, mix, normalize, positionLocal, positionWorld, pow, reflect, screenUV, smoothstep, sqrt, transformNormalToView, varying, vec2, vec3, viewportSharedTexture } from 'three/tsl';
import { BufferAttribute, BufferGeometry, Mesh, MeshPhysicalNodeMaterial } from 'three/webgpu';
import { LAKE_WAVES } from '../config.ts';
import { lakeRadius, type Lake } from '../maps/lake.ts';
import { CAUSTIC_TILE_M, rippleSlope } from './caustics.ts';
import { hexToLinear } from './colour.ts';
import type { ShoreField } from './shoreField.ts';
import { laceCover, shoreSurface, surfFoam } from './shoreWaves.ts';
import { W } from './waterUniforms.ts';

// The forest lake's water, ported from Castaway Lagoon's water shader and
// fitted to Field Line's lighting: a physical material (ior 1.333, so F0 ≈
// 0.02) takes the reflection of the environment probe, the sun's highlight
// and its shadows from the scene's own lights, and the fog. What lies under
// the surface is added as emissive, weighted by 1 − Fresnel:
//   refraction  the lake bed already rendered behind the water, distorted by
//               the surface normal, attenuated by Beer–Lambert absorption
//               along the path down and back up (a little tea-coloured);
//   scattering  green-brown in-scattered light, lit by sun and sky.
// Waves come from the baked shore field (shoreWaves.ts); foam is diffuse and
// lit like any other white surface.

/** How far past the waterline (in lake radii) the water mesh reaches: the banks rise above it there. */
const MESH_R = 1.32;

export function buildLakeWater(lake: Lake, field: ShoreField, ground: (x: number, z: number) => number, quality: 'high' | 'low'): Mesh {
  const mesh = new Mesh(lakeGrid(lake, ground, quality === 'high' ? 0.5 : 1.0), lakeMaterial(field));
  mesh.name = 'lake';
  mesh.renderOrder = 10;
  mesh.receiveShadow = true;
  return mesh;
}

/** A grid over the lake's ellipse, in world coordinates at the still level, with the depth per vertex. */
function lakeGrid(lake: Lake, ground: (x: number, z: number) => number, cellM: number): BufferGeometry {
  const x0 = lake.cx - lake.rx * MESH_R;
  const z0 = lake.cz - lake.rz * MESH_R;
  const nx = Math.ceil((lake.rx * MESH_R * 2) / cellM) + 1;
  const nz = Math.ceil((lake.rz * MESH_R * 2) / cellM) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const depth = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * cellM;
      const z = z0 + j * cellM;
      pos[k * 3] = x;
      pos[k * 3 + 1] = lake.levelM;
      pos[k * 3 + 2] = z;
      depth[k] = lake.levelM - ground(x, z);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Keep a cell if any corner is in the water or within the mesh's radius.
      const corners = [a, b, c, d];
      const anyWet = corners.some((q) => (depth[q] as number) > -0.3);
      const inside = lakeRadius(lake, x0 + (i + 0.5) * cellM, z0 + (j + 0.5) * cellM) < MESH_R;
      if (!anyWet || !inside) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('depth', new BufferAttribute(depth, 1));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nx * nz * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function lakeMaterial(field: ShoreField): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'lake', transparent: true, depthWrite: true, metalness: 0, ior: 1.333 });

  // ── Vertex: depth-aware waves from the shore field.
  const depthV = max(attribute('depth', 'float'), 0);
  const shore = shoreSurface(field, positionLocal.xz, depthV);
  m.positionNode = positionLocal.add(shore.disp);
  const vSlope = varying(shore.slope, 'vLakeSlope');
  const vDepth = varying(attribute('depth', 'float'), 'vLakeDepth');
  const vS = varying(shore.s, 'vLakeS');
  const vBreak = varying(shore.breaking, 'vLakeBreak');
  const vDir = varying(shore.dir, 'vLakeDir');

  // ── Fragment.
  const p = positionWorld;
  const depth = max(vDepth, 0);
  const toEye = cameraPosition.sub(p);
  const dist = length(toEye);
  const V = toEye.div(dist);
  // Detail ripples at half the strength the caustics splat them with: at full strength the
  // surface glittered white all over.
  const detail = rippleSlope(p.xz.div(CAUSTIC_TILE_M), false).mul(0.45).div(dist.mul(0.015).add(1));
  const N = normalize(vec3(vSlope.x.negate().add(detail.x), 1, vSlope.y.negate().sub(detail.y)));
  m.normalNode = transformNormalToView(N);

  const NdotV = clamp(dot(N, V), 0.001, 1);
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), float(5))));
  // Refraction: the bed seen through the surface, distorted less where it is shallow.
  const distortion = N.xz.mul(0.04).mul(smoothstep(0.0, 0.8, depth)).div(dist.mul(0.02).add(1));
  const behind = viewportSharedTexture(screenUV.add(vec2(distortion.x, distortion.y.negate()))).rgb;
  const cosIn = sqrt(float(1).sub(float(1).sub(V.y.mul(V.y)).div(1.77)));
  const path = depth.div(max(cosIn, 0.15)).add(depth);
  const a = LAKE_WAVES.absorptionPerM;
  const T = exp(vec3(a.r, a.g, a.b).mul(path).negate());
  const sc = hexToLinear(LAKE_WAVES.scatterColour);
  const deep = hexToLinear(LAKE_WAVES.deepColour);
  const ambient = W.sunIrradiance.mul(max(W.sunDir.y, 0)).add(W.skyIrradiance).div(Math.PI);
  const scatter = mix(vec3(sc.r, sc.g, sc.b), vec3(deep.r, deep.g, deep.b), smoothstep(0.3, 1.3, depth)).mul(ambient).mul(0.5).mul(float(1).sub(T.g));
  const transmitted = behind.mul(T).add(scatter);

  // Foam: breaking wavelets at the very edge, and a thin lacy line where water meets the bank.
  const surf = surfFoam(p.xz, vS, vBreak, vDir);
  const edgeLace = laceCover(p.xz, float(1).sub(smoothstep(0.005, 0.04, depth)).mul(0.25), float(0));
  const foam = max(surf, edgeLace);

  // The far shore: the environment probe holds only sky and ground, so a reflected ray leaving
  // the water at a low angle would show bright sky where a real lake mirrors the tree line.
  // Below ~9° of elevation (pines ~20 m tall across ~120 m of water) take the forest's colour.
  const R = reflect(V.negate(), N);
  const treeline = smoothstep(0.16, 0.05, R.y);
  const forest = vec3(0.028, 0.045, 0.03).mul(W.skyIrradiance.add(W.sunIrradiance.mul(0.25)).div(Math.PI));

  m.colorNode = vec3(0.78, 0.8, 0.78).mul(foam);
  m.roughnessNode = mix(float(0.04), float(0.85), foam);
  m.specularIntensityNode = float(1).sub(foam).mul(float(1).sub(treeline));
  m.emissiveNode = transmitted.mul(float(1).sub(fresnel)).add(forest.mul(fresnel).mul(treeline)).mul(float(1).sub(foam));
  // The thin edge fades into the wet bank behind it.
  m.opacityNode = smoothstep(0.0, 0.035, vDepth);
  return m;
}
