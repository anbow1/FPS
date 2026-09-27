import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { cameraPosition, exp, float, fog, max, positionWorld, pow, uniform, vec4 } from 'three/tsl';
import { BackSide, DirectionalLight, FloatType, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, PMREMGenerator, RenderTarget, Scene, SphereGeometry, type Texture, Vector3, type WebGPURenderer } from 'three/webgpu';
import { EXPOSURE, LIGHTING, type LightingPreset, type LightingPresetId } from '../config.ts';
import { lightColour, preExposureFor } from './colour.ts';

// Sun, sky, environment and height fog for one lighting preset from
// lighting-reference.png. Every intensity is authored in physical units (lux)
// and multiplied by the preset's pre-exposure factor before rendering, so the
// sun on polished metal never overflows FP16 (rules §2.2). The auto-exposure
// system then adjusts around that anchor.

// The Preetham sky outputs radiance in its own units. Each preset measures it
// once (calibrateSky) and scales it so the sky delivers the sheet's sky
// illuminance: the visible dome, the ambient probe and the fog then agree.
const CALIBRATION_PX = 32;
const CALIBRATION_FOV_DEG = 150; // an upward view out to 75° from the zenith
// Sun cascades: split to the real play distance (rules §2.3), not the default.
const CSM_MAX_FAR_M = { high: 450, low: 220 } as const;
const GROUND_ALBEDO = 0.2;

export class Lighting {
  readonly sun = new DirectionalLight(0xffffff, 1);
  readonly sky = new SkyMesh();
  readonly csm: CSMShadowNode;
  private readonly skyScene = new Scene();
  private readonly pmrem: PMREMGenerator;
  private envTexture: Texture | null = null;
  /** Per-channel: brightness and colour temperature both calibrated to the sheet. */
  private readonly skyGain = uniform(new Vector3(1, 1, 1));
  private readonly fogColour = uniform(new Vector3());
  private readonly sunGlowColour = uniform(new Vector3());
  private readonly sunDirection = uniform(new Vector3(0, 1, 0));
  private readonly fogDensity = uniform(0);
  /** Pre-exposed radiance of the ground as the probe sees it from above. */
  private readonly groundRadiance = uniform(new Vector3());
  private readonly fogFalloff = uniform(0.005);
  private readonly fogBaseY = uniform(0);
  preset: LightingPreset = LIGHTING.noon;
  preExposure = preExposureFor(LIGHTING.noon.ev100);
  private readonly sunDir = new Vector3();
  private readonly renderer: WebGPURenderer;
  private readonly calibTarget = new RenderTarget(CALIBRATION_PX, CALIBRATION_PX, { type: FloatType, depthBuffer: false });
  private readonly calibCamera = new PerspectiveCamera(CALIBRATION_FOV_DEG, 1, 0.1, 100);

  constructor(
    renderer: WebGPURenderer,
    private readonly scene: Scene,
    quality: 'high' | 'low',
  ) {
    this.renderer = renderer;
    this.pmrem = new PMREMGenerator(renderer);
    this.calibCamera.position.set(0, 0, 0);
    this.calibCamera.up.set(0, 0, -1);
    this.calibCamera.lookAt(0, 1, 0);
    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
    s.shadow.bias = -0.0002;
    s.shadow.normalBias = 0.02;
    this.csm = new CSMShadowNode(s, { cascades: quality === 'high' ? 4 : 2, maxFar: CSM_MAX_FAR_M[quality], mode: 'practical', lightMargin: 120 });
    this.csm.fade = true;
    s.shadow.shadowNode = this.csm;
    scene.add(s, s.target);

    this.sky.scale.setScalar(2000);
    // SkyMesh pins itself to the far plane (z = w). Under a reversed depth buffer that is
    // the near plane, so it must draw first; it never writes depth, so geometry covers it.
    this.sky.renderOrder = -1000;
    const baseColour = this.sky.material.colorNode;
    if (!baseColour) throw new Error('SkyMesh has no colour node to scale');
    // The sky node is typed as a union; SkyMesh returns vec4(texColor, 1).
    const skyColour = baseColour as unknown as ReturnType<typeof vec4>;
    this.sky.material.colorNode = vec4(skyColour.xyz.mul(this.skyGain), 1);
    scene.add(this.sky);
    // The probe scene renders the same sky: the clone shares the material, so it shares the uniforms.
    this.skyScene.add(this.sky.clone());
    // Below the horizon the probe sees the sunlit ground, not more sky: the bounce light that
    // lifts shaded walls, trunks and soldiers. Radius 50 m keeps it inside the bake camera's
    // 100 m far plane; the calibration view (≥ 15° elevation) never sees it.
    const groundMat = new MeshBasicNodeMaterial({ side: BackSide, fog: false });
    groundMat.colorNode = vec4(this.groundRadiance, 1);
    this.skyScene.add(new Mesh(new SphereGeometry(50, 32, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), groundMat));

    scene.fogNode = fog(this.fogColourNode(), this.fogFactorNode());
  }

  /** Aerial perspective colour: the horizon sky, brightened toward the sun (Mie forward scatter). */
  private fogColourNode() {
    const viewDir = positionWorld.sub(cameraPosition).normalize();
    const toward = max(viewDir.dot(this.sunDirection), 0);
    return this.fogColour.add(this.sunGlowColour.mul(pow(toward, 8)));
  }

  /**
   * Exponential height fog, integrated analytically along the view ray:
   * optical depth = ρ₀ · d · (e^(−f·h₀) − e^(−f·h₁)) / (f · (h₁ − h₀)).
   */
  private fogFactorNode() {
    const density = this.fogDensity;
    const falloff = this.fogFalloff;
    const baseY = this.fogBaseY;
    const d = positionWorld.sub(cameraPosition).length();
    const h0 = cameraPosition.y.sub(baseY);
    const h1 = positionWorld.y.sub(baseY);
    const dy = h1.sub(h0);
    const e0 = exp(falloff.mul(h0).negate());
    const e1 = exp(falloff.mul(h1).negate());
    const flat = dy.abs().lessThan(0.01);
    const integral = flat.select(e0, e0.sub(e1).div(falloff.mul(dy)));
    const depth = density.mul(d).mul(integral);
    return float(1).sub(exp(depth.negate()));
  }

  async apply(id: LightingPresetId, groundY: number): Promise<void> {
    const p = LIGHTING[id];
    this.preset = p;
    this.preExposure = preExposureFor(p.ev100);
    const sunK = lightColour(p.sunColourK);
    const skyK = lightColour(p.skyColourK);

    this.sunDir.set(Math.cos(p.sunElevationRad) * Math.sin(p.sunAzimuthRad), Math.sin(p.sunElevationRad), Math.cos(p.sunElevationRad) * Math.cos(p.sunAzimuthRad));
    this.sun.color.setRGB(sunK.r, sunK.g, sunK.b);
    this.sun.intensity = p.sunIlluminanceLux * this.preExposure;
    this.sun.position.copy(this.sunDir).multiplyScalar(500);
    this.sun.target.position.set(0, 0, 0);
    this.sunDirection.value.copy(this.sunDir);

    const u = this.sky;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.id === 'golden' ? 2.2 : p.id === 'overcast' ? 0.8 : 1.4;
    u.mieCoefficient.value = p.id === 'overcast' ? 0.02 : 0.005;
    u.mieDirectionalG.value = 0.8;
    // Full overcast is a uniform haze (high turbidity and Mie), not Preetham clouds, which
    // render as dark lenses at full cover.
    u.cloudCoverage.value = p.id === 'overcast' ? 0 : p.cloudCover;
    u.showSunDisc.value = p.id === 'overcast' ? 0 : 1;
    u.sunPosition.value.copy(this.sunDir);
    const skyLum = (p.skyIlluminanceLux / Math.PI) * this.preExposure;

    // Fog: horizon colour = sky luminance tinted by the sky temperature; sun glow by the sun temperature.
    this.fogColour.value.set(skyK.r * skyLum * 1.1, skyK.g * skyLum * 1.1, skyK.b * skyLum * 1.1);
    const glow = (p.sunIlluminanceLux / 1e5) * 0.25 * skyLum * 20;
    this.sunGlowColour.value.set(sunK.r * glow, sunK.g * glow, sunK.b * glow);
    this.fogDensity.value = p.fogDensityPerM;
    this.fogFalloff.value = p.fogHeightFalloffPerM;
    this.fogBaseY.value = groundY;

    // Ground bounce: a mean ground albedo (turf, soil, concrete ≈ 0.2 on the PBR sheet) lit by sun and sky.
    const groundE = (p.sunIlluminanceLux * Math.max(0, Math.sin(p.sunElevationRad)) + p.skyIlluminanceLux) * this.preExposure;
    const bounce = (GROUND_ALBEDO / Math.PI) * groundE;
    this.groundRadiance.value.set(bounce * 1.02, bounce, bounce * 0.9);

    // Outdoor ambient: the sky itself, filtered into an environment probe. The sun
    // disc stays out of the probe: the directional light already carries the sun.
    u.showSunDisc.value = 0;
    this.skyGain.value.set(1, 1, 1);
    const raw = await this.measureSkyIrradiance();
    // Target: the sheet's sky illuminance at the sheet's sky colour temperature (luminance-normalised).
    const k = 1 / (0.2126 * skyK.r + 0.7152 * skyK.g + 0.0722 * skyK.b);
    const e = p.skyIlluminanceLux * this.preExposure * k;
    // The probe (the light the sky casts) takes the sheet's colour temperature per channel;
    // the visible dome keeps Preetham's hues and only takes the brightness scale.
    this.skyGain.value.set((skyK.r * e) / Math.max(1e-9, raw.r), (skyK.g * e) / Math.max(1e-9, raw.g), (skyK.b * e) / Math.max(1e-9, raw.b));
    this.envTexture?.dispose();
    const rt = await this.pmrem.fromSceneAsync(this.skyScene, 0, 0.1, 100);
    this.envTexture = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 1;
    const rawLum = 0.2126 * raw.r + 0.7152 * raw.g + 0.0722 * raw.b;
    const visibleGain = (p.skyIlluminanceLux * this.preExposure) / Math.max(1e-9, rawLum);
    this.skyGain.value.set(visibleGain, visibleGain, visibleGain);
    u.showSunDisc.value = p.id === 'overcast' ? 0 : 1;
  }

  /**
   * Irradiance on a horizontal surface from the sky, per channel, in the sky
   * shader's raw units: E = Σ L · cos θ · dω over an upward view, corrected for the band
   * below 15° elevation the view does not reach (its share of ∫cos dω is 1 − sin²75°).
   */
  private async measureSkyIrradiance(): Promise<{ r: number; g: number; b: number }> {
    const n = CALIBRATION_PX;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.calibTarget);
    this.renderer.render(this.skyScene, this.calibCamera);
    this.renderer.setRenderTarget(prev);
    const data = await this.renderer.readRenderTargetPixelsAsync(this.calibTarget, 0, 0, n, n);
    const halfFov = (CALIBRATION_FOV_DEG * Math.PI) / 360;
    const tanHalf = Math.tan(halfFov);
    const pixel = (2 * tanHalf) / n; // pixel size on the image plane at unit focal length
    let er = 0;
    let eg = 0;
    let eb = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * 2 * tanHalf - tanHalf;
        const y = ((j + 0.5) / n) * 2 * tanHalf - tanHalf;
        const r2 = 1 + x * x + y * y;
        const cosZenith = 1 / Math.sqrt(r2);
        const dOmega = (pixel * pixel) / (r2 * Math.sqrt(r2)); // solid angle of a planar pixel
        const k = (j * n + i) * 4;
        const w = cosZenith * dOmega;
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
    // The square view reaches past 75° in its corners and short of it at the edges; treat it as the 75° cap.
    const capShare = Math.sin(halfFov) ** 2;
    return { r: er / capShare, g: eg / capShare, b: eb / capShare };
  }

  /** Unit vector toward the sun for the current preset. */
  get sunVector(): Vector3 {
    return this.sunDir;
  }

  /** The sky dome and the shadow cascades follow the camera. */
  update(camera: { position: Vector3 }): void {
    this.sky.position.copy(camera.position);
  }

  /** Relative EV of the adapted eye versus the preset: exposure multiplier for the output stage. */
  static exposureMultiplier(presetEv: number, adaptedEv: number): number {
    return 2 ** (presetEv - adaptedEv + EXPOSURE.compensationEv);
  }
}

