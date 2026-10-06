import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { float, length, mix, mrt, output, pass, pow, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, AgXToneMapping, HalfFloatType, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { isTouchDevice } from '../core/input.ts';
import { FrameGovernor, PassTimer } from './perf.ts';
import { installWebGpuCompat } from './webgpuCompat.ts';

// Renderer and post chain (rules §2, §4.5). One code path: WebGPURenderer falls
// back to WebGL2 by itself. Reversed depth with a float buffer carries a 5 cm
// near plane (the cockpit) and a 600 km far plane (the horizon from 15 km)
// without z-fighting. HDR scene pass with a velocity MRT; TRAA on High, FXAA
// on Low; physical bloom; exposure, tone map and sRGB once in the output
// transform; sharpening on High. G-induced grey-out and red-out are applied in
// HDR before the output, so the HUD (DOM) stays readable through them.

export type Quality = 'high' | 'low';
export type ToneMap = 'aces' | 'agx';

export interface StageSettings {
  quality: Quality;
  renderScale: number;
  toneMap: ToneMap;
}

export interface GovernorStep {
  scale: number;
}

const GOVERNOR_STEPS: readonly GovernorStep[] = [{ scale: 1 }, { scale: 0.87 }, { scale: 0.76 }, { scale: 0.67 }, { scale: 0.58 }];

export const CAMERA_NEAR_M = 0.05;
export const CAMERA_FAR_M = 600_000;

export class Stage {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly passTimer = new PassTimer();
  readonly governor: FrameGovernor<GovernorStep>;
  /** 0…1 grey-out (desaturation + tunnel vision) and red-out, from the pilot's G tolerance. */
  readonly greyOut = uniform(0);
  readonly redOut = uniform(0);
  private dynamicScale = 1;
  private pipeline: RenderPipeline | null = null;
  private settings: StageSettings;

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
    this.camera = new PerspectiveCamera(60, 16 / 9, CAMERA_NEAR_M, CAMERA_FAR_M);
    this.scene.add(this.camera);
    this.passTimer.mainScene = this.scene;
    this.passTimer.mainCamera = this.camera;
    this.governor = new FrameGovernor(GOVERNOR_STEPS, (step) => {
      if (step.scale !== this.dynamicScale) {
        this.dynamicScale = step.scale;
        this.resize();
      }
    });
  }

  async init(): Promise<void> {
    await this.renderer.init();
    this.applySettings(this.settings);
  }

  get backendName(): string {
    const backend: unknown = this.renderer.backend;
    return typeof backend === 'object' && backend !== null && 'isWebGPUBackend' in backend ? 'WebGPU' : 'WebGL2 (fallback)';
  }

  get quality(): Quality {
    return this.settings.quality;
  }

  get governorLabel(): string {
    return `${Math.round(this.governor.step.scale * 100)} %`;
  }

  applySettings(s: StageSettings): void {
    this.settings = { ...s };
    // ACES by default; AgX is the A/B for afterburner and sunset (rules §4.1).
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
    const high = this.settings.quality === 'high';
    const aa = high ? traa(colour, depth, motion, this.camera) : colour;
    const glare = bloom(aa, high ? 0.05 : 0.035, 0.35, 0);
    let lit = aa.add(glare).rgb;
    // G effects: grey-out desaturates and closes a tunnel from the edges; red-out tints red.
    const r = length(uv().sub(vec2(0.5)).mul(vec2(1.6, 1)));
    const lum = lit.dot(vec3(0.2126, 0.7152, 0.0722));
    const tunnel = float(1).sub(this.greyOut.mul(pow(r.mul(1.4), float(2).sub(this.greyOut)).add(this.greyOut.mul(0.35))).clamp(0, 1));
    lit = mix(lit, vec3(lum), this.greyOut).mul(tunnel);
    lit = mix(lit, vec3(lum.mul(1.2), lum.mul(0.08), lum.mul(0.06)), this.redOut.mul(0.85));
    // A soft optical vignette, tuned by eye.
    const graded = vec4(lit.mul(float(1).sub(pow(r, 2.6).mul(0.25))), 1);
    const pipeline = new RenderPipeline(this.renderer);
    pipeline.outputNode = high ? sharpen(graded, 0.3) : fxaa(graded);
    this.pipeline?.dispose();
    this.pipeline = pipeline;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const maxRatio = isTouchDevice() ? 1 : 4;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio) * this.settings.renderScale * this.dynamicScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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
