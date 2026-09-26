import { Object3D, Vector3 } from 'three/webgpu';
import { type LightingPresetId, WORLD_WIND } from '../config.ts';
import { damp } from '../core/vec.ts';
import type { GameEvent } from '../game/events.ts';
import type { Game } from '../game/game.ts';
import type { MapData } from '../maps/types.ts';
import { ActorView } from './actors.ts';
import { Effects } from './effects.ts';
import { AutoExposure } from './exposure.ts';
import { buildFoliage, windVector } from './foliage.ts';
import { buildFarRing, buildTerrainMesh } from './ground.ts';
import { INTERIOR_SKY_FRACTION, insideInterior, setInteriorVolumes } from './interior.ts';
import { Lighting } from './lighting.ts';
import { MaterialLibrary, wetness } from './materials.ts';
import { buildProps } from './props.ts';
import { Stage, type StageSettings } from './stage.ts';
import { VIEWMODEL_LAYER, VM_SCALE, ViewModel } from './viewmodel.ts';
import { WorldFx } from './worldFx.ts';
import { buildStaticWorld, type StaticWorld } from './worldMesh.ts';

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
  private settings: ViewSettings;
  private shake = 0;
  private interiorK = 1;
  private scopeReady = false;
  private readonly muzzleMarker = new Object3D();
  private readonly eye = new Vector3();
  private readonly tmp = new Vector3();
  private deathTilt = 0;

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
    const lib = new MaterialLibrary();
    setInteriorVolumes(map.interiors);
    stage.scene.add(buildTerrainMesh(map, lib), buildFarRing(map));
    await progress('Building the world', 0.35);
    this.world = buildStaticWorld(map, lib);
    stage.scene.add(this.world.group, buildProps(map.props, lib));
    await progress('Planting trees', 0.5);
    stage.scene.add(buildFoliage(map.trees, map.bushes, lib), this.actors.group);
    await progress('Lighting', 0.6);
    this.lighting = new Lighting(stage.renderer, stage.scene, this.settings.quality);
    await this.lighting.apply(this.settings.preset, map.playerSpawn.pos.y);
    this.exposure = new AutoExposure(stage.renderer, this.lighting.preset.ev100);
    const w = WORLD_WIND[map.id];
    windVector.value.set(Math.sin(w.directionRad) * w.speedMs, 0, Math.cos(w.directionRad) * w.speedMs);
    wetness.value = this.settings.wet && map.id === 'city' ? 1 : 0;
    this.viewModel = new ViewModel(this.scopeSidePx());
    stage.camera.add(this.viewModel.root);
    this.viewModel.setEnvironment(stage.scene.environment, 1);
    this.effects = new Effects(stage.scene);
    this.worldFx = new WorldFx(stage.scene, map);
    this.syncPreExposure();
    await progress('Compiling shaders', 0.75);
    // Pre-compile every material the first frames will need (rules §9): no stall on the first shot.
    this.stage.camera.position.set(map.playerSpawn.pos.x, map.playerSpawn.pos.y + 1.7, map.playerSpawn.pos.z);
    await stage.renderer.compileAsync(stage.scene, stage.camera);
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
        const d = this.stage.camera.position.distanceTo(this.tmp.set(e.pos.x, e.pos.y, e.pos.z));
        this.shake += Math.max(0, 2.5 - d * 0.1);
      }
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

    // Scope second view, only while the sniper is up and after the main view has
    // compiled once (the sun's cascades bind to the first camera that renders).
    if (this.scopeReady && game.weapons.current === 'sniper' && game.weapons.adsBlend > 0.3 && p.alive) {
      this.viewModel.renderScope(this.stage.renderer, this.stage.scene, cam.position);
    }
    this.stage.render();
    this.scopeReady = true;
    this.exposure.update(this.stage.hdrTexture, this.lighting.preExposure, this.lighting.preset.ev100, frameSeconds);
    this.stage.setExposure(Lighting.exposureMultiplier(this.lighting.preset.ev100, this.exposure.adaptedEv));
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
