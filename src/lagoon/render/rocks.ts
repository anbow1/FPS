import { attribute, bumpMap, float, max, mix, normalWorld, positionWorld, smoothstep, texture, triplanarTexture, vec3 } from 'three/tsl';
import { type BufferGeometry, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { fbm2 } from '../../core/noise.ts';
import { WATER_LEVEL_M } from '../config.ts';
import type { RockInstance } from '../game/world.ts';
import { noiseMap, terrainSet } from './textures.ts';
import { U } from './uniforms.ts';

// Weathered coastal and jungle boulders: noise-displaced spheres, flattened
// where they sit in the sand, textured by triplanar projection (no stretching
// on any face) with bump detail from the texture's height. Moss grows on the
// upward faces of jungle rocks; the surf zone is always wet and dark.

const VARIANTS = 6;

function rockGeometry(seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, 5);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    // Blocky weathering: layered noise on two projections, plus a flat facet or two.
    const a = fbm2(v.x * 1.6 + seed, v.z * 1.6 + v.y * 0.7, 5, seed);
    const b = fbm2(v.y * 2.3 + seed * 0.3, v.x * 2.3 - v.z, 4, seed + 7);
    let r = 1 + a * 0.28 + b * 0.12;
    const facet = v.dot(new Vector3(Math.sin(seed), 0.4, Math.cos(seed)).normalize());
    if (facet > 0.55) r -= (facet - 0.55) * 0.9;
    const y = v.y * r;
    pos.setXYZ(i, v.x * r, y < -0.25 ? -0.25 + (y + 0.25) * 0.3 : y, v.z * r);
  }
  g.computeVertexNormals();
  return g;
}

export function buildRocks(rocks: readonly RockInstance[]): Group {
  const group = new Group();
  group.name = 'rocks';
  const material = rockMaterial();
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const s = new Vector3();
  const p = new Vector3();
  for (let v = 0; v < VARIANTS; v++) {
    const list = rocks.filter((r) => r.seed % VARIANTS === v);
    if (list.length === 0) continue;
    const geo = rockGeometry(v * 13 + 3);
    const moss = new Float32Array(list.length);
    const mesh = new InstancedMesh(geo, material, list.length);
    list.forEach((r, i) => {
      q.setFromAxisAngle(up, r.yawRad);
      m.compose(p.set(r.x, r.y, r.z), q, s.set(r.sx, r.sy, r.sz));
      mesh.setMatrixAt(i, m);
      moss[i] = r.moss;
    });
    geo.setAttribute('moss', new InstancedBufferAttribute(moss, 1));
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

export function rockMaterial(): MeshStandardNodeMaterial {
  const rock = terrainSet('rock');
  const moss = terrainSet('moss');
  const noise = noiseMap();
  const m = new MeshStandardNodeMaterial({ name: 'rock', metalness: 0 });
  const p = positionWorld;
  const n = normalWorld;
  const scale = float(1 / 2.2);
  const colour = triplanarTexture(texture(rock.map), null, null, scale, p, n).rgb;
  const height = triplanarTexture(texture(rock.ormMap), null, null, scale, p, n);
  const mossColour = triplanarTexture(texture(moss.map), null, null, float(1 / 0.9), p, n).rgb;
  const blotch = texture(noise, p.xz.div(3).add(p.y.mul(0.2))).r;
  const mossAmount = attribute('moss', 'float');
  const mossMask = smoothstep(0.45, 0.8, n.y.add(blotch.sub(0.5).mul(0.9))).mul(mossAmount).mul(smoothstep(0.4, 1.2, p.y));
  // Surf zone: always wet, dark and slick; algae below the waterline.
  const surf = float(1).sub(smoothstep(WATER_LEVEL_M + 0.1, WATER_LEVEL_M + 0.9, p.y));
  const wet = max(surf, U.wetness.mul(0.9));
  let albedo = mix(colour, mossColour, mossMask);
  albedo = albedo.mul(mix(float(1), float(0.55), wet));
  albedo = mix(albedo, albedo.mul(vec3(0.7, 0.85, 0.7)), smoothstep(0.1, -0.6, p.y));
  m.colorNode = albedo;
  m.roughnessNode = mix(mix(height.g, float(0.95), mossMask), float(0.25), wet.mul(float(1).sub(mossMask.mul(0.6))));
  m.normalNode = bumpMap(height.a.add(mossMask.mul(0.3)), float(0.9));
  m.aoNode = height.r;
  return m;
}
