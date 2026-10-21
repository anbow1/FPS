import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { DataTexture, DataUtils, EquirectangularReflectionMapping, FloatType, HalfFloatType, LinearFilter, RGBAFormat } from 'three/webgpu';

// A photographed environment for the ambient light and reflections (from
// Field Line's render/hdri.ts): a real street's facades, trees and evening
// sky in a car's paint and the windows, where a procedural probe had a
// gradient over a flat grey ground. Prepared offline: 512 × 256, the sun disc
// cut out (the directional light carries the sun), the sky's irradiance
// recorded below. The visible sky stays the procedural dome.

/** The golden-hour street (Poly Haven "konigsallee", CC0; assets/hdri/LICENSE.md): no sun visible in the scan. */
const FILE = { url: new URL('../assets/hdri/konigsallee.hdr', import.meta.url).href, sunU: null, skyIrradiance: [5.6099, 6.5277, 10.0753] as const };

export interface Hdri {
  width: number;
  height: number;
  /** RGBA float, row 0 = the nadir (v = 0, as the equirect lookup reads it). */
  data: Float32Array;
  sunU: number | null;
  skyIrradiance: readonly [number, number, number];
}

export async function loadHdri(): Promise<Hdri> {
  const f = FILE;
  const parsed = new HDRLoader().setDataType(FloatType).parse(await (await fetch(f.url)).arrayBuffer());
  const width = parsed.width ?? 0;
  const height = parsed.height ?? 0;
  const src = parsed.data as Float32Array;
  if (width === 0 || src.length !== width * height * 4) throw new Error(`HDRI '${f.url}' did not parse to RGBA floats`);
  // A .hdr stores the top row first; flip so the texture needs no flipY (which data textures do not get
  // on every backend).
  const data = new Float32Array(src.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) data.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return { width, height, data, sunU: f.sunU, skyIrradiance: f.skyIrradiance };
}

/**
 * The environment texture to filter: scaled per channel by `gain` (to the preset's sky illuminance and
 * colour), and turned about the vertical so the scan's sun stands where the scene's does.
 */
export function environmentTexture(h: Hdri, gain: readonly [number, number, number], sunU: number | null): DataTexture {
  const { width: w, height: hh } = h;
  const shift = h.sunU !== null && sunU !== null ? Math.round((sunU - h.sunU) * w) : 0;
  const out = new Uint16Array(w * hh * 4);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + ((((x - shift) % w) + w) % w)) * 4;
      const d = (y * w + x) * 4;
      out[d] = DataUtils.toHalfFloat((h.data[s] as number) * gain[0]);
      out[d + 1] = DataUtils.toHalfFloat((h.data[s + 1] as number) * gain[1]);
      out[d + 2] = DataUtils.toHalfFloat((h.data[s + 2] as number) * gain[2]);
      out[d + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const t = new DataTexture(out, w, hh, RGBAFormat, HalfFloatType);
  t.mapping = EquirectangularReflectionMapping;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Equirect u of a world direction, as three's lookup computes it: atan2(z, x) / 2π + 0.5. */
export function equirectU(x: number, z: number): number {
  return Math.atan2(z, x) / (2 * Math.PI) + 0.5;
}
