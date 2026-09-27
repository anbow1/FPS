import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { float, Fn, length, Loop, mrt, output, pass, pow, saturation, smoothstep, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, AgXToneMapping, HalfFloatType, PCFShadowMap, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, type Texture, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import { setMaxAnisotropy } from './textureSet.ts';
import { LAGOON_CAMERA } from '../config.ts';

// Renderer and post chain for the lagoon (rules §2.1, §2.5): HDR half-float
// scene pass with a velocity MRT → TRAA (High) → screen-space sun shafts, the
// Mitchell-style radial light scattering of GPU Gems 3 ch. 13, masked to sky
// pixels so palm fronds cut the beams → physical bloom → a gentle grade and
// vignette → exposure, ACES tone map and sRGB once in the output stage.
// The HUD is DOM, so nothing here touches it.

export type Quality = 'high' | 'low';
export type ToneMap = 'aces' | 'agx';

export interface StageSettings {
  quality: Quality;
  renderScale: number;
  toneMap: ToneMap;
}

const SHAFT_SAMPLES = { high: 40, low: 20 } as const;

export class LagoonStage {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Screen position of the sun (uv) and how strongly shafts are drawn. */
  readonly sunScreen = uniform(new Vector2(0.5, 0.5));
  readonly shaftStrength = uniform(0);
  readonly saturationAmount = uniform(1.08);
  private pipeline: RenderPipeline | null = null;
  private sceneTexture: Texture | null = null;
  private settings: StageSettings;
  private readonly tmp = new Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    settings: StageSettings,
  ) {
    this.settings = { ...settings };
    this.renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.camera = new PerspectiveCamera(LAGOON_CAMERA.verticalFovDeg, 16 / 9, LAGOON_CAMERA.nearM, LAGOON_CAMERA.farM);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    setMaxAnisotropy(this.renderer.getMaxAnisotropy());
    this.applySettings(this.settings);
  }

  get backendName(): string {
    const backend: unknown = this.renderer.backend;
    const isWebGpu = typeof backend === 'object' && backend !== null && 'isWebGPUBackend' in backend;
    return isWebGpu ? 'WebGPU' : 'WebGL2 (fallback)';
  }

  get hdrTexture(): Texture | null {
    return this.sceneTexture;
  }

  get quality(): Quality {
    return this.settings.quality;
  }

  applySettings(s: StageSettings): void {
    this.settings = { ...s };
    // ACES by default: it keeps the lagoon's turquoise and the jungle greens punchy.
    // AgX stays as the A/B for the sunset sky, where ACES pushes orange toward yellow.
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
        const d = depth.sample(coord).r;
        // Reversed depth: the sky sits at 0.
        const sky = float(1).sub(smoothstep(0.0, 1e-6, d));
        sum.addAssign(colour.sample(coord).rgb.mul(sky).mul(decay));
        decay.mulAssign(0.955);
      });
      return vec4(sum.mul(strength.div(samples)), 0);
    })();

    const lit = aa.add(shafts);
    const glare = bloom(lit, high ? 0.08 : 0.05, 0.4, 0);
    const combined = saturation(lit.add(glare), this.saturationAmount);
    const r = length(uv().sub(vec2(0.5)).mul(vec2(1.25, 1)));
    const vignette = float(1).sub(pow(r, 2.6).mul(0.42));
    const graded = vec4(combined.mul(vignette), 1);
    const pipeline = new RenderPipeline(this.renderer);
    pipeline.outputNode = high ? sharpen(graded, 0.25) : graded;
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

  /** Where the light source is on screen, and whether its shafts show. */
  aimShafts(lightDir: { x: number; y: number; z: number }, amount: number): void {
    const cam = this.camera;
    this.tmp.set(lightDir.x, lightDir.y, lightDir.z).multiplyScalar(1000).add(cam.position);
    this.tmp.project(cam);
    const inFront = this.tmp.z < 1 && this.tmp.z > -1;
    const edge = Math.max(Math.abs(this.tmp.x), Math.abs(this.tmp.y));
    const onScreen = inFront ? 1 - smooth(1.0, 1.8, edge) : 0;
    this.sunScreen.value.set(this.tmp.x * 0.5 + 0.5, 0.5 - this.tmp.y * 0.5);
    this.shaftStrength.value = amount * onScreen;
  }

  setExposure(multiplier: number): void {
    this.renderer.toneMappingExposure = multiplier;
  }

  render(): void {
    if (!this.pipeline) throw new Error('stage.render() before init()');
    this.pipeline.render();
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
