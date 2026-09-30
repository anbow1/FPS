import { Group, Quaternion, Vector3 } from 'three/webgpu';
import { damp } from '../core/vec.ts';
import { lightColour } from './colour.ts';
import { AutoExposure } from './exposure.ts';
import { DAYLIGHT, LAGOON_CAMERA, LAGOON_EXPOSURE, LAGOON_PLAYER, WATER_LEVEL_M } from '../config.ts';
import { waterSurfaceY, waveScale } from '../game/waves.ts';
import { heightAt } from '../game/terrain.ts';
import type { LagoonEvent } from '../game/events.ts';
import type { LagoonGame } from '../game/game.ts';
import { Effects } from './effects.ts';
import { buildGround, grassInputs } from './ground.ts';
import { GrassField } from './grassField.ts';
import { OUTPOST } from '../game/outpost.ts';
import { Caustics } from './caustics.ts';
import { CpuTimer } from './perf.ts';
import { AmbientLife } from './life.ts';
import { Rain } from './weatherFx.ts';
import { FOLIAGE } from './foliageMaterials.ts';
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
import { createRipples } from './waterFx.ts';
import type { RippleField } from './rippleField.ts';
import { revealOnePerPipeline, warmAllPipelines } from './warmup.ts';

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
  private caustics!: Caustics;
  private grass: GrassField | null = null;
  private ripples!: RippleField;
  /** CPU milliseconds per part of render() (F3, benchmark). */
  readonly cpu = new CpuTimer();
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
  /** The carried lamp hangs from this pivot, which follows the left hand (swingLamp). */
  private readonly lampCarry = new Group();
  private readonly lampAnchor = new Vector3();
  private readonly lampPrevAnchor = new Vector3();
  private readonly lampPrevVel = new Vector3();
  private lampSwing = { x: 0, z: 0, vx: 0, vz: 0, fresh: true };
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
    this.caustics = new Caustics(stage.quality);
    stage.passTimer.name(this.caustics.target, 'water');
    stage.scene.add(buildGround(game.world, this.caustics));
    // `?bare` (a debug switch for viewmodel work) skips the vegetation, which dominates load and frame time.
    const bare = new URLSearchParams(location.search).has('bare');
    FOLIAGE.translucent = stage.quality === 'high';
    await progress('Growing palms', 0.18);
    if (!bare) stage.scene.add(buildPalms(game.world.palms));
    await progress('Growing the jungle', 0.28);
    if (!bare) stage.scene.add(buildJungle(game.world.trees, stage.quality));
    await progress('Undergrowth', 0.4);
    if (!bare) {
      stage.scene.add(buildUndergrowth(game.world, stage.quality));
      // Real grass blades (grassField.ts): meadow where sand turns to soil, beach grass in clumps.
      const keep = game.world.interactables.map((i) => i.pos);
      const { ground, density } = grassInputs(game.world, (x, z) => Math.hypot(x - OUTPOST.x, z - OUTPOST.z) > 5.5 && keep.every((k) => Math.abs(k.x - x) > 0.8 || Math.abs(k.z - z) > 0.8));
      const high = stage.quality === 'high';
      this.grass = new GrassField(ground, density, {
        tileM: 4,
        bladesPerTile: high ? 700 : 300,
        radiusM: high ? 40 : 24,
        wind: U.wind,
        time: U.time,
        colours: { meadow: [0.07, 0.16, 0.03], beach: [0.38, 0.34, 0.16], sedge: [0.06, 0.13, 0.04], dry: [0.44, 0.36, 0.15] },
      });
      stage.scene.add(this.grass.group);
    }
    await progress('Rocks', 0.44);
    stage.scene.add(buildRocks(game.world.rocks));
    await progress('Building the shelter', 0.47);
    this.outpost = buildOutpost();
    stage.scene.add(this.outpost.group, this.outpost.dock, this.lampCarry);
    this.props = new Props(game);
    stage.scene.add(this.props.group);
    this.viewModel = new ViewModel();
    stage.camera.add(this.viewModel.root);
    this.effects = new Effects(stage.scene, this.viewModel, this.outpost.firePos);
    this.rain = new Rain(stage.quality);
    this.life = new AmbientLife();
    stage.scene.add(this.rain.mesh, this.life.group);
    await progress('Filling the lagoon', 0.5);
    this.ripples = createRipples(stage.quality);
    this.water = buildWater(stage.quality);
    for (const t of this.water.ocean.targets) stage.passTimer.name(t, 'water');
    // one FFT at load, so its pipelines and targets exist before the first frame
    this.water.ocean.update(stage.renderer, 0);
    stage.scene.add(this.water.mesh);
    this.lighting = new LagoonLighting(stage.renderer, stage.scene, stage.quality);
    await extra(this, progress);
    await progress('Lighting the sky', 0.86);
    this.placeCamera(game, 1, 0, 0);
    await this.lighting.bakeNow(game.env, stage.camera);
    this.exposure = new AutoExposure(stage.renderer, game.env.daylight.anchorEv, { belowStops: LAGOON_EXPOSURE.minEvBelowAnchor, aboveStops: LAGOON_EXPOSURE.maxEvAboveAnchor });
    await progress('Compiling shaders', 0.92);
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
    this.cpu.begin();
    const dt = Math.max(0, frameSeconds);
    const p = game.player;
    this.bobK = damp(this.bobK, p.grounded ? Math.min(1.4, p.speedMs / LAGOON_PLAYER.walkSpeedMs) : 0, 10, dt);
    this.landDip = damp(this.landDip, 0, 9, dt);
    this.placeCamera(game, alpha, pendingYawRad, pendingPitchRad);
    this.swingLamp(game, dt);
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
    U.waveScale.value = waveScale(env.weather.rainRate, env.weather.windMs);
    // Under water when the eye is below the chop right above it (the same waves the surface is drawn with).
    const eyeP = this.stage.camera.position;
    const surfY = waterSurfaceY(eyeP.x, eyeP.z, U.time.value, U.waveScale.value, WATER_LEVEL_M - heightAt(eyeP.x, eyeP.z));
    U.underwater.value = eyeP.y < surfY - 0.02 ? 1 : 0;
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
    this.cpu.lap('update');
    for (const h of this.hooks.update) h(game, dt, alpha);
    if (this.grass) {
      const cam = this.stage.camera;
      this.grass.update(cam.position, dt, cam.fov, this.stage.renderer.domElement.height);
      // feet bend the blades they walk through; they stand up again over ~9 s
      const speed = Math.hypot(p.vel.x, p.vel.z);
      if (p.grounded && speed > 0.3) this.grass.stamp(p.pos.x, p.pos.z, 0.35, p.vel.x, p.vel.z, Math.min(0.2, speed * 0.05));
    }
    this.cpu.lap('streaming');
    // Wading and swimming push a wake that grows with speed (per 1/60 s, so frame rate does not matter).
    const wadeSpeed = Math.hypot(p.vel.x, p.vel.z);
    if (p.pos.y < WATER_LEVEL_M - 0.05 && wadeSpeed > 0.2) this.ripples.disturb(p.pos.x, p.pos.z, 0.3, Math.min(0.004, wadeSpeed * 0.0015) * dt * 60);
    this.ripples.update(dt, this.stage.camera.position.x, this.stage.camera.position.z);
    const d = env.daylight;
    const lightDir = d.night > 0.5 ? d.moonDir : d.sunDir;
    const lowSun = 1 - Math.min(1, Math.max(0, d.sunDir.y - 0.05) / 0.6);
    this.stage.aimShafts(lightDir, (1 - env.weather.cloudCover * 0.9) * (0.35 + lowSun * 0.5) * (d.night > 0.5 ? 0.25 : 1) * (1 - U.underwater.value));
    this.caustics.render(this.stage.renderer);
    this.water.ocean.update(this.stage.renderer, U.time.value);
    this.cpu.lap('water');
    this.stage.render();
    this.cpu.lap('submit');
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
    // Hanging in the shelter it lights itself at dusk; once carried it burns when the player lit it.
    const carried = game.inventory.has('lamp');
    const lampOn = carried ? (game.lampLit ? 1 : 0) : Math.min(1, Math.max(0, (d.night + (1 - Math.min(1, d.sunDir.y * 6 + 0.5)) * 0.6 - 0.2) * 2));
    const lampFlicker = 0.95 + 0.05 * Math.sin(f * 7);
    this.outpost.lantern.intensity = (DAYLIGHT.lampFluxLm / (4 * Math.PI)) * pre * lampOn * lampFlicker;
    // A small kerosene flame is a few 10⁴ cd/m².
    U.lampGlow.value = 2e4 * pre * lampOn * lampFlicker;
    const rainDamp = 1 - game.env.weather.rainRate * 0.6;
    this.outpost.fire.intensity = (DAYLIGHT.fireFluxLm / (4 * Math.PI)) * pre * wobble * rainDamp;
    const lamp = lightColour(DAYLIGHT.lampColourK);
    const fire = lightColour(DAYLIGHT.fireColourK);
    this.outpost.lantern.color.setRGB(lamp.r, lamp.g, lamp.b);
    this.outpost.fire.color.setRGB(fire.r, fire.g, fire.b);
    this.lampOn = lampOn;
  }

  /** 0..1: whether the lantern is lit. */
  lampOn = 0;

  /**
   * Once taken, the lamp hangs from the left hand, low and ahead, and swings: a damped pendulum
   * (0.2 m, about 1.1 Hz) driven by how the hand accelerates, so walking, turning and stopping
   * set it rocking. The lantern light moves with it; no light is added or removed.
   */
  private swingLamp(game: LagoonGame, dt: number): void {
    const rig = this.outpost.lanternRig;
    if (!game.inventory.has('lamp')) return;
    const cam = this.stage.camera;
    if (rig.parent !== this.lampCarry) {
      this.lampCarry.add(rig);
      rig.position.set(0, -LAMP_PIVOT_M, 0);
      rig.rotation.set(0, 0, 0);
      this.lampSwing.fresh = true;
    }
    this.lampAnchor.set(-0.27, -0.5, -0.42).applyQuaternion(cam.quaternion).add(cam.position);
    const s = this.lampSwing;
    if (s.fresh || dt <= 0) {
      this.lampPrevAnchor.copy(this.lampAnchor);
      this.lampPrevVel.set(0, 0, 0);
      s.fresh = false;
    } else {
      const vx = (this.lampAnchor.x - this.lampPrevAnchor.x) / dt;
      const vz = (this.lampAnchor.z - this.lampPrevAnchor.z) / dt;
      // A teleport or a hitch is not a swing: clamp the hand's acceleration.
      const ax = Math.max(-30, Math.min(30, (vx - this.lampPrevVel.x) / dt));
      const az = Math.max(-30, Math.min(30, (vz - this.lampPrevVel.z) / dt));
      this.lampPrevVel.set(vx, 0, vz);
      this.lampPrevAnchor.copy(this.lampAnchor);
      const g = 9.81 / LAMP_PIVOT_M;
      const h = Math.min(dt, 1 / 30);
      // In the hand's frame the lamp feels −a: it lags behind whatever the hand does.
      s.vx += (-g * Math.sin(s.x) + (az / LAMP_PIVOT_M) * Math.cos(s.x) - 2.2 * s.vx) * h;
      s.vz += (-g * Math.sin(s.z) - (ax / LAMP_PIVOT_M) * Math.cos(s.z) - 2.2 * s.vz) * h;
      s.x = Math.max(-1.1, Math.min(1.1, s.x + s.vx * h));
      s.z = Math.max(-1.1, Math.min(1.1, s.z + s.vz * h));
    }
    this.lampCarry.position.copy(this.lampAnchor);
    this.lampCarry.rotation.set(s.x, 0, s.z);
  }

  /**
   * One frame of the real pipeline with every pipeline's object forced
   * visible (see warmup.ts). It needs an animation frame of its own: three's
   * scene pass renders at most once per frame (NodeFrame.frameId advances in
   * the renderer's animation loop), so a second render in the same frame
   * skipped the scene and compiled nothing.
   */
  async warmUp(game: LagoonGame): Promise<void> {
    this.render(game, 1, 0, 0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    warmAllPipelines(this.stage.scene, () => this.stage.render());
  }

  get adaptedEv(): number {
    return this.exposure.adaptedEv;
  }

  resize(): void {
    this.stage.resize();
  }
}

const PRECOMPILE_TIMEOUT_MS = 20000;
/** From the hand to the middle of the lamp's glass (m). */
const LAMP_PIVOT_M = 0.2;

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
