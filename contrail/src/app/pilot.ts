import type { Input } from '../core/input.ts';
import type { PilotInput } from '../sim/controlLaws.ts';

// Turns keys and the mouse into stick, pedals and throttle (rules §3: gameplay
// reads actions, never key codes). The mouse moves a spring-loaded virtual
// stick: movement deflects it, it re-centres over ~0.7 s when the mouse rests,
// so a quick flick is a quick pull and letting go flies hands-off. Keys ramp
// the stick at a finite rate, like a thumb on a real one. The throttle has an
// afterburner detent: past 100 % only with a fresh press.

const MOUSE_STICK_PER_PX = 0.0045; // tuned by hand: ~220 px for full deflection
const MOUSE_RECENTRE_PER_S = 1.4;
const KEY_RATE_PER_S = 3.5;
const PEDAL_RATE_PER_S = 3;
const THROTTLE_RATE_PER_S = 0.45;

export class PilotControls {
  readonly input: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.75, limiterRelaxed: false };
  private mouseStick = { x: 0, y: 0 };
  private keyStick = { pitch: 0, roll: 0, yaw: 0 };
  private atDetent = false;
  /** Test scripts (?autostart hooks) pin stick axes here; null in play. */
  override: Partial<Pick<PilotInput, 'pitch' | 'roll' | 'yaw' | 'throttle'>> | null = null;
  /** Mouse movement of the last step (px): the orbit camera uses it when the mouse is not flying. */
  readonly delta = { dx: 0, dy: 0 };

  constructor(private readonly keys: Input) {}

  /** Reads this step's input; `mouseFlies` is false while the mouse orbits a camera instead. */
  update(dtS: number, mouseFlies: boolean): void {
    const k = this.keys;
    this.keys.takeMouseDelta(this.delta);
    if (mouseFlies) {
      this.mouseStick.x += this.delta.dx * MOUSE_STICK_PER_PX;
      this.mouseStick.y += this.delta.dy * MOUSE_STICK_PER_PX;
    }
    const len = Math.hypot(this.mouseStick.x, this.mouseStick.y);
    if (len > 1) {
      this.mouseStick.x /= len;
      this.mouseStick.y /= len;
    }
    const recentre = Math.exp(-MOUSE_RECENTRE_PER_S * dtS);
    this.mouseStick.x *= recentre;
    this.mouseStick.y *= recentre;
    if (k.pressed('centreStick')) this.mouseStick = { x: 0, y: 0 };

    const toward = (current: number, target: number, rate: number): number => current + Math.sign(target - current) * Math.min(Math.abs(target - current), rate * dtS);
    const axis = (pos: boolean, neg: boolean): number => (pos ? 1 : 0) - (neg ? 1 : 0);
    this.keyStick.pitch = toward(this.keyStick.pitch, axis(k.held('pitchUp'), k.held('pitchDown')), KEY_RATE_PER_S);
    this.keyStick.roll = toward(this.keyStick.roll, axis(k.held('rollRight'), k.held('rollLeft')), KEY_RATE_PER_S);
    this.keyStick.yaw = toward(this.keyStick.yaw, axis(k.held('yawRight'), k.held('yawLeft')), PEDAL_RATE_PER_S);

    // Mouse forward (dy < 0) pushes, back pulls: the stick is between the pilot's knees.
    this.input.pitch = clamp(this.keyStick.pitch + this.mouseStick.y, -1, 1);
    this.input.roll = clamp(this.keyStick.roll + this.mouseStick.x, -1, 1);
    this.input.yaw = this.keyStick.yaw;

    let t = this.input.throttle;
    // The afterburner detent: the lever stops at 100 %; a fresh press at the stop arms the burner range.
    if (k.pressed('throttleUp') && t >= 0.999) this.atDetent = true;
    if (k.held('throttleUp')) t += THROTTLE_RATE_PER_S * dtS;
    if (k.held('throttleDown')) t -= THROTTLE_RATE_PER_S * dtS;
    if (t <= 0.999) this.atDetent = false;
    if (!this.atDetent) t = Math.min(t, 1);
    this.input.throttle = clamp(t, 0, 1.25);
    if (k.pressed('limiter')) this.input.limiterRelaxed = !this.input.limiterRelaxed;
    if (this.override) Object.assign(this.input, this.override);
  }

  /** Touch: the on-screen stick (−1…1 each) and throttle lever (0…1.25) set the input directly. */
  setTouch(stickX: number, stickY: number, throttle: number): void {
    this.mouseStick = { x: clamp(stickX, -1, 1), y: clamp(stickY, -1, 1) };
    this.input.throttle = clamp(throttle, 0, 1.25);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
