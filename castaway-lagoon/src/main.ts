import { benchSpots, type BenchSpot, placePlayer } from './app/bench.ts';
import { FixedLoop } from './core/loop.ts';
import { LagoonControls } from './app/controls.ts';
import { LagoonAudio } from './audio/lagoonAudio.ts';
import { TIME_ORDER, type TimeOfDayId, WEATHER_ORDER, type WeatherId } from './config.ts';
import { emptyIntent, LagoonGame, type LagoonIntent } from './game/game.ts';
import { BenchRecorder, type BenchSample, formatBench } from './render/perf.ts';
import { LagoonView, type Progress } from './render/view.ts';
import { Hud } from './ui/hud.ts';
import { type LagoonSettings, loadSettings, Menus } from './ui/menus.ts';
import { TouchControls } from './ui/touch.ts';

// Entry point: title → loading → play ⇄ pause / inventory. The fixed update
// order lives in LagoonGame.step; this file wires input, logic, render, HUD
// and audio, and owns nothing else.

type State = 'loading' | 'ready' | 'playing' | 'paused' | 'bench';

interface DebugHooks {
  game: LagoonGame | null;
  view: LagoonView | null;
  stats: Record<string, number | string>;
  /** Screenshot scripts freeze the picture once enough frames have settled (TAA, exposure). */
  freeze: boolean;
  frames: number;
  /** Test scripts queue one intent editor per fixed step (only with ?autostart); `'freeze'` stops the picture there. */
  script: (((i: LagoonIntent, game: LagoonGame) => void) | 'freeze')[];
  /** Tours the benchmark spots and resolves with one row per spot. */
  bench: (() => Promise<BenchSample[]>) | null;
}

/** Frames to settle at each benchmark spot (streaming, exposure, GPU timer batches), then to record. */
const BENCH_FRAMES = { warm: 45, measure: 120 } as const;

interface BenchRun {
  spots: BenchSpot[];
  index: number;
  warm: number;
  measure: number;
  left: number;
  recorder: BenchRecorder;
  rows: BenchSample[];
  done: (rows: BenchSample[]) => void;
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
  private touch: TouchControls | null = null;
  private fpsAvg = 60;
  readonly debug: DebugHooks = { game: null, view: null, stats: {}, freeze: false, frames: 0, script: [], bench: null };
  private bench: BenchRun | null = null;
  private cpuMsAvg = 0;
  scripted = false;

  constructor() {
    this.canvas = byId<HTMLCanvasElement>('view');
    this.settings = loadSettings();
    // ?q=high|low: test and benchmark runs pick the preset without touching stored settings.
    const q = new URLSearchParams(location.search).get('q');
    if (q === 'high' || q === 'low') this.settings = { ...this.settings, quality: q };
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
      onBenchmark: () => void this.benchmarkFromMenu(),
    });
    this.debug.bench = () => this.runBenchmark();
    this.loop = new FixedLoop({ step: (dt) => this.step(dt), render: (alpha, frame) => this.render(alpha, frame) });
    if (this.controls.input.touch) {
      this.touch = new TouchControls(this.controls.input, {
        stick: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft' },
        lookScale: 1.4,
        buttons: [
          { code: 'Mouse0', label: 'FIRE', col: 0, row: 0, big: true },
          { code: 'KeyE', label: 'USE', col: 0, row: 1.45, mode: 'tap' },
          { code: 'Mouse2', label: 'AIM', col: 1.45, row: 0, mode: 'toggle' },
          { code: 'Space', label: 'JUMP', col: 1.45, row: 1.45, mode: 'tap' },
          { code: 'KeyC', label: 'DIVE', col: 2.45, row: 1.45 },
          { code: 'KeyR', label: 'R', col: 2.45, row: 0, mode: 'tap' },
          { code: 'KeyI', label: 'BAG', col: 3.45, row: 0, mode: 'tap' },
          { code: 'Digit1', label: 'AK', col: 0, row: 3.2, mode: 'tap' },
          { code: 'Digit2', label: 'KNIFE', col: 1, row: 3.2, mode: 'tap' },
          { code: 'Digit3', label: 'STONE', col: 2, row: 3.2, mode: 'tap' },
          { code: 'Digit4', label: 'WOOD', col: 5.2, row: 3.2, mode: 'tap' },
          { code: 'KeyT', label: 'WX', col: 3.2, row: 3.2, mode: 'tap' },
          { code: 'KeyN', label: 'TIME', col: 4.2, row: 3.2, mode: 'tap' },
        ],
      });
    }
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
    if (this.view && !this.bench) this.view.stage.governor.enabled = s.adaptive;
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
    this.menus.showLoading('Preparing shaders', 0.96);
    this.debug.view = this.view; // test scripts can watch the warm-up itself
    await nextFrame();
    await this.view.warmUp(game);
    this.menus.showLoading('Warming up', 0.98);
    for (let i = 0; i < 2; i++) {
      this.view.render(game, 1, 0, 0, 0);
      await nextFrame();
    }
    this.debug.game = game;
    this.debug.view = this.view;
    this.view.stage.governor.enabled = this.settings.adaptive;
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
    if (!game || !view || this.debug.freeze || this.bench) return;
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
    const t0 = performance.now();
    view.render(game, alpha, frameSeconds, this.controls.pendingYawRad, this.controls.pendingPitchRad);
    const cpuMs = performance.now() - t0;
    this.cpuMsAvg += (cpuMs - this.cpuMsAvg) * 0.05;
    if (this.bench) this.benchFrame(frameSeconds, cpuMs, view, game);
    else if (this.state === 'playing' && !document.hidden) view.stage.governor.update(frameSeconds);
    this.hud.update(game, frameSeconds);
    this.touch?.update();
    const cam = view.stage.camera;
    const fwd = { x: -Math.sin(cam.rotation.y) * Math.cos(cam.rotation.x), y: Math.sin(cam.rotation.x), z: -Math.cos(cam.rotation.y) * Math.cos(cam.rotation.x) };
    this.audio?.update(game, cam.position, fwd, frameSeconds);
    this.updateStats(frameSeconds, view);
  }

  private async benchmarkFromMenu(): Promise<void> {
    this.menus.hidePause();
    const rows = await this.runBenchmark();
    this.menus.showBenchmark(formatBench(this.benchTitle(), rows), () => this.pause());
  }

  private benchTitle(): string {
    return `Castaway Lagoon · ${this.settings.quality} · ${this.view?.stage.backendName ?? ''} · ${this.canvas.width}×${this.canvas.height} px`;
  }

  /**
   * Visits every benchmark spot with logic paused and the governor off, and restores the
   * player afterwards. Rendering keeps running from the normal loop.
   */
  runBenchmark(): Promise<BenchSample[]> {
    const game = this.game;
    const view = this.view;
    if (!game || !view || this.bench) return Promise.resolve([]);
    const spots = benchSpots(game);
    const p = game.player;
    const saved = { x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yawRad, pitch: p.pitchRad, state: this.state };
    const params = new URLSearchParams(location.search);
    const warm = Number(params.get('benchWarm')) || BENCH_FRAMES.warm;
    const measure = Number(params.get('benchFrames')) || BENCH_FRAMES.measure;
    view.stage.governor.enabled = false;
    view.stage.governor.update(0);
    this.state = 'bench';
    const first = spots[0];
    if (first) placePlayer(game, first);
    return new Promise((resolve) => {
      this.bench = {
        spots,
        index: 0,
        warm,
        measure,
        left: warm,
        recorder: new BenchRecorder(),
        rows: [],
        done: (rows) => {
          placePlayer(game, { name: 'restore', x: saved.x, y: saved.y, z: saved.z, yawRad: saved.yaw, pitchRad: saved.pitch });
          view.stage.governor.enabled = this.settings.adaptive;
          this.state = saved.state;
          console.log(JSON.stringify({ benchmark: this.benchTitle(), rows }));
          resolve(rows);
        },
      };
    });
  }

  private benchFrame(frameSeconds: number, cpuMs: number, view: LagoonView, game: LagoonGame): void {
    const run = this.bench;
    if (!run) return;
    const spot = run.spots[run.index];
    if (!spot) {
      this.bench = null;
      run.done(run.rows);
      return;
    }
    if (run.left > 0) {
      run.left--;
      return;
    }
    const info = view.stage.renderer.info.render;
    run.recorder.frame(frameSeconds, cpuMs, info.drawCalls, info.triangles);
    if (run.recorder.frames < run.measure) return;
    run.rows.push(run.recorder.finish(spot.name, view.stage.passTimer));
    run.index++;
    run.recorder = new BenchRecorder();
    run.left = run.warm;
    const next = run.spots[run.index];
    if (next) placePlayer(game, next);
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
    s.cpuFrameMs = +this.cpuMsAvg.toFixed(2);
    s.gpuMs = view.stage.passTimer.hasGpuTimes ? +view.stage.passTimer.gpuTotalMs.toFixed(2) : 'n/a';
    s.governor = view.stage.governorLabel;
    if (!this.stats.classList.contains('on')) return;
    const gpu = view.stage.passTimer.summary() || 'GPU timing: n/a on this backend';
    this.stats.textContent = `${s.fps} fps · ${(1000 / Math.max(1, this.fpsAvg)).toFixed(1)} ms frame · res ${s.governor}${this.settings.adaptive ? ' (adaptive)' : ''} · ${s.backend}\nCPU ${s.cpuFrameMs} ms: ${view.cpu.summary()}\n${gpu}\ndraw calls ${s.drawCalls} · ${(info.triangles / 1e6).toFixed(2)} M tris\nEV100 ${s.ev}`;
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
void app.start(pick('time', TIME_ORDER, 'noon'), pick('weather', WEATHER_ORDER, 'clear')).then(async () => {
  (window as unknown as { __ready: boolean }).__ready = true;
  // ?bench: tour the spots right away and leave the rows for the script (scripts/benchView.mjs).
  if (params.has('bench')) (window as unknown as { __bench: BenchSample[] }).__bench = await app.runBenchmark();
});
