import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { cameraPosition, exp, float, fog, max, positionWorld, pow, uniform, vec4 } from 'three/tsl';
import { DirectionalLight, PMREMGenerator, Scene, type Texture, Vector3, type WebGPURenderer } from 'three/webgpu';
import { EXPOSURE, LIGHTING, type LightingPreset, type LightingPresetId } from '../config.ts';
import { kelvinToLinearRgb, preExposureFor } from './colour.ts';

// Sun, sky, environment and height fog for one lighting preset from
// lighting-reference.png. Every intensity is authored in physical units (lux)
// and multiplied by the preset's pre-exposure factor before rendering, so the
// sun on polished metal never overflows FP16 (rules §2.2). The auto-exposure
// system then adjusts around that anchor.

// The Preetham sky outputs radiance in its own units. This factor maps its
// horizon brightness to the preset's sky luminance (E_sky / π, pre-exposed);
// tuned by hand against a grey card at noon so the sky sits ~1 stop above it.
const SKY_GAIN_K = 0.13;
// Preetham's own sun term at noon elevation (EE · (1 − e^−((cutoff − zenith)/1.5))), used to normalise.
const PREETHAM_NOON_SUN_E = 546;
// Sun cascades: split to the real play distance (rules §2.3), not the default.
const CSM_MAX_FAR_M = { high: 450, low: 220 } as const;

export class Lighting {
  readonly sun = new DirectionalLight(0xffffff, 1);
  readonly sky = new SkyMesh();
  readonly csm: CSMShadowNode;
  private readonly skyScene = new Scene();
  private readonly pmrem: PMREMGenerator;
  private envTexture: Texture | null = null;
  private readonly skyGain = uniform(1);
  private readonly fogColour = uniform(new Vector3());
  private readonly sunGlowColour = uniform(new Vector3());
  private readonly sunDirection = uniform(new Vector3(0, 1, 0));
  private readonly fogDensity = uniform(0);
  private readonly fogFalloff = uniform(0.005);
  private readonly fogBaseY = uniform(0);
  preset: LightingPreset = LIGHTING.noon;
  preExposure = preExposureFor(LIGHTING.noon.ev100);
  private readonly sunDir = new Vector3();

  constructor(
    renderer: WebGPURenderer,
    private readonly scene: Scene,
    quality: 'high' | 'low',
  ) {
    this.pmrem = new PMREMGenerator(renderer);
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
    const sunK = kelvinToLinearRgb(p.sunColourK);
    const skyK = kelvinToLinearRgb(p.skyColourK);

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
    u.cloudCoverage.value = p.cloudCover;
    u.showSunDisc.value = p.id === 'overcast' ? 0 : 1;
    u.sunPosition.value.copy(this.sunDir);
    const zenith = Math.PI / 2 - p.sunElevationRad;
    const sunE = 1000 * Math.max(0.02, 1 - Math.exp(-(1.6110731556870734 - zenith) / 1.5));
    const skyLum = (p.skyIlluminanceLux / Math.PI) * this.preExposure;
    this.skyGain.value = (SKY_GAIN_K * skyLum) / (sunE / PREETHAM_NOON_SUN_E) ** 1.5 / ((15000 / Math.PI) * preExposureFor(15.3));

    // Fog: horizon colour = sky luminance tinted by the sky temperature; sun glow by the sun temperature.
    this.fogColour.value.set(skyK.r * skyLum * 1.1, skyK.g * skyLum * 1.1, skyK.b * skyLum * 1.1);
    const glow = (p.sunIlluminanceLux / 1e5) * 0.25 * skyLum * 20;
    this.sunGlowColour.value.set(sunK.r * glow, sunK.g * glow, sunK.b * glow);
    this.fogDensity.value = p.fogDensityPerM;
    this.fogFalloff.value = p.fogHeightFalloffPerM;
    this.fogBaseY.value = groundY;

    // Outdoor ambient: the sky itself, filtered into an environment probe.
    this.envTexture?.dispose();
    const rt = await this.pmrem.fromSceneAsync(this.skyScene, 0, 0.1, 100);
    this.envTexture = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 1;
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

