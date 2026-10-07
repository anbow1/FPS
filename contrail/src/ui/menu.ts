import type { AircraftId } from '../config.ts';
import type { PresetId } from '../render/lighting.ts';
import type { Difficulty } from '../sim/opponent.ts';
import { type ControlSettings, saveControls } from './settings.ts';

// The start menu: game mode, your aircraft, the opponent's, difficulty and
// time of day (brief: "Duel — choose your aircraft and the opponent's").
// Shown before the world loads, so the choice decides what is built. URL
// parameters pre-select (and `?autostart` or `?spawn=` skip the menu, for the
// headless checks).

export type GameMode = 'free' | 'duel' | 'intercept' | 'landing';

export interface GameOptions {
  mode: GameMode;
  player: AircraftId;
  opponent: AircraftId;
  difficulty: Difficulty;
  time: PresetId;
  /** Free flight only: start airborne at this altitude (m) instead of on the runway (?spawn=air&alt=). */
  airStartM: number | null;
}

export function optionsFromParams(params: URLSearchParams): GameOptions {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = params.get(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  };
  const player = pick('ac', ['wraith', 'talon'] as const, 'wraith');
  return {
    mode: pick('mode', ['free', 'duel', 'intercept', 'landing'] as const, params.has('spawn') ? 'free' : 'duel'),
    player,
    opponent: pick('vs', ['wraith', 'talon'] as const, player === 'wraith' ? 'talon' : 'wraith'),
    difficulty: pick('ai', ['easy', 'normal', 'hard'] as const, 'normal'),
    time: pick('time', ['morning', 'noon', 'dusk'] as const, 'noon'),
    airStartM: params.get('spawn') === 'air' ? Number(params.get('alt') ?? 1500) : null,
  };
}

/** Shows the menu and resolves with the player's choice. */
export function chooseOptions(parent: HTMLElement, initial: GameOptions, controls: ControlSettings, touch: boolean): Promise<GameOptions> {
  const o = { ...initial };
  const root = document.createElement('div');
  root.className = 'menu';
  const card = document.createElement('div');
  card.className = 'menu-card';
  root.append(card);
  card.innerHTML = '<h1>CONTRAIL</h1><p>A stealth fighter and a heavy twin-engine fighter, one physical sky.</p>';
  const row = <K extends keyof GameOptions>(label: string, key: K, choices: [GameOptions[K], string][]): void => {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('span');
    l.textContent = label;
    r.append(l);
    const buttons: HTMLButtonElement[] = [];
    for (const [value, text] of choices) {
      const b = document.createElement('button');
      b.textContent = text;
      b.className = o[key] === value ? 'on' : '';
      b.addEventListener('click', () => {
        o[key] = value;
        for (const x of buttons) x.className = x === b ? 'on' : '';
      });
      buttons.push(b);
      r.append(b);
    }
    card.append(r);
  };
  row('Mode', 'mode', [
    ['duel', 'Duel'],
    ['intercept', 'Intercept'],
    ['landing', 'Landing'],
    ['free', 'Free flight'],
  ]);
  row('You fly', 'player', [
    ['wraith', 'V-17 Wraith'],
    ['talon', 'K-27 Talon'],
  ]);
  row('Opponent', 'opponent', [
    ['talon', 'K-27 Talon'],
    ['wraith', 'V-17 Wraith'],
  ]);
  row('AI', 'difficulty', [
    ['easy', 'Easy'],
    ['normal', 'Normal'],
    ['hard', 'Hard'],
  ]);
  row('Sky', 'time', [
    ['morning', 'Clear morning'],
    ['noon', 'Broken cloud'],
    ['dusk', 'Dusk overcast'],
  ]);
  // Control preferences: two-way toggles on the shared settings object (saved on FLY).
  const toggle = (label: string, key: keyof ControlSettings, onText: string, offText: string): void => {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('span');
    l.textContent = label;
    r.append(l);
    const on = document.createElement('button');
    const off = document.createElement('button');
    on.textContent = onText;
    off.textContent = offText;
    const paint = (): void => {
      on.className = controls[key] ? 'on' : '';
      off.className = controls[key] ? '' : 'on';
    };
    on.addEventListener('click', () => ((controls[key] = true), paint()));
    off.addEventListener('click', () => ((controls[key] = false), paint()));
    paint();
    r.append(on, off);
    card.append(r);
  };
  const what = touch ? 'Thumb' : 'Mouse';
  toggle('Pitch', 'invertPitch', `${what} up = nose up`, `${what} up = nose down`);
  if (touch) toggle('Tilt', 'tilt', 'Steer by tilting', 'Off');
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = 'FLY';
  card.append(go);
  const keys = document.createElement('div');
  keys.className = 'keys';
  keys.innerHTML = touch
    ? 'Left thumb: stick (springs back; pitch sense above). Tilt: hold the phone like a yoke, CAL sets hands-off. Left edge: throttle, top fifth = afterburner. Right: fire, weapon, lock, radar, flares, chaff, camera, gear.'
    : 'Mouse or W/S A/D: stick · Q/E: rudder · Shift/Ctrl or wheel: throttle (again at 100 % = afterburner)<br>Fire: mouse / Space · X weapon · V lock · R radar mode · , . range · PgUp/PgDn antenna · F flares · Z chaff<br>C camera (chase, cockpit, orbit, padlock, missile) · G gear · B brakes · L limiter · K sky · H data · O quality';
  card.append(keys);
  parent.append(root);
  return new Promise((resolve) => {
    go.addEventListener('click', () => {
      saveControls(controls);
      root.remove();
      resolve(o);
    });
  });
}
