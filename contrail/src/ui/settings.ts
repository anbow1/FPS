// Control preferences that outlive a flight: kept in localStorage (they are
// per device, like a joystick setup), overridable from the URL for the headless
// checks (?invert=0|1, ?tilt=0|1, ?q=high|balanced|fast). Storage can be missing or throw (private
// windows, WebView without DOM storage), so every access is guarded and the
// defaults stand in.

export interface ControlSettings {
  /** Stick, mouse and W/S forward raise the nose (an "up is up" screen stick) instead of pushing it down. */
  invertPitch: boolean;
  /** Steer by tilting the phone (touch devices with a motion sensor). */
  tilt: boolean;
  /**
   * Picture quality: `high` full effects at up to 2× (phones) or native (desktop) resolution;
   * `balanced` the cheaper effects but still a sharp 2× picture; `fast` cheaper effects at 1×.
   */
  graphics: GraphicsPreset;
}

export type GraphicsPreset = 'high' | 'balanced' | 'fast';

const KEY = 'contrail.settings.v1';

/** Stage quality and the device-pixel-ratio ceiling for a preset. */
export function graphicsSetup(g: GraphicsPreset, touch: boolean): { quality: 'high' | 'low'; maxPixelRatio: number; temporalAA: boolean } {
  if (g === 'fast') return { quality: 'low', maxPixelRatio: 1, temporalAA: false };
  // Phones: 2× is sharp on any screen a hand holds; native 3× would triple the cost for little.
  return { quality: g === 'high' ? 'high' : 'low', maxPixelRatio: touch ? 2 : 4, temporalAA: true };
}

export function loadControls(params: URLSearchParams, touch: boolean): ControlSettings {
  // "Up is up" by default: the stick on the screen reads more naturally that way, and it was asked for.
  const s: ControlSettings = { invertPitch: true, tilt: false, graphics: touch ? 'balanced' : 'high' };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Record<keyof ControlSettings, unknown>>;
      if (typeof v.invertPitch === 'boolean') s.invertPitch = v.invertPitch;
      if (typeof v.tilt === 'boolean') s.tilt = v.tilt;
      if (v.graphics === 'high' || v.graphics === 'balanced' || v.graphics === 'fast') s.graphics = v.graphics;
    }
  } catch {
    // Unreadable storage: keep the defaults.
  }
  const flag = (key: string): boolean | null => (params.has(key) ? params.get(key) !== '0' : null);
  s.invertPitch = flag('invert') ?? s.invertPitch;
  s.tilt = flag('tilt') ?? s.tilt;
  const q = params.get('q');
  if (q === 'high' || q === 'balanced' || q === 'fast') s.graphics = q;
  if (q === 'low') s.graphics = 'fast';
  return s;
}

export function saveControls(s: ControlSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Nowhere to keep it: the choice still holds for this flight.
  }
}
