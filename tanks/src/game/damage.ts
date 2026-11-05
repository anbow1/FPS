import * as THREE from 'three/webgpu';
import type { AmmoSpec, TankSpec } from '../config';
import { penetrationAt } from './ballistics';

export type ModuleId = 'engine' | 'trackL' | 'trackR' | 'gun' | 'turretDrive' | 'ammo' | 'fuel';
export const MODULES: ModuleId[] = ['engine', 'trackL', 'trackR', 'gun', 'turretDrive', 'ammo', 'fuel'];

export interface ModuleDef {
  id: ModuleId;
  /** 'hull' or 'turret' frame */
  frame: 'hull' | 'turret';
  pos: THREE.Vector3;
  r: number;
}

/** Where a vehicle's modules sit: a western or eastern tank, or an IFV (engine beside the driver up front,
 * ready rounds in the turret basket, fuel in the rear doors and sponsons, troops in between). */
export function moduleLayout(kind: 'west' | 'east' | 'ifv'): ModuleDef[] {
  if (kind === 'ifv') {
    return [
      { id: 'engine', frame: 'hull', pos: new THREE.Vector3(0.5, 0.9, 1.9), r: 0.9 },
      { id: 'trackL', frame: 'hull', pos: new THREE.Vector3(-1.35, 0.4, 0), r: 0.8 },
      { id: 'trackR', frame: 'hull', pos: new THREE.Vector3(1.35, 0.4, 0), r: 0.8 },
      { id: 'gun', frame: 'turret', pos: new THREE.Vector3(0, 0.35, 0.7), r: 0.6 },
      { id: 'turretDrive', frame: 'hull', pos: new THREE.Vector3(0, 1.2, 0.3), r: 0.8 },
      { id: 'ammo', frame: 'turret', pos: new THREE.Vector3(0, -0.2, 0), r: 0.7 },
      { id: 'fuel', frame: 'hull', pos: new THREE.Vector3(0, 0.8, -2.4), r: 0.8 },
    ];
  }
  const west = kind === 'west';
  return [
    { id: 'engine', frame: 'hull', pos: new THREE.Vector3(0, 1.1, west ? -2.6 : -2.5), r: 1.3 },
    { id: 'trackL', frame: 'hull', pos: new THREE.Vector3(-1.55, 0.45, 0), r: 0.9 },
    { id: 'trackR', frame: 'hull', pos: new THREE.Vector3(1.55, 0.45, 0), r: 0.9 },
    { id: 'gun', frame: 'turret', pos: new THREE.Vector3(0, 0.4, west ? 1.2 : 0.8), r: 0.8 },
    { id: 'turretDrive', frame: 'hull', pos: new THREE.Vector3(0, 1.55, 0.1), r: 1.0 },
    // west: bustle ammo behind blow-out panels; east: carousel low in the hull
    west
      ? { id: 'ammo', frame: 'turret', pos: new THREE.Vector3(0, 0.45, -1.7), r: 0.8 }
      : { id: 'ammo', frame: 'hull', pos: new THREE.Vector3(0, 0.75, 0.3), r: 1.0 },
    { id: 'fuel', frame: 'hull', pos: new THREE.Vector3(1.2, 1.1, 2.6), r: 0.75 },
  ];
}

export type Face = 'front' | 'side' | 'rear' | 'top';

export function faceFromNormal(n: THREE.Vector3): Face {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ay >= ax && ay >= az) return 'top';
  if (ax >= az) return 'side';
  return n.z > 0 ? 'front' : 'rear';
}

export function nominalArmour(spec: TankSpec, part: 'hull' | 'turret', face: Face): number {
  const a = spec.armour;
  if (part === 'hull') return face === 'front' ? a.hullFront : face === 'side' ? a.hullSide : face === 'rear' ? a.hullRear : a.hullTop;
  return face === 'front' ? a.turretFront : face === 'side' ? a.turretSide : face === 'rear' ? a.turretRear : a.turretTop;
}

export type Outcome = 'ricochet' | 'nopen' | 'pen' | 'track' | 'gun';

export interface ArmourResult {
  outcome: Outcome;
  /** impact angle from the plate normal, degrees */
  angleDeg: number;
  effective: number;
  penetration: number;
}

/**
 * Armour check at the plate: line-of-sight thickness t / cos(angle), a ricochet cut-off per
 * round, and ±8 % penetration scatter (`roll` in [0,1)).
 */
export function resolveArmour(
  ammo: AmmoSpec, spec: TankSpec, part: 'hull' | 'turret', localNormal: THREE.Vector3, localDir: THREE.Vector3,
  flown: number, roll: number,
): ArmourResult {
  const cos = Math.min(1, Math.max(0, -localNormal.dot(localDir)));
  const angleDeg = (Math.acos(cos) * 180) / Math.PI;
  const face = faceFromNormal(localNormal);
  const nominal = nominalArmour(spec, part, face);
  const effective = nominal / Math.max(cos, 0.17);
  const penetration = penetrationAt(ammo, flown) * (0.92 + roll * 0.16);
  if (angleDeg > ammo.ricochetDeg) return { outcome: 'ricochet', angleDeg, effective, penetration };
  return { outcome: penetration >= effective ? 'pen' : 'nopen', angleDeg, effective, penetration };
}

/** Slab test of a segment against an axis-aligned box. Returns entry fraction and entry face normal. */
export function segmentBox(
  p0: THREE.Vector3, p1: THREE.Vector3, c: THREE.Vector3, h: THREE.Vector3, outNormal: THREE.Vector3,
): number {
  let tmin = 0;
  let tmax = 1;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const o = p0.getComponent(i) - c.getComponent(i);
    const d = p1.getComponent(i) - p0.getComponent(i);
    const e = h.getComponent(i);
    if (Math.abs(d) < 1e-9) {
      if (o < -e || o > e) return -1;
      continue;
    }
    let t0 = (-e - o) / d;
    let t1 = (e - o) / d;
    let s = -1;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
      s = 1;
    }
    if (t0 > tmin) {
      tmin = t0;
      axis = i;
      sign = s;
    }
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return -1;
  }
  if (axis < 0) return -1; // started inside
  outNormal.set(0, 0, 0).setComponent(axis, sign);
  return tmin;
}
