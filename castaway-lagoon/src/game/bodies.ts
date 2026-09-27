import { PHYSICS, STONE, WATER_LEVEL_M } from '../config.ts';
import { type CollisionWorld, newHit, type RayHit } from './colliders.ts';
import type { EventQueue, P3 } from './events.ts';
import { heightAt } from './terrain.ts';
import type { TinCan } from './world.ts';

// Small free bodies: thrown stones, ejected shell casings and the tin cans on
// the log. Point masses with quadratic drag, swept against the collision world
// each step so a fast stone never tunnels through a rock (rules §5).

export type BodyKind = 'stone' | 'shell';
export type BodyState = 'flying' | 'sinking' | 'resting';

export interface Body {
  id: number;
  kind: BodyKind;
  pos: P3;
  prev: P3;
  vel: P3;
  spin: P3;
  rot: P3;
  state: BodyState;
  ageSeconds: number;
  skips: number;
}

export interface BodyRest {
  body: Body;
  underwater: boolean;
}

const SHELL_LIFE_SECONDS = 25;
const SHELL_RADIUS_M = 0.006;
const CAN_RADIUS_M = 0.04;
const CAN_RESPAWN_SECONDS = 25;

export class Bodies {
  readonly list: Body[] = [];
  private nextId = 1;
  private readonly hit: RayHit = newHit();
  private readonly dir = { x: 0, y: 0, z: 0 };
  private canTimer = 0;

  constructor(
    private readonly collision: CollisionWorld,
    private readonly events: EventQueue,
  ) {}

  throwStone(from: P3, vel: P3): void {
    this.spawn('stone', from, vel);
    let stones = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i] as Body;
      if (b.kind !== 'stone') continue;
      if (++stones > STONE.maxLive) this.list.splice(i, 1);
    }
  }

  ejectShell(from: P3, vel: P3): void {
    this.spawn('shell', from, vel);
  }

  private spawn(kind: BodyKind, from: P3, vel: P3): void {
    this.list.push({
      id: this.nextId++,
      kind,
      pos: { ...from },
      prev: { ...from },
      vel: { ...vel },
      spin: { x: 12 + this.nextId % 7, y: 8, z: 5 },
      rot: { x: 0, y: 0, z: 0 },
      state: 'flying',
      ageSeconds: 0,
      skips: 0,
    });
  }

  /** Advances every body; stones that come to rest are returned so the game can turn them back into pick-ups. */
  step(dt: number, cans: TinCan[], rested: BodyRest[]): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i] as Body;
      b.ageSeconds += dt;
      b.prev.x = b.pos.x;
      b.prev.y = b.pos.y;
      b.prev.z = b.pos.z;
      if (b.kind === 'shell' && b.ageSeconds > SHELL_LIFE_SECONDS) {
        this.list.splice(i, 1);
        continue;
      }
      if (b.state === 'resting') continue;
      if (b.state === 'sinking') {
        const floor = heightAt(b.pos.x, b.pos.z) + STONE.radiusM;
        b.pos.y = Math.max(floor, b.pos.y - STONE.sinkSpeedMs * dt);
        b.pos.x += b.vel.x * dt;
        b.pos.z += b.vel.z * dt;
        b.vel.x *= 0.9;
        b.vel.z *= 0.9;
        if (b.pos.y <= floor + 1e-3) {
          b.state = 'resting';
          if (b.kind === 'stone') {
            rested.push({ body: b, underwater: true });
            this.list.splice(i, 1);
          }
        }
        continue;
      }
      const radius = b.kind === 'stone' ? STONE.radiusM : SHELL_RADIUS_M;
      integrate(b, dt, b.kind === 'stone' ? stoneDragPerM() : 0.02);
      b.rot.x += b.spin.x * dt;
      b.rot.y += b.spin.y * dt;
      b.rot.z += b.spin.z * dt;
      if (b.kind === 'stone') this.stoneHitsCans(b, cans);
      if (this.sweep(b, radius)) {
        if ((b.state as BodyState) === 'resting' && b.kind === 'stone') { // sweep() may have put it to rest
          rested.push({ body: b, underwater: b.pos.y < WATER_LEVEL_M });
          this.list.splice(i, 1);
        }
      }
    }
    this.stepCans(dt, cans);
  }

  /** Collides the segment prev → pos. Returns true if anything was touched. */
  private sweep(b: Body, radius: number): boolean {
    const d = this.dir;
    d.x = b.pos.x - b.prev.x;
    d.y = b.pos.y - b.prev.y;
    d.z = b.pos.z - b.prev.z;
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 1e-7) return false;
    d.x /= len;
    d.y /= len;
    d.z /= len;
    // Water first: stones either skip or go under.
    if (b.prev.y > WATER_LEVEL_M && b.pos.y <= WATER_LEVEL_M && heightAt(b.pos.x, b.pos.z) < WATER_LEVEL_M - radius * 2) {
      const t = (b.prev.y - WATER_LEVEL_M) / Math.max(1e-6, b.prev.y - b.pos.y);
      const x = b.prev.x + (b.pos.x - b.prev.x) * t;
      const z = b.prev.z + (b.pos.z - b.prev.z) * t;
      const horizontal = Math.hypot(b.vel.x, b.vel.z);
      const speed = Math.hypot(horizontal, b.vel.y);
      const entryRad = Math.atan2(-b.vel.y, horizontal);
      const skip = b.kind === 'stone' && entryRad < STONE.skipMaxAngleRad && speed > STONE.skipMinSpeedMs && b.skips < 8;
      this.events.push({ type: 'splash', pos: { x, y: WATER_LEVEL_M, z }, speedMs: speed, massKg: b.kind === 'stone' ? STONE.massKg : 0.008, skip });
      if (skip) {
        b.skips++;
        b.pos.x = x;
        b.pos.z = z;
        b.pos.y = WATER_LEVEL_M + 0.001;
        b.vel.x *= STONE.skipSpeedKeep;
        b.vel.z *= STONE.skipSpeedKeep;
        b.vel.y = Math.abs(b.vel.y) * 0.55 + 0.6;
      } else {
        b.state = 'sinking';
        b.pos.x = x;
        b.pos.z = z;
        b.pos.y = WATER_LEVEL_M - 0.02;
        b.vel.x *= 0.15;
        b.vel.z *= 0.15;
      }
      return true;
    }
    if (!this.collision.raycast(b.prev, d, len + radius, this.hit, false)) return false;
    const h = this.hit;
    const vn = b.vel.x * h.nx + b.vel.y * h.ny + b.vel.z * h.nz;
    if (vn >= 0) return false;
    const restitution = b.kind === 'stone' ? (h.surface === 'sand' || h.surface === 'wetSand' ? STONE.restitution * 0.5 : STONE.restitution) : 0.3;
    b.vel.x -= (1 + restitution) * vn * h.nx;
    b.vel.y -= (1 + restitution) * vn * h.ny;
    b.vel.z -= (1 + restitution) * vn * h.nz;
    const keep = 1 - STONE.groundFriction * (h.surface === 'sand' || h.surface === 'wetSand' ? 1 : 0.5);
    b.vel.x *= keep;
    b.vel.z *= keep;
    b.pos.x = h.x + h.nx * radius;
    b.pos.y = h.y + h.ny * radius;
    b.pos.z = h.z + h.nz * radius;
    b.spin.x *= 0.6;
    b.spin.y *= 0.6;
    b.spin.z *= 0.6;
    if (-vn > 0.8) this.events.push({ type: 'bodyHit', pos: { ...b.pos }, surface: h.surface, speedMs: -vn, body: b.kind });
    const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    if (speed < STONE.restSpeedMs * (b.kind === 'shell' ? 3 : 1) && h.ny > 0.55) {
      b.state = 'resting';
      b.vel.x = 0;
      b.vel.y = 0;
      b.vel.z = 0;
    }
    return true;
  }

  private stoneHitsCans(b: Body, cans: TinCan[]): void {
    for (const c of cans) {
      const dx = c.pos.x - b.pos.x;
      const dy = c.pos.y - b.pos.y;
      const dz = c.pos.z - b.pos.z;
      const r = CAN_RADIUS_M + STONE.radiusM;
      if (dx * dx + dy * dy + dz * dz > r * r) continue;
      knockCan(c, b.vel, 0.5);
      this.events.push({ type: 'canHit', id: c.id });
      b.vel.x *= -0.3;
      b.vel.z *= -0.3;
    }
  }

  private stepCans(dt: number, cans: TinCan[]): void {
    let down = 0;
    for (const c of cans) {
      if (c.resting) {
        if (c.vel.y === 0 && c.spin.x !== 0) down++;
        continue;
      }
      const prevY = c.pos.y;
      c.vel.y -= PHYSICS.gravityMs2 * dt;
      c.pos.x += c.vel.x * dt;
      c.pos.y += c.vel.y * dt;
      c.pos.z += c.vel.z * dt;
      c.rot.x += c.spin.x * dt;
      c.rot.y += c.spin.y * dt;
      c.rot.z += c.spin.z * dt;
      const ground = this.collision.groundAt(c.pos.x, c.pos.z, prevY, 0.05) + CAN_RADIUS_M;
      const floor = Math.max(ground, heightAt(c.pos.x, c.pos.z) < WATER_LEVEL_M ? heightAt(c.pos.x, c.pos.z) + CAN_RADIUS_M : ground);
      if (c.pos.y <= floor) {
        c.pos.y = floor;
        if (Math.abs(c.vel.y) > 1.2) this.events.push({ type: 'bodyHit', pos: { ...c.pos }, surface: 'metal', speedMs: Math.abs(c.vel.y), body: 'can' });
        c.vel.y = -c.vel.y * 0.35;
        c.vel.x *= 0.6;
        c.vel.z *= 0.6;
        c.spin.y *= 0.5;
        if (Math.hypot(c.vel.x, c.vel.y, c.vel.z) < 0.4) {
          c.resting = true;
          c.vel.x = 0;
          c.vel.y = 0;
          c.vel.z = 0;
          c.rot.x = Math.PI / 2; // tipped over on its side
          c.spin.x = 1; // marks "knocked down"
        }
      }
    }
    if (down === cans.length && cans.length > 0) {
      this.canTimer += dt;
      if (this.canTimer > CAN_RESPAWN_SECONDS) {
        this.canTimer = 0;
        for (const c of cans) resetCan(c);
      }
    } else this.canTimer = 0;
  }
}

function resetCan(c: TinCan): void {
  c.pos.x = c.home.x;
  c.pos.y = c.home.y;
  c.pos.z = c.home.z;
  c.rot.x = 0;
  c.rot.z = 0;
  c.spin.x = 0;
  c.spin.y = 0;
  c.spin.z = 0;
  c.resting = true;
}

export function knockCan(c: TinCan, dir: P3, scale: number): void {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  c.resting = false;
  c.vel.x = (dir.x / len) * 4.5 * scale * 2;
  c.vel.z = (dir.z / len) * 4.5 * scale * 2;
  c.vel.y = 3.2 + scale * 1.5;
  c.spin.x = 14 * (0.5 + scale);
  c.spin.y = 6;
  c.spin.z = 9;
}

export function canRadius(): number {
  return CAN_RADIUS_M;
}

/** Quadratic drag factor k = ½ ρ C_d A / m, per metre. */
function stoneDragPerM(): number {
  const area = Math.PI * STONE.radiusM * STONE.radiusM;
  return (0.5 * PHYSICS.airDensityKgM3 * STONE.dragCoefficient * area) / STONE.massKg;
}

function integrate(b: Body, dt: number, dragPerM: number): void {
  const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
  const drag = dragPerM * speed;
  b.vel.x -= b.vel.x * drag * dt;
  b.vel.y -= (b.vel.y * drag + PHYSICS.gravityMs2) * dt;
  b.vel.z -= b.vel.z * drag * dt;
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.pos.z += b.vel.z * dt;
}
