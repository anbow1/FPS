import { HEALTH, LAGOON_PLAYER, SPECIES, TIME_OF_DAY, type TimeOfDayId, TIME_ORDER, WEATHER, WEATHER_ORDER, type WeatherId } from '../config.ts';
import type { P3, ThreatKind } from '../game/events.ts';
import type { ItemId } from '../game/items.ts';
import type { LagoonEvent } from '../game/events.ts';
import { type LagoonGame, sleepUntil } from '../game/game.ts';
import { ITEM_ICONS, TIME_ICONS, WEATHER_ICONS } from './icons.ts';

// The in-game HUD, as DOM (rules §7): a small crosshair that becomes a ring
// over something you can use, a quiet interaction prompt below the centre
// zone, pick-up toasts, the ammo or stone count only while that tool is in
// hand, an examine card, and a time/weather strip that appears when T or N is
// pressed and fades away. Health shows only while hurt or healing; a wound
// flushes the screen's edges red and an arc by the crosshair points to where
// it came from. Nothing else stays on screen.

const HIT_ARC_S = 1.4;

function causeName(c: ThreatKind | 'fall'): string {
  return c === 'fall' ? 'a fall' : c === 'guerrilla' ? 'guerrillas' : `a ${SPECIES[c].label.toLowerCase()}`;
}

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
  private readonly health: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthHeal: HTMLElement;
  private readonly healthHint: HTMLElement;
  private readonly hurtEdge: HTMLElement;
  private readonly arcs: HTMLElement[] = [];
  private readonly down: HTMLElement;
  private readonly hits: { from: P3 | null; t: number }[] = [];
  private hurtPulse = 0;
  private downFade = 0;
  private lastHint = '';
  /** First-time warnings, once each per game. */
  private readonly warned = new Set<string>();
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
      <div class="hurt"></div>
      <div class="hit-arcs"><i></i><i></i><i></i><i></i></div>
      <div class="health"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.2 0 3.6 1.2 5.3 3.2 1.7-2 3.1-3.2 5.3-3.2 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z" fill="currentColor"/></svg><i><u></u><b></b></i><em></em></div>
      <div class="down"></div>
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
    this.health = q('.health');
    this.healthFill = q('.health b');
    this.healthHeal = q('.health u');
    this.healthHint = q('.health em');
    this.hurtEdge = q('.hurt');
    this.down = q('.down');
    root.querySelectorAll<HTMLElement>('.hit-arcs i').forEach((el) => this.arcs.push(el));
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
      this.say(e.text, 2.2);
    } else if (e.type === 'hurt') {
      this.hurtPulse = Math.min(1, this.hurtPulse + 0.35 + e.amount / 60);
      if (e.from) {
        this.hits.unshift({ from: { ...e.from }, t: HIT_ARC_S });
        if (this.hits.length > this.arcs.length) this.hits.length = this.arcs.length;
      }
    } else if (e.type === 'blackout') {
      this.down.textContent = `You black out — ${causeName(e.cause)}`;
      this.hits.length = 0;
    } else if (e.type === 'wake') {
      this.say('You come round at the shelter, patched up', 3.5);
    } else if (e.type === 'treat') {
      this.toast(e.item in ITEM_ICONS ? ITEM_ICONS[e.item as keyof typeof ITEM_ICONS] : '', `+${e.hp} health`);
      this.say(e.text, 2.2);
    } else if (e.type === 'threatCall') {
      // The first sign of each danger gets a word, once.
      const first = (key: string, text: string): void => {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        this.say(text, 3.2);
      };
      if (e.kind === 'tiger' && (e.call === 'growl' || e.call === 'roar')) first('tiger', 'A growl in the trees — something big is stalking you');
      else if (e.kind === 'guerrilla' && e.call === 'shout') first('guerrilla', 'Voices, shouting — armed men in the jungle');
      else if (e.kind === 'boar' && e.call === 'squeal') first('boar', 'A boar — it is coming at you');
      else if (e.kind === 'croc') first('croc', 'Something big in the water — get out of it');
    }
  }

  private say(text: string, seconds: number): void {
    this.message.textContent = text;
    this.messageTimer = seconds;
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
    if (game.player.inJeep) {
      prompt = '<kbd>W</kbd><kbd>S</kbd> Drive · brake · <kbd>A</kbd><kbd>D</kbd> Steer · <kbd>L</kbd> Lights · <kbd>E</kbd> Get out';
    } else if (f && f.kind === 'jeep' && !busy && eq.action.kind !== 'examine') {
      const j = game.jeep;
      prompt =
        f.model === 'jeepBonnet'
          ? `<kbd>E</kbd> ${j.bonnetTarget > 0.5 ? 'Close' : 'Open'} the <b>bonnet</b>`
          : f.model === 'jeepPassenger'
            ? `<kbd>E</kbd> ${j.doorTarget.passenger > 0.5 ? 'Close' : 'Open'} the <b>door</b>`
            : '<kbd>E</kbd> Get in the <b>jeep</b>';
    } else if (game.player.inBoat) {
      prompt = '<kbd>W</kbd><kbd>S</kbd> Throttle · <kbd>A</kbd><kbd>D</kbd> Steer · <kbd>E</kbd> Leave the <b>boat</b>';
    } else if (f && f.kind === 'boat' && !busy && eq.action.kind !== 'examine') {
      prompt = '<kbd>E</kbd> Board the <b>boat</b>';
    } else if (f && f.kind === 'fire' && !busy && eq.action.kind !== 'examine') {
      const fire = game.fire;
      prompt = !fire.lit && fire.fuelS > 0 ? '<kbd>E</kbd> Light the <b>fire</b>' : `<kbd>E</kbd> Put a log on the <b>${fire.lit ? 'fire' : 'dead fire'}</b>`;
    } else if (f && f.kind === 'sleep' && !busy && eq.action.kind !== 'examine') {
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
    else if (eq.slot === 'log') ammo = `<span class="ico">${ITEM_ICONS.log}</span><b>${game.inventory.count('log')}</b>`;
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
    // Blacked out: dark while down, light again on waking.
    this.downFade += ((game.downS > 0 ? 1 : 0) - this.downFade) * Math.min(1, dt * (game.downS > 0 ? 2.5 : 1.2));
    this.down.classList.toggle('on', game.downS > 0.6);
    this.fade.style.opacity = Math.max(dark, this.downFade).toFixed(3);
    this.updateHealth(game, dt);
    this.messageTimer = Math.max(0, this.messageTimer - dt);
    this.message.classList.toggle('on', this.messageTimer > 0);
  }

  private updateHealth(game: LagoonGame, dt: number): void {
    const p = game.player;
    const k = p.health / HEALTH.max;
    const healing = game.healPool > 0;
    this.health.classList.toggle('on', k < 0.995 || healing || game.sinceHurtS < 4);
    this.health.classList.toggle('low', k < 0.3);
    this.healthFill.style.transform = `scaleX(${k.toFixed(3)})`;
    this.healthHeal.style.transform = `scaleX(${Math.min(1, (p.health + game.healPool) / HEALTH.max).toFixed(3)})`;
    // A hint to treat the wound, when there is something to treat it with.
    const kit = HEALTH.treatments.find((t) => game.inventory.has(t.item as ItemId));
    const hint = k < 0.75 && !healing && kit ? `<kbd>Q</kbd> ${kit.item === 'medkit' ? 'Dress the wound' : 'Treat wounds'}` : '';
    if (hint !== this.lastHint) {
      this.healthHint.innerHTML = hint;
      this.lastHint = hint;
    }
    // Red edges: a flush on each hit, a slow throb while badly hurt.
    this.hurtPulse = Math.max(0, this.hurtPulse - dt * 1.1);
    // Full strength from 15 % down; a ramp from 0 at 30 % left a quarter-health player with almost none.
    const throb = k < 0.35 ? (0.3 + 0.15 * Math.sin(performance.now() * 0.006)) * Math.min(1, (0.35 - k) / 0.2) : 0;
    this.hurtEdge.style.opacity = Math.min(1, this.hurtPulse + throb).toFixed(3);
    // Direction arcs: rotated to where each hit came from, relative to where the player faces.
    for (let i = 0; i < this.arcs.length; i++) {
      const el = this.arcs[i] as HTMLElement;
      const h = this.hits[i];
      if (!h || !h.from) {
        el.style.opacity = '0';
        continue;
      }
      h.t -= dt;
      const bearing = Math.atan2(-(h.from.x - p.pos.x), -(h.from.z - p.pos.z));
      const rel = bearing - p.yawRad;
      el.style.transform = `rotate(${(-rel).toFixed(3)}rad)`;
      el.style.opacity = Math.max(0, h.t / HIT_ARC_S).toFixed(3);
    }
    while (this.hits.length > 0 && (this.hits[this.hits.length - 1] as { t: number }).t <= 0) this.hits.pop();
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
