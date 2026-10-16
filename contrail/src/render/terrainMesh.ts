import { abs, attribute, cameraPosition, clamp, cos, dot, float, floor, fract, fwidth, hash, int, ivec2, length, max, min, mix, mx_noise_float, normalize, positionWorld, sin, smoothstep, step, texture, textureLoad, transformNormalToView, vec2, vec3 } from 'three/tsl';
import { Box3, BufferAttribute, Color, Frustum, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, MeshStandardNodeMaterial, type Node, type PerspectiveCamera, type Texture, Vector3 } from 'three/webgpu';
import { TERRAIN, type TerrainData } from '../sim/terrain.ts';
import type { TerrainTextures } from './terrainTextures.ts';

// Terrain by CDLOD (Strugar 2009, "Continuous Distance-Dependent Level of
// Detail"): a quadtree over the far grid's 819.2 km, selected on the CPU every
// frame by distance and frustum, drawn as ONE instanced mesh of 32 × 32-cell
// patches (one draw call, rules §6). Each vertex reads the height in the vertex
// stage (four textureLoads and the same bilinear as the CPU) and morphs towards
// the next coarser grid over the last quarter of its level's range, so levels
// meet without cracks or pops. Leaves are 1.6 km with 50 m cells (the near
// grid's resolution); each level doubles. Sea is the terrain clamped to sea
// level and shaded as water; rivers come from the cover map.
//
// Look: "satellite-style colour" (brief) — a farmland patchwork of fields with
// hedgerows below ~900 m, forests, heath, rock on steep slopes, snow above
// ~2.4 km, rivers and sea; PBR values from the sheet (grass, soil, rock, snow,
// water tint). Fine detail comes from procedural noise in the fragment stage.

const PATCH = 32;
// Leaves of 1.6 km with 50 m cells (the near grid's resolution); ten levels double up to 819.2 km.
const LEAF_M = 1600;
const LEVELS = 10;
const LEAF_RANGE_M = 3600;
const MAX_NODES = 1000;

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
    const nrm = normalize(mix(texture(tex.nearNormal, uvN), texture(tex.farNormal, uvF), t).xyz.mul(2).sub(1));
    const cov = mix(texture(tex.nearCover, uvN), texture(tex.farCover, uvF), t);
    const forest = cov.r;
    const rock = cov.g;
    const snow = cov.b;
    const water = smoothstep(0.35, 0.65, cov.a);
    const macro = mx_noise_float(P.xz.div(4500)).mul(0.5).add(0.5);
    const fine = mx_noise_float(P.xz.div(14)).mul(0.5).add(0.5);

    // Farmland as seen from the air: blocks of fields whose grid turns from one district (~6 km) to
    // the next, each block cut into one to four strips of its own crop, desaturated sheet colours with
    // per-field brightness and in-field moisture patches, hedgerows, the odd farm track along a block
    // edge, and small villages of roofs and gardens.
    const district = floor(P.xz.div(6000));
    const dId = hash(district.x.mul(3.17).add(district.y.mul(11.3)));
    const angle = dId.mul(1.4).sub(0.7);
    const ca = cos(angle);
    const sa = sin(angle);
    const r = vec2(P.x.mul(ca).sub(P.z.mul(sa)), P.x.mul(sa).add(P.z.mul(ca)));
    const fieldSize = vec2(mix(float(260), float(420), dId), mix(float(380), float(620), hash(dId.mul(9.1))));
    const row = floor(r.y.div(fieldSize.y));
    const q = vec2(r.x.div(fieldSize.x).add(hash(row.mul(13.7).add(dId)).mul(0.9)), r.y.div(fieldSize.y));
    const cell = floor(q);
    const blockId = hash(cell.x.mul(7.31).add(cell.y.mul(157.7)).add(dId.mul(41)));
    const f0 = fract(q);
    // Strips across the block.
    const strips = floor(blockId.mul(4)).add(1);
    const stripCoord = f0.x.mul(strips);
    const stripIdx = floor(stripCoord);
    const id = hash(blockId.mul(91.7).add(stripIdx.mul(3.3)));
    const crop = mix(
      mix(lin(0x6d7343), lin(0x4a6030), smoothstep(0.15, 0.2, id)),
      mix(mix(lin(0xb3a16a), lin(0x6b5a47), smoothstep(0.55, 0.6, id)), lin(0x8a9a58), smoothstep(0.8, 0.85, id)),
      smoothstep(0.38, 0.42, id),
    );
    // Satellite colour is greyer than the swatches: pull a quarter of the way to luminance, vary per field.
    const cropGrey = vec3(dot(crop, vec3(0.2126, 0.7152, 0.0722)));
    const moisture = mx_noise_float(P.xz.div(55).add(id.mul(30))).mul(0.5).add(0.5);
    const field = mix(crop, cropGrey, 0.25).mul(float(0.88).add(hash(id.mul(5.1)).mul(0.24))).mul(float(0.92).add(moisture.mul(0.16)));
    const edgeX = min(fract(stripCoord), float(1).sub(fract(stripCoord))).mul(fieldSize.x).div(strips);
    const edgeY = min(f0.y, float(1).sub(f0.y)).mul(fieldSize.y);
    const blockEdge = min(min(f0.x, float(1).sub(f0.x)).mul(fieldSize.x), edgeY);
    const hedge = float(1).sub(smoothstep(3, 7, blockEdge)).mul(step(0.35, hash(cell.x.add(cell.y.mul(5.3)))));
    const furrow = float(1).sub(smoothstep(0.6, 1.6, edgeX)).mul(0.5);
    // A farm track along some block rows.
    const track = float(1).sub(smoothstep(2, 4, edgeY)).mul(step(hash(row.mul(2.9).add(dId)), 0.25));
    // Crop rows: faint stripes along each strip.
    const rows = abs(fract(r.x.div(6).add(id.mul(3))).sub(0.5)).mul(0.08).add(0.96);
    // Low over the fields (a strafing run, an approach) the blocks read as flat paint. Tramlines — the pair
    // of tractor wheelings every 24 m along a strip — patchy growth, and drill rows close in, each faded
    // by its pixel footprint so none of it shimmers from altitude.
    const fieldFoot = fwidth(r.x).add(fwidth(r.y));
    const tramD = abs(fract(r.x.div(24).add(id.mul(7))).sub(0.5)).mul(24);
    const wheeling = float(1).sub(smoothstep(0.15, fieldFoot.add(0.3), abs(tramD.sub(0.9)))).mul(float(1).sub(smoothstep(0.6, 2.5, fieldFoot)));
    const growth = mx_noise_float(P.xz.div(18).add(id.mul(13))).mul(0.07).add(mx_noise_float(P.xz.div(4.5)).mul(0.04).mul(float(1).sub(smoothstep(0.4, 1.5, fieldFoot))));
    const drill = abs(fract(r.x.div(0.75)).sub(0.5)).mul(0.1).mul(float(1).sub(smoothstep(0.08, 0.3, fieldFoot)));
    const crops = field.mul(growth.add(1)).mul(drill.add(0.97));
    // (No wheelings on bare ploughed strips: they are soil already.)
    const ploughedK = smoothstep(0.38, 0.42, id).mul(smoothstep(0.55, 0.6, id)).mul(float(1).sub(smoothstep(0.8, 0.85, id)));
    const tilled = mix(crops, lin(0x6b5a47).mul(0.9), wheeling.mul(0.45).mul(float(1).sub(ploughedK)));
    let farm: Node<'vec3'> = mix(tilled.mul(rows), lin(0x34472a), max(hedge.mul(0.8), furrow.mul(0.3)));
    farm = mix(farm, lin(0x9b9488), track.mul(0.7));
    // Villages: a few hundred metres of roofs, gardens and lanes where a coarse noise peaks.
    const villageN = mx_noise_float(P.xz.div(2600).add(vec2(31, 7)));
    const village = smoothstep(0.55, 0.62, villageN);
    const plot = floor(P.xz.div(22));
    const plotId = hash(plot.x.mul(1.7).add(plot.y.mul(37.1)));
    const roof = mix(lin(0x8a4a38), lin(0x6e6a66), step(0.55, plotId));
    const built = mix(mix(lin(0x55663c), roof, step(0.62, plotId)), lin(0x8d8a84), step(0.9, plotId));
    const farmland = mix(farm, built, village);
    const lowland = float(1).sub(smoothstep(700, 1100, P.y)).mul(smoothstep(0.94, 0.985, nrm.y));
    const heath = mix(lin(0x6d7346), lin(0x5c5a42), macro);
    let albedo: Node<'vec3'> = mix(heath, farmland, lowland);
    // Forest canopy: dark greens with crown-scale variation.
    const canopy = mix(lin(0x2a3820), lin(0x3c4a2a), mx_noise_float(P.xz.div(60)).mul(0.5).add(0.5));
    albedo = mix(albedo, canopy, smoothstep(0.3, 0.6, forest));
    // Rock: strata — bands that follow the height, bent by noise as folded beds are — in two greys and
    // a warm iron stain, cut by darker cracks across them.
    const bend = mx_noise_float(P.xz.div(900)).mul(60).add(mx_noise_float(P.xz.div(140)).mul(12));
    // Bed thickness varies too (the height scale is itself bent by noise), so the bands never repeat evenly.
    const bed = fract(P.y.add(bend).div(mx_noise_float(P.xz.div(700)).mul(7).add(19)));
    const beds = smoothstep(0.1, 0.45, bed).mul(float(1).sub(smoothstep(0.7, 0.98, bed))).mul(0.6).add(mx_noise_float(P.xz.div(55)).mul(0.25));
    const stain = smoothstep(0.35, 0.75, mx_noise_float(P.xz.div(320).add(vec2(5, 9))));
    // Beds show only on steep faces: on a gentle slope bands of constant height become contour rings.
    // (and in patches: whole outcrops, not every slope).
    const cliff = smoothstep(0.62, 0.45, nrm.y).mul(smoothstep(0.0, 0.3, mx_noise_float(P.xz.div(1100).add(vec2(13, 4)))));
    const tone = mx_noise_float(P.xz.div(180)).mul(0.5).add(0.5);
    let rockColour: Node<'vec3'> = mix(lin(0x5e5a55), lin(0x8a857d), mix(tone, beds, cliff));
    rockColour = mix(rockColour, lin(0x7a6450), stain.mul(0.45));
    const crack = smoothstep(0.82, 0.95, abs(mx_noise_float(vec2(P.x.add(P.z).div(38), P.y.div(9)))));
    rockColour = rockColour.mul(float(1).sub(crack.mul(0.35).mul(cliff)));
    // Exposed rock also where the fragment's own slope is steep, not only where the baked cover says so.
    const steep = smoothstep(0.82, 0.62, nrm.y).mul(float(1).sub(water));
    const rockMask = max(rock, steep.mul(0.85));
    albedo = mix(albedo, rockColour, rockMask);
    // Snow settles on the flatter ground and slides off the steep faces, whatever the cover map says.
    const snowHere = snow.mul(smoothstep(0.55, 0.78, nrm.y));
    albedo = mix(albedo, lin(0xe8edf2), snowHere);
    albedo = albedo.mul(float(0.85).add(macro.mul(0.3))).mul(float(0.9).add(fine.mul(0.2)));
    // Close to the ground (taxiing, take-off, a low pass) the satellite colours alone read as flat paint:
    // grass clumps and dry tufts at metre and decimetre scale, faded out by pixel footprint (below a pixel
    // from altitude, they would only shimmer). Round the airbase the grass is mown in stripes along the
    // runway, as airfields are, which also shows from the air.
    const land = float(1).sub(rockMask).mul(float(1).sub(snowHere));
    const footprint = fwidth(P.x).add(fwidth(P.z));
    const close = float(1).sub(smoothstep(0.2, 1.5, footprint)).mul(land);
    const clump = mx_noise_float(P.xz.div(1.6)).mul(0.6).add(mx_noise_float(P.xz.div(0.42)).mul(0.4));
    const tuft = smoothstep(0.35, 0.7, mx_noise_float(P.xz.div(0.9).add(vec2(4.1, 2.7))));
    const airfield = float(1).sub(smoothstep(700, 760, abs(P.x.sub(200)))).mul(float(1).sub(smoothstep(1700, 1780, abs(P.z)))).mul(land);
    // Stripe edges anti-aliased by their own footprint, and the contrast gone once a stripe nears a pixel.
    const swath = P.x.div(9);
    const swathW = max(fwidth(swath), 1e-4);
    // A triangle wave, so both edges of a stripe (a quarter and three quarters across) are smoothed.
    const tri = abs(fract(swath).sub(0.5)).mul(2);
    const blur = smoothstep(0.15, 0.4, swathW);
    const stripe = smoothstep(float(0.5).sub(swathW.mul(2)), float(0.5).add(swathW.mul(2)), tri).mul(float(1).sub(blur)).add(blur.mul(0.5));
    const mown = mix(lin(0x56663a), lin(0x64733f), stripe).mul(float(0.9).add(fine.mul(0.15)));
    albedo = mix(albedo, mown, airfield.mul(0.85));
    albedo = albedo.mul(float(1).add(clump.mul(0.16).mul(close)));
    albedo = mix(albedo, albedo.mul(vec3(1.25, 1.15, 0.85)), tuft.mul(0.22).mul(close));
    const waterColour = mix(lin(0x0d2a36), lin(0x1f3e44), cov.a.oneMinus().mul(2).clamp(0, 1));
    m.colorNode = mix(albedo, waterColour, water);
    m.roughnessNode = mix(mix(float(0.92), float(0.62), snowHere), float(0.07), water);
    // Water normals: flat with a little wind ripple. Land: the baked normal, roughened below the grid's
    // 50 m by noise — crags and gullies on rock, a gentle undulation elsewhere.
    const ripple = vec3(mx_noise_float(P.xz.div(35)).mul(0.04), 1, mx_noise_float(P.xz.div(35).add(17)).mul(0.04));
    const crag = rockMask.mul(0.55).add(0.12);
    const detail = vec3(
      mx_noise_float(P.xz.div(31)).add(mx_noise_float(P.xz.div(9).add(3.3)).mul(0.5)),
      0,
      mx_noise_float(P.xz.div(31).add(7.7)).add(mx_noise_float(P.xz.div(9).add(1.9)).mul(0.5)),
    ).mul(crag);
    m.normalNode = transformNormalToView(normalize(mix(nrm.add(detail), ripple, water)));
    // The mountains' own light (terrainShadow.ts): sun shadow from the ridges, and sky occlusion for the
    // ambient. Both fade to 1 outside the near grid, which the bake does not cover.
    if (this.shadow) {
      const vis = texture(this.shadow, uvN);
      const sunVis = mix(vis.r, float(1), t);
      m.aoNode = mix(vis.g, float(1), t).mul(0.85).add(0.15);
      // ShadowNode calls this with the shadow factor; clouds.shadeReceivers multiplies its own on top.
      m.receivedShadowNode = ((shadow: Node<'vec4'>) => shadow.mul(sunVis)) as unknown as () => Node;
      m.userData.shadowFactor = sunVis;
    }
    return m;
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

