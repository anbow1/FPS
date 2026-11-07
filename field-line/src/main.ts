import { initNavMesh } from './game/navMesh.ts';
import { benchSpots, type BenchSpot, placePlayer } from './app/bench.ts';
import { Controls } from './app/controls.ts';
import { loadSettings, type Settings, saveSettings } from './app/settings.ts';
import { Audio, type Listener } from './audio/audio.ts';
import type { LightingPresetId } from './config.ts';
import { Input } from './core/input.ts';
import { FixedLoop } from './core/loop.ts';
import { directionFromYawPitch, Vec3 } from './core/vec.ts';
import { Game, type GameIntent } from './game/game.ts';
import type { ModeId } from './game/modes.ts';
import { buildMap } from './maps/index.ts';
import type { MapId } from './maps/types.ts';
import { BenchRecorder, type BenchSample, formatBench } from './render/perf.ts';
import { GameView } from './render/view.ts';
import { Hud } from './ui/hud.ts';
import { Menu } from './ui/menu.ts';
import { TouchControls } from './ui/touch.ts';

// Entry point: menu → loading → play ⇄ pause → results. One fixed update order
// lives in Game.step; this file only wires input, logic, render, HUD and audio.

type State = 'menu' | 'loading' | 'ready' | 'playing' | 'paused' | 'over' | 'bench';

interface DebugHooks {
  game: Game | null;
  view: GameView | null;
  /** Lets a test script drive the player without a pointer lock. */
  intent: ((i: GameIntent, game: Game) => void) | null;
  stats: Record<string, number | string>;
  /** Tours the benchmark spots and resolves with one row per spot. */
  bench: (() => Promise<BenchSample[]>) | null;
  /** The spots of the last tour, so screenshot scripts can return to them. */
  spots: BenchSpot[];
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
  private readonly input: Input;
  private readonly controls: Controls;
  private settings: Settings;
  private readonly menu: Menu;
  private readonly hud: Hud;
  private audio: Audio | null = null;
  private view: GameView | null = null;
  private game: Game | null = null;
  private state: State = 'menu';
  private readonly loop: FixedLoop;
  private canvas: HTMLCanvasElement;
  private readonly statsEl = document.createElement('div');
  private readonly hintEl = document.createElement('div');
  private touch: TouchControls | null = null;
  private overTimer = 0;
  private stepMsAvg = 0;
  private frameMsAvg = 0;
  private readonly listener: Listener = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };
  readonly debug: DebugHooks = { game: null, view: null, intent: null, stats: {}, bench: null, spots: [] };
  private bench: BenchRun | null = null;

  constructor() {
    this.canvas = byId<HTMLCanvasElement>('view');
    this.input = new Input(document.body);
    this.controls = new Controls(this.input);
    this.settings = loadSettings();
    this.hud = new Hud(byId('hud'));
    byId('hud').classList.add('hidden');
    this.menu = new Menu(byId('ui'), this.input, this.settings, {
      onStart: (s) => void this.start(s),
      onResume: () => this.resume(),
      onQuit: () => this.quit(),
      onBenchmark: () => void this.benchmarkFromMenu(),
      onSettingsChanged: (s) => void this.applySettings(s),
    });
    this.statsEl.className = 'stats';
    this.hintEl.className = 'hint';
    this.hintEl.style.display = 'none';
    document.body.append(this.statsEl, this.hintEl);
    if (this.input.touch) {
      this.touch = new TouchControls(this.input, {
        stick: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft' },
        lookScale: 1.4,
        buttons: [
          { code: 'Mouse0', label: 'FIRE', col: 0, row: 0, big: true },
          { code: 'Mouse2', label: 'AIM', col: 1.45, row: 0, mode: 'toggle' },
          { code: 'Space', label: 'JUMP', col: 0, row: 1.45, mode: 'tap' },
          { code: 'KeyC', label: 'CROUCH', col: 1.45, row: 1.45, mode: 'tap' },
          { code: 'KeyR', label: 'R', col: 2.45, row: 0, mode: 'tap' },
          { code: 'KeyG', label: 'NADE', col: 2.45, row: 1, },
          { code: 'KeyH', label: 'MED', col: 3.45, row: 0, mode: 'tap' },
          { code: 'KeyB', label: 'MODE', col: 3.45, row: 1, mode: 'tap' },
          { code: 'Digit1', label: 'RIFLE', col: 0, row: 3.2, mode: 'tap' },
          { code: 'Digit2', label: 'SNIPE', col: 1, row: 3.2, mode: 'tap' },
          { code: 'Digit3', label: 'PISTOL', col: 2, row: 3.2, mode: 'tap' },
          { code: 'KeyV', label: 'ZOOM', col: 3, row: 3.2, mode: 'tap' },
          { code: 'KeyL', label: 'LIGHT', col: 4, row: 3.2, mode: 'tap' },
        ],
      });
    }
    const maxSteps = Number(new URLSearchParams(location.search).get('maxSteps') ?? 0) || undefined;
    this.loop = new FixedLoop({ step: (dt) => this.step(dt), render: (alpha, frame) => this.render(alpha, frame) }, maxSteps);
    this.input.onLockChange = (locked) => {
      if (locked && (this.state === 'ready' || this.state === 'paused')) this.play();
      else if (!locked && this.state === 'playing') this.pause();
    };
    document.body.addEventListener('click', () => {
      if (this.state === 'ready') this.lockAndPlay();
    });
    window.addEventListener('resize', () => this.view?.resize());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') void this.applySettings({ ...this.settings, showStats: !this.settings.showStats });
    });
    this.debug.bench = () => this.runBenchmark();
  }

  showMenu(): void {
    this.state = 'menu';
    this.menu.showMain();
  }

  private async applySettings(s: Settings): Promise<void> {
    this.settings = s;
    saveSettings(s);
    this.controls.sensitivity = s.sensitivity;
    this.hud.settings.minimal = s.minimalHud;
    this.statsEl.classList.toggle('on', s.showStats);
    if (this.view && !this.bench) this.view.stage.governor.enabled = s.adaptive;
    if (this.view && (this.state === 'paused' || this.state === 'playing')) await this.view.applySettings(this.viewSettings(s));
  }

  private viewSettings(s: Settings): { quality: Settings['quality']; renderScale: number; toneMap: Settings['toneMap']; lens: Settings['lens']; preset: LightingPresetId; wet: boolean; shake: number } {
    return { quality: s.quality, renderScale: s.renderScale, toneMap: s.toneMap, lens: s.lens, preset: s.preset, wet: s.wet, shake: s.shake };
  }

  async start(s: Settings): Promise<void> {
    await this.applySettings(s);
    this.loop.stop();
    this.state = 'loading';
    this.audio ??= new Audio();
    this.audio.resume();
    // A fresh canvas per deployment: the old renderer's context goes with the old element.
    const fresh = document.createElement('canvas');
    fresh.id = 'view';
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this.view?.stage.renderer.dispose();
    this.menu.showLoading('Generating map', 0.02);
    await nextFrame();
    const map = buildMap(s.mapId);
    // Recast's module for the city maps' navigation mesh (game/navMesh.ts), loaded once.
    await initNavMesh();
    const game = new Game(map, s.modeId, Date.now() & 0xffff);
    this.game = game;
    // Each loading stage's start time in the console: which stage a slow device spends its time in.
    const t0 = performance.now();
    let last = t0;
    let lastLabel = 'start';
    const stages: { label: string; s: number }[] = [];
    this.view = await GameView.create(this.canvas, map, this.viewSettings(s), async (label, f) => {
      const now = performance.now();
      console.log(`[load] ${lastLabel}: ${((now - last) / 1000).toFixed(2)} s`);
      stages.push({ label: lastLabel, s: (now - last) / 1000 });
      last = now;
      lastLabel = label;
      this.menu.showLoading(label, f);
      await nextFrame();
    });
    this.view.stage.renderer.info.autoReset = false;
    this.view.stage.governor.enabled = s.adaptive;
    // Two frames behind the loading screen: the post chain and shadow passes compile their
    // pipelines on first use, which compileAsync does not reach. No hitch on the first real frame.
    this.menu.showLoading('Preparing shaders', 0.93);
    await nextFrame();
    const tw = performance.now();
    await this.view.warmUp(game);
    console.log(`[load] warm-up frames (every pipeline shown): ${((performance.now() - tw) / 1000).toFixed(2)} s`);
    this.menu.showLoading('Warming up', 0.97);
    for (let i = 0; i < 2; i++) {
      const tf = performance.now();
      this.view.render(game, 1, 0, 0, 0);
      await nextFrame();
      console.log(`[load] frame ${i + 1}: ${((performance.now() - tf) / 1000).toFixed(2)} s`);
    }
    console.log(`[load] ${lastLabel} → play: ${((performance.now() - last) / 1000).toFixed(2)} s; total ${((performance.now() - t0) / 1000).toFixed(2)} s`);
    stages.push({ label: 'warm-up', s: (performance.now() - last) / 1000 });
    // On a phone the console is out of reach: the pause menu shows the total and the longest stages.
    const longest = [...stages].sort((a, b) => b.s - a.s).slice(0, 4);
    this.menu.loadReport = `Loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${longest.map((x) => `${x.label} ${x.s.toFixed(1)} s`).join(' · ')}`;
    this.audio.setAmbience(map.id, game.wind.length());
    this.debug.game = game;
    this.debug.view = this.view;
    this.overTimer = 0;
    this.menu.hide();
    byId('hud').classList.remove('hidden');
    this.state = 'ready';
    this.hintEl.textContent = 'Click to deploy · Esc pauses';
    this.hintEl.style.display = 'block';
    this.loop.start();
  }

  private lockAndPlay(): void {
    this.audio?.resume();
    this.input.requestLock();
  }

  private play(): void {
    this.state = 'playing';
    this.hintEl.style.display = 'none';
    this.menu.hide();
    this.loop.start();
  }

  private pause(): void {
    this.state = 'paused';
    this.menu.showPause();
  }

  private resume(): void {
    this.lockAndPlay();
  }

  private quit(): void {
    this.loop.stop();
    this.input.exitLock();
    byId('hud').classList.add('hidden');
    this.hintEl.style.display = 'none';
    this.game = null;
    this.debug.game = null;
    this.showMenu();
  }

  private step(dt: number): void {
    const game = this.game;
    const view = this.view;
    if (!game || !view || this.bench) return;
    const scripted = this.debug.intent !== null;
    if (this.state !== 'playing' && !scripted) return;
    const t0 = performance.now();
    this.debug.stats.steps = ((this.debug.stats.steps as number | undefined) ?? 0) + 1;
    const intent = this.controls.buildIntent();
    this.debug.intent?.(intent, game);
    view.beforeStep(game);
    game.step(intent, dt);
    this.input.endStep();
    const events = game.events.drain();
    view.handleEvents(events, game);
    for (const e of events) {
      this.hud.handle(e);
      this.audio?.handle(e, game, this.listener);
    }
    this.stepMsAvg += (performance.now() - t0 - this.stepMsAvg) * 0.05;
  }

  private render(alpha: number, frameSeconds: number): void {
    const game = this.game;
    const view = this.view;
    if (!game || !view) return;
    const t0 = performance.now();
    this.debug.stats.frames = ((this.debug.stats.frames as number | undefined) ?? 0) + 1;
    if (this.state === 'playing') this.controls.readMouse(game);
    view.stage.renderer.info.reset();
    view.render(game, alpha, frameSeconds, this.controls.pendingYawRad, this.controls.pendingPitchRad);
    this.hud.update(game, frameSeconds, window.innerHeight);
    this.touch?.update();
    const cam = view.stage.camera;
    this.listener.position = cam.position;
    directionFromYawPitch(game.weapons.viewYaw(game.player), game.weapons.viewPitch(game.player), _fwd);
    this.listener.forward = _fwd;
    this.audio?.updateListener(this.listener, game.flashAmount);
    const cpuMs = performance.now() - t0;
    this.frameMsAvg += (cpuMs - this.frameMsAvg) * 0.05;
    if (this.bench) this.benchFrame(frameSeconds, cpuMs, view, game);
    else if (this.state === 'playing' && !document.hidden) view.stage.governor.update(frameSeconds);
    this.updateStats(frameSeconds, view);
    if (game.mode.view.finished && this.state === 'playing') {
      this.overTimer += frameSeconds;
      if (this.overTimer > 2) {
        this.state = 'over';
        this.input.exitLock();
        this.menu.showResult(game.mode.view.won, game.mode.view.resultText, game.kills);
      }
    }
  }

  private async benchmarkFromMenu(): Promise<void> {
    const rows = await this.runBenchmark();
    const map = this.game?.map;
    this.state = 'paused';
    this.menu.showBenchmark(this.benchTitle(map?.label ?? '') + '\n' + formatBench('', rows).trimStart());
  }

  private benchTitle(mapLabel: string): string {
    const view = this.view;
    const canvas = this.canvas;
    return `Field Line · ${mapLabel} · ${this.settings.quality} · ${view?.stage.backendName ?? ''} · ${canvas.width}×${canvas.height} px`;
  }

  /**
   * Visits every benchmark spot of the current map with logic paused and the governor off, and
   * restores the player afterwards. Rendering keeps running from the normal loop.
   */
  runBenchmark(): Promise<BenchSample[]> {
    const game = this.game;
    const view = this.view;
    if (!game || !view || this.bench) return Promise.resolve([]);
    const spots = benchSpots(game.map);
    this.debug.spots = spots;
    const p = game.player;
    const saved = { x: p.body.position.x, y: p.body.position.y, z: p.body.position.z, yaw: p.yawRad, pitch: p.pitchRad, state: this.state };
    const params = new URLSearchParams(location.search);
    const warm = Number(params.get('benchWarm')) || BENCH_FRAMES.warm;
    const measure = Number(params.get('benchFrames')) || BENCH_FRAMES.measure;
    view.stage.governor.enabled = false;
    view.stage.governor.update(0);
    this.menu.hide();
    this.state = 'bench';
    const first = spots[0];
    if (first) placePlayer(game, first);
    this.loop.start();
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
          p.body.position.set(saved.x, saved.y, saved.z);
          p.prevPosition.copy(p.body.position);
          p.yawRad = saved.yaw;
          p.pitchRad = saved.pitch;
          view.stage.governor.enabled = this.settings.adaptive;
          this.state = saved.state;
          console.log(JSON.stringify({ benchmark: this.benchTitle(game.map.label), rows }));
          resolve(rows);
        },
      };
    });
  }

  private benchFrame(frameSeconds: number, cpuMs: number, view: GameView, game: Game): void {
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

  private fpsAvg = 60;

  private updateStats(frameSeconds: number, view: GameView): void {
    if (frameSeconds > 0) this.fpsAvg += (1 / frameSeconds - this.fpsAvg) * 0.05;
    const info = view.stage.renderer.info.render;
    const s = this.debug.stats;
    s.fps = Math.round(this.fpsAvg);
    s.cpuFrameMs = +this.frameMsAvg.toFixed(2);
    s.stepMs = +this.stepMsAvg.toFixed(3);
    s.drawCalls = info.drawCalls;
    s.triangles = info.triangles;
    s.ev = +view.adaptedEv.toFixed(2);
    s.backend = view.stage.backendName;
    s.gpuMs = view.stage.passTimer.hasGpuTimes ? +view.stage.passTimer.gpuTotalMs.toFixed(2) : 'n/a';
    s.governor = view.stage.governorLabel;
    if (!this.settings.showStats) return;
    const gpu = view.stage.passTimer.summary() || 'GPU timing: n/a on this backend';
    this.statsEl.textContent = `${s.fps} fps · ${(1000 / Math.max(1, this.fpsAvg)).toFixed(1)} ms frame · res ${s.governor}${this.settings.adaptive ? ' (adaptive)' : ''}\nCPU ${s.cpuFrameMs} ms: ${view.cpu.summary()} · logic ${s.stepMs} ms/step\n${gpu}\ndraw calls ${s.drawCalls} · tris ${(info.triangles / 1e6).toFixed(2)} M\nEV100 ${s.ev} (preset ${view.presetEv}) · ${s.backend}`;
  }
}

const _fwd = new Vec3();

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

const app = new App();
const params = new URLSearchParams(location.search);
if (params.has('debug')) (window as unknown as { __fps: DebugHooks }).__fps = app.debug;
if (params.has('autostart')) {
  // Test and screenshot entry: skip the menu, run without a pointer lock (scripted input only).
  const s = loadSettings();
  const pick = <T extends string>(key: string, fallback: T): T => (params.get(key) as T | null) ?? fallback;
  s.mapId = pick<MapId>('map', s.mapId);
  s.modeId = pick<ModeId>('mode', s.mapId === 'range' ? 'range' : 'skirmish');
  s.preset = pick<LightingPresetId>('light', s.preset);
  s.quality = params.get('q') === 'low' ? 'low' : 'high';
  s.wet = params.has('wet');
  s.lens = params.get('lens') === 'bodycam' ? 'bodycam' : 'standard';
  s.showStats = !params.has('nostats');
  app.debug.intent = () => {};
  void app.start(s).then(async () => {
    document.querySelector<HTMLElement>('.hint')?.style.setProperty('display', 'none');
    (window as unknown as { __ready: boolean }).__ready = true;
    // ?bench: tour the spots right away and leave the rows for the script (scripts/benchView.mjs).
    if (params.has('bench')) (window as unknown as { __bench: BenchSample[] }).__bench = await app.runBenchmark();
  });
} else {
  app.showMenu();
}
