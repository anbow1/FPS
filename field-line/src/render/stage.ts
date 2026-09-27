import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { mrt, output, pass, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, AgXToneMapping, HalfFloatType, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, type Texture, WebGPURenderer } from 'three/webgpu';
import { CAMERA } from '../config.ts';
import { setMaxAnisotropy } from './textures.ts';

// Renderer and post chain (rules §2.1, §2.5). One code path: WebGPURenderer
// falls back to its WebGL2 backend by itself. The scene pass renders HDR half
// float with a velocity MRT; TRAA and bloom run in HDR; exposure, tone mapping
// and sRGB happen once, in the pipeline's output transform; CAS-style
// sharpening wins back what TAA softens. The HUD is DOM, so it never blooms.
//
// Not in the chain yet: GTAO, SSR, motion blur and a colour-grade LUT. They are
// listed as missing in the report rather than faked here.

export type Quality = 'high' | 'low';
export type ToneMap = 'aces' | 'agx';

export interface StageSettings {
  quality: Quality;
  renderScale: number; // 1.0 default; 1.25–1.5 supersamples on High
  toneMap: ToneMap;
}

export class Stage {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private pipeline: RenderPipeline | null = null;
  private sceneTexture: Texture | null = null;
  private settings: StageSettings;

  constructor(
    readonly canvas: HTMLCanvasElement,
    settings: StageSettings,
  ) {
    this.settings = { ...settings };
    // Reversed depth: a 4 cm near plane and a 2.6 km far plane without z-fighting at range.
    this.renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.camera = new PerspectiveCamera(CAMERA.verticalFovDeg, 16 / 9, CAMERA.nearM, CAMERA.farM);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    setMaxAnisotropy(this.renderer.getMaxAnisotropy());
    this.applySettings(this.settings);
    this.resize();
  }

  get backendName(): string {
    const backend: unknown = this.renderer.backend;
    const isWebGpu = typeof backend === 'object' && backend !== null && 'isWebGPUBackend' in backend;
    return isWebGpu ? 'WebGPU' : 'WebGL2 (fallback)';
  }

  /** HDR colour of the last scene pass, before exposure: auto exposure meters this. */
  get hdrTexture(): Texture | null {
    return this.sceneTexture;
  }

  applySettings(s: StageSettings): void {
    this.settings = { ...s };
    // ACES by default (rules §2.1); AgX kept as the A/B for fire and sky.
    this.renderer.toneMapping = s.toneMap === 'agx' ? AgXToneMapping : ACESFilmicToneMapping;
    this.buildPipeline();
    this.resize();
  }

  private buildPipeline(): void {
    const scenePass = pass(this.scene, this.camera, { type: HalfFloatType });
    scenePass.setMRT(mrt({ output, velocity }));
    const colour = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const motion = scenePass.getTextureNode('velocity');
    this.sceneTexture = scenePass.getTexture('output');
    const high = this.settings.quality === 'high';
    const aa = high ? traa(colour, depth, motion, this.camera) : colour;
    // Physical bloom: no threshold, a small share of the blurred HDR image (lens glare), not a glow filter.
    const glare = bloom(aa, high ? 0.06 : 0.04, 0.35, 0);
    const combined = aa.add(glare);
    const pipeline = new RenderPipeline(this.renderer);
    pipeline.outputNode = high ? sharpen(combined, 0.3) : combined;
    this.pipeline?.dispose();
    this.pipeline = pipeline;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(window.devicePixelRatio * this.settings.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Exposure multiplier from the adapted eye; applied in the output transform, once. */
  setExposure(multiplier: number): void {
    this.renderer.toneMappingExposure = multiplier;
  }

  render(): void {
    if (!this.pipeline) throw new Error('stage.render() before init()');
    this.pipeline.render();
  }
}
