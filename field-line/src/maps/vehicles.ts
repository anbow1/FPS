import compact from '../../../shared/vehicles/compact/compact.json';
import coupe from '../../../shared/vehicles/coupe/coupe.json';
import hatchback from '../../../shared/vehicles/hatchback/hatchback.json';
import minivan from '../../../shared/vehicles/minivan/minivan.json';
import offroad from '../../../shared/vehicles/offroad/offroad.json';
import pickup from '../../../shared/vehicles/pickup/pickup.json';
import sedan from '../../../shared/vehicles/sedan/sedan.json';
import suv from '../../../shared/vehicles/suv/suv.json';
import wagon from '../../../shared/vehicles/wagon/wagon.json';
import type { MapProp } from './types.ts';

// Which of the shared car models (shared/vehicles, from a CC BY pack: see its CREDITS.md) a parked car
// is, picked from its place so the map's colliders and the renderer agree without talking to each
// other. The sports car of the pack is left out: a supercar does not park on these streets.

export type CarModelId = 'compact' | 'coupe' | 'hatchback' | 'minivan' | 'offroad' | 'pickup' | 'sedan' | 'suv' | 'wagon';

export interface CarModelInfo {
  /** Width, height, length (m), the car standing on y = 0, front toward −Z. */
  size: [number, number, number];
  /** Linear RGB of the paint in the model's texture, or null when it is too dark to recolour. */
  paint: [number, number, number] | null;
}

/** The .json written by prepare_vehicle.py, checked: three sizes, three paint channels or none. */
function info(j: { size: number[]; paint?: number[] | null }): CarModelInfo {
  const [w, h, l] = j.size;
  if (w === undefined || h === undefined || l === undefined) throw new Error('car model .json without a size');
  const p = j.paint;
  const paint: [number, number, number] | null = p && p.length === 3 ? [p[0] as number, p[1] as number, p[2] as number] : null;
  return { size: [w, h, l], paint };
}

const INFO: Record<CarModelId, CarModelInfo> = {
  compact: info(compact),
  coupe: info(coupe),
  hatchback: info(hatchback),
  minivan: info(minivan),
  offroad: info(offroad),
  pickup: info(pickup),
  sedan: info(sedan),
  suv: info(suv),
  wagon: info(wagon),
};

/** A European street's mix: mostly hatchbacks and saloons, some estates and small cars, a few others. */
const MIX: readonly [CarModelId, number][] = [
  ['hatchback', 3],
  ['sedan', 3],
  ['compact', 2],
  ['wagon', 2],
  ['suv', 1],
  ['minivan', 1],
  ['coupe', 1],
  ['offroad', 0.5],
  ['pickup', 0.5],
];
const MIX_TOTAL = MIX.reduce((a, [, w]) => a + w, 0);

export const CAR_MODELS: readonly CarModelId[] = MIX.map(([id]) => id);

export function carModelInfo(id: CarModelId): CarModelInfo {
  return INFO[id];
}

/** The model a parked car prop is, from a hash of where it stands (stable across builds and tests). */
export function carModelOf(p: Pick<MapProp, 'pos'>): CarModelId {
  let h = Math.imul(Math.round(p.pos.x * 10) | 0, 0x9e3779b1) ^ Math.imul(Math.round(p.pos.z * 10) | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae3d);
  const u = ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  let t = u * MIX_TOTAL;
  for (const [id, w] of MIX) {
    t -= w;
    if (t < 0) return id;
  }
  return 'hatchback';
}
