import type { Settings } from '../app/settings.ts';
import { LIGHTING, type LightingPresetId } from '../config.ts';
import type { Action, Input } from '../core/input.ts';
import { MODE_LABELS, type ModeId } from '../game/modes.ts';
import { MAP_LABELS } from '../maps/index.ts';
import type { MapId } from '../maps/types.ts';
import { quitGame } from './quit.ts';

// Main menu, pause menu, loading screen and results. Plain DOM over the canvas.

const MODES_FOR: Record<MapId, ModeId[]> = {
  range: ['range'],
  city: ['skirmish', 'extraction'],
  forest: ['skirmish', 'extraction'],
};

const ACTION_LABELS: Partial<Record<Action, string>> = {
  forward: 'Forward',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  sprint: 'Sprint / hold breath',
  jump: 'Jump',
  crouch: 'Crouch / slide',
  prone: 'Prone',
  fire: 'Fire',
  aim: 'Aim',
  reload: 'Reload',
  fireMode: 'Fire mode',
  weapon1: 'Carbine',
  weapon2: 'Sniper',
  weapon3: 'Pistol',
  grenade: 'Grenade (hold to cook)',
  grenadeCycle: 'Next grenade',
  rangeFinder: 'Range finder',
  weaponLight: 'Weapon light',
  zoom: 'Scope zoom',
  suppressor: 'Suppressor',
  medKit: 'Med kit',
  ammoPack: 'Ammo pack',
  pause: 'Pause',
};

export interface MenuCallbacks {
  onStart: (s: Settings) => void;
  onResume: () => void;
  onQuit: () => void;
  /** Tours the map's fixed benchmark spots and shows the numbers (app/bench.ts). */
  onBenchmark: () => void;
  onSettingsChanged: (s: Settings) => void;
}

export class Menu {
  private rebinding: Action | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly input: Input,
    private settings: Settings,
    private readonly cb: MenuCallbacks,
  ) {
    window.addEventListener('keydown', (e) => {
      if (!this.rebinding) return;
      e.preventDefault();
      this.input.rebind(this.rebinding, e.code);
      this.rebinding = null;
      this.renderKeys();
    });
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
  }

  showMain(): void {
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="menu">
        <h1>FIELD LINE</h1>
        <p class="sub">Single-player infantry. Range, city block, forest ridge.</p>
        <div class="row"><label>Map</label><div class="seg" data-g="map"></div></div>
        <div class="row"><label>Mode</label><div class="seg" data-g="mode"></div></div>
        <div class="row"><label>Light</label><div class="seg" data-g="preset"></div></div>
        ${this.settingsRows()}
        <div class="actions"><button class="primary" data-a="start">Deploy</button></div>
        <details><summary style="cursor:pointer;margin-top:14px;color:#a9a59c">Controls</summary><div class="keys" data-g="keys"></div></details>
      </div>`;
    this.bindCommon();
    this.renderChoices();
    this.renderKeys();
    this.q('[data-a="start"]').addEventListener('click', () => this.cb.onStart(this.settings));
  }

  showPause(): void {
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="menu">
        <h1>PAUSED</h1>
        <p class="sub">Click Resume to recapture the mouse.</p>
        <div class="row"><label>Light</label><div class="seg" data-g="preset"></div></div>
        ${this.settingsRows()}
        <div class="actions"><button class="primary" data-a="resume">Resume</button><button data-a="bench">Benchmark</button><button data-a="quit">Quit to menu</button><button data-a="exit">Quit game</button></div>
        <details><summary style="cursor:pointer;margin-top:14px;color:#a9a59c">Controls</summary><div class="keys" data-g="keys"></div></details>
      </div>`;
    this.bindCommon();
    this.renderChoices();
    this.renderKeys();
    this.q('[data-a="resume"]').addEventListener('click', () => this.cb.onResume());
    this.q('[data-a="bench"]').addEventListener('click', () => this.cb.onBenchmark());
    this.q('[data-a="quit"]').addEventListener('click', () => this.cb.onQuit());
    this.q('[data-a="exit"]').addEventListener('click', () => quitGame(() => this.cb.onQuit()));
  }

  /** Benchmark results as a plain table, with a copy button for pasting into a report. */
  showBenchmark(text: string): void {
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="menu">
        <h1>BENCHMARK</h1>
        <pre class="bench"></pre>
        <div class="actions"><button class="primary" data-a="copy">Copy</button><button data-a="back">Back</button></div>
      </div>`;
    this.q('pre').textContent = text;
    this.q('[data-a="copy"]').addEventListener('click', () => {
      navigator.clipboard?.writeText(text).catch((err: unknown) => console.warn('clipboard unavailable:', err));
    });
    this.q('[data-a="back"]').addEventListener('click', () => this.showPause());
  }

  showLoading(label: string, fraction: number): void {
    this.root.classList.remove('hidden');
    if (!this.root.querySelector('.loading')) {
      this.root.innerHTML = `<div class="menu loading"><div data-g="label"></div><div class="bar"><div data-g="bar"></div></div></div>`;
    }
    this.q('[data-g="label"]').textContent = label;
    this.q('[data-g="bar"]').style.width = `${Math.round(fraction * 100)}%`;
  }

  showResult(won: boolean, text: string, kills: number): void {
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="menu">
        <h1>${won ? 'MISSION COMPLETE' : 'MISSION FAILED'}</h1>
        <p class="sub">${escapeHtml(text)} · ${kills} enemies neutralised</p>
        <div class="actions"><button class="primary" data-a="again">Redeploy</button><button data-a="quit">Menu</button></div>
      </div>`;
    this.q('[data-a="again"]').addEventListener('click', () => this.cb.onStart(this.settings));
    this.q('[data-a="quit"]').addEventListener('click', () => this.cb.onQuit());
    this.q('[data-a="exit"]').addEventListener('click', () => quitGame(() => this.cb.onQuit()));
  }

  private q(sel: string): HTMLElement {
    const el = this.root.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`menu element ${sel} missing`);
    return el;
  }

  private settingsRows(): string {
    const s = this.settings;
    return `
      <div class="row"><label>Quality</label><div class="seg"><button data-set="quality:high">High</button><button data-set="quality:low">Low</button></div></div>
      <div class="row"><label>Render scale</label><div class="seg"><button data-set="renderScale:0.75">0.75</button><button data-set="renderScale:1">1.0</button><button data-set="renderScale:1.25">1.25</button><button data-set="renderScale:1.5">1.5</button></div></div>
      <div class="row"><label>Adaptive resolution</label><div class="seg"><button data-set="adaptive:true">On</button><button data-set="adaptive:false">Off</button></div></div>
      <div class="row"><label>Tone mapping</label><div class="seg"><button data-set="toneMap:aces">ACES</button><button data-set="toneMap:agx">AgX</button></div></div>
      <div class="row"><label>Camera</label><div class="seg"><button data-set="lens:standard">Standard</button><button data-set="lens:bodycam">Bodycam</button></div></div>
      <div class="row"><label>Rain (city)</label><div class="seg"><button data-set="wet:true">On</button><button data-set="wet:false">Off</button></div></div>
      <div class="row"><label>HUD</label><div class="seg"><button data-set="minimalHud:false">Full</button><button data-set="minimalHud:true">Minimal</button></div></div>
      <div class="row"><label>Stats overlay</label><div class="seg"><button data-set="showStats:true">On</button><button data-set="showStats:false">Off</button></div></div>
      <div class="row"><label>Mouse sensitivity</label><input type="range" min="0.2" max="3" step="0.05" value="${s.sensitivity}" data-range="sensitivity" /></div>
      <div class="row"><label>Camera shake</label><input type="range" min="0" max="1.5" step="0.05" value="${s.shake}" data-range="shake" /></div>`;
  }

  private bindCommon(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) => {
      b.addEventListener('click', () => {
        const [key, raw] = (b.dataset.set ?? '').split(':') as [keyof Settings, string];
        const cur = this.settings[key];
        const value = typeof cur === 'number' ? Number(raw) : typeof cur === 'boolean' ? raw === 'true' : raw;
        this.settings = { ...this.settings, [key]: value };
        this.cb.onSettingsChanged(this.settings);
        this.renderChoices();
      });
    });
    this.root.querySelectorAll<HTMLInputElement>('[data-range]').forEach((r) => {
      r.addEventListener('input', () => {
        const key = r.dataset.range as 'sensitivity' | 'shake';
        this.settings = { ...this.settings, [key]: Number(r.value) };
        this.cb.onSettingsChanged(this.settings);
      });
    });
  }

  private renderChoices(): void {
    const s = this.settings;
    const seg = (g: string, items: [string, string][], current: string, onPick: (v: string) => void): void => {
      const host = this.root.querySelector<HTMLElement>(`[data-g="${g}"]`);
      if (!host) return;
      host.innerHTML = items.map(([v, label]) => `<button data-v="${v}" class="${v === current ? 'on' : ''}">${label}</button>`).join('');
      host.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.v ?? '')));
    };
    seg('map', (Object.keys(MAP_LABELS) as MapId[]).map((m) => [m, MAP_LABELS[m]]), s.mapId, (v) => {
      const mapId = v as MapId;
      const modes = MODES_FOR[mapId];
      this.settings = { ...this.settings, mapId, modeId: modes.includes(this.settings.modeId) ? this.settings.modeId : (modes[0] as ModeId) };
      this.cb.onSettingsChanged(this.settings);
      this.renderChoices();
    });
    seg('mode', MODES_FOR[s.mapId].map((m) => [m, MODE_LABELS[m]]), s.modeId, (v) => {
      this.settings = { ...this.settings, modeId: v as ModeId };
      this.cb.onSettingsChanged(this.settings);
      this.renderChoices();
    });
    seg('preset', (Object.keys(LIGHTING) as LightingPresetId[]).map((p) => [p, LIGHTING[p].label]), s.preset, (v) => {
      this.settings = { ...this.settings, preset: v as LightingPresetId };
      this.cb.onSettingsChanged(this.settings);
      this.renderChoices();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) => {
      const [key, raw] = (b.dataset.set ?? '').split(':') as [keyof Settings, string];
      b.classList.toggle('on', String(this.settings[key]) === raw);
    });
  }

  private renderKeys(): void {
    const host = this.root.querySelector<HTMLElement>('[data-g="keys"]');
    if (!host) return;
    const b = this.input.getBindings();
    host.innerHTML = (Object.keys(ACTION_LABELS) as Action[])
      .map((a) => `<div>${ACTION_LABELS[a] ?? a} <button data-bind="${a}">${this.rebinding === a ? '…press' : (b[a] ?? []).join(' / ')}</button></div>`)
      .join('');
    host.querySelectorAll<HTMLButtonElement>('[data-bind]').forEach((btn) =>
      btn.addEventListener('click', () => {
        this.rebinding = btn.dataset.bind as Action;
        this.renderKeys();
      }),
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
