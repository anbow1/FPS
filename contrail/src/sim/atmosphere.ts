import { ISA } from '../config.ts';

// International Standard Atmosphere (ISO 2533): a linear temperature lapse in
// the troposphere, an isothermal layer above 11 km. Density falls to about 30 %
// of sea level at 11 km and 7 % at 20 km, which is why the jet goes sluggish up
// there (brief: "this must be felt").

export interface AirState {
  temperatureK: number;
  pressurePa: number;
  densityKgM3: number;
  speedOfSoundMs: number;
}

const G0 = 9.80665;
/** Effective Earth radius of the standard (m): converts geometric altitude to the geopotential one the ISA layers use. */
const EARTH_RADIUS_M = 6_356_766;

export function atmosphereAt(altitudeM: number, out: AirState = { temperatureK: 0, pressurePa: 0, densityKgM3: 0, speedOfSoundMs: 0 }): AirState {
  const z = Math.min(Math.max(altitudeM, -500), ISA.ceilingM);
  const h = (EARTH_RADIUS_M * z) / (EARTH_RADIUS_M + z);
  const T0 = ISA.seaLevelTemperatureK;
  const L = ISA.lapseRateKPerM;
  const R = ISA.gasConstantJKgK;
  const T11 = T0 - L * ISA.tropopauseM;
  let T: number;
  let p: number;
  if (h <= ISA.tropopauseM) {
    T = T0 - L * h;
    p = ISA.seaLevelPressurePa * Math.pow(T / T0, G0 / (L * R));
  } else {
    T = T11;
    const p11 = ISA.seaLevelPressurePa * Math.pow(T11 / T0, G0 / (L * R));
    p = p11 * Math.exp((-G0 * (h - ISA.tropopauseM)) / (R * T11));
  }
  out.temperatureK = T;
  out.pressurePa = p;
  out.densityKgM3 = p / (R * T);
  out.speedOfSoundMs = Math.sqrt(ISA.heatCapacityRatio * R * T);
  return out;
}
