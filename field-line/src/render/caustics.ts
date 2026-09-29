import { dFdx, dFdy, float, length, max, mix, positionLocal, refract, texture, varying, vec2, vec3, vec4 } from 'three/tsl';
import {
  Color,
  CustomBlending,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  RepeatWrapping,
  Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { rippleNormalMap } from './waterPatterns.ts';
import { W } from './waterUniforms.ts';

// Caustics on the lake bed by rasterised photon splatting (Evan Wallace's
// "WebGL Water"; also Tidewater, Dan Greenheck, MIT), ported from Castaway
// Lagoon. A grid over one tile of the water's ripples is drawn into a small
// offscreen target every frame: each vertex refracts the sun through the
// rippled surface and moves to where the ray lands on a floor plane below;
// the fragment writes (area on the surface ÷ area on the floor), additively —
// the light concentration, so the bright network forms where rays converge and
// moves with the same ripples the water shows. Two planes (R shallow, G deep)
// are blended by the real depth at lookup.

/** World size of one caustic tile: the water's two ripple layers repeat 1× and 3× across it. */
export const CAUSTIC_TILE_M = 7.5;
export const RIPPLE_TILE_M = { coarse: CAUSTIC_TILE_M, fine: CAUSTIC_TILE_M / 3 } as const;
const PLANES_M = [0.4, 1.2] as const;
const MARGIN = 0.25;
const WATER_IOR = 1.333;
/** The splat steepens the ripples: at lake depths their drawn slopes focus too little to show. */
const CAUSTIC_SLOPE_GAIN = 1.8;

/** The water's detail slope at ripple-tile coordinate q (same layers as the water surface). */
export function rippleSlope(q: Node<'vec2'>, level: boolean): Node<'vec2'> {
  const tex = rippleNormalMap();
  const windLen = length(W.wind).max(0.1);
  const flow = W.wind.div(windLen).mul(W.time);
  const t1 = texture(tex, q.add(flow.mul(0.022)));
  const t2 = texture(tex, q.mul(RIPPLE_TILE_M.coarse / RIPPLE_TILE_M.fine).sub(flow.mul(0.037)).add(vec2(0.3, 0.7)));
  const d1 = (level ? t1.level(float(0)) : t1).xy.sub(0.5);
  const d2 = (level ? t2.level(float(0)) : t2).xy.sub(0.5);
  return d1.add(d2.mul(0.7)).mul(float(0.25).add(windLen.mul(0.04)));
}

/** Refracted sun ray under a surface with slope (sx, sz): horizontal travel per metre of depth. */
function refractedShift(slope: Node<'vec2'>): Node<'vec2'> {
  const N = vec3(slope.x, 1, slope.y.negate()).normalize();
  const R = refract(W.sunDir.normalize().negate(), N, 1 / WATER_IOR);
  return R.xz.div(max(R.y.negate(), 0.2));
}

export class Caustics {
  readonly target: RenderTarget;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly clearColour = new Color();

  constructor(quality: 'high' | 'low') {
    const px = quality === 'high' ? 256 : 128;
    this.target = new RenderTarget(px, px, { type: HalfFloatType, depthBuffer: false });
    const tex = this.target.texture;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    const cells = Math.ceil((quality === 'high' ? 128 : 64) * (1 + 2 * MARGIN));
    const grid = new PlaneGeometry(1 + 2 * MARGIN, 1 + 2 * MARGIN, cells, cells).translate(0.5, 0.5, 0);
    PLANES_M.forEach((depthM, i) => {
      const mesh = new Mesh(grid, this.material(depthM, i));
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    });
  }

  private material(depthM: number, channel: number): MeshBasicNodeMaterial {
    // Double-sided: flipping Y reverses the winding, and refraction can fold triangles over.
    const m = new MeshBasicNodeMaterial({ name: `caustics-${depthM}m`, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide });
    m.blending = CustomBlending;
    m.blendSrc = OneFactor;
    m.blendDst = OneFactor;
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneFactor;
    const q = positionLocal.xy;
    const shift = refractedShift(rippleSlope(q, true).mul(CAUSTIC_SLOPE_GAIN)).sub(refractedShift(vec2(0, 0)));
    const landed = q.add(shift.mul(depthM / CAUSTIC_TILE_M));
    // Texel row 0 is NDC y = +1 on both backends: write y inverted so tile coordinate = texture uv.
    m.vertexNode = vec4(landed.x.mul(2).sub(1), float(1).sub(landed.y.mul(2)), 0, 1);
    const rest = varying(q, 'vCausticRest');
    const land = varying(landed, 'vCausticLand');
    const before = length(dFdx(rest)).mul(length(dFdy(rest)));
    const after = length(dFdx(land)).mul(length(dFdy(land))).max(1e-9);
    const intensity = before.div(after).min(8);
    m.colorNode = channel === 0 ? vec3(intensity, 0, 0) : vec3(0, intensity, 0);
    m.opacityNode = float(1);
    return m;
  }

  /** Redraws the caustic tile for this frame's ripples and sun. */
  render(renderer: WebGPURenderer): void {
    const previous = renderer.getRenderTarget();
    renderer.getClearColor(this.clearColour);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    renderer.setClearColor(this.clearColour, clearAlpha);
  }
}

/** Caustic light factor (mean ≈ 1) on the bed at p, `depth` m under the surface. */
export function causticAt(caustics: Caustics, p: Node<'vec3'>, depth: Node<'float'>): Node<'float'> {
  const entry = p.xz.sub(refractedShift(vec2(0, 0)).mul(depth));
  const c = texture(caustics.target.texture, entry.div(CAUSTIC_TILE_M));
  const k = depth.sub(PLANES_M[0]).div(PLANES_M[1] - PLANES_M[0]).clamp(0, 1);
  return mix(c.r, c.g, k);
}
