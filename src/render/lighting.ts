import * as THREE from 'three';
import { ATMO, atmosphereUniforms, GLSL_CLOUDS } from './atmosphere';
import { G } from './shaderPatch';

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
export function kelvinToLinear(k: number, out = new THREE.Color()): THREE.Color {
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
  out.setRGB(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), THREE.SRGBColorSpace);
  const lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  return out.multiplyScalar(1 / Math.max(lum, 1e-4));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uSun; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;
uniform vec3 uSunDisk; uniform vec3 uGlow; uniform float uHaze; uniform float uStars; uniform float uDisk;
uniform float uThermal; uniform vec3 uThermalSky;
uniform float uCloudOn; uniform vec3 uCloudLit; uniform vec3 uCloudDark;
varying vec3 vDir;
${GLSL_CLOUDS}
// the sky gets two extra octaves on top of the shadow field, so outlines stay crisp
float tk_cloudSky(vec2 p) {
  p = (p + tkCloud.xy) * tkCloudP.w;
  float n = 0.5714 * tk_n2(p) + 0.2857 * tk_n2(p * 2.03 + 5.1) + 0.1429 * tk_n2(p * 4.07 + 1.7);
  n += (tk_n2(p * 8.3 + 9.2) - 0.5) * 0.1 + (tk_n2(p * 17.1 + 3.3) - 0.5) * 0.05;
  return smoothstep(1.0 - tkCloud.z, 1.18 - tkCloud.z, n);
}
float h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(h, 0.0, 1.0), mix(0.45, 0.9, uHaze));
  vec3 col = mix(uHorizon, uZenith, t);
  col = h < 0.0 ? mix(uHorizon, uGround, smoothstep(0.0, -0.08, h)) : col;
  float mu = dot(d, uSun);
  float g = mix(0.76, 0.6, uHaze);
  float mie = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.08;
  float horizonBand = exp(-abs(h) * mix(9.0, 3.0, uHaze));
  col += uGlow * mie * (0.35 + horizonBand);
  float cloud = 0.0;
  if (uCloudOn > 0.5 && h > 0.0 && tkCloud.z > 0.0) {
    // intersect the view ray with the cloud deck; the ground shadows use the same field
    float t = (tkCloudP.z - cameraPosition.y) / max(h, 0.015);
    vec2 cp = cameraPosition.xz + d.xz * t;
    cloud = tk_cloudSky(cp) * smoothstep(0.0, 0.1, h) * exp(-t / 30000.0);
    if (cloud > 0.0) {
      // thicker cloud towards the sun reads as a darker base; thin edges catch a silver lining
      float toward = tk_cloudSky(cp + uSun.xz / max(uSun.y, 0.12) * 140.0);
      vec3 cc = mix(uCloudLit, uCloudDark, toward * 0.75);
      cc += uGlow * mie * 2.5 * (1.0 - toward);
      col = mix(col, cc, cloud * 0.96);
    }
  }
  float disk = smoothstep(0.99992, 0.99996, mu) * uDisk;
  col += uSunDisk * disk * step(-0.01, h) * (1.0 - cloud);
  if (uStars > 0.0 && h > 0.0) {
    vec3 cell = floor(d * 420.0);
    float s = h13(cell);
    float star = step(0.9965, s) * smoothstep(0.0, 0.25, h) * (0.4 + 0.6 * h13(cell + 7.0)) * (1.0 - cloud);
    col += vec3(0.85, 0.9, 1.0) * star * uStars;
  }
  col = mix(col, uThermalSky, uThermal);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface LightingRig {
  sun: THREE.DirectionalLight;
  sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  preset: LightPreset;
  exposure: number;
  /** pre-exposed horizon radiance, used for fog, smoke lighting and the thermal toggle */
  fogColor: THREE.Color;
  ambient: THREE.Color;
  sunColor: THREE.Color;
  sunDir: THREE.Vector3;
}

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  preset: LightPreset = PRESETS[0]!;
  exposure = 1;
  readonly fogColor = new THREE.Color();
  /** approx. pre-exposed irradiance/π of the sky (for particle lighting) */
  readonly ambient = new THREE.Color();
  /** pre-exposed sun irradiance colour (lux·exposure·tint) */
  readonly sunColor = new THREE.Color();
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private skyScene = new THREE.Scene();
  private envSky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private shadowExtent = 140;
  private readonly scene: THREE.Scene;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.scene = scene;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.045;
    scene.add(this.sun, this.sun.target);

    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunDisk: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uHaze: { value: 0 },
        uStars: { value: 0 },
        uDisk: { value: 1 },
        uThermal: G.uThermal,
        uThermalSky: { value: new THREE.Color(0.012, 0.012, 0.012) },
        uCloudOn: { value: 1 },
        uCloudLit: { value: new THREE.Color() },
        uCloudDark: { value: new THREE.Color() },
        ...atmosphereUniforms(),
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.sky.scale.setScalar(12000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);

    const envMat = mat.clone();
    envMat.uniforms = THREE.UniformsUtils.clone(mat.uniforms);
    envMat.uniforms.uThermal = { value: 0 };
    envMat.uniforms.uDisk = { value: 0 };
    envMat.uniforms.uStars = { value: 0 };
    // the environment map stays cloud-free: it is only rebuilt when the preset changes
    envMat.uniforms.uCloudOn = { value: 0 };
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), envMat);
    this.envSky.scale.setScalar(100);
    this.skyScene.add(this.envSky);
  }

  setShadowQuality(mapSize: number, extent: number): void {
    this.shadowExtent = extent;
    const s = this.sun.shadow;
    if (s.mapSize.x !== mapSize) {
      s.mapSize.set(mapSize, mapSize);
      s.map?.dispose();
      s.map = null;
    }
    const cam = s.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 2000;
    cam.updateProjectionMatrix();
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
    this.sun.visible = true;
    // castShadow stays on: toggling it changes every lit shader's defines and would recompile
    // them all mid-game. With no direct sun the (unused) shadow map simply stops updating.
    this.sun.castShadow = true;
    this.sun.shadow.autoUpdate = beam > 1e-4;
    this.sun.shadow.radius = p.shadowSoftness;
    this.sunColor.copy(key).multiplyScalar(beam);
    G.uSunIrr.value.copy(key).multiplyScalar(beam * Math.max(0, Math.sin(el)));

    // Uniform-ish sky radiance L so that π·L·(avg) ≈ skyLux on a horizontal plane.
    const L = (p.skyLux / Math.PI) * ex;
    // Rayleigh sky is far more saturated than its CCT suggests; haze pulls it back to grey.
    const rayleigh = new THREE.Color(0.18, 0.42, 1.0);
    const zTint = skyTint.clone().lerp(rayleigh, 0.55 * (1 - p.haze));
    zTint.multiplyScalar(1 / (0.2126 * zTint.r + 0.7152 * zTint.g + 0.0722 * zTint.b));
    const zenith = zTint.multiplyScalar(L * (1.0 - 0.25 * p.haze));
    const neutral = new THREE.Color(1, 1, 1);
    const horizonTint = skyTint.clone().lerp(neutral, 0.5 + 0.4 * p.haze);
    if (p.sunElevDeg < 12 && p.sunLux > 0) horizonTint.lerp(key, 0.35);
    const horizon = horizonTint.multiplyScalar(L * (2.1 - 0.6 * p.haze));
    // Ground bounce: ~12 % albedo under the total illuminance.
    const eGround = (p.sunLux * Math.max(0, Math.sin(el)) + p.skyLux) * ex;
    const ground = new THREE.Color(0.55, 0.5, 0.4).multiplyScalar((0.12 * eGround) / Math.PI);
    const glow = key.clone().multiplyScalar(beam * 0.012 * (1 + p.haze * 2));
    if (p.id === 'twilight') glow.copy(kelvinToLinear(2200)).multiplyScalar(L * 1.2);
    // The disk is capped so FP16 targets never see inf (a real sun is ~1.6e9 cd/m²).
    const disk = key.clone().multiplyScalar(Math.min(beam * 8, 60));

    for (const m of [this.sky.material, this.envSky.material]) {
      const u = m.uniforms;
      (u.uSun!.value as THREE.Vector3).copy(this.sunDir);
      (u.uZenith!.value as THREE.Color).copy(zenith);
      (u.uHorizon!.value as THREE.Color).copy(horizon);
      (u.uGround!.value as THREE.Color).copy(ground);
      (u.uGlow!.value as THREE.Color).copy(glow);
      u.uHaze!.value = p.haze;
    }
    const su = this.sky.material.uniforms;
    (su.uSunDisk!.value as THREE.Color).copy(p.sunLux > 0 ? disk : new THREE.Color(0, 0, 0));
    su.uDisk!.value = p.sunLux > 0 ? 1 : 0;
    su.uStars!.value = p.stars * Math.max(0.02, L * 40);
    if (p.id === 'moon') {
      (su.uSunDisk!.value as THREE.Color).copy(kelvinToLinear(4100)).multiplyScalar(2.5);
    }

    // cloud deck: sunlit tops ~albedo/π of the beam, shaded bases lit by the sky
    const sinEl = Math.max(Math.sin(el), 0);
    const cloudLit = key.clone().multiplyScalar(beam * 0.24 * (0.3 + 0.7 * sinEl)).add(zenith.clone().multiplyScalar(0.9)).add(horizon.clone().multiplyScalar(0.25));
    const cloudDark = zenith.clone().multiplyScalar(0.55).add(horizon.clone().multiplyScalar(0.35)).add(key.clone().multiplyScalar(beam * 0.02));
    if (p.sunLux <= 0) cloudLit.copy(horizon).multiplyScalar(0.9).add(glow.clone().multiplyScalar(0.8));
    if (p.sunLux <= 0) cloudDark.copy(horizon).multiplyScalar(0.5);
    (su.uCloudLit!.value as THREE.Color).copy(cloudLit);
    (su.uCloudDark!.value as THREE.Color).copy(cloudDark);
    ATMO.cloud[2] = p.clouds;
    // ground shadows only under a real sun
    ATMO.cloud[3] = p.sunLux > 1000 ? 0.72 * (1 - 0.5 * p.haze) * Math.min(1, sinEl * 4) : 0;
    const sy = Math.max(this.sunDir.y, 0.12);
    ATMO.cloudP[0] = this.sunDir.x / sy;
    ATMO.cloudP[1] = this.sunDir.z / sy;
    ATMO.sunDir.set([this.sunDir.x, this.sunDir.y, this.sunDir.z, 0]);
    ATMO.fogSun.set([glow.r, glow.g, glow.b, 0.76 + (0.6 - 0.76) * p.haze]);

    this.fogColor.copy(horizon).lerp(zenith, 0.15);
    this.ambient.copy(zenith).lerp(horizon, 0.5);

    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(this.skyScene as unknown as THREE.Scene, 0, 0.1, 1000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1;
  }

  /** Keeps the shadow frustum centred on the action, snapped to texels to stop shimmering. */
  follow(focus: THREE.Vector3): void {
    const dir = this.sunDir.y > 0.02 ? this.sunDir : _up;
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    _m.lookAt(_zero, dir, Math.abs(dir.y) > 0.99 ? _fwd : _up);
    _inv.copy(_m).invert();
    _v.copy(focus).applyMatrix4(_inv);
    _v.x = Math.round(_v.x / texel) * texel;
    _v.y = Math.round(_v.y / texel) * texel;
    _v.applyMatrix4(_m);
    this.sun.target.position.copy(_v);
    this.sun.position.copy(_v).addScaledVector(dir, 800);
    this.sun.target.updateMatrixWorld();
  }
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);
