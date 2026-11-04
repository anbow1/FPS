import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { DataTexture, DataUtils, EquirectangularReflectionMapping, FloatType, HalfFloatType, LinearFilter, RGBAFormat } from 'three/webgpu';
import type { LightingPresetId } from '../config.ts';

// Photographed environments for the ambient light and reflections: a real
// street's facades, trees and clouds in a car's paint and a window, a real
// forest's trunks and ground in the bounce light, where the procedural probe
// had a gradient over a flat grey ground. CC0 HDRIs from Poly Haven
// (assets/hdri/LICENSE.md), one per setting and lighting preset, prepared
// offline: 512 × 256, the sun disc cut out (the directional light carries the
// sun), its column and the sky's irradiance recorded below. The visible sky
// stays the procedural dome, which follows the preset's sun and fog.

export type HdriSetting = 'urban' | 'nature';

interface HdriFile {
  url: string;
  /** Image u (0…1) of the sun's column, or null when the scan shows none (cloud, night, trees). */
  sunU: number | null;
  /** Irradiance on a horizontal surface from the upper hemisphere, sun removed (linear RGB, file units). */
  skyIrradiance: readonly [number, number, number];
}

const FILES: Record<HdriSetting, Record<LightingPresetId, HdriFile>> = {
  urban: {
    noon: { url: new URL('../assets/hdri/wide_street_01.hdr', import.meta.url).href, sunU: 0.6006, skyIrradiance: [0.6386, 1.1292, 1.7345] },
    overcast: { url: new URL('../assets/hdri/urban_street_01.hdr', import.meta.url).href, sunU: null, skyIrradiance: [3.7601, 4.1333, 5.0877] },
    golden: { url: new URL('../assets/hdri/konigsallee.hdr', import.meta.url).href, sunU: null, skyIrradiance: [5.6099, 6.5277, 10.0753] },
    // The bright spot in this one is a street lamp, not a sun to line up.
    night: { url: new URL('../assets/hdri/cobblestone_street_night.hdr', import.meta.url).href, sunU: null, skyIrradiance: [0.3875, 0.2145, 0.1257] },
  },
  nature: {
    noon: { url: new URL('../assets/hdri/epping_forest_01.hdr', import.meta.url).href, sunU: null, skyIrradiance: [3.1162, 3.391, 3.7224] },
    overcast: { url: new URL('../assets/hdri/misty_pines.hdr', import.meta.url).href, sunU: null, skyIrradiance: [7.8253, 8.0268, 8.7679] },
    golden: { url: new URL('../assets/hdri/forest_grove.hdr', import.meta.url).href, sunU: null, skyIrradiance: [2.71, 3.8491, 5.1848] },
    night: { url: new URL('../assets/hdri/lakeside_night.hdr', import.meta.url).href, sunU: null, skyIrradiance: [3.7138, 3.7627, 4.2444] },
  },
};

export interface Hdri {
  width: number;
  height: number;
  /** RGBA float, row 0 = the nadir (v = 0, as the equirect lookup reads it). */
  data: Float32Array;
  sunU: number | null;
  skyIrradiance: readonly [number, number, number];
  setting: HdriSetting;
}

const cache = new Map<string, Hdri>();

export async function loadHdri(setting: HdriSetting, preset: LightingPresetId): Promise<Hdri> {
  const key = `${setting}:${preset}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = FILES[setting][preset];
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
  const hdri = { width, height, data, sunU: f.sunU, skyIrradiance: f.skyIrradiance, setting };
  cache.set(key, hdri);
  return hdri;
}

/**
 * The environment texture to filter: scaled per channel by `gain` (to the preset's sky illuminance and
 * colour), and turned about the vertical so the scan's sun stands where the scene's does.
 */
export function environmentTexture(h: Hdri, gain: readonly [number, number, number], sunU: number | null, groundGain = 1): DataTexture {
  const { width: w, height: hh } = h;
  const shift = h.sunU !== null && sunU !== null ? Math.round((sunU - h.sunU) * w) : 0;
  const out = new Uint16Array(w * hh * 4);
  for (let y = 0; y < hh; y++) {
    // Below the horizon (row 0 is the nadir) the ground's own scale, blended over the last 3°.
    const elevation = ((y + 0.5) / hh) * Math.PI - Math.PI / 2;
    const below = Math.min(1, Math.max(0, -elevation / (3 * (Math.PI / 180))));
    const k = 1 + (groundGain - 1) * below;
    for (let x = 0; x < w; x++) {
      const s = (y * w + ((((x - shift) % w) + w) % w)) * 4;
      const d = (y * w + x) * 4;
      out[d] = DataUtils.toHalfFloat((h.data[s] as number) * gain[0] * k);
      out[d + 1] = DataUtils.toHalfFloat((h.data[s + 1] as number) * gain[1] * k);
      out[d + 2] = DataUtils.toHalfFloat((h.data[s + 2] as number) * gain[2] * k);
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

/**
 * Irradiance (luminance, file units) on a downward-facing surface from the scan's lower hemisphere: the
 * bounce off the photographed ground.
 */
export function groundIrradiance(h: Hdri): number {
  const { width: w, height: hh } = h;
  const dTheta = Math.PI / hh;
  const dPhi = (2 * Math.PI) / w;
  let e = 0;
  for (let y = 0; y < hh / 2; y++) {
    const elevation = ((y + 0.5) / hh) * Math.PI - Math.PI / 2;
    const cosDown = -Math.sin(elevation);
    const dOmega = Math.cos(elevation) * dTheta * dPhi;
    let row = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row += 0.2126 * (h.data[i] as number) + 0.7152 * (h.data[i + 1] as number) + 0.0722 * (h.data[i + 2] as number);
    }
    e += row * cosDown * dOmega;
  }
  return e;
}

/** Equirect u of a world direction, as three's lookup computes it: atan2(z, x) / 2π + 0.5. */
export function equirectU(x: number, z: number): number {
  return Math.atan2(z, x) / (2 * Math.PI) + 0.5;
}
