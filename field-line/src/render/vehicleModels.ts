import { attribute, clamp, dot, float, length, max, mix, smoothstep, texture, uv, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, type Material, Mesh, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node, type Texture } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR_MODELS, type CarModelId, carModelInfo } from '../maps/vehicles.ts';
import { lampLit } from './materials.ts';

// The shared car models (shared/vehicles, prepared by paris/tools/vehicles/prepare_vehicle.py) as parts
// ready for instancing: per model and level of detail, the paint (recoloured per car), the glass, the
// lamps and the wheels, each one merged geometry with its own material. Parked cars do not move, so the
// wheels are merged in place.

export type VehiclePart = 'paint' | 'glass' | 'lamps' | 'wheels';

export interface VehiclePartMesh {
  part: VehiclePart;
  geometry: BufferGeometry;
  material: Material;
  /** The paint takes each car's colour from a per-instance `paintTint` attribute. */
  recolour: boolean;
  castShadow: boolean;
}

/** Near (lod0) and far (lod1) part sets of one model; the same set twice when only the far one is loaded. */
export interface VehicleModel {
  near: VehiclePartMesh[];
  far: VehiclePartMesh[];
}

const URLS: Record<CarModelId, [string, string]> = {
  compact: [new URL('../../../shared/vehicles/compact/compact_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/compact/compact_lod1.glb', import.meta.url).href],
  coupe: [new URL('../../../shared/vehicles/coupe/coupe_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/coupe/coupe_lod1.glb', import.meta.url).href],
  hatchback: [new URL('../../../shared/vehicles/hatchback/hatchback_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/hatchback/hatchback_lod1.glb', import.meta.url).href],
  minivan: [new URL('../../../shared/vehicles/minivan/minivan_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/minivan/minivan_lod1.glb', import.meta.url).href],
  offroad: [new URL('../../../shared/vehicles/offroad/offroad_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/offroad/offroad_lod1.glb', import.meta.url).href],
  pickup: [new URL('../../../shared/vehicles/pickup/pickup_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/pickup/pickup_lod1.glb', import.meta.url).href],
  sedan: [new URL('../../../shared/vehicles/sedan/sedan_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/sedan/sedan_lod1.glb', import.meta.url).href],
  suv: [new URL('../../../shared/vehicles/suv/suv_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/suv/suv_lod1.glb', import.meta.url).href],
  wagon: [new URL('../../../shared/vehicles/wagon/wagon_lod0.glb', import.meta.url).href, new URL('../../../shared/vehicles/wagon/wagon_lod1.glb', import.meta.url).href],
};

const models = new Map<CarModelId, VehicleModel>();

/** The loaded model, or undefined before loadCarModels() (or when it failed: the procedural cars stand in). */
export function carModel(id: CarModelId): VehicleModel | undefined {
  return models.get(id);
}

/**
 * Loads every car model; a failure leaves the procedural cars in place (logged, not thrown). On Low (the
 * phones' preset) only the far level is fetched and serves near too: ~0.45 MB a model instead of ~2.3.
 */
export async function loadCarModels(quality: 'high' | 'low'): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    CAR_MODELS.map(async (id) => {
      try {
        const [nearUrl, farUrl] = URLS[id];
        const far = partsOf(id, (await loader.loadAsync(farUrl)).scene);
        const near = quality === 'high' ? partsOf(id, (await loader.loadAsync(nearUrl)).scene) : far;
        models.set(id, { near, far });
      } catch (err) {
        console.warn(`car model ${id} did not load; the procedural car stands in:`, err);
      }
    }),
  );
}

function categoryOf(materialName: string): VehiclePart {
  const n = materialName.toLowerCase();
  if (n.startsWith('body')) return 'paint';
  if (n.startsWith('glass')) return 'glass';
  if (n.startsWith('optics')) return 'lamps';
  return 'wheels';
}

interface SourceMaterial {
  map?: Texture | null;
  roughnessMap?: Texture | null;
  name: string;
}

function partsOf(id: CarModelId, root: { traverse: (f: (o: unknown) => void) => void; updateMatrixWorld: (force?: boolean) => void }): VehiclePartMesh[] {
  root.updateMatrixWorld(true);
  const pieces = new Map<VehiclePart, { geometries: BufferGeometry[]; material: SourceMaterial }>();
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const src = (Array.isArray(o.material) ? o.material[0] : o.material) as SourceMaterial;
    const part = categoryOf(src.name);
    const g = cleanGeometry(o.geometry as BufferGeometry).applyMatrix4(o.matrixWorld);
    const entry = pieces.get(part) ?? { geometries: [], material: src };
    entry.geometries.push(g);
    pieces.set(part, entry);
  });
  const out: VehiclePartMesh[] = [];
  for (const [part, { geometries, material }] of pieces) {
    const geometry = mergeGeometries(geometries, false);
    if (!geometry) continue;
    const paint = carModelInfo(id).paint;
    out.push({
      part,
      geometry,
      material: materialFor(part, material, paint),
      recolour: part === 'paint' && paint !== null,
      castShadow: part !== 'lamps',
    });
  }
  return out;
}

/** Position, normal, uv and the baked occlusion only, indexed: every piece merges with every other. */
function cleanGeometry(src: BufferGeometry): BufferGeometry {
  const g = src.clone();
  const n = g.getAttribute('position').count;
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv', 'color_1'].includes(name)) g.deleteAttribute(name);
  }
  if (!g.getAttribute('uv')) g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.getAttribute('color_1')) g.setAttribute('color_1', new BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.index) g.setIndex([...Array(n).keys()]);
  return g;
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);

function materialFor(part: VehiclePart, src: SourceMaterial, paint: [number, number, number] | null): Material {
  // prepare_vehicle.py bakes Cycles occlusion into the second colour set: it dims the sky and bounce
  // light (aoNode), not the sun, which has its own shadows.
  const ao = attribute('color_1', 'vec3').x;
  if (part === 'glass') {
    const m = new MeshPhysicalNodeMaterial({ name: 'car-glass', color: 0x0b0e11, roughness: 0.04, metalness: 0 });
    m.aoNode = ao;
    return m;
  }
  const albedo: Node<'vec3'> = src.map ? texture(src.map, uv()).rgb : vec3(0.5);
  const rough: Node<'float'> = src.roughnessMap ? texture(src.roughnessMap, uv()).g : float(0.5);
  if (part === 'paint') {
    const m = new MeshPhysicalNodeMaterial({ name: 'car-paint', metalness: 0 });
    let colour: Node<'vec3'> = albedo;
    if (paint) {
      // Recolour only the texels of the model's own paint: same chromaticity as it, not too dark (tyres,
      // grilles and shut lines keep theirs). The baked shading rides along as the luminance ratio.
      const p = vec3(paint[0], paint[1], paint[2]);
      const chroma = (c: Node<'vec3'>): Node<'vec3'> => c.div(max(c.x.add(c.y).add(c.z), 1e-4));
      const mask = float(1)
        .sub(smoothstep(0.05, 0.14, length(chroma(albedo).sub(chroma(p)))))
        .mul(smoothstep(0.002, 0.012, dot(albedo, LUMA)));
      const tint = attribute('paintTint', 'vec3');
      const recoloured = tint.mul(clamp(dot(albedo, LUMA).div(dot(p, LUMA)), 0, 1.6));
      colour = mix(albedo, recoloured, mask);
    }
    m.colorNode = colour;
    // Lacquer: the base coat's own roughness, under a smooth clear coat.
    m.roughnessNode = max(rough, 0.25);
    m.clearcoatNode = float(1);
    m.clearcoatRoughnessNode = float(0.07);
    m.aoNode = ao;
    const lamps = lampLit(colour);
    if (lamps) m.emissiveNode = lamps;
    return m;
  }
  const m = new MeshStandardNodeMaterial({ name: `car-${part}`, metalness: 0 });
  m.colorNode = albedo;
  m.roughnessNode = part === 'lamps' ? float(0.1) : rough;
  m.aoNode = ao;
  const lamps = lampLit(albedo);
  if (lamps) m.emissiveNode = lamps;
  return m;
}
