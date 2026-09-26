import { GRENADES, type GrenadeKind, PHYSICS } from '../config.ts';
import { directionFromYawPitch, Vec3 } from '../core/vec.ts';
import type { CollisionWorld, RayBoxHit } from './collision.ts';
import type { EventQueue } from './events.ts';

// Frag, smoke and flash grenades. Smoke clouds are real volumes that block AI
// vision rays, not only the camera (brief).

export interface Grenade {
  active: boolean;
  kind: GrenadeKind;
  pos: Vec3;
  vel: Vec3;
  fuseSeconds: number;
  byPlayer: boolean;
  resting: boolean;
  spinRad: number;
}

export interface SmokeCloud {
  active: boolean;
  pos: Vec3;
  ageSeconds: number;
  radiusM: number;
}

export interface ExplosionTarget {
  id: number;
  alive: boolean;
  isPlayer: boolean;
  chestPosition(out: Vec3): Vec3;
  facing(out: Vec3): Vec3;
  receiveBlast(damage: number, fromDir: Vec3, events: EventQueue): void;
  receiveFlash(amount: number, events: EventQueue): void;
}

const MAX_GRENADES = 16;
const MAX_SMOKES = 8;
const RADIUS_M = 0.04;
const PREVIEW_POINTS = 90;
const PREVIEW_DT = 1 / 30;

export class Grenades {
  readonly grenades: Grenade[] = [];
  readonly smokes: SmokeCloud[] = [];
  readonly previewPoints: Vec3[] = [];
  previewCount = 0;
  cooking: { kind: GrenadeKind; fuseSeconds: number } | null = null;

  constructor() {
    for (let i = 0; i < MAX_GRENADES; i++) {
      this.grenades.push({ active: false, kind: 'frag', pos: new Vec3(), vel: new Vec3(), fuseSeconds: 0, byPlayer: false, resting: false, spinRad: 0 });
    }
    for (let i = 0; i < MAX_SMOKES; i++) this.smokes.push({ active: false, pos: new Vec3(), ageSeconds: 0, radiusM: 0 });
    for (let i = 0; i < PREVIEW_POINTS; i++) this.previewPoints.push(new Vec3());
  }

  static fuseFor(kind: GrenadeKind): number {
    return kind === 'frag' ? GRENADES.fuseFragSeconds : kind === 'smoke' ? GRENADES.fuseSmokeSeconds : GRENADES.fuseFlashSeconds;
  }

  static throwVelocity(yawRad: number, pitchRad: number, speedMs: number, carrier: Vec3, out: Vec3): Vec3 {
    directionFromYawPitch(yawRad, pitchRad + GRENADES.throwUpBiasRad, out).scale(speedMs);
    return out.add(carrier);
  }

  startCook(kind: GrenadeKind): void {
    this.cooking = { kind, fuseSeconds: Grenades.fuseFor(kind) };
  }

  throw(kind: GrenadeKind, origin: Vec3, velocity: Vec3, fuseSeconds: number, byPlayer: boolean, events: EventQueue): void {
    const g = this.grenades.find((x) => !x.active);
    if (!g) return;
    g.active = true;
    g.kind = kind;
    g.pos.copy(origin);
    g.vel.copy(velocity);
    g.fuseSeconds = fuseSeconds;
    g.byPlayer = byPlayer;
    g.resting = false;
    g.spinRad = 0;
    events.push({ type: 'grenadeThrow', kind, byPlayer });
  }

  /** Fills previewPoints with the predicted arc (faint trajectory while cooking). */
  computePreview(world: CollisionWorld, origin: Vec3, velocity: Vec3): void {
    _p.copy(origin);
    _v.copy(velocity);
    this.previewCount = 0;
    for (let i = 0; i < PREVIEW_POINTS; i++) {
      (this.previewPoints[i] as Vec3).copy(_p);
      this.previewCount++;
      const bounced = stepBody(world, _p, _v, PREVIEW_DT, null);
      if (bounced && _v.length() < 1.5) break;
    }
  }

  update(world: CollisionWorld, targets: readonly ExplosionTarget[], events: EventQueue, dt: number): void {
    for (const g of this.grenades) {
      if (!g.active) continue;
      g.fuseSeconds -= dt;
      if (!g.resting) {
        stepBody(world, g.pos, g.vel, dt, events);
        g.spinRad += g.vel.length() * dt * 8;
        if (g.vel.length() < 0.15) g.resting = true;
      }
      if (g.fuseSeconds <= 0) {
        this.detonate(g.kind, g.pos, world, targets, events);
        g.active = false;
      }
    }
    for (const s of this.smokes) {
      if (!s.active) continue;
      s.ageSeconds += dt;
      const grow = Math.min(1, s.ageSeconds / GRENADES.smokeGrowSeconds);
      const fade = s.ageSeconds > GRENADES.smokeDurationSeconds - 8 ? Math.max(0, (GRENADES.smokeDurationSeconds - s.ageSeconds) / 8) : 1;
      s.radiusM = GRENADES.smokeMaxRadiusM * Math.sqrt(grow) * (0.6 + 0.4 * fade);
      if (s.ageSeconds >= GRENADES.smokeDurationSeconds) s.active = false;
    }
  }

  detonate(kind: GrenadeKind, pos: Vec3, world: CollisionWorld, targets: readonly ExplosionTarget[], events: EventQueue): void {
    events.push({ type: 'explosion', pos: pos.clone(), kind });
    _blast.copy(pos);
    _blast.y += 0.15;
    if (kind === 'smoke') {
      const s = this.smokes.find((x) => !x.active) ?? (this.smokes[0] as SmokeCloud);
      s.active = true;
      s.pos.copy(pos);
      s.ageSeconds = 0;
      s.radiusM = 0.5;
      return;
    }
    for (const t of targets) {
      if (!t.alive) continue;
      t.chestPosition(_chest);
      const d = _chest.distanceTo(_blast);
      if (kind === 'frag') {
        if (d > GRENADES.fragMaxRadiusM) continue;
        // Line of sight blocks fragments (brief): walls, cars, terrain.
        if (world.lineBlocked(_blast, _chest, false)) continue;
        const k = d <= GRENADES.fragLethalRadiusM ? 1 : 1 - (d - GRENADES.fragLethalRadiusM) / (GRENADES.fragMaxRadiusM - GRENADES.fragLethalRadiusM);
        _from.subVectors(_chest, _blast).normalize();
        t.receiveBlast(GRENADES.fragMaxDamage * k * k, _from, events);
      } else {
        if (d > GRENADES.flashRadiusM || world.lineBlocked(_blast, _chest, true)) continue;
        t.facing(_facing);
        _from.subVectors(_blast, _chest).normalize();
        const facingCos = _facing.dot(_from);
        const distanceK = 1 - d / GRENADES.flashRadiusM;
        // Looking at it: full white-out; looking away: a fraction still reaches the eye.
        const amount = distanceK * (facingCos > GRENADES.flashConeCos ? 1 : 0.25 + 0.25 * Math.max(0, facingCos + 1));
        t.receiveFlash(amount, events);
      }
    }
  }

  /** Metres of smoke a ray passes through between a and b. */
  smokeDepthM(a: Vec3, b: Vec3): number {
    let depth = 0;
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-6) return 0;
    _d.scale(1 / len);
    for (const s of this.smokes) {
      if (!s.active || s.radiusM < 0.5) continue;
      _oc.subVectors(s.pos, a);
      _oc.y -= s.radiusM * 0.45; // the cloud sits on the ground, centre lifted
      const tc = _oc.dot(_d);
      const perp2 = _oc.dot(_oc) - tc * tc;
      const r2 = s.radiusM * s.radiusM;
      if (perp2 >= r2) continue;
      const half = Math.sqrt(r2 - perp2);
      const t0 = Math.max(0, tc - half);
      const t1 = Math.min(len, tc + half);
      if (t1 > t0) depth += t1 - t0;
    }
    return depth;
  }
}

const _p = new Vec3();
const _v = new Vec3();
const _blast = new Vec3();
const _chest = new Vec3();
const _from = new Vec3();
const _facing = new Vec3();
const _d = new Vec3();
const _oc = new Vec3();
const _dir = new Vec3();
const _hits: RayBoxHit[] = [];

/** One physics step of a small bouncing sphere. Returns true if it bounced. */
function stepBody(world: CollisionWorld, pos: Vec3, vel: Vec3, dt: number, events: EventQueue | null): boolean {
  vel.y -= PHYSICS.gravityMs2 * dt;
  const speed = vel.length();
  const dist = speed * dt;
  if (dist < 1e-6) return false;
  _dir.copy(vel).scale(1 / speed);
  const boxes = world.raycastBoxes(pos, _dir, dist + RADIUS_M, _hits);
  let hitDist = Infinity;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  for (const h of boxes) {
    if (!h.box.blocksMovement || h.entryM <= 0) continue;
    if (h.box.surface === 'glass') {
      world.removeBox(h.box);
      events?.push({ type: 'glassBreak', pos: pos.clone().addScaled(_dir, h.entryM) });
      continue;
    }
    hitDist = h.entryM;
    nx = h.normal.x;
    ny = h.normal.y;
    nz = h.normal.z;
    break;
  }
  const t = world.raycastTerrain(pos, _dir, dist + RADIUS_M);
  if (t && t.distanceM < hitDist) {
    hitDist = t.distanceM;
    nx = t.normal.x;
    ny = t.normal.y;
    nz = t.normal.z;
  }
  if (hitDist === Infinity) {
    pos.addScaled(vel, dt);
    return false;
  }
  pos.addScaled(_dir, Math.max(0, hitDist - RADIUS_M));
  // Reflect with restitution on the normal and friction on the tangent.
  const vn = vel.x * nx + vel.y * ny + vel.z * nz;
  if (vn < 0) {
    vel.x -= (1 + GRENADES.restitution) * vn * nx;
    vel.y -= (1 + GRENADES.restitution) * vn * ny;
    vel.z -= (1 + GRENADES.restitution) * vn * nz;
    vel.scale(0.75);
    if (events && -vn > 1.5) events.push({ type: 'grenadeBounce', pos: pos.clone(), speedMs: -vn });
  }
  return true;
}
