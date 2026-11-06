import { attribute, texture, uv } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, Group, type Material, Mesh, MeshStandardNodeMaterial, type Texture, Vector3 } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The AK-pattern rifle from a downloaded model (shared/weapons/rifle_ak, CC BY; prepared by
// paris/tools/vehicles/prepare_gun.py: split at its rig's bones into the body, the magazine, the bolt
// carrier with its handle, the trigger and the selector). weaponModels.ts builds the player's rifle from
// it when it loaded, with the same frame and the same handles as the procedural one: metres, facing −Z,
// the iron-sight line at y = 0 with the rear notch at z = 0.
//
// The prepared file stands on its magazine's foot (y = 0) and is centred along its length. Its sights, read
// from the vertices on its centre line: the rear leaf's notch 0.039 m ahead of the middle, its floor at
// 0.200 m and its shoulders at 0.2135 m; the front post's tip at 0.2092 m, 0.416 m ahead (a sight radius
// of 0.377 m, the AKM's 378 mm). The aim line runs between the shoulders' top and the post's tip, 0.211 m.

const URL_RIFLE = new URL('../../../shared/weapons/rifle_ak/rifle_ak.glb', import.meta.url).href;

/** The file's frame → the rifle's: the sight line down to y = 0, the rear notch to z = 0. */
const SHIFT = new Vector3(0, -0.211, 0.039);
/** Where the game holds the magazine and the bolt at rest (viewmodel.ts animates them from there). */
const MAG_REST = new Vector3(0, -0.086, 0);
const BOLT_REST = new Vector3(0, 0, -0.02);

let parts: Map<string, { geometry: BufferGeometry; material: MeshStandardNodeMaterial }> | null = null;

/** Loads the rifle's model; a failure leaves the procedural rifle (logged, not thrown). */
export async function loadRifleModel(): Promise<void> {
  try {
    const scene = (await new GLTFLoader().loadAsync(URL_RIFLE)).scene;
    scene.updateMatrixWorld(true);
    const made = new Map<Material, MeshStandardNodeMaterial>();
    const found = new Map<string, { geometry: BufferGeometry; material: MeshStandardNodeMaterial }>();
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      g.translate(SHIFT.x, SHIFT.y, SHIFT.z);
      // The worn finishes elsewhere read `edge` (gunkit.ts); this model's wear is in its own textures.
      g.setAttribute('edge', new BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
      const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material;
      let mat = made.get(src);
      if (!mat) {
        mat = materialFor(src);
        made.set(src, mat);
      }
      // The node's name, or its parent's when the mesh is an anonymous child of the named part.
      const name = o.name.startsWith('body') || o.parent === scene || !o.parent ? o.name : o.parent.name;
      found.set(name.replace(/_\d+$/, ''), { geometry: g, material: mat });
    });
    if (!found.has('body')) throw new Error('rifle model without a body');
    parts = found;
  } catch (err) {
    console.warn('the rifle model did not load; the procedural rifle stands in:', err);
  }
}

export function rifleModelLoaded(): boolean {
  return parts !== null;
}

/**
 * Its own colours and wear (blued and phosphated steel rubbed bright on the edges, varnished laminate):
 * glTF keeps roughness in green and metalness in blue; the occlusion prepare_gun.py cast in the second
 * colour set darkens the folds.
 */
function materialFor(src: Material): MeshStandardNodeMaterial {
  const s = src as MeshStandardNodeMaterial;
  const m = new MeshStandardNodeMaterial({ name: `ak ${src.name}`, roughness: 0.5, metalness: 0.5 });
  if (s.map) m.colorNode = texture(s.map as Texture, uv()).rgb;
  if (s.normalMap) {
    m.normalMap = s.normalMap;
    m.normalScale.copy(s.normalScale);
  }
  if (s.roughnessMap) {
    const mr = texture(s.roughnessMap as Texture, uv());
    // Times the material's own factors (this one's metalness is 0.68: the laminate and the paint are not metal).
    m.roughnessNode = mr.g.mul(s.roughness);
    m.metalnessNode = mr.b.mul(s.metalness);
  }
  m.aoNode = attribute('color_1', 'vec3').x;
  return m;
}

function partMesh(name: string, at?: Vector3): Mesh {
  const p = parts?.get(name);
  if (!p) return new Mesh();
  // Each instance shares the geometry; a moving part's geometry is about its rest position.
  let g = p.geometry;
  if (at) g = g.clone().translate(-at.x, -at.y, -at.z);
  const m = new Mesh(g, p.material);
  if (at) m.position.copy(at);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export interface ModelRifle {
  root: Group;
  magazine: Mesh;
  chargingHandle: Mesh;
  muzzle: Vector3;
  port: Vector3;
  eyeZ: number;
  gripRight: Vector3;
  gripLeft: Vector3;
}

/**
 * The model's rifle in the procedural one's frame. Its points, from the prepared file: the muzzle brake's
 * mouth 0.401 m ahead of the notch with the bore 0.053 m under the sight line; the ejection port over the
 * bolt on the right; the pistol grip behind the trigger guard; the left hand on the lower handguard.
 */
export function modelRifle(): ModelRifle {
  const root = new Group();
  root.name = 'ak';
  root.add(partMesh('body'), partMesh('trigger'), partMesh('selector'));
  const magazine = partMesh('magazine', MAG_REST);
  const chargingHandle = partMesh('bolt', BOLT_REST);
  root.add(magazine, chargingHandle);
  return {
    root,
    magazine,
    chargingHandle,
    muzzle: new Vector3(0, -0.053, -0.401),
    port: new Vector3(0.02, -0.035, 0.05),
    eyeZ: 0.33,
    gripRight: new Vector3(0, -0.13, 0.19),
    gripLeft: new Vector3(0, -0.075, -0.17),
  };
}
