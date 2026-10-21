import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { convertToTexture, float, fract, int, length, mrt, output, pass, pow, saturation, screenCoordinate, sin, dot, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, HalfFloatType, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { SHOT } from '../config.ts';

// Renderer and post chain (the playbook's §1): one WebGPURenderer (it falls
// back to WebGL2 by itself) with a reversed depth buffer; the scene pass in
// half float with a velocity MRT; TRAA, then motion blur from the same
// velocities at a film camera's 180° shutter (half the frame's travel), bloom
// as a small share of the blurred image with no threshold (lens glare, not a
// glow filter), a light grade and vignette, exposure and ACES once in the
// output transform, and a CAS-style sharpen against TAA's softness. A faint
// grain keeps the gradients of the evening sky from banding in the video.

export class Stage {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Frame counter for the grain (so it moves deterministically in a recording). */
  private readonly frame = uniform(0);
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
    const r = length(uv().sub(vec2(0.5)).mul(vec2(1.3, 1)));
    const graded = saturation(blurred.add(glare), 1.06).mul(float(1).sub(pow(r, 2.4).mul(0.32)));
    // Film grain: ±0.6 % of the level, a fresh pattern every frame.
    const seed = screenCoordinate.xy.add(vec2(this.frame.mul(37.1), this.frame.mul(17.3)));
    const grain = fract(sin(dot(seed, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(0.012);
    const sharp = sharpen(vec4(graded.rgb, 1), 0.25);
    const pipeline = new RenderPipeline(this.renderer);
    pipeline.outputNode = vec4(sharp.rgb.mul(vec3(float(1).add(grain))), 1);
    const dbg = new URLSearchParams(location.search).get('post');
    if (dbg === 'scene') pipeline.outputNode = colour;
    if (dbg === 'aa') pipeline.outputNode = aa;
    if (dbg === 'vel') pipeline.outputNode = vec4(v.abs().mul(20), 0, 1);
    if (dbg === 'depth') pipeline.outputNode = vec4(depth.sample(uv()).r.mul(50), 0, 0, 1);
    if (dbg === 'graded') pipeline.outputNode = vec4(graded.rgb, 1);
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
    this.frame.value += 1;
    if (this.direct) this.renderer.render(this.scene, this.camera);
    else this.pipeline.render();
  }
}
