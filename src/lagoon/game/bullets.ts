import { PHYSICS } from '../../config.ts';
import { RIFLE } from '../config.ts';
import { knockCan } from './bodies.ts';
import { type CollisionWorld, newHit, type RayHit, WATER_HIT } from './colliders.ts';
import type { EventQueue, P3 } from './events.ts';
import type { TinCan } from './world.ts';

// Rifle bullets as point masses with gravity and quadratic drag, ray-cast
// segment by segment every step (rules §5). Each step's segment is tested
// against the terrain, shapes, the water surface, leaf volumes and the cans.

interface Bullet {
  pos: P3;
  vel: P3;
  travelledM: number;
  alive: boolean;
}

const MAX_BULLETS = 32;
const CAN_HIT_RADIUS_M = 0.05;

export class Bullets {
  private readonly pool: Bullet[] = [];
  private readonly hit: RayHit = newHit();
  private readonly dir = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly collision: CollisionWorld,
    private readonly events: EventQueue,
  ) {
    for (let i = 0; i < MAX_BULLETS; i++) this.pool.push({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, travelledM: 0, alive: false });
  }

  fire(origin: P3, dir: P3): void {
    const b = this.pool.find((p) => !p.alive);
    if (!b) return;
    b.alive = true;
    b.travelledM = 0;
    b.pos.x = origin.x;
    b.pos.y = origin.y;
    b.pos.z = origin.z;
    b.vel.x = dir.x * RIFLE.muzzleVelocityMs;
    b.vel.y = dir.y * RIFLE.muzzleVelocityMs;
    b.vel.z = dir.z * RIFLE.muzzleVelocityMs;
  }

  step(dt: number, cans: TinCan[]): void {
    for (const b of this.pool) {
      if (!b.alive) continue;
      const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      const drag = RIFLE.dragPerM * speed;
      b.vel.x -= b.vel.x * drag * dt;
      b.vel.y -= (b.vel.y * drag + PHYSICS.gravityMs2) * dt;
      b.vel.z -= b.vel.z * drag * dt;
      const d = this.dir;
      const len = Math.hypot(b.vel.x, b.vel.y, b.vel.z) * dt;
      d.x = b.vel.x / (len / dt);
      d.y = b.vel.y / (len / dt);
      d.z = b.vel.z / (len / dt);
      const canT = this.canAlong(b.pos, d, len, cans);
      const found = this.collision.raycast(b.pos, d, len, this.hit, true);
      if (canT && (!found || canT.t < this.hit.distanceM)) {
        knockCan(canT.can, d, 1);
        this.events.push({ type: 'canHit', id: canT.can.id });
        b.alive = false;
        continue;
      }
      const leafEnd = found ? this.hit.distanceM : len;
      const leaf = this.collision.leavesAlong(b.pos, d, leafEnd);
      if (leaf) this.events.push({ type: 'bulletLeaves', pos: leaf });
      if (found) {
        const h = this.hit;
        this.events.push({
          type: 'bulletImpact',
          pos: { x: h.x, y: h.y, z: h.z },
          normal: { x: h.nx, y: h.ny, z: h.nz },
          dir: { ...d },
          surface: h.colliderIndex === WATER_HIT ? 'water' : h.surface,
          distanceM: b.travelledM + h.distanceM,
        });
        b.alive = false;
        continue;
      }
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.pos.z += b.vel.z * dt;
      b.travelledM += len;
      if (b.travelledM > RIFLE.maxRangeM) b.alive = false;
    }
  }

  private canAlong(o: P3, d: P3, maxT: number, cans: TinCan[]): { can: TinCan; t: number } | null {
    let best: { can: TinCan; t: number } | null = null;
    for (const c of cans) {
      const ox = o.x - c.pos.x;
      const oy = o.y - c.pos.y;
      const oz = o.z - c.pos.z;
      const b = ox * d.x + oy * d.y + oz * d.z;
      const cc = ox * ox + oy * oy + oz * oz - CAN_HIT_RADIUS_M * CAN_HIT_RADIUS_M;
      const disc = b * b - cc;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t < 0 || t > maxT) continue;
      if (!best || t < best.t) best = { can: c, t };
    }
    return best;
  }
}
