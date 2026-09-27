// On-screen controls for phones and tablets (and the Android app). The left
// part of the screen is a floating movement stick: it appears where the thumb
// lands and presses W/A/S/D (and sprint when pushed to the rim). The rest of
// the screen is look: drags feed the same pixel deltas a mouse would. Buttons
// press the key codes the game already binds, so the rebindable input layer
// and every gameplay system stay untouched.

export interface TouchSink {
  readonly locked: boolean;
  press(code: string): void;
  release(code: string): void;
  addLook(dxPx: number, dyPx: number): void;
  exitLock(): void;
}

export interface TouchButtonSpec {
  code: string;
  label: string;
  /** Position from the bottom-right corner, in multiples of the button size. */
  col: number;
  row: number;
  /** hold: down while touched · tap: one press · toggle: stays down until tapped again. */
  mode?: 'hold' | 'tap' | 'toggle';
  big?: boolean;
}

export interface TouchLayout {
  buttons: TouchButtonSpec[];
  /** Codes the stick presses: forward, back, left, right, and sprint at the rim. */
  stick: { forward: string; back: string; left: string; right: string; sprint: string };
  /** Look speed relative to mouse pixels (a thumb drag covers less distance than a mouse). */
  lookScale: number;
}

const STICK_RADIUS_PX = 60;
const DEAD_ZONE = 0.3;
const SPRINT_AT = 0.95;
const BUTTON_PX = 58;

export class TouchControls {
  private readonly root = document.createElement('div');
  private readonly knob = document.createElement('div');
  private readonly base = document.createElement('div');
  private stickId: number | null = null;
  private stickX = 0;
  private stickY = 0;
  private readonly stickHeld = new Set<string>();
  private readonly lookIds = new Map<number, { x: number; y: number }>();
  private readonly toggled = new Set<string>();

  constructor(
    private readonly sink: TouchSink,
    private readonly layout: TouchLayout,
  ) {
    this.root.className = 'touch';
    this.base.className = 'touch-stick';
    this.knob.className = 'touch-knob';
    this.base.append(this.knob);
    this.root.append(this.base);
    const pause = document.createElement('button');
    pause.className = 'touch-btn touch-pause';
    pause.textContent = 'II';
    pause.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.releaseAll();
      this.sink.exitLock();
    });
    this.root.append(pause);
    for (const b of layout.buttons) this.root.append(this.button(b));
    this.root.addEventListener('pointerdown', (e) => this.onDown(e));
    this.root.addEventListener('pointermove', (e) => this.onMove(e));
    this.root.addEventListener('pointerup', (e) => this.onUp(e));
    this.root.addEventListener('pointercancel', (e) => this.onUp(e));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(this.root);
    document.body.classList.add('touch-mode');
    injectStyle();
    // The Android app's back button calls this: pause if playing (returns true), else let the app go back.
    (window as unknown as { __gamePause?: () => boolean }).__gamePause = () => {
      if (!this.sink.locked) return false;
      this.releaseAll();
      this.sink.exitLock();
      return true;
    };
  }

  /** Once per display frame: shown only while the game has the (virtual) lock. */
  update(): void {
    const on = this.sink.locked;
    this.root.classList.toggle('on', on);
    if (!on) this.releaseAll();
  }

  private button(spec: TouchButtonSpec): HTMLElement {
    const el = document.createElement('button');
    el.className = `touch-btn${spec.big ? ' big' : ''}`;
    el.textContent = spec.label;
    const size = spec.big ? BUTTON_PX * 1.35 : BUTTON_PX;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.right = `${16 + spec.col * (BUTTON_PX + 10)}px`;
    el.style.bottom = `${16 + spec.row * (BUTTON_PX + 10)}px`;
    const mode = spec.mode ?? 'hold';
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      if (mode === 'toggle') {
        if (this.toggled.has(spec.code)) {
          this.toggled.delete(spec.code);
          this.sink.release(spec.code);
          el.classList.remove('down');
        } else {
          this.toggled.add(spec.code);
          this.sink.press(spec.code);
          el.classList.add('down');
        }
        return;
      }
      this.sink.press(spec.code);
      el.classList.add('down');
      // A tap must still be seen as held for at least one fixed step.
      if (mode === 'tap') window.setTimeout(() => this.up(el, spec.code), 50);
    });
    const end = (e: PointerEvent): void => {
      e.stopPropagation();
      if (mode === 'hold') this.up(el, spec.code);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return el;
  }

  private up(el: HTMLElement, code: string): void {
    this.sink.release(code);
    el.classList.remove('down');
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    this.root.setPointerCapture(e.pointerId);
    if (this.stickId === null && e.clientX < window.innerWidth * 0.4) {
      this.stickId = e.pointerId;
      this.stickX = e.clientX;
      this.stickY = e.clientY;
      this.base.style.left = `${e.clientX - STICK_RADIUS_PX}px`;
      this.base.style.top = `${e.clientY - STICK_RADIUS_PX}px`;
      this.base.classList.add('on');
      this.knob.style.transform = 'translate(0px, 0px)';
      return;
    }
    this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      let dx = (e.clientX - this.stickX) / STICK_RADIUS_PX;
      let dy = (e.clientY - this.stickY) / STICK_RADIUS_PX;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      this.knob.style.transform = `translate(${dx * STICK_RADIUS_PX}px, ${dy * STICK_RADIUS_PX}px)`;
      const s = this.layout.stick;
      const want = new Set<string>();
      if (dy < -DEAD_ZONE) want.add(s.forward);
      if (dy > DEAD_ZONE) want.add(s.back);
      if (dx < -DEAD_ZONE) want.add(s.left);
      if (dx > DEAD_ZONE) want.add(s.right);
      if (len > SPRINT_AT && dy < -0.6) want.add(s.sprint);
      this.setStick(want);
      return;
    }
    const last = this.lookIds.get(e.pointerId);
    if (!last) return;
    const k = this.layout.lookScale;
    this.sink.addLook((e.clientX - last.x) * k, (e.clientY - last.y) * k);
    last.x = e.clientX;
    last.y = e.clientY;
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.base.classList.remove('on');
      this.setStick(new Set());
      return;
    }
    this.lookIds.delete(e.pointerId);
  }

  private setStick(want: Set<string>): void {
    for (const code of this.stickHeld) {
      if (!want.has(code)) {
        this.sink.release(code);
        this.stickHeld.delete(code);
      }
    }
    for (const code of want) {
      if (!this.stickHeld.has(code)) {
        this.sink.press(code);
        this.stickHeld.add(code);
      }
    }
  }

  private releaseAll(): void {
    this.setStick(new Set());
    this.stickId = null;
    this.base.classList.remove('on');
    this.lookIds.clear();
    for (const code of this.toggled) this.sink.release(code);
    this.toggled.clear();
    this.root.querySelectorAll('.touch-btn.down').forEach((el) => el.classList.remove('down'));
  }
}

let styled = false;

function injectStyle(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
    .touch { position: fixed; inset: 0; display: none; touch-action: none; user-select: none; -webkit-user-select: none; z-index: 5; }
    .touch.on { display: block; }
    .touch-stick { position: absolute; width: ${STICK_RADIUS_PX * 2}px; height: ${STICK_RADIUS_PX * 2}px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.35); background: rgba(0,0,0,0.12); display: none; pointer-events: none; }
    .touch-stick.on { display: block; }
    .touch-knob { position: absolute; left: ${STICK_RADIUS_PX - 26}px; top: ${STICK_RADIUS_PX - 26}px; width: 52px; height: 52px;
      border-radius: 50%; background: rgba(255,255,255,0.4); }
    .touch-btn { position: absolute; border-radius: 50%; border: 2px solid rgba(255,255,255,0.45); background: rgba(10,14,16,0.35);
      color: rgba(255,255,255,0.9); font: 600 13px system-ui, sans-serif; letter-spacing: 0.04em; padding: 0; touch-action: none; }
    .touch-btn.big { font-size: 15px; }
    .touch-btn.down { background: rgba(255,255,255,0.35); color: #111; }
    .touch-pause { left: 14px; top: 14px; width: 44px; height: 44px; font-size: 14px; }
    /* Bottom-right HUD readouts would sit under the fire button: lift them to the top right. */
    .touch-mode .ammo { top: 16px; bottom: auto; }
    .touch-mode .hud-health { top: calc(var(--u) * 4.4); bottom: auto; }
  `;
  document.head.append(css);
}
