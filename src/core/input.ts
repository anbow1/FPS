/** Keyboard + mouse state with pointer lock. Edge-triggered presses are consumed once per frame. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = 0;
  private clicked = 0;
  locked = false;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (['Tab', 'Space', 'F3'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.buttons = 0;
    });
    el.addEventListener('mousedown', (e) => {
      this.buttons |= 1 << e.button;
      this.clicked |= 1 << e.button;
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    el.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
    });
  }

  requestLock(): void {
    if (!this.locked) void this.el.requestPointerLock?.();
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  wasClicked(button: number): boolean {
    return (this.clicked & (1 << button)) !== 0;
  }

  isButton(button: number): boolean {
    return (this.buttons & (1 << button)) !== 0;
  }

  /** Call at the end of each rendered frame. */
  endFrame(): void {
    this.pressed.clear();
    this.clicked = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
