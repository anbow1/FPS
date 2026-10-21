import { PEOPLE, STREET, TRAFFIC } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { groundY, inCrossing, type StreetPlan } from '../city/plan.ts';
import { crossRoadHalf } from '../city/street.ts';
import { terraceLayout } from '../city/furniture.ts';
import { type Build, BUILDS } from './body.ts';

// The people on the pavements, as a simulation stepped at a fixed rate (so a
// recording is the same every time):
//   - walkers going both ways along both pavements at their own preferred
//     speeds (pedestrian studies: ~1.34 m/s, sd ~0.2), keeping to their right
//     when they meet, slowing behind slower ones, stepping round kiosks,
//     columns and café terraces;
//   - a group crossing the boulevard on the zebra while the cars wait at the
//     red light, joining the pavement on the far side;
//   - couples stopped to talk, and people sitting at the café tables.
//
// Frame: z along the boulevard (−z away from the camera), x across, yaw 0 =
// facing −z, positive turning toward −x (three's rotation about +Y).

export type Mode = 'walk' | 'stand' | 'sit' | 'wait' | 'ride';

export interface Person {
  build: Build;
  /** Palette indices: top, bottom, hair, accent; skin tone 0…1. */
  look: [number, number, number, number];
  skin: number;
  /** Uniform size about a 1.75 m man / 1.63 m woman. */
  scale: number;
  mode: Mode;
  x: number;
  z: number;
  y: number;
  yawRad: number;
  speedMs: number;
  preferredMs: number;
  /** Along the boulevard: +1 toward +z, −1 toward −z. */
  dir: 1 | -1;
  /** Where across the pavement they like to walk. */
  laneX: number;
  /** Gait cycle 0…1 (mocap): 0 and ½ are both feet planted apart. */
  gait: number;
  /** A turn of the head, rad (looking at windows, at the street). */
  headYawRad: number;
  /** For the crossers: when they step off, and where they go (x of the far kerb). */
  crossAtS: number;
  crossToX: number;
  /** Riders: the pedal crank's angle (rad). */
  crankRad: number;
}

export class Crowd {
  readonly people: Person[] = [];
  private readonly rng: Rng;
  private readonly terraces: { side: number; zMin: number; zMax: number }[];
  private readonly obstacles: { x: number; z: number; r: number }[];

  constructor(plan: StreetPlan, seed: number, startS: number) {
    this.rng = new Rng(seed);
    this.terraces = plan.cafes.filter((c) => c.zMax > -400).map((c) => ({ side: c.side, zMin: c.zMin - 1.5, zMax: c.zMax + 1.5 }));
    this.obstacles = [
      ...plan.kiosks.map((k) => ({ x: k.x, z: k.z, r: 1.9 })),
      ...plan.columns.map((c) => ({ x: c.x, z: c.z, r: 1.2 })),
      ...plan.benches.map((b) => ({ x: b.x, z: b.z, r: 1.0 })),
    ];
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < PEOPLE.walkersPerSide; i++) this.people.push(this.walker(side, this.rng.range(PEOPLE.spanFarZM, PEOPLE.spanNearZM)));
    }
    this.addCrossers(startS);
    this.addTalkers();
    this.addSitters(plan);
  }

  private newPerson(mode: Mode, x: number, z: number): Person {
    const r = this.rng;
    const build = r.pick(BUILDS);
    const woman = build === 'coatWoman' || build === 'skirtWoman';
    const pref = Math.max(0.9, PEOPLE.walkSpeedMeanMs + r.gauss() * PEOPLE.walkSpeedSdMs - (woman ? 0.05 : 0));
    return {
      build,
      look: [r.int(12), r.int(10), r.int(8), r.int(10)],
      skin: r.next(),
      scale: (woman ? 0.93 : 1) * r.range(0.95, 1.05),
      mode,
      x,
      z,
      y: groundY(x, z),
      yawRad: 0,
      speedMs: 0,
      preferredMs: pref,
      dir: -1,
      laneX: x,
      gait: r.next() < 0.5 ? 0 : 0.5,
      headYawRad: 0,
      crossAtS: 0,
      crossToX: 0,
      crankRad: 0,
    };
  }

  private walker(side: -1 | 1, z: number): Person {
    const r = this.rng;
    const x = side * r.range(PEOPLE.walkInnerXM, PEOPLE.walkOuterXM);
    const p = this.newPerson('walk', x, z);
    p.dir = r.next() < 0.5 ? 1 : -1;
    // Keep to the right: going −z the right hand is +x.
    const keepRight = p.dir < 0 ? 1 : -1;
    p.laneX = side * PEOPLE.walkInnerXM + side * (PEOPLE.walkOuterXM - PEOPLE.walkInnerXM) * (0.5 + 0.35 * keepRight * side * r.next());
    p.x = p.laneX;
    p.speedMs = p.preferredMs;
    p.yawRad = p.dir < 0 ? 0 : Math.PI;
    p.gait = r.next();
    return p;
  }

  /** People waiting at the first crossing's zebra; they step off in turn once the boulevard's light is red. */
  private addCrossers(startS: number): void {
    const c = STREET.crossings[0];
    const zebraZ = c.zM + crossRoadHalf(c.widthM) + 2.5;
    for (let i = 0; i < 9; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const p = this.newPerson('wait', side * (STREET.carriageHalfM + 0.5 + this.rng.next() * 1.2), zebraZ + (this.rng.next() - 0.5) * 3);
      p.crossAtS = startS + 1.0 + this.rng.next() * 4 + (i > 5 ? 4 : 0);
      p.crossToX = -side * (STREET.carriageHalfM + 1.0 + this.rng.next() * 1.5);
      p.yawRad = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      p.speedMs = 0;
      this.people.push(p);
    }
  }

  /** Couples stopped on the pavement, facing each other. */
  private addTalkers(): void {
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const z = -10 - i * 23 - this.rng.next() * 8;
      if (inCrossing(z, 4)) continue;
      const x = side * 13.4;
      const a = this.newPerson('stand', x, z);
      const b = this.newPerson('stand', x - side * 0.45, z - 0.75);
      a.yawRad = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI;
      b.yawRad = Math.atan2(a.x - b.x, a.z - b.z) + Math.PI;
      this.people.push(a, b);
    }
  }

  private addSitters(plan: StreetPlan): void {
    const { chairs } = terraceLayout(plan.cafes);
    for (const ch of chairs) {
      if (ch.z < -110 || this.rng.next() > 0.4) continue;
      const p = this.newPerson('sit', ch.x, ch.z);
      p.yawRad = ch.yaw;
      p.y = STREET.kerbM;
      p.headYawRad = (this.rng.next() - 0.5) * 0.8;
      this.people.push(p);
    }
  }

  /** A rider for a bicycle (placed each frame from the bike: rideWith). */
  addRider(): Person {
    const p = this.newPerson('ride', 0, 0);
    this.people.push(p);
    return p;
  }

  /** Advances everyone by dt seconds; `t` is the clip time, `boulevardRed` whether cars stop for the crossing. */
  step(dt: number, t: number, boulevardRed: boolean): void {
    for (const p of this.people) {
      if (p.mode === 'walk') this.stepWalker(p, dt);
      else if (p.mode === 'wait') this.stepCrosser(p, dt, t, boulevardRed);
      p.y = groundY(p.x, p.z);
    }
  }

  private stepCrosser(p: Person, dt: number, t: number, red: boolean): void {
    if (t < p.crossAtS || (!red && Math.abs(p.x) > STREET.carriageHalfM)) {
      p.speedMs = Math.max(0, p.speedMs - dt * 2);
      return;
    }
    const toward = Math.sign(p.crossToX - p.x);
    p.speedMs = Math.min(p.preferredMs * 1.05, p.speedMs + dt * 1.5);
    p.x += toward * p.speedMs * dt;
    p.yawRad = toward > 0 ? -Math.PI / 2 : Math.PI / 2;
    if (Math.abs(p.x - p.crossToX) < 0.2) {
      // On the far pavement: turn into the flow.
      p.mode = 'walk';
      p.dir = this.rng.next() < 0.5 ? 1 : -1;
      p.laneX = Math.sign(p.x) * this.rng.range(PEOPLE.walkInnerXM, PEOPLE.walkOuterXM);
    }
  }

  private stepWalker(p: Person, dt: number): void {
    // Who is ahead in the way: slow behind a slower one, sidestep oncoming ones (to the right).
    let target = p.preferredMs;
    let push = 0;
    for (const o of this.people) {
      if (o === p || Math.sign(o.x) !== Math.sign(p.x)) continue;
      const dz = (o.z - p.z) * p.dir;
      const dx = o.x - p.x;
      if (dz <= 0 || dz > 4 || Math.abs(dx) > 1.2) continue;
      const oncoming = o.mode === 'walk' && o.dir !== p.dir;
      if (oncoming || o.mode !== 'walk') {
        const right = p.dir < 0 ? 1 : -1;
        push += (dx === 0 ? right : -Math.sign(dx)) * (1.2 - Math.abs(dx)) * (1 - dz / 4) * 1.2 + right * 0.15;
      } else if (dz < 1.6 && Math.abs(dx) < 0.55) {
        target = Math.min(target, o.speedMs);
        push += (dx > 0 ? -1 : 1) * 0.3;
      }
    }
    // The pavement's free band here: between the tree line and the facades, or the café terrace's edge.
    const side = Math.sign(p.x);
    let outer: number = PEOPLE.walkOuterXM;
    for (const tr of this.terraces) if (tr.side === side && p.z > tr.zMin - 1 && p.z < tr.zMax + 1) outer = Math.min(outer, STREET.facadeHalfM - 3.2);
    let lane = Math.min(outer - 0.2, Math.max(PEOPLE.walkInnerXM - 0.2, Math.abs(p.laneX)));
    for (const ob of this.obstacles) {
      const dz = (ob.z - p.z) * p.dir;
      if (Math.sign(ob.x) === side && dz > -ob.r && dz < ob.r + 3) {
        // Go round on the wider side.
        const ax = Math.abs(ob.x);
        lane = ax - ob.r > PEOPLE.walkInnerXM - 0.6 ? Math.min(lane, ax - ob.r - 0.1) : Math.max(lane, ax + ob.r + 0.1);
      }
    }
    // Never into the trees, the terraces or the walls, whatever the crowd pushes.
    const wantX = side * Math.min(outer - 0.1, Math.max(PEOPLE.walkInnerXM - 0.4, lane + side * push));
    p.x += Math.max(-0.8, Math.min(0.8, (wantX - p.x) * 2)) * dt;
    p.speedMs += Math.max(-2, Math.min(1, (target - p.speedMs) * 2)) * dt;
    p.z += p.dir * p.speedMs * dt;
    const vx = (wantX - p.x) * 0.6;
    // Facing where they go: yaw 0 looks down −z.
    p.yawRad = Math.atan2(-vx, -p.dir * Math.max(0.2, p.speedMs));
    // Out of the span at one end, back in at the other (both ends are far off or behind the camera).
    const span = PEOPLE.spanNearZM - PEOPLE.spanFarZM;
    if (p.z < PEOPLE.spanFarZM) p.z += span;
    if (p.z > PEOPLE.spanNearZM) p.z -= span;
  }
}

/** Whether the boulevard's light at the first crossing is red at clip time t. */
export function boulevardRed(t: number): boolean {
  return t < TRAFFIC.greenAtS;
}
