import * as THREE from 'three';
import { HEIGHT_CELL, WATER_LEVEL, WORLD_SIZE } from '../config';
import { linear, PBR } from '../render/palette';
import { addPatch, inject, thermalPatch } from '../render/shaderPatch';
import type { GroundLayers } from '../render/groundTextures';
import type { NoiseSet } from '../render/textures';
import { makeRoadTexture } from '../render/textures';
import type { Heightfield } from './heightfield';

const CHUNK_CELLS = 64; // 128 m chunks
const LOD_STEPS = [1, 2, 4, 8, 16];
const LOD_DIST = [170, 380, 760, 1400];

/**
 * Terrain PBR material. Layer choice follows the material sheet — fresh/dry grass, dry soil, rock
 * on slopes (no stretch), wet mud at the shoreline, dirt roads — and each layer is a generated
 * close-range texture (albedo + height + normal). Layers are height-blended, so pebbles and tufts
 * poke through the neighbouring layer instead of cross-fading, and sampled with stochastic tiling
 * (after Inigo Quilez) so the 2–4 m tiles never repeat visibly. `NOTILE 0` is the cheap path.
 */
export function terrainMaterial(noise: NoiseSet, roadTex: THREE.Texture, ground: GroundLayers, fancy: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.defines = { NOTILE: fancy ? 1 : 0 };
  const uniforms = {
    tNoise: { value: noise.texture },
    tGrad: { value: noise.gradient },
    tRoad: { value: roadTex },
    tLayers: { value: ground.albedo },
    tLayerN: { value: ground.normal },
    uWorld: { value: new THREE.Vector2(WORLD_SIZE / 2, WORLD_SIZE + HEIGHT_CELL) },
    cDryTint: { value: new THREE.Vector3(linear(PBR.grassDry.color).r / linear(PBR.grassFresh.color).r, linear(PBR.grassDry.color).g / linear(PBR.grassFresh.color).g, linear(PBR.grassDry.color).b / linear(PBR.grassFresh.color).b) },
    cSand: { value: linear(PBR.sand.color) },
    uWater: { value: WATER_LEVEL },
  };
  addPatch(mat, {
    key: 'terrain2',
    apply(shader) {
      Object.assign(shader.uniforms, uniforms);
      inject(shader, 'vertex', '#include <common>', 'varying vec3 vTPos;\nvarying vec3 vTNrm;', 'after');
      inject(shader, 'vertex', '#include <begin_vertex>', 'vTPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvTNrm = normal;', 'after');
      inject(
        shader,
        'fragment',
        '#include <common>',
        `varying vec3 vTPos; varying vec3 vTNrm;
         uniform sampler2D tNoise, tGrad, tRoad;
         uniform highp sampler2DArray tLayers, tLayerN;
         uniform vec2 uWorld;
         uniform vec3 cDryTint, cSand;
         uniform float uWater;
         float tkRockMask; float tkWet; float tkRoad; float tkFine;
         vec3 tkNrmW;
         // stochastic tiling: two offset lookups per layer, blended on a low-frequency index
         void tkSample(float layer, vec2 uv, float idx, out vec4 a, out vec4 n) {
           vec2 dx = dFdx(uv), dy = dFdy(uv);
         #if NOTILE
           float l = idx * 8.0; float ia = floor(l); float f = fract(l);
           vec2 oa = sin(vec2(3.0, 7.0) * ia), ob = sin(vec2(3.0, 7.0) * (ia + 1.0));
           vec4 a0 = textureGrad(tLayers, vec3(uv + oa, layer), dx, dy), a1 = textureGrad(tLayers, vec3(uv + ob, layer), dx, dy);
           vec4 n0 = textureGrad(tLayerN, vec3(uv + oa, layer), dx, dy), n1 = textureGrad(tLayerN, vec3(uv + ob, layer), dx, dy);
           float m = smoothstep(0.2, 0.8, f - 0.1 * dot(a0.rgb - a1.rgb, vec3(1.0)));
           a = mix(a0, a1, m); n = mix(n0, n1, m);
         #else
           a = textureGrad(tLayers, vec3(uv, layer), dx, dy);
           n = textureGrad(tLayerN, vec3(uv, layer), dx, dy);
         #endif
         }`,
        'after',
      );
      inject(
        shader,
        'fragment',
        '#include <map_fragment>',
        `vec2 wp = vTPos.xz;
         vec3 nW = normalize(vTNrm);
         float macro = texture2D(tNoise, wp / 1100.0).r;
         float macro2 = texture2D(tNoise, wp / 380.0 + 0.3).g;
         float mid = texture2D(tNoise, wp / 64.0).g;
         tkFine = texture2D(tNoise, wp / 5.5).b;
         float idx = texture2D(tNoise, wp / 170.0).g;
         float slope = 1.0 - nW.y;
         float dry = smoothstep(0.4, 0.66, macro * 0.7 + macro2 * 0.3 + (mid - 0.5) * 0.3);
         tkRoad = texture2D(tRoad, (wp + uWorld.x) / uWorld.y).r;
         tkWet = 1.0 - smoothstep(0.2, 2.4, vTPos.y - uWater + (tkFine - 0.5) * 0.8);
         float beach = (1.0 - smoothstep(1.2, 3.5, vTPos.y - uWater)) * (1.0 - tkWet);
         tkRockMask = smoothstep(0.24, 0.36, slope + (mid - 0.5) * 0.14 + (macro2 - 0.5) * 0.06);
         // bare soil: small scattered patches, worn banks on moderate slopes, roads
         float soilW = smoothstep(0.74, 0.86, mid + (tkFine - 0.5) * 0.4 + dry * 0.06);
         soilW = max(soilW, smoothstep(0.15, 0.24, slope) * 0.7);
         soilW = max(soilW, smoothstep(0.05, 0.5, tkRoad));
         soilW = max(soilW, beach * 0.8);
         // layer weights: meadow, soil, rock, mud
         vec4 w = vec4(1.0 - soilW, soilW, 0.0, 0.0);
         w = mix(w, vec4(0.0, 0.0, 1.0, 0.0), tkRockMask);
         w = mix(w, vec4(0.0, 0.0, 0.0, 1.0), tkWet);
         vec4 aG = vec4(0.0), aS = vec4(0.0), aR = vec4(0.0), aM = vec4(0.0);
         vec4 nG = vec4(0.5, 0.5, 1.0, 1.0), nS = nG, nR = nG, nM = nG;
         if (w.x > 0.01) tkSample(0.0, wp / 2.2, idx, aG, nG);
         if (w.y > 0.01) tkSample(1.0, wp / 1.7, idx, aS, nS);
         if (w.z > 0.01) {
           // rock on slopes: sample on the plane facing the slope so the pattern does not stretch
           vec3 an = abs(nW);
           vec2 ruv = an.x > an.z ? vTPos.zy : vTPos.xy;
           ruv = mix(ruv, wp, smoothstep(0.55, 0.8, an.y)) / 3.5;
           tkSample(2.0, ruv, idx, aR, nR);
         }
         if (w.w > 0.01) tkSample(3.0, wp / 2.5, idx, aM, nM);
         // height blend: the taller texel of the neighbouring layers wins the transition
         vec4 hw = w * (vec4(aG.a, aS.a, aR.a, aM.a) + 0.35);
         float hm = max(max(hw.x, hw.y), max(hw.z, hw.w)) - 0.18;
         hw = max(hw - hm, 0.0);
         hw /= max(hw.x + hw.y + hw.z + hw.w, 1e-4);
         vec3 grassCol = aG.rgb * mix(vec3(1.0), cDryTint, dry) * (0.85 + 0.3 * macro2);
         vec3 soilCol = aS.rgb * mix(vec3(1.0), cSand / max(aS.rgb, vec3(0.02)) * 0.5, beach * 0.35) * (1.0 - 0.2 * smoothstep(0.55, 0.95, tkRoad));
         vec3 col = grassCol * hw.x + soilCol * hw.y + aR.rgb * hw.z + aM.rgb * hw.w;
         col *= 0.9 + 0.2 * macro;
         float ao = dot(hw, vec4(nG.b, nS.b, nR.b, nM.b));
         col *= 0.55 + 0.45 * ao;
         // puddles in the low spots of the mud
         float puddle = hw.w * (1.0 - smoothstep(0.25, 0.4, aM.a));
         diffuseColor.rgb = col * (1.0 - puddle * 0.35);
         float tkRough = dot(hw, vec4(0.88, 0.95, 0.85, 0.5)) * (1.0 - puddle * 0.75);
         vec2 tkLN = (nG.xy * 2.0 - 1.0) * hw.x + (nS.xy * 2.0 - 1.0) * hw.y + (nR.xy * 2.0 - 1.0) * hw.z + (nM.xy * 2.0 - 1.0) * hw.w * (1.0 - puddle);`,
        'after',
      );
      inject(shader, 'fragment', '#include <roughnessmap_fragment>', 'roughnessFactor = tkRough;', 'after');
      inject(
        shader,
        'fragment',
        '#include <normal_fragment_maps>',
        `{
           vec4 g2 = texture2D(tGrad, wp / 11.0) * 2.0 - 1.0;
           vec2 grad = g2.xy * 0.25 * (1.0 - tkRoad * 0.5) * (1.0 - tkWet);
           // layer relief is in the ground plane; blend towards the slope for rock faces
           tkNrmW = normalize(nW + vec3(tkLN.x - grad.x, 0.0, tkLN.y - grad.y) * 0.9);
           normal = normalize((viewMatrix * vec4(tkNrmW, 0.0)).xyz);
         }`,
        'after',
      );
    },
  });
  addPatch(
    mat,
    thermalPatch(
      'terrain',
      `0.06 + 0.04 * tkFine + tkRockMask * 0.04 + tkRoad * 0.02 - tkWet * 0.03
       + 0.1 * uDay * max(dot(tkNrmW, uSunDir), 0.0)`,
    ),
  );
  return mat;
}

interface Chunk {
  mesh: THREE.Mesh;
  ci: number;
  cj: number;
  cx: number;
  cz: number;
  lod: number;
  geoms: (THREE.BufferGeometry | undefined)[];
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private chunks: Chunk[] = [];
  private readonly hf: Heightfield;
  private readonly normals: Float32Array;

  constructor(hf: Heightfield, noise: NoiseSet, ground: GroundLayers, fancy: boolean) {
    this.hf = hf;
    const roadTex = makeRoadTexture(hf.road, hf.n);
    this.material = terrainMaterial(noise, roadTex, ground, fancy);
    this.normals = this.computeNormals();
    const per = (hf.n - 1) / CHUNK_CELLS;
    for (let cj = 0; cj < per; cj++) {
      for (let ci = 0; ci < per; ci++) {
        const mesh = new THREE.Mesh(undefined, this.material);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.matrixAutoUpdate = false;
        const cx = -hf.half + (ci + 0.5) * CHUNK_CELLS * HEIGHT_CELL;
        const cz = -hf.half + (cj + 0.5) * CHUNK_CELLS * HEIGHT_CELL;
        const chunk: Chunk = { mesh, ci, cj, cx, cz, lod: -1, geoms: [] };
        this.chunks.push(chunk);
        this.setLod(chunk, LOD_STEPS.length - 1);
        this.group.add(mesh);
      }
    }
    this.group.add(this.buildFarRing());
  }

  private computeNormals(): Float32Array {
    const { n } = this.hf;
    const out = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const hx = this.hf.gridHeight(i + 1, j) - this.hf.gridHeight(i - 1, j);
        const hz = this.hf.gridHeight(i, j + 1) - this.hf.gridHeight(i, j - 1);
        const nx = -hx;
        const ny = 2 * HEIGHT_CELL;
        const nz = -hz;
        const l = Math.hypot(nx, ny, nz);
        const k = (j * n + i) * 3;
        out[k] = nx / l;
        out[k + 1] = ny / l;
        out[k + 2] = nz / l;
      }
    }
    return out;
  }

  private buildChunkGeometry(ci: number, cj: number, step: number): THREE.BufferGeometry {
    const { n } = this.hf;
    const cells = CHUNK_CELLS / step;
    const vr = cells + 1;
    const skirt = 4 * vr;
    const vCount = vr * vr + skirt;
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    const i0 = ci * CHUNK_CELLS;
    const j0 = cj * CHUNK_CELLS;
    const put = (v: number, gi: number, gj: number, drop: number) => {
      const ii = Math.min(n - 1, gi);
      const jj = Math.min(n - 1, gj);
      pos[v * 3] = -this.hf.half + ii * HEIGHT_CELL;
      pos[v * 3 + 1] = this.hf.heights[jj * n + ii]! - drop;
      pos[v * 3 + 2] = -this.hf.half + jj * HEIGHT_CELL;
      const k = (jj * n + ii) * 3;
      nrm[v * 3] = this.normals[k]!;
      nrm[v * 3 + 1] = this.normals[k + 1]!;
      nrm[v * 3 + 2] = this.normals[k + 2]!;
    };
    for (let y = 0; y < vr; y++) for (let x = 0; x < vr; x++) put(y * vr + x, i0 + x * step, j0 + y * step, 0);
    const idx: number[] = [];
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const a = y * vr + x;
        const b = a + 1;
        const c = a + vr;
        const d = c + 1;
        idx.push(a, c, b, c, d, b);
      }
    }
    // skirts hide LOD cracks between neighbouring chunks (both windings, cheap)
    const drop = step * 1.5;
    let v = vr * vr;
    const edge = (list: number[]) => {
      const first = v;
      for (const a of list) {
        const gi = Math.round((pos[a * 3]! + this.hf.half) / HEIGHT_CELL);
        const gj = Math.round((pos[a * 3 + 2]! + this.hf.half) / HEIGHT_CELL);
        put(v++, gi, gj, drop);
      }
      for (let k = 0; k < list.length - 1; k++) {
        const a = list[k]!;
        const b = list[k + 1]!;
        const sa = first + k;
        const sb = first + k + 1;
        idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
      }
    };
    const top: number[] = [];
    const bottom: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    for (let k = 0; k < vr; k++) {
      top.push(k);
      bottom.push((vr - 1) * vr + k);
      left.push(k * vr);
      right.push(k * vr + vr - 1);
    }
    edge(top);
    edge(bottom);
    edge(left);
    edge(right);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  private setLod(ch: Chunk, lod: number): void {
    if (ch.lod === lod) return;
    let g = ch.geoms[lod];
    if (!g) {
      g = this.buildChunkGeometry(ch.ci, ch.cj, LOD_STEPS[lod]!);
      ch.geoms[lod] = g;
    }
    ch.mesh.geometry = g;
    ch.lod = lod;
  }

  /** Pick LOD per chunk from camera distance; builds at most `budget` new geometries per call. */
  update(cam: THREE.Vector3, budget = 3): void {
    let built = 0;
    for (const ch of this.chunks) {
      const d = Math.max(0, Math.hypot(ch.cx - cam.x, ch.cz - cam.z) - CHUNK_CELLS * HEIGHT_CELL * 0.7);
      let lod = LOD_DIST.length;
      for (let k = 0; k < LOD_DIST.length; k++) {
        if (d < LOD_DIST[k]!) {
          lod = k;
          break;
        }
      }
      if (lod !== ch.lod) {
        if (!ch.geoms[lod]) {
          if (built >= budget) continue;
          built++;
        }
        this.setLod(ch, lod);
      }
    }
  }

  setFancy(on: boolean): void {
    const v = on ? 1 : 0;
    if (this.material.defines?.NOTILE === v) return;
    this.material.defines = { NOTILE: v };
    this.material.needsUpdate = true;
  }

  /** Force full-detail chunks around a point (used at spawn so nothing pops). */
  warm(cam: THREE.Vector3): void {
    this.update(cam, 1000);
  }

  /** Distant mountains outside the simulated area: one coarse ring mesh from the analytic height. */
  private buildFarRing(): THREE.Mesh {
    const inner = this.hf.half;
    const outer = 9000;
    const radial = 42;
    const around = 160;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let r = 0; r <= radial; r++) {
      const t = r / radial;
      const rr = inner * 1.0 + (outer - inner) * t * t;
      for (let a = 0; a < around; a++) {
        const ang = (a / around) * Math.PI * 2;
        // square-ish inner edge so it hugs the grid border
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const sq = 1 / Math.max(Math.abs(c), Math.abs(s));
        const k = r === 0 ? sq : sq + (1 - sq) * Math.min(1, t * 3);
        const x = c * rr * k;
        const z = s * rr * k;
        let h = this.hf.analytic(x, z);
        if (r === 0) h -= 3; // tuck under the grid edge
        // fade huge distances into haze-friendly rolling ranges
        h *= 1 - 0.4 * Math.min(1, t * 1.5);
        pos.push(x, h, z);
      }
    }
    for (let r = 0; r < radial; r++) {
      for (let a = 0; a < around; a++) {
        const i0 = r * around + a;
        const i1 = r * around + ((a + 1) % around);
        const i2 = i0 + around;
        const i3 = i1 + around;
        idx.push(i0, i1, i2, i1, i3, i2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = false;
    return m;
  }
}
