// Rebindable input layer. Gameplay asks for actions ("fire", "reload"), never
// for event.code (rules §10). Bindings persist in localStorage. Each game
// passes its own action set and default bindings; `Action` is the FPS's.

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'jump'
  | 'crouch'
  | 'prone'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'fireMode'
  | 'weapon1'
  | 'weapon2'
  | 'weapon3'
  | 'grenade'
  | 'grenadeCycle'
  | 'holdBreath'
  | 'rangeFinder'
  | 'zoom'
  | 'suppressor'
  | 'medKit'
  | 'ammoPack'
  | 'interact'
  | 'pause';

// Mouse0 / Mouse2 are the left / right buttons; WheelUp / WheelDown are edges only.
export const DEFAULT_BINDINGS: Record<Action, readonly string[]> = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  sprint: ['ShiftLeft'],
  jump: ['Space'],
  crouch: ['KeyC', 'ControlLeft'],
  prone: ['KeyZ'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
  reload: ['KeyR'],
  fireMode: ['KeyB'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  grenade: ['KeyG'],
  grenadeCycle: ['Digit4', 'WheelDown'],
  holdBreath: ['ShiftLeft'],
  rangeFinder: ['KeyT'],
  zoom: ['KeyV', 'WheelUp'],
  suppressor: ['KeyN'],
  medKit: ['KeyH'],
  ammoPack: ['KeyJ'],
  interact: ['KeyF'],
  pause: ['Escape', 'KeyP'],
};

export const FPS_BINDINGS_KEY = 'fps.bindings.v1';

export class Input<A extends string = Action> {
  private readonly heldCodes = new Set<string>();
  private readonly pressedCodes = new Set<string>();
  private readonly releasedCodes = new Set<string>();
  private bindings: Record<A, readonly string[]>;
  private mouseDxPx = 0;
  private mouseDyPx = 0;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(
    private readonly target: HTMLElement,
    private readonly defaults: Readonly<Record<A, readonly string[]>>,
    private readonly storageKey: string,
  ) {
    this.bindings = loadBindings(defaults, storageKey);
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down(e.code);
      if (this.locked && (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Control'))) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.up(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    target.addEventListener('mousedown', (e) => {
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
    const result: unknown = this.target.requestPointerLock();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.warn('pointer lock refused:', err);
      });
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  held(action: A): boolean {
    for (const code of this.bindings[action]) if (this.heldCodes.has(code)) return true;
    return false;
  }

  pressed(action: A): boolean {
    for (const code of this.bindings[action]) if (this.pressedCodes.has(code)) return true;
    return false;
  }

  released(action: A): boolean {
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

  getBindings(): Readonly<Record<A, readonly string[]>> {
    return this.bindings;
  }

  rebind(action: A, code: string): void {
    this.bindings = { ...this.bindings, [action]: [code] };
    saveBindings(this.bindings, this.storageKey);
  }

  resetBindings(): void {
    this.bindings = { ...this.defaults };
    saveBindings(this.bindings, this.storageKey);
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

function loadBindings<A extends string>(defaults: Readonly<Record<A, readonly string[]>>, storageKey: string): Record<A, readonly string[]> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { ...defaults };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...defaults };
    const result: Record<A, readonly string[]> = { ...defaults };
    for (const action of Object.keys(defaults) as A[]) {
      const value = (parsed as Record<string, unknown>)[action];
      if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) result[action] = value;
    }
    return result;
  } catch (err) {
    console.warn('stored key bindings unreadable, using defaults:', err);
    return { ...defaults };
  }
}

function saveBindings<A extends string>(bindings: Record<A, readonly string[]>, storageKey: string): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(bindings));
  } catch (err) {
    console.warn('could not save key bindings:', err);
  }
}
