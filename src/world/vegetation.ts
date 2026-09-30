import * as THREE from 'three/webgpu';
import { PLAY_HALF, WATER_LEVEL } from '../config';
import { sampleWrap } from '../core/noise';
import { Rng } from '../core/rng';
import { mergeParts } from '../render/geom';
import { stdMat } from '../render/palette';
import { float, fwidth, hash, instanceIndex, log2, max, normalViewGeometry, positionLocal, pow, sin, texture, uv, vec3 } from 'three/tsl';
import { ditherOutBeyond, ImpostorAtlas, ImpostorField, type ImpostorInstance } from '../render/impostor.ts';
import { addThermalConst, G } from '../render/nodes';
import type { NoiseSet } from '../render/textures';
import { NOISE_SIZE } from '../render/textures';
import type { Heightfield } from './heightfield';
import { SITES } from './layout';
import { broadleafGeometry, coniferGeometry, makeBarkTexture, makeLeafTexture, makeNeedleTexture } from './treeModels';
import { hyp2 } from '../core/mathx';

export interface Tree {
  x: number;
  z: number;
  y: number;
  s: number;
  rot: number;
  variant: number;
  /** 0 standing … 1 flat on the ground */
  fall: number;
  fallDir: number;
  falling: boolean;
}

/** Wind sway for instanced foliage: bends with height (local metres), a phase per instance. */
function windSway(mat: THREE.NodeMaterial, strength: number): void {
  const ph = hash(instanceIndex).mul(40);
  const bend = pow(max(positionLocal.y, 0).div(10), 1.6).mul(strength);
  const gust = sin(G.uTime.mul(1.3).add(ph)).mul(0.6).add(sin(G.uTime.mul(2.9).add(ph.mul(1.7))).mul(0.25));
  const push = G.uWind.mul(bend).mul(gust.add(0.6));
  mat.positionNode = positionLocal.add(vec3(push.x, 0, push.y));
}

/**
 * Alpha-clipped foliage cards: normals kept on back faces (lit like a thin sheet, not black), alpha
 * raised with the mip level so crowns do not thin out in the distance, and — on High — thin-sheet
 * translucency inside the light loop (MeshSSSNodeMaterial, as in Field Line), so only leaves the
 * sun actually reaches glow from behind.
 */
function foliageMaterial(map: THREE.Texture, transl: number, lite: boolean): THREE.MeshStandardNodeMaterial {
  const params = { map, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.85, metalness: 0 };
  const m = lite ? new THREE.MeshStandardNodeMaterial(params) : new THREE.MeshSSSNodeMaterial(params);
  m.normalNode = normalViewGeometry;
  const img = map.image as { width?: number; height?: number } | undefined;
  const size = float(Math.max(img?.width ?? 256, img?.height ?? 256));
  const texel = fwidth(uv()).mul(size);
  m.opacityNode = texture(map).a.mul(max(log2(max(max(texel.x, texel.y), 1e-3)), 0).mul(0.28).add(1));
  if (m instanceof THREE.MeshSSSNodeMaterial) {
    m.thicknessColorNode = texture(map).rgb.mul(vec3(1.1, 1.2, 0.6));
    m.thicknessDistortionNode = float(0.2);
    m.thicknessAmbientNode = float(0);
    m.thicknessAttenuationNode = float(transl);
    m.thicknessPowerNode = float(3);
    m.thicknessScaleNode = float(3 * transl);
  }
  windSway(m, 0.35);
  addThermalConst(m, 0.05);
  return m;
}

function rockGeometry(rng: Rng): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const seedA = rng.next() * 10;
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k);
    const y = p.getY(k);
    const z = p.getZ(k);
    const d = 1 + 0.22 * Math.sin(x * 3.1 + seedA) * Math.cos(z * 2.7 + seedA) + 0.12 * Math.sin(y * 5.3 + seedA * 2);
    p.setXYZ(k, x * d * 1.25, Math.max(-0.3, y * d * 0.7), z * d);
  }
  g.computeVertexNormals();
  return mergeParts([g]);
}

/** Grid cell (m) on which the near trees and the impostors are refilled. */
const LOD_CELL_M = 32;

export class Vegetation {
  readonly group = new THREE.Group();
  readonly trees: Tree[] = [];
  /** spatial hash of tree indices, 16 m cells */
  private grid = new Map<number, number[]>();
  private trunks: THREE.InstancedMesh[] = [];
  private crowns: THREE.InstancedMesh[] = [];
  readonly rocks: { x: number; z: number; r: number }[] = [];
  private dirty = new Set<number>();
  /** each variant's trees, and which instance slot a tree holds while it is near (−1: not drawn as a mesh) */
  private readonly perVariant: Tree[][] = [[], [], []];
  private readonly slot = new Map<Tree, number>();
  private readonly kinds: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; bark: THREE.NodeMaterial; crownMat: THREE.NodeMaterial }[] = [];
  private impostors: ImpostorField | null = null;
  private readonly impostorOf = new Map<Tree, ImpostorInstance>();
  private nearM = Infinity;
  private lodCell = Number.NaN;

  constructor(hf: Heightfield, noise: NoiseSet, seed: number, lite = false) {
    const rng = new Rng(seed);
    // Foliage: alpha-clipped cards (sheet: "alpha-clip + A2C"; no MSAA here, so plain clip).
    const needles = foliageMaterial(makeNeedleTexture(seed + 1), 0.3, lite);
    const leaves = foliageMaterial(makeLeafTexture(seed + 2), 0.5, lite);
    const barkDark = stdMat('treeBark', { map: makeBarkTexture(seed + 3), color: 0xffffff, vertexColors: true });
    const barkBirch = stdMat('treeBark', { map: makeBarkTexture(seed + 4, true), color: 0xffffff, roughness: 0.8, vertexColors: true });
    for (const b of [barkDark, barkBirch]) {
      windSway(b, 0.12);
      addThermalConst(b, 0.07);
    }
    const kinds = [
      { geo: () => coniferGeometry(rng, 13, lite), crown: needles, bark: barkDark },
      { geo: () => coniferGeometry(rng, 18, lite), crown: needles, bark: barkDark },
      { geo: () => broadleafGeometry(rng, 12, lite), crown: leaves, bark: barkBirch },
    ];

    // --- scatter trees in forest patches
    const macro = (x: number, z: number) => sampleWrap(noise.r, NOISE_SIZE, x / 1100, z / 1100);
    const mid = (x: number, z: number) => sampleWrap(noise.g, NOISE_SIZE, x / 64, z / 64);
    const nrm = { x: 0, y: 1, z: 0 };
    const variants = 3;
    const perVariant = this.perVariant;
    const lim = PLAY_HALF + 120;
    for (let attempt = 0; attempt < 60000 && this.trees.length < 5200; attempt++) {
      const x = rng.range(-lim, lim);
      const z = rng.range(-lim, lim);
      const forest = sampleWrap(noise.g, NOISE_SIZE, x / 380 + 0.3, z / 380) * 0.7 + macro(x, z) * 0.3;
      const density = smooth(0.5, 0.64, forest) + 0.04;
      if (rng.next() > density) continue;
      const y = hf.heightAt(x, z);
      if (y < WATER_LEVEL + 1.5) continue;
      hf.normalAt(x, z, nrm);
      if (nrm.y < 0.82) continue;
      if (hf.roadAt(x, z) > 0.02) continue;
      if (SITES.some((s) => hyp2(x - s.x, z - s.z) < s.r * 0.9)) continue;
      if (mid(x, z) > 0.8) continue;
      const variant = rng.next() < 0.22 ? 2 : rng.next() < 0.5 ? 0 : 1;
      const t: Tree = { x, z, y: y - 0.2, s: rng.range(0.75, 1.3), rot: rng.next() * Math.PI * 2, variant, fall: 0, fallDir: 0, falling: false };
      const idx = this.trees.length;
      this.trees.push(t);
      perVariant[t.variant]!.push(t);
      const key = cellKey(x, z);
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(idx);
    }
    for (let v = 0; v < variants; v++) {
      const kind = kinds[v]!;
      const g = kind.geo();
      const list = perVariant[v]!;
      // Until the impostors are baked (initImpostors) every tree is near; afterwards only those
      // within the LOD radius hold a slot, refilled on a 32 m grid.
      const tm = new THREE.InstancedMesh(g.trunk, kind.bark, Math.max(1, list.length));
      const cm = new THREE.InstancedMesh(g.crown, kind.crown, Math.max(1, list.length));
      tm.count = cm.count = 0;
      tm.castShadow = cm.castShadow = true;
      tm.receiveShadow = cm.receiveShadow = true;
      tm.frustumCulled = cm.frustumCulled = false;
      this.trunks.push(tm);
      this.crowns.push(cm);
      this.kinds.push({ trunk: g.trunk, crown: g.crown, bark: kind.bark, crownMat: kind.crown });
      this.group.add(tm, cm);
    }
    this.refill(null);

    // --- rocks and boulders
    const rockMat = stdMat('rock');
    addThermalConst(rockMat, 0.11);
    const rockVariants = [rockGeometry(rng), rockGeometry(rng), rockGeometry(rng)];
    const rockLists: THREE.Matrix4[][] = [[], [], []];
    for (let attempt = 0; attempt < 20000 && this.rocks.length < 900; attempt++) {
      const x = rng.range(-lim, lim);
      const z = rng.range(-lim, lim);
      const y = hf.heightAt(x, z);
      hf.normalAt(x, z, nrm);
      const steep = 1 - nrm.y;
      const p = 0.03 + smooth(0.12, 0.3, steep) * 0.6;
      if (rng.next() > p) continue;
      if (hf.roadAt(x, z) > 0.02 || y < WATER_LEVEL - 1) continue;
      if (SITES.some((s) => hyp2(x - s.x, z - s.z) < s.r * 0.8)) continue;
      const big = rng.next() < 0.12;
      const r = big ? rng.range(1.6, 3.2) : rng.range(0.25, 0.9);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y - r * 0.25, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.3, 0.3), rng.next() * 6.28, rng.range(-0.3, 0.3))),
        new THREE.Vector3(r, r * rng.range(0.7, 1.1), r * rng.range(0.8, 1.2)),
      );
      rockLists[rng.int(0, 2)]!.push(m);
      if (big) this.rocks.push({ x, z, r: r * 1.1 });
    }
    rockVariants.forEach((g, i) => {
      const list = rockLists[i]!;
      const im = new THREE.InstancedMesh(g, rockMat, Math.max(1, list.length));
      im.count = list.length;
      list.forEach((m, k) => im.setMatrixAt(k, m));
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    });
  }

  /**
   * Bake the three species into an impostor atlas and draw every tree beyond `nearM` as one quad
   * of a single instanced draw (render/impostor.ts, shared with anbow1/FPS). The full meshes
   * dissolve over the band before `nearM` while the impostors dissolve in; only the near trees
   * cast shadows, so the cascades no longer draw the whole forest.
   */
  initImpostors(renderer: THREE.WebGPURenderer, nearM: number, fadeM: number, framePx: number): void {
    const sources = this.kinds.map((k) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(k.trunk, k.bark), new THREE.Mesh(k.crown, k.crownMat));
      return g;
    });
    const atlas = new ImpostorAtlas(renderer, sources, { views: 8, framePx });
    const inst: ImpostorInstance[] = [];
    this.perVariant.forEach((list, v) =>
      list.forEach((t) => {
        const i: ImpostorInstance = { x: t.x, y: t.y, z: t.z, yawRad: t.rot, scale: t.s, species: v, hidden: t.fall > 0 || t.falling };
        inst.push(i);
        this.impostorOf.set(t, i);
      }),
    );
    this.impostors = new ImpostorField(atlas, inst, { nearM, fadeM, cellM: LOD_CELL_M });
    addThermalConst(this.impostors.material, 0.05);
    this.group.add(this.impostors.mesh);
    // the two conifers share their materials: dissolve each material once
    for (const m of new Set(this.kinds.flatMap((k) => [k.bark, k.crownMat]))) ditherOutBeyond(m, nearM - fadeM, nearM);
    this.nearM = nearM;
    this.lodCell = Number.NaN;
  }

  /** Near trees into the meshes (and felled ones, wherever they lie); the rest are impostors. */
  private refill(camera: THREE.Vector3 | null): void {
    const r = this.nearM + LOD_CELL_M * 1.42;
    const r2 = r * r;
    this.slot.clear();
    this.perVariant.forEach((list, v) => {
      let k = 0;
      for (const t of list) {
        const near = !camera || t.fall > 0 || t.falling || (t.x - camera.x) ** 2 + (t.z - camera.z) ** 2 < r2;
        if (!near) continue;
        this.slot.set(t, k++);
        this.writeTree(t);
      }
      this.trunks[v]!.count = this.crowns[v]!.count = k;
      this.dirty.add(v);
    });
  }

  private writeTree(t: Tree): void {
    const i = this.slot.get(t);
    if (i === undefined) return;
    _q.setFromAxisAngle(_up, t.rot);
    if (t.fall > 0) {
      _axis.set(Math.cos(t.fallDir), 0, -Math.sin(t.fallDir));
      _q2.setFromAxisAngle(_axis, t.fall * Math.PI * 0.47);
      _q.premultiply(_q2);
    }
    _p.set(t.x, t.y, t.z);
    _s.setScalar(t.s);
    _m.compose(_p, _q, _s);
    this.trunks[t.variant]!.setMatrixAt(i, _m);
    this.crowns[t.variant]!.setMatrixAt(i, _m);
    this.dirty.add(t.variant);
  }

  /** Trees within radius of a point (for vehicle collisions). */
  query(x: number, z: number, r: number, out: number[]): number[] {
    out.length = 0;
    const c0 = Math.floor((x - r) / 16);
    const c1 = Math.floor((x + r) / 16);
    const d0 = Math.floor((z - r) / 16);
    const d1 = Math.floor((z + r) / 16);
    for (let i = c0; i <= c1; i++) {
      for (let j = d0; j <= d1; j++) {
        const list = this.grid.get(i * 100003 + j);
        if (!list) continue;
        for (const k of list) {
          const t = this.trees[k]!;
          if (t.fall === 0 && !t.falling && (t.x - x) ** 2 + (t.z - z) ** 2 < r * r) out.push(k);
        }
      }
    }
    return out;
  }

  /** Knock a tree over in the direction the vehicle is pushing (dx,dz). */
  knock(k: number, dx: number, dz: number): void {
    const t = this.trees[k]!;
    if (t.falling || t.fall > 0) return;
    t.falling = true;
    t.fallDir = Math.atan2(dx, dz);
    // a felled tree stays a mesh wherever it lies: the impostors only know standing trees
    const imp = this.impostorOf.get(t);
    if (imp) {
      imp.hidden = true;
      this.impostors?.refresh();
    }
    if (!this.slot.has(t)) this.lodCell = Number.NaN;
  }

  update(dt: number, camera: THREE.Vector3): void {
    const cell = Math.floor(camera.x / LOD_CELL_M) * 100003 + Math.floor(camera.z / LOD_CELL_M);
    if (cell !== this.lodCell && Number.isFinite(this.nearM)) {
      this.lodCell = cell;
      const c = new THREE.Vector3((Math.floor(camera.x / LOD_CELL_M) + 0.5) * LOD_CELL_M, 0, (Math.floor(camera.z / LOD_CELL_M) + 0.5) * LOD_CELL_M);
      this.refill(c);
    }
    this.impostors?.update(camera);
    for (const t of this.trees) {
      if (!t.falling) continue;
      t.fall = Math.min(1, t.fall + dt * (0.3 + t.fall * 2.6));
      if (t.fall >= 1) t.falling = false;
      this.writeTree(t);
    }
    for (const v of this.dirty) {
      this.trunks[v]!.instanceMatrix.needsUpdate = true;
      this.crowns[v]!.instanceMatrix.needsUpdate = true;
    }
    this.dirty.clear();
  }
}

function cellKey(x: number, z: number): number {
  return Math.floor(x / 16) * 100003 + Math.floor(z / 16);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
