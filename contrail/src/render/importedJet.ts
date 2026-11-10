import { BufferAttribute, type BufferGeometry, type Group, type Material, Mesh, MeshStandardNodeMaterial, type Texture } from 'three/webgpu';
import { modelLoader } from './gltf.ts';
import talonInfo from '../../../shared/vehicles/jet_talon/jet_talon.json';
import wraithInfo from '../../../shared/vehicles/jet_wraith/jet_wraith.json';
import { AIRCRAFT, type AircraftId } from '../config.ts';

// Both fighters from downloaded models (shared/vehicles/jet_wraith, CC0, and jet_talon, CC BY; prepared by
// paris/tools/vehicles/prepare_jet.py): the body without its landing gear (the game's retractable gear is
// drawn instead), the canopy glass, and where the model has them apart, the tailplanes, flaperons and
// rudders about their hinge lines (the Talon's are moulded into its skin: they stay still). jetModels.ts
// hangs them on the same hinges the procedural fighters have, so the control laws move them unchanged.
// The Talon's file is moved along its length so its main wheels stand where the flight model's do. The file's frame: nose toward −Z, standing on its wheels on y = 0; the body frame puts the
// ground, at rest on the struts, `main.y − travel + static compression` below the centre of mass.

export interface JetInfo {
  hinges: { name: string; kind: 'stab' | 'flaperon' | 'rudder'; side: number; a: number[]; b: number[] }[];
  nozzle: number[];
  /** Each engine's exit (two side by side on the Talon); absent in older files: `nozzle` alone. */
  nozzles?: number[][];
  wingtips: number[][];
  eye: number[] | null;
  gear: { x: number; z: number; belly: number }[];
  albedo: number;
  size: number[];
}

export interface ImportedJet {
  info: JetInfo;
  /** Body-frame height of the file's ground (y = 0). */
  lift: number;
  body: Mesh[];
  glass: BufferGeometry | null;
  /** Each moving surface's meshes, about its hinge's first point. */
  surfaces: Map<string, Mesh[]>;
}

const SOURCES: Record<AircraftId, { url: string; info: JetInfo }> = {
  wraith: { url: new URL('../../../shared/vehicles/jet_wraith/jet_wraith.glb', import.meta.url).href, info: wraithInfo as JetInfo },
  talon: { url: new URL('../../../shared/vehicles/jet_talon/jet_talon.glb', import.meta.url).href, info: talonInfo as JetInfo },
};

const loaded = new Map<AircraftId, Group>();

/** Loads both fighters' models; a failure leaves that one procedural (logged, not thrown). */
export async function loadJetModels(): Promise<void> {
  const loader = modelLoader();
  await Promise.all(
    (Object.keys(SOURCES) as AircraftId[]).map(async (id) => {
      try {
        loaded.set(id, (await loader.loadAsync(SOURCES[id].url)).scene);
      } catch (err) {
        console.warn(`the ${id} model did not load; the procedural one stands in:`, err);
      }
    }),
  );
}

/** A loaded fighter's parts, fresh meshes and materials each call (one per aircraft), or null. */
export function importedJet(id: AircraftId): ImportedJet | null {
  const scene = loaded.get(id);
  if (!scene) return null;
  const info = SOURCES[id].info;
  const legs = AIRCRAFT[id].gear.legs;
  const main = legs.find((l) => !l.nose) ?? legs[0];
  const lift = main ? main.y - main.travelM + AIRCRAFT[id].gear.staticCompressionM : 0;
  const made = new Map<Material, MeshStandardNodeMaterial>();
  const materialFor = (src: Material): MeshStandardNodeMaterial => {
    let m = made.get(src);
    if (m) return m;
    const s = src as MeshStandardNodeMaterial;
    // The radar-absorbent coating: a satin grey, its panel lines in the normal map.
    m = new MeshStandardNodeMaterial({
      name: `${id} ${src.name}`,
      map: (s.map as Texture | null) ?? null,
      normalMap: (s.normalMap as Texture | null) ?? null,
      color: s.color,
      roughness: 0.55,
      metalness: 0.05,
    });
    made.set(src, m);
    return m;
  };
  const meshesOf = (name: string): Mesh[] => {
    const node = scene.getObjectByName(name);
    if (!node) return [];
    node.updateMatrixWorld(true);
    const out: Mesh[] = [];
    node.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      // prepare_jet.py cast occlusion into the second colour set; as the `ao` attribute the airframe's
      // own bake (aoBake.ts) skips this mesh, keeps it as an occluder for the gear, and wires it up.
      const c1 = g.getAttribute('color_1');
      if (c1) {
        const ao = new Float32Array(c1.count);
        for (let i = 0; i < c1.count; i++) ao[i] = c1.getX(i);
        g.setAttribute('ao', new BufferAttribute(ao, 1));
      }
      const src = Array.isArray(o.material) ? (o.material[0] as Material) : (o.material as Material);
      const mesh = new Mesh(g, materialFor(src));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      out.push(mesh);
    });
    return out;
  };
  let glass: BufferGeometry | null = null;
  const glassNode = scene.getObjectByName('glass');
  glassNode?.updateMatrixWorld(true);
  glassNode?.traverse((o) => {
    if (o instanceof Mesh && !glass) glass = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
  });
  const surfaces = new Map<string, Mesh[]>();
  for (const h of info.hinges) surfaces.set(h.name, meshesOf(h.name));
  return { info, lift, body: meshesOf('body'), glass, surfaces };
}
