// Tilt steering for phones: the gravity vector from the motion sensor
// (`devicemotion`, accelerationIncludingGravity — no permission needed on
// Android) turned into stick deflections, relative to how the phone was held
// when calibrated. Holding the phone in landscape like a small yoke:
//
//   roll   turn it like a steering wheel (right side down = roll right);
//   pitch  tilt the top edge towards you to pull (nose up), away to push.
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
  // The up vector leans towards the screen's left when the right side goes down.
  const roll = Math.atan2(-s.x, Math.hypot(s.y, s.z));
  const pitch = Math.atan2(s.y, s.z);
  return { roll, pitch };
}

/** Stick deflections (−1…1) from the angles relative to the calibrated neutral. */
export function tiltStick(angles: { roll: number; pitch: number }, neutral: { roll: number; pitch: number }): { x: number; y: number } {
  const shape = (d: number, full: number): number => {
    const m = Math.max(0, Math.abs(d) - DEAD_RAD) / (full - DEAD_RAD);
    // (No −0 inside the dead zone: callers compare against a centred stick.)
    return m === 0 ? 0 : Math.sign(d) * Math.min(1, m);
  };
  let dp = angles.pitch - neutral.pitch;
  // Wrap: atan2 jumps at ±π.
  if (dp > Math.PI) dp -= 2 * Math.PI;
  if (dp < -Math.PI) dp += 2 * Math.PI;
  return { x: shape(angles.roll - neutral.roll, FULL_ROLL_RAD), y: shape(dp, FULL_PITCH_RAD) };
}

export class TiltSteering {
  /** Steering by tilt is on (the sensor is listened to either way, so switching on is instant). */
  enabled = false;
  /** Seen at least one sensor reading (the device has the sensor). */
  available = false;
  private filtered: Gravity | null = null;
  private neutral: { roll: number; pitch: number } | null = null;
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
      if (!this.neutral) this.calibrate();
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

  /** The way the phone is held now becomes neutral (hands off). */
  calibrate(): void {
    if (this.filtered) this.neutral = tiltAngles(this.filtered);
    this.stick.x = 0;
    this.stick.y = 0;
  }
}
