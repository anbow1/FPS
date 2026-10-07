import { atan, attribute, cameraPosition, cameraViewMatrix, cos, cross, diffuseColor, float, floor, fract, instanceIndex, length, max, mix, mod, mrt, normalize, normalWorld, positionWorld, select, sin, smoothstep, texture, uniformArray, varying, vec2, vec3, vec4 } from 'three/tsl';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  type Node,
  OrthographicCamera,
  RenderTarget,
  Scene,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { TERRAIN } from '../sim/terrain.ts';
import { terrainHeightNode } from './terrainMesh.ts';
import type { TerrainTextures } from './terrainTextures.ts';

// Forests of real trees, everywhere the land-cover map says forest, with no
// list of trees anywhere: the GPU makes them. Each ring is ONE instanced draw
// of N × N camera-facing quads laid on a grid that moves with the camera in
// whole cells; every instance hashes its world cell into a jittered position,
// a species, a size and a heading, reads the forest density and the ground
// height from the terrain textures in the vertex stage, and collapses to
// nothing where there is no forest. So a 100 km map costs the same as a park,
// and a tree is always in the same place when you come back to it.
//
// The quads are impostors (after the shared impostor.ts of the other games):
// three procedural species — a spruce, a pine, a broadleaf — are rendered at
// load into an atlas of eight views round the trunk plus one from straight
// above, as unlit albedo and object-space normals, so the impostors are lit by
// the real sun and sky, take the ridges' and the clouds' shadows, and turn
// smoothly as you fly round them. From high up they show their crowns from
// above instead of edge-on cards: the top view takes over with the camera's
// elevation.

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

const VIEWS = 8;
const FRAMES = VIEWS + 1;

/** A seeded 0…1 random for the tree builders. */
function rnd(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Writes per-vertex colours: a base tone, darker inside and lower in the crown, with a little noise. */
function paint(g: BufferGeometry, hex: number, axisY: number, r: () => number, darkInside = 0.45): void {
  const p = g.getAttribute('position');
  const c = new Color(hex);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const out = Math.min(1, Math.hypot(x, z, (y - axisY) * 0.4) / 4);
    const k = (1 - darkInside + darkInside * out) * (0.85 + r() * 0.3);
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
}

/** Pushes vertices outward by a random amount (ragged foliage instead of smooth solids). */
function ruffle(g: BufferGeometry, amount: number, r: () => number): void {
  const p = g.getAttribute('position');
  const n = new Vector3();
  for (let i = 0; i < p.count; i++) {
    n.set(p.getX(i), 0, p.getZ(i));
    const len = n.length() || 1;
    const k = 1 + (r() - 0.35) * amount;
    p.setXYZ(i, (p.getX(i) / len) * len * k, p.getY(i) + (r() - 0.5) * amount * 0.6, (p.getZ(i) / len) * len * k);
  }
  g.computeVertexNormals();
}

/** Normals pointing away from the crown's axis: foliage shades as one mass, not as its facets. */
function crownNormals(g: BufferGeometry, centreY: number): void {
  const p = g.getAttribute('position');
  const nrm = new Float32Array(p.count * 3);
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), (p.getY(i) - centreY) * 0.7 + 0.8, p.getZ(i)).normalize();
    nrm[i * 3] = v.x;
    nrm[i * 3 + 1] = v.y;
    nrm[i * 3 + 2] = v.z;
  }
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
}

function material(): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, side: DoubleSide });
}

function trunk(height: number, radius: number, hex: number): Mesh {
  const g = new CylinderGeometry(radius * 0.4, radius, height, 7, 1, false).translate(0, height / 2, 0);
  const c = new Color(hex);
  const col = new Float32Array(g.getAttribute('position').count * 3).map((_, i) => [c.r, c.g, c.b][i % 3]!);
  g.setAttribute('color', new BufferAttribute(col, 3));
  return new Mesh(g, material());
}

/** Spruce: a tall narrow cone of drooping, ragged tiers, close enough to merge into one dark spire. ~25 m. */
function spruce(seed: number): Group {
  const r = rnd(seed);
  const g = new Group();
  g.add(trunk(23, 0.25, 0x2e2722));
  const tiers = 17;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y0 = 2.2 + f * 21;
    const radius = 3.2 * Math.pow(1 - f, 0.9) + 0.3;
    // Each tier droops: a short cone, wider at the bottom, its rim pulled down and torn.
    const cone = new CylinderGeometry(0.1, radius, 2.6 + (1 - f) * 1.2, 11, 3, true).translate(0, y0 + 1.1, 0);
    ruffle(cone, 0.7, r);
    crownNormals(cone, 13);
    paint(cone, t % 3 === 0 ? 0x1c2e1a : 0x22371f, 13, r, 0.55);
    cone.rotateY(r() * Math.PI);
    g.add(new Mesh(cone, material()));
  }
  return g;
}

/** Pine: a grey-brown trunk under a broad, irregular crown of flat clumps. ~20 m. */
function pine(seed: number): Group {
  const r = rnd(seed);
  const g = new Group();
  g.add(trunk(16, 0.22, 0x3f342b));
  for (let k = 0; k < 13; k++) {
    const a = r() * Math.PI * 2;
    const d = r() * 3.2;
    const blob = new IcosahedronGeometry(1.5 + r() * 1.2, 1);
    blob.scale(1.35, 0.55, 1.35).translate(Math.cos(a) * d, 10.5 + r() * 8, Math.sin(a) * d);
    ruffle(blob, 0.6, r);
    crownNormals(blob, 14);
    paint(blob, 0x2a4123, 14, r);
    g.add(new Mesh(blob, material()));
  }
  return g;
}

/** Broadleaf: a short trunk and a rounded crown of many lobes. ~17 m. */
function broadleaf(seed: number): Group {
  const r = rnd(seed);
  const g = new Group();
  g.add(trunk(9, 0.45, 0x4a4036));
  for (let k = 0; k < 14; k++) {
    const a = r() * Math.PI * 2;
    const el = r() * 1.2 - 0.2;
    const d = 2.2 + r() * 2.2;
    const blob = new IcosahedronGeometry(2.1 + r() * 1.3, 1);
    blob.translate(Math.cos(a) * Math.cos(el) * d, 11 + Math.sin(el) * d * 0.9, Math.sin(a) * Math.cos(el) * d);
    ruffle(blob, 0.55, r);
    crownNormals(blob, 11);
    paint(blob, 0x3a5527, 11, r, 0.55);
    g.add(new Mesh(blob, material()));
  }
  return g;
}

interface Frame {
  size: number;
  minY: number;
}

/** Bakes each species into FRAMES frames: VIEWS round the trunk, then one from straight above. */
class TreeAtlas {
  readonly albedo: Texture;
  readonly normal: Texture;
  readonly frames: Frame[] = [];

  constructor(renderer: WebGPURenderer, sources: Group[], px: number) {
    const target = new RenderTarget(px * FRAMES, px * sources.length, { count: 2, type: UnsignedByteType, depthBuffer: true, generateMipmaps: true, magFilter: LinearFilter });
    const [albedo, normal] = target.textures as [Texture, Texture];
    // The MRT outputs are matched to the target's textures by name.
    albedo.name = 'albedo';
    normal.name = 'normal';
    this.albedo = albedo;
    this.normal = normal;
    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, 0, 0.01, 10);
    const box = new Box3();
    const prevTarget = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT();
    const prevAutoClear = renderer.autoClear;
    const prevClear = renderer.getClearColor(new Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setMRT(mrt({ albedo: vec4(diffuseColor.rgb, 1), normal: vec4(normalWorld.mul(0.5).add(0.5), 1) }));
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.autoClear = false;
    const look = new Vector3();
    sources.forEach((src, s) => {
      box.setFromObject(src);
      const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * Math.SQRT2;
      const size = Math.max(2 * reach, box.max.y - box.min.y) * 1.02;
      this.frames.push({ size, minY: box.min.y });
      scene.add(src);
      for (let v = 0; v < FRAMES; v++) {
        if (v < VIEWS) {
          camera.left = -size / 2;
          camera.right = size / 2;
          camera.bottom = 0;
          camera.top = size;
          const a = (v / VIEWS) * Math.PI * 2;
          camera.position.set(Math.sin(a) * size * 2, box.min.y, Math.cos(a) * size * 2);
          camera.up.set(0, 1, 0);
          camera.lookAt(look.set(0, box.min.y, 0));
        } else {
          // Straight down, screen right = +x, screen up = −z.
          camera.left = -size / 2;
          camera.right = size / 2;
          camera.bottom = -size / 2;
          camera.top = size / 2;
          camera.position.set(0, box.max.y + size, 0);
          camera.up.set(0, 0, -1);
          camera.lookAt(look.set(0, 0, 0));
        }
        camera.near = 0.01;
        camera.far = size * 4 + box.max.y;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        target.viewport.set(v * px, s * px, px, px);
        target.scissor.set(v * px, s * px, px, px);
        target.scissorTest = true;
        renderer.render(scene, camera);
      }
      scene.remove(src);
    });
    target.scissorTest = false;
    renderer.autoClear = prevAutoClear;
    renderer.setMRT(prevMRT);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
  }
}

export interface ForestRing {
  /** Instances per side and their cell spacing (m). */
  n: number;
  spacingM: number;
  /** Leave this much round the camera to the ring inside it (m); 0 for the innermost. */
  innerM: number;
  /** Size multiplier: the outer rings draw fewer, slightly larger trees standing for the rest. */
  sizeK: number;
}

export class Forest {
  readonly meshes: Mesh[] = [];

  constructor(renderer: WebGPURenderer, tex: TerrainTextures, shadow: Texture | null, rings: ForestRing[], atlasPx: number) {
    const atlas = new TreeAtlas(renderer, [spruce(11), pine(23), broadleaf(37)], atlasPx);
    const species = atlas.frames.length;
    const frames = uniformArray(atlas.frames.map((f) => new Vector2(f.size, f.minY)), 'vec2');
    for (const ring of rings) {
      const g = new InstancedBufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
      g.setAttribute('corner', new BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.instanceCount = ring.n * ring.n;
      const m = this.material(atlas, frames, species, tex, shadow, ring);
      const mesh = new Mesh(g, m);
      mesh.name = `forest ${ring.spacingM} m`;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
    }
  }

  private material(atlas: TreeAtlas, frames: ReturnType<typeof uniformArray>, species: number, tex: TerrainTextures, shadow: Texture | null, ring: ForestRing): MeshStandardNodeMaterial {
    const m = new MeshStandardNodeMaterial({ name: 'forest', roughness: 0.9, metalness: 0, alphaTest: 0.5, side: DoubleSide });
    const N = ring.n;
    const s = ring.spacingM;
    const idx = float(instanceIndex);
    const ix = mod(idx, N);
    const iz = floor(idx.div(N));
    const cell = floor(cameraPosition.xz.div(s)).add(vec2(ix, iz)).sub(N / 2);
    // Per-cell randoms. Not TSL's hash(): it converts its seed to an unsigned integer, so every cell west
    // or north of the origin (negative coordinates) would share one value — rows of identical trees.
    const cellHash = (c: V2, k: number): F => fract(sin(c.dot(vec2(12.9898 + k * 1.37, 78.233 + k * 2.71)).add(k * 0.618)).mul(43758.5453));
    const h = (k: number): F => cellHash(cell, k);
    // Anywhere in its cell: with less jitter the rows of the grid show, an orchard instead of a forest.
    const xz = cell.add(vec2(h(1), h(2))).mul(s);
    // Forest density from the near land-cover map (no trees on water or bare rock), and the ring's band.
    const uvN = xz.div(TERRAIN.nearSizeM).add(0.5);
    const cov = texture(tex.nearCover, uvN).level(float(0));
    const density = cov.r.mul(float(1).sub(cov.a)).mul(float(1).sub(cov.g.mul(0.8)));
    const inside = max(xz.x.abs(), xz.y.abs()).lessThan(TERRAIN.nearSizeM / 2 - 200);
    // Stands and clearings: a coarser hash (cells of ~6 × 6 trees) thins or fills the cover, and a few
    // gaps everywhere break up what is left of the grid.
    const stand = cellHash(floor(cell.div(6)), 9);
    const local = density.mul(stand.mul(0.7).add(0.55));
    const gap = h(7).greaterThan(0.84);
    const exists = select(inside.and(gap.not()), smoothstep(h(3), h(3).add(0.08), local.mul(1.1).sub(0.08)), float(0));
    const d = length(xz.sub(cameraPosition.xz));
    const outer = (N / 2 - 1.5) * s;
    const band = float(1).sub(smoothstep(outer * 0.8, outer, d)).mul(ring.innerM > 0 ? smoothstep(ring.innerM * 0.85, ring.innerM, d) : float(1));
    // Sizes from saplings to old trees (squared hash: mostly middling, a few big ones).
    const scale = h(4).mul(h(4)).mul(0.8).add(0.65).mul(ring.sizeK).mul(exists).mul(band);
    const sp = floor(h(5).mul(species)).min(species - 1);
    const yaw = h(6).mul(Math.PI * 2);
    const frame = frames.element(sp.toInt()) as unknown as V2;
    const size = frame.x.mul(scale);
    const ground = terrainHeightNode(tex.nearHeight, tex.farHeight, xz);
    const centre = vec3(xz.x, ground.add(frame.y.add(frame.x.mul(0.5)).mul(scale)), xz.y);
    // A billboard facing the camera in all three axes, so from above it lies down and shows the crown.
    const toCam = cameraPosition.sub(centre);
    const flat = vec2(toCam.x, toCam.z);
    const right = normalize(vec3(toCam.z, 0, toCam.x.negate()).add(vec3(1e-4, 0, 0)));
    const up = normalize(cross(normalize(toCam), right));
    const c = attribute('corner', 'vec2');
    m.positionNode = centre.add(right.mul(c.x.mul(size))).add(up.mul(c.y.mul(size)));
    // Which baked views: the two side views nearest the camera's bearing round the trunk, and the top
    // view, weighted in by the camera's elevation over the tree.
    const elevation = atan(toCam.y, length(flat));
    const topW = varying(smoothstep(0.65, 1.15, elevation), 'vTreeTop');
    const phi = atan(flat.x, flat.y).sub(yaw);
    const f = mod(phi.div(Math.PI * 2).mul(VIEWS), VIEWS);
    const f0 = floor(f);
    const f1 = mod(f0.add(1), VIEWS);
    const cu = c.x.add(0.5);
    // Render-target textures are addressed from the top on both backends (three flips WebGL's to match),
    // so a frame's bottom — the tree's base — is at the larger v.
    const row = sp.add(float(0.5).sub(c.y)).div(species);
    const uv0 = varying(vec2(f0.add(cu).div(FRAMES), row), 'vTreeUv0');
    const uv1 = varying(vec2(f1.add(cu).div(FRAMES), row), 'vTreeUv1');
    const blend = varying(fract(f), 'vTreeBlend');
    // Top view: the quad corner's horizontal offset from the trunk, turned into the tree's own frame.
    const off = right.mul(c.x).add(up.mul(c.y));
    const cy = cos(yaw);
    const sy = sin(yaw);
    const lx = off.x.mul(cy).sub(off.z.mul(sy));
    const lz = off.x.mul(sy).add(off.z.mul(cy));
    // Top view: screen up was −z, and v runs downwards, so −z is the smaller v.
    const uvTop = varying(vec2(float(VIEWS).add(lx.add(0.5)).div(FRAMES), sp.add(lz.add(0.5)).div(species)), 'vTreeUvTop');
    const vYaw = varying(yaw, 'vTreeYaw');
    const a0 = texture(atlas.albedo, uv0);
    const a1 = texture(atlas.albedo, uv1);
    const at = texture(atlas.albedo, uvTop);
    const side = mix(a0, a1, blend);
    const all = mix(side, at, topW);
    m.colorNode = all.rgb;
    m.opacityNode = all.a;
    const n0 = texture(atlas.normal, uv0).rgb.mul(2).sub(1);
    const n1 = texture(atlas.normal, uv1).rgb.mul(2).sub(1);
    const nt = texture(atlas.normal, uvTop).rgb.mul(2).sub(1);
    const nObj = normalize(mix(mix(n0, n1, blend), nt, topW));
    const cv = cos(vYaw);
    const sv = sin(vYaw);
    const nW: V3 = vec3(nObj.x.mul(cv).add(nObj.z.mul(sv)), nObj.y, nObj.x.negate().mul(sv).add(nObj.z.mul(cv)));
    m.normalNode = normalize(cameraViewMatrix.mul(vec4(nW, 0)).xyz);
    if (shadow) {
      // The ridges' shadow on the trees, as on the ground they stand on (clouds.shadeReceivers adds its own).
      const vis = texture(shadow, positionWorld.xz.div(TERRAIN.nearSizeM).add(0.5));
      m.receivedShadowNode = ((sh: Node<'vec4'>) => sh.mul(vis.r)) as unknown as () => Node;
      m.userData.shadowFactor = vis.r;
      m.aoNode = vis.g.mul(0.5).add(0.5);
    }
    return m;
  }
}
