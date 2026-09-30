import { LAGOON_PLAYER, TIME_OF_DAY, type TimeOfDayId, TIME_ORDER, WEATHER, WEATHER_ORDER, type WeatherId } from '../config.ts';
import type { LagoonEvent } from '../game/events.ts';
import { type LagoonGame, sleepUntil } from '../game/game.ts';
import { ITEM_ICONS, TIME_ICONS, WEATHER_ICONS } from './icons.ts';

// The in-game HUD, as DOM (rules §7): a small crosshair that becomes a ring
// over something you can use, a quiet interaction prompt below the centre
// zone, pick-up toasts, the ammo or stone count only while that tool is in
// hand, an examine card, and a time/weather strip that appears when T or N is
// pressed and fades away. Nothing else stays on screen.

const TOAST_SECONDS = 2.6;
const STRIP_SECONDS = 3.2;

export class Hud {
  private readonly cross: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly ammo: HTMLElement;
  private readonly examine: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly message: HTMLElement;
  private readonly air: HTMLElement;
  private readonly airFill: HTMLElement;
  private readonly current: HTMLElement;
  private readonly fade: HTMLElement;
  private stripTimer = 0;
  private messageTimer = 0;
  private lastPrompt = '';
  private lastAmmo = '';
  private lastTime: TimeOfDayId | null = null;
  private lastWeather: WeatherId | null = null;
  private examiningId = -1;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="cross"><i></i></div>
      <div class="prompt"></div>
      <div class="toasts"></div>
      <div class="ammo"></div>
      <div class="examine"><h3></h3><p></p><small>E — put it back</small></div>
      <div class="strip"></div>
      <div class="message"></div>
      <div class="air"><span>Air</span><i><b></b></i></div>
      <div class="current">The current is carrying you back</div>
      <div class="fade"></div>`;
    const q = (sel: string): HTMLElement => {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`HUD element ${sel} missing`);
      return el;
    };
    this.cross = q('.cross');
    this.prompt = q('.prompt');
    this.toasts = q('.toasts');
    this.ammo = q('.ammo');
    this.examine = q('.examine');
    this.strip = q('.strip');
    this.message = q('.message');
    this.air = q('.air');
    this.airFill = q('.air b');
    this.current = q('.current');
    this.fade = q('.fade');
  }

  set visible(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  handle(e: LagoonEvent): void {
    if (e.type === 'itemGained') this.toast(e.itemId in ITEM_ICONS ? ITEM_ICONS[e.itemId as keyof typeof ITEM_ICONS] : '', `+${e.count} ${e.name}`);
    else if (e.type === 'examine') {
      this.examiningId = e.id;
      (this.examine.querySelector('h3') as HTMLElement).textContent = e.title;
      (this.examine.querySelector('p') as HTMLElement).textContent = e.text;
    } else if (e.type === 'message') {
      this.message.textContent = e.text;
      this.messageTimer = 2.2;
    }
  }

  private toast(icon: string, text: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="ico">${icon}</span><span></span>`;
    (el.lastElementChild as HTMLElement).textContent = text;
    this.toasts.prepend(el);
    window.setTimeout(() => el.classList.add('out'), TOAST_SECONDS * 1000);
    window.setTimeout(() => el.remove(), TOAST_SECONDS * 1000 + 600);
    while (this.toasts.children.length > 5) this.toasts.lastElementChild?.remove();
  }

  update(game: LagoonGame, dt: number): void {
    const eq = game.equipment;
    const f = game.focus;
    const busy = eq.action.kind !== 'idle' && eq.action.kind !== 'examine';
    // Crosshair: hidden when aimed down the iron sights.
    this.cross.classList.toggle('focus', f !== null && !busy);
    this.cross.style.opacity = String(1 - eq.adsBlend);
    let prompt = '';
    if (f && f.kind === 'sleep' && !busy && eq.action.kind !== 'examine') {
      prompt = `<kbd>E</kbd> Sleep until <b>${TIME_OF_DAY[sleepUntil(game.env.timeId)].label.toLowerCase()}</b>`;
    } else if (f && !busy && eq.action.kind !== 'examine') {
      const verb = f.kind === 'pickup' ? 'Pick up' : f.kind === 'harvest' ? 'Harvest' : f.kind === 'crate' ? 'Open' : 'Examine';
      prompt = `<kbd>E</kbd> ${verb} <b>${escapeHtml(f.name)}</b>`;
    }
    if (prompt !== this.lastPrompt) {
      this.prompt.innerHTML = prompt;
      this.lastPrompt = prompt;
    }
    this.prompt.classList.toggle('on', prompt !== '');
    // Ammo / stones.
    let ammo = '';
    if (eq.slot === 'rifle') ammo = `<span class="ico">${ITEM_ICONS.rifle}</span><b>${eq.magazineRounds}</b><span class="res">/ ${game.inventory.count('ammo762')}</span>`;
    else if (eq.slot === 'stone') ammo = `<span class="ico">${ITEM_ICONS.stone}</span><b>${game.inventory.count('stone')}</b>`;
    else if (eq.slot === 'knife') ammo = `<span class="ico">${ITEM_ICONS.knife}</span>`;
    if (ammo !== this.lastAmmo) {
      this.ammo.innerHTML = ammo;
      this.lastAmmo = ammo;
    }
    this.ammo.classList.toggle('on', ammo !== '');
    // Examine card.
    const examining = eq.action.kind === 'examine' && eq.action.targetId === this.examiningId;
    this.examine.classList.toggle('on', examining);
    // Time and weather strip: shown on change.
    const env = game.env;
    if (env.timeId !== this.lastTime || env.weatherId !== this.lastWeather) {
      const first = this.lastTime === null;
      this.lastTime = env.timeId;
      this.lastWeather = env.weatherId;
      this.renderStrip(env.timeId, env.weatherId);
      if (!first) this.stripTimer = STRIP_SECONDS;
    }
    this.stripTimer = Math.max(0, this.stripTimer - dt);
    this.strip.classList.toggle('on', this.stripTimer > 0);
    // Air: shown under water and while it refills; red when nearly gone.
    const p = game.player;
    const air = p.airS / LAGOON_PLAYER.breathSeconds;
    this.air.classList.toggle('on', p.underwater || air < 0.999);
    this.air.classList.toggle('low', air < 0.25);
    this.airFill.style.transform = `scaleX(${air.toFixed(3)})`;
    this.current.classList.toggle('on', p.current > 0.15);
    // Sleep: fade to black, the hours pass at the midpoint (game.ts), fade back in.
    let dark = 0;
    if (eq.action.kind === 'sleep') {
      const t = Math.min(1, eq.action.elapsedSeconds / eq.action.durationSeconds);
      dark = t < 0.35 ? t / 0.35 : t > 0.7 ? (1 - t) / 0.3 : 1;
    }
    this.fade.style.opacity = dark.toFixed(3);
    this.messageTimer = Math.max(0, this.messageTimer - dt);
    this.message.classList.toggle('on', this.messageTimer > 0);
  }

  private renderStrip(time: TimeOfDayId, weather: WeatherId): void {
    const t = TIME_ORDER.map((id) => `<span class="opt${id === time ? ' sel' : ''}">${TIME_ICONS[id]}</span>`).join('');
    const w = WEATHER_ORDER.map((id) => `<span class="opt${id === weather ? ' sel' : ''}">${WEATHER_ICONS[id]}</span>`).join('');
    this.strip.innerHTML = `<div class="grp"><kbd>N</kbd>${t}<em>${TIME_OF_DAY[time].label}</em></div><div class="grp"><kbd>T</kbd>${w}<em>${WEATHER[weather].label}</em></div>`;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
