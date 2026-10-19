// Tilt steering for phones: the gravity vector from the motion sensor
// (`devicemotion`, accelerationIncludingGravity — no permission needed on
// Android) turned into stick deflections, relative to how the phone was held
// when calibrated. Holding the phone in landscape like a small yoke:
//
//   roll   turn it like a steering wheel (right side down = roll right);
//   pitch  tilt the top edge towards you to pull (nose up), away to push.
//
// The two are measured apart: roll as the turn about the screen's normal (a
// wheel's angle, the same however far back the phone leans), pitch as the lean
// of the screen itself (unchanged by turning it). Taken together from one
// angle, turning the wheel moved the nose and the roll grew weak as the phone
// leant back. Neutral is how the phone is held just after "tap to fly",
// averaged over a moment, so the jolt of the tap itself is not taken for it.
//
// A small dead zone keeps hands-off flight steady, a low-pass filter takes out
// hand tremor, and the angles for full deflection are modest (30° roll, 25°
// pitch) so the screen stays readable. The maths is a pure function so it can
// be tested without a phone.

export interface Gravity {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
const FULL_ROLL_RAD = 30 * DEG;
const FULL_PITCH_RAD = 25 * DEG;
const DEAD_RAD = 2.5 * DEG;
/** Readings averaged into a calibration: ~0.4 s at the usual 60 Hz, after the tap's jolt has passed. */
const CAL_READINGS = 24;

/**
 * The reaction-to-gravity vector in screen axes (x right, y up, z out of the screen) for the current
 * screen orientation angle (0, 90, 180, 270). Device axes are those of the portrait-held phone.
 */
export function toScreen(g: Gravity, screenAngleDeg: number): Gravity {
  const a = ((Math.round(screenAngleDeg / 90) % 4) + 4) % 4;
  if (a === 1) return { x: -g.y, y: g.x, z: g.z };
  if (a === 2) return { x: -g.x, y: -g.y, z: g.z };
  if (a === 3) return { x: g.y, y: -g.x, z: g.z };
  return { ...g };
}

/** Roll (right +) and pitch (top edge towards you +) angles of the screen, in radians. */
export function tiltAngles(s: Gravity): { roll: number; pitch: number } {
  const inPlane = Math.hypot(s.x, s.y);
  const g = Math.max(1e-6, Math.hypot(inPlane, s.z));
  // The wheel's angle: the up vector turns in the screen's plane, toward its left when the right side goes
  // down. Lying nearly flat that plane holds little of it, so there the lean toward the side takes over.
  const wheel = Math.atan2(-s.x, s.y);
  const lean = Math.atan2(-s.x, Math.hypot(s.y, s.z));
  const k = Math.min(1, Math.max(0, (inPlane / g - 0.2) / 0.2));
  const roll = lean + (wheel - lean) * k;
  // The screen's own lean back from upright: turning it like a wheel leaves this alone.
  const pitch = Math.atan2(inPlane, s.z);
  return { roll, pitch };
}

/** Stick deflections (−1…1) from the angles relative to the calibrated neutral. */
export function tiltStick(angles: { roll: number; pitch: number }, neutral: { roll: number; pitch: number }): { x: number; y: number } {
  const shape = (d: number, full: number): number => {
    const m = Math.max(0, Math.abs(d) - DEAD_RAD) / (full - DEAD_RAD);
    // (No −0 inside the dead zone: callers compare against a centred stick.)
    return m === 0 ? 0 : Math.sign(d) * Math.min(1, m);
  };
  // Wrap: atan2 jumps at ±π.
  const wrap = (d: number): number => (d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d);
  return { x: shape(wrap(angles.roll - neutral.roll), FULL_ROLL_RAD), y: shape(wrap(angles.pitch - neutral.pitch), FULL_PITCH_RAD) };
}

export class TiltSteering {
  /** Steering by tilt is on (the sensor is listened to either way, so switching on is instant). */
  enabled = false;
  /** Seen at least one sensor reading (the device has the sensor). */
  available = false;
  private filtered: Gravity | null = null;
  private neutral: { roll: number; pitch: number } | null = null;
  /** Readings still to take into the neutral, and their sum: a calibration averages ~0.4 s of holding. */
  private calLeft = 0;
  private readonly calSum = { x: 0, y: 0, z: 0 };
  /** Current stick from tilt (x roll right +, y pull +). */
  readonly stick = { x: 0, y: 0 };

  constructor() {
    window.addEventListener('devicemotion', (e) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x === null || g.y === null || g.z === null) return;
      this.available = true;
      const raw = toScreen({ x: g.x, y: g.y, z: g.z }, screen.orientation?.angle ?? 0);
      // Low-pass (~6 Hz at 60 Hz sensor rate): steady, but not laggy.
      if (!this.filtered) this.filtered = raw;
      else {
        const k = 0.35;
        this.filtered = { x: this.filtered.x + (raw.x - this.filtered.x) * k, y: this.filtered.y + (raw.y - this.filtered.y) * k, z: this.filtered.z + (raw.z - this.filtered.z) * k };
      }
      if (!this.neutral && this.calLeft === 0) this.calibrate();
      if (this.calLeft > 0) {
        // Hands off while the neutral is being taken.
        this.calSum.x += raw.x;
        this.calSum.y += raw.y;
        this.calSum.z += raw.z;
        if (--this.calLeft === 0) this.neutral = tiltAngles(this.calSum);
        this.stick.x = 0;
        this.stick.y = 0;
        return;
      }
      const s = tiltStick(tiltAngles(this.filtered), this.neutral ?? { roll: 0, pitch: 0 });
      this.stick.x = s.x;
      this.stick.y = s.y;
    });
  }

  /**
   * Switches tilt steering on (calibrating to the way the phone is held now) or off. Call from a tap: iOS
   * asks for motion-sensor permission, and only grants it inside a user gesture.
   */
  async setEnabled(on: boolean): Promise<boolean> {
    if (on) {
      const ask = (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
      if (ask) {
        try {
          if ((await ask()) !== 'granted') return (this.enabled = false);
        } catch {
          return (this.enabled = false);
        }
      }
      this.calibrate();
    }
    this.enabled = on;
    return on;
  }

  /** The way the phone is held over the next moment becomes neutral (hands off): on "tap to fly" and CAL. */
  calibrate(): void {
    this.calLeft = CAL_READINGS;
    this.calSum.x = this.calSum.y = this.calSum.z = 0;
    this.stick.x = 0;
    this.stick.y = 0;
  }
}
