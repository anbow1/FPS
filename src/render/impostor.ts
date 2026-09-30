import {
  atan,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  diffuseColor,
  dot,
  float,
  floor,
  fract,
  length,
  mix,
  mod,
  mrt,
  normalize,
  normalWorld,
  positionWorld,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  texture,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  Box3,
  BufferAttribute,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  type Node,
  type NodeMaterial,
  type Object3D,
  OrthographicCamera,
  RenderTarget,
  Scene,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

// Tree impostors, shared file for file by Field Line, Castaway Lagoon and Tanks
// (docs/graphics-playbook.md §5.5). At load every species is rendered from
// `views` directions around its vertical axis into one atlas — unlit albedo
// with alpha, and object-space normals — through an MRT, so the impostor is lit
// at run time by the real sun, sky, shadows and fog. Far trees then draw as ONE
// instanced mesh of camera-facing quads: each picks the two baked views nearest
// to its own viewing angle and blends them, so a tree seen while walking round
// it turns smoothly instead of popping between eight pictures.
//
// Hand-over with the full meshes is a complementary screen-space dither over a
// distance band: the mesh keeps the pixels where a per-pixel threshold is above
// the fade, the impostor the others, so together they always cover each pixel
// exactly once and TAA smooths the pattern.

type F = Node<'float'>;

/** Interleaved-gradient noise per pixel (Jimenez 2014): the dither threshold, 0..1. */
export const ditherThreshold = (): F => fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189));

/** Horizontal distance from the camera to the shaded pixel. */
const flatDistance = (): F => length(positionWorld.xz.sub(cameraPosition.xz));

/**
 * Makes a full-detail material dissolve (dithered) as the pixel's distance crosses [fromM, toM],
 * the band where the impostors fade in. Needs alpha testing: opaque materials get alphaTest 0.5.
 */
export function ditherOutBeyond(mat: NodeMaterial, fromM: number, toM: number): void {
  const fade = smoothstep(fromM, toM, flatDistance());
  const keep = ditherThreshold().greaterThanEqual(fade);
  const base = mat.opacityNode ?? float(1);
  mat.opacityNode = select(keep, base, float(0));
  if (mat.alphaTest === 0) mat.alphaTest = 0.5;
  mat.needsUpdate = true;
}

export interface ImpostorOptions {
  /** Baked directions around the vertical axis. */
  views: number;
  /** Side of one baked frame, px. */
  framePx: number;
}

/** A species' square frame, in the object's own units: its side and where its bottom sits. */
interface FrameInfo {
  size: number;
  minY: number;
}

export class ImpostorAtlas {
  readonly albedo: Texture;
  readonly normal: Texture;
  readonly frames: FrameInfo[] = [];
  private readonly target: RenderTarget;

  /** Bakes every source (a group of meshes around its own origin, base at y≈0) into the atlas. */
  constructor(
    renderer: WebGPURenderer,
    sources: readonly Object3D[],
    readonly opts: ImpostorOptions,
  ) {
    const px = opts.framePx;
    const w = px * opts.views;
    const h = px * sources.length;
    this.target = new RenderTarget(w, h, { count: 2, type: UnsignedByteType, depthBuffer: true, generateMipmaps: true, magFilter: LinearFilter });
    const [albedo, normal] = this.target.textures as [Texture, Texture];
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
    const lookAt = new Vector3();
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_colour);
    renderer.setRenderTarget(this.target);
    // unlit albedo with coverage, and the object-space normal packed into 0..1
    renderer.setMRT(mrt({ albedo: vec4(diffuseColor.rgb, 1), normal: vec4(normalWorld.mul(0.5).add(0.5), 1) }));
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.autoClear = false;
    sources.forEach((src, s) => {
      box.setFromObject(src);
      const r = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * Math.SQRT2;
      const size = Math.max(2 * r, box.max.y - box.min.y) * 1.02;
      this.frames.push({ size, minY: box.min.y });
      camera.left = -size / 2;
      camera.right = size / 2;
      camera.bottom = 0;
      camera.top = size;
      camera.near = 0.01;
      camera.far = size * 4;
      camera.updateProjectionMatrix();
      scene.add(src);
      for (let v = 0; v < opts.views; v++) {
        const a = (v / opts.views) * Math.PI * 2;
        camera.position.set(Math.sin(a) * size * 2, box.min.y, Math.cos(a) * size * 2);
        camera.lookAt(lookAt.set(0, box.min.y, 0));
        camera.updateMatrixWorld();
        this.target.viewport.set(v * px, s * px, px, px);
        this.target.scissor.set(v * px, s * px, px, px);
        this.target.scissorTest = true;
        renderer.render(scene, camera);
      }
      scene.remove(src);
    });
    this.target.scissorTest = false;
    this.target.viewport.set(0, 0, w, h);
    renderer.autoClear = prevAutoClear;
    renderer.setMRT(prevMRT);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(_colour, prevClearAlpha);
  }

  get species(): number {
    return this.frames.length;
  }

  dispose(): void {
    this.target.dispose();
  }
}

export interface ImpostorInstance {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  /** Uniform scale of the source object. */
  scale: number;
  species: number;
  /** Left out of the impostors (a felled tree): call refresh() after changing it. */
  hidden?: boolean;
}

export interface ImpostorFieldOptions {
  /** Impostors start here (m): the full meshes dissolve over [nearM − fadeM, nearM]. */
  nearM: number;
  fadeM: number;
  /** Grid cell (m) the instance list is refilled on. */
  cellM: number;
}

/**
 * All far trees of every species as one instanced draw. The instance list is refilled from a
 * grid whenever the camera crosses into another cell (as InstanceStream does for the meshes),
 * with every tree beyond the start of the fade band.
 */
export class ImpostorField {
  readonly mesh: Mesh;
  readonly material: MeshStandardNodeMaterial;
  private readonly all: readonly ImpostorInstance[];
  private readonly pos: InstancedBufferAttribute;
  private readonly data: InstancedBufferAttribute;
  private readonly geometry: InstancedBufferGeometry;
  private currentCell = Number.NaN;

  constructor(
    atlas: ImpostorAtlas,
    instances: readonly ImpostorInstance[],
    private readonly opts: ImpostorFieldOptions,
  ) {
    this.all = instances;
    const n = Math.max(1, instances.length);
    const g = new InstancedBufferGeometry();
    // one quad; its corners are offsets, the vertex shader builds the billboard in world space
    g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('corner', new BufferAttribute(new Float32Array([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.data = new InstancedBufferAttribute(new Float32Array(n * 3), 3); // yaw, scale, species
    g.setAttribute('iPos', this.pos);
    g.setAttribute('iData', this.data);
    g.instanceCount = 0;
    this.geometry = g;

    const views = atlas.opts.views;
    const species = atlas.species;
    const frames = uniformArray(atlas.frames.map((f) => new Vector2(f.size, f.minY)), 'vec2');
    const m = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, alphaTest: 0.5 });
    m.name = 'impostor';
    const iPos = attribute('iPos', 'vec3');
    const iData = attribute('iData', 'vec3');
    const corner = attribute('corner', 'vec2');
    const yaw = iData.x;
    const scale = iData.y;
    const sp = iData.z;
    const frame = frames.element(sp.toInt()) as unknown as Node<'vec2'>;
    const size = frame.x.mul(scale);
    const toCam = cameraPosition.xz.sub(iPos.xz);
    const d = normalize(toCam);
    const right = vec3(d.y, 0, d.x.negate());
    m.positionNode = iPos.add(right.mul(corner.x.mul(size))).add(vec3(0, frame.y.mul(scale).add(corner.y.mul(size)), 0));
    // the camera's angle round the tree, in the tree's own frame → the two nearest baked views
    const phi = atan(toCam.x, toCam.y).sub(yaw);
    const f = mod(phi.div(Math.PI * 2).mul(views), views);
    const f0 = floor(f);
    const f1 = mod(f0.add(1), views);
    const cu = corner.x.add(0.5);
    const row = sp.add(corner.y).div(species);
    const uv0 = varying(vec2(f0.add(cu).div(views), row), 'vImpUv0');
    const uv1 = varying(vec2(f1.add(cu).div(views), row), 'vImpUv1');
    const blend = varying(fract(f), 'vImpBlend');
    const vYaw = varying(yaw, 'vImpYaw');
    const a0 = texture(atlas.albedo, uv0);
    const a1 = texture(atlas.albedo, uv1);
    m.colorNode = mix(a0.rgb, a1.rgb, blend);
    // complementary dither with the full meshes across the fade band (same per-pixel distance)
    const fade = smoothstep(opts.nearM - opts.fadeM, opts.nearM, flatDistance());
    m.opacityNode = select(ditherThreshold().lessThan(fade), mix(a0.a, a1.a, blend), float(0));
    const n0 = texture(atlas.normal, uv0).rgb.mul(2).sub(1);
    const n1 = texture(atlas.normal, uv1).rgb.mul(2).sub(1);
    const nObj = normalize(mix(n0, n1, blend));
    // baked in the tree's frame: turn by the instance's yaw (three's rotation about +Y)
    const c = cos(vYaw);
    const s = sin(vYaw);
    const nW = vec3(nObj.x.mul(c).add(nObj.z.mul(s)), nObj.y, nObj.x.negate().mul(s).add(nObj.z.mul(c)));
    m.normalNode = normalize(cameraViewMatrix.mul(vec4(nW, 0)).xyz);
    this.material = m;

    this.mesh = new Mesh(g, m);
    this.mesh.name = 'impostors';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
  }

  /** Refill at the next update even if the camera stays in its cell (an instance changed). */
  refresh(): void {
    this.currentCell = Number.NaN;
  }

  /** Refill with every tree beyond the start of the fade band, when the camera changes cell. */
  update(camera: Vector3): void {
    const cell = Math.floor(camera.x / this.opts.cellM) * 100003 + Math.floor(camera.z / this.opts.cellM);
    if (cell === this.currentCell) return;
    this.currentCell = cell;
    // a cell's slack on top of the band, so no tree is missing before the next refill
    const r = Math.max(0, this.opts.nearM - this.opts.fadeM - this.opts.cellM * 0.75);
    const r2 = r * r;
    const p = this.pos.array as Float32Array;
    const q = this.data.array as Float32Array;
    let k = 0;
    for (const t of this.all) {
      if (t.hidden) continue;
      const dx = t.x - camera.x;
      const dz = t.z - camera.z;
      if (dx * dx + dz * dz < r2) continue;
      p[k * 3] = t.x;
      p[k * 3 + 1] = t.y;
      p[k * 3 + 2] = t.z;
      q[k * 3] = t.yawRad;
      q[k * 3 + 1] = t.scale;
      q[k * 3 + 2] = t.species;
      k++;
    }
    this.geometry.instanceCount = k;
    for (const a of [this.pos, this.data]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, k * 3);
      a.needsUpdate = true;
    }
  }
}

const _colour = new Color();
