import { CircleGeometry, Color, DirectionalLight, Mesh, MeshBasicNodeMaterial, PMREMGenerator, type RenderTarget, Scene, Vector3, type WebGPURenderer } from 'three/webgpu';
import { Atmosphere, SUN_TOA_LUX } from './atmosphere.ts';

// Sun, exposure and the environment probe, driven by the atmosphere (rules
// §4.1–4.3). The three presets the brief asks for; EV100 per preset from
// lighting-reference.png (clear noon 15.3 on the ground; above the weather the
// light is a little stronger at the same sun height). The sun light is the
// top-of-atmosphere illuminance times the transmittance from the camera's
// altitude towards the sun — reddened and dimmed near the horizon by the same
// model that paints the sky. The probe (PMREM) is the sky dome plus a ground
// hemisphere of albedo 0.2 lit by sun and sky (ground bounce), re-baked into the
// same target only when the sun, the exposure or the altitude band changed.

export type PresetId = 'morning' | 'noon' | 'dusk' | 'rain';

export interface LightPreset {
  id: PresetId;
  label: string;
  /** Sun azimuth from north, clockwise (deg), and elevation (deg). */
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  ev100: number;
  /** Cloud layer: base and top altitude (m), coverage 0…1 — used by the cloud pass. */
  cloudBaseM: number;
  cloudTopM: number;
  coverage: number;
  /** Relative humidity factor 0…1 for contrails and vapour. */
  humidity: number;
  /** 0 … 1: rain falling below the cloud base (absent = dry). */
  rain?: number;
}

export const PRESETS: Record<PresetId, LightPreset> = {
  morning: { id: 'morning', label: 'Clear morning', sunAzimuthDeg: 105, sunElevationDeg: 14, ev100: 13.8, cloudBaseM: 2200, cloudTopM: 3200, coverage: 0.12, humidity: 0.9 },
  noon: { id: 'noon', label: 'Broken cloud, noon', sunAzimuthDeg: 170, sunElevationDeg: 62, ev100: 15.0, cloudBaseM: 1600, cloudTopM: 3400, coverage: 0.55, humidity: 0.7 },
  // A low, unbroken deck with steady rain under it: flat grey light (EV ~12 under heavy overcast).
  rain: { id: 'rain', label: 'Rain under a low overcast', sunAzimuthDeg: 170, sunElevationDeg: 45, ev100: 12.2, cloudBaseM: 650, cloudTopM: 2600, coverage: 1, humidity: 1, rain: 1 },
  dusk: { id: 'dusk', label: 'Dusk above an overcast', sunAzimuthDeg: 268, sunElevationDeg: 3, ev100: 12.8, cloudBaseM: 1200, cloudTopM: 2600, coverage: 0.95, humidity: 1 },
};

/** Pre-exposure for an EV100 (Lagarde & de Rousiers 2014). */
export function exposureFor(ev100: number): number {
  return 1 / (1.2 * Math.pow(2, ev100));
}

const GROUND_ALBEDO = 0.2;

/** Where the camera is relative to the cloud layer, for the probe. */
export type CloudSide = 'below' | 'inside' | 'above';

export class SkyLighting {
  readonly sun = new DirectionalLight(0xffffff, 1);
  readonly sunDir = new Vector3(0, 1, 0);
  preset: LightPreset;
  exposure = 1;
  private readonly pmrem: PMREMGenerator;
  private readonly probeScene = new Scene();
  private readonly groundColour = new Color();
  private probeTarget: RenderTarget | null = null;
  /** The cloud deck in the probe: a ceiling seen from below, a floor of tops seen from above. */
  private readonly ceilingMat = new MeshBasicNodeMaterial({ name: 'probe cloud base', transparent: true, depthWrite: false });
  private readonly floorMat = new MeshBasicNodeMaterial({ name: 'probe cloud tops', transparent: true, depthWrite: false });
  private readonly ceiling: Mesh;
  private readonly floor: Mesh;
  private cloud = { coverage: 0, side: 'below' as CloudSide };
  private lastBake = { sunY: -2, exposure: -1, band: -999, cloudKey: '' };
  private lastSunT = { band: -999, sunY: -2 };

  constructor(
    private readonly renderer: WebGPURenderer,
    readonly atmosphere: Atmosphere,
    presetId: PresetId,
  ) {
    this.pmrem = new PMREMGenerator(renderer);
    this.preset = PRESETS[presetId];
    // The probe: the sky dome scaled inside the bake camera's far plane, and a ground disc below.
    const dome = atmosphere.dome.clone();
    dome.scale.setScalar(1 / 10_000);
    this.probeScene.add(dome);
    const groundMat = new MeshBasicNodeMaterial({ name: 'probe ground', color: this.groundColour });
    const ground = new Mesh(new CircleGeometry(48, 32).rotateX(-Math.PI / 2), groundMat);
    ground.position.y = -2;
    this.probeScene.add(ground);
    // Cloud deck discs, inside the dome (radius 50) and nearer than the ground disc, so the probe
    // sees an overcast as a grey ceiling (dim, flat ambient underneath) or a white floor (the bright
    // glow from below when flying over the tops).
    this.ceiling = new Mesh(new CircleGeometry(45, 48).rotateX(Math.PI / 2), this.ceilingMat);
    this.ceiling.position.y = 1;
    this.floor = new Mesh(new CircleGeometry(45, 48).rotateX(-Math.PI / 2), this.floorMat);
    this.floor.position.y = -1;
    this.probeScene.add(this.ceiling, this.floor);
    // The sun's shadow map follows the aircraft (self-shadowing, the runway, nearby ground).
    const l = this.sun;
    l.castShadow = true;
    l.shadow.mapSize.set(2048, 2048);
    const sc = l.shadow.camera;
    sc.left = -45;
    sc.right = 45;
    sc.top = 45;
    sc.bottom = -45;
    sc.near = 1;
    sc.far = 2000;
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = 0.05;
    this.setPreset(presetId);
  }

  /** Compiles the probe's shaders so the first bake (synchronous) draws something. */
  async prepare(camera: import('three/webgpu').Camera): Promise<void> {
    await this.renderer.compileAsync(this.probeScene, camera);
    await this.pmrem.compileCubemapShader();
  }

  setPreset(id: PresetId): void {
    this.preset = PRESETS[id];
    const az = (this.preset.sunAzimuthDeg * Math.PI) / 180;
    const el = (this.preset.sunElevationDeg * Math.PI) / 180;
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    this.exposure = exposureFor(this.preset.ev100);
    this.lastSunT.band = -999;
  }

  /** The cloud layer as the probe should see it (coverage 0…1; which side of the deck the camera is on). */
  setCloudCover(coverage: number, side: CloudSide): void {
    this.cloud.coverage = coverage;
    this.cloud.side = side;
  }

  /** Per frame: sun colour from the transmittance at this altitude, the LUTs, the probe when stale. */
  update(camera: { position: Vector3; projectionMatrix: import('three/webgpu').Matrix4; matrixWorld: import('three/webgpu').Matrix4 }, followM: Vector3): void {
    const sunIll = SUN_TOA_LUX * this.exposure;
    this.atmosphere.update(this.renderer, camera, { sunDir: this.sunDir, sunIlluminance: sunIll });
    const band = Math.round(camera.position.y / 250);
    if (band !== this.lastSunT.band || Math.abs(this.sunDir.y - this.lastSunT.sunY) > 1e-4) {
      const T = Atmosphere.sunTransmittanceCpu(camera.position.y, this.sunDir);
      const lum = 0.2126 * T.x + 0.7152 * T.y + 0.0722 * T.z;
      this.sun.color.setRGB(T.x / Math.max(lum, 1e-6), T.y / Math.max(lum, 1e-6), T.z / Math.max(lum, 1e-6));
      this.sun.intensity = sunIll * lum;
      // Ground bounce for the probe: albedo/π × (direct on the ground + roughly a fifth again from the sky).
      const Tg = Atmosphere.sunTransmittanceCpu(0, this.sunDir);
      const e = SUN_TOA_LUX * Math.max(this.sunDir.y, 0) * this.exposure * 1.2;
      this.groundColour.setRGB((GROUND_ALBEDO / Math.PI) * e * Tg.x, (GROUND_ALBEDO / Math.PI) * e * Tg.y, (GROUND_ALBEDO / Math.PI) * e * Tg.z);
      this.lastSunT = { band, sunY: this.sunDir.y };
    }
    this.sun.position.copy(followM).addScaledVector(this.sunDir, 800);
    this.sun.target.position.copy(followM);
    const probeBand = Math.round(camera.position.y / 1000);
    const b = this.lastBake;
    const cloudKey = `${this.cloud.side}:${this.cloud.coverage.toFixed(2)}`;
    if (Math.abs(this.sunDir.y - b.sunY) > 0.005 || Math.abs(this.exposure - b.exposure) > 1e-12 || probeBand !== b.band || cloudKey !== b.cloudKey || !this.probeTarget) {
      this.updateCloudDeck();
      this.bake(probeBand, cloudKey);
    }
  }

  private updateCloudDeck(): void {
    // Rough radiances of the deck, pre-exposed: sunlit tops as a diffuse white surface (plus a
    // little sky), the base transmitting what a deck of that coverage lets through (~15 % when overcast).
    const T = Atmosphere.sunTransmittanceCpu(2500, this.sunDir);
    const e = SUN_TOA_LUX * this.exposure;
    const top = (e * (Math.max(this.sunDir.y, 0) * 0.8 + 0.06)) / Math.PI;
    const base = top * (1 - 0.85 * this.cloud.coverage) * 0.6;
    this.floorMat.color.setRGB(top * T.x, top * T.y, top * T.z);
    this.ceilingMat.color.setRGB(base * T.x, base * T.y, base * T.z);
    const cov = this.cloud.coverage;
    this.ceiling.visible = this.cloud.side !== 'above' && cov > 0.01;
    this.floor.visible = this.cloud.side !== 'below' && cov > 0.01;
    this.ceilingMat.opacity = this.cloud.side === 'inside' ? 1 : cov;
    this.floorMat.opacity = this.cloud.side === 'inside' ? 1 : cov;
  }

  private bake(band: number, cloudKey: string): void {
    // Re-bake into the same target: the environment texture keeps its identity, nothing recompiles.
    const rt = this.pmrem.fromScene(this.probeScene, 0, 0.1, 100, this.probeTarget ? { size: 128, renderTarget: this.probeTarget } : { size: 128 });
    if (!this.probeTarget) this.probeTarget = rt;
    this.lastBake = { sunY: this.sunDir.y, exposure: this.exposure, band, cloudKey };
  }

  get environment(): import('three/webgpu').Texture | null {
    return this.probeTarget ? this.probeTarget.texture : null;
  }
}
