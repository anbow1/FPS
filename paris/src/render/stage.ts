import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { convertToTexture, dot, float, int, length, mrt, output, pass, pow, saturation, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, HalfFloatType, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { SHOT } from '../config.ts';

// Renderer and post chain (the playbook's §1): one WebGPURenderer (it falls
// back to WebGL2 by itself) with a reversed depth buffer; the scene pass in
// half float with a velocity MRT; TRAA, then motion blur from the same
// velocities at a film camera's 180° shutter (half the frame's travel), bloom
// as a small share of the blurred image with no threshold (lens glare, not a
// glow filter), halation and lateral chromatic aberration (a film camera's
// look), a light grade and vignette, exposure and ACES once in the output
// transform, and a CAS-style sharpen against TAA's softness. Film grain is
// the recorder's (ffmpeg), after the supersampled frame is scaled down.

/** Pre-exposed HDR level above which highlights get halation (a lit lantern, the sun's glint; not a sunlit wall). */
const HALATION_THRESHOLD = 1.6;
const HALATION_AMOUNT = 0.35;
/** Chromatic aberration as a uv shift at r² = 1 (≈ 1.2 px at a 1920 px frame's corner). */
const CA_UV = 0.0025;

export class Stage {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private pipeline: RenderPipeline | null = null;
  /** Debug: render the scene straight to the canvas, without the post chain. */
  direct = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly shutter: number,
  ) {
    this.renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.camera = new PerspectiveCamera(SHOT.verticalFovDeg, 16 / 9, SHOT.nearM, SHOT.farM);
    this.scene.add(this.camera);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    this.build();
  }

  get backendName(): string {
    const backend: unknown = this.renderer.backend;
    return typeof backend === 'object' && backend !== null && 'isWebGPUBackend' in backend ? 'WebGPU' : 'WebGL2';
  }

  private build(): void {
    const scenePass = pass(this.scene, this.camera, { type: HalfFloatType });
    scenePass.setMRT(mrt({ output, velocity }));
    const colour = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const motion = scenePass.getTextureNode('velocity');
    const aa = traa(colour, depth, motion, this.camera);
    // NDC velocity → uv offset (y flips), at the shutter's share of the frame.
    const v = motion.sample(uv()).xy;
    const blurUv = vec2(v.x.mul(0.5), v.y.mul(-0.5)).mul(this.shutter);
    const blurred = this.shutter > 0 ? motionBlur(convertToTexture(aa), blurUv, int(12)) : aa;
    const glare = bloom(blurred, 0.05, 0.4, 0);
    // Halation (after the film look of mexicat/pdoom-video): light that crossed the emulsion scatters back off
    // the film base as a red-orange fringe round the highlights only — lanterns, brake lights, the sun on glass.
    const halo = bloom(blurred, 0.9, 0.55, HALATION_THRESHOLD);
    const halation = vec3(1, 0.18, 0.04).mul(dot(halo.rgb, vec3(0.2126, 0.7152, 0.0722))).mul(HALATION_AMOUNT);
    const lit = convertToTexture(vec4(saturation(blurred.add(glare).rgb.add(halation), 1.06), 1));
    // Lateral chromatic aberration: red and blue land a little apart toward the frame's edge (~1.2 px at the
    // corners of a 1080p frame), growing with the square of the radius as a lens's does.
    const d = uv().sub(vec2(0.5));
    const shift = d.mul(dot(d, d)).mul(CA_UV);
    const fringed = vec3(lit.sample(uv().add(shift)).r, lit.sample(uv()).g, lit.sample(uv().sub(shift)).b);
    const r = length(d.mul(vec2(1.3, 1)));
    const graded = fringed.mul(float(1).sub(pow(r, 2.4).mul(0.32)));
    // Grain is not drawn here: the recorder adds it in ffmpeg after the downscale (grain in the page makes every
    // frame incompressible and, rendered supersampled, would be averaged away).
    const sharp = sharpen(vec4(graded, 1), 0.3);
    const pipeline = new RenderPipeline(this.renderer);
    pipeline.outputNode = sharp;
    const dbg = new URLSearchParams(location.search).get('post');
    if (dbg === 'scene') pipeline.outputNode = colour;
    if (dbg === 'aa') pipeline.outputNode = aa;
    if (dbg === 'vel') pipeline.outputNode = vec4(v.abs().mul(20), 0, 1);
    if (dbg === 'depth') pipeline.outputNode = vec4(depth.sample(uv()).r.mul(50), 0, 0, 1);
    if (dbg === 'graded') pipeline.outputNode = vec4(graded, 1);
    this.pipeline = pipeline;
  }

  /** Sets the canvas's drawing size in pixels (a recording's resolution, or the window's). */
  setSize(width: number, height: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setExposure(multiplier: number): void {
    this.renderer.toneMappingExposure = multiplier;
  }

  render(): void {
    if (!this.pipeline) throw new Error('Stage.render() before init()');
    if (this.direct) this.renderer.render(this.scene, this.camera);
    else this.pipeline.render();
  }
}
