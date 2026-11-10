import { abs, attribute, float, length, positionLocal, select, texture, uv, vec2, vec3 } from 'three/tsl';
import type { UniformNode } from 'three/webgpu';
import { type BufferGeometry, DoubleSide, type Group, type Material, Mesh, MeshStandardNodeMaterial, type Object3D, type Texture, Vector3 } from 'three/webgpu';
import { modelLoader } from './gltf.ts';
import { JEEP } from '../config.ts';

// The jeep from a downloaded model (shared/vehicles/jeep_open, CC BY; prepared by
// paris/tools/vehicles/prepare_vehicle.py with its wheels and bonnet as their own nodes, its stencilled
// star and numbers painted out): a wartime-pattern open quarter-ton with a fold-down screen, a slat grille
// and a spare on the tail. render/jeep.ts hangs it in the logic's frame (game/jeep.ts: forward −Z, y = 0 the
// body's reference point, JEEP.rideHeightM over the ground) and turns its wheels and bonnet as before.
// The file faces −Z and stands on its tyres at y = 0; its wheels sit a little off its bounding box's middle
// (a mirror on one side only), so the frame is centred on the wheels instead.

const URL_JEEP = new URL('../../../shared/vehicles/jeep_open/jeep_open.glb', import.meta.url).href;

/**
 * The headlamp lenses in the logic's frame: the two bezels' middle in the prepared file (x ±0.35 about the
 * wheels' centre line, 0.934 m over the ground, their glass 1.388 m ahead of the file's middle), radius 7 cm.
 */
export const JEEP_LAMP = { x: 0.35, y: 0.934 - JEEP.rideHeightM, z: -1.277, r: 0.07 } as const;

let scene: Group | null = null;

/** Loads the jeep's model; a failure leaves the procedural jeep (logged, not thrown). */
export async function loadJeepModel(): Promise<void> {
  try {
    scene = (await modelLoader().loadAsync(URL_JEEP)).scene;
  } catch (err) {
    console.warn('the jeep model did not load; the procedural jeep stands in:', err);
  }
}

export function jeepLoaded(): boolean {
  return scene !== null;
}

function materialFor(src: Material, glow: UniformNode<'float', number>): MeshStandardNodeMaterial {
  const s = src as MeshStandardNodeMaterial;
  const m = new MeshStandardNodeMaterial({ name: `jeep ${src.name}`, roughness: 0.7, metalness: 0, side: DoubleSide });
  if (src.name.toLowerCase().includes('glass')) {
    // The screen: clear, a little green in its thickness.
    m.colorNode = vec3(0.03, 0.04, 0.038);
    m.roughnessNode = float(0.05);
    m.transparent = true;
    m.opacity = 0.3;
    m.depthWrite = false;
    return m;
  }
  if (s.map) m.colorNode = texture(s.map as Texture, uv()).rgb;
  if (s.normalMap) {
    m.normalMap = s.normalMap;
    m.normalScale.copy(s.normalScale);
  }
  // The model's own wear map: chipped and dusty paint rough, rubbed edges and the bright work smoother
  // (glTF keeps roughness in green, metalness in blue).
  if (s.roughnessMap) {
    const mr = texture(s.roughnessMap as Texture, uv());
    m.roughnessNode = mr.g;
    m.metalnessNode = mr.b;
  }
  m.aoNode = attribute('color_1', 'vec3').x;
  // The headlamp glasses light up: the lens discs on the front face of each bezel.
  const p = positionLocal;
  const off = length(vec2(abs(p.x).sub(JEEP_LAMP.x), p.y.sub(JEEP_LAMP.y)));
  const lens = select(off.lessThan(JEEP_LAMP.r).and(p.z.lessThan(JEEP_LAMP.z + 0.03)), float(1), float(0));
  m.emissiveNode = vec3(1, 0.92, 0.78).mul(glow).mul(lens);
  return m;
}

export interface JeepParts {
  body: Mesh[];
  /** The bonnet's meshes about its hinge (its rear top edge), and where that hinge is. */
  bonnet: Mesh[];
  hinge: Vector3;
  /** Each wheel about its own axle, where the axle is, and whether it steers. */
  wheels: { meshes: Mesh[]; at: Vector3; front: boolean }[];
}

/** The model's parts in the logic's frame (see the top of this file). */
export function jeepParts(glow: UniformNode<'float', number>): JeepParts {
  const out: JeepParts = { body: [], bonnet: [], hinge: new Vector3(), wheels: [] };
  if (!scene) return out;
  scene.updateMatrixWorld(true);
  const nodes: Object3D[] = [...scene.children];
  const wheelNodes = nodes.filter((n) => n.name.startsWith('wheel_'));
  // The wheels' centre line and the middle of the wheelbase, from the file's own axles.
  let cx = 0;
  let cz = 0;
  for (const w of wheelNodes) {
    cx += w.position.x / wheelNodes.length;
    cz += w.position.z / wheelNodes.length;
  }
  const shift = new Vector3(-cx, -JEEP.rideHeightM, -cz);
  const made = new Map<Material, MeshStandardNodeMaterial>();
  const meshesOf = (node: Object3D, place: (g: BufferGeometry) => void): Mesh[] => {
    const list: Mesh[] = [];
    node.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      place(g);
      const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material;
      let mat = made.get(src);
      if (!mat) {
        mat = materialFor(src, glow);
        made.set(src, mat);
      }
      const mesh = new Mesh(g, mat);
      mesh.castShadow = !src.name.toLowerCase().includes('glass');
      mesh.receiveShadow = true;
      list.push(mesh);
    });
    return list;
  };
  for (const n of nodes) {
    if (n.name.startsWith('wheel_')) {
      const at = n.position.clone().add(shift);
      // Each wheel's geometry about its own axle: the view spins and steers it there.
      const meshes = meshesOf(n, (g) => g.translate(-n.position.x, -n.position.y, -n.position.z));
      out.wheels.push({ meshes, at, front: n.name.charAt(6) === 'F' });
    } else if (n.name === 'bonnet') {
      const box = new Vector3(-Infinity, -Infinity, -Infinity);
      const meshes = meshesOf(n, (g) => {
        g.translate(shift.x, shift.y, shift.z);
        g.computeBoundingBox();
        if (g.boundingBox) box.max(g.boundingBox.max);
      });
      // Hinged along its rear top edge, at the screen.
      out.hinge.set(0, box.y, box.z);
      for (const m of meshes) m.geometry.translate(0, -box.y, -box.z);
      out.bonnet.push(...meshes);
    } else {
      out.body.push(...meshesOf(n, (g) => g.translate(shift.x, shift.y, shift.z)));
    }
  }
  return out;
}
