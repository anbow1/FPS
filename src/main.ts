import * as THREE from 'three';
import { PHYS_DT, QUALITY } from './config';
import { Input } from './core/input';
import { Audio } from './game/audio';
import { Game, type GameState } from './game/game';
import { PRESETS } from './render/lighting';
import { Pipeline } from './render/pipeline';
import { Hud } from './ui/hud';
import { isTouchDevice, TouchControls } from './ui/touch';
import { World } from './world/world';

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
  const world = new World(20260923, quality);
  status.textContent = 'Kompilowanie shaderów…';
  await nextFrame();
  const pipeline = new Pipeline(canvas, new THREE.Scene(), new THREE.PerspectiveCamera());
  const game = new Game(pipeline, world, input, hud, audio, quality.id);
  game.setQuality(quality);
  game.setPreset(Number(lightSel.value));
  pipeline.setToneMapping(toneSel.value === 'agx' ? 'agx' : 'aces');
  pipeline.setExposureComp(Number(evIn.value));
  game.sensitivity = Number(sensIn.value);
  audio.setVolume(Number(volIn.value));
  pipeline.resize();
  // pre-compile every material against the current lights so the first shot does not hitch
  game.start();
  game.pause(true);
  pipeline.renderer.compile(game.scene, game.camera);
  status.textContent = `Gotowe (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
  playBtn.disabled = false;
  playBtn.textContent = 'Graj';

  qualitySel.onchange = () => {
    settings.quality = qualitySel.value;
    save();
    game.setQuality(QUALITY[qualitySel.value === 'low' ? 'low' : 'high']);
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
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
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
    const markers = game.frame(running ? dt : 0, running ? acc / PHYS_DT : 1);
    pipeline.render(game.now);
    const info = pipeline.info.render;
    hud.setExtras({ drone: game.droneMap, infantry: game.spottedInfantry, droneStatus: game.droneStatus });
    hud.update(dt, game.player, game.rangeInfo.range, game.rangeInfo.lased, game.enemies, game.spottedSet, fps, cpuMs, { calls: info.calls, triangles: info.triangles }, game.quality.id, markers);
    input.endFrame();
    cpuMs += (performance.now() - frameStart - cpuMs) * 0.05;
  };
  requestAnimationFrame(loop);
  (window as unknown as { __game: Game }).__game = game;
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

boot().catch((e: unknown) => {
  console.error(e);
  status.textContent = `Błąd: ${e instanceof Error ? e.message : String(e)}`;
});
