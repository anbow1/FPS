import { Object3D, Vector3 } from 'three/webgpu';
import { LAKE_WAVES, type LightingPresetId, WORLD_WIND } from '../config.ts';
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
import { INTERIOR_SKY_FRACTION, insideInterior, setInteriorVolumes } from './interior.ts';
import { Lighting } from './lighting.ts';
import { FOLIAGE, MaterialLibrary, wetness } from './materials.ts';
import { buildProps } from './props.ts';
import { CpuTimer } from './perf.ts';
import { Stage, type StageSettings } from './stage.ts';
import { Undergrowth } from './undergrowth.ts';
import { VIEWMODEL_LAYER, VM_SCALE, ViewModel } from './viewmodel.ts';
import { WorldFx } from './worldFx.ts';
import { buildStaticWorld, type StaticWorld } from './worldMesh.ts';
import { revealOnePerPipeline, warmAllPipelines } from './warmup.ts';

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
  private exposure!: AutoExposure;
  private world!: StaticWorld;
  private readonly actors = new ActorView();
  private viewModel!: ViewModel;
  private effects!: Effects;
  private worldFx!: WorldFx;
  private foliage!: Foliage;
  private caustics: Caustics | null = null;
  private lakeFx: LakeFx | null = null;
  /** Interactive ripples on the lake: legs wading, bullets and blasts (rippleField.ts). */
  private ripples: RippleField | null = null;
  private undergrowth!: Undergrowth;
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
    await progress('Generating textures', 0.15);
    FOLIAGE.translucent = this.settings.quality === 'high';
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
    stage.scene.add(buildTerrainMesh(map, lib, this.lakeFx), buildFarRing(map));
    await progress('Building the world', 0.35);
    this.world = buildStaticWorld(map, lib);
    stage.scene.add(this.world.group, buildProps(map.props, lib));
    await progress('Planting trees', 0.5);
    this.foliage = new Foliage(map.trees, map.bushes, lib, this.settings.quality, stage.renderer);
    await progress('Growing undergrowth', 0.55);
    this.undergrowth = new Undergrowth(map, lib, this.settings.quality);
    stage.scene.add(this.foliage.group, this.undergrowth.group, this.actors.group);
    await progress('Lighting', 0.6);
    this.lighting = new Lighting(stage.renderer, stage.scene, this.settings.quality);
    await this.lighting.apply(this.settings.preset, map.playerSpawn.pos.y);
    this.exposure = new AutoExposure(stage.renderer, this.lighting.preset.ev100);
    const w = WORLD_WIND[map.id];
    windVector.value.set(Math.sin(w.directionRad) * w.speedMs, 0, Math.cos(w.directionRad) * w.speedMs);
    wetness.value = this.settings.wet && map.id === 'city' ? 1 : 0;
    this.viewModel = new ViewModel(this.scopeSidePx());
    stage.passTimer.name(this.viewModel.scope.target, 'scope');
    stage.camera.add(this.viewModel.root);
    this.viewModel.setEnvironment(stage.scene.environment, 1);
    this.effects = new Effects(stage.scene);
    this.worldFx = new WorldFx(stage.scene, map);
    this.syncPreExposure();
    await progress('Compiling shaders', 0.75);
    // Pre-compile every material the first frames will need (rules §9): no stall on the first shot.
    this.stage.camera.position.set(map.playerSpawn.pos.x, map.playerSpawn.pos.y + 1.7, map.playerSpawn.pos.z);
    // Fill the streamed plant meshes first: an instanced mesh pre-compiled while it was empty
    // (count 0) never drew in the main pass afterwards (three r186), though its shadows did.
    this.foliage.update(this.stage.camera.position);
    this.undergrowth.update(this.stage.camera.position);
    // Compile with one object per shader build shown and at least one instance: an instanced mesh
    // pre-compiled while empty (count 0) was left with a pipeline that never became ready, so it
    // never drew in the main pass (three r186). compileAsync collects its objects synchronously,
    // so everything can be put back as soon as it returns or times out.
    const restore = revealOnePerPipeline(stage.scene);
    try {
      await precompile(stage.renderer.compileAsync(stage.scene, stage.camera));
    } finally {
      restore();
    }
    await progress('Ready', 1);
  }

  private syncPreExposure(): void {
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
    this.stage.applySettings(s);
    wetness.value = s.wet && this.map.id === 'city' ? 1 : 0;
    if (presetChanged) {
      await this.lighting.apply(s.preset, this.map.playerSpawn.pos.y);
      this.exposure.reset(this.lighting.preset.ev100);
      this.viewModel.setEnvironment(this.stage.scene.environment, this.interiorK);
      this.syncPreExposure();
    }
  }

  beforeStep(game: Game): void {
    this.actors.beforeStep(game.soldiers);
  }

  handleEvents(events: readonly GameEvent[], game: Game): void {
    for (const e of events) {
      if (e.type === 'shot' && e.shooterId === game.player.id) {
        this.shake += 0.15;
        this.effects.handle(e, game.player.id, this.muzzleWorld(game));
        continue;
      }
      if (e.type === 'playerHit') this.shake += e.armour ? 0.4 : 0.7;
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
  private muzzleWorld(game: Game): Vector3 {
    const cam = this.stage.camera;
    const id = game.weapons.current;
    this.muzzleMarker.position.set(0, id === 'pistol' ? -0.018 : id === 'sniper' ? -0.065 : -0.082, id === 'pistol' ? -0.13 : id === 'sniper' ? -0.95 : -0.67);
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
    const inside = insideInterior(this.map.interiors, cam.position.x, cam.position.y, cam.position.z);
    this.interiorK = damp(this.interiorK, inside ? INTERIOR_SKY_FRACTION : 1, 4, frameSeconds);
    this.viewModel.setEnvironment(this.stage.scene.environment, this.interiorK);
    const pixelAngle = ((cam.fov * Math.PI) / 180) / Math.max(1, this.stage.renderer.domElement.height);
    this.viewModel.update(game, frameSeconds, pendingYawRad, pendingPitchRad, pixelAngle);
    this.viewModel.root.visible = p.alive;
    this.viewModel.root.updateMatrixWorld(true);
    this.viewModel.aimRedDot();

    this.actors.update(game.soldiers, alpha, frameSeconds);
    this.effects.update(game, cam, frameSeconds);
    this.worldFx.update(game, cam, frameSeconds, this.world.glass, this.world.glassColliderIds);
    this.lighting.update(cam);
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
    this.exposure.update(this.stage.hdrTexture, this.lighting.preExposure, this.lighting.preset.ev100, frameSeconds);
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
    warmAllPipelines(this.stage.scene, () => this.stage.render());
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

const PRECOMPILE_TIMEOUT_MS = 20000;

/**
 * Shader pre-compilation behind the loading screen (rules §9). A phone GPU can
 * take very long, or a single failing pipeline can reject the whole batch;
 * neither may leave the player stuck on the loading screen, so after the
 * timeout (or a failure) loading carries on and anything left compiles on
 * first use.
 */
async function precompile(job: Promise<unknown>): Promise<void> {
  let timer = 0;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = window.setTimeout(() => resolve('timeout'), PRECOMPILE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([job, timeout]);
    if (result === 'timeout') console.warn(`shader pre-compilation still running after ${PRECOMPILE_TIMEOUT_MS / 1000} s; continuing, the rest compiles on first use`);
  } catch (err) {
    console.error('shader pre-compilation failed; continuing, the renderer reports the failing material:', err);
  } finally {
    window.clearTimeout(timer);
  }
}
