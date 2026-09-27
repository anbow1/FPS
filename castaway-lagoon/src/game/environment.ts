import type { Rng } from '../core/rng.ts';
import { DAYLIGHT, ENVIRONMENT, TIME_OF_DAY, TIME_ORDER, type TimeOfDayId, WEATHER, WEATHER_ORDER, type WeatherId, type WeatherSpec } from '../config.ts';
import type { EventQueue, P3 } from './events.ts';

// Time of day and weather as continuous state. Pressing N sweeps the clock
// forward to the next preset hour; pressing T blends every weather parameter
// toward the next weather. They are independent, so a storm at sunset or a
// cloudy night just works. Physical light (lux) follows from the sun's
// elevation and the cloud deck; render only turns these numbers into pixels.

export interface WeatherParams {
  cloudCover: number;
  sunTransmittance: number;
  skyFactor: number;
  rainRate: number;
  windMs: number;
  fogDensityPerM: number;
}

export interface Daylight {
  sunDir: P3; // unit vector toward the sun
  sunElevationRad: number;
  sunNormalLux: number; // direct sun at normal incidence, after clouds
  skyLux: number; // diffuse sky on a horizontal plane
  moonDir: P3;
  moonLux: number;
  sunColourK: number;
  skyColourK: number;
  /** 0 by day → 1 in full night. */
  night: number;
  /** EV100 the pre-exposure is anchored to (lighting sheet method, plus the night bias). */
  anchorEv: number;
}

const WEATHER_KEYS: readonly (keyof WeatherParams)[] = ['cloudCover', 'sunTransmittance', 'skyFactor', 'rainRate', 'windMs', 'fogDensityPerM'];

export class Environment {
  hour: number;
  timeId: TimeOfDayId;
  weatherId: WeatherId;
  readonly weather: WeatherParams;
  /** Surface wetness 0..1: soaks up under rain, dries slowly. */
  wetness = 0;
  windDirRad = (240 * Math.PI) / 180;
  lightningFlash = 0;
  private hourFrom: number;
  private hourTo: number;
  private hourT = 1;
  private weatherFrom: WeatherParams;
  private weatherTo: WeatherParams;
  private weatherT = 1;
  private lightningTimer = 12;
  private clockSeconds = 0;
  readonly daylight: Daylight;

  constructor(timeId: TimeOfDayId, weatherId: WeatherId) {
    this.timeId = timeId;
    this.weatherId = weatherId;
    this.hour = TIME_OF_DAY[timeId].hour;
    this.hourFrom = this.hour;
    this.hourTo = this.hour;
    this.weather = specToParams(WEATHER[weatherId]);
    this.weatherFrom = { ...this.weather };
    this.weatherTo = { ...this.weather };
    this.wetness = this.weather.rainRate > 0 ? 0.9 : 0;
    this.daylight = computeDaylight(this.hour, this.weather);
  }

  get transitioning(): boolean {
    return this.hourT < 1 || this.weatherT < 1;
  }

  setTime(id: TimeOfDayId, instant = false): void {
    this.timeId = id;
    this.hourFrom = this.hour;
    this.hourTo = TIME_OF_DAY[id].hour;
    this.hourT = instant ? 1 : 0;
    if (instant) this.hour = this.hourTo;
  }

  setWeather(id: WeatherId, instant = false): void {
    this.weatherId = id;
    this.weatherFrom = { ...this.weather };
    this.weatherTo = specToParams(WEATHER[id]);
    this.weatherT = instant ? 1 : 0;
    if (instant) {
      Object.assign(this.weather, this.weatherTo);
      this.wetness = this.weather.rainRate > 0 ? 0.9 : 0;
    }
  }

  cycleTime(): TimeOfDayId {
    const next = TIME_ORDER[(TIME_ORDER.indexOf(this.timeId) + 1) % TIME_ORDER.length] as TimeOfDayId;
    this.setTime(next);
    return next;
  }

  cycleWeather(): WeatherId {
    const next = WEATHER_ORDER[(WEATHER_ORDER.indexOf(this.weatherId) + 1) % WEATHER_ORDER.length] as WeatherId;
    this.setWeather(next);
    return next;
  }

  step(dt: number, rng: Rng, events: EventQueue): void {
    this.clockSeconds += dt;
    if (this.hourT < 1) {
      this.hourT = Math.min(1, this.hourT + dt / ENVIRONMENT.timeTransitionSeconds);
      const forward = (this.hourTo - this.hourFrom + 24) % 24;
      this.hour = (this.hourFrom + forward * easeInOut(this.hourT)) % 24;
    }
    if (this.weatherT < 1) {
      this.weatherT = Math.min(1, this.weatherT + dt / ENVIRONMENT.weatherTransitionSeconds);
      const k = easeInOut(this.weatherT);
      for (const key of WEATHER_KEYS) this.weather[key] = this.weatherFrom[key] + (this.weatherTo[key] - this.weatherFrom[key]) * k;
    }
    const rain = this.weather.rainRate;
    if (rain > 0.05) this.wetness = Math.min(1, this.wetness + (rain * dt) / ENVIRONMENT.wetUpSeconds * 2);
    else this.wetness = Math.max(0, this.wetness - dt / ENVIRONMENT.dryOffSeconds);
    // The wind veers slowly; gusts are render-side.
    this.windDirRad = (240 * Math.PI) / 180 + Math.sin(this.clockSeconds * 0.013) * 0.35;

    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 6);
    if (rain > 0.75) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = rng.range(ENVIRONMENT.lightningMinGapSeconds, ENVIRONMENT.lightningMaxGapSeconds);
        const distanceM = rng.range(500, 4000);
        const strength = Math.min(1, 1200 / distanceM + 0.2);
        this.lightningFlash = strength;
        events.push({ type: 'lightning', strength, thunderDelaySeconds: distanceM / 343 });
      }
    }
    Object.assign(this.daylight, computeDaylight(this.hour, this.weather));
  }

  windVector(out: { x: number; z: number }): { x: number; z: number } {
    out.x = Math.sin(this.windDirRad) * this.weather.windMs;
    out.z = -Math.cos(this.windDirRad) * this.weather.windMs;
    return out;
  }
}

function specToParams(s: WeatherSpec): WeatherParams {
  return { cloudCover: s.cloudCover, sunTransmittance: s.sunTransmittance, skyFactor: s.skyFactor, rainRate: s.rainRate, windMs: s.windMs, fogDensityPerM: s.fogDensityPerM };
}

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Unit vector toward the sun for a clock hour (compass: −Z north, +X east). */
export function sunDirection(hour: number, out: P3): P3 {
  const a = ((hour - ENVIRONMENT.sunriseHour) / (ENVIRONMENT.sunsetHour - ENVIRONMENT.sunriseHour)) * Math.PI;
  const az = ENVIRONMENT.sunriseAzimuthRad;
  const ex = Math.sin(az);
  const ez = -Math.cos(az);
  // The noon sun stands toward the side of the sky 90° clockwise from sunrise.
  const sx = -ez;
  const sz = ex;
  const tilt = ENVIRONMENT.sunPathTiltRad;
  const up = Math.sin(a) * Math.cos(tilt);
  const side = Math.sin(a) * Math.sin(tilt);
  out.x = Math.cos(a) * ex + side * sx;
  out.y = up;
  out.z = Math.cos(a) * ez + side * sz;
  const len = Math.hypot(out.x, out.y, out.z);
  out.x /= len;
  out.y /= len;
  out.z /= len;
  return out;
}

/** Relative optical air mass (Kasten & Young 1989). */
export function airMass(elevationRad: number): number {
  const deg = Math.max(0, (elevationRad * 180) / Math.PI);
  return 1 / (Math.sin(Math.max(0, elevationRad)) + 0.50572 * (deg + 6.07995) ** -1.6364);
}

export function computeDaylight(hour: number, w: WeatherParams): Daylight {
  const sunDir = sunDirection(hour, { x: 0, y: 0, z: 0 });
  const sinEl = sunDir.y;
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const aboveHorizon = smoothstep(-0.015, 0.035, sinEl);
  const sunClear = DAYLIGHT.solarConstantLux * Math.exp(-DAYLIGHT.clearOpticalDepth * airMass(el)) * aboveHorizon;
  const sunNormalLux = sunClear * w.sunTransmittance;
  const twilight = smoothstep(-0.2, 0.02, sinEl);
  const skyClear = DAYLIGHT.clearSkyPeakLux * Math.max(0, sinEl) ** DAYLIGHT.skyElevationExponent + DAYLIGHT.twilightSkyLux * twilight;
  const night = 1 - smoothstep(-0.16, 0.02, sinEl);
  const moonDir = { ...ENVIRONMENT.moonDirection };
  const ml = Math.hypot(moonDir.x, moonDir.y, moonDir.z);
  moonDir.x /= ml;
  moonDir.y /= ml;
  moonDir.z /= ml;
  const moonLux = DAYLIGHT.moonLux * night * (1 - w.cloudCover * 0.85);
  const skyLux = skyClear * w.skyFactor + DAYLIGHT.nightSkyLux * night * (1 - w.cloudCover * 0.5);
  const sunColourK = Math.max(1000, DAYLIGHT.sunColourLowK + (DAYLIGHT.sunColourNoonK - DAYLIGHT.sunColourLowK) * smoothstep(0, 0.55, sinEl)) * (1 - w.cloudCover) + 6500 * w.cloudCover;
  const skyColourK = DAYLIGHT.skyColourK * (1 - w.cloudCover * 0.35);
  const horizontal = sunNormalLux * Math.max(0, sinEl) + skyLux + moonLux * moonDir.y;
  const physicalEv = Math.log2(Math.max(1e-4, horizontal) * (0.18 / Math.PI) * (100 / 12.5));
  const anchorEv = physicalEv - DAYLIGHT.nightExposureBiasEv * night;
  return { sunDir, sunElevationRad: el, sunNormalLux, skyLux, moonDir, moonLux, sunColourK, skyColourK, night, anchorEv };
}
