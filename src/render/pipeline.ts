import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { QualityPreset } from '../config';

/** Sight overlay for the thermal channel: sensor noise, slight blur of the edges, vignette. */
const ThermalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAmount: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uAmount; uniform vec2 uRes;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 61.7) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      if (uAmount <= 0.0) { gl_FragColor = c; return; }
      vec2 px = 1.0 / uRes;
      vec3 b = (texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb +
                texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb) * 0.25;
      float l = dot(mix(c.rgb, b, 0.5), vec3(0.299, 0.587, 0.114));
      l = pow(l, 0.85) * 1.1;
      l += (h(floor(vUv * uRes / 1.5)) - 0.5) * 0.07;
      float row = sin(vUv.y * uRes.y * 0.5) * 0.015;
      vec3 col = vec3(l + row);
      gl_FragColor = vec4(mix(c.rgb, col, uAmount), 1.0);
    }`,
};

export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  private renderPass: RenderPass;
  private gtao: GTAOPass;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private smaa: SMAAPass;
  private thermal: ShaderPass;
  private quality!: QualityPreset;
  private scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  thermalOn = false;

  constructor(canvas: HTMLCanvasElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = Math.pow(2, 0.5); // +0.5 EV default compensation
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;
    this.renderer = r;

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
    this.composer = new EffectComposer(r, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.gtao = new GTAOPass(scene, camera, 1, 1);
    this.gtao.blendIntensity = 0.75;
    this.gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 12 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    // GTAO draws its normal/depth buffer with an override material that ignores alpha clipping;
    // alpha-tested foliage would show up as solid quads, so it is left out of the AO pass.
    const g = this.gtao as unknown as { _overrideVisibility: () => void; _visibilityCache: THREE.Object3D[] };
    const baseOverride = g._overrideVisibility.bind(this.gtao);
    g._overrideVisibility = () => {
      baseOverride();
      scene.traverse((o) => {
        if (o.userData.noAO && o.visible) {
          o.visible = false;
          g._visibilityCache.push(o);
        }
      });
    };
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.12, 0.35, 1.6);
    // Clamp what feeds the bloom: a sun glint on water is ~100x brighter than the threshold and
    // would otherwise flood the frame. The image itself keeps full HDR; only the halo is capped.
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace(
      'gl_FragColor = mix( outputColor, texel, alpha );',
      'vec4 bloomIn = mix( outputColor, texel, alpha ); float bl = max(max(bloomIn.r, bloomIn.g), bloomIn.b); gl_FragColor = bloomIn * min(1.0, 6.0 / max(bl, 1e-4));',
    );
    hp.needsUpdate = true;
    this.output = new OutputPass();
    this.smaa = new SMAAPass();
    this.thermal = new ShaderPass(ThermalShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtao);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.smaa);
    this.composer.addPass(this.thermal);
  }

  setQuality(q: QualityPreset): void {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
    this.gtao.enabled = q.ao;
    this.resize();
  }

  /** Exposure compensation in EV on top of the physical exposure of the light preset. */
  setExposureComp(ev: number): void {
    this.renderer.toneMappingExposure = Math.pow(2, ev);
  }

  setToneMapping(kind: 'aces' | 'agx'): void {
    this.renderer.toneMapping = kind === 'aces' ? THREE.ACESFilmicToneMapping : THREE.AgXToneMapping;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.thermal.uniforms.uRes!.value.set(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(time: number): void {
    this.renderer.info.reset();
    this.renderPass.camera = this.camera;
    (this.gtao as unknown as { camera: THREE.Camera }).camera = this.camera;
    this.gtao.enabled = this.quality.ao && !this.thermalOn;
    this.bloom.enabled = this.quality.bloom && !this.thermalOn;
    this.thermal.enabled = this.thermalOn;
    this.thermal.uniforms.uTime!.value = time;
    this.thermal.uniforms.uAmount!.value = this.thermalOn ? 1 : 0;
    this.composer.render();
  }

  get info(): THREE.WebGLInfo {
    return this.renderer.info;
  }

  get sceneRef(): THREE.Scene {
    return this.scene;
  }
}
