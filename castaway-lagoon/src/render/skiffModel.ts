import { attribute, float, texture, uv, vec3 } from 'three/tsl';
import { type BufferGeometry, DoubleSide, type Group, type Material, Mesh, MeshStandardNodeMaterial, Shape, ShapeGeometry, type Texture, Vector2 } from 'three/webgpu';
import { modelLoader } from './gltf.ts';

// The skiff from a downloaded model (shared/vehicles/boat_skiff, CC BY; prepared by
// paris/tools/vehicles/prepare_truck.py without its own outboard): a riveted aluminium runabout of 4.6 m
// with a windscreen over a small helm, two seats behind it and an open cockpit aft. render/boat.ts hangs
// it in the boat's frame and clamps its own outboard (turned by the helm, its propeller spinning) on the
// transom. The file faces −Z and stands on its keel at y = 0.

/**
 * The model's keel below the boat's reference point (the still waterline of game/boat.ts). The logic
 * floats a flat-bottomed hull ~0.08 m deep; this one has a vee under it, so its keel draws deeper.
 */
export const SKIFF_KEEL_M = 0.2;
/** Its transom's top and its gunwale aft, over the reference point (the model's 0.84 m over its keel). */
export const SKIFF_TRANSOM_Y = 0.84 - SKIFF_KEEL_M;

const URL_SKIFF = new URL('../../../shared/vehicles/boat_skiff/boat_skiff.glb', import.meta.url).href;

let scene: Group | null = null;

/** Loads the skiff's model; a failure leaves the lofted procedural dinghy (logged, not thrown). */
export async function loadSkiffModel(): Promise<void> {
  try {
    scene = (await modelLoader().loadAsync(URL_SKIFF)).scene;
  } catch (err) {
    console.warn('the skiff model did not load; the procedural dinghy stands in:', err);
  }
}

export function skiffLoaded(): boolean {
  return scene !== null;
}

function materialFor(src: Material): MeshStandardNodeMaterial {
  const s = src as MeshStandardNodeMaterial;
  const m = new MeshStandardNodeMaterial({ name: `skiff ${src.name}`, roughness: 0.5, metalness: 0, side: DoubleSide });
  if (src.name.toLowerCase().includes('glass')) {
    // The windscreen: clear, a faint green tint in its edge.
    m.colorNode = vec3(0.03, 0.04, 0.038);
    m.roughnessNode = float(0.05);
    m.transparent = true;
    m.opacity = 0.35;
    m.depthWrite = false;
    return m;
  }
  if (s.map) m.colorNode = texture(s.map as Texture, uv()).rgb;
  if (s.normalMap) {
    m.normalMap = s.normalMap;
    m.normalScale.copy(s.normalScale);
  }
  // Bare and painted aluminium sheet: smoother than the cushions, a little metal in the bare parts.
  m.roughnessNode = float(0.45);
  m.metalnessNode = float(0.25);
  m.aoNode = attribute('color_1', 'vec3').x;
  return m;
}

/** The model's meshes in the boat's frame (keel at −SKIFF_KEEL_M), and their geometries for the mask. */
export function skiffMeshes(): { meshes: Mesh[]; geometries: BufferGeometry[] } {
  const meshes: Mesh[] = [];
  const geometries: BufferGeometry[] = [];
  if (!scene) return { meshes, geometries };
  scene.updateMatrixWorld(true);
  const made = new Map<Material, MeshStandardNodeMaterial>();
  scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    g.translate(0, -SKIFF_KEEL_M, 0);
    const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material;
    let mat = made.get(src);
    if (!mat) {
      mat = materialFor(src);
      made.set(src, mat);
    }
    const mesh = new Mesh(g, mat);
    mesh.castShadow = !src.name.toLowerCase().includes('glass');
    mesh.receiveShadow = true;
    meshes.push(mesh);
    geometries.push(g);
  });
  return { meshes, geometries };
}

/**
 * The hull's outline at the gunwale, from the model itself: at each station along it, the widest of its
 * vertices above the waterline, drawn in 2 cm, as a flat cap at `y` (the water must not show above it
 * inside the hull).
 */
export function skiffMaskGeometry(geometries: BufferGeometry[], y: number): BufferGeometry {
  const n = 28;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const g of geometries) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      zMin = Math.min(zMin, p.getZ(i));
      zMax = Math.max(zMax, p.getZ(i));
    }
  }
  const half = new Array<number>(n + 1).fill(0);
  for (const g of geometries) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < 0.05) continue;
      const k = Math.round(((p.getZ(i) - zMin) / (zMax - zMin)) * n);
      half[k] = Math.max(half[k] ?? 0, Math.abs(p.getX(i)));
    }
  }
  const pts: Vector2[] = [];
  for (let k = 0; k <= n; k++) pts.push(new Vector2(Math.max(0.005, (half[k] ?? 0) - 0.02), -(zMin + (k / n) * (zMax - zMin))));
  for (let k = n; k >= 0; k--) pts.push(new Vector2(-Math.max(0.005, (half[k] ?? 0) - 0.02), -(zMin + (k / n) * (zMax - zMin))));
  // Shape (x, y) → the boat's x (starboard) and −z (forward), laid flat, facing up.
  const g = new ShapeGeometry(new Shape(pts));
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}
