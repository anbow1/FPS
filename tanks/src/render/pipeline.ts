import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import {
  unpackRGBToNormal,
  packNormalToRGB,
  dot,
  exp,
  float,
  Fn,
  fract,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  mrt,
  normalView,
  output,
  pass,
  pow,
  renderOutput,
  sample,
  screenCoordinate,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { ACESFilmicToneMapping, AgXToneMapping, Color, HalfFloatType, type Node, type PassNode, type PerspectiveCamera, RenderPipeline, type Scene, SRGBColorSpace, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import type { QualityPreset } from '../config';
import { hash12 } from './nodes';
import { isTouchDevice } from '../ui/touch.ts';
import { FrameGovernor, PassTimer } from './perf.ts';
import { screenReflectionOn } from './screenReflection.ts';
import { installWebGpuCompat } from './webgpuCompat.ts';

/**
 * Renderer and post chain, the same architecture as Field Line and Castaway Lagoon (anbow1/FPS):
 * WebGPURenderer (WebGPU, or its own WebGL2 fallback) and one TSL RenderPipeline.
 *   scene pass (HDR half float; velocity for TRAA, view normals for GTAO on High)
 *   → TRAA → GTAO (High) → sun shafts (sky mask smeared toward the sun)
 *   → bloom (input clamped so a glint cannot flood the frame) → exposure, ACES/AgX, sRGB
 *   → thermal sight grade → sharpen.
 * Everything the governor or the sight switches is a uniform, so nothing recompiles mid-game.
 */

/** Taps of the shafts loop per preset (a uniform count: the governor can turn them off). */
const SHAFT_TAPS = { high: 24, low: 12 } as const;

/** What the frame governor may give up, cheapest loss first. */
interface GovernorStep {
  ao: boolean;
  shafts: boolean;
  /** The lakes' mirror (High only): off, the shader shows the sky and the mirror renders coarse. */
  reflections: boolean;
  scale: number;
}
const GOVERNOR_STEPS: readonly GovernorStep[] = [
  { ao: true, shafts: true, reflections: true, scale: 1 },
  { ao: false, shafts: true, reflections: true, scale: 1 },
  { ao: false, shafts: false, reflections: true, scale: 1 },
  { ao: false, shafts: false, reflections: false, scale: 1 },
  { ao: false, shafts: false, reflections: false, scale: 0.87 },
  { ao: false, shafts: false, reflections: false, scale: 0.76 },
  { ao: false, shafts: false, reflections: false, scale: 0.67 },
  { ao: false, shafts: false, reflections: false, scale: 0.58 },
  // Deeper steps for slow phones, now that they start from a 2× picture.
  { ao: false, shafts: false, reflections: false, scale: 0.5 },
  { ao: false, shafts: false, reflections: false, scale: 0.42 },
];

/** Screen-space crepuscular rays: world direction to the sun and their pre-exposed colour (0 = off). */
export class Shafts {
  readonly sunDir = new Vector3(0, 1, 0);
  readonly color = new Color(0, 0, 0);
  /** shader warm-up: draw them even without a visible sun */
  force = false;
  readonly uSun = uniform(new Vector2(0.5, 0.5));
  readonly uColor = uniform(new Color(0, 0, 0));
  readonly uAspect = uniform(1);
  private readonly f = new Vector3();
  private readonly v = new Vector3();

  /** Once per frame: aim at the sun and fade out when it is behind the camera or far off screen. */
  prepare(camera: PerspectiveCamera, allowed: boolean): void {
    let k = 0;
    if (this.force) k = 1;
    else if (allowed && this.color.r + this.color.g + this.color.b > 0) {
      camera.getWorldDirection(this.f);
      const facing = this.f.dot(this.sunDir);
      this.v.copy(camera.position).addScaledVector(this.sunDir, 1000).project(camera);
      // sun a little off-screen still throws rays into view
      if (facing >= 0.15 && Math.abs(this.v.x) <= 1.6 && Math.abs(this.v.y) <= 1.6) {
        this.uSun.value.set(this.v.x * 0.5 + 0.5, 0.5 - this.v.y * 0.5);
        k = Math.min(1, (facing - 0.15) / 0.35);
      }
    }
    this.uColor.value.copy(this.color).multiplyScalar(k);
    this.uAspect.value = camera.aspect;
  }
}

export class Pipeline {
  readonly renderer: WebGPURenderer;
  /** GPU time per pass group (F3, benchmark). */
  readonly passTimer = new PassTimer();
  readonly governor: FrameGovernor<GovernorStep>;
  readonly shafts = new Shafts();
  private scene: Scene;
  camera: PerspectiveCamera;
  thermalOn = false;
  /** The pass the scene is drawn in (half-float colour, velocity, normals with GTAO): what its materials are built for. */
  scenePass: PassNode | null = null;
  /** 0..1 fraction of the preset's pixel ratio, set by the frame-time governor */
  renderScale = 1;
  /** governor may switch ambient occlusion off before touching resolution */
  aoAllowed = true;
  private shaftsAllowed = true;
  private quality: QualityPreset | null = null;
  /** full chain, and the same chain without GTAO: both compiled at load, the governor picks one */
  private full: RenderPipeline | null = null;
  private lite: RenderPipeline | null = null;
  private readonly uThermal = uniform(0);
  private readonly uTime = uniform(0);
  private readonly uBloom = uniform(1);
  private readonly uShaftCount = uniform(0, 'int');

  constructor(canvas: HTMLCanvasElement, scene: Scene, camera: PerspectiveCamera, onGovernorChange: () => void = () => {}) {
    this.scene = scene;
    this.camera = camera;
    installWebGpuCompat();
    // Reversed depth: 0.25 m near and 9 km far without z-fighting on the far ridges (gunnery at 3 km).
    const r = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance', trackTimestamp: true });
    r.inspector = this.passTimer;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = Math.pow(2, 0.5); // +0.5 EV default compensation
    r.shadowMap.enabled = true;
    r.info.autoReset = false;
    this.renderer = r;
    this.passTimer.mainScene = scene;
    this.passTimer.mainCamera = camera;
    this.governor = new FrameGovernor(GOVERNOR_STEPS, (s) => {
      this.aoAllowed = s.ao;
      this.shaftsAllowed = s.shafts;
      screenReflectionOn.value = s.reflections ? 1 : 0;
      this.setRenderScale(s.scale);
      onGovernorChange();
    });
  }

  async init(): Promise<void> {
    await this.renderer.init();
  }

  get backendName(): string {
    const backend: unknown = this.renderer.backend;
    const isWebGpu = typeof backend === 'object' && backend !== null && 'isWebGPUBackend' in backend;
    return isWebGpu ? 'WebGPU' : 'WebGL2 (fallback)';
  }

  /** "87 % · AO off": what the governor currently gives up. */
  get governorLabel(): string {
    const s = this.governor.step;
    return `${Math.round(s.scale * 100)} %${s.ao ? '' : ' · AO off'}${s.shafts ? '' : ' · shafts off'}${s.reflections ? '' : ' · reflections off'}`;
  }

  setQuality(q: QualityPreset): void {
    const rebuild = q.id !== this.quality?.id;
    this.quality = q;
    if (rebuild) this.build(q);
    this.applyPixelRatio();
  }

  private build(q: QualityPreset): void {
    const scenePass = pass(this.scene, this.camera, { type: HalfFloatType });
    this.scenePass = scenePass;
    // TRAA on both presets: on a phone it is what keeps the 2× picture (grass, foliage, wires) from
    // shimmering, and a velocity target costs far less than the pixels FXAA would need to match it.
    // The normal target exists only for GTAO (config: off on both presets for now), so it costs nothing without it.
    scenePass.setMRT(q.ao ? mrt({ output, normal: packNormalToRGB(normalView), velocity }) : mrt({ output, velocity }));
    const colour = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const velocityTex = scenePass.getTextureNode('velocity');
    const aa = traa(colour, depth, velocityTex, this.camera);

    // Sun shafts: the sky (reversed depth: 0 at the far plane) smeared radially toward the sun, taps
    // jittered per pixel to trade banding for fine noise, strongest near the sun.
    const taps = SHAFT_TAPS[q.id];
    const sh = this.shafts;
    const count = this.uShaftCount;
    const rays = Fn(() => {
      const p0 = uv();
      const d = sh.uSun.sub(p0);
      const stepv = d.mul(0.6 / taps).mul(min(1, float(0.9).div(max(length(d.mul(vec2(sh.uAspect, 1))), 1e-3))));
      const p = p0.add(stepv.mul(hash12(screenCoordinate.xy))).toVar();
      const sum = float(0).toVar();
      const w = float(1).toVar();
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, () => {
        sum.addAssign(float(1).sub(smoothstep(0, 1e-6, depth.sample(p).r)).mul(w));
        w.mulAssign(0.93);
        p.addAssign(stepv);
      });
      const fall = exp(length(p0.sub(sh.uSun).mul(vec2(sh.uAspect, 1))).mul(-2.6));
      return sum.div(11).mul(fall);
    })();

    const withRays = (c: Node<'vec4'>) => vec4(c.rgb.add(sh.uColor.mul(rays)), c.a);
    // Bloom: a small share of the HDR image, its input capped so a sun glint on water (~100× the
    // threshold) cannot flood the frame. The image itself keeps full HDR. Off in the thermal sight.
    const chain = (c: Node<'vec4'>) => {
      const lit = withRays(c);
      const peak = max(max(lit.r, lit.g), lit.b);
      const capped = lit.mul(min(1, float(6).div(max(peak, 1e-4))));
      const glare = bloom(capped, 0.12, 0.35, 1.6);
      const hdr = vec4(lit.rgb.add(glare.rgb.mul(this.uBloom)), 1);
      // exposure, tone mapping and sRGB here, so the sight grade and the AA work on display values
      const ldr = renderOutput(hdr);
      const graded = thermalGrade(ldr, this.uThermal, this.uTime);
      return sharpen(graded, 0.25);
    };

    this.full?.dispose();
    this.lite?.dispose();
    const lite = new RenderPipeline(this.renderer);
    lite.outputColorTransform = false;
    lite.outputNode = chain(aa);
    this.lite = lite;
    if (q.ao) {
      // GTAO from the depth and view normals of the same scene pass, applied to the scene colour
      // BEFORE TRAA, with its noise rotated every frame (useTemporalFiltering) so TRAA averages it
      // out. Applied after TRAA, as it was, the raw per-pixel noise reached the screen as grain.
      // Full resolution: the half-resolution path gathers four depths and keeps the min(), which
      // with this reversed depth buffer (near = 1) is the farthest, not the nearest; on WebGPU
      // that path drew a line across the middle of the screen (Low, without GTAO, had none).
      const normals = scenePass.getTextureNode('normal');
      const sceneNormal = sample((c) => unpackRGBToNormal(normals.sample(c)));
      const aoPass = ao(depth, sceneNormal, this.camera);
      aoPass.resolutionScale = 1;
      aoPass.samples.value = 8;
      aoPass.useTemporalFiltering = true;
      const occl = aoPass.getTextureNode().sample(uv()).r;
      // thermal imagers see heat, not occlusion; the sky (reversed depth: 0 at the far plane) has none
      const onGeometry = smoothstep(0, 1e-6, depth.sample(uv()).r);
      const k = mix(float(1), mix(occl, float(1), this.uThermal).mul(0.75).add(0.25), onGeometry);
      const occluded = vec4(colour.rgb.mul(k), colour.a);
      const full = new RenderPipeline(this.renderer);
      full.outputColorTransform = false;
      full.outputNode = chain(traa(occluded, depth, velocityTex, this.camera));
      this.full = full;
    } else {
      this.full = null;
    }
  }

  /** Changes the render resolution (reallocates the post-processing targets: call sparingly). */
  setRenderScale(scale: number): void {
    if (Math.abs(scale - this.renderScale) < 1e-3) return;
    this.renderScale = scale;
    this.applyPixelRatio();
  }

  private applyPixelRatio(): void {
    // Phones: up to 2× on either preset — sharp on any screen a hand holds; native 3× would triple the cost.
    const cap = isTouchDevice() ? 2 : (this.quality?.pixelRatioCap ?? 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap) * this.renderScale);
    this.resize();
  }

  /** Exposure compensation in EV on top of the physical exposure of the light preset. */
  setExposureComp(ev: number): void {
    this.renderer.toneMappingExposure = Math.pow(2, ev);
  }

  setToneMapping(kind: 'aces' | 'agx'): void {
    this.renderer.toneMapping = kind === 'aces' ? ACESFilmicToneMapping : AgXToneMapping;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Draw both chains once (behind the loading screen), so switching between them never compiles. */
  renderBoth(time: number): void {
    const allowed = this.aoAllowed;
    this.aoAllowed = true;
    this.render(time);
    this.aoAllowed = false;
    this.render(time);
    this.aoAllowed = allowed;
  }

  render(time: number): void {
    const pl = this.quality?.ao && this.aoAllowed && !this.thermalOn && this.full ? this.full : this.lite;
    if (!pl) throw new Error('pipeline.render() before setQuality()');
    this.renderer.info.reset();
    this.passTimer.mainCamera = this.camera;
    this.uThermal.value = this.thermalOn ? 1 : 0;
    this.uTime.value = time;
    this.uBloom.value = this.quality?.bloom && !this.thermalOn ? 1 : 0;
    this.shafts.prepare(this.camera, !this.thermalOn && this.shaftsAllowed);
    // no visible sun: skip the loop entirely (its cost is the taps, not the add)
    const c = this.shafts.uColor.value;
    this.uShaftCount.value = this.shafts.force || c.r + c.g + c.b > 0 ? SHAFT_TAPS[this.quality?.id ?? 'low'] : 0;
    pl.render();
    this.passTimer.poll(this.renderer);
  }

  get info(): WebGPURenderer['info'] {
    return this.renderer.info;
  }

  get sceneRef(): Scene {
    return this.scene;
  }
}

/**
 * Thermal sight: white-hot luminance with a little gamma, sensor noise and faint scan lines, on
 * display values. `amount` is 0 or 1 (a uniform); the materials already output heat as grey.
 */
function thermalGrade(c: Node<'vec4'>, amount: Node<'float'>, time: Node<'float'>): Node<'vec4'> {
  const l0 = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  const grain = fract(sin(dot(screenCoordinate.xy.div(1.5).floor(), vec2(12.9898, 78.233)).add(time.mul(61.7))).mul(43758.5453)).sub(0.5).mul(0.07);
  const row = sin(screenCoordinate.y.mul(0.5)).mul(0.015);
  const l = pow(max(l0, 0), 0.85).mul(1.1).add(grain).add(row);
  return vec4(mix(c.rgb, vec3(l), amount), 1);
}
