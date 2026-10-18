import { uniform } from 'three/tsl';
import { Vector2, Vector3 } from 'three/webgpu';

// Global shader inputs, written once per frame by the view from logic state
// (time of day, weather, wind) and read by every lagoon material. Light
// quantities are pre-exposed: physical value × the frame's pre-exposure.

export const U = {
  /** Seconds of game time (not wall time), so pausing freezes the water. */
  time: uniform(0),
  sunDir: uniform(new Vector3(0, 1, 0)),
  /** Direct sun (or moon) irradiance at normal incidence, pre-exposed, linear RGB. */
  sunIrradiance: uniform(new Vector3()),
  /** Sky irradiance on a horizontal surface, pre-exposed, linear RGB. */
  skyIrradiance: uniform(new Vector3()),
  /** Horizon and zenith sky radiance, pre-exposed (the fog and the dome share them). */
  horizonRadiance: uniform(new Vector3()),
  zenithRadiance: uniform(new Vector3()),
  /** Light bounced off the ground (sand, turf, water) as seen from below the horizon, pre-exposed. */
  groundRadiance: uniform(new Vector3()),
  /** Radiance of the sun's glow around its disc, pre-exposed. */
  sunGlowRadiance: uniform(new Vector3()),
  /** Direct sun disc radiance, pre-exposed. */
  sunDiscRadiance: uniform(new Vector3()),
  moonDir: uniform(new Vector3(0, 1, 0)),
  moonRadiance: uniform(new Vector3()),
  night: uniform(0),
  cloudCover: uniform(0.2),
  /** Cloud layer brightness under the sun (pre-exposed). */
  cloudLit: uniform(new Vector3()),
  cloudShade: uniform(new Vector3()),
  cloudOffset: uniform(new Vector2()),
  starBrightness: uniform(0),
  rain: uniform(0),
  wetness: uniform(0),
  lightning: uniform(0),
  wind: uniform(new Vector2(1, 0)), // m/s, x/z
  gust: uniform(0), // 0..1 slow gust envelope
  fogDensity: uniform(0.001),
  fogFalloff: uniform(0.012),
  /** 0…1: the thin mist lying on the water at dawn and after rain (lighting.ts `mistLayerFactor`). */
  waterMist: uniform(0),
  preExposure: uniform(1),
  waveScale: uniform(1),
  /** 1 while the camera is below the water surface (stage post pass, water underside). */
  underwater: uniform(0),
  /** Radiance of the lamp's flame, pre-exposed (0 when out). */
  lampGlow: uniform(0),
};
