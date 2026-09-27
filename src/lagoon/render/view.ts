import { Quaternion, Vector3 } from 'three/webgpu';
import { damp } from '../../core/vec.ts';
import { lightColour } from '../../render/colour.ts';
import { AutoExposure } from '../../render/exposure.ts';
import { DAYLIGHT, LAGOON_CAMERA, LAGOON_EXPOSURE, LAGOON_PLAYER, WAVES } from '../config.ts';
import type { LagoonEvent } from '../game/events.ts';
import type { LagoonGame } from '../game/game.ts';
import { Effects } from './effects.ts';
import { buildGround } from './ground.ts';
import { AmbientLife } from './life.ts';
import { Rain } from './weatherFx.ts';
import { buildJungle } from './jungle.ts';
import { buildOutpost, type OutpostView } from './outpost.ts';
import { Props } from './props.ts';
import { ViewModel } from './viewmodel.ts';
import { buildRocks } from './rocks.ts';
import { buildPalms } from './palms.ts';
import { buildUndergrowth } from './undergrowth.ts';
import { LagoonLighting } from './lighting.ts';
import { LagoonStage, type StageSettings } from './stage.ts';
import { U } from './uniforms.ts';
import { buildWater, placeWater } from './water.ts';

// The render system: reads game state once per display frame and writes
// transforms and uniforms (rules §10 — logic never touches THREE). Owns the
// stage, lighting, exposure and every visual subsystem.

export type Progress = (label: string, fraction: number) => Promise<void>;

export interface ViewHooks {
  /** Optional per-frame additions (vegetation wind, viewmodel, effects) registered by later systems. */
  update: ((game: LagoonGame, frameSeconds: number, alpha: number) => void)[];
  events: ((e: LagoonEvent, game: LagoonGame) => void)[];
}

export class LagoonView {
  readonly stage: LagoonStage;
  lighting!: LagoonLighting;
  private exposure!: AutoExposure;
  private water!: ReturnType<typeof buildWater>;
  outpost!: OutpostView;
  private props!: Props;
  viewModel!: ViewModel;
  effects!: Effects;
  private rain!: Rain;
  private life!: AmbientLife;
  private readonly camQuat = new Quaternion();
  private flicker = 0;
  readonly hooks: ViewHooks = { update: [], events: [] };
  private readonly eye = new Vector3();
  private bobK = 0;
  private landDip = 0;
  private gust = 0;
  private gustTarget = 0;
  private gustTimer = 0;
  /** Extra camera pitch from the viewmodel (recoil punch), radians. */
  cameraPunchRad = 0;

  private constructor(canvas: HTMLCanvasElement, settings: StageSettings) {
    this.stage = new LagoonStage(canvas, settings);
  }

  static async create(canvas: HTMLCanvasElement, game: LagoonGame, settings: StageSettings, progress: Progress, extra: (view: LagoonView, progress: Progress) => Promise<void>): Promise<LagoonView> {
    const v = new LagoonView(canvas, settings);
    await v.build(game, progress, extra);
    return v;
  }

  private async build(game: LagoonGame, progress: Progress, extra: (view: LagoonView, progress: Progress) => Promise<void>): Promise<void> {
    const { stage } = this;
    await progress('Starting renderer', 0.04);
    await stage.init();
    await progress('Shaping the island', 0.1);
    stage.scene.add(buildGround(game.world));
    // `?bare` (a debug switch for viewmodel work) skips the vegetation, which dominates load and frame time.
    const bare = new URLSearchParams(location.search).has('bare');
    await progress('Growing palms', 0.18);
    if (!bare) stage.scene.add(buildPalms(game.world.palms));
    await progress('Growing the jungle', 0.28);
    if (!bare) stage.scene.add(buildJungle(game.world.trees, stage.quality));
    await progress('Undergrowth', 0.4);
    if (!bare) stage.scene.add(buildUndergrowth(game.world, stage.quality));
    await progress('Rocks', 0.44);
    stage.scene.add(buildRocks(game.world.rocks));
    await progress('Building the shelter', 0.47);
    this.outpost = buildOutpost();
    stage.scene.add(this.outpost.group, this.outpost.dock);
    this.props = new Props(game);
    stage.scene.add(this.props.group);
    this.viewModel = new ViewModel();
    stage.camera.add(this.viewModel.root);
    this.effects = new Effects(stage.scene, this.viewModel, this.outpost.firePos);
    this.rain = new Rain(stage.quality);
    this.life = new AmbientLife();
    stage.scene.add(this.rain.mesh, this.life.group);
    await progress('Filling the lagoon', 0.5);
    this.water = buildWater();
    stage.scene.add(this.water.mesh);
    this.lighting = new LagoonLighting(stage.renderer, stage.scene, stage.quality);
    await extra(this, progress);
    await progress('Lighting the sky', 0.86);
    this.placeCamera(game, 1, 0, 0);
    await this.lighting.bakeNow(game.env, stage.camera);
    this.exposure = new AutoExposure(stage.renderer, game.env.daylight.anchorEv, { belowStops: LAGOON_EXPOSURE.minEvBelowAnchor, aboveStops: LAGOON_EXPOSURE.maxEvAboveAnchor });
    await progress('Compiling shaders', 0.92);
    await stage.renderer.compileAsync(stage.scene, stage.camera);
  }

  get depthMap() {
    return this.water.depthMap;
  }

  handleEvents(events: readonly LagoonEvent[], game: LagoonGame): void {
    for (const e of events) {
      if (e.type === 'land') this.landDip = Math.min(0.12, this.landDip + e.impactSpeedMs * 0.018);
      this.effects.handle(e, game, this.stage.camera);
      for (const h of this.hooks.events) h(e, game);
    }
  }

  private placeCamera(game: LagoonGame, alpha: number, pendingYawRad: number, pendingPitchRad: number): void {
    const p = game.player;
    const cam = this.stage.camera;
    this.eye.set(p.prev.x + (p.pos.x - p.prev.x) * alpha, p.prev.y + (p.pos.y - p.prev.y) * alpha + LAGOON_PLAYER.eyeHeightM, p.prev.z + (p.pos.z - p.prev.z) * alpha);
    // Head bob: a figure-eight with the stride, gone when standing still or aiming.
    const bob = LAGOON_CAMERA.bobAmplitudeM * this.bobK * (1 - game.equipment.adsBlend * 0.8);
    const phase = p.stridePhase;
    this.eye.y += (Math.abs(Math.sin(phase)) - 0.5) * bob - this.landDip;
    const sideX = Math.cos(p.yawRad);
    const sideZ = -Math.sin(p.yawRad);
    this.eye.x += sideX * Math.sin(phase) * bob * 0.5;
    this.eye.z += sideZ * Math.sin(phase) * bob * 0.5;
    cam.position.copy(this.eye);
    cam.rotation.set(p.pitchRad - pendingPitchRad + this.cameraPunchRad, p.yawRad - pendingYawRad, Math.sin(phase) * LAGOON_CAMERA.headRollRad * this.bobK);
    cam.updateMatrixWorld();
  }

  render(game: LagoonGame, alpha: number, frameSeconds: number, pendingYawRad: number, pendingPitchRad: number): void {
    const dt = Math.max(0, frameSeconds);
    const p = game.player;
    this.bobK = damp(this.bobK, p.grounded ? Math.min(1.4, p.speedMs / LAGOON_PLAYER.walkSpeedMs) : 0, 10, dt);
    this.landDip = damp(this.landDip, 0, 9, dt);
    this.placeCamera(game, alpha, pendingYawRad, pendingPitchRad);
    const env = game.env;
    U.time.value = game.timeSeconds + alpha / 60;
    // Gusts: a slow random envelope on top of the mean wind.
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = 2 + Math.random() * 5;
      this.gustTarget = Math.random() ** 2;
    }
    this.gust = damp(this.gust, this.gustTarget, 0.8, dt);
    U.gust.value = this.gust;
    U.waveScale.value = 1 + (WAVES.stormAmplitudeScale - 1) * env.weather.rainRate + (env.weather.windMs - 3) * 0.03;
    this.lighting.update(env, this.stage.camera, dt);
    placeWater(this.water.mesh, this.stage.camera.position);
    this.props.update(game);
    this.viewModel.root.updateMatrixWorld(true);
    this.viewModel.update(game, dt, pendingYawRad, pendingPitchRad);
    this.updateLocalLights(game, dt);
    this.effects.update(game, dt, this.stage.camera, this.lighting.preExposure);
    this.rain.update(game, dt, this.stage.camera, this.effects);
    this.stage.camera.getWorldQuaternion(this.camQuat);
    this.life.update(game, dt, this.camQuat);
    for (const h of this.hooks.update) h(game, dt, alpha);
    const d = env.daylight;
    const lightDir = d.night > 0.5 ? d.moonDir : d.sunDir;
    const lowSun = 1 - Math.min(1, Math.max(0, d.sunDir.y - 0.05) / 0.6);
    this.stage.aimShafts(lightDir, (1 - env.weather.cloudCover * 0.9) * (0.35 + lowSun * 0.5) * (d.night > 0.5 ? 0.25 : 1));
    this.stage.render();
    // The eye aims for the anchor, so night stays about two stops under a grey card.
    this.exposure.update(this.stage.hdrTexture, this.lighting.preExposure, this.lighting.anchorEv, dt, -DAYLIGHT.nightExposureBiasEv * d.night);
    this.stage.setExposure(2 ** (this.lighting.anchorEv - this.exposure.adaptedEv + LAGOON_EXPOSURE.compensationEv));
  }

  /** Lantern after dusk, camp fire always (it just disappears against daylight); rain damps the fire. */
  private updateLocalLights(game: LagoonGame, dt: number): void {
    const d = game.env.daylight;
    const pre = this.lighting.preExposure;
    this.flicker += dt;
    const f = this.flicker;
    const wobble = 0.85 + 0.1 * Math.sin(f * 13.1) + 0.06 * Math.sin(f * 29.7 + 1.3) + 0.04 * Math.sin(f * 51.3);
    const lampOn = Math.min(1, Math.max(0, (d.night + (1 - Math.min(1, d.sunDir.y * 6 + 0.5)) * 0.6 - 0.2) * 2));
    this.outpost.lantern.intensity = (DAYLIGHT.lampFluxLm / (4 * Math.PI)) * pre * lampOn * (0.95 + 0.05 * Math.sin(f * 7));
    const rainDamp = 1 - game.env.weather.rainRate * 0.6;
    this.outpost.fire.intensity = (DAYLIGHT.fireFluxLm / (4 * Math.PI)) * pre * wobble * rainDamp;
    const lamp = lightColour(DAYLIGHT.lampColourK);
    const fire = lightColour(DAYLIGHT.fireColourK);
    this.outpost.lantern.color.setRGB(lamp.r, lamp.g, lamp.b);
    this.outpost.fire.color.setRGB(fire.r, fire.g, fire.b);
    this.lampOn = lampOn;
  }

  /** 0..1: whether the lantern is lit (effects draw its flame). */
  lampOn = 0;

  get adaptedEv(): number {
    return this.exposure.adaptedEv;
  }

  resize(): void {
    this.stage.resize();
  }
}
