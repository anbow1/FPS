import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { convertToTexture, depth as fragmentDepth, float, length, mix, mrt, normalize, output, pass, pow, rtt, screenUV, select, texture, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl';
import { ACESFilmicToneMapping, AddEquation, AgXToneMapping, CustomBlending, DepthTexture, FloatType, HalfFloatType, Layers, type Material, type Node, OneFactor, OneMinusSrcAlphaFactor, PerspectiveCamera, RenderPipeline, Scene, SrcAlphaFactor, SRGBColorSpace, WebGPURenderer, ZeroFactor } from 'three/webgpu';
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
  /** Ceiling on the device pixel ratio (render pixels per CSS pixel) before the governor's scale. */
  maxPixelRatio: number;
}

export interface GovernorStep {
  scale: number;
}

// Down to ~0.4: from a 2× phone picture that is still about the old 1× one, the floor it used to start at.
const GOVERNOR_STEPS: readonly GovernorStep[] = [{ scale: 1 }, { scale: 0.87 }, { scale: 0.76 }, { scale: 0.67 }, { scale: 0.58 }, { scale: 0.5 }, { scale: 0.42 }];

/**
 * Objects on this layer (contrails, vapour, afterburner flames) skip the scene pass and are drawn in an
 * overlay pass composited after the clouds: the cloud composite only knows the depth of opaque
 * surfaces, so a trail in front of a cloud would otherwise vanish behind it.
 */
export const OVERLAY_LAYER = 1;

const depthPlaceholder = new DepthTexture(1, 1);
depthPlaceholder.type = FloatType;
/** The scene pass's depth, for overlay materials to hide behind opaque surfaces (see `overlayVisibility`). */
const SCENE_DEPTH = texture(depthPlaceholder);

/** 1 where an overlay fragment is in front of the opaque scene, 0 behind it (reversed depth: larger is nearer). */
export function overlayVisibility(): Node<'float'> {
  return select(fragmentDepth.greaterThanEqual(SCENE_DEPTH.sample(screenUV).r.mul(0.99995)), float(1), float(0));
}

/**
 * Blending for overlay materials: colour premultiplied over (transparent black), alpha multiplied by
 * (1 − α) so it ends as the transmittance the composite needs. Emissive overlays (flames) add colour
 * and leave alpha alone instead.
 */
export function overlayBlending(m: Material, emissive: boolean): void {
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendEquationAlpha = AddEquation;
  m.blendSrc = emissive ? OneFactor : SrcAlphaFactor;
  m.blendDst = emissive ? OneFactor : OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = ZeroFactor;
  m.blendDstAlpha = emissive ? OneFactor : OneMinusSrcAlphaFactor;
}

export const CAMERA_NEAR_M = 0.05;
export const CAMERA_FAR_M = 600_000;

export interface CloudHook {
  readonly quality: { resolutionScale: number };
  march(dir: Node<'vec3'>, distanceM: Node<'float'>, uv: Node<'vec2'>): Node<'vec4'>;
  composite(scene: Node<'vec3'>, cloud: Node<'vec4'>, dir: Node<'vec3'>, distanceM: Node<'float'>): Node<'vec3'>;
}

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
  /** Aerial perspective applied to every surface in the scene pass (atmosphere.ts); sky pixels are skipped. */
  private aerial: ((colour: Node<'vec3'>, uv: Node<'vec2'>, distanceM: Node<'float'>) => Node<'vec3'>) | null = null;
  /** Volumetric clouds (clouds.ts): a reduced-resolution march composited over the hazed scene. */
  private clouds: CloudHook | null = null;
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

  setAerialPerspective(fn: (colour: Node<'vec3'>, uv: Node<'vec2'>, distanceM: Node<'float'>) => Node<'vec3'>): void {
    this.aerial = fn;
    this.buildPipeline();
  }

  setClouds(clouds: CloudHook): void {
    this.clouds = clouds;
    this.buildPipeline();
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
    SCENE_DEPTH.value = scenePass.getTexture('depth');
    // The overlay: only OVERLAY_LAYER. It is rendered from inside convertToTexture's RTT, which resets
    // the clear colour to opaque black, so its alpha holds transmittance (1 = nothing drawn): overlay
    // materials blend with `OVERLAY_BLENDING`.
    const overlayPass = pass(this.scene, this.camera, { type: HalfFloatType });
    const overlayLayers = new Layers();
    overlayLayers.set(OVERLAY_LAYER);
    overlayPass.setLayers(overlayLayers);
    const overlay = overlayPass.getTextureNode('output');
    const motion = scenePass.getTextureNode('velocity');
    const high = this.settings.quality === 'high';
    // Aerial perspective before anti-aliasing, on the HDR scene colour: every surface takes the haze
    // of the air between it and the eye; the sky (reversed depth 0) already has it.
    let hazed: Node<'vec4'> = colour;
    if (this.aerial || this.clouds) {
      const screen = uv();
      const d = depth.sample(screen).r;
      // The scene camera's matrices as uniforms: inside a post pass the camera nodes refer to the
      // full-screen quad's own camera, not the scene's.
      // Our own unprojection: getViewPosition maps depth to −1…1 under WebGL, but with a reversed
      // buffer the WebGL backend switches clip control to 0…1 (as WebGPU), so depth is NDC z as is.
      const ndcZ = this.renderer.reversedDepthBuffer || this.backendName === 'WebGPU' ? d : d.mul(2).sub(1);
      const clip = vec4(screen.x.mul(2).sub(1), screen.y.oneMinus().mul(2).sub(1), ndcZ, 1);
      const view4 = uniform(this.camera.projectionMatrixInverse).mul(clip);
      const viewPos = view4.xyz.div(view4.w);
      // Sky pixels (reversed depth 0) carry no usable view position: call them infinitely far.
      const distanceM = select(d.lessThanEqual(0), float(1e7), length(viewPos));
      // Sample the scene colour explicitly: used as `colour.rgb` inside a branch it read black.
      const sceneRgb = colour.sample(screen).rgb;
      const aerial = this.aerial;
      let rgb: Node<'vec3'> = aerial ? select(d.lessThanEqual(0), sceneRgb, aerial(sceneRgb, screen, distanceM)) : sceneRgb;
      if (this.clouds) {
        const dir = normalize(uniform(this.camera.matrixWorld).mul(vec4(viewPos, 0)).xyz);
        const cloudTex = rtt(this.clouds.march(dir, distanceM, screen), null, null, { resolutionScale: this.clouds.quality.resolutionScale });
        rgb = this.clouds.composite(rgb, cloudTex.sample(screen), dir, distanceM);
      }
      const ov = overlay.sample(screen);
      rgb = rgb.mul(ov.a.clamp(0, 1)).add(ov.rgb);
      // TRAA re-samples its input at reprojected positions, so it needs a texture, not an
      // expression: render the hazed frame to one first.
      hazed = convertToTexture(vec4(rgb, 1));
    }
    const aa = high ? traa(hazed, depth, motion, this.camera) : hazed;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.settings.maxPixelRatio) * this.settings.renderScale * this.dynamicScale);
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
