import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { float, Fn, int, length, Loop, mrt, output, pass, pow, saturation, smoothstep, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, AgXToneMapping, HalfFloatType, PCFShadowMap, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, type Texture, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import { setMaxAnisotropy } from './textureSet.ts';
import { installWebGpuCompat } from './webgpuCompat.ts';
import { LAGOON_CAMERA } from '../config.ts';
import { isTouchDevice } from '../core/input.ts';
import { FrameGovernor, PassTimer } from './perf.ts';

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

const SHAFT_SAMPLES = { high: 40, low: 0 } as const; // low: no shafts (a full-screen 40-tap loop)

/** What the frame governor may give up, cheapest loss first: the shafts' 40-tap loop, then pixels. */
export interface GovernorStep {
  shafts: boolean;
  scale: number;
}
const GOVERNOR_STEPS: Record<Quality, readonly GovernorStep[]> = {
  high: [
    { shafts: true, scale: 1 },
    { shafts: false, scale: 1 },
    { shafts: false, scale: 0.87 },
    { shafts: false, scale: 0.76 },
    { shafts: false, scale: 0.67 },
    { shafts: false, scale: 0.58 },
  ],
  low: [
    { shafts: false, scale: 1 },
    { shafts: false, scale: 0.87 },
    { shafts: false, scale: 0.76 },
    { shafts: false, scale: 0.67 },
    { shafts: false, scale: 0.58 },
  ],
};

export class LagoonStage {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Screen position of the sun (uv) and how strongly shafts are drawn. */
  readonly sunScreen = uniform(new Vector2(0.5, 0.5));
  readonly shaftStrength = uniform(0);
  readonly saturationAmount = uniform(1.08);
  /** GPU time per pass group (F3, benchmark). */
  readonly passTimer = new PassTimer();
  governor: FrameGovernor<GovernorStep>;
  /** Loop count of the shafts pass: a uniform, so the governor turns them off without a recompile. */
  private readonly shaftCount = uniform(0, 'int');
  private dynamicScale = 1;
  private pipeline: RenderPipeline | null = null;
  private sceneTexture: Texture | null = null;
  private settings: StageSettings;
  private readonly tmp = new Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    settings: StageSettings,
  ) {
    this.settings = { ...settings };
    installWebGpuCompat();
    this.renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance', trackTimestamp: true });
    this.renderer.inspector = this.passTimer;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.camera = new PerspectiveCamera(LAGOON_CAMERA.verticalFovDeg, 16 / 9, LAGOON_CAMERA.nearM, LAGOON_CAMERA.farM);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.passTimer.mainScene = this.scene;
    this.passTimer.mainCamera = this.camera;
    this.governor = this.makeGovernor();
  }

  private makeGovernor(): FrameGovernor<GovernorStep> {
    return new FrameGovernor(GOVERNOR_STEPS[this.settings.quality], (step) => this.applyStep(step));
  }

  private applyStep(step: GovernorStep): void {
    this.shaftCount.value = step.shafts ? SHAFT_SAMPLES[this.settings.quality] : 0;
    if (step.scale !== this.dynamicScale) {
      this.dynamicScale = step.scale;
      this.resize();
    }
  }

  /** "87 % · shafts off": what the governor currently gives up. */
  get governorLabel(): string {
    const s = this.governor.step;
    const shaftsOff = !s.shafts && SHAFT_SAMPLES[this.settings.quality] > 0;
    return `${Math.round(s.scale * 100)} %${shaftsOff ? ' · shafts off' : ''}`;
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
    const qualityChanged = s.quality !== this.settings.quality;
    this.settings = { ...s };
    if (qualityChanged) {
      const enabled = this.governor.enabled;
      this.governor = this.makeGovernor();
      this.governor.enabled = enabled;
    }
    // ACES by default: it keeps the lagoon's turquoise and the jungle greens punchy.
    // AgX stays as the A/B for the sunset sky, where ACES pushes orange toward yellow.
    this.renderer.toneMapping = s.toneMap === 'agx' ? AgXToneMapping : ACESFilmicToneMapping;
    this.buildPipeline();
    this.applyStep(this.governor.step);
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
    const count = this.shaftCount;
    const shafts = Fn(() => {
      const start = uv();
      const step = start.sub(sunUv).mul(0.85 / samples);
      const coord = start.toVar();
      const decay = float(1).toVar();
      const sum = vec3(0).toVar();
      // The loop count is a uniform, so control flow stays uniform and implicit-LOD sampling is legal in WGSL.
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, () => {
        coord.subAssign(step);
        const d = depth.sample(coord).r;
        // Reversed depth: the sky sits at 0.
        const sky = float(1).sub(smoothstep(0.0, 1e-6, d));
        sum.addAssign(colour.sample(coord).rgb.mul(sky).mul(decay));
        decay.mulAssign(0.955);
      });
      return vec4(sum.mul(strength.div(samples)), 0);
    })();

    const lit = samples > 0 ? aa.add(shafts) : aa;
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
    // Phones report a device pixel ratio of 3 or more: rendering that many pixels would halve the
    // frame rate for detail a 6-inch screen cannot show. Touch screens render at 1 pixel per CSS pixel.
    const maxRatio = isTouchDevice() ? 1 : 4;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio) * this.settings.renderScale * this.dynamicScale);
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
    this.passTimer.poll(this.renderer);
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
