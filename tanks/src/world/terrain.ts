import { cameraPosition, cameraViewMatrix, dFdx, dFdy, dot, float, floor, fract, Fn, If, int, length, max, mix, normalize, normalWorldGeometry, positionWorld, pow, property, sin, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { HEIGHT_CELL, WATER_LEVEL, WORLD_SIZE } from '../config';
import { linear, PBR } from '../render/palette';
import { G, thermalOutput, vnoise2 } from '../render/nodes';
import type { GroundLayers } from '../render/groundTextures';
import type { NoiseSet } from '../render/textures';
import { makeRoadTexture } from '../render/textures';
import type { Heightfield } from './heightfield';
import { hyp2, hyp3 } from '../core/mathx';

const CHUNK_CELLS = 64; // 128 m chunks
const LOD_STEPS = [1, 2, 4, 8, 16];
const LOD_DIST = [170, 380, 760, 1400];

type V2 = THREE.Node<'vec2'>;
type V4 = THREE.Node<'vec4'>;

/** 0 … 1 hash per cell, safe for negative cells (TSL's hash() is not). */
const cellHash = (c: V2, k: number): THREE.Node<'float'> => fract(sin(dot(c, vec2(12.9898 + k * 1.37, 78.233 + k * 2.71)).add(k * 0.618)).mul(43758.5453));

/** One layer of rain rings (Field Line render/wetStreet.ts): each cell, one drop per cycle, its ring running out and fading. */
const ringLayer = (p: V2, cellM: number, periodS: number, seed: number, time: THREE.Node<'float'>): V2 => {
  const q = p.div(cellM);
  const cell = floor(q);
  const phase = cellHash(cell, seed);
  const t = fract(time.div(periodS).add(phase));
  const cycle = floor(time.div(periodS).add(phase));
  const centre = vec2(cellHash(cell.add(cycle), seed + 1), cellHash(cell.add(cycle), seed + 2)).mul(0.7).add(0.15);
  const d = q.sub(cell).sub(centre);
  const x = length(d).mul(cellM).sub(t.mul(cellM * 0.45));
  const wave = sin(x.mul(70)).mul(smoothstep(0.03, 0.0, x.abs()));
  return normalize(d.add(1e-5)).mul(wave.mul(pow(float(1).sub(t), 2)));
};

/** Slope (xz) of the rain rings on standing water at world `p`. */
function rainRings(p: V2, time: THREE.Node<'float'>): V2 {
  return ringLayer(p, 0.45, 0.9, 3, time).add(ringLayer(p.add(vec2(0.21, 0.13)), 0.33, 0.75, 11, time));
}

/**
 * Terrain PBR material. Layer choice follows the material sheet — fresh/dry grass, dry soil, rock
 * on slopes (no stretch), wet mud at the shoreline, dirt roads — and each layer is a generated
 * close-range texture (albedo + height + normal). Layers are height-blended, so pebbles and tufts
 * poke through the neighbouring layer instead of cross-fading, and sampled with stochastic tiling
 * (after Inigo Quilez) so the 2–4 m tiles never repeat visibly. `fancy` off is the cheap path.
 *
 * The whole ground evaluation runs once, in the colour node; roughness, the shading normal and the
 * thermal heat it produces travel to the other nodes through shader-scope properties.
 */
export function terrainMaterial(noise: NoiseSet, roadTex: THREE.Texture, ground: GroundLayers, fancy: boolean): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  mat.name = fancy ? 'terrain-fancy' : 'terrain';
  const dryTint = (() => {
    const d = linear(PBR.grassDry.color);
    const f = linear(PBR.grassFresh.color);
    return vec3(d.r / f.r, d.g / f.g, d.b / f.b);
  })();
  const sand = linear(PBR.sand.color);
  const uWorld = uniform(new THREE.Vector2(WORLD_SIZE / 2, WORLD_SIZE + HEIGHT_CELL));
  const uWater = uniform(WATER_LEVEL);
  const tkRough = property('float', 'tkRough');
  const tkNrmW = property('vec3', 'tkNrmW');
  const tkHeat = property('float', 'tkHeat');

  // one layer: two offset lookups blended on a low-frequency index (stochastic tiling), with
  // explicit gradients so the offsets never break mip selection and sampling is legal inside a
  // branch. The gradients come from outside the branch: WGSL allows derivatives only in uniform
  // control flow.
  const sampleLayer = (layer: number, uv: V2, dx: V2, dy: V2, idx: THREE.Node<'float'>, outA: V4, outN: V4): void => {
    const albedo = (at: V2) => texture(ground.albedo, at).depth(int(layer)).grad(dx, dy);
    const normal = (at: V2) => texture(ground.normal, at).depth(int(layer)).grad(dx, dy);
    if (!fancy) {
      outA.assign(albedo(uv));
      outN.assign(normal(uv));
      return;
    }
    const l = idx.mul(8);
    const ia = floor(l);
    const f = fract(l);
    const oa = sin(vec2(3, 7).mul(ia));
    const ob = sin(vec2(3, 7).mul(ia.add(1)));
    const a0 = albedo(uv.add(oa));
    const a1 = albedo(uv.add(ob));
    const m = smoothstep(0.2, 0.8, f.sub(dot(a0.rgb.sub(a1.rgb), vec3(1)).mul(0.1)));
    outA.assign(mix(a0, a1, m));
    outN.assign(mix(normal(uv.add(oa)), normal(uv.add(ob)), m));
  };

  mat.colorNode = Fn(() => {
    const wp = positionWorld.xz;
    const nW = normalize(normalWorldGeometry);
    const tex = (s: number, off = 0) => texture(noise.texture, wp.div(s).add(off));
    const macro = tex(1100).r;
    const macro2 = tex(380, 0.3).g;
    const mid = tex(64).g;
    const fine = tex(5.5).b;
    const idx = tex(170).g;
    const slope = float(1).sub(nW.y);
    const dry = smoothstep(0.4, 0.66, macro.mul(0.7).add(macro2.mul(0.3)).add(mid.sub(0.5).mul(0.3)));
    const road = texture(roadTex, wp.add(uWorld.x).div(uWorld.y)).r;
    const wet = float(1).sub(smoothstep(0.2, 2.4, positionWorld.y.sub(uWater).add(fine.sub(0.5).mul(0.8))));
    const beach = float(1).sub(smoothstep(1.2, 3.5, positionWorld.y.sub(uWater))).mul(float(1).sub(wet));
    const rockMask = smoothstep(0.24, 0.36, slope.add(mid.sub(0.5).mul(0.14)).add(macro2.sub(0.5).mul(0.06)));
    // bare soil: small scattered patches (a few per cent of a grazed meadow: worn spots, molehills — at a
    // quarter of the ground it read as camouflage), worn banks on moderate slopes, roads, the beach
    const soilW = max(max(max(smoothstep(0.81, 0.9, mid.add(fine.sub(0.5).mul(0.4)).add(dry.mul(0.06))), smoothstep(0.15, 0.24, slope).mul(0.7)), smoothstep(0.05, 0.5, road)), beach.mul(0.8));
    // layer weights: meadow, soil, rock, mud
    const w = mix(mix(vec4(float(1).sub(soilW), soilW, 0, 0), vec4(0, 0, 1, 0), rockMask), vec4(0, 0, 0, 1), wet).toVar();
    const flat = vec4(0.5, 0.5, 1, 1);
    const aG = vec4(0).toVar();
    const aS = vec4(0).toVar();
    const aR = vec4(0).toVar();
    const aM = vec4(0).toVar();
    const nG = flat.toVar();
    const nS = flat.toVar();
    const nR = flat.toVar();
    const nM = flat.toVar();
    const uvG = wp.div(2.2).toVar();
    const uvS = wp.div(1.7).toVar();
    // rock on slopes: sample on the plane facing the slope so the pattern does not stretch
    const an = nW.abs();
    const side = mix(positionWorld.xy, positionWorld.zy, an.x.greaterThan(an.z).select(float(1), float(0)));
    const uvR = mix(side, wp, smoothstep(0.55, 0.8, an.y)).div(3.5).toVar();
    const uvM = wp.div(2.5).toVar();
    const d = (uv: V2): [V2, V2] => [dFdx(uv).toVar(), dFdy(uv).toVar()];
    const [gx, gy] = d(uvG);
    const [sx, sy] = d(uvS);
    const [rx, ry] = d(uvR);
    const [mx, my] = d(uvM);
    If(w.x.greaterThan(0.01), () => sampleLayer(0, uvG, gx, gy, idx, aG, nG));
    If(w.y.greaterThan(0.01), () => sampleLayer(1, uvS, sx, sy, idx, aS, nS));
    If(w.z.greaterThan(0.01), () => sampleLayer(2, uvR, rx, ry, idx, aR, nR));
    If(w.w.greaterThan(0.01), () => sampleLayer(3, uvM, mx, my, idx, aM, nM));
    // height blend: the taller texel of the neighbouring layers wins the transition
    const hw0 = w.mul(vec4(aG.a, aS.a, aR.a, aM.a).add(0.35));
    const hm = max(max(hw0.x, hw0.y), max(hw0.z, hw0.w)).sub(0.18);
    const hw1 = max(hw0.sub(hm), 0);
    const hw = hw1.div(max(hw1.x.add(hw1.y).add(hw1.z).add(hw1.w), 1e-4)).toVar();
    const grassCol = aG.rgb.mul(mix(vec3(1), dryTint, dry)).mul(macro2.mul(0.3).add(0.85));
    const sandTint = vec3(sand.r, sand.g, sand.b).div(max(aS.rgb, vec3(0.02))).mul(0.5);
    const soilCol = aS.rgb.mul(mix(vec3(1), sandTint, beach.mul(0.35))).mul(float(1).sub(smoothstep(0.55, 0.95, road).mul(0.2)));
    const col = grassCol.mul(hw.x).add(soilCol.mul(hw.y)).add(aR.rgb.mul(hw.z)).add(aM.rgb.mul(hw.w)).mul(macro.mul(0.2).add(0.9));
    const ao = dot(hw, vec4(nG.b, nS.b, nR.b, nM.b));
    // puddles in the low spots of the mud
    const puddle = hw.w.mul(float(1).sub(smoothstep(0.25, 0.4, aM.a)));
    tkRough.assign(dot(hw, vec4(0.88, 0.95, 0.85, 0.5)).mul(float(1).sub(puddle.mul(0.75))));
    const ln = nG.xy.mul(2).sub(1).mul(hw.x).add(nS.xy.mul(2).sub(1).mul(hw.y)).add(nR.xy.mul(2).sub(1).mul(hw.z)).add(nM.xy.mul(2).sub(1).mul(hw.w).mul(float(1).sub(puddle)));
    // fine relief from the noise gradient, flattened on roads and in the wet
    const g2 = texture(noise.gradient, wp.div(11)).mul(2).sub(1);
    const grad = g2.xy.mul(0.25).mul(float(1).sub(road.mul(0.5))).mul(float(1).sub(wet));
    // layer relief is in the ground plane; blend towards the slope for rock faces
    tkNrmW.assign(normalize(nW.add(vec3(ln.x.sub(grad.x), 0, ln.y.sub(grad.y)).mul(0.9))));
    // Swash on the bank, after Castaway Lagoon (docs/graphics-playbook.md §7.5) at lake scale: the
    // wind waves run a thin film up to 4–22 cm above the still level and pull it back, in phase
    // with the lake shader's shore-foam fronts; the bank stays dark and glossy up to the highest
    // run-up, and a lacy foam line rides the film's edge.
    const above = positionWorld.y.sub(uWater);
    const t = G.uTime;
    const broad = vnoise2(wp.add(vec2(t.mul(0.32), t.mul(-0.13))).div(4));
    const runup = mix(0.04, 0.22, sin(t.mul(1.22).add(broad.sub(0.5).mul(2.3))).mul(0.5).add(0.5));
    const film = float(1).sub(smoothstep(runup.sub(0.04), runup, above));
    const soaked = float(1).sub(smoothstep(0.2, 0.45, above.add(fine.sub(0.5).mul(0.1))));
    const lace = smoothstep(runup.sub(0.05), runup.sub(0.01), above).mul(float(1).sub(smoothstep(runup.sub(0.01), runup.add(0.01), above))).mul(smoothstep(0.45, 0.65, fine));
    tkRough.assign(mix(mix(tkRough, float(0.3), soaked), float(0.06), film));
    tkNrmW.assign(normalize(mix(tkNrmW, nW, film.mul(0.8))));
    tkHeat.assign(
      float(0.06).add(fine.mul(0.04)).add(rockMask.mul(0.04)).add(road.mul(0.02)).sub(wet.mul(0.03)).add(G.uDay.mul(0.1).mul(max(dot(tkNrmW, G.uSunDir), 0))),
    );
    // Rain (G.uRain): soil, mud, road and rock soak dark and glossy, grass less so; water stands in
    // the ruts of the tracks, in the mud and in flat low spots, rippled by rain rings near the camera.
    const rain = G.uRain;
    const soak = rain.mul(float(1).sub(hw.x.mul(0.55)));
    const flatGround = smoothstep(0.93, 0.99, nW.y);
    const pool = tex(9, 0.7).r.mul(0.55).add(road.mul(0.45)).add(hw.w.mul(0.35)).add(hw.y.mul(0.1));
    const rainPuddle = rain.mul(flatGround).mul(smoothstep(0.62, 0.72, pool));
    const dist = positionWorld.sub(cameraPosition).length();
    const rings = rainRings(wp, G.uTime).mul(smoothstep(30, 6, dist)).mul(0.4);
    tkRough.assign(mix(mix(tkRough, max(tkRough.mul(0.5), 0.3), soak), float(0.03), rainPuddle));
    tkNrmW.assign(normalize(mix(tkNrmW, normalize(nW.sub(vec3(rings.x, 0, rings.y))), rainPuddle)));
    const ground = col.mul(ao.mul(0.45).add(0.55)).mul(float(1).sub(puddle.mul(0.35))).mul(mix(float(1), float(0.6), soak)).mul(float(1).sub(rainPuddle.mul(0.45)));
    return mix(ground.mul(mix(float(1), float(0.6), max(soaked.mul(0.7), film))), vec3(0.8), lace.mul(0.8));
  })();
  mat.roughnessNode = tkRough;
  mat.normalNode = normalize(cameraViewMatrix.mul(vec4(tkNrmW, 0)).xyz);
  thermalOutput(mat, tkHeat);
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
  material: THREE.MeshStandardNodeMaterial;
  private readonly noise: NoiseSet;
  private readonly ground: GroundLayers;
  private readonly roadTex: THREE.Texture;
  private fancy: boolean;
  private farRing: THREE.Mesh;
  private chunks: Chunk[] = [];
  private readonly hf: Heightfield;
  private readonly normals: Float32Array;

  constructor(hf: Heightfield, noise: NoiseSet, ground: GroundLayers, fancy: boolean) {
    this.hf = hf;
    this.noise = noise;
    this.ground = ground;
    this.fancy = fancy;
    this.roadTex = makeRoadTexture(hf.road, hf.n);
    this.material = terrainMaterial(noise, this.roadTex, ground, fancy);
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
    this.farRing = this.buildFarRing();
    this.group.add(this.farRing);
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
        const l = hyp3(nx, ny, nz);
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
  update(cam: THREE.Vector3, budget = 1): void {
    let built = 0;
    for (const ch of this.chunks) {
      const d = Math.max(0, hyp2(ch.cx - cam.x, ch.cz - cam.z) - CHUNK_CELLS * HEIGHT_CELL * 0.7);
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

  /** Stochastic tiling on/off: a different material (the menu's quality switch warms it up). */
  setFancy(on: boolean): void {
    if (on === this.fancy) return;
    this.fancy = on;
    const old = this.material;
    this.material = terrainMaterial(this.noise, this.roadTex, this.ground, on);
    for (const ch of this.chunks) ch.mesh.material = this.material;
    this.farRing.material = this.material;
    old.dispose();
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
