// Control preferences that outlive a flight: kept in localStorage (they are
// per device, like a joystick setup), overridable from the URL for the headless
// checks (?invert=0|1, ?tilt=0|1). Storage can be missing or throw (private
// windows, WebView without DOM storage), so every access is guarded and the
// defaults stand in.

export interface ControlSettings {
  /** Stick, mouse and W/S forward raise the nose (an "up is up" screen stick) instead of pushing it down. */
  invertPitch: boolean;
  /** Steer by tilting the phone (touch devices with a motion sensor). */
  tilt: boolean;
}

const KEY = 'contrail.settings.v1';

export function loadControls(params: URLSearchParams): ControlSettings {
  // "Up is up" by default: the stick on the screen reads more naturally that way, and it was asked for.
  const s: ControlSettings = { invertPitch: true, tilt: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Record<keyof ControlSettings, unknown>>;
      if (typeof v.invertPitch === 'boolean') s.invertPitch = v.invertPitch;
      if (typeof v.tilt === 'boolean') s.tilt = v.tilt;
    }
  } catch {
    // Unreadable storage: keep the defaults.
  }
  const flag = (key: string): boolean | null => (params.has(key) ? params.get(key) !== '0' : null);
  s.invertPitch = flag('invert') ?? s.invertPitch;
  s.tilt = flag('tilt') ?? s.tilt;
  return s;
}

export function saveControls(s: ControlSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Nowhere to keep it: the choice still holds for this flight.
  }
}
