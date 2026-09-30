import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { abs, cameraPosition, clamp, dot, exp, float, floor, Fn, If, max, mix, mul, normalize, positionLocal, positionWorld, pow, smoothstep, step, uniform, vec3 } from 'three/tsl';
import {
  BackSide,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PerspectiveCamera,
  PMREMGenerator,
  type RenderTarget,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { ATMO, cloudShadow } from './atmosphere';
import { G, hash13, vnoise2 } from './nodes';

/**
 * Physically based lighting from the lighting reference sheet.
 *   exposure = 1 / (1.2 · 2^EV100)
 * Every light is multiplied by the exposure before rendering ("pre-exposure") so FP16
 * buffers never overflow; tone mapping then only has to deal with ~0..10.
 */
export interface LightPreset {
  id: string;
  label: string;
  ev100: number;
  /** extra EV so night scenes read dark (the eye does not fully adapt) */
  evBias: number;
  /** illuminance of the direct beam at normal incidence, lux */
  sunLux: number;
  /** diffuse sky illuminance on a horizontal plane, lux */
  skyLux: number;
  sunElevDeg: number;
  sunAzDeg: number;
  keyK: number;
  skyK: number;
  haze: number; // 0 clear .. 1 overcast
  /** fair-weather cumulus coverage 0..1 (drawn in the sky, shadows drift over the ground) */
  clouds: number;
  fogDensity: number;
  shadowSoftness: number;
  stars: number;
  headlights: boolean;
  note: string;
}

export const PRESETS: LightPreset[] = [
  { id: 'noon', label: 'Czyste południe', ev100: 15.3, evBias: 0, sunLux: 90000, skyLux: 18500, sunElevDeg: 65, sunAzDeg: 150, keyK: 5500, skyK: 10000, haze: 0.12, clouds: 0.42, fogDensity: 0.00032, shadowSoftness: 1.2, stars: 0, headlights: false, note: 'sun elev 60-75°' },
  { id: 'hazy', label: 'Mglisty dzień', ev100: 14.0, evBias: 0, sunLux: 30000, skyLux: 13000, sunElevDeg: 58, sunAzDeg: 165, keyK: 5500, skyK: 7000, haze: 0.55, clouds: 0.5, fogDensity: 0.0006, shadowSoftness: 5, stars: 0, headlights: false, note: 'soft shadow edges' },
  { id: 'overcast', label: 'Pochmurno', ev100: 11.6, evBias: 0, sunLux: 0, skyLux: 8000, sunElevDeg: 50, sunAzDeg: 170, keyK: 6500, skyK: 7000, haze: 1, clouds: 0, fogDensity: 0.0009, shadowSoftness: 8, stars: 0, headlights: false, note: 'sky is the key light' },
  { id: 'golden', label: 'Złota godzina', ev100: 12.2, evBias: 0, sunLux: 40000, skyLux: 6400, sunElevDeg: 8, sunAzDeg: 255, keyK: 3200, skyK: 9000, haze: 0.3, clouds: 0.36, fogDensity: 0.0004, shadowSoftness: 2, stars: 0, headlights: false, note: 'long shadows, warm rim' },
  { id: 'sunset', label: 'Zachód słońca', ev100: 7.3, evBias: 0.3, sunLux: 4000, skyLux: 330, sunElevDeg: 1.2, sunAzDeg: 265, keyK: 2000, skyK: 12000, haze: 0.35, clouds: 0.34, fogDensity: 0.00045, shadowSoftness: 3, stars: 0, headlights: false, note: 'cold ambient, warm horizon' },
  { id: 'twilight', label: 'Zmierzch cywilny', ev100: 2.0, evBias: 1.0, sunLux: 0, skyLux: 10, sunElevDeg: -4, sunAzDeg: 270, keyK: 2000, skyK: 14000, haze: 0.3, clouds: 0.3, fogDensity: 0.0004, shadowSoftness: 6, stars: 0.3, headlights: true, note: 'headlights start to read' },
  { id: 'moon', label: 'Pełnia księżyca', ev100: -3.3, evBias: 2.0, sunLux: 0.2, skyLux: 0.12, sunElevDeg: 40, sunAzDeg: 200, keyK: 4100, skyK: 7800, haze: 0.15, clouds: 0.25, fogDensity: 0.0003, shadowSoftness: 2, stars: 1, headlights: true, note: 'moon 4100 K, render slightly blue' },
  { id: 'night', label: 'Pochmurna noc', ev100: -10.3, evBias: 7.0, sunLux: 0, skyLux: 0.002, sunElevDeg: 30, sunAzDeg: 200, keyK: 4000, skyK: 4000, haze: 1, clouds: 0, fogDensity: 0.0007, shadowSoftness: 8, stars: 0, headlights: true, note: 'almost black, use NV / thermal' },
];

export function exposureFor(p: LightPreset): number {
  return 1 / (1.2 * Math.pow(2, p.ev100 + p.evBias));
}

/** Blackbody colour (Tanner Helland fit), returned in linear RGB normalised to luminance 1. */
export function kelvinToLinear(k: number, out = new Color()): Color {
  const t = k / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  out.setRGB(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), SRGBColorSpace);
  const lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  return out.multiplyScalar(1 / Math.max(lum, 1e-4));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** One sky's inputs. The visible sky and the (cloud- and star-free) environment probe each own a set. */
function skyUniforms() {
  return {
    sun: uniform(new Vector3(0, 1, 0)),
    zenith: uniform(new Color()),
    horizon: uniform(new Color()),
    ground: uniform(new Color()),
    sunDisk: uniform(new Color()),
    glow: uniform(new Color()),
    cloudLit: uniform(new Color()),
    cloudDark: uniform(new Color()),
    haze: uniform(0),
    stars: uniform(0),
    disk: uniform(1),
    cloudOn: uniform(1),
  };
}
type SkyUniforms = ReturnType<typeof skyUniforms>;

/** The sky gets two extra octaves on top of the ground-shadow field, so its outlines stay crisp. */
const cloudSky = Fn(([p0]: [V2]) => {
  const p = p0.add(ATMO.cloud.xy).mul(ATMO.cloudP.w);
  const n = vnoise2(p)
    .mul(0.5714)
    .add(vnoise2(p.mul(2.03).add(5.1)).mul(0.2857))
    .add(vnoise2(p.mul(4.07).add(1.7)).mul(0.1429))
    .add(vnoise2(p.mul(8.3).add(9.2)).sub(0.5).mul(0.1))
    .add(vnoise2(p.mul(17.1).add(3.3)).sub(0.5).mul(0.05));
  return smoothstep(float(1).sub(ATMO.cloud.z), float(1.18).sub(ATMO.cloud.z), n);
});

const THERMAL_SKY = vec3(0.012, 0.012, 0.012);

/** Sky radiance along a unit direction (pre-exposed): gradient, Mie halo, cloud deck, sun disk, stars. */
function skyColour(u: SkyUniforms, thermal: boolean) {
  return Fn(([d]: [V3]) => {
    const h = d.y;
    const t = pow(clamp(h, 0, 1), mix(0.45, 0.9, u.haze));
    const col = mix(u.horizon, u.zenith, t).toVar();
    // below the horizon: fade to the lit ground (edges ascending: GLSL smoothstep needs e0 < e1)
    col.assign(mix(col, mix(u.horizon, u.ground, float(1).sub(smoothstep(-0.08, 0, h))), step(h, 0)));
    const mu = dot(d, u.sun);
    const g = mix(0.76, 0.6, u.haze);
    const mie = float(1).sub(g.mul(g)).div(pow(float(1).add(g.mul(g)).sub(g.mul(2).mul(mu)), 1.5)).mul(0.08);
    const horizonBand = exp(abs(h).negate().mul(mix(9, 3, u.haze)));
    col.addAssign(u.glow.mul(mie).mul(horizonBand.add(0.35)));
    const cloud = float(0).toVar();
    If(u.cloudOn.greaterThan(0.5).and(h.greaterThan(0)).and(ATMO.cloud.z.greaterThan(0)), () => {
      // intersect the view ray with the cloud deck; the ground shadows use the same field
      const tt = ATMO.cloudP.z.sub(cameraPosition.y).div(max(h, 0.015));
      const cp = cameraPosition.xz.add(d.xz.mul(tt));
      cloud.assign(cloudSky(cp).mul(smoothstep(0, 0.1, h)).mul(exp(tt.negate().div(30000))));
      If(cloud.greaterThan(0), () => {
        // thicker cloud towards the sun reads as a darker base; thin edges catch a silver lining
        const toward = cloudSky(cp.add(u.sun.xz.div(max(u.sun.y, 0.12)).mul(140)));
        const cc = mix(u.cloudLit, u.cloudDark, toward.mul(0.75)).add(u.glow.mul(mie).mul(2.5).mul(float(1).sub(toward)));
        col.assign(mix(col, cc, cloud.mul(0.96)));
      });
    });
    const disk = smoothstep(0.99992, 0.99996, mu).mul(u.disk);
    col.addAssign(u.sunDisk.mul(disk).mul(step(-0.01, h)).mul(float(1).sub(cloud)));
    If(u.stars.greaterThan(0).and(h.greaterThan(0)), () => {
      const cell = floor(d.mul(420));
      const s = hash13(cell);
      const star = step(0.9965, s).mul(smoothstep(0, 0.25, h)).mul(hash13(cell.add(7)).mul(0.6).add(0.4)).mul(float(1).sub(cloud));
      col.addAssign(vec3(0.85, 0.9, 1.0).mul(star).mul(u.stars));
    });
    return thermal ? mix(col, THERMAL_SKY, G.uThermal) : col;
  });
}

function skyMesh(u: SkyUniforms, thermal: boolean): Mesh<SphereGeometry, MeshBasicNodeMaterial> {
  const mat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  mat.name = thermal ? 'sky' : 'skyProbe';
  mat.colorNode = skyColour(u, thermal)(normalize(positionLocal));
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), mat);
  mesh.frustumCulled = false;
  return mesh;
}

export class Lighting {
  readonly sun: DirectionalLight;
  readonly csm: CSMShadowNode;
  readonly sky: Mesh<SphereGeometry, MeshBasicNodeMaterial>;
  preset: LightPreset = PRESETS[0]!;
  exposure = 1;
  readonly fogColor = new Color();
  /** approx. pre-exposed irradiance/π of the sky (for particle lighting) */
  readonly ambient = new Color();
  /** pre-exposed sun irradiance colour (lux·exposure·tint) */
  readonly sunColor = new Color();
  readonly sunDir = new Vector3(0, 1, 0);
  private readonly pmrem: PMREMGenerator;
  private probeTarget: RenderTarget | null = null;
  private readonly skyScene = new Scene();
  private readonly probeCamera = new PerspectiveCamera(90, 1, 0.1, 100);
  /** the visible sky's inputs: the water reflects the same sky function */
  readonly skyU = skyUniforms();
  private readonly envU = skyUniforms();
  private readonly scene: Scene;
  private readonly renderer: WebGPURenderer;

  constructor(renderer: WebGPURenderer, scene: Scene, quality: 'high' | 'low') {
    this.scene = scene;
    this.renderer = renderer;
    this.pmrem = new PMREMGenerator(renderer);
    this.sun = new DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.045;
    const px = quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(px, px);
    // Cascades instead of one 4096² map around the tank: crisp near the hull, still shadowed at range.
    this.csm = new CSMShadowNode(this.sun, { cascades: quality === 'high' ? 3 : 2, maxFar: quality === 'high' ? 600 : 360, mode: 'practical', lightMargin: 200 });
    this.csm.fade = true;
    // Drifting cloud shadows ride on the sun's shadow term: one multiply, no pass of their own.
    this.sun.shadow.shadowNode = mul(this.csm as unknown as Node<'float'>, cloudShadow(positionWorld));
    scene.add(this.sun, this.sun.target);

    this.sky = skyMesh(this.skyU, true);
    this.sky.scale.setScalar(8000);
    this.sky.renderOrder = -1;
    scene.add(this.sky);
    // the probe dome must sit inside the bake camera's 100 m far plane (PMREM fromScene near/far)
    const probe = skyMesh(this.envU, false);
    probe.scale.setScalar(50);
    this.envU.cloudOn.value = 0;
    this.envU.disk.value = 0;
    this.envU.stars.value = 0;
    this.skyScene.add(probe);
  }

  /** Compile the probe's sky and the PMREM shaders, then bake once: call before the first frame. */
  async prepare(): Promise<void> {
    try {
      await this.renderer.compileAsync(this.skyScene, this.probeCamera);
    } catch (err) {
      console.error('sky probe shader pre-compilation failed; baking anyway:', err);
    }
    await this.pmrem.compileCubemapShader();
    this.bakeProbe();
  }

  /** Cascade range follows the quality preset (kept for the old single-map API). */
  setShadowQuality(_mapSize: number, extent: number): void {
    this.csm.maxFar = extent * 4;
    this.refitCascades();
  }

  /** Re-split the cascades along the view frustum (after a zoom); a no-op until the first frame binds the camera. */
  refitCascades(): void {
    if ((this.csm as unknown as { camera: unknown }).camera) this.csm.updateFrustums();
  }

  apply(p: LightPreset): void {
    this.preset = p;
    const ex = exposureFor(p);
    this.exposure = ex;
    const el = (p.sunElevDeg * Math.PI) / 180;
    const az = (p.sunAzDeg * Math.PI) / 180;
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    G.uSunDir.value.copy(this.sunDir).setY(Math.max(this.sunDir.y, 0.05)).normalize();
    G.uDay.value = Math.min(1, (p.sunLux + p.skyLux) / 20000);

    const key = kelvinToLinear(p.keyK);
    const skyTint = kelvinToLinear(p.skyK);
    // Direct beam loses blue near the horizon — keyK already encodes that per preset.
    const beam = p.sunLux * ex;
    this.sun.color.copy(key);
    this.sun.intensity = beam;
    // castShadow stays on: toggling it changes every lit shader and would recompile them mid-game.
    this.sun.shadow.radius = p.shadowSoftness;
    this.sunColor.copy(key).multiplyScalar(beam);
    G.uSunIrr.value.copy(key).multiplyScalar(beam * Math.max(0, Math.sin(el)));

    // Uniform-ish sky radiance L so that π·L·(avg) ≈ skyLux on a horizontal plane.
    const L = (p.skyLux / Math.PI) * ex;
    // Rayleigh sky is far more saturated than its CCT suggests; haze pulls it back to grey.
    const rayleigh = new Color(0.18, 0.42, 1.0);
    const zTint = skyTint.clone().lerp(rayleigh, 0.55 * (1 - p.haze));
    zTint.multiplyScalar(1 / (0.2126 * zTint.r + 0.7152 * zTint.g + 0.0722 * zTint.b));
    const zenith = zTint.multiplyScalar(L * (1.0 - 0.25 * p.haze));
    const neutral = new Color(1, 1, 1);
    const horizonTint = skyTint.clone().lerp(neutral, 0.5 + 0.4 * p.haze);
    if (p.sunElevDeg < 12 && p.sunLux > 0) horizonTint.lerp(key, 0.35);
    const horizon = horizonTint.multiplyScalar(L * (2.1 - 0.6 * p.haze));
    // Ground bounce: ~12 % albedo under the total illuminance.
    const eGround = (p.sunLux * Math.max(0, Math.sin(el)) + p.skyLux) * ex;
    const ground = new Color(0.55, 0.5, 0.4).multiplyScalar((0.12 * eGround) / Math.PI);
    const glow = key.clone().multiplyScalar(beam * 0.012 * (1 + p.haze * 2));
    if (p.id === 'twilight') glow.copy(kelvinToLinear(2200)).multiplyScalar(L * 1.2);
    // The disk is capped so FP16 targets never see inf (a real sun is ~1.6e9 cd/m²).
    const disk = key.clone().multiplyScalar(Math.min(beam * 8, 60));

    for (const u of [this.skyU, this.envU]) {
      u.sun.value.copy(this.sunDir);
      u.zenith.value.copy(zenith);
      u.horizon.value.copy(horizon);
      u.ground.value.copy(ground);
      u.glow.value.copy(glow);
      u.haze.value = p.haze;
    }
    const su = this.skyU;
    su.sunDisk.value.copy(p.sunLux > 0 ? disk : new Color(0, 0, 0));
    su.disk.value = p.sunLux > 0 ? 1 : 0;
    su.stars.value = p.stars * Math.max(0.02, L * 40);
    if (p.id === 'moon') su.sunDisk.value.copy(kelvinToLinear(4100)).multiplyScalar(2.5);

    // cloud deck: sunlit tops ~albedo/π of the beam, shaded bases lit by the sky
    const sinEl = Math.max(Math.sin(el), 0);
    const cloudLit = key.clone().multiplyScalar(beam * 0.24 * (0.3 + 0.7 * sinEl)).add(zenith.clone().multiplyScalar(0.9)).add(horizon.clone().multiplyScalar(0.25));
    const cloudDark = zenith.clone().multiplyScalar(0.55).add(horizon.clone().multiplyScalar(0.35)).add(key.clone().multiplyScalar(beam * 0.02));
    if (p.sunLux <= 0) cloudLit.copy(horizon).multiplyScalar(0.9).add(glow.clone().multiplyScalar(0.8));
    if (p.sunLux <= 0) cloudDark.copy(horizon).multiplyScalar(0.5);
    su.cloudLit.value.copy(cloudLit);
    su.cloudDark.value.copy(cloudDark);
    const c = ATMO.cloud.value;
    c.z = p.clouds;
    // ground shadows only under a real sun
    c.w = p.sunLux > 1000 ? 0.72 * (1 - 0.5 * p.haze) * Math.min(1, sinEl * 4) : 0;
    const sy = Math.max(this.sunDir.y, 0.12);
    ATMO.cloudP.value.x = this.sunDir.x / sy;
    ATMO.cloudP.value.y = this.sunDir.z / sy;
    ATMO.sunDir.value.set(this.sunDir.x, this.sunDir.y, this.sunDir.z, 0);
    ATMO.fogSun.value.set(glow.r, glow.g, glow.b, 0.76 + (0.6 - 0.76) * p.haze);

    this.fogColor.copy(horizon).lerp(zenith, 0.15);
    this.ambient.copy(zenith).lerp(horizon, 0.5);
    if (this.probeTarget) this.bakeProbe();
  }

  /** Bake the sky probe into the same render target every time: the environment texture never changes identity, so nothing recompiles. */
  private bakeProbe(): void {
    const opts = this.probeTarget ? { size: 128, renderTarget: this.probeTarget } : { size: 128 };
    const rt = this.pmrem.fromScene(this.skyScene, 0, 0.1, 100, opts);
    this.probeTarget = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 1;
  }

  /** The sun looks at the action; the cascades fit themselves to the camera. */
  follow(focus: Vector3): void {
    const dir = this.sunDir.y > 0.02 ? this.sunDir : _up;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(dir, 800);
    this.sun.target.updateMatrixWorld();
  }

  /** The sky dome travels with the eye (it is smaller than the far plane). */
  track(camera: Vector3): void {
    this.sky.position.copy(camera);
  }
}

const _up = new Vector3(0, 1, 0);
