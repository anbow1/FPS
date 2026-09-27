import type { ItemId } from '../game/items.ts';
import type { TimeOfDayId, WeatherId } from '../config.ts';

// Inline SVG icons: one silhouette per item, drawn in the HUD's ink colour
// with a single accent, so the inventory reads at a glance.

const svg = (body: string): string => `<svg viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;

export const ITEM_ICONS: Record<ItemId, string> = {
  stone: svg('<ellipse cx="32" cy="36" rx="20" ry="13" fill="#9d978c"/><ellipse cx="26" cy="31" rx="8" ry="4" fill="#bdb7ab"/>'),
  rifle: svg(
    '<path d="M4 30h14l4-4h22l2 2h14v5H46l-3 3h-9l-2 14-7 1 2-15h-8l-8 7H5z" fill="#d9d3c4"/><path d="M33 36l3 13 5-1-3-12z" fill="#b86a3c"/><path d="M5 31h12l-7 6H5z" fill="#b86a3c"/>',
  ),
  ammo762: svg('<g fill="#e3c77a"><rect x="14" y="20" width="8" height="30" rx="3"/><rect x="28" y="20" width="8" height="30" rx="3"/><rect x="42" y="20" width="8" height="30" rx="3"/></g><g fill="#b7934a"><path d="M14 22l4-8 4 8z"/><path d="M28 22l4-8 4 8z"/><path d="M42 22l4-8 4 8z"/></g>'),
  knife: svg('<path d="M6 36l30-10 20 4-22 8z" fill="#e1e3e6"/><rect x="36" y="30" width="4" height="12" fill="#444"/><rect x="40" y="33" width="18" height="7" rx="3" fill="#5f6a45"/>'),
  herb: svg('<path d="M32 56V26" stroke="#6b8f3a" stroke-width="3"/><path d="M32 30c-14-2-18-14-16-20 10 2 16 8 16 20zM32 36c12-2 18-12 16-20-10 2-16 8-16 20z" fill="#7fb14a"/><path d="M32 46c-10 0-16-8-16-14 8 0 14 6 16 14z" fill="#5f9235"/>'),
  hibiscus: svg('<g fill="#d8343c"><circle cx="32" cy="20" r="10"/><circle cx="44" cy="30" r="10"/><circle cx="39" cy="44" r="10"/><circle cx="25" cy="44" r="10"/><circle cx="20" cy="30" r="10"/></g><circle cx="32" cy="32" r="5" fill="#f3d36b"/>'),
  aloe: svg('<g fill="#7f9b69"><path d="M32 58L28 12l6 0z"/><path d="M30 58L10 22l6-2z"/><path d="M34 58l20-36-6-2z"/><path d="M30 58L4 40l5-4z"/><path d="M34 58l26-18-5-4z"/></g>'),
  coconut: svg('<circle cx="32" cy="34" r="20" fill="#7a5a34"/><circle cx="26" cy="30" r="3" fill="#3a2a1a"/><circle cx="34" cy="28" r="3" fill="#3a2a1a"/><circle cx="31" cy="36" r="3" fill="#3a2a1a"/>'),
  beans: svg('<rect x="18" y="12" width="28" height="40" rx="4" fill="#c8c8c4"/><rect x="18" y="20" width="28" height="22" fill="#2e6a8a"/><rect x="18" y="12" width="28" height="4" fill="#9a9a96"/>'),
  flare: svg('<rect x="10" y="28" width="42" height="10" rx="3" fill="#b8302a"/><rect x="50" y="29" width="6" height="8" fill="#e8e0d0"/><path d="M56 26l6-6M57 33h7M56 40l6 6" stroke="#f0a040" stroke-width="3"/>'),
  canteen: svg('<ellipse cx="32" cy="36" rx="18" ry="20" fill="#b9bcbe"/><rect x="28" y="8" width="8" height="10" fill="#3a3d33"/><path d="M14 30c6 4 30 4 36 0" stroke="#5a5e48" stroke-width="4" fill="none"/>'),
  rope: svg('<g fill="none" stroke="#c8ae7a" stroke-width="5"><ellipse cx="32" cy="32" rx="22" ry="18"/><ellipse cx="32" cy="32" rx="14" ry="11"/></g><path d="M50 40l8 14" stroke="#c8ae7a" stroke-width="5"/>'),
};

export const TIME_ICONS: Record<TimeOfDayId, string> = {
  morning: svg('<path d="M8 44h48" stroke="currentColor" stroke-width="3"/><path d="M18 44a14 14 0 0 1 28 0" fill="currentColor" opacity=".85"/><path d="M32 18v6M14 28l4 4M50 28l-4 4" stroke="currentColor" stroke-width="3"/>'),
  noon: svg('<circle cx="32" cy="32" r="11" fill="currentColor"/><g stroke="currentColor" stroke-width="3"><path d="M32 6v8M32 50v8M6 32h8M50 32h8M13 13l6 6M45 45l6 6M13 51l6-6M45 19l6-6"/></g>'),
  sunset: svg('<path d="M8 40h48M14 48h36M20 56h24" stroke="currentColor" stroke-width="3"/><path d="M18 40a14 14 0 0 1 28 0z" fill="currentColor"/>'),
  night: svg('<path d="M40 10a22 22 0 1 0 14 30A18 18 0 0 1 40 10z" fill="currentColor"/><circle cx="16" cy="14" r="2" fill="currentColor"/><circle cx="24" cy="26" r="1.5" fill="currentColor"/>'),
};

export const WEATHER_ICONS: Record<WeatherId, string> = {
  clear: svg('<circle cx="32" cy="32" r="12" fill="currentColor"/><g stroke="currentColor" stroke-width="3"><path d="M32 8v6M32 50v6M8 32h6M50 32h6"/></g>'),
  cloudy: svg('<path d="M18 46h30a10 10 0 0 0 0-20 14 14 0 0 0-26-4 12 12 0 0 0-4 24z" fill="currentColor"/>'),
  rain: svg('<path d="M18 36h30a10 10 0 0 0 0-20 14 14 0 0 0-26-4 12 12 0 0 0-4 24z" fill="currentColor"/><g stroke="currentColor" stroke-width="3"><path d="M22 42l-3 8M34 42l-3 8M46 42l-3 8"/></g>'),
  storm: svg('<path d="M18 34h30a10 10 0 0 0 0-20 14 14 0 0 0-26-4 12 12 0 0 0-4 24z" fill="currentColor"/><path d="M34 36l-8 12h7l-4 12 12-16h-7l4-8z" fill="#f2d35b"/><g stroke="currentColor" stroke-width="3"><path d="M18 40l-3 8M48 40l-3 8"/></g>'),
};
