import { float, positionWorld, uniform } from 'three/tsl';
import { Vector3 } from 'three/webgpu';
import type { InteriorVolume } from '../maps/types.ts';

// Interior ambient (rules §2.4: interiors are never lit by the outdoor
// environment alone). Each enterable building's volume is a baked "sky
// visibility" probe: inside it, the sky's ambient is scaled down to the share
// of sky a room sees through its windows. Direct sun through the windows and
// the bulbs still light the room at full strength; the eye adapts from there.
//
// The factor feeds each world material's AO term, which applies to indirect
// light only — the same channel GTAO would use.

const MAX_VOLUMES = 8;
// Share of the outdoor sky ambient that reaches a room through ~25 % glazing
// on two or more walls. Tuned by hand against the lighting sheet: a noon room
// meters about 5–6 stops under the street, like a real one.
export const INTERIOR_SKY_FRACTION = 0.06;
const EDGE_M = 0.08; // inner wall faces sit on the volume edge; outer faces are 0.3 m out

const mins = Array.from({ length: MAX_VOLUMES }, () => uniform(new Vector3(1e6, 1e6, 1e6)));
const fractions = Array.from({ length: MAX_VOLUMES }, () => uniform(INTERIOR_SKY_FRACTION));
const maxs = Array.from({ length: MAX_VOLUMES }, () => uniform(new Vector3(-1e6, -1e6, -1e6)));

export function setInteriorVolumes(volumes: readonly InteriorVolume[]): void {
  if (volumes.length > MAX_VOLUMES) throw new Error(`${volumes.length} interior volumes; the shader holds at most ${MAX_VOLUMES}`);
  for (let i = 0; i < MAX_VOLUMES; i++) {
    const v = volumes[i];
    const lo = (mins[i] as (typeof mins)[number]).value;
    const hi = (maxs[i] as (typeof maxs)[number]).value;
    (fractions[i] as (typeof fractions)[number]).value = v?.skyFraction ?? INTERIOR_SKY_FRACTION;
    if (v) {
      lo.set(v.min.x - EDGE_M, v.min.y - EDGE_M, v.min.z - EDGE_M);
      hi.set(v.max.x + EDGE_M, v.max.y + EDGE_M, v.max.z + EDGE_M);
    } else {
      lo.set(1e6, 1e6, 1e6);
      hi.set(-1e6, -1e6, -1e6);
    }
  }
}

/** 1 outdoors, the volume's sky fraction inside an interior volume. Multiplies the AO term. */
export function skyVisibilityNode() {
  const p = positionWorld;
  const shares = mins.map((lo, i) => {
    const hi = maxs[i] as (typeof maxs)[number];
    const inBox = p.x.greaterThan(lo.x).and(p.x.lessThan(hi.x)).and(p.y.greaterThan(lo.y)).and(p.y.lessThan(hi.y)).and(p.z.greaterThan(lo.z)).and(p.z.lessThan(hi.z));
    return inBox.select(fractions[i] as (typeof fractions)[number], float(1));
  });
  return shares.reduce((acc, f) => acc.min(f));
}

/** The sky fraction at a point (1 outdoors): the CPU twin of skyVisibilityNode. */
export function interiorSkyFraction(volumes: readonly InteriorVolume[], x: number, y: number, z: number): number {
  const v = volumes.find((v) => x > v.min.x && x < v.max.x && y > v.min.y - 0.2 && y < v.max.y && z > v.min.z && z < v.max.z);
  return v ? (v.skyFraction ?? INTERIOR_SKY_FRACTION) : 1;
}
