import { buildParisStreet, parisLamps, syncParisLight, tickParis } from './parisStreet.ts';
import { loadPhotoTextures } from './photoTextures.ts';
import { loadScanModels } from './scanModels.ts';
import { loadHandMesh } from './handMesh.ts';
import { loadGunModels } from './gunModels.ts';
import { loadMocap } from './mocap.ts';
import { type HdriSetting, loadHdri } from './hdri.ts';
import { Object3D, Vector3 } from 'three/webgpu';
import { CITY_LIGHTS, EXPOSURE, LAKE_WAVES, type LightingPresetId, WORLD_WIND } from '../config.ts';
import { damp } from '../core/vec.ts';
import type { GameEvent } from '../game/events.ts';
import type { Game } from '../game/game.ts';
import type { MapData } from '../maps/types.ts';
import { ActorView } from './actors.ts';
import { Effects } from './effects.ts';
import { AutoExposure } from './exposure.ts';
import { Foliage, windVector } from './foliage.ts';
import { buildFarRing, buildTerrainMesh, type LakeFx } from './ground.ts';
import { Caustics } from './caustics.ts';
import { computeShoreField, lakeDomain, shoreFieldTexture } from './shoreField.ts';
import { buildLakeWater } from './water.ts';
import { RippleField } from './rippleField.ts';
import { waterDepth } from '../maps/lake.ts';
import { W } from './waterUniforms.ts';
import { sampleHeight } from '../maps/terrain.ts';
import { interiorSkyFraction, setInteriorVolumes } from './interior.ts';
import { Lighting } from './lighting.ts';
import { bakeCloudField, CLOUD_QUALITY, VolumeClouds } from './volumeClouds.ts';
import { Breaches } from './breaches.ts';
import { CITY, FOLIAGE, MaterialLibrary, wetness } from './materials.ts';
import { CityLights } from './cityLights.ts';
import { buildProps, type PropsView } from './props.ts';
import { loadCarModels } from './vehicleModels.ts';
import { loadSoldierCast } from './soldierCast.ts';
import { CpuTimer } from './perf.ts';
import { Stage, type StageSettings } from './stage.ts';
import { Undergrowth } from './undergrowth.ts';
import { VIEWMODEL_LAYER, VM_SCALE, ViewModel } from './viewmodel.ts';
import { WorldFx } from './worldFx.ts';
import { buildStaticWorld, type StaticWorld } from './worldMesh.ts';
import { buildStreetFurniture } from './streetFurniture.ts';
import { buildWetStreet, puddleAmount, rainRate, wetTime } from './wetStreet.ts';
import { Rain } from './rain.ts';
import { roomDaylight } from './roomInteriors.ts';
import { warmAllPipelines } from './warmup.ts';
import { WeaponLight } from './weaponLight.ts';
import { buildSkyline } from './skyline.ts';

// The render system: reads game state, writes transforms (rules §10 — logic
// never touches THREE). Owns the stage, lighting, exposure and every visual
// subsystem, and drives them once per display frame.

export interface ViewSettings extends StageSettings {
  preset: LightingPresetId;
  wet: boolean;
  shake: number; // global camera-shake scale, player adjustable
}

export type Progress = (label: string, fraction: number) => Promise<void>;

export class GameView {
  readonly stage: Stage;
  private lighting!: Lighting;
  private clouds!: VolumeClouds;
  /** Holes the grenades blow in the city's façades (breaches.ts); null on maps without façades. */
  private breaches: Breaches | null = null;
  private exposure!: AutoExposure;
  private world!: StaticWorld;
  private readonly actors = new ActorView();
  private viewModel!: ViewModel;
  private effects!: Effects;
  private worldFx!: WorldFx;
  private weaponLight!: WeaponLight;
  private foliage!: Foliage;
  private caustics: Caustics | null = null;
  private lakeFx: LakeFx | null = null;
  /** Interactive ripples on the lake: legs wading, bullets and blasts (rippleField.ts). */
  private ripples: RippleField | null = null;
  private undergrowth!: Undergrowth;
  /** The city's rain and street lamps (null elsewhere). */
  private rain: Rain | null = null;
  private cityLights: CityLights | null = null;
  private props: PropsView | null = null;
  private settings: ViewSettings;
  private shake = 0;
  private interiorK = 1;
  private scopeReady = false;
  private readonly muzzleMarker = new Object3D();
  private readonly eye = new Vector3();
  private readonly tmp = new Vector3();
  private deathTilt = 0;
  /** CPU milliseconds per part of render() (F3, benchmark). */
  readonly cpu = new CpuTimer();

  private constructor(
    canvas: HTMLCanvasElement,
    private readonly map: MapData,
    settings: ViewSettings,
  ) {
    this.settings = { ...settings };
    this.stage = new Stage(canvas, settings);
  }

  static async create(canvas: HTMLCanvasElement, map: MapData, settings: ViewSettings, progress: Progress): Promise<GameView> {
    const v = new GameView(canvas, map, settings);
    await v.build(progress);
    return v;
  }

  private async build(progress: Progress): Promise<void> {
    const { stage, map } = this;
    await progress('Starting renderer', 0.05);
    await stage.init();
    stage.camera.layers.enable(VIEWMODEL_LAYER);
    // The photographed sets are decoded before any material asks for one (photoTextures.ts).
    await progress('Loading textures', 0.1);
    const [, , , , cast] = await Promise.all([loadPhotoTextures(), loadScanModels(), loadMocap(), loadHandMesh(), loadSoldierCast(this.settings.quality), loadGunModels()]);
    this.actors.useCast(cast);
    await progress('Generating textures', 0.15);
    FOLIAGE.translucent = this.settings.quality === 'high';
    CITY.lamps = map.id === 'city' || map.id === 'boulevard';
    const lib = new MaterialLibrary();
    setInteriorVolumes(map.interiors);
    // The forest lake: its wave field is solved over the carved bed once here; the terrain
    // shader reads it (swash, wet bank) along with the caustics pass.
    if (map.lake) {
      await progress('Filling the lake', 0.2);
      const lake = map.lake;
      const w = WORLD_WIND[map.id];
      const ground = (x: number, z: number): number => sampleHeight(map.terrain, x, z);
      const domain = lakeDomain(lake);
      const field = { texture: shoreFieldTexture(computeShoreField(domain, lake.levelM, ground, { x: Math.sin(w.directionRad), z: Math.cos(w.directionRad) })), domain };
      this.caustics = new Caustics(this.settings.quality);
      stage.passTimer.name(this.caustics.target, 'water');
      this.lakeFx = { lake, field, caustics: this.caustics };
      this.ripples = new RippleField({
        cells: this.settings.quality === 'high' ? 128 : 96,
        cellM: 0.2,
        speedMps: 1.1,
        lifeS: 1.8,
        isWater: (x, z) => waterDepth(lake, x, z, ground(x, z)) > 0.02,
      });
      stage.scene.add(buildLakeWater(lake, field, ground, this.settings.quality, this.ripples));
    }
    // On the boulevard the Paris street is the ground (parisStreet.ts): a terrain mesh at road level would fight it.
    if (map.id !== 'boulevard') stage.scene.add(buildTerrainMesh(map, lib, this.lakeFx));
    stage.scene.add(buildFarRing(map));
    await progress('Building the world', 0.35);
    this.world = buildStaticWorld(map, lib);
    // The shared car models (shared/vehicles), only on maps that park cars.
    if (map.props.some((p) => p.kind === 'car')) await loadCarModels(this.settings.quality);
    this.props = buildProps(map.props, lib);
    stage.scene.add(this.world.group, this.props.group);
    const furniture = buildStreetFurniture(map, lib);
    if (furniture) stage.scene.add(furniture);
    // The city in the rain: standing water, rings and reflections on the street, and the rain itself.
    // The boulevard: the Paris scene's street and façades over the map's colliders (parisStreet.ts).
    if (map.id === 'boulevard') stage.scene.add(await buildParisStreet());
    if (map.id === 'city') {
      // The city beyond the map: a skyline of towers to the horizon (skyline.ts).
      stage.scene.add(buildSkyline());
      this.breaches = new Breaches(map.boxes);
      stage.scene.add(this.breaches.group);
      stage.scene.add(buildWetStreet(map, this.settings.quality));
      this.rain = new Rain(map, this.settings.quality);
      const w = WORLD_WIND.city;
      this.rain.wind.value.set(Math.sin(w.directionRad) * w.speedMs, Math.cos(w.directionRad) * w.speedMs);
      stage.scene.add(this.rain.mesh);
    }
    await progress('Planting trees', 0.5);
    this.foliage = new Foliage(map.trees, map.bushes, lib, this.settings.quality, stage.renderer);
    await progress('Growing undergrowth', 0.55);
    this.undergrowth = new Undergrowth(map, lib, this.settings.quality);
    stage.scene.add(this.foliage.group, this.undergrowth.group, this.actors.group);
    await progress('Lighting', 0.6);
    this.lighting = new Lighting(stage.renderer, stage.scene, this.settings.quality);
    this.lighting.setLake(map.lake ?? null);
    await progress('Raising clouds', 0.6);
    this.clouds = new VolumeClouds(await bakeCloudField(), CLOUD_QUALITY[this.settings.quality]);
    this.lighting.clouds = this.clouds;
    stage.setClouds(this.clouds);
    await this.lighting.apply(this.settings.preset, map.playerSpawn.pos.y, await loadHdri(hdriSetting(map.id), this.settings.preset));
    this.exposure = new AutoExposure(stage.renderer, this.sceneEv());
    if (map.id === 'city') this.cityLights = new CityLights(map, stage.scene, this.settings.quality);
    // The boulevard by night: its candelabra's lanterns, warm and soft (parisStreet.ts).
    if (map.id === 'boulevard') this.cityLights = new CityLights(map, stage.scene, this.settings.quality, parisLamps(map.halfSizeM));
    const w = WORLD_WIND[map.id];
    windVector.value.set(Math.sin(w.directionRad) * w.speedMs, 0, Math.cos(w.directionRad) * w.speedMs);
    this.applyWeather();
    this.viewModel = new ViewModel(this.scopeSidePx());
    stage.passTimer.name(this.viewModel.scope.target, 'scope');
    stage.camera.add(this.viewModel.root);
    this.viewModel.setEnvironment(stage.scene.environment, 1);
    this.effects = new Effects(stage.scene);
    this.worldFx = new WorldFx(stage.scene, map);
    // Before the shader pre-compile: a light added later would recompile every material (weaponLight.ts).
    this.weaponLight = new WeaponLight(stage.scene, this.settings.quality);
    this.syncPreExposure();
    // Cloud shadows on everything the sun shadows, now that the world is built.
    this.clouds.shadeReceivers(stage.scene, this.settings.quality === 'high' ? 3 : 2);
    // The camera at the spawn and the streamed plants filled for it: the warm-up frame (warmUp, behind the
    // loading screen) builds every shader the first frames need, one object per build shown. No separate
    // pre-compile: three r186's compileAsync over the scene built one pipeline and hung until its 20 s
    // timeout on every load, and one call per object, all at once, came out slower than the warm-up frame
    // building them itself (measured on WebGPU, every game: Field Line 71 s → 59 s without it).
    this.stage.camera.position.set(map.playerSpawn.pos.x, map.playerSpawn.pos.y + 1.7, map.playerSpawn.pos.z);
    // Fill the streamed plant meshes first: an instanced mesh first seen empty (count 0) never drew in the
    // main pass afterwards (three r186), though its shadows did.
    this.foliage.update(this.stage.camera.position);
    this.undergrowth.update(this.stage.camera.position);
    await progress('Ready', 1);
  }

  /**
   * The exposure the eye settles at here: the preset's, except on a lamp-lit street at night. The night
   * preset's EV is for a moonlit, overcast field (~8 lux the brightest); exposed so, a street under its
   * lamps (20–60 lux) came out as an orange noon. A night street is exposed as a photographer would
   * (EV tables: lit night streets ~5–8), its lamp-lit paving a little under mid-grey, the sky near black.
   */
  private sceneEv(): number {
    const p = this.lighting.preset;
    const id = this.map.id;
    if (p.id !== 'night' || (id !== 'city' && id !== 'boulevard')) return p.ev100;
    return CITY_LIGHTS.streetEv100[id];
  }

  private syncPreExposure(): void {
    if (this.map.id === 'boulevard') syncParisLight(this.lighting.preset, this.lighting.preExposure);
    this.effects.preExposure = this.lighting.preExposure;
    this.worldFx.preExposure = this.lighting.preExposure;
  }

  /** Scope target: square, about the ocular's on-screen size, never over half the view height. */
  private scopeSidePx(): number {
    const h = window.innerHeight * window.devicePixelRatio * this.settings.renderScale;
    const lensFraction = 0.32; // ocular diameter as a share of the view height when aimed
    const side = Math.min(h * 0.5, h * lensFraction);
    return 2 ** Math.round(Math.log2(Math.max(128, side)));
  }

  async applySettings(s: ViewSettings): Promise<void> {
    const presetChanged = s.preset !== this.settings.preset;
    this.settings = { ...s };
    // The march is built into the pipeline: its quality first, then the rebuild.
    this.clouds.quality = CLOUD_QUALITY[s.quality];
    this.stage.applySettings(s);
    if (presetChanged) {
      await this.lighting.apply(s.preset, this.map.playerSpawn.pos.y, await loadHdri(hdriSetting(this.map.id), s.preset));
      this.exposure.reset(this.sceneEv());
      this.viewModel.setEnvironment(this.stage.scene.environment, this.interiorK);
      this.syncPreExposure();
    }
    this.applyWeather();
  }

  /** Wet streets (the city's rain setting): soaked materials, standing water, falling rain lit by the sky. */
  private applyWeather(): void {
    const wet = this.settings.wet && this.map.id === 'city';
    wetness.value = wet ? 1 : 0;
    puddleAmount.value = wet ? 1 : 0;
    rainRate.value = wet ? 1 : 0;
    this.cityLights?.setNight(this.lighting.preset.id === 'night', this.lighting.preExposure);
    // Rooms get ~5 % of the light outside by the window, falling off inwards (roomInteriors.ts): the
    // daylight factor of an ordinary room near its window.
    const outside = this.lighting.preset.skyIlluminanceLux + this.lighting.preset.sunIlluminanceLux * 0.3;
    roomDaylight.value = outside * 0.05 * this.lighting.preExposure;
    if (this.rain) {
      this.rain.rate.value = wet ? 1 : 0;
      const sky = (this.lighting.preset.skyIlluminanceLux / Math.PI) * this.lighting.preExposure;
      this.rain.light.value.set(sky * 0.9, sky * 0.95, sky);
    }
  }

  beforeStep(game: Game): void {
    this.actors.beforeStep(game.soldiers);
  }

  handleEvents(events: readonly GameEvent[], game: Game): void {
    for (const e of events) {
      if (e.type === 'shot' && e.shooterId === game.player.id) {
        this.shake += 0.15;
        this.effects.handle(e, game.player.id, this.muzzleWorld());
        continue;
      }
      if (e.type === 'playerHit') this.shake += e.armour ? 0.4 : 0.7;
      if (e.type === 'explosion' && e.kind === 'frag' && this.breaches) {
        // Against a façade, a frag breaks the wall (breaches.ts): the masonry flies out of the hole.
        const hole = this.breaches.blast(e.pos.x, e.pos.y, e.pos.z);
        if (hole) this.effects.wallBurst(hole.x, hole.y, hole.z, hole.nx, hole.nz, hole.look === 'brick' || hole.look === 'brickDark' ? 0x7a4636 : 0x8a8781);
      }
      if (e.type === 'explosion' && e.kind !== 'smoke') {
        // the blast lays the grass flat outward from the centre
        this.undergrowth.grass?.stamp(e.pos.x, e.pos.z, 4, 0, 0, 1);
        if (this.inLake(e.pos.x, e.pos.y - 1.5, e.pos.z)) this.ripples?.disturb(e.pos.x, e.pos.z, 1.6, 0.18);
        const d = this.stage.camera.position.distanceTo(this.tmp.set(e.pos.x, e.pos.y, e.pos.z));
        this.shake += Math.max(0, 2.5 - d * 0.1);
      }
      // A round into the lake: the hit is on the bed, a little past where it entered the water.
      if (e.type === 'impact' && !e.exit && this.inLake(e.pos.x, e.pos.y, e.pos.z)) this.ripples?.disturb(e.pos.x, e.pos.z, 0.12, 0.03);
      if (e.type === 'land') this.shake += Math.min(1, e.impactSpeedMs * 0.08);
      this.effects.handle(e, game.player.id, null);
    }
  }

  /** The viewmodel's muzzle, projected out to true range along the same eye ray. */
  private muzzleWorld(): Vector3 {
    const cam = this.stage.camera;
    this.muzzleMarker.position.copy(this.viewModel.muzzle());
    this.viewModel.attachMuzzle(this.muzzleMarker);
    this.muzzleMarker.updateWorldMatrix(true, false);
    const m = this.muzzleMarker.getWorldPosition(this.tmp);
    return m.sub(cam.position).divideScalar(VM_SCALE).add(cam.position);
  }

  render(game: Game, alpha: number, frameSeconds: number, pendingYawRad: number, pendingPitchRad: number): void {
    this.cpu.begin();
    const cam = this.stage.camera;
    const p = game.player;
    // Eye: interpolated feet + smoothed eye height; dead players slump to the ground.
    this.eye.set(p.prevPosition.x, p.prevPosition.y, p.prevPosition.z).lerp(this.tmp.set(p.body.position.x, p.body.position.y, p.body.position.z), alpha);
    this.deathTilt = damp(this.deathTilt, p.alive ? 0 : 1, 3, frameSeconds);
    this.eye.y += p.eyeHeightM * (1 - this.deathTilt * 0.8);
    cam.position.copy(this.eye);
    this.shake = Math.min(3, this.shake * Math.exp(-frameSeconds * 6));
    const s = this.shake * this.settings.shake * 0.01;
    const t = game.timeSeconds;
    cam.rotation.set(
      game.weapons.viewPitch(p) - pendingPitchRad + Math.sin(t * 37) * s,
      game.weapons.viewYaw(p) - pendingYawRad + Math.sin(t * 29 + 1) * s,
      Math.sin(t * 23 + 2) * s * 0.5 + this.deathTilt * 0.9,
    );
    cam.updateMatrixWorld();

    // Ambient on the rig follows whether the eye is indoors.
    const skyK = interiorSkyFraction(this.map.interiors, cam.position.x, cam.position.y, cam.position.z);
    this.interiorK = damp(this.interiorK, skyK, 4, frameSeconds);
    this.viewModel.setEnvironment(this.stage.scene.environment, this.interiorK);
    const pixelAngle = ((cam.fov * Math.PI) / 180) / Math.max(1, this.stage.renderer.domElement.height);
    this.viewModel.update(game, frameSeconds, pendingYawRad, pendingPitchRad, pixelAngle);
    this.viewModel.root.visible = p.alive;
    this.viewModel.root.updateMatrixWorld(true);
    this.viewModel.aimRedDot();

    this.actors.update(game.soldiers, alpha, frameSeconds, cam.position);
    this.effects.update(game, cam, frameSeconds);
    this.worldFx.update(game, cam, frameSeconds, this.world.glass, this.world.glassColliderIds);
    this.lighting.update(cam);
    this.clouds.update(frameSeconds);
    this.lighting.mistTime.value = game.timeSeconds;
    if (this.map.id === 'boulevard') tickParis(game.timeSeconds);
    // The weapon light's beam shows in the haze, in rain, and in the dust of a closed room.
    const scatter = this.lighting.preset.fogDensityPerM + 0.0012 + wetness.value * rainRate.value * 0.02 + (skyK < 1 ? 0.004 : 0);
    this.weaponLight.update(cam, p.weaponLight && p.alive, this.lighting.preExposure, scatter, game.timeSeconds);
    wetTime.value = game.timeSeconds;
    this.cityLights?.update(cam, this.lighting.preExposure);
    this.props?.update(cam.position);
    this.rain?.update(game.timeSeconds, cam);
    if (this.caustics) this.updateWater(game);
    this.cpu.lap('update');
    this.foliage.update(cam.position);
    this.undergrowth.update(cam.position, frameSeconds, cam.fov, this.stage.renderer.domElement.height);
    this.trampleGrass(game);
    this.cpu.lap('streaming');
    if (this.ripples) {
      this.stirWater(game, frameSeconds);
      this.ripples.update(frameSeconds, cam.position.x, cam.position.z);
    }
    // Sun shafts through the canopy: strongest with a low sun, none under a full overcast.
    const preset = this.lighting.preset;
    const lowSun = 1 - Math.min(1, Math.max(0, preset.sunElevationRad - 0.05) / 0.6);
    this.stage.aimShafts(this.lighting.sunVector, (1 - preset.cloudCover * 0.9) * (0.35 + lowSun * 0.5));

    // Scope second view, only while the sniper is up and after the main view has
    // compiled once (the sun's cascades bind to the first camera that renders).
    if (this.scopeReady && game.weapons.current === 'sniper' && game.weapons.adsBlend > 0.3 && p.alive) {
      this.viewModel.renderScope(this.stage.renderer, this.stage.scene, cam.position);
    }
    this.cpu.lap('scope');
    this.caustics?.render(this.stage.renderer);
    this.cpu.lap('water');
    this.stage.render();
    this.cpu.lap('submit');
    this.scopeReady = true;
    const night = this.lighting.preset.id === 'night';
    this.exposure.update(this.stage.hdrTexture, this.lighting.preExposure, this.sceneEv(), frameSeconds, night ? EXPOSURE.minEvBelowPresetNight : EXPOSURE.minEvBelowPreset, night ? EXPOSURE.maxEvAbovePresetNight : EXPOSURE.maxEvAbovePreset);
    this.stage.setExposure(Lighting.exposureMultiplier(this.lighting.preset.ev100, this.exposure.adaptedEv));
  }

  /** The player's feet bend the grass they walk through (and it stands up again over ~9 s). */
  private trampleGrass(game: Game): void {
    const grass = this.undergrowth.grass;
    const p = game.player;
    if (!grass || !p.body.grounded) return;
    const v = p.body.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 0.3 && p.stance !== 'prone') return;
    const r = p.stance === 'prone' ? 0.7 : 0.35;
    grass.stamp(p.body.position.x, p.body.position.z, r, v.x, v.z, p.stance === 'prone' ? 0.25 : Math.min(0.2, speed * 0.05));
  }

  /** Whether a point is under the lake's still surface. */
  private inLake(x: number, y: number, z: number): boolean {
    const lake = this.map.lake;
    return !!lake && y < lake.levelM && waterDepth(lake, x, z, y) > 0;
  }

  /** Everyone wading pushes a wake: a dip at the legs that grows with speed (per 1/60 s, so frame rate does not matter). */
  private stirWater(game: Game, dtS: number): void {
    const ripples = this.ripples;
    if (!ripples) return;
    const wade = (x: number, y: number, z: number, vx: number, vz: number): void => {
      if (!this.inLake(x, y, z)) return;
      const speed = Math.hypot(vx, vz);
      if (speed < 0.2) return;
      ripples.disturb(x, z, 0.3, Math.min(0.004, speed * 0.0015) * dtS * 60);
    };
    const p = game.player;
    if (p.alive) wade(p.body.position.x, p.body.position.y, p.body.position.z, p.body.velocity.x, p.body.velocity.z);
    for (const s of game.soldiers) {
      if (s.alive) wade(s.body.position.x, s.body.position.y, s.body.position.z, s.body.velocity.x, s.body.velocity.z);
    }
  }

  /** The lake's shader inputs for this frame: game time, sun and sky, wind. */
  private updateWater(game: Game): void {
    const sun = this.lighting.sun;
    W.time.value = game.timeSeconds;
    W.sunDir.value.copy(this.lighting.sunVector).normalize();
    W.sunIrradiance.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity);
    const sky = this.lighting.preset.skyIlluminanceLux * this.lighting.preExposure;
    W.skyIrradiance.value.set(sky * 0.85, sky * 0.93, sky * 1.05);
    W.wind.value.set(windVector.value.x, windVector.value.z);
    W.amplitudeM.value = windVector.value.length() * LAKE_WAVES.amplitudePerWindMs;
  }

  /**
   * One frame of the real pipeline with every pipeline's object forced
   * visible (see warmup.ts). It needs an animation frame of its own: three's
   * scene pass renders at most once per frame (NodeFrame.frameId advances in
   * the renderer's animation loop), so a second render in the same frame
   * skipped the scene and compiled nothing.
   */
  async warmUp(game: Game): Promise<void> {
    this.render(game, 1, 0, 0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // The rifle scope draws the world again into its own half-float target (optics.ts), so every material
    // needs a second build for it; left to the first look through the scope they all built at once, a stall
    // of ~10 s on a phone. One look through it here, with everything shown, builds them behind the loading
    // screen. (A background build with compileAsync after play began hung like the loading screen's did.)
    warmAllPipelines(this.stage.scene, () => {
      this.stage.render();
      this.viewModel.renderScope(this.stage.renderer, this.stage.scene, this.stage.camera.position);
    });
  }

  get adaptedEv(): number {
    return this.exposure.adaptedEv;
  }

  get presetEv(): number {
    return this.lighting.preset.ev100;
  }

  resize(): void {
    this.stage.resize();
  }
}



/** The city's streets in the urban scans, the forest and the range in the woodland ones. */
function hdriSetting(mapId: string): HdriSetting {
  return mapId === 'city' || mapId === 'boulevard' ? 'urban' : 'nature';
}
