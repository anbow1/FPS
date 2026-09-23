import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Rng } from '../core/rng';

/**
 * Tessendorf FFT wave field on the GPU (after Aurélien's "Clearwater", MIT):
 * a directional wind-sea spectrum is evolved with the deep/capillary dispersion relation and
 * inverse-transformed every frame with a Stockham radix-2 FFT. The output texture holds
 * (height, dh/dx, dh/dz, slope²); its mip chain gives the slope variance used to widen
 * sun glints in the distance (LEAN mapping) instead of letting them alias.
 */
export interface OceanParams {
  n: number; // grid (power of two)
  size: number; // patch size, m
  peakWavelength: number; // m
  targetSlope: number; // RMS slope
  wind: [number, number];
}

const VERT = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class OceanFFT {
  readonly surface: THREE.WebGLRenderTarget;
  readonly size: number;
  private readonly logN: number;
  private readonly a: THREE.WebGLRenderTarget;
  private readonly b: THREE.WebGLRenderTarget;
  private readonly h0: THREE.DataTexture;
  private readonly quad = new FullScreenQuad();
  private readonly spec: THREE.ShaderMaterial;
  private readonly fft: THREE.ShaderMaterial;
  private readonly resolve: THREE.ShaderMaterial;

  constructor(renderer: THREE.WebGLRenderer, p: OceanParams) {
    this.size = p.size;
    this.logN = Math.round(Math.log2(p.n));
    const N = p.n;
    const float = renderer.extensions.has('EXT_color_buffer_float');
    const fmt = { type: float ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping };
    this.a = new THREE.WebGLRenderTarget(N, N, fmt);
    this.b = new THREE.WebGLRenderTarget(N, N, fmt);
    this.surface = new THREE.WebGLRenderTarget(N, N, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    });
    this.surface.texture.anisotropy = 8;
    this.h0 = buildH0(p);

    const common = { vertexShader: VERT, depthTest: false, depthWrite: false };
    this.spec = new THREE.ShaderMaterial({
      ...common,
      uniforms: { uH0: { value: this.h0 }, uT: { value: 0 }, uL: { value: p.size } },
      fragmentShader: /* glsl */ `
        precision highp float; precision highp sampler2D;
        uniform sampler2D uH0; uniform float uT, uL;
        vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
        void main(){
          ivec2 id = ivec2(gl_FragCoord.xy);
          vec4 s = texelFetch(uH0, id, 0);
          vec2 n = vec2(id); n -= step(${N / 2}.0, n) * ${N}.0;
          vec2 k = 6.28318530718 * n / uL; float kl = length(k);
          float w = sqrt(9.81 * kl + 7.4e-5 * kl * kl * kl);
          float w0 = 6.28318530718 / 90.0; w = floor(w / w0) * w0; // seamless 90 s loop
          float c = cos(w * uT), sn = sin(w * uT);
          vec2 H = cmul(s.xy, vec2(c, sn)) + cmul(s.zw, vec2(c, -sn));
          // two real fields in one complex FFT: h + i*dh/dx, and dh/dz
          gl_FragColor = vec4(H - k.x * H, vec2(-k.y * H.y, k.y * H.x));
        }`,
    });
    this.fft = new THREE.ShaderMaterial({
      ...common,
      uniforms: { uSrc: { value: null }, uP: { value: 1 }, uHoriz: { value: 1 } },
      fragmentShader: /* glsl */ `
        precision highp float; precision highp sampler2D; precision highp int;
        uniform sampler2D uSrc; uniform int uP, uHoriz;
        vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
        void main(){
          ivec2 id = ivec2(gl_FragCoord.xy);
          int j = uHoriz == 1 ? id.x : id.y;
          int k = j & (uP - 1);
          int i = ((j - (j & (2 * uP - 1))) >> 1) + k;
          bool y1 = (j & uP) != 0;
          ivec2 a = uHoriz == 1 ? ivec2(i, id.y) : ivec2(id.x, i);
          ivec2 b = uHoriz == 1 ? ivec2(i + ${N / 2}, id.y) : ivec2(id.x, i + ${N / 2});
          vec4 x0 = texelFetch(uSrc, a, 0), x1 = texelFetch(uSrc, b, 0);
          float ang = 3.14159265359 * float(k) / float(uP);
          vec2 w = vec2(cos(ang), sin(ang));
          vec4 wx = vec4(cmul(w, x1.xy), cmul(w, x1.zw));
          gl_FragColor = y1 ? x0 - wx : x0 + wx;
        }`,
    });
    this.resolve = new THREE.ShaderMaterial({
      ...common,
      uniforms: { uSrc: { value: null } },
      fragmentShader: /* glsl */ `
        precision highp float; precision highp sampler2D;
        uniform sampler2D uSrc;
        void main(){
          vec4 s = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
          vec2 sl = vec2(s.y, s.z);
          gl_FragColor = vec4(s.x, sl, dot(sl, sl));
        }`,
    });
  }

  update(renderer: THREE.WebGLRenderer, time: number): void {
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    this.spec.uniforms.uT!.value = time;
    this.quad.material = this.spec;
    renderer.setRenderTarget(this.a);
    this.quad.render(renderer);
    let src = this.a;
    let dst = this.b;
    this.quad.material = this.fft;
    for (let horiz = 1; horiz >= 0; horiz--) {
      for (let s = 0; s < this.logN; s++) {
        this.fft.uniforms.uSrc!.value = src.texture;
        this.fft.uniforms.uP!.value = 1 << s;
        this.fft.uniforms.uHoriz!.value = horiz;
        renderer.setRenderTarget(dst);
        this.quad.render(renderer);
        [src, dst] = [dst, src];
      }
    }
    this.resolve.uniforms.uSrc!.value = src.texture;
    this.quad.material = this.resolve;
    renderer.setRenderTarget(this.surface); // mipmaps regenerate on unbind
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
    this.surface.dispose();
    this.h0.dispose();
    this.spec.dispose();
    this.fft.dispose();
    this.resolve.dispose();
    this.quad.dispose();
  }
}

/** Initial spectrum h0(k) and conj(h0(-k)), scaled so the surface has the requested RMS slope. */
function buildH0(p: OceanParams): THREE.DataTexture {
  const N = p.n;
  const L = p.size;
  const rng = new Rng(7);
  const gauss = () => {
    let u = 0;
    while (!u) u = rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  };
  const kp = (2 * Math.PI) / p.peakWavelength;
  const kcut = (2 * Math.PI) / (L / N * 2.2);
  const wl = Math.hypot(p.wind[0], p.wind[1]) || 1;
  const wd = [p.wind[0] / wl, p.wind[1] / wl];
  const re = new Float32Array(N * N);
  const im = new Float32Array(N * N);
  let s2 = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const nx = n < N / 2 ? n : n - N;
      const nz = m < N / 2 ? m : m - N;
      const kx = (2 * Math.PI * nx) / L;
      const kz = (2 * Math.PI * nz) / L;
      const k = Math.hypot(kx, kz);
      let P = 0;
      if (k > 1e-6) {
        const lk = Math.log(k / kp);
        const bump = Math.exp(-0.5 * (lk / 0.38) ** 2);
        const tail = 0.04 * Math.exp(-((kp / k) ** 2)) * Math.exp(-((k / kcut) ** 2));
        const c = (kx * wd[0]! + kz * wd[1]!) / k;
        const spread = (0.3 + 0.7 * c * c) * (c < 0 ? 0.35 : 1);
        P = ((bump + tail) * spread) / (k * k * k * k);
      }
      const a = Math.sqrt(P / 2);
      const i = m * N + n;
      re[i] = gauss() * a;
      im[i] = gauss() * a;
      s2 += 2 * k * k * (re[i]! * re[i]! + im[i]! * im[i]!);
    }
  }
  const sc = p.targetSlope / Math.sqrt(s2);
  const data = new Float32Array(N * N * 4);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const j = ((N - m) % N) * N + ((N - n) % N);
      data[i * 4] = re[i]! * sc;
      data[i * 4 + 1] = im[i]! * sc;
      data[i * 4 + 2] = re[j]! * sc;
      data[i * 4 + 3] = -im[j]! * sc;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
