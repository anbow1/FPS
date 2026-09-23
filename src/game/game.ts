import * as THREE from 'three';
import { ENEMY_TANK, PHYS_DT, PLAY_HALF, PLAYER_TANK, QUALITY, type QualityPreset, WATER_LEVEL } from '../config';
import type { Input } from '../core/input';
import { Rng } from '../core/rng';
import { Lighting, PRESETS } from '../render/lighting';
import type { Pipeline } from '../render/pipeline';
import { G } from '../render/shaderPatch';
import type { Hud, MarkerState } from '../ui/hud';
import { PLAYER_SPAWN } from '../world/layout';
import type { World } from '../world/world';
import { TankAI } from './ai';
import type { Audio } from './audio';
import { aimDirection, stepShell, timeOfFlight } from './ballistics';
import { Effects, PKind } from './effects';
import { type ImpactEvent, Projectiles } from './projectiles';
import { type HitInfo, Tank } from './tank';

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

const OUTCOME_TEXT: Record<string, string> = {
  ricochet: 'RYKOSZET', nopen: 'BRAK PRZEBICIA', pen: 'PRZEBICIE', track: 'GĄSIENICA ZERWANA', gun: 'TRAFIENIE W DZIAŁO', kill: 'CEL ZNISZCZONY',
};

export class Game {
  state: GameState = 'menu';
  readonly scene: THREE.Scene;
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.25, 9000);
  readonly lighting: Lighting;
  readonly effects: Effects;
  readonly projectiles: Projectiles;
  player!: Tank;
  enemies: Tank[] = [];
  private ais: TankAI[] = [];
  private tanks: Tank[] = [];
  private headlight: THREE.SpotLight;
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
  private deadCamT = 0;
  onStateChange: (s: GameState) => void = () => {};

  constructor(
    private readonly pipeline: Pipeline,
    readonly world: World,
    private readonly input: Input,
    private readonly hud: Hud,
    private readonly audio: Audio,
  ) {
    pipeline.camera = this.camera;
    this.scene = pipeline.sceneRef;
    this.scene.add(world.group);
    this.lighting = new Lighting(pipeline.renderer, this.scene);
    this.effects = new Effects(this.quality.maxParticles);
    this.scene.add(this.effects.group);
    this.projectiles = new Projectiles(this.effects);
    this.headlight = new THREE.SpotLight(0xfff4e0, 0, 120, 0.5, 0.45, 2);
    this.scene.add(this.headlight, this.headlight.target);
    this.scene.fog = new THREE.FogExp2(0xffffff, 0.0003);
    this.setQuality(this.quality);
    this.setPreset(0);
    hud.buildMinimap(world);
  }

  setQuality(q: QualityPreset): void {
    this.quality = q;
    this.pipeline.setQuality(q);
    this.lighting.setShadowQuality(q.shadowMapSize, q.shadowExtent);
    this.effects.setMaxParticles(q.maxParticles);
    this.effects.setWreckShadow(q.wreckShadow);
    this.world.grass.setDensity(q.grassPerChunk, q.grassRadius);
  }

  setPreset(i: number): void {
    this.presetIndex = (i + PRESETS.length) % PRESETS.length;
    const p = PRESETS[this.presetIndex]!;
    this.lighting.apply(p);
    this.applyFog();
    this.headlightsOn = p.headlights;
  }

  private applyFog(): void {
    const fog = this.scene.fog as THREE.FogExp2;
    const p = this.lighting.preset;
    if (this.thermal) {
      fog.color.setRGB(0.02, 0.02, 0.02);
      fog.density = p.fogDensity * 0.5;
    } else {
      fog.color.copy(this.lighting.fogColor);
      fog.density = p.fogDensity;
    }
    const pr = this.pipeline.renderer.getPixelRatio();
    this.effects.setLighting(this.lighting.exposure, this.lighting.ambient, this.lighting.sunColor, fog.color, fog.density, (window.innerHeight * pr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360)));
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    this.clearBattle();
    this.player = new Tank(PLAYER_TANK, 'player', 'west', 7);
    this.scene.add(this.player.model.root);
    this.player.place(PLAYER_SPAWN.x, PLAYER_SPAWN.z, PLAYER_SPAWN.yaw, this.world);
    this.player.engineVoice = this.audio.createEngine(true, this.player.pos);
    this.tanks.push(this.player);
    this.camYaw = PLAYER_SPAWN.yaw + Math.PI;
    this.camPitch = 0.02;
    this.sight = false;
    this.wave = 0;
    this.score = 0;
    this.time = 0;
    this.world.terrain.warm(this.player.pos);
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
    this.effects.clear();
    this.world.decals.clear();
    this.lockTarget = null;
    this.lasedRange = null;
  }

  private setState(s: GameState): void {
    this.state = s;
    this.onStateChange(s);
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
        if (this.world.buildings.some((b) => Math.hypot(b.x - x, b.z - z) < 25)) continue;
        if (this.tanks.some((t) => Math.hypot(t.pos.x - x, t.pos.z - z) < 40)) continue;
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
    this.hud.setWave(`FALA ${this.wave} · wrogów: ${count}`);
    this.hud.message(`Fala ${this.wave}: ${count} czołgów wroga`, 'info');
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

    const fwd = (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0);
    const right = (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0);
    p.throttle = fwd * (inp.isDown('ShiftLeft') && !this.sight ? 0.45 : 1);
    p.steer = right;
    if (inp.isDown('Space')) p.throttle = 0; // hand brake / short halt

    if (inp.wasPressed('Digit1')) p.selectAmmo('APFSDS');
    if (inp.wasPressed('Digit2')) p.selectAmmo('HEAT');
    if (inp.wasPressed('Digit3')) p.selectAmmo('HE');
    if (inp.wasPressed('KeyF')) {
      if (p.extinguish()) this.hud.message('Pożar ugaszony', 'good');
    }
    if (inp.wasPressed('KeyL')) this.headlightsOn = !this.headlightsOn;
    if (inp.wasPressed('KeyV') || inp.wasClicked(2)) this.toggleSight();
    if (inp.wasPressed('KeyN')) {
      this.thermal = !this.thermal;
      G.uThermal.value = this.thermal ? 1 : 0;
      this.pipeline.thermalOn = this.thermal;
      this.applyFog();
      this.audio.uiBeep(this.thermal ? 880 : 660);
    }
    this.freeLook = inp.isDown('KeyC');

    const fovRad = (this.camera.fov * Math.PI) / 180;
    const sens = 0.0022 * this.sensitivity * (this.sight ? fovRad / 1.05 : 1);
    if (this.sight) {
      this.sightYaw -= inp.mouseDX * sens;
      this.sightPitch = Math.max(-0.26, Math.min(0.4, this.sightPitch - inp.mouseDY * sens));
      if (inp.wheel !== 0) {
        this.zoomIdx = Math.max(0, Math.min(this.zooms.length - 1, this.zoomIdx - inp.wheel));
      }
    } else {
      this.camYaw -= inp.mouseDX * sens;
      this.camPitch = Math.max(-0.75, Math.min(0.5, this.camPitch - inp.mouseDY * sens));
      if (inp.wheel !== 0) this.camDist = Math.max(7, Math.min(24, this.camDist + inp.wheel * 1.5));
    }
    if (inp.wasPressed('KeyR')) this.lase();
    if (inp.wasClicked(0) || inp.wasPressed('Enter')) this.playerFire();
    void dt;
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

    // player's aim → turret demand (stabilised)
    if (p.alive && !this.freeLook) {
      p.muzzlePosition(_m);
      aimDirection(p.ammoSpec, _m, this.aimPoint, _dir);
      p.aimDir.set(_dir.x, _dir.y, _dir.z);
    }
    for (const ai of this.ais) ai.update(dt, this.world, p, this.time, (t) => this.fireTank(t));
    for (const t of this.tanks) t.step(dt, this.world);
    this.collideTanks();
    this.projectiles.update(dt, this.world, this.tanks, this.camera.position, (e) => this.onImpact(e), (pos) => this.audio.crack(pos));
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
            const d = Math.hypot(ddx, ddz);
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
    const byPlayer = sh.owner === this.player;
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
        this.lastHitFrom.copy(sh.owner.pos);
        this.effects.shake = Math.max(this.effects.shake, pen ? 1 : 0.5);
        const txt = rep.outcome === 'ricochet' ? 'Rykoszet od pancerza' : rep.outcome === 'nopen' ? 'Trafienie — pancerz wytrzymał' : rep.outcome === 'track' ? 'Zerwana gąsienica!' : 'PRZEBICIE!';
        const mods = rep.modules.length ? ` · ${rep.modules.map((m) => MOD_PL[m]).join(', ')}` : '';
        this.hud.message(`${txt}${mods}${rep.fire ? ' · POŻAR' : ''}`, pen ? 'bad' : 'info');
      }
      return;
    }
    const explosive = ammo.id === 'HE' ? 1 : ammo.id === 'HEAT' ? 0.5 : 0;
    if (e.kind === 'water') {
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
    for (const t of this.tanks) t.interpolate(alpha);
    // own gun and turret would fill the gunner's view: hide them in the sight (shadows too, acceptable)
    const inSight = this.sight && p.alive;
    p.model.gun.visible = !inSight;
    for (const c of p.model.turret.children) if (c !== p.model.gun && (c as THREE.Mesh).isMesh) c.visible = !inSight;
    // camera
    if (this.sight && p.alive) {
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

    // aim point
    const origin = this.sight ? p.sightPosition(_v) : cam.position;
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

    // lighting follows the action
    this.lighting.follow(this.sight ? this.aimPoint.clone().lerp(p.pos, 0.85) : p.pos);
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
        if (seen || (e.alive && this.time - e.lastShotTime < 4 && d < 1800)) this.spotted.add(e);
        else if (!e.alive || d > 2600) this.spotted.delete(e);
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
    const ammo = p.ammoSpec;
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
    return {
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
