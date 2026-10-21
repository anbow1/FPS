// Colour helpers for the render layer. Light colours come from colour
// temperature (lighting sheet), converted to linear sRGB primaries.

export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Planckian locus colour for a temperature in kelvin, as linear sRGB with the
 * largest channel at 1. Krystek's rational approximation of the locus in CIE
 * 1960 uv (Krystek 1985, valid 1000–15000 K), then xy → XYZ → linear sRGB (D65).
 */
export function kelvinToLinearRgb(kelvin: number): LinearRgb {
  if (!(kelvin >= 1000 && kelvin <= 15000)) throw new Error(`colour temperature ${kelvin} K is outside 1000–15000 K`);
  const t = kelvin;
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d;
  const y = (2 * v) / d;
  const X = x / y;
  const Z = (1 - x - y) / y;
  let r = 3.2406 * X - 1.5372 - 0.4986 * Z;
  let g = -0.9689 * X + 1.8758 + 0.0415 * Z;
  let b = 0.0557 * X - 0.204 + 1.057 * Z;
  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);
  const m = Math.max(r, g, b);
  return { r: r / m, g: g / m, b: b / m };
}

const D65_KELVIN = 6504;
let d65: LinearRgb | null = null;

/**
 * Colour of a light source for rendering: its Planckian colour white-balanced
 * to D65, the white point of sRGB. Without this a 5500 K noon sun renders pink,
 * where an eye or camera adapted to daylight sees it as white; with it, golden
 * hour (3200 K) stays warm and a 10000 K sky stays blue. Largest channel = 1.
 */
export function lightColour(kelvin: number): LinearRgb {
  d65 ??= kelvinToLinearRgb(D65_KELVIN);
  const c = kelvinToLinearRgb(kelvin);
  const r = c.r / d65.r;
  const g = c.g / d65.g;
  const b = c.b / d65.b;
  const m = Math.max(r, g, b);
  return { r: r / m, g: g / m, b: b / m };
}

/** sRGB hex (as on the PBR sheet) → linear channel values 0..1. */
export function hexToLinear(hex: number): LinearRgb {
  const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return { r: toLinear(((hex >> 16) & 255) / 255), g: toLinear(((hex >> 8) & 255) / 255), b: toLinear((hex & 255) / 255) };
}

/** Relative luminance of a linear colour (Rec. 709 weights). */
export function luminanceOf(c: LinearRgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Pre-exposure factor for an EV100 (lighting sheet; Lagarde & de Rousiers 2014). */
export function preExposureFor(ev100: number): number {
  return 1 / (1.2 * 2 ** ev100);
}
