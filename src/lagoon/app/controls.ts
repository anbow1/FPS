import { Input } from '../../core/input.ts';
import { LAGOON_PLAYER } from '../config.ts';
import { emptyIntent, type LagoonIntent } from '../game/game.ts';

// The lagoon's actions and their default keys (brief §12). Gameplay reads
// actions, never key codes (rules §10). Mouse look is read every display
// frame and banked until the next fixed step consumes it.

export type LagoonAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'jump'
  | 'interact'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'rifle'
  | 'knife'
  | 'stone'
  | 'holster'
  | 'inventory'
  | 'weather'
  | 'time'
  | 'pause';

export const LAGOON_BINDINGS: Record<LagoonAction, readonly string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  interact: ['KeyE'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
  reload: ['KeyR'],
  rifle: ['Digit1'],
  knife: ['Digit2'],
  stone: ['Digit3'],
  holster: ['KeyH'],
  inventory: ['KeyI', 'Tab'],
  weather: ['KeyT'],
  time: ['KeyN'],
  pause: ['Escape'],
};

export const LAGOON_BINDINGS_KEY = 'lagoon.bindings.v1';

export class LagoonControls {
  readonly input: Input<LagoonAction>;
  pendingYawRad = 0;
  pendingPitchRad = 0;
  sensitivity = 1;
  invertY = false;
  private readonly mouse = { dx: 0, dy: 0 };

  constructor(target: HTMLElement) {
    this.input = new Input<LagoonAction>(target, LAGOON_BINDINGS, LAGOON_BINDINGS_KEY);
  }

  /** Once per display frame. Aiming down the sights slows the mouse a little. */
  readMouse(adsBlend: number, lookEnabled: boolean): void {
    this.input.takeMouseDelta(this.mouse);
    if (!lookEnabled) return;
    const k = (LAGOON_PLAYER.mouseRadPerPixel * this.sensitivity) / (1 + 0.3 * adsBlend);
    this.pendingYawRad += this.mouse.dx * k;
    this.pendingPitchRad += this.mouse.dy * k * (this.invertY ? -1 : 1);
  }

  /** Once per fixed step. Edges live for exactly one step. */
  buildIntent(gameplay: boolean): LagoonIntent {
    const i = this.input;
    const intent = emptyIntent();
    intent.lookYawRad = this.pendingYawRad;
    intent.lookPitchRad = this.pendingPitchRad;
    this.pendingYawRad = 0;
    this.pendingPitchRad = 0;
    if (!gameplay) return intent;
    intent.move.moveRight = (i.held('right') ? 1 : 0) - (i.held('left') ? 1 : 0);
    intent.move.moveForward = (i.held('forward') ? 1 : 0) - (i.held('back') ? 1 : 0);
    intent.move.sprint = i.held('sprint');
    intent.move.jump = i.pressed('jump');
    intent.interactPressed = i.pressed('interact');
    const t = intent.triggers;
    t.firePressed = i.pressed('fire');
    t.fireHeld = i.held('fire');
    t.fireReleased = i.released('fire');
    t.aimHeld = i.held('aim');
    t.reloadPressed = i.pressed('reload');
    t.selectSlot = i.pressed('rifle') ? 'rifle' : i.pressed('knife') ? 'knife' : i.pressed('stone') ? 'stone' : i.pressed('holster') ? 'hands' : null;
    intent.cycleTime = i.pressed('time');
    intent.cycleWeather = i.pressed('weather');
    return intent;
  }
}
