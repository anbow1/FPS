import { TARGETS, type TargetKind } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { Vec3 } from '../core/vec.ts';

// The ground force for free flight: armour and soft vehicles up the valley
// north of the base — parked groups on the river banks and a convoy driving
// the valley road — so the weapons have something to work on. They do not
// shoot back yet (brief step 7); they burn when killed, and a fresh force
// rolls in once the last one is gone.
//
// Armour by aspect (brief: "a top attack works, a frontal hit often does
// not"): the damage a hit does is scaled by where it came from — the front,
// a side, the rear, or steeply from above.

export interface GroundTarget {
  readonly id: number;
  readonly kind: TargetKind;
  readonly position: Vec3;
  /** Direction the vehicle faces (rad, 0 = north / −z, positive turning left, as the helicopter's yaw). */
  headingRad: number;
  health: number;
  alive: boolean;
  /** Seconds since it was destroyed (it burns, then smoulders). */
  deadS: number;
  /** Convoy vehicles drive the road between two points along the valley; parked ones have none. */
  route: { z0: number; z1: number; offsetM: number; dir: 1 | -1 } | null;
  readonly velocity: Vec3;
}

export interface TerrainQuery {
  groundAt(x: number, z: number): number;
  riverX(z: number): number;
  /** Forest cover 0…1 (optional): parked vehicles look for open ground, where they can be seen. */
  forestAt?(x: number, z: number): number;
}

/** Where a shot travelling along `travel` (world, need not be unit) hits the vehicle: its damage factor. */
export function armourFactor(t: GroundTarget, travel: Vec3): number {
  const a = TARGETS[t.kind].armour;
  const len = Math.hypot(travel.x, travel.y, travel.z) || 1;
  // Steeply from above: the thin roof.
  if (-travel.y / len > 0.6) return a.top;
  // Towards the shooter, against the vehicle's facing: + from the front, − from the rear.
  const fx = -Math.sin(t.headingRad);
  const fz = -Math.cos(t.headingRad);
  const h = Math.hypot(travel.x, travel.z) || 1;
  const facing = -(travel.x * fx + travel.z * fz) / h;
  return facing > 0.7 ? a.front : facing < -0.7 ? a.rear : a.side;
}

export class GroundForce {
  readonly targets: GroundTarget[] = [];
  /** Waves sent so far (the first is 1). */
  wave = 0;
  private nextId = 1;
  private allDeadS = -1;

  constructor(private readonly land: TerrainQuery) {
    this.deploy();
  }

  get alive(): number {
    let n = 0;
    for (const t of this.targets) if (t.alive) n++;
    return n;
  }

  /** A fresh force: parked groups at four places up the valley and one convoy on the road. */
  deploy(): void {
    this.wave++;
    this.targets.length = 0;
    this.allDeadS = -1;
    const rng = new Rng(1000 + this.wave * 17);
    const groups: { z: number; side: 1 | -1; kinds: TargetKind[] }[] = [
      { z: -2300, side: 1, kinds: ['truck', 'truck', 'apc'] },
      { z: -3700, side: -1, kinds: ['tank', 'apc', 'truck'] },
      { z: -5300, side: 1, kinds: ['tank', 'tank', 'apc', 'truck'] },
      { z: -7000, side: -1, kinds: ['apc', 'truck', 'truck', 'tank'] },
    ];
    for (const g of groups) {
      // An open, level patch off the bank: outwards from the river, then up and down the valley, until the
      // ground is gentle and clear of trees (vehicles parked in a wood would be invisible).
      let cx = this.land.riverX(g.z) + g.side * 160;
      let cz = g.z;
      search: for (let ring = 0; ring < 12; ring++)
        for (const dz of [0, 150, -150]) {
          const x = this.land.riverX(g.z + dz) + g.side * (160 + ring * 60);
          if (this.slope(x, g.z + dz) < 0.15 && (this.land.forestAt?.(x, g.z + dz) ?? 0) < 0.08) {
            cx = x;
            cz = g.z + dz;
            break search;
          }
        }
      const heading = rng.range(-Math.PI, Math.PI);
      g.kinds.forEach((kind, i) => {
        const along = (i - (g.kinds.length - 1) / 2) * 22;
        const x = cx + Math.cos(heading) * along + rng.range(-4, 4);
        const z = cz - Math.sin(heading) * along + rng.range(-4, 4);
        this.add(kind, x, z, heading + rng.range(-0.4, 0.4), null);
      });
    }
    // The convoy: nose to tail along the valley, clear of the riverside woods on the east bank.
    const convoy: TargetKind[] = ['apc', 'truck', 'truck', 'tank'];
    convoy.forEach((kind, i) => {
      const z = -2800 - i * 28;
      this.add(kind, this.roadX(z, 260), z, 0, { z0: -2600, z1: -6600, offsetM: 260, dir: 1 });
    });
  }

  /** Puts a vehicle on the ground at (x, z). */
  add(kind: TargetKind, x: number, z: number, headingRad: number, route: GroundTarget['route']): GroundTarget {
    const t: GroundTarget = {
      id: this.nextId++,
      kind,
      position: new Vec3(x, this.land.groundAt(x, z), z),
      headingRad,
      health: TARGETS[kind].health,
      alive: true,
      deadS: 0,
      route,
      velocity: new Vec3(),
    };
    this.targets.push(t);
    return t;
  }

  private roadX(z: number, offsetM: number): number {
    return this.land.riverX(z) + offsetM;
  }

  private slope(x: number, z: number): number {
    const g = this.land.groundAt;
    return Math.hypot(g(x + 8, z) - g(x - 8, z), g(x, z + 8) - g(x, z - 8)) / 16;
  }

  step(dtS: number): void {
    for (const t of this.targets) {
      t.velocity.set(0, 0, 0);
      if (!t.alive) {
        t.deadS += dtS;
        continue;
      }
      const r = t.route;
      if (!r) continue;
      // Drive along the road; turn round at either end.
      const v = TARGETS[t.kind].speedMs * 0.8;
      const z = t.position.z - r.dir * v * dtS;
      if ((r.dir === 1 && z < r.z1) || (r.dir === -1 && z > r.z0)) r.dir = r.dir === 1 ? -1 : 1;
      const x = this.roadX(z, r.offsetM);
      t.velocity.set((x - t.position.x) / dtS, 0, (z - t.position.z) / dtS);
      t.headingRad = Math.atan2(-(x - t.position.x), -(z - t.position.z));
      t.position.set(x, this.land.groundAt(x, z), z);
    }
    if (this.alive === 0) {
      if (this.allDeadS < 0) this.allDeadS = 0;
      this.allDeadS += dtS;
    }
  }

  /** True once every target has been dead for `delayS`: time for a new wave. */
  cleared(delayS: number): boolean {
    return this.allDeadS >= delayS;
  }

  /**
   * Damage from a hit travelling along `travel` (a direct hit), or from a burst nearby (`splash`: the
   * direction is from the burst); returns true if it destroyed the target.
   */
  damage(t: GroundTarget, amount: number, travel: Vec3, splash = false): boolean {
    if (!t.alive) return false;
    t.health -= amount * armourFactor(t, travel) * (splash ? TARGETS[t.kind].splash : 1);
    if (t.health > 1e-6) return false;
    t.alive = false;
    t.deadS = 0;
    t.route = null;
    return true;
  }

  /** Centre of a target's hit volume (m above its ground point). */
  static centre(t: GroundTarget, out: Vec3): Vec3 {
    return out.set(t.position.x, t.position.y + 1.4, t.position.z);
  }
}
