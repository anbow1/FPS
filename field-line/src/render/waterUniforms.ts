import { uniform } from 'three/tsl';
import { Vector2, Vector3 } from 'three/webgpu';

// Shader inputs for the lake (water surface, swash on the bank, caustics),
// written once per frame by the view from the game and the lighting preset.
// Light values are pre-exposed like every other light in the scene.

export const W = {
  /** Game time (s): pausing freezes the water. */
  time: uniform(0),
  /** Unit vector toward the sun. */
  sunDir: uniform(new Vector3(0, 1, 0)),
  /** Direct sun irradiance at normal incidence, pre-exposed, linear RGB. */
  sunIrradiance: uniform(new Vector3()),
  /** Sky irradiance on a horizontal surface, pre-exposed, linear RGB. */
  skyIrradiance: uniform(new Vector3()),
  /** Wind over the water (m/s, x/z). */
  wind: uniform(new Vector2(1, 0)),
  /** Wave amplitude (m) at full fetch, from the wind speed. */
  amplitudeM: uniform(0.05),
};
