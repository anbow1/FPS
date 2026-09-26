import type { Input } from '../core/input';
import { hyp2 } from '../core/mathx';

/**
 * On-screen controls for phones and tablets. A floating joystick on the left drives the hull,
 * dragging anywhere else aims, and buttons map onto the same virtual keys the keyboard uses,
 * so the game logic has a single input path.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stick: HTMLDivElement;
  private knob: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private fireId: number | null = null;
  active = false;
  private wanted = false;
  onPause: () => void = () => {};

  constructor(private readonly input: Input) {
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div id="touch-look"></div>
      <div id="stick"><div id="stick-knob"></div></div>
      <button class="tbtn big" data-key="Enter" id="t-fire" aria-label="Strzał">OGIEŃ</button>
      <button class="tbtn" data-key="KeyV" id="t-sight" aria-label="Celownik">CEL</button>
      <button class="tbtn" data-key="KeyZ" id="t-zoom" aria-label="Zoom">ZOOM</button>
      <button class="tbtn" data-key="KeyR" id="t-lase" aria-label="Dalmierz">LASER</button>
      <button class="tbtn" data-key="KeyQ" id="t-ammo" aria-label="Amunicja">AMUN.</button>
      <button class="tbtn" data-key="KeyN" id="t-thermal" aria-label="Termowizja">TERMO</button>
      <button class="tbtn" data-key="Space" data-hold="1" id="t-brake" aria-label="Hamulec">STOP</button>
      <button class="tbtn small" data-key="KeyF" id="t-ext" aria-label="Gaśnica">GAŚ</button>
      <button class="tbtn small" id="t-pause" aria-label="Pauza">II</button>
      <button class="tbtn" data-key="KeyM" data-hold="1" id="t-mg" aria-label="Karabin maszynowy">KM</button>
      <button class="tbtn small" data-key="KeyB" id="t-drone" aria-label="Dron">DRON</button>
      <button class="tbtn dronly" data-key="KeyE" data-hold="1" id="t-up" aria-label="W górę">▲</button>
      <button class="tbtn dronly" data-key="KeyQ" data-hold="1" id="t-down" aria-label="W dół">▼</button>
      <button class="tbtn dronly" data-key="KeyG" id="t-back" aria-label="Powrót drona">WRÓĆ</button>`;
    document.body.append(root);
    this.root = root;
    this.stick = root.querySelector('#stick') as HTMLDivElement;
    this.knob = root.querySelector('#stick-knob') as HTMLDivElement;

    const look = root.querySelector('#touch-look') as HTMLDivElement;
    look.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));

    for (const b of root.querySelectorAll<HTMLButtonElement>('.tbtn')) {
      const key = b.dataset.key;
      const hold = b.dataset.hold === '1';
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.add('on');
        if (b.id === 't-pause') {
          this.onPause();
          return;
        }
        if (!key) return;
        if (hold) this.input.hold(key, true);
        else this.input.press(key);
        // the fire button doubles as an aiming pad: slide your thumb to fine-tune
        if (b.id === 't-fire') {
          this.fireId = e.pointerId;
          this.lookLast = { x: e.clientX, y: e.clientY };
        }
      });
      const release = () => {
        b.classList.remove('on');
        if (key && hold) this.input.hold(key, false);
      };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('pointerleave', release);
    }
    // any real touch switches the UI into touch mode (also on hybrid laptops)
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') this.setActive(true);
    }, { capture: true });
    this.setActive(isTouchDevice());
  }

  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    this.input.touchMode = on;
    document.body.classList.toggle('touch', on);
    this.show(this.wanted);
  }

  show(on: boolean): void {
    this.wanted = on;
    this.root.style.display = on && this.active ? '' : 'none';
    if (!on) this.resetStick();
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    const leftZone = e.clientX < window.innerWidth * 0.42;
    if (leftZone && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.stick.classList.add('on');
      this.moveKnob(0, 0);
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      const r = this.stickRadius();
      let dx = e.clientX - this.stickOrigin.x;
      let dy = e.clientY - this.stickOrigin.y;
      const d = hyp2(dx, dy);
      if (d > r) {
        dx = (dx / d) * r;
        dy = (dy / d) * r;
      }
      this.moveKnob(dx, dy);
      // small dead zone, then a slightly progressive response
      const shape = (v: number) => {
        const a = Math.max(0, Math.abs(v) - 0.12) / 0.88;
        return Math.sign(v) * Math.min(1, a * (0.6 + 0.4 * a) * 1.15);
      };
      this.input.stickX = shape(dx / r);
      this.input.stickY = shape(-dy / r);
    } else if (e.pointerId === this.lookId || e.pointerId === this.fireId) {
      this.input.look((e.clientX - this.lookLast.x) * 1.4, (e.clientY - this.lookLast.y) * 1.4);
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId === this.stickId) this.resetStick();
    if (e.pointerId === this.lookId) this.lookId = null;
    if (e.pointerId === this.fireId) this.fireId = null;
  }

  private resetStick(): void {
    this.stickId = null;
    this.stick.classList.remove('on');
    this.input.stickX = 0;
    this.input.stickY = 0;
    this.moveKnob(0, 0);
  }

  private moveKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private stickRadius(): number {
    return Math.max(44, Math.min(window.innerWidth, window.innerHeight) * 0.13);
  }
}

export function isTouchDevice(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}
