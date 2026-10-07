import type { Input } from '../core/input.ts';
import { type HeliInput, neutralHeliInput } from '../sim/helicopter.ts';

// Keys, mouse and touch turned into cyclic, collective and pedals (rules §3:
// gameplay reads actions, never key codes).
//
//   cyclic      the mouse deflects a spring-loaded stick that settles back to
//               the trim position, not to the centre; W/S A/D ramp it like a
//               thumb would. The trim key (T) makes the current cyclic and pedal
//               positions the new neutral — the force-trim release of a real
//               cyclic — so a hover is held hands-off once trimmed (brief: "without
//               it, mouse flying is exhausting");
//   collective  Shift / Ctrl ramp the lever, the wheel moves it in notches; the
//               on-screen lever sets it directly;
//   pedals      Q / E, ramped, around their trimmed position;
//   toggles     SAS (Z), engines (I: cut them for autorotation practice),
//               wheel brakes (B, held).

const MOUSE_STICK_PER_PX = 0.0035;
const MOUSE_RECENTRE_PER_S = 1.2;
const KEY_RATE_PER_S = 2.5;
const PEDAL_RATE_PER_S = 2.2;
const COLLECTIVE_RATE_PER_S = 0.35;
const WHEEL_NOTCH = 0.025;

export class PilotControls {
  readonly input: HeliInput = { ...neutralHeliInput(), collective: 0 };
  /** Forward (stick up, mouse forward, W) raises the nose instead of lowering it. */
  invertPitch = false;
  /** The cyclic and pedal positions the springs return to (set by the trim key). */
  readonly trim = { x: 0, y: 0, pedal: 0 };
  private mouse = { x: 0, y: 0 };
  private keys = { x: 0, y: 0, pedal: 0 };
  private touchStick: { x: number; y: number } | null = null;
  private touchCollective: number | null = null;
  private tiltStick: { x: number; y: number } | null = null;
  /** Mouse movement of the last step (px): the orbit camera uses it when the mouse is not flying. */
  readonly delta = { dx: 0, dy: 0 };
  /** Test scripts pin controls here; null in play. */
  override: Partial<HeliInput> | null = null;

  constructor(private readonly keysIn: Input) {}

  update(dtS: number, mouseFlies: boolean): void {
    const k = this.keysIn;
    k.takeMouseDelta(this.delta);
    const sense = this.invertPitch ? -1 : 1;
    if (mouseFlies) {
      this.mouse.x += this.delta.dx * MOUSE_STICK_PER_PX;
      this.mouse.y += this.delta.dy * MOUSE_STICK_PER_PX * sense;
    }
    const len = Math.hypot(this.mouse.x, this.mouse.y);
    if (len > 1.2) {
      this.mouse.x *= 1.2 / len;
      this.mouse.y *= 1.2 / len;
    }
    const recentre = Math.exp(-MOUSE_RECENTRE_PER_S * dtS);
    this.mouse.x *= recentre;
    this.mouse.y *= recentre;
    if (k.pressed('centreStick')) this.mouse = { x: 0, y: 0 };

    const toward = (current: number, target: number, rate: number): number => current + Math.sign(target - current) * Math.min(Math.abs(target - current), rate * dtS);
    const axis = (pos: boolean, neg: boolean): number => (pos ? 1 : 0) - (neg ? 1 : 0);
    this.keys.y = toward(this.keys.y, sense * axis(k.held('pitchUp'), k.held('pitchDown')), KEY_RATE_PER_S);
    this.keys.x = toward(this.keys.x, axis(k.held('rollRight'), k.held('rollLeft')), KEY_RATE_PER_S);
    this.keys.pedal = toward(this.keys.pedal, axis(k.held('pedalRight'), k.held('pedalLeft')), PEDAL_RATE_PER_S);

    // Deflection from trim: the screen stick under a thumb overrides the mouse and tilt.
    let dx = this.keys.x + this.mouse.x;
    let dy = this.keys.y + this.mouse.y;
    if (this.touchStick) {
      dx += this.touchStick.x;
      dy += this.touchStick.y * sense;
    } else if (this.tiltStick) {
      dx += this.tiltStick.x;
      dy += this.tiltStick.y;
    }
    const i = this.input;
    i.cyclicX = clamp(this.trim.x + dx, -1, 1);
    i.cyclicY = clamp(this.trim.y + dy, -1, 1);
    i.pedal = clamp(this.trim.pedal + this.keys.pedal, -1, 1);

    if (k.pressed('trim')) {
      // The stick stays where it is, now as the neutral: mouse and key deflections fold into the trim.
      this.trim.x = i.cyclicX;
      this.trim.y = i.cyclicY;
      this.trim.pedal = i.pedal;
      this.mouse = { x: 0, y: 0 };
      this.keys = { x: 0, y: 0, pedal: 0 };
    }

    let c = i.collective;
    if (k.held('collectiveUp')) c += COLLECTIVE_RATE_PER_S * dtS;
    if (k.held('collectiveDown')) c -= COLLECTIVE_RATE_PER_S * dtS;
    if (k.pressed('collectiveUp') && !k.held('collectiveUp')) c += WHEEL_NOTCH;
    if (k.pressed('collectiveDown') && !k.held('collectiveDown')) c -= WHEEL_NOTCH;
    if (this.touchCollective !== null) c = this.touchCollective;
    i.collective = clamp(c, 0, 1);
    if (k.pressed('sas')) i.sas = !i.sas;
    if (k.pressed('engines')) i.engines = !i.engines;
    i.brake = k.held('brake') || (i.collective < 0.15 && Math.abs(this.keys.pedal) < 0.01);
    if (this.override) Object.assign(i, this.override);
  }

  /** Resets the trim and the stick (a respawn). */
  resetTrim(collective: number): void {
    this.trim.x = this.trim.y = this.trim.pedal = 0;
    this.mouse = { x: 0, y: 0 };
    this.keys = { x: 0, y: 0, pedal: 0 };
    this.input.collective = collective;
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
