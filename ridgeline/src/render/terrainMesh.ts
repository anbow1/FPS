import { abs, attribute, cameraPosition, clamp, dFdx, dFdy, dot, float, floor, Fn, fract, If, int, ivec2, length, max, mix, mx_noise_float, normalize, positionWorld, property, select, smoothstep, texture, textureLoad, transformNormalToView, vec2, vec3, vec4 } from 'three/tsl';
import { Box3, BufferAttribute, Color, Frustum, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, MeshStandardNodeMaterial, type Node, type PerspectiveCamera, type Texture, Vector3 } from 'three/webgpu';
import { TERRAIN, type TerrainData } from '../sim/terrain.ts';
import { contactOcclusion, vehicleSunShadow } from './contactShadow.ts';
import type { GroundLayers } from './groundTextures.ts';
import { type LandSurface, landSurface } from './landCover.ts';
import type { TerrainTextures } from './terrainTextures.ts';

// Terrain by CDLOD (Strugar 2009, "Continuous Distance-Dependent Level of
// Detail"): a quadtree over the far grid's 819.2 km, selected on the CPU every
// frame by distance and frustum, drawn as ONE instanced mesh of 32 × 32-cell
// patches (one draw call, rules §6). Each vertex reads the height in the vertex
// stage (four textureLoads and the same bilinear as the CPU) and morphs towards
// the next coarser grid over the last quarter of its level's range, so levels
// meet without cracks or pops. Leaves are 320 m with 10 m cells (the near
// grid's resolution); each level doubles. Sea is the terrain clamped to sea
// level and shaded as water; rivers come from the cover map.
//
// Look: seen from a helicopter at tens of metres — meadows, pastures and hay
// fields in small irregular plots with hedgerows on the valley floors, rough
// grass and heath on the slopes, the forest belt, rock on the steepest ground,
// the river; PBR values from the sheet (grass, soil, rock, water tint). Fine
// detail comes from procedural noise in the fragment stage.

const PATCH = 32;
// Leaves of 320 m with 10 m cells (the near grid's resolution: the scale a helicopter flies at); ten levels
// double up to the far grid's 163.84 km.
const LEAF_M = 320;
const LEVELS = 10;
const LEAF_RANGE_M = 760;
const MAX_NODES = 900;

function lin(hex: number): Node<'vec3'> {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

export class TerrainRenderer {
  readonly mesh: Mesh;
  private readonly instances: InstancedBufferAttribute;
  private readonly geometry: InstancedBufferGeometry;
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly box = new Box3();
  private readonly camPos = new Vector3();
  private readonly ranges: number[] = [];
  private readonly bounds = new Map<number, [number, number]>();
  private count = 0;
  /** Nodes drawn last frame (F3 overlay). */
  nodesDrawn = 0;

  constructor(
    private readonly data: TerrainData,
    tex: TerrainTextures,
    /** The baked sun and sky visibility of the near grid (terrainShadow.ts), or null for none. */
    private readonly shadow: Texture | null = null,
    /** Close-range texture layers (groundTextures.ts), or null for the colours from the air alone. */
    private readonly ground: GroundLayers | null = null,
    /** High: stochastic tiling (two lookups per layer, no repeat); Low: one. */
    private readonly fancy = true,
  ) {
    for (let l = 0; l < LEVELS; l++) this.ranges.push(LEAF_RANGE_M * 2 ** l);
    const g = new InstancedBufferGeometry();
    const positions: number[] = [];
    for (let j = 0; j <= PATCH; j++) for (let i = 0; i <= PATCH; i++) positions.push(i / PATCH, 0, j / PATCH);
    const indices: number[] = [];
    for (let j = 0; j < PATCH; j++) {
      for (let i = 0; i < PATCH; i++) {
        const a = j * (PATCH + 1) + i;
        const b = a + 1;
        const c = a + PATCH + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    g.setIndex(indices);
    this.instances = new InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4);
    g.setAttribute('node', this.instances);
    g.instanceCount = 0;
    this.geometry = g;
    this.mesh = new Mesh(g, this.material(tex));
    this.mesh.name = 'terrain';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  private material(tex: TerrainTextures): MeshStandardNodeMaterial {
    const m = new MeshStandardNodeMaterial({ name: 'terrain', roughness: 0.92, metalness: 0 });
    const node = attribute('node', 'vec4'); // origin x, origin z, size, level
    const local = attribute('position', 'vec3').xz;
    const heightAt = (xz: Node<'vec2'>): Node<'float'> => terrainHeightNode(tex.nearHeight, tex.farHeight, xz);
    const world0 = vec2(node.x, node.y).add(local.mul(node.z));
    // Morph towards the coarser grid over the last quarter of this level's range.
    const range = float(LEAF_RANGE_M).mul(float(2).pow(node.w));
    const d0 = length(vec3(world0.x, heightAt(world0), world0.y).sub(cameraPosition));
    const k = clamp(d0.sub(range.mul(0.75)).div(range.mul(0.25)), 0, 1);
    const gridPos = local.mul(PATCH);
    const odd = fract(gridPos.mul(0.5)).mul(2);
    const world = world0.sub(odd.mul(node.z.div(PATCH)).mul(k));
    const h = heightAt(world);
    // The Earth curves away: drop d²/2R below the camera's tangent plane, so from 12 km the
    // horizon sits at ~390 km where the terrain ring ends (brief) — rendering only, the logic
    // stays flat (sub-metre within the 100 km play area).
    const dCam = world.sub(cameraPosition.xz);
    const drop = dot(dCam, dCam).div(2 * 6_360_000);
    m.positionNode = vec3(world.x, max(h, TERRAIN.seaLevelM).sub(drop), world.y);

    // ---- surface: near maps inside, far maps outside, blended exactly like the heights.
    const P = positionWorld;
    const t = clamp(max(abs(P.x), abs(P.z)).sub(TERRAIN.blendFromM).div(TERRAIN.blendToM - TERRAIN.blendFromM), 0, 1);
    const uvN = P.xz.div(TERRAIN.nearSizeM).add(0.5);
    const uvF = P.xz.div(TERRAIN.farSizeM).add(0.5);
    const nm = mix(texture(tex.nearNormal, uvN), texture(tex.farNormal, uvF), t);
    const nrm = normalize(nm.xyz.mul(2).sub(1));
    const cov = mix(texture(tex.nearCover, uvN), texture(tex.farCover, uvF), t);
    const land = landSurface(P, nrm, cov, nm.a.mul(2).sub(1));
    const water = land.water;
    const rockMask = land.rock;
    const snowHere = land.snow;
    let albedo: Node<'vec3'> = land.albedo;
    let detailN: Node<'vec3'> = vec3(0);
    let roughLand: Node<'float'> = mix(float(0.92), float(0.62), snowHere);
    if (this.ground) {
      const d = this.closeRange(this.ground, P, nrm, land);
      albedo = d.albedo;
      detailN = d.normal;
      roughLand = mix(d.roughness, float(0.62), snowHere);
    }
    // The river's own edge (screenshot tour: a navy shape cut sharp out of the meadow). A bank of wet silt
    // and gravel on the land side of the cover's edge, darker for the water in it; the shallows over that
    // bank greener and lighter than the deep channel.
    const bank = smoothstep(0.12, 0.3, cov.a).mul(float(1).sub(smoothstep(0.4, 0.55, cov.a)));
    albedo = mix(albedo, lin(0x6b604c).mul(0.85), bank.mul(0.75));
    roughLand = mix(roughLand, float(0.55), bank);
    const waterColour = mix(lin(0x0d2a36), lin(0x2c4e46), cov.a.oneMinus().mul(2).clamp(0, 1));
    m.colorNode = mix(albedo, waterColour, water);
    m.roughnessNode = mix(roughLand, float(0.07), water);
    // Water normals: flat with a little wind ripple. Land: the baked normal, roughened below the grid's
    // 10 m by noise — crags and gullies on rock, a gentle undulation elsewhere — and the close-range
    // layers' own relief on top.
    const ripple = vec3(mx_noise_float(P.xz.div(35)).mul(0.04), 1, mx_noise_float(P.xz.div(35).add(17)).mul(0.04));
    const crag = rockMask.mul(0.55).add(0.12);
    const detail = vec3(
      mx_noise_float(P.xz.div(31)).add(mx_noise_float(P.xz.div(9).add(3.3)).mul(0.5)),
      0,
      mx_noise_float(P.xz.div(31).add(7.7)).add(mx_noise_float(P.xz.div(9).add(1.9)).mul(0.5)),
    ).mul(crag);
    m.normalNode = transformNormalToView(normalize(mix(nrm.add(detail).add(detailN), ripple, water)));
    // The mountains' own light (terrainShadow.ts): sun shadow from the ridges, and sky occlusion for the
    // ambient. Both fade to 1 outside the near grid, which the bake does not cover.
    // Under a parked or low helicopter the ground sees less sky (contactShadow.ts).
    m.aoNode = contactOcclusion(positionWorld.xz);
    // The ground vehicles' stand-in sun shadows (contactShadow.ts), for when they are beyond the shadow map.
    const vehicles = vehicleSunShadow(positionWorld.xz);
    m.userData.shadowFactor = vehicles;
    m.receivedShadowNode = ((shadow: Node<'vec4'>) => shadow.mul(vehicles)) as unknown as () => Node;
    if (this.shadow) {
      const vis = texture(this.shadow, uvN);
      const sunVis = mix(vis.r, float(1), t).mul(vehicles);
      m.aoNode = mix(vis.g, float(1), t).mul(0.85).add(0.15).mul(contactOcclusion(positionWorld.xz));
      // ShadowNode calls this with the shadow factor; clouds.shadeReceivers multiplies its own on top.
      m.receivedShadowNode = ((shadow: Node<'vec4'>) => shadow.mul(sunVis)) as unknown as () => Node;
      m.userData.shadowFactor = sunVis;
    }
    return m;
  }

  /**
   * The close-range layers over the colours from the air (docs/graphics-playbook.md §2–3): each layer
   * sampled in world metres, height-blended with its neighbours so pebbles and tufts poke through instead
   * of cross-fading, with stochastic tiling on High (after Inigo Quilez: two offset lookups chosen by a
   * low-frequency index) and a second, rotated lookup 7.3× coarser that carries the pattern out to a few
   * hundred metres, where the first has mipped away. Colour is the layer's ratio to its own mean, so
   * from altitude the land keeps its field colours exactly; soil and litter take their own colour where
   * the air view had none for them (worn heath, the floor under the trees seen from below the crowns).
   * Runs in one Fn, which also writes the shading normal's detail and the roughness (shader properties).
   */
  private closeRange(g: GroundLayers, P: Node<'vec3'>, nrm: Node<'vec3'>, land: LandSurface): { albedo: Node<'vec3'>; normal: Node<'vec3'>; roughness: Node<'float'> } {
    const fancy = this.fancy;
    const outN = property('vec3', 'rlDetailN');
    const outR = property('float', 'rlRough');
    const means = g.means.map((c) => vec3(c[0], c[1], c[2]));
    const albedo = Fn(() => {
      const wp = P.xz;
      const dist = length(P.sub(cameraPosition));
      // Rock on a slope: sampled on the plane facing it, so the pattern does not stretch down the face.
      const an = abs(nrm);
      const side = select(an.x.greaterThan(an.z), P.zy, P.xy);
      const rockPlane = select(an.y.greaterThan(0.72), wp, side);
      const rot = (v: Node<'vec2'>): Node<'vec2'> => vec2(v.x.mul(0.82).sub(v.y.mul(0.57)), v.x.mul(0.57).add(v.y.mul(0.82)));
      const uvs = [wp.div(2.6), wp.div(2.2), rockPlane.div(3.6), wp.div(2.4)].map((u) => u.toVar());
      const uvFar = uvs.map((u) => rot(u).div(7.3).toVar());
      // Gradients outside the branches: WGSL allows derivatives only in uniform control flow.
      const grads = uvs.map((u) => [dFdx(u).toVar(), dFdy(u).toVar()] as const);
      const gradsFar = uvFar.map((u) => [dFdx(u).toVar(), dFdy(u).toVar()] as const);
      const idx = mx_noise_float(wp.div(170)).mul(0.5).add(0.5).toVar();
      const farK = smoothstep(12, 90, dist).mul(0.75).toVar();
      const w = land.layers.toVar();
      const wi = [w.x, w.y, w.z, w.w];
      const A = [0, 1, 2, 3].map(() => vec4(1, 1, 1, 0.3).toVar());
      const N = [0, 1, 2, 3].map(() => vec4(0.5, 0.5, 0.78, 1).toVar());
      // Beyond a few kilometres every mip is the mean: skip the lookups.
      If(dist.lessThan(4000), () => {
        for (let i = 0; i < 4; i++) {
          If(wi[i]!.greaterThan(0.01), () => {
            const [dx, dy] = grads[i]!;
            const at = (uv: Node<'vec2'>, ddx: Node<'vec2'>, ddy: Node<'vec2'>): [Node<'vec4'>, Node<'vec4'>] => [
              texture(g.albedo, uv).depth(int(i)).grad(ddx, ddy),
              texture(g.normal, uv).depth(int(i)).grad(ddx, ddy),
            ];
            const uv = uvs[i]!;
            if (fancy) {
              const l = idx.mul(8);
              const ia = floor(l);
              const f = fract(l);
              const oa = vec2(3, 7).mul(ia).sin();
              const ob = vec2(3, 7).mul(ia.add(1)).sin();
              const [a0, n0] = at(uv.add(oa), dx, dy);
              const [a1, n1] = at(uv.add(ob), dx, dy);
              const m = smoothstep(0.2, 0.8, f.sub(dot(a0.rgb.sub(a1.rgb), vec3(1)).mul(0.1)));
              A[i]!.assign(mix(a0, a1, m));
              N[i]!.assign(mix(n0, n1, m));
            } else {
              const [a0, n0] = at(uv, dx, dy);
              A[i]!.assign(a0);
              N[i]!.assign(n0);
            }
            const [fx, fy] = gradsFar[i]!;
            const [af, nf] = at(uvFar[i]!, fx, fy);
            const near = A[i]!.rgb.div(means[i]!);
            const far = af.rgb.div(means[i]!);
            A[i]!.assign(vec4(near.mul(mix(vec3(1), far, farK)), A[i]!.a));
            N[i]!.assign(vec4(mix(N[i]!.xy, nf.xy, farK.mul(0.5)), mix(N[i]!.z, nf.z, farK.mul(0.5)), 1));
          });
        }
      });
      // Height blend: the taller texel of the neighbouring layers wins the transition.
      const hw0 = w.mul(vec4(A[0]!.a, A[1]!.a, A[2]!.a, A[3]!.a).add(0.35));
      const hm = max(max(hw0.x, hw0.y), max(hw0.z, hw0.w)).sub(0.18);
      const hw1 = max(hw0.sub(hm), 0);
      const hw = hw1.div(max(hw1.x.add(hw1.y).add(hw1.z).add(hw1.w), 1e-4)).toVar();
      // What each layer is painted over: the air view, or the layer's own colour where that had none.
      const tone = land.macro.mul(0.3).add(0.85);
      const soilTarget = mix(land.albedo, means[1]!.mul(tone), max(float(1).sub(land.lowland), land.bare));
      const underCanopy = land.forest.mul(smoothstep(900, 300, dist));
      const litterTarget = mix(land.albedo, means[3]!.mul(tone).mul(mix(float(1), float(0.62), land.forest)), mix(float(1), underCanopy, land.forest));
      const target = land.albedo.mul(hw.x.add(hw.z)).add(soilTarget.mul(hw.y)).add(litterTarget.mul(hw.w));
      // A sward is never one green: tussocks and patches of other grasses, yellower and bluer, at a
      // couple of metres and at seven, fading out before the noise could alias (it has no mips).
      const mottleK = float(1).sub(smoothstep(150, 600, dist));
      const m1 = mx_noise_float(wp.div(1.9));
      const m2 = mx_noise_float(wp.div(7.3).add(vec2(4.1, 2.7)));
      const sward = vec3(1).add(vec3(0.08, 0.035, -0.14).mul(m2).mul(mottleK)).mul(m1.mul(0.13).mul(mottleK).add(1));
      const ratio = A[0]!.rgb.mul(sward).mul(hw.x).add(A[1]!.rgb.mul(hw.y)).add(A[2]!.rgb.mul(hw.z)).add(A[3]!.rgb.mul(hw.w));
      // Cavity AO, normalised by its mean so the far view keeps its brightness.
      const ao = dot(hw, vec4(N[0]!.z, N[1]!.z, N[2]!.z, N[3]!.z)).mul(0.45).add(0.55).div(0.45 * 0.78 + 0.55);
      const k = float(1).sub(land.snow).mul(float(1).sub(land.water));
      const ln = N[0]!.xy.mul(2).sub(1).mul(hw.x).add(N[1]!.xy.mul(2).sub(1).mul(hw.y)).add(N[2]!.xy.mul(2).sub(1).mul(hw.z)).add(N[3]!.xy.mul(2).sub(1).mul(hw.w));
      outN.assign(vec3(ln.x, 0, ln.y).mul(k).mul(0.9));
      outR.assign(dot(hw, vec4(0.9, 0.95, 0.82, 0.93)));
      return mix(land.albedo, target.mul(ratio).mul(ao), k);
    })();
    return { albedo, normal: outN, roughness: outR };
  }

  /** Selects the patches for this camera; call after the camera's matrices are current. */
  update(camera: PerspectiveCamera): void {
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem, camera.reversedDepth);
    this.camPos.copy(camera.position);
    this.count = 0;
    const rootSize = LEAF_M * 2 ** (LEVELS - 1);
    this.select(-rootSize / 2, -rootSize / 2, LEVELS - 1);
    this.geometry.instanceCount = this.count;
    this.instances.needsUpdate = true;
    this.nodesDrawn = this.count;
  }

  private select(x0: number, z0: number, level: number): void {
    const size = LEAF_M * 2 ** level;
    const [minH, maxH] = this.nodeBounds(x0, z0, size, level);
    this.box.min.set(x0, minH, z0);
    this.box.max.set(x0 + size, maxH, z0 + size);
    if (!this.frustum.intersectsBox(this.box)) return;
    const dist = this.box.distanceToPoint(this.camPos);
    const childRange = level > 0 ? this.ranges[level - 1]! : 0;
    if (level === 0 || dist > childRange) {
      this.emit(x0, z0, size, level);
      return;
    }
    const half = size / 2;
    this.select(x0, z0, level - 1);
    this.select(x0 + half, z0, level - 1);
    this.select(x0, z0 + half, level - 1);
    this.select(x0 + half, z0 + half, level - 1);
  }

  private emit(x0: number, z0: number, size: number, level: number): void {
    if (this.count >= MAX_NODES) return;
    this.instances.array.set([x0, z0, size, level], this.count * 4);
    this.count++;
  }

  /** Conservative height range of a node (5 × 5 samples plus a margin), cached. */
  private nodeBounds(x0: number, z0: number, size: number, level: number): [number, number] {
    const key = level * 1e12 + Math.round(x0 / LEAF_M + 512) * 1e6 + Math.round(z0 / LEAF_M + 512);
    const hit = this.bounds.get(key);
    if (hit) return hit;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j <= 4; j++) {
      for (let i = 0; i <= 4; i++) {
        const hgt = Math.max(TERRAIN.seaLevelM, this.data.heightAt(x0 + (i / 4) * size, z0 + (j / 4) * size));
        lo = Math.min(lo, hgt);
        hi = Math.max(hi, hgt);
      }
    }
    const margin = 60 + size * 0.02;
    const out: [number, number] = [lo - margin, hi + margin];
    this.bounds.set(key, out);
    return out;
  }
}

/** The CPU's bilinear grid lookup, in TSL: near grid inside, far outside, blended in between. */
export function terrainHeightNode(near: Texture, far: Texture, xz: Node<'vec2'>): Node<'float'> {
  const sample = (tex: Texture, res: number, size: number): Node<'float'> => {
    const uv = xz.div(size).add(0.5).mul(res).sub(0.5);
    const i = clamp(floor(uv), vec2(0), vec2(res - 2));
    const f = clamp(uv.sub(i), vec2(0), vec2(1));
    const at = (dx: number, dz: number): Node<'float'> => (textureLoad(tex, ivec2(int(i.x.add(dx)), int(i.y.add(dz)))) as unknown as Node<'vec4'>).x;
    const a = at(0, 0);
    const b = at(1, 0);
    const c = at(0, 1);
    const d = at(1, 1);
    return a.add(b.sub(a).mul(f.x)).add(c.sub(a).mul(f.y)).add(a.sub(b).sub(c).add(d).mul(f.x).mul(f.y));
  };
  // Linear blend, exactly as TerrainData.heightAt on the CPU.
  const m = max(abs(xz.x), abs(xz.y));
  const t = clamp(m.sub(TERRAIN.blendFromM).div(TERRAIN.blendToM - TERRAIN.blendFromM), 0, 1);
  return mix(sample(near, TERRAIN.nearRes, TERRAIN.nearSizeM), sample(far, TERRAIN.farRes, TERRAIN.farSizeM), t);
}


/**
 * The height of the rendered surface itself within the near grid, for things that stand on it (the
 * grass): level-0 patches put their vertices on the 10 m lattice, each the grid's bilinear there —
 * the mean of the four texel centres round it, half a cell off — and cut every cell from (i+1, j) to
 * (i, j+1) as the patch's index buffer does. Nine loads; exact where the near patches are unmorphed
 * (inside 570 m of the camera).
 */
export function meshHeightNode(near: Texture, xz: Node<'vec2'>): Node<'float'> {
  const cell = TERRAIN.nearSizeM / TERRAIN.nearRes;
  const g = xz.div(cell);
  const I = floor(g);
  const f = g.sub(I);
  const s0 = clamp(I.add(TERRAIN.nearRes / 2 - 1), vec2(0), vec2(TERRAIN.nearRes - 3));
  const L = (a: number, b: number): Node<'float'> => (textureLoad(near, ivec2(int(s0.x.add(a)), int(s0.y.add(b)))) as unknown as Node<'vec4'>).x;
  const l = [0, 1, 2].map((b) => [0, 1, 2].map((a) => L(a, b)));
  const at = (a: number, b: number): Node<'float'> => l[b]![a]!.add(l[b]![a + 1]!).add(l[b + 1]![a]!).add(l[b + 1]![a + 1]!).mul(0.25);
  const v00 = at(0, 0);
  const v10 = at(1, 0);
  const v01 = at(0, 1);
  const v11 = at(1, 1);
  const lower = v00.add(v10.sub(v00).mul(f.x)).add(v01.sub(v00).mul(f.y));
  const upper = v11.add(v01.sub(v11).mul(float(1).sub(f.x))).add(v10.sub(v11).mul(float(1).sub(f.y)));
  return max(select(f.x.add(f.y).lessThanEqual(1), lower, upper), TERRAIN.seaLevelM);
}
