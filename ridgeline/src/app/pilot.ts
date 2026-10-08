import type { Input } from '../core/input.ts';
import { type HeliInput, neutralHeliInput } from '../sim/helicopter.ts';

// Keys and touch turned into cyclic, collective and pedals (rules §3:
// gameplay reads actions, never key codes). The mouse does not fly: it looks
// and aims the gun and the laser (main.ts).
//
//   nose        W pushes the nose down (and the aircraft goes forward), S pulls
//               it up — always, whatever the stick setting; ramped like a thumb;
//   turn        A / D: a turn. In a hover that is mostly a yaw (the tail rotor
//               swings the nose round), with speed it becomes a banked turn —
//               the flight computer coordinates it;
//   yaw         Q / E: the pedals, a pure rotation about the vertical axis;
//   power       with SAS on, the collective lever has three levels and the
//               flight computer flies the height: Shift held = climb, Ctrl held
//               = descend, neither = hold the height. The wheel sets a standing
//               climb or descent in notches (back to the middle to hold).
//               With SAS off the lever is the raw collective, ramped by
//               Shift / Ctrl;
//   trim        T: the current stick becomes neutral;
//   toggles     SAS (Z), engines (I: cut them for autorotation practice),
//               wheel brakes (B, held).
//
// Touch: the left thumb's stick is the cyclic (its sideways throw turns, as
// A / D do), the lever on the left edge springs back to its middle — hold —
// when let go.

const KEY_RATE_PER_S = 2.5;
const PEDAL_RATE_PER_S = 2.2;
const COLLECTIVE_RATE_PER_S = 0.35;
const WHEEL_NOTCH = 0.025;
/** The lever's levels with SAS on: the middle holds the height; the wheel steps a standing climb or descent. */
const LEVER_HOLD = 0.5;
const LEVER_STEP = 0.125;
/** A sideways input's yaw at hover speeds (pedal fraction per unit), fading out as the turn becomes a banked one. */
const TURN_YAW = 0.75;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export class PilotControls {
  readonly input: HeliInput = { ...neutralHeliInput(), collective: 0 };
  /** The touch stick (and tilt) pushed forward raise the nose instead of lowering it. Keys never flip. */
  invertPitch = false;
  /** The cyclic and pedal positions the springs return to (set by the trim key). */
  readonly trim = { x: 0, y: 0, pedal: 0 };
  private keys = { x: 0, y: 0, pedal: 0 };
  /** The standing lever level with SAS on (wheel notches); keys override it while held. */
  private lever = LEVER_HOLD;
  private touchStick: { x: number; y: number } | null = null;
  private touchCollective: number | null = null;
  private tiltStick: { x: number; y: number } | null = null;
  /** Mouse (or right-thumb) movement of the last step (px): it looks and aims. */
  readonly delta = { dx: 0, dy: 0 };
  /** Test scripts pin controls here; null in play. */
  override: Partial<HeliInput> | null = null;

  constructor(private readonly keysIn: Input) {}

  /** `speedMs`: airspeed, which decides how much a sideways input yaws and how much it banks. */
  update(dtS: number, speedMs: number): void {
    const k = this.keysIn;
    k.takeMouseDelta(this.delta);
    const sense = this.invertPitch ? -1 : 1;

    const toward = (current: number, target: number, rate: number): number => current + Math.sign(target - current) * Math.min(Math.abs(target - current), rate * dtS);
    const axis = (pos: boolean, neg: boolean): number => (pos ? 1 : 0) - (neg ? 1 : 0);
    // S pulls (nose up, +), W pushes (nose down, −).
    this.keys.y = toward(this.keys.y, axis(k.held('pitchUp'), k.held('pitchDown')), KEY_RATE_PER_S);
    this.keys.x = toward(this.keys.x, axis(k.held('rollRight'), k.held('rollLeft')), KEY_RATE_PER_S);
    this.keys.pedal = toward(this.keys.pedal, axis(k.held('pedalRight'), k.held('pedalLeft')), PEDAL_RATE_PER_S);

    // Deflection from trim: the screen stick under a thumb overrides tilt.
    let dx = this.keys.x;
    let dy = this.keys.y;
    if (this.touchStick) {
      dx += this.touchStick.x;
      dy += this.touchStick.y * sense;
    } else if (this.tiltStick) {
      dx += this.tiltStick.x;
      dy += this.tiltStick.y;
    }
    dx = clamp(dx, -1, 1);
    // A sideways input turns: at hover speeds mostly by yaw with a little bank, with speed by bank alone.
    const fast = smoothstep(6, 22, speedMs);
    const i = this.input;
    i.cyclicX = clamp(this.trim.x + dx * (0.3 + 0.7 * fast), -1, 1);
    i.cyclicY = clamp(this.trim.y + dy, -1, 1);
    i.pedal = clamp(this.trim.pedal + this.keys.pedal + dx * TURN_YAW * (1 - fast), -1, 1);

    if (k.pressed('trim')) {
      // The stick stays where it is, now as the neutral: key deflections fold into the trim.
      this.trim.x = clamp(this.trim.x + this.keys.x * (0.3 + 0.7 * fast), -1, 1);
      this.trim.y = i.cyclicY;
      // Under SAS a trimmed pedal would be a standing turn: the computer already holds the heading.
      this.trim.pedal = i.sas ? 0 : i.pedal;
      this.keys = { x: 0, y: 0, pedal: 0 };
    }

    let c = i.collective;
    if (i.sas) {
      // Three levels and the wheel's standing climb or descent.
      if (k.pressed('collectiveUp') && !k.held('collectiveUp')) this.lever = clamp(this.lever + LEVER_STEP, 0, 1);
      if (k.pressed('collectiveDown') && !k.held('collectiveDown')) this.lever = clamp(this.lever - LEVER_STEP, 0, 1);
      c = k.held('collectiveUp') ? 1 : k.held('collectiveDown') ? 0 : this.lever;
    } else {
      if (k.held('collectiveUp')) c += COLLECTIVE_RATE_PER_S * dtS;
      if (k.held('collectiveDown')) c -= COLLECTIVE_RATE_PER_S * dtS;
      if (k.pressed('collectiveUp') && !k.held('collectiveUp')) c += WHEEL_NOTCH;
      if (k.pressed('collectiveDown') && !k.held('collectiveDown')) c -= WHEEL_NOTCH;
    }
    if (this.touchCollective !== null) c = this.touchCollective;
    i.collective = clamp(c, 0, 1);
    if (k.pressed('sas')) {
      i.sas = !i.sas;
      // Switching the computer on puts the lever in its hold detent; off, the raw lever starts at a hover.
      this.lever = LEVER_HOLD;
      i.collective = LEVER_HOLD;
    }
    if (k.pressed('engines')) i.engines = !i.engines;
    // Parking brakes while the lever is down: at or under the hold detent with SAS (it does not climb off the
    // ground there), or near the bottom raw. Pedals release them for taxiing turns.
    const parked = i.sas ? i.collective <= LEVER_HOLD + 0.08 : i.collective < 0.15;
    i.brake = k.held('brake') || (parked && Math.abs(this.keys.pedal) < 0.01);
    if (this.override) Object.assign(i, this.override);
  }

  /** Resets the trim and the stick (a respawn); the lever goes to its hold detent (SAS) or `collective` (raw). */
  resetTrim(collective: number): void {
    this.trim.x = this.trim.y = this.trim.pedal = 0;
    this.keys = { x: 0, y: 0, pedal: 0 };
    this.lever = LEVER_HOLD;
    this.input.collective = this.input.sas ? LEVER_HOLD : collective;
  }

  /** Touch: the screen stick (deflection from trim, y up = push), or null; and the collective lever 0…1, or null. */
  setTouch(stick: { x: number; y: number } | null, collective: number | null): void {
    this.touchStick = stick ? { x: clamp(stick.x, -1, 1), y: clamp(stick.y, -1, 1) } : null;
    this.touchCollective = collective === null ? null : clamp(collective, 0, 1);
  }

  setTilt(stick: { x: number; y: number } | null): void {
    this.tiltStick = stick;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
