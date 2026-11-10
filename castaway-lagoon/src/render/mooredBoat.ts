import { attribute, float, texture, uv, vec3 } from 'three/tsl';
import { type BufferGeometry, Group, type Material, Mesh, MeshStandardNodeMaterial, type Texture } from 'three/webgpu';
import { modelLoader } from './gltf.ts';
import { WATER_LEVEL_M } from '../config.ts';
import { CUTTER } from '../game/moored.ts';
import { heightAt } from '../game/terrain.ts';
import { waterSurfaceY } from '../game/waves.ts';

// The cutter at anchor (game/moored.ts) as drawn: a downloaded model (shared/vehicles/boat_cutter, CC BY;
// prepared by paris/tools/vehicles/prepare_truck.py, its name painted off the bow) riding the same chop the
// water is drawn with. Its heave is the mean of the surface under bow, stern and both sides; its pitch and
// roll follow their differences, eased by its 8 m (a long hull bridges the short waves). It swings slowly
// to its anchor, a few degrees either way. The file faces −Z and stands on its keel at y = 0.

const URL_CUTTER = new URL('../../../shared/vehicles/boat_cutter/boat_cutter.glb', import.meta.url).href;

let scene: Group | null = null;

/** Loads the cutter's model; a failure leaves the lagoon without it (logged, not thrown). */
export async function loadMooredBoat(): Promise<void> {
  try {
    scene = (await modelLoader().loadAsync(URL_CUTTER)).scene;
  } catch (err) {
    console.warn('the moored cutter did not load:', err);
  }
}

/**
 * The model's own colours (a weathered painted hull: its texture is lit as it is); the occlusion
 * prepare_truck.py cast dims the sky and bounce light; glass dark and glossy; the lamp lenses their colour.
 */
function materialFor(src: Material): MeshStandardNodeMaterial {
  const s = src as MeshStandardNodeMaterial;
  const name = src.name.toLowerCase();
  const m = new MeshStandardNodeMaterial({ name: `cutter ${src.name}`, roughness: 0.7, metalness: 0 });
  if (name.includes('glass')) {
    m.colorNode = vec3(0.02, 0.025, 0.028);
    m.roughnessNode = float(0.08);
    m.transparent = true;
    m.opacity = 0.6;
    m.depthWrite = false;
    return m;
  }
  if (name.includes('greenlight')) m.colorNode = vec3(0.02, 0.35, 0.08);
  else if (name.includes('redlight')) m.colorNode = vec3(0.45, 0.02, 0.02);
  else if (s.map) m.colorNode = texture(s.map as Texture, uv()).rgb;
  if (s.normalMap) {
    m.normalMap = s.normalMap;
    m.normalScale.copy(s.normalScale);
  }
  if (name.includes('metal')) m.roughnessNode = float(0.55);
  m.aoNode = attribute('color_1', 'vec3').x;
  return m;
}

export class MooredBoatView {
  readonly group = new Group();
  private readonly hull = new Group();

  constructor() {
    this.group.name = 'moored cutter';
    this.group.position.set(CUTTER.x, WATER_LEVEL_M, CUTTER.z);
    this.hull.rotation.order = 'YXZ';
    this.group.add(this.hull);
    if (!scene) return;
    scene.updateMatrixWorld(true);
    const made = new Map<Material, MeshStandardNodeMaterial>();
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      // The keel at y = 0 in the file: its waterline down to the surface.
      g.translate(0, -CUTTER.draftM, 0);
      const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material;
      let mat = made.get(src);
      if (!mat) {
        mat = materialFor(src);
        made.set(src, mat);
      }
      const mesh = new Mesh(g, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.hull.add(mesh);
    });
  }

  update(timeS: number, waveScale: number): void {
    const swing = 0.07 * Math.sin(timeS / 41) + 0.04 * Math.sin(timeS / 17 + 1.3);
    const yaw = CUTTER.yawRad + swing;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const half = CUTTER.lengthM * 0.4;
    const side = CUTTER.beamM * 0.45;
    // `across` toward starboard: facing along (fx, fz) with y up, the right hand is (−fz, fx).
    const at = (along: number, across: number): number => {
      const x = CUTTER.x + fx * along - fz * across;
      const z = CUTTER.z + fz * along + fx * across;
      return waterSurfaceY(x, z, timeS, waveScale, WATER_LEVEL_M - heightAt(x, z));
    };
    const bow = at(half, 0);
    const stern = at(-half, 0);
    const port = at(0, -side);
    const starboard = at(0, side);
    const h = this.hull;
    h.position.y = (bow + stern + port + starboard) / 4;
    // The file faces −Z: a half turn puts its bow along the heading.
    h.rotation.y = yaw + Math.PI;
    // In the turned hull's own frame the bow lies toward −Z and starboard toward +X: a positive turn about
    // x lifts the bow, a positive turn about z lifts the starboard side.
    h.rotation.x = 0.6 * Math.atan2(bow - stern, 2 * half);
    h.rotation.z = 0.6 * Math.atan2(starboard - port, 2 * side);
  }
}
