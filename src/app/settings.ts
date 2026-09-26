import type { LightingPresetId } from '../config.ts';
import type { ModeId } from '../game/modes.ts';
import type { MapId } from '../maps/types.ts';
import type { Quality, ToneMap } from '../render/stage.ts';

// Player settings. Stored per viewer in localStorage as a convenience only:
// if storage is blocked the game runs on defaults.

export interface Settings {
  mapId: MapId;
  modeId: ModeId;
  preset: LightingPresetId;
  wet: boolean;
  quality: Quality;
  renderScale: number;
  toneMap: ToneMap;
  minimalHud: boolean;
  sensitivity: number;
  shake: number;
  showStats: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mapId: 'range',
  modeId: 'range',
  preset: 'noon',
  wet: false,
  quality: 'high',
  renderScale: 1,
  toneMap: 'aces',
  minimalHud: false,
  sensitivity: 1,
  shake: 1,
  showStats: false,
};

const KEY = 'fps.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const out: Settings = { ...DEFAULT_SETTINGS };
    const src = parsed as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (typeof src[k] === typeof DEFAULT_SETTINGS[k]) (out as unknown as Record<string, unknown>)[k] = src[k];
    }
    return out;
  } catch (err) {
    console.warn('stored settings unreadable, using defaults:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    console.warn('could not save settings:', err);
  }
}
