import { CAMERA, HEALTH } from '../config.ts';
import { wrapAngle } from '../core/vec.ts';
import type { GameEvent } from '../game/events.ts';
import type { Game } from '../game/game.ts';

// DOM HUD after hud-layout-reference.png (FPS panel): title-safe 90 %, anchored
// to the centred 16:9 area on ultrawide screens. Objective top-left, compass
// with the objective bearing top-right, weapon and ammo bottom-left, health,
// armour and med kits bottom-right, grenades bottom-centre. The centre zone
// (a circle 30 % of the width) holds symbols only — the reticle, hit markers,
// the damage direction arcs — and nothing at all while aiming down sights.
// Every element reads a real value from the game; DOM writes happen only on change.

export interface HudSettings {
  minimal: boolean;
}

const GRENADE_LABEL = { frag: 'FRAG', smoke: 'SMOKE', flash: 'FLASH' } as const;

export class Hud {
  private readonly root: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly cache = new Map<string, string>();
  private readonly hitArcs: { el: HTMLElement; bearingRad: number; age: number }[] = [];
  private hitMarkerAge = 9;
  private hitMarkerKill = false;
  private damageFlash = 0;
  private toastAge = 9;
  settings: HudSettings = { minimal: false };

  constructor(container: HTMLElement) {
    this.root = container;
    container.innerHTML = `
      <div class="hud-safe">
        <div class="hud-obj" data-k="objective"></div>
        <div class="hud-compass" data-k="compass"><div class="hud-compass-strip" data-k="strip"></div><div class="hud-compass-obj" data-k="objMark"></div><div class="hud-compass-caret"></div></div>
        <div class="hud-range" data-k="range"></div>
        <div class="hud-weapon">
          <div class="hud-toast" data-k="toast"></div>
          <div class="hud-wname" data-k="wname"></div>
          <div class="hud-ammo"><span data-k="mag"></span><span class="hud-mags" data-k="mags"></span></div>
          <div class="hud-mode" data-k="mode"></div>
        </div>
        <div class="hud-grenade">
          <div class="hud-item" data-k="item"><div class="hud-item-label" data-k="itemLabel"></div><div class="hud-bar"><div data-k="itemBar"></div></div></div>
          <div data-k="grenade"></div>
          <div class="hud-bar hud-fuse" data-k="fuse"><div data-k="fuseBar"></div></div>
        </div>
        <div class="hud-health">
          <div class="hud-armour" data-k="armour"></div>
          <div class="hud-hp"><div class="hud-hp-perm" data-k="hpPerm"></div><div class="hud-hp-buf" data-k="hpBuf"></div></div>
          <div class="hud-kits" data-k="kits"></div>
        </div>
      </div>
      <div class="hud-centre">
        <div class="hud-reticle" data-k="reticle"><i></i><i></i><i></i><i></i><b></b></div>
        <div class="hud-hitmark" data-k="hitmark"><i></i><i></i><i></i><i></i></div>
        <div class="hud-arcs" data-k="arcs"></div>
      </div>
      <div class="hud-vignette" data-k="vignette"></div>
      <div class="hud-flash" data-k="flash"></div>`;
    container.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => {
      const k = e.dataset.k;
      if (k) this.el[k] = e;
    });
    this.buildCompass();
  }

  private e(k: string): HTMLElement {
    const el = this.el[k];
    if (!el) throw new Error(`HUD element '${k}' missing from the template`);
    return el;
  }

  private text(k: string, v: string): void {
    if (this.cache.get(k) === v) return;
    this.cache.set(k, v);
    this.e(k).textContent = v;
  }

  private style(k: string, prop: 'width' | 'opacity' | 'transform' | 'display' | 'left', v: string): void {
    const key = `${k}.${prop}`;
    if (this.cache.get(key) === v) return;
    this.cache.set(key, v);
    this.e(k).style[prop] = v;
  }

  private buildCompass(): void {
    // Two full turns of ticks so the strip can scroll without a seam.
    const strip = this.e('strip');
    const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let html = '';
    for (let turn = 0; turn < 3; turn++) {
      for (let deg = 0; deg < 360; deg += 15) {
        const label = deg % 45 === 0 ? labels[deg / 45] : '';
        html += `<span class="${label ? 'major' : ''}">${label || '·'}</span>`;
      }
    }
    strip.innerHTML = html;
  }

  handle(e: GameEvent): void {
    switch (e.type) {
      case 'hit':
        if (e.byPlayer) {
          this.hitMarkerAge = 0;
          this.hitMarkerKill = e.killed;
        }
        break;
      case 'playerHit': {
        // fromDir points from the player toward the shooter; bearing relative to the view.
        this.addHitArc(Math.atan2(-e.fromDir.x, -e.fromDir.z));
        this.damageFlash = Math.min(1, this.damageFlash + (e.armour ? 0.35 : 0.7));
        break;
      }
      case 'pickup':
        this.toast(e.item === 'medKit' ? '+ Med kit' : e.item === 'ammoPack' ? '+ Ammo' : '+ Grenade');
        break;
      case 'itemInterrupted':
        this.toast('Med kit interrupted');
        break;
      case 'plateBreak':
        if (e.isPlayer) this.toast('Armour plate broken');
        break;
      case 'land':
        if (e.brokenLeg) this.toast('Leg broken');
        break;
      default:
        break;
    }
  }

  private toast(msg: string): void {
    this.text('toast', msg);
    this.toastAge = 0;
  }

  private addHitArc(bearingRad: number): void {
    const el = document.createElement('div');
    el.className = 'hud-arc';
    this.e('arcs').appendChild(el);
    this.hitArcs.push({ el, bearingRad, age: 0 });
  }

  update(game: Game, dt: number, viewportH: number): void {
    const p = game.player;
    const w = game.weapons;
    const st = w.state;
    const min = this.settings.minimal;
    this.root.classList.toggle('minimal', min);

    this.text('objective', game.mode.view.objectiveText);
    // Compass: 1° = 4 px on the strip. Yaw 0 looks down −Z, which we call north.
    const headingDeg = ((-p.yawRad * 180) / Math.PI + 720) % 360;
    // Ticks are 60 px per 15°, label centred: degree d sits at 4·d + 30 px along the strip.
    this.style('strip', 'transform', `translateX(${(-((headingDeg + 360) * 4 + 30)).toFixed(1)}px)`);
    const obj = game.mode.view.objectivePos;
    if (obj) {
      const eye = p.body.position;
      const bearing = Math.atan2(-(obj.x - eye.x), -(obj.z - eye.z));
      const rel = (wrapAngle(bearing - p.yawRad) * 180) / Math.PI;
      const visible = Math.abs(rel) < 60;
      this.style('objMark', 'display', visible ? 'block' : 'none');
      this.style('objMark', 'transform', `translateX(${(-rel * 4).toFixed(1)}px)`);
    } else this.style('objMark', 'display', 'none');
    const rf = game.rangeFinderAgeSeconds < 6 ? (game.rangeFinderM === null ? 'RNG ----' : `RNG ${Math.round(game.rangeFinderM)} m`) : '';
    this.text('range', rf);

    this.text('wname', st.spec.displayName + (st.suppressed ? '  · SUP' : ''));
    this.text('mag', `${st.magRounds + (st.chambered ? 1 : 0)}`);
    this.text('mags', ` / ${st.spareMags.filter((n) => n > 0).length}`);
    const mode = st.spec.boltAction ? `BOLT  ${w.scopeMagnification}×` : st.autoMode ? 'AUTO' : 'SEMI';
    this.text('mode', w.action.kind === 'reload' ? 'RELOADING' : mode);

    this.text('grenade', `${GRENADE_LABEL[p.grenadeKind]}  ${p.grenades[p.grenadeKind]}   ·   ${(['frag', 'smoke', 'flash'] as const).map((k) => p.grenades[k]).join(' / ')}`);
    const cook = game.grenades.cooking;
    this.style('fuse', 'display', cook ? 'block' : 'none');
    if (cook) this.style('fuseBar', 'width', `${Math.max(0, (cook.fuseSeconds / 4.5) * 100).toFixed(0)}%`);
    const item = p.itemInUse;
    this.style('item', 'display', item ? 'block' : 'none');
    if (item) {
      const total = item.kind === 'medKit' ? HEALTH.medKitSeconds : HEALTH.ammoPackSeconds;
      this.text('itemLabel', item.kind === 'medKit' ? 'Med kit' : 'Ammo pack');
      this.style('itemBar', 'width', `${((1 - item.secondsLeft / total) * 100).toFixed(0)}%`);
    }

    // Health: permanent pool and the regenerating buffer on one bar, scaled to their total.
    const total = HEALTH.permanentMax + HEALTH.bufferMax;
    this.style('hpPerm', 'width', `${((p.permanentHp / total) * 100).toFixed(1)}%`);
    this.style('hpBuf', 'width', `${((p.bufferHp / total) * 100).toFixed(1)}%`);
    this.e('hpPerm').classList.toggle('bleeding', p.bleeding);
    this.text('armour', p.armourHitsLeft > 0 ? `PLATE ${'■'.repeat(p.armourHitsLeft)}${'□'.repeat(HEALTH.armourPlateHits - p.armourHitsLeft)}` : 'PLATE BROKEN');
    this.text('kits', `MED ${p.medKits}   AMMO ${p.ammoPacks}${p.bleeding ? '   BLEEDING' : ''}`);

    // Reticle: a cross whose gap is the real hip-fire cone. Gone when aimed or sprinting.
    const aimed = w.adsBlend > 0.4;
    const showReticle = p.alive && !aimed && !p.isSprinting && w.action.kind !== 'busy';
    this.style('reticle', 'opacity', showReticle ? '1' : '0');
    const fovHalf = (CAMERA.verticalFovDeg * Math.PI) / 360;
    const gapPx = Math.max(4, (Math.tan(w.currentSpreadRad(p)) / Math.tan(fovHalf)) * (viewportH / 2));
    this.e('reticle').style.setProperty('--gap', `${gapPx.toFixed(1)}px`);

    this.hitMarkerAge += dt;
    this.style('hitmark', 'opacity', this.hitMarkerAge < 0.25 ? '1' : '0');
    this.e('hitmark').classList.toggle('kill', this.hitMarkerKill);
    for (let i = this.hitArcs.length - 1; i >= 0; i--) {
      const arc = this.hitArcs[i];
      if (!arc) continue;
      arc.age += dt;
      if (arc.age > 1.6) {
        arc.el.remove();
        this.hitArcs.splice(i, 1);
        continue;
      }
      // Arcs point at the shooter's world bearing, so they swing round as you turn.
      const rel = wrapAngle(arc.bearingRad - p.yawRad);
      arc.el.style.transform = `rotate(${((-rel * 180) / Math.PI).toFixed(1)}deg)`;
      arc.el.style.opacity = `${Math.min(1, 1.6 - arc.age)}`;
    }
    this.toastAge += dt;
    this.style('toast', 'opacity', this.toastAge < 2.5 ? '1' : '0');

    // Blood-free damage feedback: dirt and focus-loss vignette, stronger at low health.
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.2);
    const low = 1 - Math.min(1, p.healthTotal / (total * 0.6));
    this.style('vignette', 'opacity', Math.min(1, this.damageFlash + low * 0.7).toFixed(2));
    this.style('flash', 'opacity', game.flashAmount.toFixed(2));
  }
}
