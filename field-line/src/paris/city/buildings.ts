import { Group, InstancedMesh, Matrix4, Mesh, type Vector3 } from 'three/webgpu';
import { awningMaterial, ironMaterial, potMaterial, stoneMaterial, zincMaterial } from '../render/architecture.ts';
import { shopMaterial, windowMaterial } from '../render/windows.ts';
import { FacadeWriter, type FacadeBuilders } from './facade.ts';
import { MeshBuilder } from './meshBuilder.ts';
import type { StreetPlan } from './plan.ts';
import { potGeometry, writeRoof } from './roof.ts';

// Every building of the street, built once at load: one mesh per material in
// each 70 m chunk of the street (and per cross-street front), plus the chimney
// pots instanced, so the camera and each shadow cascade draw only the chunks
// they see.

/** Length of a chunk along the boulevard: each is culled on its own, by the camera and by every shadow cascade. */
const CHUNK_M = 70;

export function buildBuildings(plan: StreetPlan): Group {
  const group = new Group();
  group.name = 'buildings';
  const mats = { stone: stoneMaterial(), zinc: zincMaterial(), glass: windowMaterial(), shop: shopMaterial(), iron: ironMaterial(), awning: awningMaterial(), pot: potMaterial() };
  const chunks = new Map<string, typeof plan.lots>();
  for (const lot of plan.lots) {
    const key = lot.boulevard ? `b${lot.side}:${Math.floor(lot.zMin / CHUNK_M)}` : `c${Math.round(lot.oz)}:${lot.side}`;
    const list = chunks.get(key) ?? [];
    list.push(lot);
    chunks.set(key, list);
  }
  for (const [key, lots] of chunks) group.add(buildChunk(key, lots, mats));
  return group;
}

function buildChunk(key: string, lots: StreetPlan['lots'], mats: Record<'stone' | 'zinc' | 'glass' | 'shop' | 'iron' | 'awning' | 'pot', Mesh['material']>): Group {
  const b: FacadeBuilders = {
    stone: new MeshBuilder({ tone: 1, rustic: 1, ao: 1 }),
    zinc: new MeshBuilder({ ao: 1 }),
    glass: new MeshBuilder({ win: 4, ao: 1 }),
    shop: new MeshBuilder({ shop: 4, paint: 1 }),
    iron: new MeshBuilder({ rail: 2 }),
    awning: new MeshBuilder({ paint: 1 }),
  };
  const fw = new FacadeWriter(b);
  const pots: Vector3[] = [];
  for (const lot of lots) {
    fw.write(lot);
    writeRoof(fw, b, lot, pots);
  }
  const group = new Group();
  group.name = `buildings ${key}`;
  const add = (builder: MeshBuilder, name: string, material: Mesh['material'], shadows = true): void => {
    if (builder.vertexCount === 0) return;
    const mesh = new Mesh(builder.build(name), material);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(b.stone, 'stone', mats.stone);
  add(b.zinc, 'zinc', mats.zinc);
  add(b.glass, 'windows', mats.glass, false);
  add(b.shop, 'shopfronts', mats.shop, false);
  add(b.iron, 'railings', mats.iron);
  add(b.awning, 'awnings', mats.awning);
  if (pots.length > 0) {
    const potMesh = new InstancedMesh(potGeometry(), mats.pot, pots.length);
    const m = new Matrix4();
    pots.forEach((p, i) => potMesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    potMesh.castShadow = true;
    potMesh.receiveShadow = true;
    potMesh.name = 'chimney pots';
    potMesh.computeBoundingSphere();
    group.add(potMesh);
  }
  return group;
}
