import * as THREE from 'three/webgpu';
import { CITY, DRONE, ENEMY_TANK, HMG_127, MG_762, MG_AIM, PHYS_DT, PLAY_HALF, PLAYER_TANK, QUALITY, type QualityPreset, WATER_LEVEL } from '../config';
import type { Input } from '../core/input';
import { Rng } from '../core/rng';
import { ATMO, installAtmosphere } from '../render/atmosphere';
import { Lighting, PRESETS } from '../render/lighting';
import type { Pipeline } from '../render/pipeline';
import { CITY_LIGHT } from '../render/cityMaterial';
import { G } from '../render/nodes';
import { Rain } from '../render/rain';
import { revealOnePerPipeline, warmAllPipelines } from '../render/warmup.ts';
import type { Hud, MarkerState } from '../ui/hud';
import { PLAYER_SPAWN } from '../world/layout';
import { Water } from '../world/water';
import type { World } from '../world/world';
import { TankAI } from './ai';
import type { Audio } from './audio';
import { aimDirection, stepShell, timeOfFlight } from './ballistics';
import { Bullets, type SoftTarget } from './bullets';
import { Drone } from './drone';
import { Effects, PKind } from './effects';
import { Infantry, type Soldier } from './infantry';
import { type ImpactEvent, Projectiles } from './projectiles';
import { type HitInfo, Tank } from './tank';
import { prebakeTankOcclusion } from './tankModel';
import { hyp2 } from '../core/mathx';

export type GameState = 'menu' | 'playing' | 'paused' | 'dead' | 'intermission';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Vector3();
const _dir = { x: 0, y: 0, z: 1 };
const _hit: HitInfo = { t: 0, part: 'hull', localNormal: new THREE.Vector3(), point: new THREE.Vector3() };
const _ray = { t: 0, x: 0, y: 0, z: 0, kind: 'none' as 'terrain' | 'building' | 'none' };
const _proj = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Resolve `job`, or give up waiting after `ms` (a slow phone GPU must not hold the loading screen). */
async function withTimeout(job: Promise<unknown>, ms: number): Promise<void> {
  let timer = 0;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = window.setTimeout(() => resolve('timeout'), ms);
  });
  try {
    if ((await Promise.race([job, timeout])) === 'timeout') console.warn(`shader pre-compilation still running after ${ms / 1000} s; continuing`);
  } finally {
    window.clearTimeout(timer);
  }
}

const OUTCOME_TEXT: Record<string, string> = {
  ricochet: 'RYKOSZET', nopen: 'BRAK PRZEBICIA', pen: 'PRZEBICIE', track: 'GĄSIENICA ZERWANA', gun: 'TRAFIENIE W DZIAŁO', kill: 'CEL ZNISZCZONY',
};

export class Game {
  state: GameState = 'menu';
  readonly scene: THREE.Scene;
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.25, 9000);
  readonly lighting: Lighting;
  readonly effects: Effects;
  private readonly rain: Rain;
  readonly projectiles: Projectiles;
  player!: Tank;
  enemies: Tank[] = [];
  private ais: TankAI[] = [];
  private tanks: Tank[] = [];
  private headlight: THREE.SpotLight;
  private water: Water;
  readonly bullets: Bullets;
  readonly drone = new Drone();
  readonly infantry = new Infantry();
  droneView = false;
  private mgHeld = false;
  private mgT = 0;
  private mgCount = 0;
  private aa = new Map<Tank, { t: number; burst: number }>();
  private droneSpotted = new Map<Tank, number>();
  private droneSpotT = 0;
  private rotor: ReturnType<Audio['createRotor']> = null;
  private soft: SoftTarget[] = [];
  private time = 0;
  wave = 0;
  score = 0;
  private waveTimer = 0;
  private rng = new Rng(1234);
  quality: QualityPreset = QUALITY.high;
  presetIndex = 0;

  // player view / fire control
  private camYaw = 0;
  private camPitch = 0.02;
  private camDist = 12;
  sight = false;
  private zoomIdx = 0;
  private readonly zooms = [3, 8, 12];
  thermal = false;
  private sightYaw = 0;
  private sightPitch = 0;
  private lasedRange: number | null = null;
  private autoRange = 1000;
  private lockTarget: Tank | null = null;
  private readonly aimPoint = new THREE.Vector3();
  private hitAge = 99;
  private lastHitFrom = new THREE.Vector3();
  private spotted = new Set<Tank>();
  private spotT = 0;
  private headlightsOn = false;
  sensitivity = 1;
  private shakeOffset = new THREE.Vector3();
  private freeLook = false;
  private camPos = new THREE.Vector3();
  private cascadeFov = 0;
  private deadCamT = 0;
  onStateChange: (s: GameState) => void = () => {};

  constructor(
    private readonly pipeline: Pipeline,
    readonly world: World,
    private readonly input: Input,
    private readonly hud: Hud,
    private readonly audio: Audio,
    initialDetail: 'high' | 'low' = 'high',
  ) {
    pipeline.camera = this.camera;
    this.scene = pipeline.sceneRef;
    this.scene.add(world.group);
    installAtmosphere(this.scene);
    this.lighting = new Lighting(pipeline.renderer, this.scene, initialDetail);
    prebakeTankOcclusion();
    this.effects = new Effects(this.quality.maxParticles);
    this.rain = new Rain(this.quality.id === 'low' ? 'low' : 'high');
    this.scene.add(this.rain.mesh);
    this.scene.add(this.effects.group);
    this.projectiles = new Projectiles(this.effects);
    this.bullets = new Bullets(this.effects);
    this.scene.add(this.bullets.tracers, this.drone.model, this.infantry.group);
    this.infantry.onKill = (s, how) => this.onSoldierKilled(s, how);
    this.headlight = new THREE.SpotLight(0xfff4e0, 0, 120, 0.5, 0.45, 2);
    this.scene.add(this.headlight, this.headlight.target);
    this.setQuality(this.quality);
    this.setPreset(0);
    this.water = new Water(world.hf, world.noise, this.lighting, initialDetail);
    for (const t of this.water.targets) pipeline.passTimer.name(t, 'water');
    this.scene.add(this.water.group);
    this.water.setMirrorScene([world.grass.group], () => [this.lighting.sun, ...this.lighting.csm.lights]);
    hud.buildMinimap(world);
  }

  setQuality(q: QualityPreset): void {
    this.quality = q;
    this.pipeline.setQuality(q);
    this.lighting.setShadowQuality(q.shadowMapSize, q.shadowExtent);
    this.effects.setMaxParticles(q.maxParticles);
    this.effects.setWreckShadow(q.wreckShadow);
    this.world.grass.setDensity(q.grassPerChunk, q.grassRadius);
    this.world.terrain.setFancy(q.id === 'high');
  }

  setPreset(i: number): void {
    this.presetIndex = (i + PRESETS.length) % PRESETS.length;
    const p = PRESETS[this.presetIndex]!;
    this.lighting.apply(p);
    // crepuscular rays only under a real sun; stronger in hazy air
    this.pipeline.shafts.sunDir.copy(this.lighting.sunDir);
    if (p.sunLux > 1000 && p.sunElevDeg > 0) this.pipeline.shafts.color.copy(this.lighting.sunColor).multiplyScalar(0.07 * (1 + p.haze));
    else this.pipeline.shafts.color.setRGB(0, 0, 0);
    this.applyFog();
    this.headlightsOn = p.headlights;
    // Rain: the soaked ground and the falling drops, lit by the sky.
    const rain = p.rain ?? 0;
    G.uRain.value = rain;
    this.rain.rate.value = rain;
    const sky = (p.skyLux / Math.PI) * this.lighting.exposure;
    this.rain.light.value.set(sky * 0.9, sky * 0.95, sky);
    // the town's lights: rooms, lamp lenses and the lamps' light on the paving, from dusk
    const ex = this.lighting.exposure;
    const on = p.skyLux < CITY.lightsOnSkyLux ? 1 : 0;
    CITY_LIGHT.window.value = on * Math.min(CITY.windowDisplayCap, CITY.windowLuminanceCdM2 * ex);
    CITY_LIGHT.lamp.value = on * Math.min(CITY.lensDisplayCap, CITY.lampLensCdM2 * ex);
    CITY_LIGHT.lampCd.value = on * Math.min(CITY.poolDisplayCapCd, CITY.lampIntensityCd * ex);
  }

  /** The frame governor moved (render scale, reflections): particle sizes are in pixels, the lakes' mirror follows. */
  refreshPixelScale(): void {
    this.applyFog();
    this.water.setMirrorAllowed(this.pipeline.governor.step.reflections);
  }

  private applyFog(): void {
    const p = this.lighting.preset;
    const colour = ATMO.fogColor.value;
    let density: number;
    if (this.thermal) {
      colour.setRGB(0.02, 0.02, 0.02);
      density = p.fogDensity * 0.5;
    } else {
      colour.copy(this.lighting.fogColor);
      density = p.fogDensity;
    }
    // height fog: denser in the valleys, thinner on the ridges (see render/atmosphere.ts)
    ATMO.fog.value.x = density * 1.12;
    ATMO.fog.value.w = this.thermal ? 0 : 1;
    this.effects.setLighting(this.lighting.exposure, this.lighting.ambient, this.lighting.sunColor);
  }

  /** Bake the sky probe behind the loading screen (the renderer must be initialised). */
  async init(): Promise<void> {
    await this.lighting.prepare();
    // trees beyond the quality's near distance become impostors (baked once, here)
    const q = this.quality;
    this.world.vegetation.initImpostors(this.pipeline.renderer, q.treeNearDist, q.id === 'high' ? 30 : 24, q.id === 'high' ? 192 : 128);
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    this.clearBattle();
    this.hud.clearMessages();
    this.player = new Tank(PLAYER_TANK, 'player', 'west', 7);
    this.scene.add(this.player.model.root);
    this.player.place(PLAYER_SPAWN.x, PLAYER_SPAWN.z, PLAYER_SPAWN.yaw, this.world);
    this.player.engineVoice = this.audio.createEngine(true, this.player.pos);
    this.tanks.push(this.player);
    this.drone.reset();
    this.droneView = false;
    this.droneSpotted.clear();
    this.camYaw = PLAYER_SPAWN.yaw + Math.PI;
    this.camPitch = 0.02;
    this.sight = false;
    this.wave = 0;
    this.score = 0;
    this.time = 0;
    this.world.terrain.warm(this.player.pos);
    this.world.grass.warm(this.player.pos);
    this.nextWave();
    this.setState('playing');
  }

  private clearBattle(): void {
    for (const t of this.tanks) {
      this.audio.stopEngine(t.engineVoice);
      t.dispose();
    }
    this.tanks = [];
    this.enemies = [];
    this.ais = [];
    this.projectiles.clear();
    this.bullets.clear();
    this.infantry.clear();
    this.aa.clear();
    this.effects.clear();
    this.world.decals.clear();
    this.lockTarget = null;
    this.lasedRange = null;
  }

  private setState(s: GameState): void {
    this.state = s;
    this.onStateChange(s);
  }

  /**
   * Compile every shader the battle can need before it starts. Effects, tracers, the drone and
   * wreck fires are hidden until first used, and compileAsync skips hidden objects (and compiles
   * for the plain framebuffer, not the post chain's scene pass), so they would otherwise compile
   * mid-fight and stall a frame. One object per shader build is forced visible for compileAsync and
   * for one real frame of both post chains, sun shafts forced on, in the normal and thermal
   * channels; then everything is put back (render/warmup.ts, shared with anbow1/FPS).
   */
  async warmup(): Promise<void> {
    const r = this.pipeline.renderer;
    this.water.warmup(r);
    const lights: [THREE.DirectionalLight, boolean][] = [];
    this.scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (l.isLight && l.castShadow && l.shadow) {
        lights.push([l, l.shadow.autoUpdate]);
        l.shadow.autoUpdate = true;
      }
    });
    const restore = revealOnePerPipeline(this.scene);
    try {
      await withTimeout(r.compileAsync(this.scene, this.camera), 20000);
      this.water.warmMirror(r, this.scene, this.camera);
    } catch (err) {
      console.error('shader pre-compilation failed; continuing, the rest compiles on first use:', err);
    } finally {
      restore();
    }
    // the scene pass renders at most once per animation frame: give each warm frame its own
    this.pipeline.render(this.now);
    await nextFrame();
    const th = this.pipeline.thermalOn;
    for (const thermal of [false, true]) {
      this.pipeline.thermalOn = thermal;
      G.uThermal.value = thermal ? 1 : 0;
      this.pipeline.shafts.force = true;
      warmAllPipelines(this.scene, () => this.pipeline.renderBoth(this.now));
      this.pipeline.shafts.force = false;
      await nextFrame();
    }
    this.pipeline.thermalOn = th;
    G.uThermal.value = th ? 1 : 0;
    for (const [l, a] of lights) l.shadow.autoUpdate = a;
  }

  /** Benchmark: the player's tank at a fixed spot, the chase camera behind it, no sight or drone view. */
  benchPlace(x: number, z: number, yaw: number): void {
    this.player.turretYaw = 0; // hull-relative: the gun looks where the tank faces
    this.player.place(x, z, yaw, this.world);
    this.camYaw = yaw + Math.PI;
    this.camPitch = 0.02;
    this.sight = false;
    this.droneView = false;
  }

  pause(on: boolean): void {
    if (on && this.state === 'playing') this.setState('paused');
    else if (!on && this.state === 'paused') this.setState('playing');
  }

  private nextWave(): void {
    // remove old wrecks from previous waves (keep the scene light)
    for (const e of this.enemies) {
      if (!e.alive && e.deadTime > 30) {
        this.audio.stopEngine(e.engineVoice);
        e.dispose();
        this.tanks.splice(this.tanks.indexOf(e), 1);
      }
    }
    this.enemies = this.enemies.filter((e) => this.tanks.includes(e));
    this.ais = this.ais.filter((a) => this.tanks.includes(a.tank));
    this.wave++;
    const count = Math.min(2 + this.wave, 7);
    const skill = Math.min(1, 0.25 + this.wave * 0.12);
    const p = this.player;
    for (let i = 0; i < count; i++) {
      let x = 0;
      let z = 0;
      for (let a = 0; a < 200; a++) {
        const ang = this.rng.next() * Math.PI * 2;
        const d = this.rng.range(850, 1500);
        x = p.pos.x + Math.cos(ang) * d;
        z = p.pos.z + Math.sin(ang) * d;
        if (Math.abs(x) > PLAY_HALF - 60 || Math.abs(z) > PLAY_HALF - 60) continue;
        if (this.world.hf.heightAt(x, z) < WATER_LEVEL + 1.5) continue;
        if (this.world.insideBuilding(x, z, 12)) continue;
        // in the town only on a street or in a park: never shut in a courtyard
        const ground = this.world.city.surfaceAt(x, z);
        if (ground === 'block' || ground === 'walk' || ground === 'square') continue;
        if (this.tanks.some((t) => hyp2(t.pos.x - x, t.pos.z - z) < 40)) continue;
        break;
      }
      const e = new Tank(ENEMY_TANK, 'enemy', 'east', 100 + this.wave * 10 + i);
      this.scene.add(e.model.root);
      e.place(x, z, Math.atan2(p.pos.x - x, p.pos.z - z) + this.rng.range(-0.6, 0.6), this.world);
      e.engineVoice = this.audio.createEngine(false, e.pos);
      this.tanks.push(e);
      this.enemies.push(e);
      this.ais.push(new TankAI(e, skill, 900 + this.wave * 31 + i));
    }
    // infantry AT teams wait in cover along the approach
    const centre = new THREE.Vector3();
    for (const e of this.enemies) if (e.alive) centre.add(e.pos);
    centre.divideScalar(Math.max(1, this.enemies.filter((e) => e.alive).length));
    const squads = Math.min(1 + Math.floor(this.wave / 2), 3);
    for (let i = 0; i < squads; i++) this.infantry.spawnSquad(this.world, p.pos, centre);
    this.hud.setWave(`FALA ${this.wave} · wrogów: ${count}`);
    this.hud.message(`Fala ${this.wave}: ${count} czołgów wroga, piechota w zasadzkach`, 'info');
  }

  // ------------------------------------------------------------------ per-frame input (render rate)

  handleInput(dt: number): void {
    const inp = this.input;
    const p = this.player;
    if (inp.wasPressed('F3')) this.hud.perfVisible = !this.hud.perfVisible;
    if (inp.wasPressed('KeyT')) {
      this.setPreset(this.presetIndex + 1);
      this.hud.message(`Oświetlenie: ${this.lighting.preset.label}`, 'info');
    }
    if (inp.wasPressed('KeyO')) {
      this.setQuality(this.quality.id === 'high' ? QUALITY.low : QUALITY.high);
      this.applyFog();
      this.hud.message(`Jakość: ${this.quality.id === 'high' ? 'wysoka' : 'niska'}`, 'info');
    }
    if (this.state !== 'playing') return;
    if (!p.alive) return;

    // ---- recon drone
    if (inp.wasPressed('KeyB')) this.toggleDrone();
    if (inp.wasPressed('KeyG') && this.drone.alive) {
      this.drone.recall();
      this.droneView = false;
      this.hud.message('Dron wraca do czołgu', 'info');
    }
    if (this.droneView && !this.drone.alive) this.droneView = false;
    if (this.droneView) {
      const d = this.drone;
      const f = (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0) + inp.stickY;
      const r = (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0) + inp.stickX;
      const u = (inp.isDown('KeyE') || inp.isDown('Space') ? 1 : 0) - (inp.isDown('KeyQ') || inp.isDown('KeyC') ? 1 : 0);
      d.input.fwd = Math.max(-1, Math.min(1, f));
      d.input.right = Math.max(-1, Math.min(1, r));
      d.input.up = u;
      d.input.boost = inp.isDown('ShiftLeft');
      const sens = 0.0022 * this.sensitivity;
      d.camYaw -= inp.mouseDX * sens;
      d.camPitch = Math.max(-1.5, Math.min(0.35, d.camPitch - inp.mouseDY * sens));
      p.throttle = 0;
      p.steer = 0;
      this.mgHeld = false;
      if (inp.wasPressed('KeyN')) this.toggleThermal();
      if (inp.wasPressed('KeyR') || inp.wasClicked(0)) this.droneLase();
      return;
    }
    this.mgHeld = inp.isButton(2) || inp.isDown('KeyM');

    const fwd = (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0);
    const right = (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0);
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    p.throttle = clamp1(fwd + inp.stickY) * (inp.isDown('ShiftLeft') && !this.sight ? 0.45 : 1);
    p.steer = clamp1(right + inp.stickX);
    if (inp.isDown('Space')) p.throttle = 0; // hand brake / short halt

    if (inp.wasPressed('Digit1')) p.selectAmmo('APFSDS');
    if (inp.wasPressed('Digit2')) p.selectAmmo('HEAT');
    if (inp.wasPressed('Digit3')) p.selectAmmo('HE');
    if (inp.wasPressed('KeyQ')) {
      const order = ['APFSDS', 'HEAT', 'HE'] as const;
      p.selectAmmo(order[(order.indexOf(p.selected) + 1) % order.length]!);
      this.audio.uiBeep(1000, 0.03);
    }
    if (inp.wasPressed('KeyF')) {
      if (p.extinguish()) this.hud.message('Pożar ugaszony', 'good');
    }
    if (inp.wasPressed('KeyL')) this.headlightsOn = !this.headlightsOn;
    if (inp.wasPressed('KeyV')) this.toggleSight();
    if (inp.wasPressed('KeyN')) this.toggleThermal();
    this.freeLook = inp.isDown('KeyC');

    const fovRad = (this.camera.fov * Math.PI) / 180;
    const sens = 0.0022 * this.sensitivity * (this.sight ? fovRad / 1.05 : 1);
    if (this.sight) {
      this.sightYaw -= inp.mouseDX * sens;
      this.sightPitch = Math.max(-0.26, Math.min(0.4, this.sightPitch - inp.mouseDY * sens));
      if (inp.wheel !== 0) {
        this.zoomIdx = Math.max(0, Math.min(this.zooms.length - 1, this.zoomIdx - inp.wheel));
      }
      if (inp.wasPressed('KeyZ')) this.zoomIdx = (this.zoomIdx + 1) % this.zooms.length;
    } else {
      this.camYaw -= inp.mouseDX * sens;
      this.camPitch = Math.max(-0.75, Math.min(0.5, this.camPitch - inp.mouseDY * sens));
      if (inp.wheel !== 0) this.camDist = Math.max(7, Math.min(24, this.camDist + inp.wheel * 1.5));
    }
    if (inp.wasPressed('KeyR')) this.lase();
    if (inp.wasClicked(0) || inp.wasPressed('Enter')) this.playerFire();
    void dt;
  }

  private toggleThermal(): void {
    this.thermal = !this.thermal;
    G.uThermal.value = this.thermal ? 1 : 0;
    this.pipeline.thermalOn = this.thermal;
    this.applyFog();
    this.audio.uiBeep(this.thermal ? 880 : 660);
  }

  /** B: launch the drone, or switch between the drone and the tank while it flies. */
  private toggleDrone(): void {
    const d = this.drone;
    if (d.canLaunch()) {
      d.launch(this.player);
      this.droneView = true;
      this.sight = false;
      this.hud.message(`Dron startuje (zapas: ${d.spares})`, 'info');
      this.audio.uiBeep(1300, 0.05);
    } else if (d.alive) {
      this.droneView = !this.droneView;
      if (this.droneView) this.sight = false;
    } else if (d.state === 'rearming') {
      this.hud.message(d.spares > 0 ? `Dron: przygotowanie ${Math.ceil(d.rearmT)} s` : 'Brak dronów', 'info');
    } else if (d.spares <= 0) this.hud.message('Brak dronów', 'info');
  }

  /** Mark whatever sits under the drone's crosshair (tanks and infantry within 25 m of the aim point). */
  private droneLase(): void {
    const d = this.drone;
    const dir = d.cameraDir(_v);
    const end = _m.copy(d.pos).addScaledVector(dir, 2500);
    const r = this.world.raycast(d.pos.x, d.pos.y, d.pos.z, end.x, end.y, end.z, _ray, 5);
    if (r.kind === 'none') return;
    const hit = _v2.set(r.x, r.y, r.z);
    let n = 0;
    for (const e of this.enemies) if (e.alive && e.pos.distanceTo(hit) < 25) {
      this.droneSpotted.set(e, this.time + 60);
      n++;
    }
    for (const s of this.infantry.soldiers) if (s.alive && s.pos.distanceTo(hit) < 25) {
      s.spottedUntil = this.time + 60;
      n++;
    }
    this.audio.uiBeep(n ? 1500 : 500, 0.05);
    if (n) this.hud.message(`Dron oznaczył cele: ${n}`, 'good');
  }

  private onSoldierKilled(s: Soldier, how: string): void {
    this.score += 20 * Math.max(1, this.wave);
    if (s.spottedUntil > this.time || how === 'crushed' || how === 'blast' || how === 'bullet') {
      this.hud.message(how === 'crushed' ? 'Piechota przejechana' : `Piechota zneutralizowana${s.role === 'rpg' ? ' (RPG)' : ''}`, 'good');
    }
  }

  private toggleSight(): void {
    this.sight = !this.sight;
    const p = this.player;
    if (this.sight) {
      // start the sight looking where the camera looked
      const d = _v.copy(this.aimPoint).sub(p.sightPosition(_v2)).normalize();
      this.sightYaw = Math.atan2(d.x, d.z);
      this.sightPitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
      this.lasedRange = this.lasedRange ?? Math.round(this.autoRange / 10) * 10;
    } else {
      this.camYaw = this.sightYaw + Math.PI;
      this.camPitch = Math.max(-0.75, Math.min(0.5, -this.sightPitch - 0.08));
    }
    this.audio.uiBeep(this.sight ? 1200 : 900, 0.03);
  }

  /** Laser rangefinder along the line of sight; locks a tank for the lead computer. */
  private lase(): void {
    const origin = this.sight ? this.player.sightPosition(_v2) : this.camera.getWorldPosition(_v2);
    const dir = this.sight ? this.sightDir(_v) : this.camera.getWorldDirection(_v);
    const end = _m.copy(origin).addScaledVector(dir, 5000);
    let best = this.world.raycast(origin.x, origin.y, origin.z, end.x, end.y, end.z, _ray, 6).kind === 'none' ? 2 : _ray.t;
    let tank: Tank | null = null;
    for (const t of this.enemies) {
      const h = t.raycast(origin, end, _hit);
      if (h && h.t < best) {
        best = h.t;
        tank = t;
      }
    }
    if (best > 1) {
      this.lasedRange = null;
      this.audio.uiBeep(300, 0.12);
      return;
    }
    const muzzle = this.player.muzzlePosition(_proj);
    const point = _v2.copy(origin).lerp(end, best);
    this.lasedRange = point.distanceTo(muzzle);
    this.lockTarget = tank;
    this.audio.uiBeep(1500, 0.05);
  }

  private sightDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.sightYaw) * Math.cos(this.sightPitch), Math.sin(this.sightPitch), Math.cos(this.sightYaw) * Math.cos(this.sightPitch));
  }

  private playerFire(): void {
    const p = this.player;
    if (!p.canFire()) {
      if (!p.loaded) this.audio.uiBeep(220, 0.05);
      return;
    }
    this.fireTank(p);
  }

  private fireTank(t: Tank): void {
    const ammo = t.fire(this.time);
    if (!ammo) return;
    const muzzle = t.muzzlePosition(new THREE.Vector3());
    const dir = t.gunDirection(new THREE.Vector3());
    // dispersion: 0.2 mil halted, worse on the move (stabiliser helps)
    const mil = 0.00025 + Math.min(1, Math.abs(t.speed) / 10) * 0.0006;
    dir.x += this.rng.gauss() * mil;
    dir.y += this.rng.gauss() * mil;
    dir.z += this.rng.gauss() * mil;
    dir.normalize();
    this.projectiles.fire(t, ammo, muzzle, dir);
    this.effects.muzzleBlast(muzzle, dir, this.world.hf.heightAt(muzzle.x, muzzle.z), true);
    this.audio.cannon(muzzle, t === this.player);
    if (t === this.player) this.effects.shake = Math.max(this.effects.shake, this.sight ? 0.35 : 0.8);
  }

  // ------------------------------------------------------------------ simulation (fixed 60 Hz)

  fixedStep(dt: number): void {
    if (this.state !== 'playing' && this.state !== 'dead' && this.state !== 'intermission') return;
    this.time += dt;
    G.uTime.value = this.time;
    const p = this.player;

    // player's aim → turret demand (stabilised); the FCS switches to coax ballistics while the MG fires
    if (p.alive && !this.freeLook && !this.droneView) {
      // lay from the weapon actually firing (the coax sits beside the main gun)
      if (this.mgHeld) {
        p.model.coax.updateWorldMatrix(true, false);
        _m.setFromMatrixPosition(p.model.coax.matrixWorld);
      } else p.muzzlePosition(_m);
      aimDirection(this.mgHeld ? MG_AIM : p.ammoSpec, _m, this.aimPoint, _dir);
      p.aimDir.set(_dir.x, _dir.y, _dir.z);
    }
    this.fireCoax(dt);
    for (const ai of this.ais) ai.update(dt, this.world, p, this.time, (t) => this.fireTank(t));
    for (const t of this.tanks) t.step(dt, this.world);
    this.collideTanks();
    // drone, infantry, small arms
    this.drone.update(dt, this.world, p, this.effects);
    this.droneSpotting(dt);
    this.infantry.update(dt, this.time, this.world, p, this.drone.alive ? this.drone : null, this.projectiles, this.bullets, this.effects, this.audio);
    this.antiDroneFire(dt);
    this.soft.length = 0;
    for (const s of this.infantry.soldiers) if (s.alive) this.soft.push(s);
    if (this.drone.alive) this.soft.push(this.drone);
    this.bullets.update(dt, this.world, this.tanks, this.soft, this.audio);
    this.projectiles.update(dt, this.world, this.tanks, this.soft, this.camera.position, (e) => this.onImpact(e), (pos) => this.audio.crack(pos));
    this.vehicleEffects(dt);

    // deaths
    for (const t of this.tanks) {
      if (t.alive && t.hp <= 0) this.destroy(t, false);
      if (!t.alive) t.deadTime += dt;
    }
    if (this.state === 'playing' && !p.alive) {
      this.setState('dead');
      this.deadCamT = 0;
    }
    if (this.state === 'playing' && this.enemies.every((e) => !e.alive)) {
      this.setState('intermission');
      this.waveTimer = 8;
      this.hud.message('Fala odparta! Uzupełnianie amunicji i naprawa…', 'good');
    }
    if (this.state === 'intermission') {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        // resupply and field repair between waves
        p.hp = Math.min(p.spec.hp, p.hp + p.spec.hp * 0.3);
        for (const k of Object.keys(p.modules) as (keyof typeof p.modules)[]) p.modules[k] = Math.max(p.modules[k], 0.6);
        p.ammo = { ...p.spec.ammo };
        p.extinguishers = 2;
        this.nextWave();
        this.setState('playing');
      }
    }
  }

  /** Coaxial 7.62 mm: ~800 rds/min, every fourth a tracer. */
  private fireCoax(dt: number): void {
    const p = this.player;
    this.mgT -= dt;
    p.mgHeat = Math.max(0, p.mgHeat - dt * 0.08);
    if (!this.mgHeld || !p.alive || this.droneView || p.mgAmmo <= 0 || p.modules.gun <= 0) return;
    while (this.mgT <= 0 && p.mgAmmo > 0) {
      this.mgT += 60 / 800;
      p.mgAmmo--;
      this.mgCount++;
      p.mgHeat = Math.min(1, p.mgHeat + 0.004);
      p.model.coax.updateWorldMatrix(true, false);
      const pos = _v.setFromMatrixPosition(p.model.coax.matrixWorld);
      const dir = p.gunDirection(_v2);
      const disp = 0.0007 + p.mgHeat * 0.002 + Math.min(1, Math.abs(p.speed) / 10) * 0.0012;
      dir.x += this.rng.gauss() * disp;
      dir.y += this.rng.gauss() * disp;
      dir.z += this.rng.gauss() * disp;
      dir.normalize();
      this.bullets.fire(MG_762, 'player', pos, dir, this.mgCount % 4 === 0, p);
      this.effects.emit(PKind.Flash, pos.x + dir.x * 0.3, pos.y + dir.y * 0.3, pos.z + dir.z * 0.3, dir.x * 20, dir.y * 20, dir.z * 20, 0.5, 0.04, 2.4, 1.6, 0.8, 1, 1);
      this.audio.mg(pos, true);
    }
  }

  /** What the drone's camera sees (cone of view + line of sight) is reported to the crew. */
  private droneSpotting(dt: number): void {
    const d = this.drone;
    this.droneSpotT -= dt;
    if (!d.alive || this.droneSpotT > 0) return;
    this.droneSpotT = 0.25;
    const fwd = d.cameraDir(_fwd);
    const check = (pos: THREE.Vector3, range: number): boolean => {
      const to = _v.subVectors(pos, d.pos);
      const dist = to.length();
      if (dist > range) return false;
      if (to.dot(fwd) / dist < Math.cos(0.62)) return false;
      return this.world.lineOfSight(d.pos.x, d.pos.y, d.pos.z, pos.x, pos.y, pos.z);
    };
    let newly = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (check(e.centre(_v2).clone().setY(e.pos.y + 2.2), 1400)) {
        if ((this.droneSpotted.get(e) ?? 0) < this.time) newly++;
        this.droneSpotted.set(e, this.time + 25);
      }
    }
    for (const s of this.infantry.soldiers) {
      if (!s.alive) continue;
      if (check(_v2.copy(s.pos).setY(s.pos.y + 1.2), 650)) {
        if (s.spottedUntil < this.time) newly++;
        s.spottedUntil = this.time + 25;
      }
    }
    if (newly) this.audio.uiBeep(1700, 0.03);
  }

  /** Enemy tanks engage the drone with their roof machine guns (12.7 mm), green tracers. */
  private antiDroneFire(dt: number): void {
    const d = this.drone;
    if (!d.alive) return;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      let st = this.aa.get(e);
      if (!st) this.aa.set(e, (st = { t: 1 + Math.random() * 2, burst: 0 }));
      st.t -= dt;
      if (st.t > 0) continue;
      e.model.roofMg.updateWorldMatrix(true, false);
      const pos = _v.setFromMatrixPosition(e.model.roofMg.matrixWorld);
      const dist = pos.distanceTo(d.pos);
      if (dist > 650 || !this.world.lineOfSight(pos.x, pos.y, pos.z, d.pos.x, d.pos.y, d.pos.z)) {
        st.t = 0.8;
        st.burst = 0;
        continue;
      }
      if (st.burst <= 0) st.burst = 6 + Math.floor(Math.random() * 5);
      const tof = dist / HMG_127.v0;
      const aim = _v2.copy(d.pos).addScaledVector(d.vel, tof * 0.9);
      aim.y += (9.81 * tof * tof) / 2;
      const dir = aim.sub(pos).normalize();
      // the crew has to find and track the drone first: poor accuracy at range
      const disp = 0.009 + dist * 0.000012;
      dir.x += this.rng.gauss() * disp;
      dir.y += this.rng.gauss() * disp;
      dir.z += this.rng.gauss() * disp;
      this.bullets.fire(HMG_127, 'enemy', pos, dir.normalize(), st.burst % 3 === 0, e);
      this.audio.mg(pos, false);
      st.burst--;
      st.t = st.burst > 0 ? 0.1 : 1.6 + Math.random() * 1.8;
    }
  }

  private collideTanks(): void {
    const n = this.tanks.length;
    for (let i = 0; i < n; i++) {
      const a = this.tanks[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = this.tanks[j]!;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        if (dx * dx + dz * dz > 100) continue;
        // two circles per hull
        for (const sa of [-1, 1]) {
          for (const sb of [-1, 1]) {
            const oa = a.spec.length * 0.25 * sa;
            const ob = b.spec.length * 0.25 * sb;
            const ax = a.pos.x + Math.sin(a.yaw) * oa;
            const az = a.pos.z + Math.cos(a.yaw) * oa;
            const bx = b.pos.x + Math.sin(b.yaw) * ob;
            const bz = b.pos.z + Math.cos(b.yaw) * ob;
            const ddx = bx - ax;
            const ddz = bz - az;
            const d = hyp2(ddx, ddz);
            const r = (a.spec.width + b.spec.width) / 2;
            if (d < r && d > 1e-4) {
              const push = (r - d) / 2;
              const wa = a.alive ? 1 : 0.2;
              const wb = b.alive ? 1 : 0.2;
              a.pos.x -= (ddx / d) * push * wb;
              a.pos.z -= (ddz / d) * push * wb;
              b.pos.x += (ddx / d) * push * wa;
              b.pos.z += (ddz / d) * push * wa;
              a.speed *= 0.9;
              b.speed *= 0.9;
            }
          }
        }
      }
    }
  }

  private vehicleEffects(dt: number): void {
    const fx = this.effects;
    for (const t of this.tanks) {
      const moved = t.animateRunningGear(dt);
      if (!t.alive) continue;
      const speed = Math.abs(t.speed);
      // a hull pushing through a lake raises a bow wave; scaled by dt so it does not depend on frame rate
      if (speed > 0.4 && WATER_LEVEL - this.world.hf.heightAt(t.pos.x, t.pos.z) > 0.1) {
        const bow = t.spec.length * 0.4 * Math.sign(t.speed);
        this.water.ripples.disturb(t.pos.x + Math.sin(t.yaw) * bow, t.pos.z + Math.cos(t.yaw) * bow, 1.4, Math.min(0.03, speed * 0.006) * dt * 60);
      }
      // exhaust
      const exhaustRate = 0.15 + Math.abs(t.throttle) * 1.2;
      for (const e of t.model.exhaust) {
        if (Math.random() < exhaustRate * dt * 12) {
          _v.copy(e).applyMatrix4(t.model.hull.matrixWorld);
          fx.emit(PKind.Smoke, _v.x, _v.y, _v.z, (Math.random() - 0.5) * 0.6, 0.8 + Math.random(), (Math.random() - 0.5) * 0.6, 0.35, 1.2 + Math.random(), 0.2, 0.19, 0.18, 0.06 + Math.abs(t.throttle) * 0.14, 3.5);
        }
      }
      // track dust on dry ground
      if (speed > 1.5) {
        const wet = this.world.hf.heightAt(t.pos.x, t.pos.z) < WATER_LEVEL + 2;
        const rate = Math.min(1, speed / 12) * (wet ? 0.2 : 1);
        for (const side of [-1, 1] as const) {
          if (Math.random() < rate * dt * 30) {
            t.trackContact(side, _v);
            const y = this.world.hf.heightAt(_v.x, _v.z);
            fx.emit(PKind.Dust, _v.x, y + 0.4, _v.z, -t.velocity.x * 0.2 + (Math.random() - 0.5), 0.6 + Math.random() * 1.2, -t.velocity.z * 0.2 + (Math.random() - 0.5),
              1.2 + speed * 0.1, 2.5 + Math.random() * 2.5, 0.55, 0.47, 0.37, 0.35 * rate, 4);
          }
        }
      }
      if (moved > 0 && t.takeTrackMark()) {
        for (const side of [-1, 1] as const) {
          t.trackContact(side, _v);
          this.world.decals.addTrack(_v.x, _v.z, t.yaw, 0.62);
        }
      }
      // burning vehicle
      if (t.burning > 0 && Math.random() < dt * 20) {
        t.centre(_v);
        fx.emit(PKind.Fire, _v.x + (Math.random() - 0.5), _v.y + 0.5, _v.z + (Math.random() - 0.5), 0, 2 + Math.random() * 2, 0, 1.2, 0.5, 2, 1.3, 0.6, 1, 1.2);
        fx.emit(PKind.Smoke, _v.x, _v.y + 1.5, _v.z, 0, 3, 0, 1.8, 4, 0.1, 0.1, 0.1, 0.6, 4);
      }
    }
    for (let i = 0; i < this.tanks.length && i < 10; i++) {
      const t = this.tanks[i]!;
      this.world.grass.setPusher(i, t.pos.x, t.pos.y, t.pos.z, t.spec.length * 0.55);
    }
  }

  private destroy(t: Tank, cookOff: boolean): void {
    t.kill(cookOff);
    t.centre(_v);
    this.effects.bigExplosion(_v.x, _v.y, _v.z);
    this.effects.addFire(_v.x, _v.y + 0.5, _v.z, cookOff ? 120 : 75, cookOff ? 1.4 : 1);
    this.audio.explosion(_v, cookOff ? 3 : 2);
    this.audio.stopEngine(t.engineVoice);
    t.engineVoice = null;
    this.world.decals.addScorch(t.pos.x, t.pos.z, 9);
    if (t.team === 'enemy') {
      this.score += 100 * this.wave;
      this.player.kills++;
      this.hud.setWave(`FALA ${this.wave} · wrogów: ${this.enemies.filter((e) => e.alive).length}`);
    }
    if (this.lockTarget === t) this.lockTarget = null;
  }

  private onImpact(e: ImpactEvent): void {
    const sh = e.shell;
    const ammo = sh.ammo;
    const byPlayer = sh.team === 'player';
    // shrapnel and blast against infantry
    const blastR = ammo.id === 'HE' ? 9 : ammo.id === 'HEAT' ? 4 : ammo.id === 'RPG' ? 3 : 1.5;
    this.infantry.blast(e.point, blastR);
    if (this.drone.alive && this.drone.pos.distanceTo(e.point) < blastR * 1.5) this.drone.shootDown();
    if (e.kind === 'soft' && e.soft) {
      e.soft.onBullet(e.point, e.dir, 1000, sh.team);
      if (ammo.blastRadius > 0) this.effects.explosionCore(e.point.x, e.point.y, e.point.z, ammo.id === 'HE' ? 1 : 0.5);
      this.audio.explosion(e.point, 0.6);
      return;
    }
    if (e.kind === 'tank' && e.tank && e.hit) {
      const t = e.tank;
      const rep = t.takeHit(e.hit, e.dir, ammo, sh.flown, sh.owner);
      const worldN = _v.copy(e.hit.localNormal).transformDirection(
        (e.hit.part === 'hull' ? t.model.hull : e.hit.part === 'turret' ? t.model.turret : t.model.gun).matrixWorld,
      );
      const pen = rep.outcome === 'pen' || rep.outcome === 'kill';
      this.effects.armourHit(e.point, worldN, pen);
      if (ammo.blastRadius > 0) this.effects.explosionCore(e.point.x, e.point.y, e.point.z, ammo.id === 'HE' ? 1 : 0.6);
      this.audio.clang(e.point, pen ? 1.4 : 1, rep.outcome === 'ricochet', t === this.player);
      if (rep.outcome === 'ricochet') this.projectiles.ricochet(sh, worldN);
      if (rep.cookOff || (rep.outcome === 'kill' && t.alive)) this.destroy(t, rep.cookOff);
      if (byPlayer) {
        const extra = rep.modules.length ? ` · ${rep.modules.map((m) => MOD_PL[m]).join(', ')}` : '';
        const txt = rep.cookOff ? 'WYBUCH AMUNICJI!' : OUTCOME_TEXT[rep.outcome] ?? rep.outcome;
        this.hud.message(`${txt}${extra}`, pen || rep.outcome === 'track' ? 'good' : 'info');
      }
      if (t === this.player) {
        this.hitAge = 0;
        this.lastHitFrom.copy(sh.owner ? sh.owner.pos : sh.origin);
        this.effects.shake = Math.max(this.effects.shake, pen ? 1 : 0.5);
        const txt = rep.outcome === 'ricochet' ? 'Rykoszet od pancerza' : rep.outcome === 'nopen' ? 'Trafienie — pancerz wytrzymał' : rep.outcome === 'track' ? 'Zerwana gąsienica!' : 'PRZEBICIE!';
        const mods = rep.modules.length ? ` · ${rep.modules.map((m) => MOD_PL[m]).join(', ')}` : '';
        this.hud.message(`${txt}${mods}${rep.fire ? ' · POŻAR' : ''}`, pen ? 'bad' : 'info');
      }
      return;
    }
    const explosive = ammo.id === 'HE' ? 1 : ammo.id === 'HEAT' ? 0.5 : 0;
    if (e.kind === 'water') {
      this.water.ripples.disturb(e.point.x, e.point.z, 0.9 + explosive * 1.2, 0.25 + explosive * 0.2);
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        this.effects.emit(PKind.Dust, e.point.x, WATER_LEVEL + 0.2, e.point.z, Math.cos(a) * 2, 8 + Math.random() * 14, Math.sin(a) * 2, 1.2, 1.6, 0.85, 0.9, 0.92, 0.6, 2);
      }
      this.audio.explosion(e.point, 0.4);
      return;
    }
    this.effects.groundImpact(e.point.x, e.point.y, e.point.z, explosive);
    if (e.kind === 'terrain') this.world.decals.addScorch(e.point.x, e.point.z, 1.5 + explosive * 3);
    this.audio.explosion(e.point, 0.5 + explosive);
    // splash damage from HE near a tank
    if (ammo.blastRadius > 0) {
      for (const t of this.tanks) {
        if (!t.alive) continue;
        const d = t.centre(_v2).distanceTo(e.point);
        if (d < ammo.blastRadius) {
          const loss = t.spec.hp * 0.03 * (1 - d / ammo.blastRadius);
          t.hp -= loss;
          if (d < ammo.blastRadius * 0.5) {
            const side = t.model.hull.worldToLocal(_v2.copy(e.point)).x > 0 ? 'trackL' : 'trackR';
            t.modules[side] = Math.max(0, t.modules[side] - 0.5);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ render-rate update

  frame(dt: number, alpha = 1): MarkerState {
    const p = this.player;
    const cam = this.camera;
    this.hitAge += dt;
    // cloud field drifts with the wind (~9 m/s); wrapped so float precision never degrades
    const cl = ATMO.cloud.value;
    cl.x = (cl.x + G.uWind.value.x * dt * 8.5) % 90000;
    cl.y = (cl.y + G.uWind.value.y * dt * 8.5) % 90000;
    for (const t of this.tanks) t.interpolate(alpha);
    // own gun and turret would fill the gunner's view: hide them in the sight (shadows too, acceptable)
    const inSight = this.sight && p.alive;
    p.model.gun.visible = !inSight;
    for (const c of p.model.turret.children) if (c !== p.model.gun && (c as THREE.Mesh).isMesh) c.visible = !inSight;
    this.drone.model.visible = this.drone.airborne && !this.droneView;
    // camera
    if (this.droneView && this.drone.alive) {
      const d = this.drone;
      cam.fov = 70;
      cam.position.copy(d.model.position).y -= 0.08;
      cam.up.set(0, 1, 0);
      cam.lookAt(_v.copy(cam.position).add(d.cameraDir(_fwd)));
    } else if (this.sight && p.alive) {
      const zoom = this.zooms[this.zoomIdx]!;
      cam.fov = (2 * Math.atan(Math.tan((60 * Math.PI) / 360) / zoom) * 180) / Math.PI;
      p.sightPosition(cam.position);
      this.sightDir(_fwd);
      cam.up.set(0, 1, 0);
      cam.lookAt(_v.copy(cam.position).add(_fwd));
    } else {
      this.sight = false;
      cam.fov = 60;
      const rp = p.model.root.position;
      const pivot = _v.copy(rp).setY(rp.y + 3.0);
      if (!p.alive) {
        this.deadCamT += dt;
        this.camYaw += dt * 0.15;
      }
      const cy = Math.cos(this.camPitch);
      _fwd.set(Math.sin(this.camYaw) * cy, Math.sin(-this.camPitch), Math.cos(this.camYaw) * cy);
      const want = _v2.copy(pivot).addScaledVector(_fwd, this.camDist);
      // pull the camera in front of walls and hills between it and the tank
      this.world.raycast(pivot.x, pivot.y, pivot.z, want.x, want.y, want.z, _ray, 1.5);
      if (_ray.kind !== 'none') want.lerpVectors(pivot, want, Math.max(0.12, _ray.t - 0.06));
      const ground = this.world.hf.heightAt(want.x, want.z) + 1.2;
      if (want.y < ground) want.y = ground;
      // smooth only the height to avoid jitter over bumps
      this.camPos.copy(want);
      cam.position.copy(this.camPos);
      cam.lookAt(_m.copy(pivot).addScaledVector(_up, 0.6 + this.camDist * 0.06));
    }
    // camera shake
    const sh = this.effects.shake * (this.sight ? 0.15 : 0.3);
    if (sh > 0.001) {
      this.shakeOffset.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
      if (this.sight) cam.rotateX(this.shakeOffset.y * 0.02).rotateY(this.shakeOffset.x * 0.02);
      else cam.position.add(this.shakeOffset);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // the shadow cascades are split along the view frustum: refit them when the sight zooms
    if (cam.fov !== this.cascadeFov) {
      this.cascadeFov = cam.fov;
      this.lighting.refitCascades();
    }
    this.lighting.track(cam.position);

    // aim point (the turret holds its last aim while the crew flies the drone)
    const origin = this.sight ? p.sightPosition(_v) : cam.position;
    if (!this.droneView) {
    const dir = this.sight ? this.sightDir(_v2) : cam.getWorldDirection(_v2);
    if (this.sight) {
      const range = this.lasedRange ?? 1000;
      this.aimPoint.copy(origin).addScaledVector(dir, range);
    } else {
      const end = _m.copy(origin).addScaledVector(dir, 4000);
      let best = this.world.raycast(origin.x, origin.y, origin.z, end.x, end.y, end.z, _ray, 5).kind === 'none' ? 2 : _ray.t;
      for (const t of this.tanks) {
        if (t === p) continue;
        const h = t.raycast(origin, end, _hit);
        if (h && h.t < best) best = h.t;
      }
      if (best > 1) best = 0.6; // sky: aim 2.4 km out
      this.aimPoint.copy(origin).lerp(end, best);
      // don't aim at our own tank when looking down past it
      if (this.aimPoint.distanceTo(p.pos) < 8) this.aimPoint.copy(origin).addScaledVector(dir, 60);
      p.muzzlePosition(_proj);
      this.autoRange = this.aimPoint.distanceTo(_proj);
    }
    }

    // lighting follows the action
    this.lighting.follow(this.droneView ? cam.position.clone().addScaledVector(this.drone.cameraDir(_v), 60) : this.sight ? this.aimPoint.clone().lerp(p.pos, 0.85) : p.pos);
    const hl = this.headlightsOn && p.alive;
    p.model.headlightMat.emissiveIntensity = hl ? Math.min(2e4, 3000 * this.lighting.exposure) : 0;
    this.headlight.intensity = hl ? Math.min(1e5, 15000 * this.lighting.exposure) : 0;
    if (hl) {
      p.model.hull.updateWorldMatrix(true, false);
      this.headlight.position.set(0, 1.5, 3.9).applyMatrix4(p.model.hull.matrixWorld);
      this.headlight.target.position.set(0, -2, 30).applyMatrix4(p.model.hull.matrixWorld);
      this.headlight.target.updateMatrixWorld();
    }

    this.world.update(dt, cam.position);
    this.rain.wind.value.set(G.uWind.value.x * 3, G.uWind.value.y * 3);
    this.rain.update(this.time, cam.position);
    this.infantry.render(cam.position);
    if (!this.rotor && this.audio.ready) this.rotor = this.audio.createRotor();
    if (this.rotor) this.audio.updateRotor(this.rotor, this.drone.pos, Math.min(1, this.drone.vel.length() / DRONE.maxSpeed), this.drone.alive);
    this.water.update(this.pipeline.renderer, this.time, this.scene, cam, dt);
    this.effects.update(dt, cam.position, this.quality.wreckShadow);
    this.effects.setWind(G.uWind.value);

    // audio
    cam.getWorldDirection(_fwd);
    this.audio.setListener(cam.position, _fwd, _up);
    for (const t of this.tanks) {
      if (!t.engineVoice) continue;
      const rpm = Math.min(1, Math.abs(t.speed) / t.spec.maxFwd * 0.8 + Math.abs(t.throttle) * 0.3 + Math.abs(t.steer) * 0.15);
      this.audio.updateEngine(t.engineVoice, rpm, Math.abs(t.throttle), t.pos, t === p ? (this.sight ? 0.6 : 1) : 1.3);
    }
    this.audio.setTurretSpeed(p.alive ? p.turretSpeed : 0);

    // spotting for the minimap (2 Hz)
    this.spotT -= dt;
    if (this.spotT <= 0) {
      this.spotT = 0.5;
      p.centre(_v);
      _v.y += 1;
      for (const e of this.enemies) {
        e.centre(_v2);
        const d = _v.distanceTo(_v2);
        const seen = e.alive && d < 2500 && this.world.lineOfSight(_v.x, _v.y, _v.z, _v2.x, _v2.y + 0.5, _v2.z);
        const byDrone = (this.droneSpotted.get(e) ?? 0) > this.time;
        if (seen || byDrone || (e.alive && this.time - e.lastShotTime < 4 && d < 1800)) this.spotted.add(e);
        else if (!e.alive || d > 2600) this.spotted.delete(e);
      }
      for (const s of this.infantry.soldiers) {
        if (!s.alive) continue;
        const d = s.pos.distanceTo(p.pos);
        const firing = s.state === 'aim' && s.timer < 0.3;
        if ((d < 120 || (firing && d < 600)) && this.world.lineOfSight(_v.x, _v.y, _v.z, s.pos.x, s.pos.y + 1.2, s.pos.z)) {
          s.spottedUntil = Math.max(s.spottedUntil, this.time + 8);
        }
      }
    }

    return this.markers();
  }

  private toScreen(p: THREE.Vector3): { x: number; y: number } | null {
    _proj.copy(p).project(this.camera);
    if (_proj.z > 1 || _proj.z < -1) return null;
    return { x: (_proj.x * 0.5 + 0.5) * window.innerWidth, y: (-_proj.y * 0.5 + 0.5) * window.innerHeight };
  }

  /** Predicted impact of the gun as it points right now (the gun marker). */
  private gunImpact(out: THREE.Vector3): boolean {
    const p = this.player;
    p.muzzlePosition(_m);
    p.gunDirection(_v);
    const ammo = this.mgHeld ? MG_AIM : p.ammoSpec;
    const s = { x: _m.x, y: _m.y, z: _m.z, vx: _v.x * ammo.v0, vy: _v.y * ammo.v0, vz: _v.z * ammo.v0 };
    for (let i = 0; i < 300; i++) {
      const ax = s.x;
      const ay = s.y;
      const az = s.z;
      stepShell(s, ammo.k, 1 / 60);
      this.world.raycast(ax, ay, az, s.x, s.y, s.z, _ray, 6);
      if (_ray.kind !== 'none') {
        out.set(_ray.x, _ray.y, _ray.z);
        return true;
      }
      _v.set(ax, ay, az);
      _v2.set(s.x, s.y, s.z);
      for (const t of this.enemies) {
        const h = t.raycast(_v, _v2, _hit);
        if (h) {
          out.copy(h.point);
          return true;
        }
      }
    }
    return false;
  }

  private markers(): MarkerState {
    const p = this.player;
    const cam = this.camera;
    const focal = window.innerHeight / 2 / Math.tan((cam.fov * Math.PI) / 360);
    let gun: { x: number; y: number } | null = null;
    if (p.alive && this.gunImpact(_v)) {
      // in the sight the marker shows the bore line at the lased range instead of the ground hit
      gun = this.toScreen(_v);
    }
    let lead: { x: number; y: number } | null = null;
    let target: { x: number; y: number; r: number } | null = null;
    const lt = this.lockTarget;
    if (lt && lt.alive && p.alive) {
      lt.centre(_v);
      const sc = this.toScreen(_v);
      if (sc) {
        const d = _v.distanceTo(cam.position);
        target = { ...sc, r: (4 * focal) / Math.max(1, d) };
        const tof = timeOfFlight(p.ammoSpec, lt.pos.distanceTo(p.pos));
        _v.addScaledVector(lt.velocity, tof).addScaledVector(p.velocity, -tof);
        lead = lt.velocity.lengthSq() > 0.5 ? this.toScreen(_v) : null;
      }
    }
    let hitDir: number | null = null;
    if (this.hitAge < 2.5) {
      const a = Math.atan2(this.lastHitFrom.x - cam.position.x, this.lastHitFrom.z - cam.position.z);
      cam.getWorldDirection(_v);
      const c = Math.atan2(_v.x, _v.z);
      hitDir = -(a - c);
    }
    // spotted units: red chevrons over tanks, small diamonds over infantry
    const spots: { x: number; y: number; kind: 'tank' | 'inf' }[] = [];
    for (const e of this.enemies) {
      if (!e.alive || !this.spotted.has(e)) continue;
      const sc = this.toScreen(e.centre(_v).setY(e.pos.y + 4));
      if (sc) spots.push({ ...sc, kind: 'tank' });
    }
    for (const s of this.infantry.spotted(this.time)) {
      const sc = this.toScreen(_v.copy(s.pos).setY(s.pos.y + 2.1));
      if (sc) spots.push({ ...sc, kind: 'inf' });
    }
    const d = this.drone;
    const drone = this.droneView && d.alive
      ? {
        alt: d.pos.y - this.world.hf.heightAt(d.pos.x, d.pos.z),
        dist: hyp2(d.pos.x - p.pos.x, d.pos.z - p.pos.z),
        battery: d.battery / DRONE.battery,
        speed: d.vel.length(),
        spares: d.spares,
        warning: d.warning,
        returning: d.state === 'returning',
      }
      : null;
    return {
      drone,
      spots,
      mg: { held: this.mgHeld, ammo: p.mgAmmo, heat: p.mgHeat },
      sight: this.sight,
      zoom: this.zooms[this.zoomIdx]!,
      thermal: this.thermal,
      gun,
      gunReady: !!p.loaded,
      lead,
      target,
      pxPerMil: focal / 1000,
      hitDir,
      hitAge: this.hitAge,
    };
  }

  get rangeInfo(): { range: number | null; lased: boolean } {
    return this.sight ? { range: this.lasedRange, lased: true } : { range: this.autoRange, lased: this.lasedRange !== null && this.lockTarget !== null };
  }

  get droneMap(): { x: number; z: number; yaw: number; state: string } | null {
    const d = this.drone;
    return d.airborne ? { x: d.pos.x, z: d.pos.z, yaw: d.camYaw, state: d.state } : null;
  }

  get droneStatus(): { state: string; spares: number; rearm: number } {
    return { state: this.drone.state, spares: this.drone.spares, rearm: this.drone.rearmT };
  }

  get spottedInfantry(): Soldier[] {
    return this.infantry.spotted(this.time);
  }

  get spottedSet(): Set<Tank> {
    return this.spotted;
  }

  get allTanks(): Tank[] {
    return this.tanks;
  }

  get now(): number {
    return this.time;
  }
}

const MOD_PL: Record<string, string> = {
  engine: 'silnik', trackL: 'gąsienica L', trackR: 'gąsienica P', gun: 'działo', turretDrive: 'napęd wieży', ammo: 'amunicja', fuel: 'paliwo',
};

export { PHYS_DT };
