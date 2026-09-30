import { WAVES, WATER_LEVEL_M } from '../config.ts';

// The water's height where logic needs it — a swimmer's head, later a hull —
// from the same chop the water shader displaces the surface with
// (render/water.ts): the Gerstner components shorter than 8 m, damped in the
// shallows. The long swell is left out: inside the lagoon the shader takes it
// from the baked shore field instead, and it moves a floating head by only a
// few centimetres more.

/** Wave height multiplier for the weather: storms and wind raise the chop. Shared with render. */
export function waveScale(rainRate: number, windMs: number): number {
  return 1 + (WAVES.stormAmplitudeScale - 1) * rainRate + (windMs - 3) * 0.03;
}

/** Water surface height (m) at (x, z) at time t over water `depthM` deep. */
export function waterSurfaceY(x: number, z: number, timeS: number, scale: number, depthM: number): number {
  const damp = smoothstep(0.05, 2.8, depthM);
  let y = 0;
  for (const w of WAVES.components) {
    if (w.wavelengthM >= 8) continue;
    const k = (2 * Math.PI) / w.wavelengthM;
    const omega = Math.sqrt(9.81 * k);
    const a = (w.directionDeg * Math.PI) / 180;
    y += w.amplitudeM * Math.sin((Math.cos(a) * x + Math.sin(a) * z) * k - timeS * omega);
  }
  return WATER_LEVEL_M + y * scale * damp;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
