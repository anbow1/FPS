import { STREET, TRAFFIC } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { crossRoadHalf } from '../city/street.ts';

// Traffic on the boulevard and the first cross street: every vehicle follows
// the one ahead in its lane by the Intelligent Driver Model (Treiber,
// Hennecke & Helbing 2000), and stops for a red light as for a standing car
// at the stop line. The boulevard is red for the first seconds of the clip —
// a queue waits at the line while people cross in front of it — then turns
// green and the queue pulls away; the cross street's traffic flows across
// until its own light turns red.
//
// Lanes are one-dimensional: s is the distance travelled from the lane's
// start; past its end a vehicle comes back in at the start (both ends far in
// the haze or behind the camera).

export type VehicleKind = 'car' | 'taxi' | 'bus' | 'bike';

export interface Lane {
  /** World position at s = 0 and the unit direction of travel (xz). */
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  lengthM: number;
  /** s of the stop line, and which light governs it (null: none). */
  stopS: number | null;
  light: 'boulevard' | 'cross' | null;
  bikes: boolean;
}

export interface Vehicle {
  kind: VehicleKind;
  lane: Lane;
  s: number;
  v: number;
  /** Bumper to bumper. */
  lengthM: number;
  desiredMs: number;
  /** Body variant and paint (indices the view reads). */
  variant: number;
  paint: number;
  /** Wheel turn (rad) from the distance travelled, and whether braking (tail lamps). */
  wheelRad: number;
  braking: boolean;
  /** Pedal crank angle (bikes). */
  crankRad: number;
}

/** Light states at clip time t (s). */
export function lights(t: number): { boulevard: boolean; cross: boolean } {
  return { boulevard: t >= TRAFFIC.greenAtS, cross: t < TRAFFIC.greenAtS - 3.5 };
}

export function makeLanes(): Lane[] {
  const lanes: Lane[] = [];
  const c = STREET.crossings[0];
  const half = crossRoadHalf(c.widthM);
  const zFar = -900;
  const zNear = 80;
  const len = zNear - zFar;
  // Away from the camera (−z) on the right (+x); the stop line before the zebra on the near side.
  const awayStop = zNear - (c.zM + half + 5.4);
  const towardStop = c.zM - half - 5.4 - zFar;
  for (const x of [STREET.laneXM[0], STREET.laneXM[1]]) lanes.push({ x0: x, z0: zNear, dx: 0, dz: -1, lengthM: len, stopS: awayStop, light: 'boulevard', bikes: false });
  lanes.push({ x0: 6.35, z0: zNear, dx: 0, dz: -1, lengthM: len, stopS: awayStop, light: 'boulevard', bikes: true });
  for (const x of [STREET.laneXM[0], STREET.laneXM[1]]) lanes.push({ x0: -x, z0: zFar, dx: 0, dz: 1, lengthM: len, stopS: towardStop, light: 'boulevard', bikes: false });
  lanes.push({ x0: -6.35, z0: zFar, dx: 0, dz: 1, lengthM: len, stopS: towardStop, light: 'boulevard', bikes: true });
  // The cross street: one lane each way (keeping right), stop lines before the boulevard's kerb.
  const reach = 140;
  lanes.push({ x0: -reach, z0: c.zM + 1.6, dx: 1, dz: 0, lengthM: 2 * reach, stopS: reach - STREET.carriageHalfM - 2.5, light: 'cross', bikes: false });
  lanes.push({ x0: reach, z0: c.zM - 1.6, dx: -1, dz: 0, lengthM: 2 * reach, stopS: reach - STREET.carriageHalfM - 2.5, light: 'cross', bikes: false });
  return lanes;
}

export class Traffic {
  readonly lanes = makeLanes();
  readonly vehicles: Vehicle[] = [];

  constructor(seed: number) {
    const r = new Rng(seed);
    for (const lane of this.lanes) {
      const n = lane.bikes ? 3 : lane.dx !== 0 ? 4 : TRAFFIC.perLane;
      for (let i = 0; i < n; i++) {
        // Buses keep to the boulevard's outer lanes.
        const kind: VehicleKind = lane.bikes ? 'bike' : lane.dx === 0 && Math.abs(lane.x0) > 3 && r.next() < 0.12 ? 'bus' : r.next() < 0.12 ? 'taxi' : 'car';
        const lengthM = kind === 'bus' ? 12 : kind === 'bike' ? 1.8 : 4.3;
        this.vehicles.push({
          kind,
          lane,
          s: (lane.lengthM * (i + r.next() * 0.6)) / n,
          v: 0,
          lengthM,
          desiredMs: kind === 'bike' ? r.range(4, 5.5) : kind === 'bus' ? 9.5 : TRAFFIC.desiredSpeedMs * r.range(0.85, 1.12),
          variant: r.int(2),
          paint: r.int(16),
          wheelRad: r.next() * 6,
          braking: false,
          crankRad: r.next() * 6,
        });
      }
    }
  }

  /** Advances every vehicle by dt at clip time t. */
  step(dt: number, t: number): void {
    const state = lights(t);
    for (const lane of this.lanes) {
      const inLane = this.vehicles.filter((v) => v.lane === lane).sort((a, b) => a.s - b.s);
      const red = lane.light !== null && !state[lane.light];
      inLane.forEach((me, i) => {
        const ahead = inLane[(i + 1) % inLane.length] as Vehicle;
        let gap = ahead === me ? 1e4 : ahead.s - me.s - (ahead.lengthM + me.lengthM) / 2;
        if (gap < -lane.lengthM / 2) gap += lane.lengthM;
        let leaderV = ahead.v;
        const front = me.s + me.lengthM / 2;
        if (red && lane.stopS !== null && front < lane.stopS + 0.5 && lane.stopS - front < gap) {
          // A red light is a car standing at the line; one already over it carries on.
          gap = lane.stopS - front;
          leaderV = 0;
        }
        const a = idmAccel(me.v, me.desiredMs, gap, me.v - leaderV);
        me.braking = a < -0.6 || (me.v < 0.3 && gap < 6);
        me.v = Math.max(0, me.v + a * dt);
        me.s += me.v * dt;
        if (me.s > lane.lengthM) me.s -= lane.lengthM;
        me.wheelRad += (me.v * dt) / (me.kind === 'bike' ? 0.34 : me.kind === 'bus' ? 0.5 : 0.316);
        if (me.kind === 'bike') me.crankRad += ((me.v * dt) / 0.34) * (1 / 2.6);
      });
    }
  }
}

/** IDM acceleration for speed v toward v0 with `gap` m to the leader closing at `dv` m/s. */
export function idmAccel(v: number, v0: number, gap: number, dv: number): number {
  const T = TRAFFIC;
  const sStar = T.minGapM + Math.max(0, v * T.timeHeadwayS + (v * dv) / (2 * Math.sqrt(T.maxAccelMs2 * T.comfortDecelMs2)));
  const free = 1 - (v / v0) ** 4;
  const interact = (sStar / Math.max(gap, 0.1)) ** 2;
  return Math.max(-8, T.maxAccelMs2 * (free - interact));
}

/** World position and heading (yaw, 0 = facing −z) of a vehicle. */
export function placeOf(v: Vehicle): { x: number; z: number; yawRad: number } {
  const l = v.lane;
  return { x: l.x0 + l.dx * v.s, z: l.z0 + l.dz * v.s, yawRad: Math.atan2(-l.dx, -l.dz) };
}
