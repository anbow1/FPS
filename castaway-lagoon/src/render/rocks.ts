import { attribute, float, max, mix, normalMap, normalWorld, positionWorld, smoothstep, texture, triplanarTexture, uv, vec2, vec3 } from 'three/tsl';
import { Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial, type Node, Quaternion, Vector3 } from 'three/webgpu';
import { WATER_LEVEL_M } from '../config.ts';
import type { RockInstance } from '../game/world.ts';
import { noiseMap, terrainSet } from './textures.ts';
import { type ScanId, type ScanModel, scanModel } from './scanModels.ts';
import { U } from './uniforms.ts';
import { markStaticInstances } from './instancing.ts';

// Coastal and jungle boulders from photoscans (scanModels.ts): three boulders
// for anything over ~1.6 m across, three stones under it. Each keeps its own
// scanned colour, normal and ORM; moss grows over the upward faces of jungle
// rocks, the surf zone is always wet and dark, algae tint what stays under water.

const BOULDERS: readonly ScanId[] = ['boulder_01', 'namaqualand_boulder_04', 'namaqualand_boulder_02'];
const STONES: readonly ScanId[] = ['rock_07', 'rock_09', 'namaqualand_boulder_05'];

export function buildRocks(rocks: readonly RockInstance[]): Group {
  const group = new Group();
  group.name = 'rocks';
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const s = new Vector3();
  const p = new Vector3();
  const pick = (r: RockInstance): ScanId => {
    const list = Math.max(r.sx, r.sz) > 1.6 ? BOULDERS : STONES;
    return list[r.seed % list.length] as ScanId;
  };
  for (const id of [...BOULDERS, ...STONES]) {
    const list = rocks.filter((r) => pick(r) === id);
    if (list.length === 0) continue;
    const scan = scanModel(id);
    const geo = scan.geometry.clone();
    const moss = new Float32Array(list.length);
    const mesh = markStaticInstances(new InstancedMesh(geo, scanRockMaterial(scan, id), list.length));
    list.forEach((r, i) => {
      // Across, the rock spans its placement's radii; its height is the scan's own, nudged by how flat
      // the placement asked for, so a standing block stays a standing block and no boulder is squashed.
      const across = (r.sx + r.sz) / 2;
      const sy = across * Math.min(1.1, Math.max(0.7, (r.sy / across) * 1.4));
      // Set down on the ground and buried by a quarter of its height, as boulders settle into sand and soil.
      q.setFromAxisAngle(up, r.yawRad);
      m.compose(p.set(r.x, r.groundY - scan.heightRatio * sy * 0.25, r.z), q, s.set(r.sx, sy, r.sz));
      mesh.setMatrixAt(i, m);
      moss[i] = r.moss;
    });
    geo.setAttribute('moss', new InstancedBufferAttribute(moss, 1));
    mesh.computeBoundingSphere();
    mesh.name = `rock-${id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** A scanned rock's own surface, with the island's moss, surf and algae over it. */
function scanRockMaterial(scan: ScanModel, id: ScanId): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: `rock-${id}`, metalness: 0 });
  const orm = texture(scan.ormMap);
  const w = weathering(texture(scan.map).rgb, orm.g);
  m.colorNode = w.albedo;
  m.roughnessNode = w.roughness;
  // Moss and the film of water soften the scan's relief.
  const relief = float(1).sub(w.mossMask.mul(0.6)).sub(w.wet.mul(0.3));
  m.normalNode = normalMap(texture(scan.normalMap, uv()), vec2(relief, relief)) as unknown as Node<'vec3'>;
  m.aoNode = orm.r;
  return m;
}

/** Moss on top of jungle rocks, the wet surf zone and algae under water, over any rock's own colour. */
function weathering(colour: Node<'vec3'>, roughness: Node<'float'>): { albedo: Node<'vec3'>; roughness: Node<'float'>; mossMask: Node<'float'>; wet: Node<'float'> } {
  const moss = terrainSet('moss');
  const noise = noiseMap();
  const p = positionWorld;
  const n = normalWorld;
  const mossColour = triplanarTexture(texture(moss.map), null, null, float(1 / 0.9), p, n).rgb;
  const blotch = texture(noise, p.xz.div(3).add(p.y.mul(0.2))).r;
  const mossAmount = attribute('moss', 'float');
  const mossMask = smoothstep(0.45, 0.8, n.y.add(blotch.sub(0.5).mul(0.9))).mul(mossAmount).mul(smoothstep(0.4, 1.2, p.y));
  // Surf zone: always wet, dark and slick; algae below the waterline.
  const surf = float(1).sub(smoothstep(WATER_LEVEL_M + 0.1, WATER_LEVEL_M + 0.9, p.y));
  const wet = max(surf, U.wetness.mul(0.9));
  let albedo = mix(colour, mossColour, mossMask);
  albedo = albedo.mul(mix(float(1), float(0.55), wet));
  albedo = mix(albedo, albedo.mul(vec3(0.7, 0.85, 0.7)), float(1).sub(smoothstep(-0.6, 0.1, p.y)));
  const rough = mix(mix(roughness, float(0.95), mossMask), float(0.25), wet.mul(float(1).sub(mossMask.mul(0.6))));
  return { albedo, roughness: rough, mossMask, wet };
}
