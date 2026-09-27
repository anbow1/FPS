import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { float, Fn, length, Loop, mrt, output, pass, pow, saturation, smoothstep, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, AgXToneMapping, HalfFloatType, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, type Texture, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import { CAMERA } from '../config.ts';
import { setMaxAnisotropy } from './textures.ts';

// Renderer and post chain (rules §2.1, §2.5). One code path: WebGPURenderer
// falls back to its WebGL2 backend by itself. The scene pass renders HDR half
// float with a velocity MRT; TRAA and bloom run in HDR; exposure, tone mapping
// and sRGB happen once, in the pipeline's output transform; CAS-style
// sharpening wins back what TAA softens. The HUD is DOM, so it never blooms.
// Screen-space sun shafts (radial light scattering, GPU Gems 3 ch. 13) sample
// only sky pixels, so pine crowns and buildings cut the beams; a light grade
// (saturation, vignette) runs in HDR before the output transform.
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

const SHAFT_SAMPLES = { high: 40, low: 20 } as const;

export class Stage {
  /** Screen position of the sun (uv) and how strongly its shafts are drawn. */
  readonly sunScreen = uniform(new Vector2(0.5, 0.5));
  readonly shaftStrength = uniform(0);
  private readonly tmp = new Vector3();
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
    const samples = SHAFT_SAMPLES[this.settings.quality];
    const sunUv = this.sunScreen;
    const strength = this.shaftStrength;
    const shafts = Fn(() => {
      const start = uv();
      const step = start.sub(sunUv).mul(0.85 / samples);
      const coord = start.toVar();
      const decay = float(1).toVar();
      const sum = vec3(0).toVar();
      Loop(samples, () => {
        coord.subAssign(step);
        // Reversed depth: the sky sits at 0.
        const sky = float(1).sub(smoothstep(0.0, 1e-6, depth.sample(coord).r));
        sum.addAssign(colour.sample(coord).rgb.mul(sky).mul(decay));
        decay.mulAssign(0.955);
      });
      return vec4(sum.mul(strength.div(samples)), 0);
    })();
    const lit = aa.add(shafts);
    // Physical bloom: no threshold, a small share of the blurred HDR image (lens glare), not a glow filter.
    const glare = bloom(lit, high ? 0.06 : 0.04, 0.35, 0);
    // Grade: a touch of saturation and a soft optical vignette, tuned by eye.
    const r = length(uv().sub(vec2(0.5)).mul(vec2(1.25, 1)));
    const graded = vec4(saturation(lit.add(glare), 1.05).mul(float(1).sub(pow(r, 2.6).mul(0.35))), 1);
    const pipeline = new RenderPipeline(this.renderer);
    pipeline.outputNode = high ? sharpen(graded, 0.3) : graded;
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

  /** Where the sun is on screen, and how much of its shafts to draw (0 behind the camera or off screen). */
  aimShafts(sunDir: { x: number; y: number; z: number }, amount: number): void {
    const cam = this.camera;
    this.tmp.set(sunDir.x, sunDir.y, sunDir.z).multiplyScalar(1000).add(cam.position).project(cam);
    const inFront = this.tmp.z < 1 && this.tmp.z > -1;
    const edge = Math.max(Math.abs(this.tmp.x), Math.abs(this.tmp.y));
    const t = Math.min(1, Math.max(0, (edge - 1) / 0.8));
    this.sunScreen.value.set(this.tmp.x * 0.5 + 0.5, 0.5 - this.tmp.y * 0.5);
    this.shaftStrength.value = inFront ? amount * (1 - t * t * (3 - 2 * t)) : 0;
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
