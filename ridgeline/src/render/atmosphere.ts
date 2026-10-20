import { acos, atan, cameraPosition, clamp, cos, dot, exp, float, Fn, If, int, length, Loop, max, min, mix, normalize, positionWorld, pow, screenUV, select, sin, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { BackSide, HalfFloatType, LinearFilter, Matrix4, Mesh, MeshBasicNodeMaterial, type Node, NoBlending, QuadMesh, RenderTarget, SphereGeometry, Vector3, type WebGPURenderer } from 'three/webgpu';

// Physically based sky and aerial perspective after Hillaire, "A Scalable and
// Production Ready Sky and Atmosphere Rendering Technique" (EGSR 2020) — the
// brief's requirement, valid from the runway to 15 km and beyond (the three.js
// Preetham sky is only valid on the ground). Earth radius 6360 km, atmosphere
// top 6460 km; Rayleigh, Mie and ozone coefficients from the paper (after
// Bruneton 2017). Four look-up tables, all rendered by quad passes that write
// raw data through `fragmentNode` (the colour path would clamp it):
//
//   transmittance (256 × 64)   from any height towards any zenith angle; once;
//   multiple scattering (32²)  the paper's Ψ_ms, isotropic higher orders; once;
//   sky view (192 × 108)       in-scattered radiance for every view direction
//                              from the camera's altitude; every frame;
//   aerial perspective         32 depth slices of 32 × 32, side by side in a
//                              1024 × 32 atlas: in-scattering (rgb) and mean
//                              transmittance (a) from the camera to each slice;
//                              every frame.
//
// Everything is per unit of sun illuminance; the passes that use it multiply
// by the pre-exposed solar illuminance, so the sky, the haze and the lights
// share one scale (rules §4.1–4.2). The sky dome adds a limb-darkened sun disc.

const RG = 6_360_000;
const RT = 6_460_000;
const H_RAYLEIGH = 8000;
const H_MIE = 1200;
const RAYLEIGH = new Vector3(5.802e-6, 13.558e-6, 33.1e-6);
const MIE_SCATTER = 3.996e-6;
const MIE_EXTINCT = 4.4e-6 + 3.996e-6;
const OZONE = new Vector3(0.65e-6, 1.881e-6, 0.085e-6);
const MIE_G = 0.8;
const GROUND_ALBEDO = 0.3;
/** Solar illuminance at the top of the atmosphere (lux): ~128 klx, which leaves ~100 klx at noon on the ground. */
export const SUN_TOA_LUX = 128_000;
/** Sun's angular radius (0.53° diameter). */
export const SUN_RADIUS_RAD = (0.265 * Math.PI) / 180;
/** Aerial perspective reaches this far (m); beyond it the last slice holds. */
const AP_RANGE_M = 420_000;
const AP_SLICES = 32;
const AP_RES = 32;

type F = Node<'float'>;
type V3 = Node<'vec3'>;

const vRayleigh = (): V3 => vec3(RAYLEIGH.x, RAYLEIGH.y, RAYLEIGH.z);
const vOzone = (): V3 => vec3(OZONE.x, OZONE.y, OZONE.z);

/** Densities (Rayleigh, Mie, ozone) at height h above the ground (m). */
function densities(h: F): V3 {
  const rayleigh = exp(h.negate().div(H_RAYLEIGH));
  const mie = exp(h.negate().div(H_MIE));
  // Ozone: a tent centred at 25 km, 30 km wide.
  const ozone = max(float(0), float(1).sub(h.sub(25_000).abs().div(15_000)));
  return vec3(rayleigh, mie, ozone);
}

function extinctionAt(h: F): V3 {
  const d = densities(h);
  return vRayleigh().mul(d.x).add(vec3(MIE_EXTINCT).mul(d.y)).add(vOzone().mul(d.z));
}

/** Distance along a ray from radius r with zenith cosine mu to the sphere of radius R (far hit), or −1. */
function distanceToSphere(r: F, mu: F, R: number): F {
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(R * R);
  return select(disc.lessThan(0), float(-1), r.negate().mul(mu).add(sqrt(max(disc, 0))));
}

/** Distance to the ground (near hit) or −1 when the ray misses it. */
function distanceToGround(r: F, mu: F): F {
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(RG * RG);
  const t = r.negate().mul(mu).sub(sqrt(max(disc, 0)));
  return select(disc.lessThan(0).or(mu.greaterThan(0)).or(t.lessThan(0)), float(-1), t);
}

// ---- transmittance LUT parameterisation (Bruneton 2017)
const H_TOP = Math.sqrt(RT * RT - RG * RG);

function transmittanceUv(r: F, mu: F): Node<'vec2'> {
  const rho = sqrt(max(r.mul(r).sub(RG * RG), 0));
  const d = distanceToSphere(r, mu, RT);
  const dMin = float(RT).sub(r);
  const dMax = rho.add(H_TOP);
  const xMu = d.sub(dMin).div(max(dMax.sub(dMin), 1));
  const xR = rho.div(H_TOP);
  return vec2(xMu, xR);
}

function rMuFromTransmittanceUv(uv: Node<'vec2'>): { r: F; mu: F } {
  const rho = uv.y.mul(H_TOP);
  const r = sqrt(rho.mul(rho).add(RG * RG));
  const dMin = float(RT).sub(r);
  const dMax = rho.add(H_TOP);
  const d = dMin.add(uv.x.mul(dMax.sub(dMin)));
  const mu = select(d.equal(0), float(1), float(H_TOP * H_TOP).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(d).mul(2)));
  return { r, mu: clamp(mu, -1, 1) };
}

function rayleighPhase(c: F): F {
  return float(3 / (16 * Math.PI)).mul(float(1).add(c.mul(c)));
}

function miePhase(c: F): F {
  // Cornette–Shanks.
  const g = MIE_G;
  const k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  return float(k).mul(float(1).add(c.mul(c))).div(pow(float(1 + g * g).sub(c.mul(2 * g)), 1.5));
}

export interface SkyState {
  /** Unit vector towards the sun (world). */
  sunDir: Vector3;
  /** Pre-exposed solar illuminance at the top of the atmosphere (lux × exposure). */
  sunIlluminance: number;
}

export class Atmosphere {
  readonly sunDir = uniform(new Vector3(0, 1, 0));
  readonly sunIlluminance = uniform(1);
  /** Camera altitude above the ground sphere (m). */
  readonly cameraAltitude = uniform(1000);
  readonly invViewProj = uniform(new Matrix4());
  /** The scene camera's position: inside the LUT passes `cameraPosition` is the quad's camera. */
  readonly cameraWorld = uniform(new Vector3());
  readonly transmittance: RenderTarget;
  readonly multiScatter: RenderTarget;
  readonly skyView: RenderTarget;
  readonly aerial: RenderTarget;
  private readonly skyViewQuad: QuadMesh;
  private readonly aerialQuad: QuadMesh;
  private builtStatic = false;
  private readonly transmittanceQuad: QuadMesh;
  private readonly multiScatterQuad: QuadMesh;
  /** The sky dome (follows the camera). */
  readonly dome: Mesh;

  constructor(quality: 'high' | 'low') {
    const target = (w: number, h: number): RenderTarget => {
      const t = new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false });
      t.texture.magFilter = LinearFilter;
      t.texture.minFilter = LinearFilter;
      t.texture.generateMipmaps = false;
      return t;
    };
    this.transmittance = target(256, 64);
    this.multiScatter = target(32, 32);
    this.skyView = target(quality === 'high' ? 192 : 128, quality === 'high' ? 108 : 72);
    this.aerial = target(AP_SLICES * AP_RES, AP_RES);
    const quad = (node: Node<'vec4'>): QuadMesh => {
      const m = new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
      m.blending = NoBlending;
      m.fragmentNode = node;
      return new QuadMesh(m);
    };
    this.transmittanceQuad = quad(this.transmittanceNode());
    this.multiScatterQuad = quad(this.multiScatterNode());
    this.skyViewQuad = quad(this.skyViewNode());
    this.aerialQuad = quad(this.aerialNode());
    this.dome = this.buildDome();
  }

  // ---- shared lookups
  transmittanceTo(r: F, mu: F): V3 {
    return texture(this.transmittance.texture, transmittanceUv(r, mu)).rgb;
  }

  private multiScatterAt(r: F, muS: F): V3 {
    const uv = vec2(muS.mul(0.5).add(0.5), r.sub(RG).div(RT - RG));
    return texture(this.multiScatter.texture, clamp(uv, vec2(0.5 / 32), vec2(1 - 0.5 / 32))).rgb;
  }

  // ---- LUT passes
  private transmittanceNode(): Node<'vec4'> {
    return Fn(() => {
      const { r, mu } = rMuFromTransmittanceUv(screenUV);
      const len = distanceToSphere(r, mu, RT);
      const steps = 40;
      const dt = len.div(steps);
      const depth = vec3(0).toVar();
      Loop({ start: int(0), end: int(steps), type: 'int', condition: '<' }, ({ i }) => {
        const t = float(i).add(0.5).mul(dt);
        const ri = sqrt(r.mul(r).add(t.mul(t)).add(r.mul(mu).mul(t).mul(2)));
        depth.addAssign(extinctionAt(ri.sub(RG)).mul(dt));
      });
      return vec4(exp(depth.negate()), 1);
    })();
  }

  private multiScatterNode(): Node<'vec4'> {
    return Fn(() => {
      const muS = screenUV.x.mul(2).sub(1);
      const r = float(RG).add(screenUV.y.mul(RT - RG)).add(10);
      const sun = vec3(0, muS, sqrt(max(float(1).sub(muS.mul(muS)), 0)));
      const L2 = vec3(0).toVar();
      const fms = vec3(0).toVar();
      const N = 8;
      const STEPS = 20;
      Loop({ start: int(0), end: int(N), type: 'int', condition: '<' }, ({ i: a }) => {
        Loop({ start: int(0), end: int(N), type: 'int', condition: '<' }, ({ i: b }) => {
          // Uniform directions on the sphere.
          const cosT = float(1).sub(float(a).add(0.5).div(N).mul(2));
          const sinT = sqrt(max(float(1).sub(cosT.mul(cosT)), 0));
          const phi = float(b).add(0.5).div(N).mul(Math.PI * 2);
          const dir = vec3(sinT.mul(cos(phi)), cosT, sinT.mul(sin(phi)));
          const ground = distanceToGround(r, cosT);
          const tMax = select(ground.greaterThan(0), ground, distanceToSphere(r, cosT, RT));
          const dt = tMax.div(STEPS);
          const T = vec3(1).toVar();
          const lum = vec3(0).toVar();
          const f = vec3(0).toVar();
          Loop({ start: int(0), end: int(STEPS), type: 'int', condition: '<' }, ({ i: s }) => {
            const t = float(s).add(0.5).mul(dt);
            const p = vec3(0, r, 0).add(dir.mul(t));
            const rp = length(p);
            const d = densities(rp.sub(RG));
            const scat = vRayleigh().mul(d.x).add(vec3(MIE_SCATTER).mul(d.y));
            const ext = extinctionAt(rp.sub(RG));
            const muSp = dot(p.div(rp), sun);
            const lit = select(distanceToGround(rp, muSp).greaterThan(0), float(0), float(1));
            const sunT = this.transmittanceTo(rp, muSp);
            const stepT = exp(ext.negate().mul(dt));
            const integ = float(1).sub(stepT).div(max(ext, vec3(1e-12)));
            lum.addAssign(T.mul(scat).mul(sunT).mul(lit).mul(1 / (4 * Math.PI)).mul(integ));
            f.addAssign(T.mul(scat).mul(integ));
            T.mulAssign(stepT);
          });
          // Light bounced off the ground (Lambertian albedo).
          If(ground.greaterThan(0), () => {
            const p = vec3(0, r, 0).add(dir.mul(ground));
            const up = normalize(p);
            const muG = dot(up, sun);
            lum.addAssign(T.mul(this.transmittanceTo(float(RG), muG)).mul(max(muG, 0)).mul(GROUND_ALBEDO / Math.PI));
          });
          // Both are means over the sphere of directions (the isotropic phase 1/4π times the
          // sphere's 4π cancel): L_2nd and f_ms of the paper's eq. 6–8.
          L2.addAssign(lum.div(N * N));
          fms.addAssign(f.div(N * N));
        });
      });
      return vec4(L2.div(max(vec3(1).sub(fms), vec3(1e-3))), 1);
    })();
  }

  /** View direction ↔ sky-view LUT coordinates (Hillaire §5.3: azimuth from the sun, latitude squeezed towards the horizon). */
  private skyViewUv(dir: V3): Node<'vec2'> {
    const r = float(RG).add(max(this.cameraAltitude, 1));
    const horizon = acos(sqrt(r.mul(r).sub(RG * RG)).div(r)).negate();
    const elevation = atan(dir.y, length(dir.xz));
    const above = elevation.greaterThanEqual(horizon);
    const lUp = elevation.sub(horizon).div(float(Math.PI / 2).sub(horizon));
    const lDown = horizon.sub(elevation).div(float(Math.PI / 2).add(horizon));
    const v = select(above, float(0.5).sub(sqrt(clamp(lUp, 0, 1)).mul(0.5)), float(0.5).add(sqrt(clamp(lDown, 0, 1)).mul(0.5)));
    // Azimuth relative to the sun, 0…π (the sky is symmetric about the sun's vertical plane).
    const sunXZ = normalize(vec2(this.sunDir.x, this.sunDir.z).add(vec2(1e-6, 0)));
    const dirXZ = normalize(dir.xz.add(vec2(1e-6, 0)));
    const az = acos(clamp(dot(sunXZ, dirXZ), -1, 1));
    const u = sqrt(az.div(Math.PI));
    return vec2(u, v);
  }

  private skyViewNode(): Node<'vec4'> {
    return Fn(() => {
      const r = float(RG).add(max(this.cameraAltitude, 1));
      const horizon = acos(sqrt(r.mul(r).sub(RG * RG)).div(r)).negate();
      const u = screenUV.x;
      const v = screenUV.y;
      const az = u.mul(u).mul(Math.PI);
      const upper = v.lessThan(0.5);
      const lUp = float(0.5).sub(v).mul(2);
      const lDown = v.sub(0.5).mul(2);
      const elevation = select(upper, horizon.add(lUp.mul(lUp).mul(float(Math.PI / 2).sub(horizon))), horizon.sub(lDown.mul(lDown).mul(float(Math.PI / 2).add(horizon))));
      // Local frame: the sun at azimuth 0 along −z.
      const sunY = this.sunDir.y;
      const sunH = sqrt(max(float(1).sub(sunY.mul(sunY)), 0));
      const sunLocal = vec3(0, sunY, sunH.negate());
      const dir = vec3(sin(az).mul(cos(elevation)), sin(elevation), cos(az).negate().mul(cos(elevation)));
      const cosView = dot(dir, sunLocal);
      return vec4(this.march(r, dir, cosView, sunLocal, float(-1), 30), 1);
    })();
  }

  /** Ray-march from the camera (radius r on the local vertical) along dir; `maxDist` < 0 = to the ground or the top. */
  private march(r: F, dir: V3, cosView: F, sunLocal: V3, maxDist: F, steps: number): V3 {
    const ground = distanceToGround(r, dir.y);
    const top = distanceToSphere(r, dir.y, RT);
    const tEnd = select(ground.greaterThan(0), ground, max(top, 0));
    const tMax = select(maxDist.greaterThan(0), min(maxDist, tEnd), tEnd);
    const L = vec3(0).toVar();
    const T = vec3(1).toVar();
    const prevT = float(0).toVar();
    Loop({ start: int(0), end: int(steps), type: 'int', condition: '<' }, ({ i }) => {
      // Quadratic step distribution: fine near the camera.
      const f = float(i).add(1).div(steps);
      const t = tMax.mul(f.mul(f));
      const dt = t.sub(prevT);
      const tMid = prevT.add(dt.mul(0.5));
      const pos = vec3(0, r, 0).add(dir.mul(tMid));
      const rp = length(pos);
      const d = densities(rp.sub(RG));
      const up = pos.div(rp);
      const muS = dot(up, sunLocal);
      const sunT = this.transmittanceTo(rp, muS);
      const lit = select(distanceToGround(rp, muS).greaterThan(0), float(0), float(1));
      const sR = vRayleigh().mul(d.x);
      const sM = vec3(MIE_SCATTER).mul(d.y);
      const S = sR.mul(rayleighPhase(cosView)).add(sM.mul(miePhase(cosView))).mul(sunT).mul(lit).add(this.multiScatterAt(rp, muS).mul(sR.add(sM)));
      const ext = extinctionAt(rp.sub(RG));
      const stepT = exp(ext.negate().mul(dt));
      const integ = S.sub(S.mul(stepT)).div(max(ext, vec3(1e-12)));
      L.addAssign(T.mul(integ));
      T.mulAssign(stepT);
      prevT.assign(t);
    });
    return L;
  }

  private aerialNode(): Node<'vec4'> {
    return Fn(() => {
      const px = screenUV.x.mul(AP_SLICES);
      const slice = px.floor();
      const tileUv = vec2(px.sub(slice), screenUV.y);
      // View ray through this froxel column (NDC from the tile uv; y down in uv, up in NDC).
      const ndc = vec4(tileUv.x.mul(2).sub(1), float(1).sub(tileUv.y.mul(2)), 0.5, 1);
      const world = this.invViewProj.mul(ndc);
      const dir = normalize(world.xyz.div(world.w).sub(this.cameraWorld));
      const f = slice.add(1).div(AP_SLICES);
      const dist = f.mul(f).mul(AP_RANGE_M);
      const r = float(RG).add(max(this.cameraAltitude, 1));
      const cosView = dot(dir, this.sunDir);
      const L = this.march(r, dir, cosView, this.sunDir, dist, 16);
      // Mean transmittance over the same path (grey: enough for haze on surfaces).
      const depth = vec3(0).toVar();
      Loop({ start: int(0), end: int(12), type: 'int', condition: '<' }, ({ i }) => {
        const t = float(i).add(0.5).div(12).mul(dist);
        const rp = length(vec3(0, r, 0).add(dir.mul(t)));
        depth.addAssign(extinctionAt(rp.sub(RG)).mul(dist.div(12)));
      });
      return vec4(L, exp(depth.negate()).dot(vec3(1 / 3)));
    })();
  }

  /** Aerial perspective for a surface at `distance` metres in screen position `uv`: (inscatter × sun, transmittance). */
  applyAerial(colour: V3, uv: Node<'vec2'>, distance: F): V3 {
    const s = sqrt(clamp(distance.div(AP_RANGE_M), 0, 1)).mul(AP_SLICES).sub(1);
    const s0 = clamp(s.floor(), 0, AP_SLICES - 1);
    const s1 = min(s0.add(1), AP_SLICES - 1);
    const w = clamp(s.sub(s0), 0, 1);
    const inTile = clamp(uv, vec2(0.5 / AP_RES), vec2(1 - 0.5 / AP_RES));
    const at = (slice: F): Node<'vec4'> => texture(this.aerial.texture, vec2(slice.add(inTile.x).div(AP_SLICES), inTile.y));
    // In front of the first slice: fade from nothing.
    const near = clamp(s.add(1), 0, 1);
    const a = mix(at(s0), at(s1), w);
    const inscatter = a.rgb.mul(near).mul(this.sunIlluminance);
    const T = mix(float(1), a.a, near);
    return colour.mul(T).add(inscatter);
  }

  /** Sky radiance (pre-exposed) for a world view direction, without the sun disc (cloud ambient light). */
  skyOnly(dir: V3): V3 {
    return texture(this.skyView.texture, this.skyViewUv(dir)).rgb.mul(this.sunIlluminance);
  }

  /** Sky radiance (pre-exposed) for a world view direction, with the sun disc. */
  skyRadiance(dir: V3): V3 {
    const sky = this.skyOnly(dir);
    const r = float(RG).add(max(this.cameraAltitude, 1));
    const cosSun = dot(dir, this.sunDir);
    const disc = smoothstep(Math.cos(SUN_RADIUS_RAD * 1.05), Math.cos(SUN_RADIUS_RAD), cosSun);
    // Limb darkening (Neckel–Labs approximation, u ≈ 0.6).
    const mu = sqrt(max(float(1).sub(float(1).sub(cosSun).div(1 - Math.cos(SUN_RADIUS_RAD))), 0));
    const limb = float(0.4).add(mu.mul(0.6));
    const solidAngle = 2 * Math.PI * (1 - Math.cos(SUN_RADIUS_RAD));
    const sunT = this.transmittanceTo(r, dir.y);
    const ground = distanceToGround(r, dir.y).greaterThan(0);
    // Clamp the disc so it cannot overflow half floats after pre-exposure (rules §4.1).
    const sun = min(this.sunIlluminance.div(solidAngle).mul(limb), float(30_000)).mul(sunT).mul(disc);
    return sky.add(select(ground, vec3(0), sun));
  }

  private buildDome(): Mesh {
    const m = new MeshBasicNodeMaterial({ name: 'sky', side: BackSide, depthWrite: false });
    m.colorNode = this.skyRadiance(normalize(positionWorld.sub(cameraPosition)));
    const dome = new Mesh(new SphereGeometry(500_000, 48, 24), m);
    dome.name = 'sky dome';
    dome.frustumCulled = false;
    dome.renderOrder = -1;
    return dome;
  }

  /** Transmittance from altitude `altitudeM` towards the sun (CPU, for the sun light's colour). */
  static sunTransmittanceCpu(altitudeM: number, sunDir: Vector3): Vector3 {
    const r = RG + Math.max(altitudeM, 0);
    const mu = sunDir.y;
    const disc = r * r * (mu * mu - 1) + RT * RT;
    const len = disc < 0 ? 0 : -r * mu + Math.sqrt(disc);
    const steps = 40;
    const depth = new Vector3();
    for (let i = 0; i < steps; i++) {
      const t = ((i + 0.5) / steps) * len;
      const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG;
      const dr = Math.exp(-h / H_RAYLEIGH);
      const dm = Math.exp(-h / H_MIE);
      const dO = Math.max(0, 1 - Math.abs(h - 25_000) / 15_000);
      depth.x += (RAYLEIGH.x * dr + MIE_EXTINCT * dm + OZONE.x * dO) * (len / steps);
      depth.y += (RAYLEIGH.y * dr + MIE_EXTINCT * dm + OZONE.y * dO) * (len / steps);
      depth.z += (RAYLEIGH.z * dr + MIE_EXTINCT * dm + OZONE.z * dO) * (len / steps);
    }
    // Below the horizon of the planet: no direct sun.
    const groundDisc = r * r * (mu * mu - 1) + RG * RG;
    if (mu < 0 && groundDisc > 0) return new Vector3(0, 0, 0);
    return new Vector3(Math.exp(-depth.x), Math.exp(-depth.y), Math.exp(-depth.z));
  }

  /** Renders the LUTs: the static two once, sky view and aerial perspective every call. */
  update(renderer: WebGPURenderer, camera: { position: Vector3; projectionMatrix: Matrix4; matrixWorld: Matrix4 }, state: SkyState): void {
    this.sunDir.value.copy(state.sunDir);
    this.sunIlluminance.value = state.sunIlluminance;
    this.cameraAltitude.value = Math.max(1, camera.position.y);
    this.cameraWorld.value.copy(camera.position);
    this.invViewProj.value.copy(camera.matrixWorld).multiply(tmpInvProj.copy(camera.projectionMatrix).invert());
    const previous = renderer.getRenderTarget();
    if (!this.builtStatic) {
      renderer.setRenderTarget(this.transmittance);
      this.transmittanceQuad.render(renderer);
      renderer.setRenderTarget(this.multiScatter);
      this.multiScatterQuad.render(renderer);
      this.builtStatic = true;
    }
    renderer.setRenderTarget(this.skyView);
    this.skyViewQuad.render(renderer);
    renderer.setRenderTarget(this.aerial);
    this.aerialQuad.render(renderer);
    renderer.setRenderTarget(previous);
    this.dome.position.copy(camera.position);
  }
}

const tmpInvProj = new Matrix4();
