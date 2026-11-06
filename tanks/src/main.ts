import { loadGroundPhotos } from './render/photoGround';
import * as THREE from 'three/webgpu';
import { PHYS_DT, QUALITY } from './config';
import { Input } from './core/input';
import { Audio } from './game/audio';
import { Game, type GameState } from './game/game';
import { ATMO } from './render/atmosphere';
import { benchSpots } from './game/bench';
import { loadTankModels } from './game/importedTank';
import { loadSoldierCast } from './render/soldierCast';
import { BenchRecorder, type BenchSample, formatBench } from './render/benchRecorder';
import { PRESETS } from './render/lighting';
import { Pipeline } from './render/pipeline';
import { Hud } from './ui/hud';
import { quitGame } from './ui/quit';
import { isTouchDevice, TouchControls } from './ui/touch';
import { World } from './world/world';
import { PLAYER_SPAWN } from './world/layout';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const menu = $('menu');
const gameover = $('gameover');
const playBtn = $<HTMLButtonElement>('btn-play');
const status = $('status');
const qualitySel = $<HTMLSelectElement>('set-quality');
const lightSel = $<HTMLSelectElement>('set-light');
const toneSel = $<HTMLSelectElement>('set-tone');
const sensIn = $<HTMLInputElement>('set-sens');
const volIn = $<HTMLInputElement>('set-vol');
const evIn = $<HTMLInputElement>('set-ev');

// Per-viewer conveniences only; the game works without storage.
const settings = (() => {
  try {
    return JSON.parse(localStorage.getItem('tanks.settings') ?? '{}') as Record<string, string>;
  } catch {
    return {} as Record<string, string>;
  }
})();
const save = () => {
  try {
    localStorage.setItem('tanks.settings', JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
};

for (const [i, p] of PRESETS.entries()) {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = p.label;
  lightSel.append(o);
}
qualitySel.value = settings.quality ?? (isTouchDevice() || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 6) ? 'low' : 'high');
// ?q=high|low: benchmark runs pick the preset without touching stored settings.
const qParam = new URLSearchParams(location.search).get('q');
if (qParam === 'high' || qParam === 'low') qualitySel.value = qParam;
lightSel.value = settings.light ?? '0';
toneSel.value = settings.tone ?? 'aces';
sensIn.value = settings.sens ?? '1';
volIn.value = settings.vol ?? '0.8';
evIn.value = settings.ev ?? '0.5';

async function boot(): Promise<void> {
  status.textContent = 'Generowanie terenu…';
  await nextFrame();
  const t0 = performance.now();
  const input = new Input(canvas);
  const touch = new TouchControls(input);
  const hud = new Hud();
  const audio = new Audio();
  const quality = QUALITY[qualitySel.value === 'low' ? 'low' : 'high'];
  await loadGroundPhotos();
  const world = new World(20260923, quality);
  status.textContent = 'Kompilowanie shaderów…';
  await nextFrame();
  // the governor's resolution steps change particle sizes in pixels: refresh them when it acts
  let onGovernor = (): void => {};
  const pipeline = new Pipeline(canvas, new THREE.Scene(), new THREE.PerspectiveCamera(), () => onGovernor());
  await pipeline.init();
  const game = new Game(pipeline, world, input, hud, audio, quality.id);
  onGovernor = () => game.refreshPixelScale();
  game.setQuality(quality);
  // The downloaded tanks (shared/vehicles) before the first tank is built; the procedural ones stand in on failure.
  await loadTankModels();
  // The infantry as Field Line's MPFB soldiers (render/soldierCast.ts); none loaded, the procedural men stay.
  game.infantry.useCast(await loadSoldierCast());
  await game.init();
  game.setPreset(Number(lightSel.value));
  pipeline.setToneMapping(toneSel.value === 'agx' ? 'agx' : 'aces');
  pipeline.setExposureComp(Number(evIn.value));
  game.sensitivity = Number(sensIn.value);
  audio.setVolume(Number(volIn.value));
  pipeline.resize();
  // pre-compile every material against the current lights so the first shot does not hitch
  game.start();
  game.pause(true);
  await game.warmup();
  status.textContent = `Gotowe (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
  playBtn.disabled = false;
  playBtn.textContent = 'Graj';

  const governor = pipeline.governor;

  // Benchmark (docs/graphics-playbook.md §9 in anbow1/FPS): the fixed spots of game/bench.ts,
  // each settled for BENCH_WARM frames and recorded for BENCH_FRAMES, with the game paused and the
  // governor at full quality. The same table as Field Line and Castaway Lagoon.
  const params = new URLSearchParams(location.search);
  const BENCH_WARM = Number(params.get('benchWarm')) || 45;
  const BENCH_FRAMES = Number(params.get('benchFrames')) || 120;
  const benchBtn = $<HTMLButtonElement>('btn-bench');
  const benchOut = $('bench-out');
  let bench: { index: number; left: number; recorder: BenchRecorder; rows: BenchSample[]; done: (rows: BenchSample[]) => void } | null = null;
  const spots = benchSpots();
  const benchTitle = () => `Tanks · ${game.quality.id} · ${pipeline.backendName} · ${canvas.width}×${canvas.height} px`;
  const runBenchmark = (): Promise<BenchSample[]> =>
    new Promise((resolve) => {
      if (bench) return resolve([]);
      game.pause(true);
      governor.enabled = false;
      governor.update(0);
      const first = spots[0];
      if (first) game.benchPlace(first.x, first.z, first.yawRad);
      bench = { index: 0, left: BENCH_WARM, recorder: new BenchRecorder(), rows: [], done: resolve };
    });
  const benchFrame = (intervalS: number, cpu: number, calls: number, triangles: number): void => {
    const run = bench;
    if (!run) return;
    const spot = spots[run.index];
    if (!spot) {
      bench = null;
      governor.enabled = true;
      console.log(JSON.stringify({ benchmark: benchTitle(), rows: run.rows }));
      run.done(run.rows);
      return;
    }
    if (run.left > 0) {
      run.left--;
      return;
    }
    run.recorder.frame(intervalS, cpu, calls, triangles);
    if (run.recorder.frames < BENCH_FRAMES) return;
    run.rows.push(run.recorder.finish(spot.name, pipeline.passTimer));
    run.index++;
    run.recorder = new BenchRecorder();
    run.left = BENCH_WARM;
    const next = spots[run.index];
    if (next) game.benchPlace(next.x, next.z, next.yawRad);
  };
  benchBtn.disabled = false;
  benchBtn.onclick = async () => {
    benchBtn.disabled = true;
    menu.style.display = 'none';
    const rows = await runBenchmark();
    // back where a new game starts
    game.benchPlace(PLAYER_SPAWN.x, PLAYER_SPAWN.z, PLAYER_SPAWN.yaw);
    menu.style.display = '';
    benchOut.textContent = formatBench(benchTitle(), rows);
    benchOut.style.display = '';
    benchBtn.disabled = false;
  };

  qualitySel.onchange = () => {
    settings.quality = qualitySel.value;
    save();
    game.setQuality(QUALITY[qualitySel.value === 'low' ? 'low' : 'high']);
    void game.warmup();
    governor.reset();
  };
  lightSel.onchange = () => {
    settings.light = lightSel.value;
    save();
    game.setPreset(Number(lightSel.value));
  };
  toneSel.onchange = () => {
    settings.tone = toneSel.value;
    save();
    pipeline.setToneMapping(toneSel.value === 'agx' ? 'agx' : 'aces');
  };
  evIn.oninput = () => {
    settings.ev = evIn.value;
    save();
    pipeline.setExposureComp(Number(evIn.value));
  };
  sensIn.oninput = () => {
    settings.sens = sensIn.value;
    save();
    game.sensitivity = Number(sensIn.value);
  };
  volIn.oninput = () => {
    settings.vol = volIn.value;
    save();
    audio.setVolume(Number(volIn.value));
  };

  let firstStart = true;
  const resume = () => {
    audio.unlock();
    if (game.state === 'dead') return;
    if (firstStart) {
      firstStart = false;
      // restart so engine voices are created now that audio is unlocked
      game.start();
    }
    game.pause(false);
    input.requestLock();
  };
  playBtn.onclick = resume;
  // "Zakończ grę" in the pause menu: closes the Android app, or the tab (else back to the start)
  const quitBtn = $('btn-quit');
  quitBtn.onclick = () => quitGame(() => window.location.reload());
  canvas.addEventListener('click', () => {
    if (game.state === 'playing' && !input.locked) input.requestLock();
  });
  $('btn-restart').onclick = () => {
    audio.unlock();
    gameover.style.display = 'none';
    game.start();
    input.requestLock();
  };
  document.addEventListener('pointerlockchange', () => {
    if (!input.locked && game.state === 'playing') game.pause(true);
  });

  touch.onPause = () => game.pause(true);
  game.onStateChange = (s: GameState) => {
    menu.style.display = s === 'paused' ? '' : 'none';
    hud.show(s !== 'paused' && s !== 'menu');
    touch.show(s === 'playing' || s === 'intermission');
    if (!firstStart) playBtn.textContent = 'Wznów';
    quitBtn.style.display = firstStart ? 'none' : '';
    if (s === 'dead') {
      setTimeout(() => {
        if (game.state !== 'dead') return;
        input.releaseLock();
        $('go-stats').innerHTML = `Fala: <b>${game.wave}</b><br>Zniszczone czołgi: <b>${game.player.kills}</b><br>Oddane strzały: <b>${game.player.shotsFired}</b><br>Wynik: <b>${game.score}</b>`;
        gameover.style.display = '';
      }, 3500);
    }
  };
  game.onStateChange(game.state);
  window.addEventListener('resize', () => {
    pipeline.resize();
    hud.layout();
  });

  // fixed 60 Hz simulation, render every animation frame
  let last = performance.now();
  let acc = 0;
  let fps = 60;
  let cpuMs = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const frameStart = performance.now();
    const rawDt = (now - last) / 1000;
    const dt = Math.min(0.1, rawDt);
    last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
    if (game.state === 'playing' && !document.hidden) governor.update(rawDt);
    game.handleInput(dt);
    const running = game.state === 'playing' || game.state === 'dead' || game.state === 'intermission';
    if (running) {
      acc += dt;
      let steps = 0;
      while (acc >= PHYS_DT && steps < 5) {
        game.fixedStep(PHYS_DT);
        acc -= PHYS_DT;
        steps++;
      }
      if (steps === 5) acc = 0;
    }
    const renderStart = performance.now();
    const markers = game.frame(running ? dt : 0, running ? acc / PHYS_DT : 1);
    pipeline.render(game.now);
    const info = pipeline.info.render;
    if (bench) benchFrame(rawDt, performance.now() - renderStart, info.drawCalls, info.triangles);
    hud.setExtras({ drone: game.droneMap, infantry: game.spottedInfantry, droneStatus: game.droneStatus });
    hud.allies = game.escort;
    hud.update(dt, game.player, game.rangeInfo.range, game.rangeInfo.lased, game.enemies, game.spottedSet, fps, cpuMs, { calls: info.drawCalls, triangles: info.triangles, scale: pipeline.governorLabel, gpu: pipeline.passTimer.summary(), backend: pipeline.backendName }, game.quality.id, markers);
    input.endFrame();
    cpuMs += (performance.now() - frameStart - cpuMs) * 0.05;
  };
  requestAnimationFrame(loop);
  (window as unknown as { __game: Game; __atmo: typeof ATMO }).__game = game;
  (window as unknown as { __backend: string }).__backend = pipeline.backendName;
  // ?bench: tour the spots right after loading and leave the rows for scripts/benchView.mjs.
  if (params.has('bench')) (window as unknown as { __bench: BenchSample[] }).__bench = await runBenchmark();
  (window as unknown as { __atmo: typeof ATMO }).__atmo = ATMO;
  // Screenshot scripts revisit the same named views the benchmark uses (game.benchPlace).
  if (params.has('bench') || params.has('debug')) (window as unknown as { __spots: ReturnType<typeof benchSpots> }).__spots = benchSpots();
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

boot().catch((e: unknown) => {
  console.error(e);
  status.textContent = `Błąd: ${e instanceof Error ? e.message : String(e)}`;
});
