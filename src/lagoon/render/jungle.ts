import { type BufferGeometry, Group, InstancedMesh, type Material, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { Rng } from '../../core/rng.ts';
import { beachWidth, heightAt, LAGOON_CENTRE, normalAt, shoreDistance } from '../game/terrain.ts';
import type { TreeInstance } from '../game/world.ts';
import { addSway, barkMaterial, leafMaterial } from './foliageMaterials.ts';
import { card, merge, rand, tube } from './meshkit.ts';

// Rainforest trees: pale buttressed trunks, a few limbs, and a broad crown of
// leaf-cluster cards on an ellipsoid shell with normals bent outward. The
// modelled trees fill the slopes around the bay; a cheaper version carpets
// the far hills and the volcano's skirt so ridgelines read as jungle.

const VARIANT_HEIGHTS = [10, 13, 16, 19, 22];

interface TreeParts {
  wood: BufferGeometry;
  leaves: BufferGeometry;
}

function buildTree(H: number, seed: number, cards: number, limbs: number, detailed = true): TreeParts {
  const rng = new Rng(seed);
  const trunkTop = H * 0.62;
  const lean = new Vector3(rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4));
  const pts: Vector3[] = [];
  const radii: number[] = [];
  const baseR = 0.18 + H * 0.014;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new Vector3(lean.x * t * t, trunkTop * t - 0.3, lean.z * t * t));
    radii.push(baseR * (1 - 0.45 * t) + (t < 0.08 ? (0.08 - t) * baseR * 6 : 0));
  }
  const woodParts: BufferGeometry[] = [tube(detailed ? pts : pts.filter((_, i) => i % 3 === 0), detailed ? radii : radii.filter((_, i) => i % 3 === 0), detailed ? 9 : 5, 1.2)];
  // Buttress fins: thin flared roots, typical of rainforest giants.
  for (let b = 0; b < (detailed ? 4 : 0); b++) {
    const a = (b / 4) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = new Vector3(Math.cos(a), 0, Math.sin(a));
    woodParts.push(tube([new Vector3(0, H * 0.09, 0), d.clone().multiplyScalar(baseR * 1.6).setY(H * 0.03), d.clone().multiplyScalar(baseR * 3).setY(-0.2)], [0.05, 0.07, 0.04], 5, 1.2));
  }
  const crown = new Vector3(lean.x, H * 0.74, lean.z);
  const rx = H * 0.34;
  const ry = H * 0.27;
  for (let l = 0; l < limbs; l++) {
    const a = (l / limbs) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const start = new Vector3(lean.x * 0.5, trunkTop * rng.range(0.75, 0.98), lean.z * 0.5);
    const end = crown.clone().add(new Vector3(Math.cos(a) * rx * 0.75, rng.range(-0.1, 0.4) * ry, Math.sin(a) * rx * 0.75));
    const mid = start.clone().lerp(end, 0.5).add(new Vector3(0, H * 0.06, 0));
    woodParts.push(tube([start, mid, end], [baseR * 0.45, baseR * 0.3, baseR * 0.12], detailed ? 6 : 4, 1.2));
  }
  const wood = merge(woodParts, 'tree wood');
  addSway(wood, 0.05, () => 0, H);

  const leafParts: BufferGeometry[] = [];
  const out = new Vector3();
  for (let c = 0; c < cards; c++) {
    // Mostly the upper shell, some fill lower down.
    const u = rng.next();
    const v = rng.range(-0.55, 1);
    const theta = u * Math.PI * 2;
    const phi = Math.acos(v);
    out.set(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    const p = crown.clone().add(new Vector3(out.x * rx * rng.range(0.75, 1.05), out.y * ry * rng.range(0.7, 1.05), out.z * rx * rng.range(0.75, 1.05)));
    const size = H * rng.range(0.15, 0.22);
    const g = card(size, size);
    g.translate(0, -size * 0.15, 0);
    // Stem toward the crown centre, leaf face tilted outward and up.
    g.rotateX(-Math.PI / 2 + rng.range(-0.6, 0.4) - out.y * 0.6);
    g.rotateY(-theta - Math.PI / 2 + rng.range(-0.4, 0.4));
    g.translate(p.x, p.y, p.z);
    bendNormals(g, crown, 0.65);
    leafParts.push(g);
  }
  const leaves = merge(leafParts, 'tree leaves');
  addSway(leaves, 0.05, (x, y, z) => 0.4 + rand(Math.floor(x * 7), Math.floor(z * 7 + y)) * 0.6, H);
  return { wood, leaves };
}

/** Bends card normals toward "away from the crown centre" so the crown shades as one volume. */
function bendNormals(g: BufferGeometry, centre: Vector3, k: number): void {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const v = new Vector3();
  const n = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(centre).normalize();
    n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
    if (n.dot(v) < 0) n.negate();
    n.multiplyScalar(1 - k).addScaledVector(v, k).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
}

export function buildJungle(trees: readonly TreeInstance[], quality: 'high' | 'low'): Group {
  const group = new Group();
  group.name = 'jungle';
  const bark = barkMaterial('jungle');
  const leafA = leafMaterial('broadleaf');
  const leafB = leafMaterial('broadleafDark');
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const s = new Vector3();
  const p = new Vector3();
  const place = (list: readonly TreeInstance[], parts: TreeParts, heightM: number, leaf: Material, shadows: boolean): void => {
    if (list.length === 0) return;
    for (const [geo, mat] of [
      [parts.wood, bark],
      [parts.leaves, leaf],
    ] as const) {
      const mesh = new InstancedMesh(geo, mat, list.length);
      list.forEach((t, i) => {
        q.setFromAxisAngle(up, t.yawRad);
        const k = t.heightM / heightM;
        m.compose(p.set(t.x, t.y, t.z), q, s.set(k, k * (0.9 + (t.seed % 20) / 100), k));
        mesh.setMatrixAt(i, m);
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  };
  VARIANT_HEIGHTS.forEach((H, v) => {
    const list = trees.filter((t) => nearestVariant(t.heightM) === v);
    place(list, buildTree(H, 1000 + v * 77, quality === 'high' ? 130 : 80, 6), H, v % 2 === 0 ? leafA : leafB, true);
  });
  // The far canopy: cheap trees on the hills beyond the bay and the volcano's skirt.
  const far = farTrees(quality === 'high' ? 2600 : 1200);
  place(far.filter((t) => t.seed % 2 === 0), buildTree(16, 5001, 30, 3, false), 16, leafA, false);
  place(far.filter((t) => t.seed % 2 === 1), buildTree(16, 5002, 30, 3, false), 16, leafB, false);
  return group;
}

function nearestVariant(h: number): number {
  let best = 0;
  VARIANT_HEIGHTS.forEach((v, i) => {
    if (Math.abs(v - h) < Math.abs((VARIANT_HEIGHTS[best] as number) - h)) best = i;
  });
  return best;
}

function farTrees(count: number): TreeInstance[] {
  const rng = new Rng(777);
  const out: TreeInstance[] = [];
  const n = { x: 0, y: 1, z: 0 };
  for (let tries = 0; tries < count * 12 && out.length < count; tries++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(215, 1100);
    const x = LAGOON_CENTRE.x + Math.cos(a) * r;
    const z = LAGOON_CENTRE.z + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 3 || y > 300) continue;
    if (shoreDistance(x, z) < beachWidth(x, z) + 4 && y < 8) continue;
    normalAt(x, z, n);
    if (n.y < 0.6) continue;
    out.push({ x, y: y - 0.5, z, heightM: rng.range(12, 22), yawRad: rng.range(0, Math.PI * 2), seed: rng.int(0, 1e6) });
  }
  // The volcano's lower flanks.
  for (let k = 0; k < count * 0.35; k++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(250, 900);
    const x = 420 + Math.cos(a) * r;
    const z = -1250 + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < 4 || y > 230) continue;
    out.push({ x, y: y - 0.5, z, heightM: rng.range(14, 24), yawRad: rng.range(0, Math.PI * 2), seed: rng.int(0, 1e6) });
  }
  return out;
}
