import { type BufferGeometry, Group, InstancedMesh, Matrix4, type Material, Quaternion, SphereGeometry, Vector3 } from 'three/webgpu';
import { type PalmInstance, PALM_VARIANTS } from '../game/world.ts';
import { addSway, barkMaterial, leafMaterial, swayingSolid } from './foliageMaterials.ts';
import { foldedStrip, merge, rand, tube } from './meshkit.ts';

// Coconut palms, one modelled shape per variant (height and lean), instanced
// and uniformly scaled per tree. The trunk leans toward +Z and curves back up
// under the crown; fronds are folded two-rank strips arching out and down,
// with two dead ones hanging brown against the trunk and a cluster of nuts.

const FRONDS = 16;
const SEGMENTS = 14;
const TRUNK_BEND_PER_M = 0.1;

interface PalmParts {
  trunk: BufferGeometry;
  crown: BufferGeometry;
  dead: BufferGeometry;
  nuts: BufferGeometry;
}

function buildVariant(index: number): PalmParts {
  const { heightM: H, leanRad } = PALM_VARIANTS[index] as (typeof PALM_VARIANTS)[number];
  const topY = Math.cos(leanRad) * H;
  const topZ = Math.sin(leanRad) * H * 0.8; // matches trunkTop() in the logic
  const pts: Vector3[] = [];
  const radii: number[] = [];
  const n = 36;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const wobble = Math.sin(t * 9 + index) * 0.03 * t;
    pts.push(new Vector3(wobble, topY * t, topZ * (2 * t - t * t)));
    const flare = t < 0.06 ? (0.06 - t) * 2.2 : 0;
    radii.push(0.17 - 0.05 * t + flare + 0.012 * Math.sin(t * 60));
  }
  const top = pts[n] as Vector3;
  // Crownshaft: the fibrous knob the fronds grow from.
  const knob = tube([top.clone().add(new Vector3(0, -0.5, 0)), top.clone().add(new Vector3(0, -0.2, 0)), top.clone().add(new Vector3(0, 0.15, 0)), top.clone().add(new Vector3(0, 0.3, 0))], [0.14, 0.2, 0.17, 0.05], 10, 0.6, true);
  const trunk = merge([tube(pts, radii, 12, 0.6), knob], 'palm trunk');
  addSway(trunk, TRUNK_BEND_PER_M, () => 0, topY);

  const fronds: BufferGeometry[] = [];
  const dead: BufferGeometry[] = [];
  const crownCentre = top.clone().add(new Vector3(0, 0.2, 0));
  for (let f = 0; f < FRONDS + 2; f++) {
    const isDead = f >= FRONDS;
    const r1 = rand(index * 100 + f, 1);
    const r2 = rand(index * 100 + f, 2);
    const azimuth = isDead ? r1 * Math.PI * 2 : (f / FRONDS) * Math.PI * 2 + r1 * 0.3;
    // Young fronds stand up, old ones droop: spread the start elevations across the crown.
    const age = isDead ? 1 : ((f * 7) % FRONDS) / FRONDS;
    const elev = isDead ? -1.2 : 0.95 - age * 1.25 + r2 * 0.15;
    const L = isDead ? 2.6 : 3.3 + r2 * 1.1 - Math.max(0, 0.4 - age) * 1.2;
    const droop = isDead ? 0.15 : 0.35 + age * 0.55;
    const h = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const spine: Vector3[] = [];
    const sides: Vector3[] = [];
    const halfW: number[] = [];
    const fold: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS;
      const p = top.clone().add(new Vector3(0, 0.22, 0));
      p.addScaledVector(h, L * s * Math.cos(elev) + (isDead ? 0.1 : 0));
      p.y += L * s * Math.sin(elev) - droop * L * s * s;
      spine.push(p);
      sides.push(new Vector3(-h.z, 0, h.x));
      halfW.push(isDead ? 0.28 : 0.72);
      fold.push(isDead ? 1.1 : 0.42 + s * 0.35);
    }
    const g = foldedStrip(spine, sides, halfW, fold, crownCentre, 0.45);
    (isDead ? dead : fronds).push(g);
  }
  const crown = merge(fronds, 'palm crown');
  const flutter = (x: number, _y: number, z: number): number => Math.min(1, Math.hypot(x - top.x, z - top.z) / 4) ** 1.3;
  addSway(crown, TRUNK_BEND_PER_M, flutter, topY);
  const deadG = merge(dead, 'palm dead fronds');
  addSway(deadG, TRUNK_BEND_PER_M, flutter, topY);

  const nutParts: BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + index;
    const s = new SphereGeometry(0.11, 10, 8);
    s.scale(1, 1.15, 1);
    s.translate(top.x + Math.cos(a) * 0.2, top.y - 0.1 - rand(k, index) * 0.12, top.z + Math.sin(a) * 0.2);
    nutParts.push(s);
  }
  const nuts = merge(nutParts, 'coconuts');
  addSway(nuts, TRUNK_BEND_PER_M, () => 0, topY);
  return { trunk, crown, dead: deadG, nuts };
}

export function buildPalms(palms: readonly PalmInstance[]): Group {
  const group = new Group();
  group.name = 'palms';
  const bark = barkMaterial('palm');
  const leaf = leafMaterial('palm');
  const deadLeaf = leafMaterial('palm', true, true);
  const nut = swayingSolid(0x5e5a2a, 0.55);
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const s = new Vector3();
  const p = new Vector3();
  for (let v = 0; v < PALM_VARIANTS.length; v++) {
    const list = palms.filter((t) => t.variant === v);
    if (list.length === 0) continue;
    const parts = buildVariant(v);
    const shape = PALM_VARIANTS[v] as (typeof PALM_VARIANTS)[number];
    const add = (geo: BufferGeometry, mat: Material, shadows: boolean): void => {
      const mesh = new InstancedMesh(geo, mat, list.length);
      list.forEach((t, i) => {
        q.setFromAxisAngle(up, t.leanDirRad);
        const k = t.heightM / shape.heightM;
        m.compose(p.set(t.x, t.y - 0.15, t.z), q, s.set(k, k, k));
        mesh.setMatrixAt(i, m);
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    add(parts.trunk, bark, true);
    add(parts.crown, leaf, true);
    add(parts.dead, deadLeaf, true);
    add(parts.nuts, nut, false);
  }
  return group;
}
