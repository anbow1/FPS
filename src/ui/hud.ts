import type { AmmoId } from '../config';
import { AMMO, BUDGET, PLAY_HALF, WATER_LEVEL } from '../config';
import type { ModuleId } from '../game/damage';
import type { Tank } from '../game/tank';
import type { World } from '../world/world';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const MODULE_LABEL: Record<ModuleId, string> = {
  engine: 'silnik', trackL: 'gąsienica L', trackR: 'gąsienica P', gun: 'działo', turretDrive: 'napęd wieży', ammo: 'amunicja', fuel: 'paliwo',
};

export interface MarkerState {
  sight: boolean;
  zoom: number;
  thermal: boolean;
  /** screen px of the gun's predicted impact, or null */
  gun: { x: number; y: number } | null;
  gunReady: boolean;
  lead: { x: number; y: number } | null;
  target: { x: number; y: number; r: number } | null;
  /** pixels per mil at the current FOV */
  pxPerMil: number;
  /** direction of the last hit taken, radians relative to camera heading (0 = ahead) */
  hitDir: number | null;
  hitAge: number;
}

/**
 * DOM HUD following the tank-gunner zone layout: everything inside a 16:9 box centred on the
 * screen, text only inside the 90 % title-safe area, the centre circle (30 % of width) carries
 * symbols only.
 */
export class Hud {
  private root = $('hud');
  private svg = $('markers') as unknown as SVGSVGElement;
  private turretInd = $('turret-ind') as unknown as SVGGElement;
  private hullInd = $('hull-ind') as unknown as SVGGElement;
  private speedEl = $('speed');
  private rangeEl = $('range');
  private ammoEl = $('ammo');
  private reloadBar = $('reload-bar');
  private reloadTxt = $('reload-txt');
  private msgEl = $('messages');
  private waveEl = $('wave');
  private hpBar = $('hp-bar');
  private hpTxt = $('hp-txt');
  private fireEl = $('fire-ind');
  private perfEl = $('perf');
  private sightMask = $('sight-mask');
  private sightInfo = $('sight-info');
  private minimap = $('minimap') as HTMLCanvasElement;
  private mmCtx: CanvasRenderingContext2D;
  private mmBase: HTMLCanvasElement | null = null;
  private msgs: { el: HTMLElement; t: number }[] = [];
  private slow = 0;
  private modEls = new Map<ModuleId, SVGElement>();
  perfVisible = false;

  constructor() {
    const ctx = this.minimap.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.mmCtx = ctx;
    for (const id of ['engine', 'trackL', 'trackR', 'gun', 'turretDrive', 'ammo', 'fuel'] as ModuleId[]) {
      const el = document.querySelector(`#modules [data-m="${id}"]`);
      if (el) this.modEls.set(id, el as SVGElement);
    }
    window.addEventListener('resize', () => this.layout());
    this.layout();
  }

  /** Anchor to the centred 16:9 area (ultrawide-safe). */
  layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const bw = Math.min(w, (h * 16) / 9);
    const bh = Math.min(h, (w * 9) / 16);
    Object.assign(this.root.style, { width: `${bw}px`, height: `${bh}px`, left: `${(w - bw) / 2}px`, top: `${(h - bh) / 2}px` });
    this.root.style.setProperty('--u', `${bw / 100}px`);
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
    this.svg.style.display = on ? '' : 'none';
  }

  buildMinimap(world: World): void {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const ext = PLAY_HALF + 40;
    const nrm = { x: 0, y: 1, z: 0 };
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const x = -ext + ((i + 0.5) / S) * ext * 2;
        const z = -ext + ((j + 0.5) / S) * ext * 2;
        const h = world.hf.heightAt(x, z);
        world.hf.normalAt(x, z, nrm, 6);
        const shade = Math.max(0, nrm.x * -0.5 + nrm.y * 0.7 + nrm.z * -0.5);
        let r = 70 + h * 0.5;
        let g = 84 + h * 0.4;
        let b = 58;
        if (h < WATER_LEVEL) {
          r = 40;
          g = 64;
          b = 72;
        }
        const road = world.hf.roadAt(x, z);
        r += road * 50;
        g += road * 35;
        b += road * 25;
        const k = 0.55 + shade * 0.6;
        const o = (j * S + i) * 4;
        img.data[o] = r * k;
        img.data[o + 1] = g * k;
        img.data[o + 2] = b * k;
        img.data[o + 3] = 235;
      }
    }
    ctx.putImageData(img, 0, 0);
    const toPx = (v: number) => ((v + ext) / (ext * 2)) * S;
    ctx.fillStyle = 'rgba(28,40,24,0.55)';
    for (const t of world.vegetation.trees) {
      if (Math.abs(t.x) < ext && Math.abs(t.z) < ext) ctx.fillRect(toPx(t.x) - 0.6, toPx(t.z) - 0.6, 1.2, 1.2);
    }
    ctx.fillStyle = '#c9b9a0';
    for (const b of world.buildings) {
      ctx.save();
      ctx.translate(toPx(b.x), toPx(b.z));
      ctx.rotate(-b.rot);
      const sx = (b.hw * 2 * S) / (ext * 2);
      const sz = (b.hd * 2 * S) / (ext * 2);
      ctx.fillRect(-sx / 2, -sz / 2, sx, sz);
      ctx.restore();
    }
    this.mmBase = c;
  }

  message(text: string, kind: 'good' | 'bad' | 'info' = 'info'): void {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = text;
    this.msgEl.prepend(el);
    this.msgs.unshift({ el, t: 0 });
    while (this.msgs.length > 5) this.msgs.pop()!.el.remove();
  }

  setWave(text: string): void {
    this.waveEl.textContent = text;
  }

  update(dt: number, p: Tank, range: number | null, rangeLased: boolean, enemies: Tank[], spotted: Set<Tank>, fps: number, cpuMs: number, info: { calls: number; triangles: number }, quality: 'high' | 'low', m: MarkerState): void {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const q = this.msgs[i]!;
      q.t += dt;
      q.el.style.opacity = String(Math.max(0, Math.min(1, 4.5 - q.t)));
      if (q.t > 4.5) {
        q.el.remove();
        this.msgs.splice(i, 1);
      }
    }
    this.markers(m);
    this.turretInd.setAttribute('transform', 'rotate(0 50 50)');
    this.hullInd.setAttribute('transform', `rotate(${(p.turretYaw * 180) / Math.PI} 50 50)`);

    // reload bar every frame (smooth)
    const rl = p.loaded ? 1 : 1 - p.reloadLeft / p.reloadTime;
    this.reloadBar.style.width = `${Math.max(0, Math.min(1, rl)) * 100}%`;
    this.reloadBar.classList.toggle('ready', !!p.loaded);

    this.slow -= dt;
    if (this.slow > 0) return;
    this.slow = 1 / 12;
    this.speedEl.textContent = `${Math.round(Math.abs(p.speed) * 3.6)} km/h${p.speed < -0.3 ? ' R' : ''}`;
    this.rangeEl.textContent = range === null ? '----' : `${Math.round(range / 5) * 5}`;
    this.rangeEl.classList.toggle('lased', rangeLased);
    this.reloadTxt.textContent = p.loaded ? `${AMMO[p.loaded].label} gotowy` : p.modules.gun <= 0 ? 'działo zniszczone' : p.ammo[p.selected] <= 0 ? 'brak amunicji' : `ładowanie ${p.reloadLeft.toFixed(1)} s`;
    let html = '';
    for (const id of ['APFSDS', 'HEAT', 'HE'] as AmmoId[]) {
      const sel = p.selected === id ? ' sel' : '';
      const ld = p.loaded === id ? '●' : '';
      html += `<span class="am${sel}"><b>${id === 'APFSDS' ? 1 : id === 'HEAT' ? 2 : 3}</b> ${AMMO[id].label} ${p.ammo[id]}${ld}</span>`;
    }
    this.ammoEl.innerHTML = html;
    const hp = p.hp / p.spec.hp;
    this.hpBar.style.width = `${hp * 100}%`;
    this.hpBar.style.background = hp > 0.6 ? '#9fcf7f' : hp > 0.3 ? '#e8c35a' : '#e0604a';
    this.hpTxt.textContent = `${Math.round(p.hp)}`;
    this.fireEl.style.display = p.burning > 0 ? '' : 'none';
    this.fireEl.textContent = `POŻAR — F gaśnica (${p.extinguishers})`;
    for (const [id, el] of this.modEls) {
      const v = p.modules[id];
      const repair = p.repairProgress(id);
      el.setAttribute('class', v <= 0 ? 'mod dead' : v < 0.5 ? 'mod hurt' : 'mod ok');
      el.setAttribute('data-repair', v <= 0 ? `${Math.round(repair * 100)}%` : '');
      el.querySelector('title')!.textContent = `${MODULE_LABEL[id]}: ${v <= 0 ? `zniszczony (naprawa ${Math.round(repair * 100)}%)` : v < 0.5 ? 'uszkodzony' : 'sprawny'}`;
    }
    const b = BUDGET[quality];
    this.perfEl.style.display = this.perfVisible ? '' : 'none';
    if (this.perfVisible) {
      const warn = (v: number, lim: number) => (v > lim ? ' class="over"' : '');
      this.perfEl.innerHTML =
        `<div>${fps.toFixed(0)} fps · CPU ${cpuMs.toFixed(1)} ms</div>` +
        `<div${warn(info.calls, b.drawCalls)}>draw calls ${info.calls} / ${b.drawCalls}</div>` +
        `<div${warn(info.triangles / 1e6, b.trianglesM)}>tris ${(info.triangles / 1e6).toFixed(2)} M / ${b.trianglesM}</div>`;
    }
    this.drawMinimap(p, enemies, spotted);
    this.sightMask.style.display = m.sight ? '' : 'none';
    this.sightInfo.style.display = m.sight ? '' : 'none';
    this.sightInfo.textContent = `${m.zoom.toFixed(0)}×${m.thermal ? ' · TERMO' : ''}`;
    this.root.classList.toggle('sight', m.sight);
  }

  private drawMinimap(p: Tank, enemies: Tank[], spotted: Set<Tank>): void {
    const ctx = this.mmCtx;
    const S = this.minimap.width;
    ctx.clearRect(0, 0, S, S);
    if (this.mmBase) ctx.drawImage(this.mmBase, 0, 0, S, S);
    const ext = PLAY_HALF + 40;
    const toPx = (v: number) => ((v + ext) / (ext * 2)) * S;
    // map is drawn with +x to the right, +z down; heading yaw uses (sin, cos) on (x, z)
    for (const e of enemies) {
      const x = toPx(e.pos.x);
      const y = toPx(e.pos.z);
      if (!e.alive) {
        ctx.strokeStyle = 'rgba(40,40,40,0.9)';
        ctx.beginPath();
        ctx.moveTo(x - 3, y - 3);
        ctx.lineTo(x + 3, y + 3);
        ctx.moveTo(x + 3, y - 3);
        ctx.lineTo(x - 3, y + 3);
        ctx.stroke();
      } else if (spotted.has(e)) {
        ctx.fillStyle = '#ff5a3c';
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const px = toPx(p.pos.x);
    const py = toPx(p.pos.z);
    // turret cone
    const ty = p.yaw + p.turretYaw;
    ctx.fillStyle = 'rgba(255,220,140,0.22)';
    ctx.beginPath();
    ctx.moveTo(px, py);
    const len = 46;
    for (const a of [-0.3, 0.3]) ctx.lineTo(px + Math.sin(ty + a) * len, py + Math.cos(ty + a) * len);
    ctx.closePath();
    ctx.fill();
    // hull arrow
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#f2e6c8';
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(4, -4);
    ctx.lineTo(-4, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private markers(m: MarkerState): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;
    const set = (id: string, attrs: Record<string, string | number>) => {
      const el = this.svg.getElementById(id);
      if (!el) return;
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    };
    const s = Math.max(0.8, Math.min(1.4, w / 1600));
    set('reticle', { transform: `translate(${cx} ${cy}) scale(${s})`, visibility: m.sight ? 'hidden' : 'visible' });
    if (m.gun) set('gun-marker', { transform: `translate(${m.gun.x} ${m.gun.y}) scale(${s})`, visibility: 'visible', class: m.gunReady ? 'ready' : 'reloading' });
    else set('gun-marker', { visibility: 'hidden' });
    if (m.lead) set('lead-mark', { transform: `translate(${m.lead.x} ${m.lead.y}) scale(${s})`, visibility: 'visible' });
    else set('lead-mark', { visibility: 'hidden' });
    if (m.target) {
      const r = Math.max(14, m.target.r);
      set('target-box', { transform: `translate(${m.target.x} ${m.target.y})`, visibility: 'visible' });
      const box = this.svg.getElementById('target-box-path');
      box?.setAttribute('d', `M${-r} ${-r + 6}V${-r}H${-r + 6} M${r - 6} ${-r}H${r}V${-r + 6} M${r} ${r - 6}V${r}H${r - 6} M${-r + 6} ${r}H${-r}V${r - 6}`);
    } else set('target-box', { visibility: 'hidden' });
    // gunner-sight mil reticle
    if (m.sight) {
      // mil stadia: keep ticks at least ~9 px apart whatever the zoom
      const k = m.pxPerMil;
      const step = [1, 2, 5, 10].find((q) => q * k >= 9) ?? 10;
      const span = Math.min(20, Math.max(step * 4, Math.floor(Math.min(w, h) * 0.13 / k / step) * step));
      let d = '';
      for (let i = -span; i <= span; i += step) {
        if (i === 0) continue;
        const len = i % (step * 5) === 0 ? 10 : 5;
        d += `M${cx + i * k} ${cy}v${len}`;
      }
      for (let i = step; i <= span; i += step) {
        const len = i % (step * 2) === 0 ? 14 : 7;
        d += `M${cx - len / 2} ${cy + i * k}h${len}`;
      }
      d += `M${cx - 40 * s - span * k} ${cy}H${cx - span * k}M${cx + span * k} ${cy}H${cx + 40 * s + span * k}M${cx} ${cy + span * k + 20}V${cy + span * k + 60 * s}`;
      set('mil-scale', { d, visibility: 'visible' });
      set('sight-chevron', { transform: `translate(${cx} ${cy}) scale(${s})`, visibility: 'visible' });
    } else {
      set('mil-scale', { visibility: 'hidden' });
      set('sight-chevron', { visibility: 'hidden' });
    }
    if (m.hitDir !== null && m.hitAge < 2.5) {
      const r = Math.min(w, h) * 0.13;
      set('hit-dir', {
        transform: `translate(${cx} ${cy}) rotate(${(m.hitDir * 180) / Math.PI})`,
        visibility: 'visible',
        opacity: (1 - m.hitAge / 2.5).toFixed(2),
      });
      const arc = this.svg.getElementById('hit-dir-path');
      arc?.setAttribute('d', `M${-r * Math.sin(0.35)} ${-r * Math.cos(0.35)} A${r} ${r} 0 0 1 ${r * Math.sin(0.35)} ${-r * Math.cos(0.35)}`);
    } else set('hit-dir', { visibility: 'hidden' });
  }
}
