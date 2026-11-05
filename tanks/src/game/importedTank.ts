import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import mbtWestInfo from '../../../shared/vehicles/mbt_west/mbt_west.json';
import mbtEastInfo from '../../../shared/vehicles/mbt_east/mbt_east.json';
import ifvWestInfo from '../../../shared/vehicles/ifv_west/ifv_west.json';
import ifvEastInfo from '../../../shared/vehicles/ifv_east/ifv_east.json';
import { makeVehicleUniforms, vehicleMaterial } from '../render/vehicleMaterial';
import type { TankModel, TankStyle } from './tankModel';

// Tanks and IFVs from downloaded models (shared/vehicles, CC BY; prepared by
// paris/tools/vehicles/prepare_tank.py into a hull, a turret about its ring and a gun about its
// trunnions), assembled into the same TankModel the procedural tanks are, so the game drives them the
// same way: the turret group traverses, the gun group elevates, the muzzle, coax and roof gun are
// points on them. The prepared files face -Z; the game's tanks face +Z, so everything turns half round.
// Their running gear is part of the hull and does not turn: the wheel and track fields are inert.

interface PartBox {
  min: number[];
  max: number[];
}

interface TankInfo {
  turretPivot: number[];
  gunPivot: number[];
  muzzle: number[];
  boxes: { hull: PartBox; turret: PartBox; gun: PartBox };
  /** Mean linear luminance of the model's colour textures (prepare_tank.py). */
  albedo: number;
}

/**
 * Mean albedo the lifted texture lands on: weathered olive and camouflage paint measures about 0.1-0.15
 * linear. Most of the downloaded models' textures were painted for engines that added light of their own
 * (0.016-0.05 measured over the texels in use), so under this game's measured sun and sky they read near
 * black. Never darkened; lifted at most six times (the darkest texture, whose painted shading then
 * stays as dark as it was drawn).
 */
const PAINT_ALBEDO = 0.12;
const MAX_GAIN = 6;

const SOURCES: Record<TankStyle, { url: string; info: TankInfo }> = {
  west: { url: new URL('../../../shared/vehicles/mbt_west/mbt_west.glb', import.meta.url).href, info: mbtWestInfo },
  east: { url: new URL('../../../shared/vehicles/mbt_east/mbt_east.glb', import.meta.url).href, info: mbtEastInfo },
  ifvWest: { url: new URL('../../../shared/vehicles/ifv_west/ifv_west.glb', import.meta.url).href, info: ifvWestInfo },
  ifvEast: { url: new URL('../../../shared/vehicles/ifv_east/ifv_east.glb', import.meta.url).href, info: ifvEastInfo },
};

const loaded = new Map<TankStyle, THREE.Group>();

/** Loads every vehicle; a failure leaves the procedural tank of its side (logged, not thrown). */
export async function loadTankModels(): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    (Object.keys(SOURCES) as TankStyle[]).map(async (style) => {
      try {
        loaded.set(style, (await loader.loadAsync(SOURCES[style].url)).scene);
      } catch (err) {
        console.warn(`tank model ${style} did not load; the procedural tank stands in:`, err);
      }
    }),
  );
}

/** A half turn about Y: the prepared files' frame (front -Z) into the game's (front +Z). */
const turn = (v: readonly number[]): THREE.Vector3 => new THREE.Vector3(-(v[0] ?? 0), v[1] ?? 0, -(v[2] ?? 0));

/** The box of a part in the game's frame, relative to `origin`, its height capped (antennas are not armour). */
function boxOf(b: PartBox, origin: THREE.Vector3, topCap: number): TankModel['hullBox'] {
  const a = turn(b.min).sub(origin);
  const c = turn(b.max).sub(origin);
  const lo = new THREE.Vector3(Math.min(a.x, c.x), Math.min(a.y, c.y), Math.min(a.z, c.z));
  const hi = new THREE.Vector3(Math.max(a.x, c.x), Math.min(Math.max(a.y, c.y), topCap), Math.max(a.z, c.z));
  return { c: lo.clone().add(hi).multiplyScalar(0.5), h: hi.clone().sub(lo).multiplyScalar(0.5) };
}

/** The imported tank for this style, or null when its model is not loaded (the procedural one is used). */
export function importedTank(style: TankStyle, seed: number): TankModel | null {
  const scene = loaded.get(style);
  if (!scene) return null;
  const info = SOURCES[style].info;
  const uniforms = makeVehicleUniforms(seed, [0x4b5340, 0x4f3f2e, 0x262628]);
  const mapGain = Math.min(MAX_GAIN, Math.max(1, PAINT_ALBEDO / Math.max(info.albedo, 1e-3)));
  const materials: THREE.Material[] = [];
  const byMaterial = new Map<THREE.Material, THREE.Material>();
  const materialFor = (src: THREE.Material): THREE.Material => {
    let m = byMaterial.get(src);
    if (!m) {
      const std = src as THREE.MeshStandardMaterial;
      const made = std.map
        ? vehicleMaterial('natoGreen', uniforms, { map: std.map, mapGain })
        : vehicleMaterial('parkerised', uniforms, { params: { color: std.color ?? new THREE.Color(0x30302c) } });
      // prepare_tank.py casts occlusion into the second colour set: it dims the sky and bounce light only.
      made.aoNode = attribute('color_1', 'vec3').x;
      materials.push(made);
      byMaterial.set(src, made);
      m = made;
    }
    return m;
  };

  const turretPivot = turn(info.turretPivot);
  const gunPivot = turn(info.gunPivot);
  const gunLength = -(info.muzzle[2] ?? -5);
  const root = new THREE.Group();
  const hull = new THREE.Group();
  root.add(hull);
  const turret = new THREE.Group();
  turret.position.copy(turretPivot);
  hull.add(turret);
  const gun = new THREE.Group();
  gun.position.copy(gunPivot);
  turret.add(gun);

  // Each part's meshes, turned into the game's frame; `tankPos` is the rest-pose position in the hull
  // frame, which the paint's dust, grime and heat are laid out by.
  const place = (name: string, into: THREE.Group, offset: THREE.Vector3): void => {
    const node = scene.getObjectByName(name);
    if (!node) return;
    node.updateMatrixWorld(true);
    node.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const g = (o.geometry as THREE.BufferGeometry).clone();
      g.applyMatrix4(new THREE.Matrix4().copy(o.matrixWorld).premultiply(new THREE.Matrix4().makeRotationY(Math.PI)));
      const p = g.getAttribute('position');
      const tp = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        tp[i * 3] = p.getX(i) + offset.x;
        tp[i * 3 + 1] = p.getY(i) + offset.y;
        tp[i * 3 + 2] = p.getZ(i) + offset.z;
      }
      g.setAttribute('tankPos', new THREE.BufferAttribute(tp, 3));
      if (!g.getAttribute('color_1')) g.setAttribute('color_1', new THREE.BufferAttribute(new Float32Array(p.count * 3).fill(1), 3));
      const mesh = new THREE.Mesh(g, materialFor(Array.isArray(o.material) ? (o.material[0] as THREE.Material) : o.material));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      into.add(mesh);
    });
  };
  place('hull', hull, new THREE.Vector3());
  place('turret', turret, turretPivot);
  place('gun', gun, turretPivot.clone().add(gunPivot));

  const hullBox = boxOf(info.boxes.hull, new THREE.Vector3(), turretPivot.y + 0.15);
  const turretBox = boxOf(info.boxes.turret, turretPivot, 1.1);
  const deckY = turretPivot.y;
  const rearZ = hullBox.c.z - hullBox.h.z;
  const frontZ = hullBox.c.z + hullBox.h.z;

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, gunLength + 0.05);
  gun.add(muzzle);
  const coax = new THREE.Object3D();
  coax.position.set(0.3, 0.02, 0.75);
  gun.add(coax);
  const roofMg = new THREE.Object3D();
  roofMg.position.set(-0.6, turretBox.c.y + turretBox.h.y, 0.3);
  turret.add(roofMg);
  const sight = new THREE.Object3D();
  sight.position.set(0.55, turretBox.c.y + turretBox.h.y - 0.1, turretBox.c.z + turretBox.h.z - 0.3);
  turret.add(sight);

  // Inert running gear: the model's wheels and tracks are part of the hull.
  const inert = new THREE.MeshStandardNodeMaterial();
  const wheels = new THREE.InstancedMesh(new THREE.BufferGeometry(), inert, 1);
  wheels.count = 0;
  const headlightMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8e8e0, emissive: 0xfff2d8, emissiveIntensity: 0 });
  return {
    root,
    hull,
    turret,
    gun,
    muzzle,
    coax,
    roofMg,
    sight,
    turretPivot,
    gunPivot,
    uniforms,
    materials,
    trackMats: [inert, inert],
    trackTex: [new THREE.Texture(), new THREE.Texture()],
    wheels,
    wheelSpecs: [],
    sprockets: [new THREE.Mesh(), new THREE.Mesh()],
    idlers: [new THREE.Mesh(), new THREE.Mesh()],
    trackX: Math.max(0.9, hullBox.h.x - 0.38),
    linkPitch: 0.16,
    hullBox,
    turretBox,
    gunLength,
    exhaust: [new THREE.Vector3(0.5, deckY + 0.05, rearZ + 0.3), new THREE.Vector3(-0.5, deckY + 0.05, rearZ + 0.3)],
    headlights: [new THREE.Vector3(1.3, 1.15, frontZ - 0.1), new THREE.Vector3(-1.3, 1.15, frontZ - 0.1)],
    headlightMat,
  };
}
