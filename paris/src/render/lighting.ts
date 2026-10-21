import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { cameraPosition, exp, float, fog, max, positionWorld, pow, uniform, vec4 } from 'three/tsl';
import { type Camera, DirectionalLight, FloatType, PerspectiveCamera, PMREMGenerator, RenderTarget, Scene, Vector3, type WebGPURenderer } from 'three/webgpu';
import { LIGHT } from '../config.ts';
import { lightColour, preExposureFor } from './colour.ts';
import { environmentTexture, equirectU, loadHdri } from './hdri.ts';
import { SCENE } from './nodes.ts';

// Sun, sky, environment and haze for one golden-hour evening, in physical
// units (the playbook's §1 and §4, after Field Line's render/lighting.ts):
// the sun and sky in lux from the lighting sheet, colours from kelvin
// white-balanced to D65, every value multiplied by the pre-exposure of the
// sheet's EV so nothing overflows half floats. The Preetham sky is measured
// once and scaled to deliver the sheet's sky illuminance, so the visible dome,
// the fog and the photographed environment (HDRI, one gain for all channels)
// agree. Shadows: four cascades out to the street's play distance.

const CALIBRATION_PX = 32;
const CALIBRATION_FOV_DEG = 150;
const CSM_MAX_FAR_M = 520;

export class Lighting {
  readonly sun = new DirectionalLight(0xffffff, 1);
  readonly sky = new SkyMesh();
  readonly csm: CSMShadowNode;
  readonly preExposure = preExposureFor(LIGHT.ev100);
  readonly sunDir = new Vector3();
  private readonly skyGain = uniform(new Vector3(1, 1, 1));
  private readonly fogColour = uniform(new Vector3());
  private readonly sunGlow = uniform(new Vector3());
  private readonly sunDirU = uniform(new Vector3(0, 1, 0));
  private readonly fogDensity = uniform(LIGHT.fogDensityPerM);
  private readonly fogFalloff = uniform(LIGHT.fogHeightFalloffPerM);

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Scene,
    shadowMapPx: number,
  ) {
    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(shadowMapPx, shadowMapPx);
    s.shadow.bias = -0.0002;
    s.shadow.normalBias = 0.03;
    this.csm = new CSMShadowNode(s, { cascades: 4, maxFar: CSM_MAX_FAR_M, mode: 'practical', lightMargin: 160 });
    this.csm.fade = true;
    s.shadow.shadowNode = this.csm;
    scene.add(s, s.target);

    this.sky.scale.setScalar(3000);
    // SkyMesh pins itself to the far plane; under a reversed depth buffer it must draw first.
    this.sky.renderOrder = -1000;
    const base = this.sky.material.colorNode as unknown as ReturnType<typeof vec4>;
    this.sky.material.colorNode = vec4(base.xyz.mul(this.skyGain), 1);
    scene.add(this.sky);
    scene.fogNode = fog(this.fogColourNode(), this.fogFactorNode());
  }

  /** Aerial perspective colour: the horizon sky, brightened toward the sun (Mie forward scatter). */
  private fogColourNode() {
    const viewDir = positionWorld.sub(cameraPosition).normalize();
    const toward = max(viewDir.dot(this.sunDirU), 0);
    return this.fogColour.add(this.sunGlow.mul(pow(toward, 6)));
  }

  /** Exponential height fog integrated along the view ray (density × d × (e^−fh₀ − e^−fh₁) / (f·Δh)). */
  private fogFactorNode() {
    const d = positionWorld.sub(cameraPosition).length();
    const h0 = cameraPosition.y;
    const h1 = positionWorld.y;
    const dy = h1.sub(h0);
    const e0 = exp(this.fogFalloff.mul(h0).negate());
    const e1 = exp(this.fogFalloff.mul(h1).negate());
    const integral = dy.abs().lessThan(0.01).select(e0, e0.sub(e1).div(this.fogFalloff.mul(dy)));
    return float(1).sub(exp(this.fogDensity.mul(d).mul(integral).negate()));
  }

  async apply(): Promise<void> {
    const L = LIGHT;
    const pe = this.preExposure;
    const sunK = lightColour(L.sunColourK);
    const skyK = lightColour(L.skyColourK);
    this.sunDir.set(Math.cos(L.sunElevationRad) * Math.sin(L.sunAzimuthRad), Math.sin(L.sunElevationRad), Math.cos(L.sunElevationRad) * Math.cos(L.sunAzimuthRad));
    this.sun.color.setRGB(sunK.r, sunK.g, sunK.b);
    this.sun.intensity = L.sunIlluminanceLux * pe;
    this.sun.position.copy(this.sunDir).multiplyScalar(600);
    this.sun.target.position.set(0, 0, 0);
    this.sunDirU.value.copy(this.sunDir);
    SCENE.sunDir.value.copy(this.sunDir);

    const u = this.sky;
    u.turbidity.value = L.turbidity;
    u.rayleigh.value = 2.0;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.82;
    u.cloudCoverage.value = 0;
    u.sunPosition.value.copy(this.sunDir);
    const skyLum = (L.skyIlluminanceLux / Math.PI) * pe;
    this.fogColour.value.set(skyK.r * skyLum, skyK.g * skyLum * 0.97, skyK.b * skyLum * 0.92);
    const glow = skyLum * 2.6;
    this.sunGlow.value.set(sunK.r * glow, sunK.g * glow, sunK.b * glow);

    // Light levels the materials read: a room ~2 % of the outdoor light by day, a lit room's lamp, shops.
    SCENE.interiorLux.value = (L.skyIlluminanceLux + L.sunIlluminanceLux * 0.2) * 0.025 * pe;
    SCENE.roomLampNits.value = 60 * pe;
    SCENE.shopNits.value = 260 * pe;
    SCENE.lanternNits.value = L.lampLanternCdM2 * pe;
    SCENE.leafSunNits.value = (L.sunIlluminanceLux * 0.2 * pe) / Math.PI;

    // The visible dome scaled to the sheet's sky illuminance.
    u.showSunDisc.value = 0;
    this.skyGain.value.set(1, 1, 1);
    const raw = await this.measureSkyIrradiance();
    const rawLum = 0.2126 * raw.r + 0.7152 * raw.g + 0.0722 * raw.b;
    const g = (L.skyIlluminanceLux * pe) / Math.max(1e-9, rawLum);
    this.skyGain.value.set(g, g, g);
    u.showSunDisc.value = 1;

    // The photographed street for ambient and reflections, one gain to the sheet's sky illuminance.
    const hdri = await loadHdri();
    const [ir, ig, ib] = hdri.skyIrradiance;
    const k = (L.skyIlluminanceLux * pe) / (0.2126 * ir + 0.7152 * ig + 0.0722 * ib);
    const equirect = environmentTexture(hdri, [k, k, k], equirectU(this.sunDir.x, this.sunDir.z));
    const pmrem = new PMREMGenerator(this.renderer);
    const rt = pmrem.fromEquirectangular(equirect);
    equirect.dispose();
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 1;
  }

  /** E = Σ L cos θ dω over an upward view, in the sky shader's raw units (Field Line's calibration). */
  private async measureSkyIrradiance(): Promise<{ r: number; g: number; b: number }> {
    const n = CALIBRATION_PX;
    const target = new RenderTarget(n, n, { type: FloatType, depthBuffer: false });
    const cam = new PerspectiveCamera(CALIBRATION_FOV_DEG, 1, 0.1, 5000);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 1, 0);
    const sky = this.sky.clone();
    sky.position.set(0, 0, 0);
    const scene = new Scene();
    scene.add(sky);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(scene, cam);
    this.renderer.setRenderTarget(prev);
    const data = (await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, n, n)) as Float32Array;
    target.dispose();
    const tanHalf = Math.tan((CALIBRATION_FOV_DEG * Math.PI) / 360);
    const pixel = (2 * tanHalf) / n;
    let er = 0;
    let eg = 0;
    let eb = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * 2 * tanHalf - tanHalf;
        const y = ((j + 0.5) / n) * 2 * tanHalf - tanHalf;
        const r2 = 1 + x * x + y * y;
        const w = (1 / Math.sqrt(r2)) * ((pixel * pixel) / (r2 * Math.sqrt(r2)));
        const k = (j * n + i) * 4;
        const r = data[k] as number;
        const g = data[k + 1] as number;
        const b = data[k + 2] as number;
        if (Number.isFinite(r + g + b)) {
          er += r * w;
          eg += g * w;
          eb += b * w;
        }
      }
    }
    const capShare = Math.sin((CALIBRATION_FOV_DEG * Math.PI) / 360) ** 2;
    return { r: er / capShare, g: eg / capShare, b: eb / capShare };
  }

  /** The dome follows the camera. */
  update(camera: Camera): void {
    this.sky.position.copy(camera.position);
  }
}
