import { attribute, cameraPosition, positionLocal, sin, smoothstep, time, uniform, vec2, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, Color, CylinderGeometry, Group, type Material, Matrix4, type MeshStandardNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { InstanceStream, type StreamPlacement } from './instanceStream.ts';
import type { TreeInstance } from '../maps/types.ts';
import { cloneMaterial, type MaterialLibrary } from './materials.ts';
import { card, indexed, merge, rand } from './meshkit.ts';

// Instanced pines and shrubs, one streamed mesh per part (see
// instanceStream.ts) with two levels of detail:
// full crowns (two cards per branch, a dozen whorls) near the player, a light
// crown of big cards beyond, which keeps the forest's triangle count, and its
// shadow passes, inside a phone's budget. Every plant sways with the same
// wind vector that drifts bullets (brief): one uniform, fed from game.wind.

/** World wind in m/s, set by the view each frame from the game's wind. */
export const windVector = uniform(new Vector3());

/** Distances (m) at which crowns switch to the light version and small plants disappear, per quality. */
export const FOLIAGE_LOD = {
  nearCrownM: { high: 110, low: 60 },
  shrubM: { high: 220, low: 120 },
} as const;

/**
 * Crown of unit height. Branches leave the trunk in whorls, drooping more
 * lower down and shortening toward the top; each is a needle-spray card, and
 * in the full crown a second card rolled about the branch so the crown has
 * volume from the side instead of stacking flat plates. Normals point away
 * from the crown's axis (a standard foliage trick) so it shades as a cone.
 */
function pineCrown(whorls: number, perWhorl: number, crossed: boolean, sizeK: number, seed: number): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const along = new Vector3();
  const across = new Vector3();
  const up = new Vector3();
  const corner = new Vector3();
  const n = new Vector3();
  const addCard = (y: number, dir: Vector3, lengthM: number, widthM: number, droop: number, roll: number): void => {
    along.set(dir.x * Math.cos(droop), -Math.sin(droop), dir.z * Math.cos(droop));
    // Across the branch, rolled about it by `roll`.
    const flat = new Vector3(-dir.z, 0, dir.x);
    up.crossVectors(flat, along).normalize();
    across.copy(flat).multiplyScalar(Math.cos(roll)).addScaledVector(up, Math.sin(roll));
    const base = pos.length / 3;
    const corners: [number, number, number, number][] = [
      [0, -0.5, 0, 0],
      [0, 0.5, 1, 0],
      [1, 0.35, 1, 1],
      [1, -0.35, 0, 1],
    ];
    for (const [t, s, u, v] of corners) {
      corner.set(0, y, 0).addScaledVector(along, lengthM * t).addScaledVector(across, widthM * s);
      pos.push(corner.x, corner.y, corner.z);
      n.set(corner.x, (corner.y - y) + 0.12, corner.z).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const dir = new Vector3();
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y = 0.3 + t * 0.64;
    const lengthM = (0.22 * (1 - t * 0.85) + 0.02) * sizeK;
    const droop = 0.25 + (1 - t) * 0.35;
    for (let k = 0; k < perWhorl; k++) {
      const a = ((k + rand(seed, w * 31 + k) * 0.5) / perWhorl) * Math.PI * 2 + w * 1.3;
      dir.set(Math.cos(a), 0, Math.sin(a));
      const l = lengthM * (0.85 + rand(seed + 1, w * 31 + k) * 0.3);
      const yy = y + (rand(seed + 2, w * 31 + k) - 0.5) * 0.03;
      addCard(yy, dir, l, l * 0.85, droop, (rand(seed + 3, w * 31 + k) - 0.5) * 0.4);
      if (crossed) addCard(yy + 0.01, dir, l * 0.9, l * 0.55, droop + 0.1, 1.2);
    }
  }
  // Leader: two crossed upright sprays at the top.
  for (let i = 0; i < 2; i++) {
    const g = card(0.06 * sizeK, 0.12).rotateY((i * Math.PI) / 2).translate(0, 0.88, 0);
    const p = g.getAttribute('position');
    const base = pos.length / 3;
    for (let j = 0; j < p.count; j++) {
      pos.push(p.getX(j), p.getY(j), p.getZ(j));
      n.set(p.getX(j), 0.3, p.getZ(j)).normalize();
      nor.push(n.x, n.y, n.z);
    }
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = indexed(pos, nor, uv, idx);
  addSway(g);
  return g;
}

function pineTrunk(): BufferGeometry {
  const g = new CylinderGeometry(0.004, 0.018, 1, 7, 1, true).translate(0, 0.5, 0);
  addSway(g);
  return g;
}

/** Broadleaf shrub: leaf-spray cards arranged over a dome, facing outward. Unit ≈ 1.1 m tall. */
function shrubGeometry(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let c = 0; c < 14; c++) {
    const theta = rand(seed, c) * Math.PI * 2;
    const v = rand(seed, c + 30) * 1.3 - 0.3;
    const phi = Math.acos(Math.max(-1, Math.min(1, v)));
    const out = new Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    const g = card(1.1, 1.1);
    g.rotateX(-Math.PI / 2 - out.y * 0.8 + 0.3);
    g.rotateY(-theta - Math.PI / 2);
    g.translate(out.x * 0.45, Math.max(0.1, 0.65 + out.y * 0.35), out.z * 0.45);
    parts.push(g);
  }
  const g = merge(parts, 'shrub');
  // Leaves point away from the dome's centre so the shrub shades as a mound.
  const p = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const d = new Vector3();
  for (let i = 0; i < p.count; i++) {
    d.set(p.getX(i), p.getY(i) - 0.45, p.getZ(i)).normalize();
    nrm.setXYZ(i, d.x, d.y, d.z);
  }
  addSway(g);
  return g;
}

/** Sway weight: 0 at the base, rising with the square of height. */
export function addSway(g: BufferGeometry): void {
  const pos = g.getAttribute('position');
  const sway = new Float32Array(pos.count);
  let maxY = 0;
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
  for (let i = 0; i < pos.count; i++) sway[i] = (Math.max(0, pos.getY(i)) / maxY) ** 2;
  g.setAttribute('sway', new BufferAttribute(sway, 1));
}

/**
 * Wind-driven vertex offset, applied after instancing (positionLocal is world
 * here). With `sinkBeyondM`, small plants also sink into the ground as they
 * near the end of their draw distance, so they never pop out of view.
 */
export function swayingMaterial(base: Material, amplitudePerMs: number, sinkBeyondM?: [number, number, number]): MeshStandardNodeMaterial {
  const m = cloneMaterial(base) as MeshStandardNodeMaterial;
  const w = attribute('sway', 'float');
  const p = positionLocal;
  const phase = p.x.mul(0.07).add(p.z.mul(0.05));
  // Gusts: a slow push with the wind plus a faster flutter across it.
  const push = sin(time.mul(0.9).add(phase)).mul(0.5).add(0.6);
  const flutter = sin(time.mul(3.1).add(phase.mul(3)));
  const across = vec3(windVector.z.negate(), 0, windVector.x);
  let out = p.add(windVector.mul(push.mul(amplitudePerMs).mul(w))).add(across.mul(flutter.mul(amplitudePerMs * 0.3).mul(w)));
  if (sinkBeyondM) {
    const [from, to, depthM] = sinkBeyondM;
    const d = vec2(p.x, p.z).sub(vec2(cameraPosition.x, cameraPosition.z)).length();
    out = out.sub(vec3(0, smoothstep(from, to, d).mul(depthM), 0));
  }
  m.positionNode = out;
  return m;
}

/** Grid cell (m) the streamed tree and shrub meshes refill on. */
const CELL_M = 32;

export class Foliage {
  readonly group = new Group();
  private readonly streams: InstanceStream[] = [];

  constructor(trees: readonly TreeInstance[], bushes: readonly TreeInstance[], lib: MaterialLibrary, quality: 'high' | 'low') {
    this.group.name = 'foliage';
    if (trees.length === 0 && bushes.length === 0) return;
    const nearM = FOLIAGE_LOD.nearCrownM[quality];
    const shrubM = FOLIAGE_LOD.shrubM[quality];
    const nearCrown = pineCrown(12, 8, true, 1, 11);
    const farCrown = pineCrown(4, 5, false, 1.15, 23);
    const trunk = pineTrunk();
    const shrubs = [shrubGeometry(5), shrubGeometry(17)];
    const needles = swayingMaterial(lib.get('needles'), 0.18);
    const bark = swayingMaterial(lib.get('pineBark'), 0.08);
    const shrubMats = [swayingMaterial(lib.get('hazel'), 0.06), swayingMaterial(lib.get('buckthorn'), 0.06)];

    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const place = (list: readonly TreeInstance[], sink: number, tint: (seed: number) => Color): StreamPlacement[] =>
      list.map((t) => {
        q.setFromAxisAngle(up, t.yawRad);
        const w = t.heightM * (0.85 + ((t.seed % 97) / 97) * 0.3);
        return { matrix: new Matrix4().compose(new Vector3(t.pos.x, t.pos.y - sink, t.pos.z), q, new Vector3(w, t.heightM, w)), colour: tint(t.seed) };
      });
    // Per-tree tint: some crowns yellower, some bluer, some darker, as in a real stand.
    const crownTint = (seed: number): Color => {
      const h = rand(seed, 1);
      const k = 0.82 + rand(seed, 2) * 0.3;
      return new Color((0.92 + h * 0.16) * k, k, (1.08 - h * 0.2) * k);
    };
    const crowns = place(trees, 0.3, crownTint);
    const add = (stream: InstanceStream): void => {
      this.streams.push(stream);
      this.group.add(stream.mesh);
    };
    if (trees.length > 0) {
      add(new InstanceStream(trunk, bark, place(trees, 0.3, (seed) => new Color().setScalar(0.8 + rand(seed, 3) * 0.35)), { cellM: CELL_M, radiusM: Infinity, castShadow: true }));
      add(new InstanceStream(nearCrown, needles, crowns, { cellM: CELL_M, radiusM: nearM, castShadow: true }));
      add(new InstanceStream(farCrown, needles, crowns, { cellM: CELL_M, radiusM: nearM, outside: true, castShadow: quality === 'high' }));
    }
    for (let v = 0; v < shrubs.length; v++) {
      const list = bushes.filter((b) => b.seed % shrubs.length === v);
      if (list.length === 0) continue;
      const placements = place(list, 0.08, (seed) => new Color().setScalar(0.85 + rand(seed, 4) * 0.3));
      add(new InstanceStream(shrubs[v] as BufferGeometry, shrubMats[v] as Material, placements, { cellM: CELL_M, radiusM: shrubM, castShadow: quality === 'high' }));
    }
  }

  /** Refills the near/far crown and shrub sets when the camera crosses into another cell. */
  update(camera: Vector3): void {
    for (const s of this.streams) s.update(camera);
  }
}
