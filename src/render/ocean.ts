import { cos, float, floor, int, ivec2, length, screenCoordinate, select, sin, sqrt, step, textureLoad, uniform, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';

/**
 * Shared file for file by Tanks (lake) and Castaway Lagoon (open sea).
 *
 * Tessendorf FFT wave field on the GPU (after Aurélien's "Clearwater", MIT):
 * a directional wind-sea spectrum is evolved with the deep/capillary dispersion relation and
 * inverse-transformed every frame with a Stockham radix-2 FFT. The output texture holds
 * (height, dh/dx, dh/dz, slope²); its mip chain gives the slope variance used to widen
 * sun glints in the distance (LEAN mapping) instead of letting them alias.
 *
 * Each pass is a full-screen TSL quad into a float target. Every butterfly stage has its own
 * material with its stride, direction and source texture baked in, so a frame of FFT changes no
 * uniform between draws and every pipeline is compiled once.
 */
export interface OceanParams {
  n: number; // grid (power of two)
  size: number; // patch size, m
  peakWavelength: number; // m
  targetSlope: number; // RMS slope
  wind: [number, number];
}

type V2 = THREE.Node<'vec2'>;
const cmul = (a: V2, b: V2): V2 => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));

export class OceanFFT {
  readonly surface: THREE.RenderTarget;
  readonly size: number;
  private readonly logN: number;
  private readonly a: THREE.RenderTarget;
  private readonly b: THREE.RenderTarget;
  private readonly h0: THREE.DataTexture;
  private readonly specQuad: THREE.QuadMesh;
  private readonly fftQuads: { quad: THREE.QuadMesh; dst: THREE.RenderTarget }[] = [];
  private readonly resolveQuad: THREE.QuadMesh;
  private readonly uT = uniform(0);

  constructor(p: OceanParams) {
    this.size = p.size;
    this.logN = Math.round(Math.log2(p.n));
    const N = p.n;
    const fmt = { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping };
    this.a = new THREE.RenderTarget(N, N, fmt);
    this.b = new THREE.RenderTarget(N, N, fmt);
    this.surface = new THREE.RenderTarget(N, N, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    });
    this.surface.texture.anisotropy = 8;
    this.h0 = buildH0(p);
    const quad = (node: THREE.Node<'vec4'>, name: string) => {
      // The pass writes raw data through fragmentNode, past the material's colour and output stages:
      // through colorNode the channels came out clamped at 0 (half of every wave field is negative)
      // and alpha forced to 1 on an opaque material, though .w carries data here (an FFT component,
      // then the slope²). No blending, so .w is stored as it is.
      const m = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending });
      m.name = name;
      m.fragmentNode = node;
      return new THREE.QuadMesh(m);
    };
    const id = ivec2(floor(screenCoordinate.xy));

    // spectrum at time t: two real fields in one complex FFT, h + i·dh/dx and dh/dz
    {
      const s = textureLoad(this.h0, id);
      const n0 = vec2(id);
      const n = n0.sub(step(N / 2, n0).mul(N));
      const k = n.mul((2 * Math.PI) / p.size);
      const kl = length(k);
      const w0 = (2 * Math.PI) / 90;
      const w = floor(sqrt(kl.mul(9.81).add(kl.mul(kl).mul(kl).mul(7.4e-5))).div(w0)).mul(w0); // seamless 90 s loop
      const c = cos(w.mul(this.uT));
      const sn = sin(w.mul(this.uT));
      const H = cmul(s.xy, vec2(c, sn)).add(cmul(s.zw, vec2(c, sn.negate())));
      this.specQuad = quad(vec4(H.sub(H.mul(k.x)), k.y.negate().mul(H.y), k.y.mul(H.x)), 'ocean-spectrum');
    }

    // Stockham butterflies: rows, then columns; source and destination alternate a → b → a …
    let src = this.a;
    let dst = this.b;
    for (let horiz = 1; horiz >= 0; horiz--) {
      for (let stage = 0; stage < this.logN; stage++) {
        const P = 1 << stage;
        const j = horiz ? id.x : id.y;
        const kk = j.bitAnd(int(P - 1));
        const i = j.sub(j.bitAnd(int(2 * P - 1))).shiftRight(int(1)).add(kk);
        const y1 = j.bitAnd(int(P)).notEqual(int(0));
        const ia = horiz ? ivec2(i, id.y) : ivec2(id.x, i);
        const ib = horiz ? ivec2(i.add(N / 2), id.y) : ivec2(id.x, i.add(N / 2));
        const x0 = textureLoad(src.texture, ia);
        const x1 = textureLoad(src.texture, ib);
        const ang = float(kk).mul(Math.PI / P);
        const tw = vec2(cos(ang), sin(ang));
        const wx = vec4(cmul(tw, x1.xy), cmul(tw, x1.zw));
        this.fftQuads.push({ quad: quad(select(y1, x0.sub(wx), x0.add(wx)), `ocean-fft-${horiz ? 'h' : 'v'}${stage}`), dst });
        [src, dst] = [dst, src];
      }
    }
    const s = textureLoad(src.texture, id);
    this.resolveQuad = quad(vec4(s.x, s.y, s.z, s.y.mul(s.y).add(s.z.mul(s.z))), 'ocean-resolve');
  }

  /** Every offscreen target, for the per-pass GPU timer. */
  get targets(): THREE.RenderTarget[] {
    return [this.a, this.b, this.surface];
  }

  update(renderer: THREE.WebGPURenderer, time: number): void {
    const prev = renderer.getRenderTarget();
    this.uT.value = time;
    renderer.setRenderTarget(this.a);
    this.specQuad.render(renderer);
    for (const f of this.fftQuads) {
      renderer.setRenderTarget(f.dst);
      f.quad.render(renderer);
    }
    renderer.setRenderTarget(this.surface); // mipmaps are regenerated after the pass
    this.resolveQuad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
    this.surface.dispose();
    this.h0.dispose();
    for (const q of [this.specQuad, this.resolveQuad, ...this.fftQuads.map((f) => f.quad)]) (q.material as THREE.Material).dispose();
  }
}

/** Initial spectrum h0(k) and conj(h0(-k)), scaled so the surface has the requested RMS slope. */
function buildH0(p: OceanParams): THREE.DataTexture {
  const N = p.n;
  const L = p.size;
  // mulberry32 with a fixed seed: the same sea on every run
  let seed = 7;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0;
    while (!u) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
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
