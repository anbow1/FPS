import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, positionLocal, sin, time, uniform, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, MeshStandardNodeMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three/webgpu';
import type { TreeInstance } from '../maps/types.ts';
import type { MaterialLibrary } from './materials.ts';

// Instanced pines and undergrowth, split into spatial chunks so frustum culling
// drops what is behind the camera. The crown sways with the same wind vector
// that drifts bullets (brief): one uniform, fed from game.wind every frame.
// Foliage uses the alpha-clip needle material with coverage-preserving mips.

const CHUNK_M = 100;

/** World wind in m/s, set by the view each frame from the game's wind. */
export const windVector = uniform(new Vector3());

/**
 * Pine of unit height, crown from 35 % up: stacked open cones (double-sided
 * needle cards), radius about 0.2 × height at the base of the crown.
 */
function pineCrown(): BufferGeometry {
  const layers: BufferGeometry[] = [];
  const count = 7;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const y = 0.35 + t * 0.58;
    const radius = 0.2 * (1 - t * 0.82);
    const h = 0.16 - t * 0.05;
    const cone = new CylinderGeometry(0.004, radius, h, 11, 1, true);
    cone.rotateY(i * 0.9);
    cone.translate(0, y, 0);
    layers.push(cone);
  }
  const g = mergeGeometries(layers, false);
  if (!g) throw new Error('pine crown merge failed');
  addSway(g);
  return g;
}

function pineTrunk(): BufferGeometry {
  const g = new CylinderGeometry(0.004, 0.018, 1, 7, 1, true).translate(0, 0.5, 0);
  addSway(g);
  return g;
}

/** Three crossed needle cards, unit size. */
function bushGeometry(): BufferGeometry {
  const cards: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) cards.push(new PlaneGeometry(1.6, 1.0).translate(0, 0.45, 0).rotateY((i * Math.PI) / 3));
  const g = mergeGeometries(cards, false);
  if (!g) throw new Error('bush merge failed');
  addSway(g);
  return g;
}

/** Sway weight: 0 at the base, rising with the square of height. */
function addSway(g: BufferGeometry): void {
  const pos = g.getAttribute('position');
  const sway = new Float32Array(pos.count);
  let maxY = 0;
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
  for (let i = 0; i < pos.count; i++) sway[i] = (Math.max(0, pos.getY(i)) / maxY) ** 2;
  g.setAttribute('sway', new BufferAttribute(sway, 1));
}

/** Wind-driven vertex offset, applied after instancing (positionLocal is world here). */
function swayingMaterial(base: MeshStandardNodeMaterial, amplitudePerMs: number): MeshStandardNodeMaterial {
  const m = base.clone();
  const w = attribute('sway', 'float');
  const p = positionLocal;
  const phase = p.x.mul(0.07).add(p.z.mul(0.05));
  // Gusts: a slow push with the wind plus a faster flutter across it.
  const push = sin(time.mul(0.9).add(phase)).mul(0.5).add(0.6);
  const flutter = sin(time.mul(3.1).add(phase.mul(3)));
  const across = vec3(windVector.z.negate(), 0, windVector.x);
  m.positionNode = p.add(windVector.mul(push.mul(amplitudePerMs).mul(w))).add(across.mul(flutter.mul(amplitudePerMs * 0.3).mul(w)));
  return m;
}

export function buildFoliage(trees: readonly TreeInstance[], bushes: readonly TreeInstance[], lib: MaterialLibrary): Group {
  const group = new Group();
  group.name = 'foliage';
  if (trees.length === 0 && bushes.length === 0) return group;
  const crown = pineCrown();
  const trunk = pineTrunk();
  const bush = bushGeometry();
  const needles = swayingMaterial(lib.get('needles') as MeshStandardNodeMaterial, 0.18);
  const bark = swayingMaterial(lib.get('bark') as MeshStandardNodeMaterial, 0.08);
  const bushMat = swayingMaterial(lib.get('needles') as MeshStandardNodeMaterial, 0.05);

  const chunks = new Map<string, { trees: TreeInstance[]; bushes: TreeInstance[] }>();
  const chunkOf = (t: TreeInstance): { trees: TreeInstance[]; bushes: TreeInstance[] } => {
    const key = `${Math.floor(t.pos.x / CHUNK_M)},${Math.floor(t.pos.z / CHUNK_M)}`;
    let c = chunks.get(key);
    if (!c) {
      c = { trees: [], bushes: [] };
      chunks.set(key, c);
    }
    return c;
  };
  for (const t of trees) chunkOf(t).trees.push(t);
  for (const b of bushes) chunkOf(b).bushes.push(b);

  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const fill = (mesh: InstancedMesh, list: readonly TreeInstance[], widthScale: number, sink: number): void => {
    list.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yawRad);
      const w = t.heightM * widthScale * (0.85 + ((t.seed % 97) / 97) * 0.3);
      m.compose(new Vector3(t.pos.x, t.pos.y - sink, t.pos.z), q, new Vector3(w, t.heightM, w));
      mesh.setMatrixAt(i, m);
    });
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  };
  for (const c of chunks.values()) {
    if (c.trees.length > 0) {
      const trunks = new InstancedMesh(trunk, bark, c.trees.length);
      fill(trunks, c.trees, 1, 0.3);
      const crowns = new InstancedMesh(crown, needles, c.trees.length);
      fill(crowns, c.trees, 1, 0.3);
      group.add(trunks, crowns);
    }
    if (c.bushes.length > 0) {
      const b = new InstancedMesh(bush, bushMat, c.bushes.length);
      fill(b, c.bushes, 1, 0.05);
      b.castShadow = false;
      group.add(b);
    }
  }
  return group;
}
