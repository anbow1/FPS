import { FixedLoop } from '../core/loop.ts';
import { LagoonControls } from './app/controls.ts';
import { LagoonAudio } from './audio/lagoonAudio.ts';
import { TIME_ORDER, type TimeOfDayId, WEATHER_ORDER, type WeatherId } from './config.ts';
import { emptyIntent, LagoonGame, type LagoonIntent } from './game/game.ts';
import { LagoonView, type Progress } from './render/view.ts';
import { Hud } from './ui/hud.ts';
import { type LagoonSettings, loadSettings, Menus } from './ui/menus.ts';

// Entry point: title → loading → play ⇄ pause / inventory. The fixed update
// order lives in LagoonGame.step; this file wires input, logic, render, HUD
// and audio, and owns nothing else.

type State = 'loading' | 'ready' | 'playing' | 'paused';

interface DebugHooks {
  game: LagoonGame | null;
  view: LagoonView | null;
  stats: Record<string, number | string>;
  /** Screenshot scripts freeze the picture once enough frames have settled (TAA, exposure). */
  freeze: boolean;
  frames: number;
  /** Test scripts queue one intent editor per fixed step (only with ?autostart); `'freeze'` stops the picture there. */
  script: (((i: LagoonIntent, game: LagoonGame) => void) | 'freeze')[];
}

class App {
  private readonly controls: LagoonControls;
  private view: LagoonView | null = null;
  private game: LagoonGame | null = null;
  private audio: LagoonAudio | null = null;
  private state: State = 'loading';
  private readonly loop: FixedLoop;
  private readonly canvas: HTMLCanvasElement;
  private readonly hud: Hud;
  private readonly menus: Menus;
  private settings: LagoonSettings;
  private pendingTime: TimeOfDayId | null = null;
  private pendingWeather: WeatherId | null = null;
  private readonly stats: HTMLElement;
  private fpsAvg = 60;
  readonly debug: DebugHooks = { game: null, view: null, stats: {}, freeze: false, frames: 0, script: [] };
  scripted = false;

  constructor() {
    this.canvas = byId<HTMLCanvasElement>('view');
    this.settings = loadSettings();
    this.controls = new LagoonControls(document.body);
    this.applyControlSettings();
    this.hud = new Hud(byId('hud'));
    this.hud.visible = false;
    this.stats = byId('stats');
    this.menus = new Menus(byId('ui'), this.settings, {
      onResume: () => this.controls.input.requestLock(),
      onTime: (id) => {
        this.pendingTime = id;
      },
      onWeather: (id) => {
        this.pendingWeather = id;
      },
      onSettings: (s) => this.applySettings(s),
    });
    this.loop = new FixedLoop({ step: (dt) => this.step(dt), render: (alpha, frame) => this.render(alpha, frame) });
    this.controls.input.onLockChange = (locked) => {
      if (locked && (this.state === 'ready' || this.state === 'paused')) this.play();
      else if (!locked && this.state === 'playing') this.pause();
    };
    document.body.addEventListener('click', () => {
      if (this.state === 'ready' || this.state === 'paused') {
        this.audio ??= new LagoonAudio();
        this.audio.setVolume(this.settings.volume);
        this.audio.resume();
        this.controls.input.requestLock();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') this.stats.classList.toggle('on');
    });
    window.addEventListener('resize', () => this.view?.resize());
  }

  private applyControlSettings(): void {
    this.controls.sensitivity = this.settings.sensitivity;
    this.controls.invertY = this.settings.invertY;
  }

  private applySettings(s: LagoonSettings): void {
    const rebuild = s.quality !== this.settings.quality || s.toneMap !== this.settings.toneMap;
    this.settings = s;
    this.applyControlSettings();
    this.audio?.setVolume(s.volume);
    if (rebuild && this.view) this.view.stage.applySettings({ quality: s.quality, renderScale: 1, toneMap: s.toneMap });
  }

  async start(time: TimeOfDayId, weather: WeatherId): Promise<void> {
    this.state = 'loading';
    const game = new LagoonGame(20260927, time, weather);
    this.game = game;
    const progress: Progress = async (label, f) => {
      this.menus.showLoading(label, f);
      await nextFrame();
    };
    this.view = await LagoonView.create(this.canvas, game, { quality: this.settings.quality, renderScale: 1, toneMap: this.settings.toneMap }, progress, async () => {});
    // Warm-up frames behind the title: the post chain and shadow passes compile on first use.
    this.menus.showLoading('Warming up', 0.97);
    for (let i = 0; i < 2; i++) {
      this.view.render(game, 1, 0, 0, 0);
      await nextFrame();
    }
    this.debug.game = game;
    this.debug.view = this.view;
    this.menus.showReady();
    this.state = 'ready';
    this.loop.start();
  }

  private play(): void {
    this.state = 'playing';
    this.menus.hideTitle();
    this.menus.hidePause();
    this.hud.visible = true;
  }

  private pause(): void {
    this.state = 'paused';
    const env = this.game?.env;
    this.menus.showPause(this.pendingTime ?? env?.timeId ?? 'noon', this.pendingWeather ?? env?.weatherId ?? 'clear');
  }

  private step(dt: number): void {
    const game = this.game;
    const view = this.view;
    if (!game || !view || this.debug.freeze) return;
    const playing = this.state === 'playing';
    if (!playing && !this.scripted && this.pendingTime === null && this.pendingWeather === null) return;
    const inventory = this.menus.inventoryOpen;
    const input = this.controls.input;
    if (playing && input.pressed('inventory')) this.menus.toggleInventory(game.inventory);
    const intent = playing ? this.controls.buildIntent(!inventory) : emptyIntent();
    if (this.scripted && this.debug.script.length > 0) {
      const next = this.debug.script.shift();
      if (next === 'freeze') {
        this.debug.freeze = true;
        return;
      }
      next?.(intent, game);
    }
    intent.setTime = this.pendingTime;
    intent.setWeather = this.pendingWeather;
    this.pendingTime = null;
    this.pendingWeather = null;
    if (playing || this.scripted) game.step(intent, dt);
    else {
      // Paused: apply menu choices so the world behind the menu changes, but do not advance play.
      if (intent.setTime) game.env.setTime(intent.setTime);
      if (intent.setWeather) game.env.setWeather(intent.setWeather);
    }
    input.endStep();
    const events = game.events.drain();
    view.handleEvents(events, game);
    for (const e of events) {
      this.hud.handle(e);
      this.audio?.handle(e, game);
      if (e.type === 'itemGained' && this.menus.inventoryOpen) this.menus.renderInventory(game.inventory);
    }
  }

  private render(alpha: number, frameSeconds: number): void {
    const game = this.game;
    const view = this.view;
    if (!game || !view || this.debug.freeze) return;
    this.debug.frames++;
    // Paused: keep the environment moving behind the menu so time/weather choices are visible.
    if (this.state === 'paused') game.env.step(frameSeconds, game.rng, game.events);
    if (this.state === 'playing') this.controls.readMouse(game.equipment.adsBlend, !this.menus.inventoryOpen);
    view.stage.renderer.info.reset();
    view.render(game, alpha, frameSeconds, this.controls.pendingYawRad, this.controls.pendingPitchRad);
    this.hud.update(game, frameSeconds);
    const cam = view.stage.camera;
    const fwd = { x: -Math.sin(cam.rotation.y) * Math.cos(cam.rotation.x), y: Math.sin(cam.rotation.x), z: -Math.cos(cam.rotation.y) * Math.cos(cam.rotation.x) };
    this.audio?.update(game, cam.position, fwd, frameSeconds);
    this.updateStats(frameSeconds, view);
  }

  private updateStats(frameSeconds: number, view: LagoonView): void {
    if (frameSeconds > 0) this.fpsAvg += (1 / frameSeconds - this.fpsAvg) * 0.05;
    const info = view.stage.renderer.info.render;
    const s = this.debug.stats;
    s.fps = Math.round(this.fpsAvg);
    s.drawCalls = info.drawCalls;
    s.triangles = info.triangles;
    s.ev = +view.adaptedEv.toFixed(2);
    s.backend = view.stage.backendName;
    if (this.stats.classList.contains('on')) this.stats.textContent = `${s.fps} fps · ${s.backend}\ndraw calls ${s.drawCalls} · ${(info.triangles / 1e6).toFixed(2)} M tris\nEV100 ${s.ev}`;
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from lagoon.html`);
  return el as T;
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

const app = new App();
const params = new URLSearchParams(location.search);
if (params.has('debug') || params.has('autostart')) (window as unknown as { __lagoon: DebugHooks }).__lagoon = app.debug;
const pick = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
  const v = params.get(key);
  return v !== null && (options as readonly string[]).includes(v) ? (v as T) : fallback;
};
// ?autostart runs the world without a pointer lock, for screenshots and tests.
app.scripted = params.has('autostart');
void app.start(pick('time', TIME_ORDER, 'noon'), pick('weather', WEATHER_ORDER, 'clear')).then(() => {
  (window as unknown as { __ready: boolean }).__ready = true;
});
