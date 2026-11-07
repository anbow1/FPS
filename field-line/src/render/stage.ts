import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { convertToTexture, float, Fn, int, length, Loop, mrt, normalize, output, pass, pow, rtt, saturation, screenSize, select, smoothstep, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, AgXToneMapping, type Camera, FloatType, HalfFloatType, type Node, type PassNode, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, type Texture, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import { CAMERA } from '../config.ts';
import { setMaxAnisotropy } from './textures.ts';
import { installWebGpuCompat } from './webgpuCompat.ts';
import { screenReflectionOn } from './screenReflection.ts';
import { bodycamLens } from './bodycam.ts';
import { isTouchDevice } from '../core/input.ts';
import { FrameGovernor, PassTimer } from './perf.ts';
import type { VolumeClouds } from './volumeClouds.ts';

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
/** The camera's lens: the standard view, or a body-worn camera's (bodycam.ts). */
export type Lens = 'standard' | 'bodycam';

export interface StageSettings {
  quality: Quality;
  renderScale: number; // 1.0 default; 1.25–1.5 supersamples on High
  toneMap: ToneMap;
  lens: Lens;
}

/** Vertical field of view the bodycam lens renders at: its barrel magnifies the middle by 1 / 0.8. */
const BODYCAM_FOV_DEG = 88;

const SHAFT_SAMPLES = { high: 40, low: 0 } as const; // low: no shafts (a full-screen 40-tap loop)

/** What the frame governor may give up, cheapest loss first: the shafts' 40-tap loop, the lake's reflections, then pixels. */
export interface GovernorStep {
  shafts: boolean;
  /** Screen-space reflections on the lake (High only). */
  reflections: boolean;
  scale: number;
}
const GOVERNOR_STEPS: Record<Quality, readonly GovernorStep[]> = {
  // The lake's reflections go after the shafts and before any resolution: a march per water
  // pixel, and only where the lake is in view.
  high: [
    { shafts: true, reflections: true, scale: 1 },
    { shafts: false, reflections: true, scale: 1 },
    { shafts: false, reflections: false, scale: 1 },
    { shafts: false, reflections: false, scale: 0.87 },
    { shafts: false, reflections: false, scale: 0.76 },
    { shafts: false, reflections: false, scale: 0.67 },
    { shafts: false, reflections: false, scale: 0.58 },
  ],
  low: [
    { shafts: false, reflections: false, scale: 1 },
    { shafts: false, reflections: false, scale: 0.87 },
    { shafts: false, reflections: false, scale: 0.76 },
    { shafts: false, reflections: false, scale: 0.67 },
    { shafts: false, reflections: false, scale: 0.58 },
    { shafts: false, reflections: false, scale: 0.5 },
    { shafts: false, reflections: false, scale: 0.42 },
  ],
};

export class Stage {
  /** Screen position of the sun (uv) and how strongly its shafts are drawn. */
  readonly sunScreen = uniform(new Vector2(0.5, 0.5));
  readonly shaftStrength = uniform(0);
  private readonly tmp = new Vector3();
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** GPU time per pass group (F3, benchmark). */
  readonly passTimer = new PassTimer();
  governor: FrameGovernor<GovernorStep>;
  /** Loop count of the shafts pass: a uniform, so the governor turns them off without a recompile. */
  private readonly shaftCount = uniform(0, 'int');
  /** One over the output exposure (the bodycam's grain floor). */
  private readonly exposureInv = uniform(1);
  private dynamicScale = 1;
  private pipeline: RenderPipeline | null = null;
  /** The pass the scene is drawn in (half-float colour and velocity): what its materials are built for. */
  private scenePass: PassNode | null = null;
  private sceneTexture: Texture | null = null;
  private settings: StageSettings;
  /** Volumetric cumulus (volumeClouds.ts): a reduced-resolution march composited over the sky before TRAA. */
  private clouds: VolumeClouds | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    settings: StageSettings,
  ) {
    this.settings = { ...settings };
    installWebGpuCompat();
    // Reversed depth: a 4 cm near plane and a 2.6 km far plane without z-fighting at range.
    this.renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance', trackTimestamp: true });
    this.renderer.inspector = this.passTimer;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.camera = new PerspectiveCamera(CAMERA.verticalFovDeg, 16 / 9, CAMERA.nearM, CAMERA.farM);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.passTimer.mainScene = this.scene;
    this.passTimer.mainCamera = this.camera;
    this.governor = this.makeGovernor();
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

  setClouds(clouds: VolumeClouds): void {
    this.clouds = clouds;
    this.buildPipeline();
  }

  private makeGovernor(): FrameGovernor<GovernorStep> {
    return new FrameGovernor(GOVERNOR_STEPS[this.settings.quality], (step) => this.applyStep(step));
  }

  private applyStep(step: GovernorStep): void {
    this.shaftCount.value = step.shafts ? SHAFT_SAMPLES[this.settings.quality] : 0;
    screenReflectionOn.value = step.reflections ? 1 : 0;
    if (step.scale !== this.dynamicScale) {
      this.dynamicScale = step.scale;
      this.resize();
    }
  }

  /** "87 % · shafts off": what the governor currently gives up. */
  get governorLabel(): string {
    const s = this.governor.step;
    const shaftsOff = !s.shafts && SHAFT_SAMPLES[this.settings.quality] > 0;
    const reflectionsOff = !s.reflections && this.settings.quality === 'high';
    return `${Math.round(s.scale * 100)} %${shaftsOff ? ' · shafts off' : ''}${reflectionsOff ? ' · reflections off' : ''}`;
  }

  applySettings(s: StageSettings): void {
    const qualityChanged = s.quality !== this.settings.quality;
    this.settings = { ...s };
    if (qualityChanged) {
      const enabled = this.governor.enabled;
      this.governor = this.makeGovernor();
      this.governor.enabled = enabled;
    }
    // ACES by default (rules §2.1); AgX kept as the A/B for fire and sky.
    this.renderer.toneMapping = s.toneMap === 'agx' ? AgXToneMapping : ACESFilmicToneMapping;
    this.camera.fov = s.lens === 'bodycam' ? BODYCAM_FOV_DEG : CAMERA.verticalFovDeg;
    this.buildPipeline();
    this.applyStep(this.governor.step);
    this.resize();
  }

  private buildPipeline(): void {
    const scenePass = pass(this.scene, this.camera, { type: HalfFloatType });
    scenePass.setMRT(mrt({ output, velocity }));
    this.scenePass = scenePass;
    const depth = scenePass.getTextureNode('depth');
    const motion = scenePass.getTextureNode('velocity');
    this.sceneTexture = scenePass.getTexture('output');
    const high = this.settings.quality === 'high';
    let colour = scenePass.getTextureNode('output');
    if (this.clouds) {
      const screen = uv();
      const d = depth.sample(screen).r;
      // The scene camera as uniforms: inside a post pass the camera nodes are the quad's. Reversed depth on
      // both backends, so the buffer holds NDC z as it is; the sky (0, never written) is infinitely far.
      const clip = vec4(screen.x.mul(2).sub(1), screen.y.oneMinus().mul(2).sub(1), d, 1);
      const view4 = uniform(this.camera.projectionMatrixInverse).mul(clip);
      const viewPos = view4.xyz.div(view4.w);
      const distanceM = select(d.lessThanEqual(0), float(1e7), length(viewPos));
      const dir = normalize(uniform(this.camera.matrixWorld).mul(vec4(viewPos, 0)).xyz);
      const cam = uniform(this.camera.position);
      const scale = this.clouds.quality.resolutionScale;
      const cloudTex = rtt(this.clouds.march(dir, cam), null, null, { resolutionScale: scale });
      // At half resolution bilinear is enough (TRAA does the rest); coarser, four taps half a texel apart make
      // a tent over 3 × 3 texels, or each texel shows as a block of its own jitter.
      let cloud: Node<'vec4'> = cloudTex.sample(screen);
      if (scale < 0.5) {
        const o = vec2(0.5).div(screenSize.mul(scale));
        cloud = cloudTex
          .sample(screen.add(o))
          .add(cloudTex.sample(screen.sub(o)))
          .add(cloudTex.sample(screen.add(vec2(o.x, o.y.negate()))))
          .add(cloudTex.sample(screen.add(vec2(o.x.negate(), o.y))))
          .mul(0.25);
      }
      // TRAA and the shafts re-sample their input at other positions: they need a texture, not an expression.
      colour = convertToTexture(vec4(this.clouds.composite(colour.sample(screen).rgb, cloud, dir, cam, distanceM), 1));
    }
    // TRAA on both presets: the velocity buffer is rendered either way, so it costs only its resolve, and
    // on a phone it is what keeps the 2× picture (and its foliage) from shimmering.
    const aa = traa(colour, depth, motion, this.camera);
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
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, () => {
        coord.subAssign(step);
        // The loop count is a uniform, so control flow stays uniform and implicit-LOD sampling is legal in WGSL.
        const sky = float(1).sub(smoothstep(0.0, 1e-6, depth.sample(coord).r));
        sum.addAssign(colour.sample(coord).rgb.mul(sky).mul(decay));
        decay.mulAssign(0.955);
      });
      return vec4(sum.mul(strength.div(samples)), 0);
    })();
    const lit = samples > 0 ? aa.add(shafts) : aa;
    // Physical bloom: no threshold, a small share of the blurred HDR image (lens glare), not a glow filter.
    const glare = bloom(lit, high ? 0.06 : 0.04, 0.35, 0);
    // Grade: a touch of saturation and a soft optical vignette, tuned by eye.
    const r = length(uv().sub(vec2(0.5)).mul(vec2(1.25, 1)));
    const graded = vec4(saturation(lit.add(glare), 1.05).mul(float(1).sub(pow(r, 2.6).mul(0.35))), 1);
    const pipeline = new RenderPipeline(this.renderer);
    const sharp = sharpen(graded, high ? 0.3 : 0.25);
    pipeline.outputNode = this.settings.lens === 'bodycam' ? bodycamLens(sharp, this.exposureInv) : sharp;
    this.pipeline?.dispose();
    this.pipeline = pipeline;
  }

  /**
   * Builds the scene's shaders for the pass the game draws them in, asynchronously (the loading screen's
   * pre-compile, view.ts). renderer.compileAsync builds for whatever target is set, and with none set that
   * is the plain framebuffer: other outputs (no velocity), tone mapping in the material, another format, so
   * none of those builds was the one the game uses, and the first frame built every material again,
   * synchronously, the main thread blocked. The objects are gathered at the call; the target and MRT are
   * put back as soon as it returns.
   */
  compileScene(camera: Camera = this.camera): Promise<unknown> {
    const r = this.renderer;
    const p = this.scenePass;
    if (!p) return r.compileAsync(this.scene, camera);
    const target = p.renderTarget;
    // What PassNode.setup sets on the pipeline's first frame (three r186); until then the target holds its
    // defaults, and the samples and the formats are part of every build.
    target.samples = p.options.samples ?? r.samples;
    target.texture.type = r.getOutputBufferType();
    if (r.reversedDepthBuffer && target.depthTexture) target.depthTexture.type = FloatType;
    const prevTarget = r.getRenderTarget();
    const prevMrt = r.getMRT();
    r.setRenderTarget(target);
    r.setMRT(p.getMRT());
    try {
      return r.compileAsync(this.scene, camera);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setMRT(prevMrt);
    }
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    // Phones report a device pixel ratio of 3 or more: rendering that many pixels would halve the
    // frame rate for detail a 6-inch screen cannot show.
    // Phones: up to 2× — sharp on any screen a hand holds; native 3× would triple the cost for little.
    const maxRatio = isTouchDevice() ? 2 : 4;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio) * this.settings.renderScale * this.dynamicScale);
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
    this.exposureInv.value = 1 / Math.max(multiplier, 1e-6);
  }

  render(): void {
    if (!this.pipeline) throw new Error('stage.render() before init()');
    this.pipeline.render();
    this.passTimer.poll(this.renderer);
  }
}
