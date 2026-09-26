import * as THREE from 'three';
import { PLAY_HALF, WATER_LEVEL } from '../config';
import { sampleWrap } from '../core/noise';
import { Rng } from '../core/rng';
import { mergeParts } from '../render/geom';
import { stdMat } from '../render/palette';
import { addPatch, addThermalConst, foliageNormalPatch, G, inject, translucencyPatch } from '../render/shaderPatch';
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

/** Wind sway for instanced foliage: bends with height, phase from instance position. */
function windPatch(mat: THREE.Material, strength: number): void {
  addPatch(mat, {
    key: `wind`,
    apply(shader) {
      shader.uniforms.uTime = G.uTime;
      shader.uniforms.uWind = G.uWind;
      shader.uniforms.uWindAmp = { value: strength };
      inject(shader, 'vertex', '#include <common>', 'uniform float uTime; uniform vec2 uWind; uniform float uWindAmp;', 'after');
      inject(
        shader,
        'vertex',
        '#include <begin_vertex>',
        `#ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float ph = ip.x * 0.071 + ip.z * 0.053;
          float bend = pow(max(position.y, 0.0) / 10.0, 1.6) * uWindAmp;
          float gust = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.25;
          transformed.xz += uWind * bend * (0.6 + gust);
        #endif`,
        'after',
      );
    },
  });
}

/** Keep alpha-clipped foliage from thinning out in the distance as mip levels average alpha down. */
const alphaCoveragePatch = {
  key: 'alphaCoverage',
  apply(shader: THREE.WebGLProgramParametersWithUniforms) {
    inject(
      shader,
      'fragment',
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec2 tkTexel = fwidth(vMapUv) * vec2(textureSize(map, 0));
        diffuseColor.a *= 1.0 + 0.28 * max(0.0, log2(max(max(tkTexel.x, tkTexel.y), 1e-3)));
      #endif`,
      'after',
    );
  },
};

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

export class Vegetation {
  readonly group = new THREE.Group();
  readonly trees: Tree[] = [];
  /** spatial hash of tree indices, 16 m cells */
  private grid = new Map<number, number[]>();
  private trunks: THREE.InstancedMesh[] = [];
  private crowns: THREE.InstancedMesh[] = [];
  readonly rocks: { x: number; z: number; r: number }[] = [];
  private dirty = new Set<number>();

  constructor(hf: Heightfield, noise: NoiseSet, seed: number, lite = false) {
    const rng = new Rng(seed);
    // Foliage: alpha-clipped cards (sheet: "alpha-clip + A2C"; no MSAA here, so plain clip),
    // normals kept on back faces, thin-sheet translucency, wind.
    const foliage = (map: THREE.Texture, transl: number) => {
      const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.85, metalness: 0 });
      addPatch(m, foliageNormalPatch);
      addPatch(m, alphaCoveragePatch);
      addPatch(m, translucencyPatch(transl));
      windPatch(m, 0.35);
      addThermalConst(m, 0.05);
      return m;
    };
    const needles = foliage(makeNeedleTexture(seed + 1), 0.3);
    const leaves = foliage(makeLeafTexture(seed + 2), 0.5);
    const barkDark = stdMat('treeBark', { map: makeBarkTexture(seed + 3), color: 0xffffff, vertexColors: true });
    const barkBirch = stdMat('treeBark', { map: makeBarkTexture(seed + 4, true), color: 0xffffff, roughness: 0.8, vertexColors: true });
    for (const b of [barkDark, barkBirch]) {
      windPatch(b, 0.12);
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
    const perVariant: Tree[][] = [[], [], []];
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
      const tm = new THREE.InstancedMesh(g.trunk, kind.bark, Math.max(1, list.length));
      const cm = new THREE.InstancedMesh(g.crown, kind.crown, Math.max(1, list.length));
      tm.count = cm.count = list.length;
      tm.castShadow = cm.castShadow = true;
      cm.userData.noAO = true;
      tm.receiveShadow = cm.receiveShadow = true;
      this.trunks.push(tm);
      this.crowns.push(cm);
      this.group.add(tm, cm);
    }
    // instance slot of each tree inside its variant mesh
    const slot = new Map<Tree, number>();
    for (let v = 0; v < variants; v++) perVariant[v]!.forEach((t, i) => slot.set(t, i));
    this.slotOf = (t) => slot.get(t)!;
    for (const t of this.trees) this.writeTree(t);
    for (const m of [...this.trunks, ...this.crowns]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }

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

  private slotOf: (t: Tree) => number;

  private writeTree(t: Tree): void {
    const i = this.slotOf(t);
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
  }

  update(dt: number): void {
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
