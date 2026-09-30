import { TIME_OF_DAY, type TimeOfDayId, TIME_ORDER, WEATHER, WEATHER_ORDER, type WeatherId } from '../config.ts';
import type { Inventory } from '../game/inventory.ts';
import { ITEMS } from '../game/items.ts';
import { isTouchDevice } from '../core/input.ts';
import { escapeHtml } from './hud.ts';
import { ITEM_ICONS, TIME_ICONS, WEATHER_ICONS } from './icons.ts';

// Title and loading screen, the pause menu (time of day, weather, graphics,
// mouse, volume, controls) and the inventory panel. Settings persist in
// localStorage; everything else is live game state.

export interface LagoonSettings {
  quality: 'high' | 'low';
  sensitivity: number;
  invertY: boolean;
  volume: number;
  toneMap: 'aces' | 'agx';
  /** Frame governor: drops sun shafts, then resolution, to hold 60 fps (render/perf.ts). */
  adaptive: boolean;
}

const KEY = 'lagoon.settings.v1';
// Phones and tablets start on Low: the High jungle is sized for a desktop GPU.
const DEFAULTS: LagoonSettings = { quality: isTouchDevice() ? 'low' : 'high', sensitivity: 1, invertY: false, volume: 0.8, toneMap: 'aces', adaptive: true };

export function loadSettings(): LagoonSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return { ...DEFAULTS };
    const o = v as Record<string, unknown>;
    return {
      quality: o.quality === 'low' ? 'low' : 'high',
      sensitivity: typeof o.sensitivity === 'number' && o.sensitivity > 0.1 && o.sensitivity < 5 ? o.sensitivity : 1,
      invertY: o.invertY === true,
      volume: typeof o.volume === 'number' && o.volume >= 0 && o.volume <= 1 ? o.volume : 0.8,
      toneMap: o.toneMap === 'agx' ? 'agx' : 'aces',
      adaptive: o.adaptive !== false,
    };
  } catch (err) {
    console.warn('stored lagoon settings unreadable, using defaults:', err);
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: LagoonSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    console.warn('could not save lagoon settings:', err);
  }
}

const CONTROLS: readonly [string, string][] = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['Shift', 'Sprint'],
  ['Space', 'Jump · swim up'],
  ['C', 'Dive (hold, in deep water)'],
  ['E', 'Interact · pick up · sleep on the cot'],
  ['L', 'Lamp on / off'],
  ['LMB', 'Shoot · slash · throw (hold to wind up)'],
  ['RMB', 'Aim the rifle'],
  ['R', 'Reload'],
  ['1 / 2 / 3 / 4', 'AK-47 · knife · stone · firewood'],
  ['H', 'Empty hands'],
  ['I', 'Inventory'],
  ['T / N', 'Weather · time of day'],
  ['Esc', 'Pause · settings'],
];

export interface MenuCallbacks {
  onResume: () => void;
  onTime: (id: TimeOfDayId) => void;
  onWeather: (id: WeatherId) => void;
  onSettings: (s: LagoonSettings) => void;
  /** Tours the fixed benchmark spots and shows the numbers (app/bench.ts). */
  onBenchmark: () => void;
}

export class Menus {
  private readonly title: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly inventory: HTMLElement;

  constructor(
    root: HTMLElement,
    private settings: LagoonSettings,
    private readonly cb: MenuCallbacks,
  ) {
    root.innerHTML = `<div class="title"></div><div class="pause hidden"></div><div class="inventory hidden"></div>`;
    this.title = root.querySelector('.title') as HTMLElement;
    this.pause = root.querySelector('.pause') as HTMLElement;
    this.inventory = root.querySelector('.inventory') as HTMLElement;
    this.title.innerHTML = `
      <div class="brand"><h1>CASTAWAY LAGOON</h1><p>A hidden bay. A shelter by the beach. Nobody else.</p></div>
      <div class="loading"><div class="bar"><i></i></div><span>Preparing</span></div>
      <div class="start hidden">${isTouchDevice() ? 'Tap' : 'Click'} to begin</div>
      <div class="keys">${controlsTable()}</div>`;
  }

  showLoading(label: string, fraction: number): void {
    (this.title.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
    (this.title.querySelector('.loading span') as HTMLElement).textContent = label;
  }

  showReady(): void {
    this.title.querySelector('.loading')?.classList.add('hidden');
    this.title.querySelector('.start')?.classList.remove('hidden');
  }

  hideTitle(): void {
    this.title.classList.add('gone');
  }

  showPause(time: TimeOfDayId, weather: WeatherId): void {
    const s = this.settings;
    this.pause.classList.remove('hidden');
    this.pause.innerHTML = `
      <div class="panel">
        <h2>Paused</h2>
        <button class="resume">Resume</button>
        <h4>Time of day</h4>
        <div class="seg">${TIME_ORDER.map((id) => `<button data-time="${id}" class="${id === time ? 'sel' : ''}">${TIME_ICONS[id]}<span>${TIME_OF_DAY[id].label}</span></button>`).join('')}</div>
        <h4>Weather</h4>
        <div class="seg">${WEATHER_ORDER.map((id) => `<button data-weather="${id}" class="${id === weather ? 'sel' : ''}">${WEATHER_ICONS[id]}<span>${WEATHER[id].label}</span></button>`).join('')}</div>
        <h4>Settings</h4>
        <div class="row"><label>Graphics</label><div class="seg small"><button data-q="high" class="${s.quality === 'high' ? 'sel' : ''}">High</button><button data-q="low" class="${s.quality === 'low' ? 'sel' : ''}">Low</button></div></div>
        <div class="row"><label>Adaptive res.</label><input type="checkbox" ${s.adaptive ? 'checked' : ''} data-k="adaptive"></div>
        <div class="row"><label>Tone map</label><div class="seg small"><button data-tm="aces" class="${s.toneMap === 'aces' ? 'sel' : ''}">ACES</button><button data-tm="agx" class="${s.toneMap === 'agx' ? 'sel' : ''}">AgX</button></div></div>
        <div class="row"><label>Mouse</label><input type="range" min="0.2" max="3" step="0.05" value="${s.sensitivity}" data-k="sensitivity"></div>
        <div class="row"><label>Invert Y</label><input type="checkbox" ${s.invertY ? 'checked' : ''} data-k="invertY"></div>
        <div class="row"><label>Volume</label><input type="range" min="0" max="1" step="0.02" value="${s.volume}" data-k="volume"></div>
        <div class="row"><label>Performance</label><button class="bench">Benchmark</button></div>
        <details><summary>Controls</summary>${controlsTable()}</details>
      </div>`;
    this.pause.querySelector('.bench')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onBenchmark();
    });
    this.pause.querySelector('.resume')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onResume();
    });
    this.pause.querySelectorAll<HTMLButtonElement>('button[data-time]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onTime(b.dataset.time as TimeOfDayId);
        this.showPause(b.dataset.time as TimeOfDayId, weather);
      }),
    );
    this.pause.querySelectorAll<HTMLButtonElement>('button[data-weather]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onWeather(b.dataset.weather as WeatherId);
        this.showPause(time, b.dataset.weather as WeatherId);
      }),
    );
    const change = (patch: Partial<LagoonSettings>): void => {
      this.settings = { ...this.settings, ...patch };
      saveSettings(this.settings);
      this.cb.onSettings(this.settings);
    };
    this.pause.querySelectorAll<HTMLButtonElement>('button[data-q]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        change({ quality: b.dataset.q === 'low' ? 'low' : 'high' });
        this.showPause(time, weather);
      }),
    );
    this.pause.querySelectorAll<HTMLButtonElement>('button[data-tm]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        change({ toneMap: b.dataset.tm === 'agx' ? 'agx' : 'aces' });
        this.showPause(time, weather);
      }),
    );
    this.pause.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('input', () => {
        const k = input.dataset.k;
        if (k === 'invertY') change({ invertY: input.checked });
        else if (k === 'adaptive') change({ adaptive: input.checked });
        else if (k === 'sensitivity') change({ sensitivity: Number(input.value) });
        else if (k === 'volume') change({ volume: Number(input.value) });
      });
    });
    this.pause.addEventListener('click', (e) => e.stopPropagation());
  }

  /** Benchmark results as a plain table, with a copy button for pasting into a report. */
  showBenchmark(text: string, onBack: () => void): void {
    this.pause.classList.remove('hidden');
    this.pause.innerHTML = `
      <div class="panel">
        <h2>Benchmark</h2>
        <pre class="bench"></pre>
        <div class="row"><button class="copy">Copy</button><button class="back">Back</button></div>
      </div>`;
    (this.pause.querySelector('pre') as HTMLElement).textContent = text;
    this.pause.querySelector('.copy')?.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(text).catch((err: unknown) => console.warn('clipboard unavailable:', err));
    });
    this.pause.querySelector('.back')?.addEventListener('click', (e) => {
      e.stopPropagation();
      onBack();
    });
  }

  hidePause(): void {
    this.pause.classList.add('hidden');
  }

  get inventoryOpen(): boolean {
    return !this.inventory.classList.contains('hidden');
  }

  toggleInventory(inv: Inventory): void {
    if (this.inventoryOpen) {
      this.inventory.classList.add('hidden');
      return;
    }
    this.renderInventory(inv);
    this.inventory.classList.remove('hidden');
  }

  renderInventory(inv: Inventory): void {
    const entries = inv.entries();
    const cards = entries
      .map((e) => {
        const spec = ITEMS[e.id];
        return `<div class="item"><div class="ico">${ITEM_ICONS[e.id]}</div><div class="txt"><b>${escapeHtml(spec.name)}</b>${spec.tool ? '' : `<span class="qty">× ${e.count}</span>`}<p>${escapeHtml(spec.description)}</p></div></div>`;
      })
      .join('');
    this.inventory.innerHTML = `<div class="panel"><h2>Inventory <small>${entries.length} ${entries.length === 1 ? 'item' : 'items'}</small></h2><div class="grid">${cards || '<p class="empty">Nothing yet. Stones lie along the waterline; the shelter holds more.</p>'}</div><small class="hint">I — close</small></div>`;
  }
}

function controlsTable(): string {
  return `<table>${CONTROLS.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('')}</table>`;
}
