import { attribute, texture, uv } from 'three/tsl';
import { type BufferGeometry, type Group, type Material, Mesh, MeshStandardNodeMaterial, type Texture } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import bulatInfo from '../../../shared/vehicles/heli_bulat/heli_bulat.json';
import wardenInfo from '../../../shared/vehicles/heli_warden/heli_warden.json';
import { HELICOPTERS, type HeliId } from '../config.ts';

// Both helicopters from downloaded models (shared/vehicles/heli_warden and heli_bulat, CC BY; prepared by
// paris/tools/vehicles/prepare_heli.py): body, canopy glass, the main rotor's hub and blades, the tail
// rotor's hub and blades, the chin gun about its breech, and each anti-armour missile (the Bulat's fly from
// sealed launchers: none to hide). heliModel.ts hangs them on the same groups the procedural helicopters
// have, so the flight model, the views and the weapons drive them unchanged. The file's frame: mast on x = z = 0, wheels on y = 0, nose toward −Z; the body frame's
// origin is the centre of gravity, the wheels' contact `wheels[0][1]` below it.


export interface HeliInfo {
  hub: number[];
  rotorRadius: number;
  tailHub: number[];
  tailRadius: number;
  tailSide: number;
  gunPivot: number[];
  missiles: { centre: number[]; length: number }[];
  pods: { centre: number[]; front: number }[];
  eyes: { gunner: number[]; pilot: number[] } | null;
  albedo: number;
}

export interface ImportedHeli {
  info: HeliInfo;
  /** Body-frame height of the file's ground (y = 0). */
  lift: number;
  body: Mesh[];
  glass: BufferGeometry | null;
  rotorHub: Mesh[];
  rotorBlades: Mesh[];
  tailHub: Mesh[];
  tailBlades: Mesh[];
  gun: Mesh[];
  /** Each missile's meshes, in the file's order (heliModel.ts sorts them into firing order). */
  missiles: Mesh[][];
}

/**
 * Mean albedo the lifted texture lands on (olive-drab helicopter paint measures ~0.08-0.1 linear): the
 * model's textures were painted darker, for an engine that added light of its own. Never darkened, at
 * most quadrupled.
 */
const PAINT_ALBEDO = 0.09;
const MAX_GAIN = 4;

const SOURCES: Record<HeliId, { url: string; info: HeliInfo }> = {
  warden: { url: new URL('../../../shared/vehicles/heli_warden/heli_warden.glb', import.meta.url).href, info: wardenInfo as HeliInfo },
  bulat: { url: new URL('../../../shared/vehicles/heli_bulat/heli_bulat.glb', import.meta.url).href, info: bulatInfo as HeliInfo },
};

const loaded = new Map<HeliId, Group>();

/**
 * Loads both helicopters' models; a failure leaves that one procedural (logged, not thrown). Loaded, its crew's
 * eye points move to the model's seats (the cockpit view and the crew figures follow them).
 */
export async function loadHeliModels(): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    (Object.keys(SOURCES) as HeliId[]).map(async (id) => {
      try {
        loaded.set(id, (await loader.loadAsync(SOURCES[id].url)).scene);
      } catch (err) {
        console.warn(`the ${id} model did not load; the procedural one stands in:`, err);
        return;
      }
      const eyes = SOURCES[id].info.eyes;
      if (eyes) {
        const cfg = HELICOPTERS[id];
        const lift = cfg.wheels[0]?.[1] ?? 0;
        cfg.gunnerEye = [eyes.gunner[0] ?? 0, (eyes.gunner[1] ?? 0) + lift, eyes.gunner[2] ?? 0];
        cfg.pilotEye = [eyes.pilot[0] ?? 0, (eyes.pilot[1] ?? 0) + lift, eyes.pilot[2] ?? 0];
      }
    }),
  );
}

/** A loaded helicopter's parts with their materials made, or null (the procedural one is built). */
export function importedHeli(id: HeliId): ImportedHeli | null {
  const scene = loaded.get(id);
  if (!scene) return null;
  const info = SOURCES[id].info;
  const lift = HELICOPTERS[id].wheels[0]?.[1] ?? 0;
  const gain = Math.min(MAX_GAIN, Math.max(1, PAINT_ALBEDO / Math.max(info.albedo, 1e-3)));
  const made = new Map<Material, MeshStandardNodeMaterial>();
  const materialFor = (src: Material, fading: boolean): MeshStandardNodeMaterial => {
    const key = src;
    const cached = fading ? undefined : made.get(key);
    if (cached) return cached;
    const map = (src as MeshStandardNodeMaterial).map as Texture | null;
    const m = new MeshStandardNodeMaterial({ name: `${id} ${src.name}`, roughness: 0.68, metalness: 0 });
    if (map) m.colorNode = texture(map, uv()).rgb.mul(gain);
    // prepare_heli.py casts occlusion into the second colour set: the sky and bounce light only.
    m.aoNode = attribute('color_1', 'vec3').x;
    // The blades fade into the smear disc as the rotor spins up (heliView.ts sets their opacity).
    if (fading) m.transparent = true;
    if (!fading) made.set(key, m);
    return m;
  };
  const meshesOf = (name: string, fading = false): Mesh[] => {
    const node = scene.getObjectByName(name);
    if (!node) return [];
    const out: Mesh[] = [];
    node.updateMatrixWorld(true);
    node.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      const src = Array.isArray(o.material) ? (o.material[0] as Material) : (o.material as Material);
      const mesh = new Mesh(g, materialFor(src, fading));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      out.push(mesh);
    });
    return out;
  };
  const glassNode = scene.getObjectByName('glass');
  let glass: BufferGeometry | null = null;
  glassNode?.updateMatrixWorld(true);
  glassNode?.traverse((o) => {
    if (o instanceof Mesh && !glass) glass = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
  });
  const missiles: Mesh[][] = info.missiles.map((_, i) => meshesOf(`missile_${i}`));
  return {
    info,
    lift,
    body: meshesOf('body'),
    glass,
    rotorHub: meshesOf('rotor_hub'),
    rotorBlades: meshesOf('rotor_blades', true),
    tailHub: meshesOf('tail_hub'),
    tailBlades: meshesOf('tail_blades', true),
    gun: meshesOf('gun'),
    missiles,
  };
}
