// Rebindable input layer. Gameplay asks for actions ("fire", "limiter"), never
// for event.code (rules §10). Bindings persist in localStorage.

export type Action =
  | 'pitchUp'
  | 'pitchDown'
  | 'rollLeft'
  | 'rollRight'
  | 'yawLeft'
  | 'yawRight'
  | 'throttleUp'
  | 'throttleDown'
  | 'limiter'
  | 'camera'
  | 'debug'
  | 'fire'
  | 'pause'
  | 'quality'
  | 'toneMap'
  | 'centreStick'
  | 'gear'
  | 'brake'
  | 'timeOfDay'
  | 'weapon'
  | 'designate'
  | 'radarMode'
  | 'flare'
  | 'chaff'
  | 'rangeUp'
  | 'rangeDown'
  | 'antennaUp'
  | 'antennaDown';

// Mouse0 / Mouse2 are the left / right buttons; WheelUp / WheelDown are edges only.
// Pull = nose up = S / Down, as on a real stick (pull back to climb).
export const DEFAULT_BINDINGS: Record<Action, readonly string[]> = {
  pitchUp: ['KeyS', 'ArrowDown'],
  pitchDown: ['KeyW', 'ArrowUp'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'WheelUp'],
  throttleDown: ['ControlLeft', 'WheelDown'],
  limiter: ['KeyL'],
  camera: ['KeyC'],
  debug: ['KeyH'],
  fire: ['Mouse0', 'Space'],
  pause: ['Escape', 'KeyP'],
  quality: ['KeyO'],
  toneMap: ['KeyT'],
  centreStick: ['Mouse2'],
  gear: ['KeyG'],
  brake: ['KeyB'],
  timeOfDay: ['KeyK'],
  weapon: ['KeyX'],
  designate: ['KeyV'],
  radarMode: ['KeyR'],
  flare: ['KeyF'],
  chaff: ['KeyZ'],
  rangeUp: ['Period'],
  rangeDown: ['Comma'],
  antennaUp: ['PageUp'],
  antennaDown: ['PageDown'],
};

const STORAGE_KEY = 'contrail.bindings.v1';

export class Input {
  private readonly heldCodes = new Set<string>();
  private readonly pressedCodes = new Set<string>();
  private readonly releasedCodes = new Set<string>();
  private bindings: Record<Action, readonly string[]>;
  private mouseDxPx = 0;
  private mouseDyPx = 0;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  /**
   * Phones and tablets have no pointer lock and no keyboard: the game "locks"
   * virtually, and the on-screen controls (ui/touch.ts) feed key codes and
   * look deltas through press / release / addLook.
   */
  readonly touch = isTouchDevice();

  constructor(private readonly target: HTMLElement) {
    this.bindings = loadBindings();
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down(e.code);
      if (this.locked && (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Control'))) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.up(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    target.addEventListener('mousedown', (e) => {
      // A tap on a touch screen also fires a synthetic mousedown: the on-screen fire button owns Mouse0.
      if (this.touch) return;
      this.down(`Mouse${e.button}`);
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => this.up(`Mouse${e.button}`));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener(
      'wheel',
      (e) => {
        this.pressedCodes.add(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
        e.preventDefault();
      },
      { passive: false },
    );
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDxPx += e.movementX;
      this.mouseDyPx += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.releaseAll();
      this.onLockChange?.(this.locked);
    });
  }

  requestLock(): void {
    if (this.touch) {
      this.setVirtualLock(true);
      return;
    }
    const result: unknown = this.target.requestPointerLock();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.warn('pointer lock refused:', err);
      });
    }
  }

  exitLock(): void {
    if (this.touch) {
      this.setVirtualLock(false);
      return;
    }
    if (document.pointerLockElement) document.exitPointerLock();
  }

  held(action: Action): boolean {
    for (const code of this.bindings[action]) if (this.heldCodes.has(code)) return true;
    return false;
  }

  pressed(action: Action): boolean {
    for (const code of this.bindings[action]) if (this.pressedCodes.has(code)) return true;
    return false;
  }

  released(action: Action): boolean {
    for (const code of this.bindings[action]) if (this.releasedCodes.has(code)) return true;
    return false;
  }

  /** Mouse movement since the last call, in pixels. */
  takeMouseDelta(out: { dx: number; dy: number }): void {
    out.dx = this.mouseDxPx;
    out.dy = this.mouseDyPx;
    this.mouseDxPx = 0;
    this.mouseDyPx = 0;
  }

  /** Called once after each fixed step: edges live for exactly one step. */
  endStep(): void {
    this.pressedCodes.clear();
    this.releasedCodes.clear();
  }

  getBindings(): Readonly<Record<Action, readonly string[]>> {
    return this.bindings;
  }

  rebind(action: Action, code: string): void {
    this.bindings = { ...this.bindings, [action]: [code] };
    saveBindings(this.bindings);
  }

  resetBindings(): void {
    this.bindings = { ...DEFAULT_BINDINGS };
    saveBindings(this.bindings);
  }

  /** On-screen control pressed (touch mode). */
  press(code: string): void {
    this.down(code);
  }

  /** On-screen control released (touch mode). */
  release(code: string): void {
    this.up(code);
  }

  /** Look input from a touch drag, in the same pixel units as mouse movement. */
  addLook(dxPx: number, dyPx: number): void {
    if (!this.locked) return;
    this.mouseDxPx += dxPx;
    this.mouseDyPx += dyPx;
  }

  private setVirtualLock(on: boolean): void {
    if (this.locked === on) return;
    this.locked = on;
    if (!on) this.releaseAll();
    this.onLockChange?.(on);
  }

  private down(code: string): void {
    if (!this.heldCodes.has(code)) this.pressedCodes.add(code);
    this.heldCodes.add(code);
  }

  private up(code: string): void {
    if (this.heldCodes.has(code)) this.releasedCodes.add(code);
    this.heldCodes.delete(code);
  }

  private releaseAll(): void {
    for (const code of this.heldCodes) this.releasedCodes.add(code);
    this.heldCodes.clear();
  }
}

function loadBindings(): Record<Action, readonly string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_BINDINGS };
    const result: Record<Action, readonly string[]> = { ...DEFAULT_BINDINGS };
    for (const action of Object.keys(DEFAULT_BINDINGS) as Action[]) {
      const value = (parsed as Record<string, unknown>)[action];
      if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) result[action] = value;
    }
    return result;
  } catch (err) {
    console.warn('stored key bindings unreadable, using defaults:', err);
    return { ...DEFAULT_BINDINGS };
  }
}

function saveBindings(bindings: Record<Action, readonly string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch (err) {
    console.warn('could not save key bindings:', err);
  }
}

/** A coarse pointer with touch points (phone, tablet, the Android app), or `?touch` for testing. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).has('touch')) return true;
  return navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
}
