// On-screen controls for phones, tablets and the Android app. Flying needs an
// analogue stick and a throttle lever, not keys:
//
//   left half    a floating stick that appears where the thumb lands: up pushes
//                (nose down), down pulls, sideways rolls — like the mouse stick,
//                it springs back to centre when the thumb lifts;
//   left edge    the throttle lever: drag up and down; the top fifth is reheat;
//   right side   buttons that press the key codes the game already binds
//                (fire, weapon, lock, radar, flares, chaff, camera, gear,
//                brakes), so the rebindable input layer stays the only path;
//   elsewhere    on the right, a drag orbits the camera (orbit view).
// Multi-touch throughout: each finger is tracked by its pointer id.

export interface FlightTouchSink {
  readonly locked: boolean;
  press(code: string): void;
  release(code: string): void;
  addLook(dxPx: number, dyPx: number): void;
}

export interface FlightTouchButton {
  code: string;
  label: string;
  /** Grid position from the bottom-right corner, in button sizes. */
  col: number;
  row: number;
  mode: 'hold' | 'tap';
  big?: boolean;
}

const STICK_RADIUS_PX = 70;
const LEVER_WIDTH_PX = 64;
const BUTTON_PX = 60;

export class FlightTouchControls {
  private readonly root = document.createElement('div');
  private readonly base = document.createElement('div');
  private readonly knob = document.createElement('div');
  private readonly lever = document.createElement('div');
  private readonly leverFill = document.createElement('div');
  private stickId: number | null = null;
  private leverId: number | null = null;
  private readonly lookIds = new Map<number, { x: number; y: number }>();
  private originX = 0;
  private originY = 0;
  /** Stick deflection −1…1 (x right, y up = push), or null when no thumb is on it. */
  stick: { x: number; y: number } | null = null;
  /** Throttle lever 0…1.25. */
  throttle = 0.75;
  /** Called on every touch (the game starts audio and "locks" on the first). */
  onTouch: (() => void) | null = null;

  constructor(
    private readonly sink: FlightTouchSink,
    buttons: FlightTouchButton[],
  ) {
    this.root.className = 'touch';
    this.base.className = 'touch-stick';
    this.knob.className = 'touch-knob';
    this.base.append(this.knob);
    this.lever.className = 'touch-lever';
    this.leverFill.className = 'touch-lever-fill';
    const ab = document.createElement('div');
    ab.className = 'touch-lever-ab';
    ab.textContent = 'AB';
    this.lever.append(this.leverFill, ab);
    this.root.append(this.base, this.lever);
    for (const b of buttons) this.root.append(this.button(b));
    document.body.append(this.root);
    this.root.addEventListener('pointerdown', (e) => this.down(e));
    this.root.addEventListener('pointermove', (e) => this.move(e));
    this.root.addEventListener('pointerup', (e) => this.up(e));
    this.root.addEventListener('pointercancel', (e) => this.up(e));
    this.drawLever();
  }

  set visible(v: boolean) {
    this.root.style.display = v ? 'block' : 'none';
  }

  private button(b: FlightTouchButton): HTMLElement {
    const el = document.createElement('div');
    el.className = b.big ? 'touch-btn big' : 'touch-btn';
    el.textContent = b.label;
    const size = b.big ? BUTTON_PX * 1.5 : BUTTON_PX;
    el.style.width = el.style.height = `${size}px`;
    el.style.right = `${12 + b.col * (BUTTON_PX + 10)}px`;
    el.style.bottom = `${12 + b.row * (BUTTON_PX + 10)}px`;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.onTouch?.();
      el.classList.add('down');
      this.sink.press(b.code);
      if (b.mode === 'tap') {
        // One press: release on the next frame so the game sees a single edge.
        requestAnimationFrame(() => this.sink.release(b.code));
      }
    });
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      el.classList.remove('down');
      if (b.mode === 'hold') this.sink.release(b.code);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    return el;
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    this.onTouch?.();
    const w = window.innerWidth;
    if (e.clientX < LEVER_WIDTH_PX + 16 && this.leverId === null) {
      this.leverId = e.pointerId;
      this.setLever(e.clientY);
    } else if (e.clientX < w * 0.5 && this.stickId === null) {
      this.stickId = e.pointerId;
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.base.style.display = 'block';
      this.base.style.left = `${e.clientX - STICK_RADIUS_PX}px`;
      this.base.style.top = `${e.clientY - STICK_RADIUS_PX}px`;
      this.setStick(e.clientX, e.clientY);
    } else this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.root.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    if (e.pointerId === this.stickId) this.setStick(e.clientX, e.clientY);
    else if (e.pointerId === this.leverId) this.setLever(e.clientY);
    else {
      const last = this.lookIds.get(e.pointerId);
      if (!last) return;
      this.sink.addLook((e.clientX - last.x) * 1.5, (e.clientY - last.y) * 1.5);
      last.x = e.clientX;
      last.y = e.clientY;
    }
  }

  private up(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.stick = null;
      this.base.style.display = 'none';
    } else if (e.pointerId === this.leverId) this.leverId = null;
    else this.lookIds.delete(e.pointerId);
  }

  private setStick(x: number, y: number): void {
    let dx = (x - this.originX) / STICK_RADIUS_PX;
    let dy = (y - this.originY) / STICK_RADIUS_PX;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    // Thumb down = pull (pitch +), like the mouse stick (mouse back pulls).
    this.stick = { x: dx, y: dy };
    this.knob.style.transform = `translate(${dx * STICK_RADIUS_PX * 0.6}px, ${dy * STICK_RADIUS_PX * 0.6}px)`;
  }

  private setLever(y: number): void {
    const h = window.innerHeight;
    const top = h * 0.35;
    const bottom = h * 0.9;
    const f = Math.max(0, Math.min(1, (bottom - y) / (bottom - top)));
    // Bottom 80 % of travel: idle to military; the top 20 %: reheat.
    this.throttle = f <= 0.8 ? f / 0.8 : 1 + ((f - 0.8) / 0.2) * 0.25;
    this.drawLever();
  }

  /** Sets the lever from the game (e.g. after a respawn). */
  setThrottle(t: number): void {
    this.throttle = t;
    this.drawLever();
  }

  private drawLever(): void {
    const f = this.throttle <= 1 ? this.throttle * 0.8 : 0.8 + ((this.throttle - 1) / 0.25) * 0.2;
    this.leverFill.style.height = `${f * 100}%`;
    this.leverFill.classList.toggle('ab', this.throttle > 1.001);
  }
}
