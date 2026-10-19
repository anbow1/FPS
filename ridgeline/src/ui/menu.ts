import type { HeliId } from '../config.ts';
import type { PresetId } from '../render/lighting.ts';
import { type ControlSettings, saveControls } from './settings.ts';

// The start menu: mission, helicopter, time of day, and the control and
// graphics preferences. Shown before the world loads, so the choice decides what
// is built. URL parameters pre-select (and `?autostart` skips the menu, for the
// headless checks).

export type GameMode = 'free';

export interface GameOptions {
  mode: GameMode;
  heli: HeliId;
  time: PresetId;
  /** Start in a hover at this height above the ground (m) instead of on the pad (?spawn=air&alt=). */
  airStartM: number | null;
}

export function optionsFromParams(params: URLSearchParams): GameOptions {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = params.get(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  };
  return {
    mode: 'free',
    heli: pick('heli', ['warden', 'bulat'] as const, 'warden'),
    time: pick('time', ['morning', 'noon', 'dusk', 'rain'] as const, 'noon'),
    airStartM: params.get('spawn') === 'air' ? Number(params.get('alt') ?? 30) : null,
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
  card.innerHTML = '<h1>RIDGELINE</h1><p>An attack helicopter, a rotor that flies like one, and ridges to hide behind.</p>';
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
  row('Mission', 'mode', [['free', 'Free flight']]);
  row('You fly', 'heli', [
    ['warden', 'AH-7 Warden'],
    ['bulat', 'M-38 Bulat'],
  ]);
  row('Sky', 'time', [
    ['morning', 'Clear morning'],
    ['noon', 'Broken cloud'],
    ['dusk', 'Dusk overcast'],
    ['rain', 'Rain'],
  ]);
  // Control preferences: two-way toggles on the shared settings object (saved on FLY).
  const toggle = (label: string, key: 'invertPitch' | 'tilt', onText: string, offText: string): void => {
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
  // The keys never flip (W is always nose down) and the mouse aims: the setting is the thumb stick's.
  if (touch) toggle('Pitch', 'invertPitch', 'Thumb up = nose up', 'Thumb up = nose down');
  if (touch) toggle('Tilt', 'tilt', 'Steer by tilting', 'Off');
  {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('span');
    l.textContent = 'Graphics';
    r.append(l);
    const buttons: HTMLButtonElement[] = [];
    for (const [value, text] of [
      ['high', 'High'],
      ['balanced', 'Balanced'],
      ['fast', 'Fast'],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = text;
      b.className = controls.graphics === value ? 'on' : '';
      b.addEventListener('click', () => {
        controls.graphics = value;
        for (const x of buttons) x.className = x === b ? 'on' : '';
      });
      buttons.push(b);
      r.append(b);
    }
    card.append(r);
  }
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = 'FLY';
  card.append(go);
  const keys = document.createElement('div');
  keys.className = 'keys';
  keys.innerHTML = touch
    ? 'Left thumb: stick — up/down tilts the nose, sideways turns. Left edge: power lever — above the mark climb, below descend, let go to hold the height. ◀ ▶: rotate on the spot.<br>Right thumb: drag the gun cursor. FIRE shoots; WPN steps gun → rockets ×1/×4/×8 → missiles; LSR the laser. TILT steers by tilting the phone (then the right thumb only aims, the left only works the lever); CAL sets hands-off.'
    : 'W / S: nose down (forward) / nose up · A / D: turn · Q / E: rotate on the spot · Shift: climb · Ctrl: descend · neither: hold the height (wheel: a standing climb or descent)<br>Mouse: moves the gun cursor (the aircraft flies on) · left click or Space: fire · right click or L: laser (marks the target for missiles) · middle click or X: cursor back to the centre · R weapon · V rocket ripple 1/4/8<br>T trim · Z SAS · I engines (autorotation practice) · B wheel brakes · C camera (outside, front seat) · H flight data · K sky · O quality · M sound';
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
