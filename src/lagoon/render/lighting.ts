import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { cameraPosition, exp, float, fog, positionWorld } from 'three/tsl';
import { DirectionalLight, PMREMGenerator, Scene, type Texture, Vector3, type WebGPURenderer } from 'three/webgpu';
import { lightColour, type LinearRgb, preExposureFor } from '../../render/colour.ts';
import { GRAPHICS } from '../config.ts';
import type { Environment } from '../game/environment.ts';
import { buildSkyDome, hazeColour } from './sky.ts';
import { U } from './uniforms.ts';

// Turns the logic's physical daylight (lux, kelvin) into lights, sky uniforms,
// fog and an environment probe. Every value is pre-exposed with the frame's
// anchor EV (lighting sheet; Lagarde & de Rousiers 2014) so the sun disc and
// its glint on the water stay inside FP16.

const PROBE_MIN_INTERVAL_S = 0.35;
const CLOUD_DRIFT_SCALE = 1 / 5200; // cloud texture tile size (sky.ts)

export class LagoonLighting {
  readonly light = new DirectionalLight(0xffffff, 1);
  readonly csm: CSMShadowNode;
  readonly sky = buildSkyDome(true);
  private readonly probeScene = new Scene();
  private readonly pmrem: PMREMGenerator;
  private envTexture: Texture | null = null;
  private bakedPreExposure = 1;
  private probeAge = 999;
  private baking = false;
  private lastBake = { sunY: -9, ev: -99, cover: -1, night: -1, rain: -1 };
  preExposure = 1;
  anchorEv = 15;
  private readonly tmp = new Vector3();

  constructor(
    renderer: WebGPURenderer,
    private readonly scene: Scene,
    quality: 'high' | 'low',
  ) {
    this.pmrem = new PMREMGenerator(renderer);
    const l = this.light;
    l.castShadow = true;
    const px = GRAPHICS.shadowMapPx[quality];
    l.shadow.mapSize.set(px, px);
    l.shadow.bias = -0.0003;
    l.shadow.normalBias = 0.035;
    this.csm = new CSMShadowNode(l, { cascades: quality === 'high' ? 3 : 2, maxFar: GRAPHICS.shadowRangeM[quality], mode: 'practical', lightMargin: 60 });
    this.csm.fade = true;
    l.shadow.shadowNode = this.csm;
    scene.add(l, l.target, this.sky);
    this.probeScene.add(buildSkyDome(false));
    scene.fogNode = fog(hazeColour(positionWorld.sub(cameraPosition).normalize()), heightFogFactor());
  }

  /** Once per frame, before rendering. */
  update(env: Environment, camera: { position: Vector3 }, dtSeconds: number): void {
    const d = env.daylight;
    const w = env.weather;
    this.anchorEv = d.anchorEv;
    const pre = preExposureFor(d.anchorEv);
    this.preExposure = pre;
    U.preExposure.value = pre;
    const sinEl = d.sunDir.y;
    const cover = w.cloudCover;

    const sunK = lightColour(Math.min(15000, Math.max(1000, d.sunColourK)));
    const moonK = lightColour(7600);
    // The one shadow-casting light is the sun by day and the moon by night.
    const sunE = d.sunNormalLux;
    const moonE = d.moonLux;
    const useMoon = sunE * Math.max(0, sinEl) < moonE * d.moonDir.y;
    const dir = useMoon ? d.moonDir : d.sunDir;
    const col = useMoon ? moonK : sunK;
    const e = useMoon ? moonE : sunE;
    this.light.color.setRGB(col.r, col.g, col.b);
    this.light.intensity = e * pre;
    this.tmp.set(dir.x, dir.y, dir.z);
    this.light.position.copy(camera.position).addScaledVector(this.tmp, 400);
    this.light.target.position.copy(camera.position);
    this.light.castShadow = e * pre > 1e-4;
    U.sunDir.value.set(d.sunDir.x, d.sunDir.y, d.sunDir.z);
    U.sunIrradiance.value.set(col.r * e * pre, col.g * e * pre, col.b * e * pre);
    U.moonDir.value.set(d.moonDir.x, d.moonDir.y, d.moonDir.z);

    // Sky colours: luminance-normalised hues, scaled so the dome delivers the sky illuminance.
    const sunset = sinEl > -0.12 ? 1 - smooth(0.04, 0.4, sinEl) : 0;
    const overcast = cover ** 1.5;
    const zen = mixRgb(mixRgb(mixRgb(norm(0.13, 0.34, 1.0), norm(0.2, 0.28, 0.72), sunset), norm(0.07, 0.11, 0.3), d.night), norm(0.78, 0.82, 0.88), overcast);
    const hor = mixRgb(mixRgb(mixRgb(norm(0.58, 0.77, 1.0), norm(1.0, 0.66, 0.42), sunset * 0.75), norm(0.12, 0.15, 0.26), d.night), norm(0.8, 0.83, 0.87), overcast);
    const ratio = 1.5 * (1 - overcast) + 0.55 * overcast;
    const zL = (d.skyLux / Math.PI / (0.184 * ratio + 0.816)) * pre;
    const hL = zL * ratio;
    U.zenithRadiance.value.set(zen.r * zL, zen.g * zL, zen.b * zL);
    U.horizonRadiance.value.set(hor.r * hL, hor.g * hL, hor.b * hL);
    const avg = mixRgb(hor, zen, 0.5);
    const skyE = d.skyLux * pre;
    U.skyIrradiance.value.set(avg.r * skyE, avg.g * skyE, avg.b * skyE);
    // Ground bounce: a mean albedo of sand, turf, jungle floor and lagoon, lit by sun, sky and moon.
    const groundE = (sunE * Math.max(0, sinEl) + d.skyLux + moonE * Math.max(0, d.moonDir.y)) * pre;
    const bounce = (0.24 / Math.PI) * groundE;
    U.groundRadiance.value.set(bounce * 1.02, bounce, bounce * 0.86);
    const glowK = ((0.06 + 0.5 * sunset) * (1 - 0.8 * cover) * sunE) / Math.PI * pre;
    U.sunGlowRadiance.value.set(sunK.r * glowK, sunK.g * glowK, sunK.b * glowK);
    const discL = (sunE / 4e-4) * pre; // disc drawn 1.3° wide: Ω ≈ 4e-4 sr
    U.sunDiscRadiance.value.set(sunK.r * discL, sunK.g * discL, sunK.b * discL);
    const moonL = ((moonE + 0.02 * d.night) / 7.7e-4) * pre * (1 - cover * 0.7);
    U.moonRadiance.value.set(moonK.r * moonL, moonK.g * moonL, moonK.b * moonL);
    U.night.value = d.night;
    U.starBrightness.value = d.night * (1 - cover) * zL * 30;
    U.cloudCover.value = cover;
    const litK = ((sunE * Math.max(sinEl, 0.06) * 0.35 + d.skyLux * 0.55 + moonE * 0.3) / Math.PI) * pre;
    const shadeK = ((d.skyLux * 0.5 + sunE * 0.02 * (1 - cover)) / Math.PI) * pre;
    const litCol = mixRgb(sunK, { r: 1, g: 1, b: 1 }, 0.35);
    U.cloudLit.value.set(litCol.r * litK, litCol.g * litK, litCol.b * litK);
    U.cloudShade.value.set(avg.r * shadeK * 0.95, avg.g * shadeK, avg.b * shadeK * 1.05);
    const wind = env.windVector({ x: 0, z: 0 });
    U.cloudOffset.value.x += wind.x * 3 * dtSeconds * CLOUD_DRIFT_SCALE;
    U.cloudOffset.value.y += wind.z * 3 * dtSeconds * CLOUD_DRIFT_SCALE;
    U.lightning.value = env.lightningFlash;
    U.rain.value = w.rainRate;
    U.wetness.value = env.wetness;
    U.wind.value.set(wind.x, wind.z);

    // Haze: humid tropical air, a low morning mist, and rain curtains.
    const mist = smooth(6.3, 7.2, env.hour) * (1 - smooth(8.3, 10, env.hour));
    U.fogDensity.value = w.fogDensityPerM * (1 + mist * 5);
    U.fogFalloff.value = 0.012 + mist * 0.05;

    this.updateProbe(env, dtSeconds);
    this.sky.position.copy(camera.position);
  }

  /** Re-bakes the sky probe when the sky has visibly changed; between bakes, scales it by the pre-exposure ratio. */
  private updateProbe(env: Environment, dtSeconds: number): void {
    this.probeAge += dtSeconds;
    // A lightning flash lights the whole storm-dark scene through the probe for a moment.
    if (this.envTexture) this.scene.environmentIntensity = (this.preExposure / this.bakedPreExposure) * (1 + env.lightningFlash * 6);
    if (this.baking || this.probeAge < PROBE_MIN_INTERVAL_S) return;
    const d = env.daylight;
    const b = this.lastBake;
    const changed = Math.abs(d.sunDir.y - b.sunY) > 0.01 || Math.abs(d.anchorEv - b.ev) > 0.25 || Math.abs(env.weather.cloudCover - b.cover) > 0.03 || Math.abs(d.night - b.night) > 0.03 || Math.abs(env.lightningFlash) > 0.2;
    if (!changed && this.envTexture) return;
    this.baking = true;
    this.probeAge = 0;
    const pre = this.preExposure;
    this.lastBake = { sunY: d.sunDir.y, ev: d.anchorEv, cover: env.weather.cloudCover, night: d.night, rain: env.weather.rainRate };
    try {
      const rt = this.pmrem.fromScene(this.probeScene, 0, 0.1, 100);
      this.envTexture?.dispose();
      this.envTexture = rt.texture;
      this.bakedPreExposure = pre;
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = this.preExposure / pre;
    } finally {
      this.baking = false;
    }
  }

  /** Waits for the first probe, so the loading screen covers it. */
  async bakeNow(env: Environment, camera: { position: Vector3 }): Promise<void> {
    this.update(env, camera, 0);
    await this.pmrem.compileEquirectangularShader();
    const rt = this.pmrem.fromScene(this.probeScene, 0, 0.1, 100);
    this.envTexture?.dispose();
    this.envTexture = rt.texture;
    this.bakedPreExposure = this.preExposure;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 1;
    this.lastBake = { sunY: env.daylight.sunDir.y, ev: env.daylight.anchorEv, cover: env.weather.cloudCover, night: env.daylight.night, rain: env.weather.rainRate };
  }
}

/**
 * Exponential height fog, integrated along the view ray:
 * optical depth = ρ₀ · d · (e^(−f·h₀) − e^(−f·h₁)) / (f · (h₁ − h₀)).
 */
function heightFogFactor() {
  const density = U.fogDensity;
  const falloff = U.fogFalloff;
  const d = positionWorld.sub(cameraPosition).length();
  const h0 = cameraPosition.y;
  const h1 = positionWorld.y;
  const dy = h1.sub(h0);
  const e0 = exp(falloff.mul(h0).negate());
  const e1 = exp(falloff.mul(h1).negate());
  const flat = dy.abs().lessThan(0.01);
  const integral = flat.select(e0, e0.sub(e1).div(falloff.mul(dy)));
  return float(1).sub(exp(density.mul(d).mul(integral).negate()));
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** A hue with unit luminance. */
function norm(r: number, g: number, b: number): LinearRgb {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { r: r / l, g: g / l, b: b / l };
}

function mixRgb(a: LinearRgb, b: LinearRgb, t: number): LinearRgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
