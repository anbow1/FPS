import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * Screen-space crepuscular rays. The sky is wherever the depth buffer is still at the far plane;
 * that mask is smeared radially towards the sun at quarter resolution (24 taps), then added to the
 * HDR image before bloom and tone mapping. Costs one tiny pass plus a composite, and switches
 * itself off whenever the sun is behind the camera, below the horizon, or the thermal sight is on.
 */
const RAYS = {
  uniforms: {
    tDepth: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2() },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDepth; uniform vec2 uSun; uniform float uAspect;
    varying vec2 vUv;
    const int N = 24;
    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 d = (uSun - vUv);
      // rays reach ~0.6 of the screen; jitter the start to trade banding for fine noise
      vec2 stepv = d * (0.6 / float(N)) * min(1.0, 0.9 / max(length(d * vec2(uAspect, 1.0)), 1e-3));
      vec2 p = vUv + stepv * h12(gl_FragCoord.xy);
      float sum = 0.0;
      float w = 1.0;
      for (int i = 0; i < N; i++) {
        float sky = step(0.99999, texture2D(tDepth, p).r);
        sum += sky * w;
        w *= 0.93;
        p += stepv;
      }
      gl_FragColor = vec4(vec3(sum / 11.0), 1.0);
    }`,
};

const COMPOSITE = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tRays: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2() },
    uAspect: { value: 1 },
    uColor: { value: new THREE.Color() },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tRays; uniform vec2 uSun; uniform float uAspect; uniform vec3 uColor;
    varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float r = texture2D(tRays, vUv).r;
      // strongest around the sun, fading over about half a screen
      float dist = length((vUv - uSun) * vec2(uAspect, 1.0));
      float fall = exp(-dist * 2.6);
      c.rgb += uColor * r * fall;
      gl_FragColor = c;
    }`,
};

export class SunShaftsPass extends Pass {
  private rt: THREE.WebGLRenderTarget;
  private raysMat = new THREE.ShaderMaterial({ ...RAYS, uniforms: THREE.UniformsUtils.clone(RAYS.uniforms), depthTest: false, depthWrite: false });
  private compMat = new THREE.ShaderMaterial({ ...COMPOSITE, uniforms: THREE.UniformsUtils.clone(COMPOSITE.uniforms), depthTest: false, depthWrite: false });
  private quad = new FullScreenQuad();
  private readonly camera: () => THREE.Camera;
  /** world direction to the sun and the pre-exposed colour of the shafts (0 = off) */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly color = new THREE.Color(0, 0, 0);
  private readonly _v = new THREE.Vector3();
  private readonly _f = new THREE.Vector3();

  constructor(camera: () => THREE.Camera) {
    super();
    this.camera = camera;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.compMat.uniforms.tRays!.value = this.rt.texture;
    this.needsSwap = true;
  }

  override setSize(w: number, h: number): void {
    this.rt.setSize(Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4)));
    this.raysMat.uniforms.uAspect!.value = w / Math.max(h, 1);
    this.compMat.uniforms.uAspect!.value = w / Math.max(h, 1);
  }

  private k = 0;
  /** shader warm-up: run the pass even without a visible sun */
  force = false;
  private readonly uv = new THREE.Vector2();

  /** Call once per frame before the composer: turns the pass off when no shafts can be seen. */
  prepare(allowed: boolean): void {
    this.k = this.force ? 1 : allowed ? this.strength() : 0;
    this.enabled = this.k > 0;
  }

  private strength(): number {
    if (this.color.r + this.color.g + this.color.b <= 0) return 0;
    const cam = this.camera();
    cam.getWorldDirection(this._f);
    const facing = this._f.dot(this.sunDir);
    if (facing < 0.15) return 0;
    this._v.copy(cam.position).addScaledVector(this.sunDir, 1000).project(cam);
    // sun a little off-screen still throws rays into view
    if (Math.abs(this._v.x) > 1.6 || Math.abs(this._v.y) > 1.6) return 0;
    this.uv.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5);
    this.raysMat.uniforms.uSun!.value.copy(this.uv);
    this.compMat.uniforms.uSun!.value.copy(this.uv);
    return Math.min(1, (facing - 0.15) / 0.35);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const k = this.k;
    const target = this.renderToScreen ? null : writeBuffer;
    this.raysMat.uniforms.tDepth!.value = readBuffer.depthTexture;
    this.quad.material = this.raysMat;
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    this.compMat.uniforms.tDiffuse!.value = readBuffer.texture;
    (this.compMat.uniforms.uColor!.value as THREE.Color).copy(this.color).multiplyScalar(k);
    this.quad.material = this.compMat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.rt.dispose();
    this.raysMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}
