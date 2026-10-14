import { GUERRILLA, LAGOON_PLAYER, RIFLE } from '../config.ts';
import type { Rng } from '../core/rng.ts';
import { type CollisionWorld, newHit, type RayHit, WATER_HIT } from './colliders.ts';
import type { HitPart, P3 } from './events.ts';
import { type HitSphere, setSphere, type Target } from './targets.ts';
import { bearing, depthAt, sightLine, type ThreatContext, trunkAvoidance, turnToward, wrapAngle } from './threatContext.ts';
import { beachWidth, heightAt, LAGOON_CENTRE, normalAt, OUTPOST_CENTRE, shoreDistance } from './terrain.ts';

// Guerrillas: irregulars with AKs, headless (rules §10). Three live in a camp
// in the jungle west of the shelter, two walk a patrol along the edge of the
// beach, and every few minutes a small party comes down on the shelter itself.
//
// Each one sees (a cone, a range that shrinks at night unless the player
// carries a lit lamp or stands in firelight, a line of sight that the trunks
// block and the leaves half hide) and hears gunshots. Seeing the player for
// long enough, it shoots: real bullets (flown like the player's, tested
// against the player's body), in bursts, with a human aim — a wide cone that
// tightens while it holds still on a target in sight. It moves between
// positions every few seconds, crouches to shoot, reloads, calls the others
// within earshot, searches where the player was last seen, and gives up after
// a while. The dead drop their ammunition and sometimes a field dressing.

export type GuerrillaState = 'camp' | 'patrol' | 'alert' | 'search' | 'engage' | 'dead';
export type GuerrillaRole = 'camp' | 'patrol' | 'raider';

const EYE_STAND_M = 1.62;
const EYE_CROUCH_M = 1.12;
const SHOT_INTERVAL_S = 60 / GUERRILLA.roundsPerMinute;
const BULLET_SPEED_MS = RIFLE.muzzleVelocityMs;
const PLAYER_RADIUS_M = LAGOON_PLAYER.radiusM;
const MAX_BULLETS = 48;

export class Guerrilla implements Target {
  readonly kind = 'guerrilla' as const;
  readonly pos: P3;
  readonly prev: P3;
  readonly home: P3;
  yawRad: number;
  prevYawRad: number;
  pitchRad = 0;
  speedMs = 0;
  crouch = 0;
  health: number = GUERRILLA.health;
  alive = true;
  deathS = 0;
  /** Direction it was hit from last (for the fall). */
  readonly deathDir: P3 = { x: 0, y: 0, z: -1 };
  state: GuerrillaState;
  stateS = 0;
  awareness = 0;
  readonly lastKnown: P3 = { x: 0, y: 0, z: 0 };
  hasLastKnown = false;
  sinceSeenS = 99;
  /** Seconds the aim has held on a target in sight (the cone tightens with it). */
  aimS = 0;
  magazine: number = GUERRILLA.magazineRounds;
  reloadS = 0;
  private burstLeft = 0;
  private shotS = 0;
  private repositionS = 0;
  private perceiveS = 0;
  private readonly moveTarget: P3 = { x: 0, y: 0, z: 0 };
  routeIndex = 0;
  /** Seen the player this step (for render: rifle up, head toward). */
  seesPlayer = false;
  /** Fired this step (render: muzzle flash on the model). */
  fired = false;
  /** Its kit has been dropped (once, however it died). */
  looted = false;
  readonly hitSpheres: HitSphere[] = [];

  constructor(
    readonly id: number,
    readonly role: GuerrillaRole,
    at: P3,
    yawRad: number,
    private readonly route: readonly P3[],
  ) {
    this.pos = { ...at };
    this.prev = { ...at };
    this.home = { ...at };
    this.yawRad = yawRad;
    this.prevYawRad = yawRad;
    this.state = role === 'patrol' ? 'patrol' : role === 'raider' ? 'alert' : 'camp';
    this.perceiveS = (id % 5) * 0.04;
    this.updateSpheres();
  }

  /** Low ready on patrol and at camp; up when alert or fighting. */
  get rifleUp(): boolean {
    return this.state === 'engage' || this.state === 'alert' || this.state === 'search';
  }

  eye(out: P3): P3 {
    out.x = this.pos.x;
    out.y = this.pos.y + EYE_STAND_M + (EYE_CROUCH_M - EYE_STAND_M) * this.crouch;
    out.z = this.pos.z;
    return out;
  }

  hurt(amount: number, part: HitPart, dir: P3, _byPlayer: boolean): boolean {
    if (!this.alive) return false;
    this.health -= amount * GUERRILLA.partMultiplier[part];
    this.awareness = 1;
    this.deathDir.x = dir.x;
    this.deathDir.y = 0;
    this.deathDir.z = dir.z;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.setState('dead');
      this.speedMs = 0;
      this.hitSpheres.length = 0;
      return true;
    }
    return false;
  }

  setState(s: GuerrillaState): void {
    this.state = s;
    this.stateS = 0;
  }

  updateSpheres(): void {
    if (!this.alive) return;
    const c = this.crouch;
    const y = this.pos.y;
    const h = (stand: number, kneel: number): number => y + stand + (kneel - stand) * c;
    setSphere(this.hitSpheres, 0, this.pos.x, h(1.64, 1.14), this.pos.z, 0.12, 'head');
    setSphere(this.hitSpheres, 1, this.pos.x, h(1.32, 0.92), this.pos.z, 0.22, 'torso');
    setSphere(this.hitSpheres, 2, this.pos.x, h(1.02, 0.68), this.pos.z, 0.2, 'torso');
    setSphere(this.hitSpheres, 3, this.pos.x, h(0.52, 0.32), this.pos.z, 0.2, 'limb');
  }

  // ------------------------------------------------------------------ step

  step(ctx: ThreatContext, band: GuerrillaBand): void {
    const dt = ctx.dt;
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
    this.prevYawRad = this.yawRad;
    this.stateS += dt;
    this.fired = false;
    if (!this.alive) {
      this.deathS += dt;
      return;
    }
    this.reloadS = Math.max(0, this.reloadS - dt);
    if (this.reloadS === 0 && this.magazine === 0) this.magazine = GUERRILLA.magazineRounds;
    this.perceive(ctx, band);
    switch (this.state) {
      case 'camp':
        this.atCamp(ctx);
        break;
      case 'patrol':
        this.patrol(ctx);
        break;
      case 'alert':
      case 'search':
        this.investigate(ctx);
        break;
      case 'engage':
        this.engage(ctx, band);
        break;
      default:
        break;
    }
    this.crouch += ((this.state === 'engage' && this.speedMs < 0.5 ? 1 : 0) - this.crouch) * Math.min(1, dt * 4);
    this.updateSpheres();
  }

  private perceive(ctx: ThreatContext, band: GuerrillaBand): void {
    const dt = ctx.dt;
    this.sinceSeenS += dt;
    this.perceiveS -= dt;
    if (ctx.noise) {
      const d = Math.hypot(ctx.noise.pos.x - this.pos.x, ctx.noise.pos.z - this.pos.z);
      if (d < Math.min(GUERRILLA.hearM, ctx.noise.radiusM) && this.state !== 'engage') {
        // Heard, not seen: a rough bearing, the place off by a few metres per ten.
        const err = d * 0.12;
        this.setLastKnown(ctx.noise.pos.x + ctx.rng.range(-err, err), ctx.noise.pos.z + ctx.rng.range(-err, err));
        if (this.state !== 'alert') this.setState('alert');
        this.awareness = Math.max(this.awareness, 0.5);
      }
    }
    if (this.perceiveS > 0) return;
    this.perceiveS = 0.2;
    const seen = this.canSee(ctx);
    this.seesPlayer = seen > 0;
    if (seen > 0) {
      const d = Math.hypot(ctx.player.pos.x - this.pos.x, ctx.player.pos.z - this.pos.z);
      const quick = this.state === 'alert' || this.state === 'search' || this.state === 'engage' ? 2.2 : 1;
      const moving = ctx.player.speedMs > 3.5 ? 1.5 : 1;
      this.awareness = Math.min(1.5, this.awareness + ((0.2 * quick * moving * seen) / GUERRILLA.noticeS) * Math.min(2, 25 / Math.max(d, 5)));
      if (this.awareness >= 1) {
        this.setLastKnown(ctx.player.pos.x, ctx.player.pos.z);
        this.sinceSeenS = 0;
        if (this.state !== 'engage') {
          this.setState('engage');
          ctx.events.push({ type: 'threatCall', pos: this.headPos(), kind: 'guerrilla', call: 'shout' });
          band.alertOthers(this, ctx);
        }
      }
    } else this.awareness = Math.max(0, this.awareness - 0.2 * 0.08);
  }

  private headPos(): P3 {
    return { x: this.pos.x, y: this.pos.y + 1.6, z: this.pos.z };
  }

  /** 0 unseen … 1 in clear view (½ through leaves). */
  private canSee(ctx: ThreatContext): number {
    if (ctx.playerDown) return 0;
    const p = ctx.player.pos;
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const lit = ctx.lampLit || (ctx.fire !== null && Math.hypot(p.x - ctx.fire.x, p.z - ctx.fire.z) < 8);
    const range = GUERRILLA.sightM + ((lit ? GUERRILLA.litSightM : GUERRILLA.nightSightM) - GUERRILLA.sightM) * ctx.night;
    if (d > range) return 0;
    if (d > 6 && Math.abs(wrapAngle(bearing(this.pos.x, this.pos.z, p.x, p.z) - this.yawRad)) > GUERRILLA.fovRad / 2) return 0;
    const eye = this.eye(_eye);
    // The head pokes out of the water, the whole body stands on land.
    const chest = { x: p.x, y: p.y + (ctx.player.swimming ? 1.6 : 1.3), z: p.z };
    return sightLine(ctx.collision, eye, chest);
  }

  setLastKnown(x: number, z: number): void {
    this.lastKnown.x = x;
    this.lastKnown.z = z;
    this.lastKnown.y = heightAt(x, z);
    this.hasLastKnown = true;
  }

  private walk(ctx: ThreatContext, tx: number, tz: number, speed: number): boolean {
    const dt = ctx.dt;
    const want = bearing(this.pos.x, this.pos.z, tx, tz);
    const avoid = trunkAvoidance(ctx.collision, this.pos.x, this.pos.z, this.yawRad, 1.8);
    this.yawRad = turnToward(this.yawRad, want + avoid * 0.9, 4.5, dt);
    this.speedMs += (speed - this.speedMs) * Math.min(1, dt * 5);
    const nx = this.pos.x - Math.sin(this.yawRad) * this.speedMs * dt;
    const nz = this.pos.z - Math.cos(this.yawRad) * this.speedMs * dt;
    if (depthAt(nx, nz) > 0.35) {
      this.speedMs = 0;
      return false;
    }
    this.pos.x = nx;
    this.pos.z = nz;
    this.pos.y = ctx.collision.groundAt(nx, nz, this.pos.y + 0.3, 0.45);
    return true;
  }

  private stop(dt: number): void {
    this.speedMs = Math.max(0, this.speedMs - dt * 8);
  }

  private atCamp(ctx: ThreatContext): void {
    // Stand about the camp: now and then a few steps somewhere else in it.
    if (Math.hypot(this.moveTarget.x - this.pos.x, this.moveTarget.z - this.pos.z) > 0.8 && this.stateS > 0.5) this.walk(ctx, this.moveTarget.x, this.moveTarget.z, GUERRILLA.walkMs * 0.7);
    else this.stop(ctx.dt);
    if (this.stateS > 9 + (this.id % 4) * 3) {
      this.stateS = 0;
      const a = ctx.rng.range(0, Math.PI * 2);
      this.moveTarget.x = this.home.x + Math.cos(a) * ctx.rng.range(1, 5);
      this.moveTarget.z = this.home.z + Math.sin(a) * ctx.rng.range(1, 5);
    }
  }

  private patrol(ctx: ThreatContext): void {
    const r = this.route;
    if (r.length === 0) return this.atCamp(ctx);
    const wp = r[this.routeIndex % r.length] as P3;
    if (Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z) < 2) this.routeIndex = (this.routeIndex + 1) % r.length;
    else if (!this.walk(ctx, wp.x, wp.z, GUERRILLA.walkMs)) this.routeIndex = (this.routeIndex + 1) % r.length;
  }

  private investigate(ctx: ThreatContext): void {
    const lk = this.lastKnown;
    const d = Math.hypot(lk.x - this.pos.x, lk.z - this.pos.z);
    if (this.state === 'alert') {
      // Go there quickly, rifle up.
      if (d > 3 && this.walk(ctx, lk.x, lk.z, this.stateS < 20 ? GUERRILLA.runMs * 0.75 : GUERRILLA.walkMs)) return;
      this.setState('search');
      return;
    }
    // Search round the spot, then go back to what it was doing.
    if (Math.hypot(this.moveTarget.x - this.pos.x, this.moveTarget.z - this.pos.z) < 1.5 || this.stateS % 6 < ctx.dt) {
      const a = ctx.rng.range(0, Math.PI * 2);
      this.moveTarget.x = lk.x + Math.cos(a) * ctx.rng.range(4, 12);
      this.moveTarget.z = lk.z + Math.sin(a) * ctx.rng.range(4, 12);
    }
    this.walk(ctx, this.moveTarget.x, this.moveTarget.z, GUERRILLA.walkMs);
    if (this.stateS > 25) {
      this.awareness = 0;
      this.hasLastKnown = false;
      this.setState(this.role === 'patrol' ? 'patrol' : 'camp');
      if (this.role === 'raider') this.setState('patrol'); // raiders who lose the trail walk the beach
    }
  }

  private engage(ctx: ThreatContext, band: GuerrillaBand): void {
    const dt = ctx.dt;
    const p = ctx.player.pos;
    const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
    if (ctx.playerDown) {
      this.setState('search');
      return;
    }
    if (this.sinceSeenS > 3) {
      // Lost: go where it was last seen.
      this.aimS = 0;
      this.setState('alert');
      return;
    }
    // Face the target; aim settles while it stands still with the target in view.
    const want = bearing(this.pos.x, this.pos.z, p.x, p.z);
    this.yawRad = turnToward(this.yawRad, want, 5, dt);
    const eye = this.eye(_eye);
    this.pitchRad = Math.atan2(p.y + 1.2 - eye.y, Math.max(d, 0.1));
    const steady = this.seesPlayer && this.speedMs < 0.6 && Math.abs(wrapAngle(want - this.yawRad)) < 0.15;
    this.aimS = steady ? this.aimS + dt : Math.max(0, this.aimS - dt * 2);
    // Move: close in from far, back off from too close, and shift position every few seconds.
    this.repositionS -= dt;
    if (d > GUERRILLA.engageMaxM) {
      this.walk(ctx, p.x, p.z, GUERRILLA.runMs);
      return;
    }
    if (this.repositionS <= 0) {
      this.repositionS = ctx.rng.range(4, 8);
      const side = ctx.rng.next() < 0.5 ? -1 : 1;
      const out = d < GUERRILLA.engageMinM ? -4 : ctx.rng.range(-2, 3);
      // Sideways a few metres, toward a trunk if there is one to stand by.
      const tree = band.coverNear(this.pos, 7, ctx);
      if (tree) {
        this.moveTarget.x = tree.x;
        this.moveTarget.z = tree.z;
      } else {
        this.moveTarget.x = this.pos.x + Math.cos(want) * side * 4 - Math.sin(want) * out;
        this.moveTarget.z = this.pos.z - Math.sin(want) * side * 4 - Math.cos(want) * out;
      }
    }
    const moving = Math.hypot(this.moveTarget.x - this.pos.x, this.moveTarget.z - this.pos.z) > 0.8 && this.repositionS > 1.5;
    if (moving) {
      this.walk(ctx, this.moveTarget.x, this.moveTarget.z, GUERRILLA.runMs * 0.8);
      this.yawRad = turnToward(this.yawRad, want, 6, dt); // keeps the rifle on the target while moving
    } else this.stop(dt);
    // Fire in bursts when it sees the target and the rifle is loaded.
    this.shotS -= dt;
    if (this.reloadS > 0 || !this.seesPlayer) return;
    if (this.magazine === 0) {
      this.reloadS = GUERRILLA.reloadS;
      return;
    }
    if (this.burstLeft <= 0) {
      if (this.shotS > 0) return;
      this.burstLeft = ctx.rng.int(GUERRILLA.burstMin, GUERRILLA.burstMax);
    }
    if (this.shotS > 0) return;
    this.shotS = SHOT_INTERVAL_S;
    this.burstLeft--;
    if (this.burstLeft <= 0) this.shotS = ctx.rng.range(GUERRILLA.burstPauseS[0], GUERRILLA.burstPauseS[1]);
    this.magazine--;
    this.fire(ctx, band);
  }

  private fire(ctx: ThreatContext, band: GuerrillaBand): void {
    const eye = this.eye(_eye);
    const p = ctx.player.pos;
    // Aim at the chest (the head when only it is out of the water), with a human error that shrinks while
    // the aim holds; moving or just alerted, it is wide.
    const aimY = p.y + (ctx.player.swimming ? 1.65 : 1.25);
    const tx = p.x - eye.x;
    const ty = aimY - eye.y;
    const tz = p.z - eye.z;
    const len = Math.hypot(tx, ty, tz) || 1;
    const settle = Math.min(1, this.aimS / GUERRILLA.spreadSettleS);
    const spread = GUERRILLA.spreadStartRad + (GUERRILLA.spreadFloorRad - GUERRILLA.spreadStartRad) * settle + (this.speedMs > 0.5 ? 0.03 : 0);
    const dir = { x: tx / len + ctx.rng.gauss() * spread, y: ty / len + ctx.rng.gauss() * spread * 0.7, z: tz / len + ctx.rng.gauss() * spread };
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= dl;
    dir.y /= dl;
    dir.z /= dl;
    // The muzzle: half a metre ahead of the eye, a little down and right.
    const muzzle = { x: eye.x + dir.x * 0.7 + Math.cos(this.yawRad) * 0.12, y: eye.y - 0.1, z: eye.z + dir.z * 0.7 - Math.sin(this.yawRad) * 0.12 };
    band.bullets.fire(muzzle, dir);
    this.fired = true;
    ctx.events.push({ type: 'enemyShot', origin: muzzle, dir });
  }
}

const _eye: P3 = { x: 0, y: 0, z: 0 };

interface EnemyBullet {
  pos: P3;
  dir: P3;
  travelledM: number;
  alive: boolean;
  whizzed: boolean;
}

/**
 * The guerrillas' rounds: straight segments at the AK's muzzle velocity (the drop over a jungle
 * engagement is centimetres), tested each step against the world and against the player's body (a
 * vertical capsule, the head its top 0.3 m). A round passing within two metres of the head whizzes.
 */
export class EnemyBullets {
  private readonly pool: EnemyBullet[] = [];
  private readonly hit: RayHit = newHit();

  constructor() {
    for (let i = 0; i < MAX_BULLETS; i++) this.pool.push({ pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: -1 }, travelledM: 0, alive: false, whizzed: false });
  }

  fire(origin: P3, dir: P3): void {
    const b = this.pool.find((p) => !p.alive);
    if (!b) return;
    b.alive = true;
    b.whizzed = false;
    b.travelledM = 0;
    b.pos.x = origin.x;
    b.pos.y = origin.y;
    b.pos.z = origin.z;
    b.dir.x = dir.x;
    b.dir.y = dir.y;
    b.dir.z = dir.z;
  }

  get live(): number {
    return this.pool.reduce((n, b) => n + (b.alive ? 1 : 0), 0);
  }

  step(ctx: ThreatContext): void {
    const len = BULLET_SPEED_MS * ctx.dt;
    const p = ctx.player.pos;
    for (const b of this.pool) {
      if (!b.alive) continue;
      const found = ctx.collision.raycast(b.pos, b.dir, len, this.hit, true);
      const wallT = found ? this.hit.distanceM : len;
      // The player: closest approach of the segment to the body's axis.
      if (!ctx.playerDown) {
        const swim = ctx.player.swimming;
        const y0 = p.y + (swim ? 1.35 : 0.1);
        const y1 = p.y + 1.78;
        const hitT = segmentCapsule(b.pos, b.dir, wallT, p.x, y0, y1, p.z, PLAYER_RADIUS_M);
        if (hitT !== null) {
          const hy = b.pos.y + b.dir.y * hitT;
          const head = hy > p.y + 1.48;
          ctx.hurtPlayer(GUERRILLA.damage * (head ? GUERRILLA.headMultiplier : 1), b.pos, 'guerrilla');
          b.alive = false;
          continue;
        }
        if (!b.whizzed) {
          const near = closestToPoint(b.pos, b.dir, wallT, p.x, p.y + 1.6, p.z);
          if (near.d < 2) {
            b.whizzed = true;
            ctx.events.push({ type: 'whiz', pos: near.at });
          }
        }
      }
      if (found) {
        const h = this.hit;
        ctx.events.push({ type: 'bulletImpact', pos: { x: h.x, y: h.y, z: h.z }, normal: { x: h.nx, y: h.ny, z: h.nz }, dir: { ...b.dir }, surface: h.colliderIndex === WATER_HIT ? 'water' : h.surface, distanceM: b.travelledM + h.distanceM });
        b.alive = false;
        continue;
      }
      b.pos.x += b.dir.x * len;
      b.pos.y += b.dir.y * len;
      b.pos.z += b.dir.z * len;
      b.travelledM += len;
      if (b.travelledM > 400) b.alive = false;
    }
  }
}

/** Parameter t ∈ [0, maxT] where the ray o + d·t comes within r of the vertical segment (x, y0..y1, z), or null. */
export function segmentCapsule(o: P3, d: P3, maxT: number, x: number, y0: number, y1: number, z: number, r: number): number | null {
  // Horizontal approach first (the body is vertical), then check the height there.
  const ox = o.x - x;
  const oz = o.z - z;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return null;
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0 || t > maxT) return null;
  const y = o.y + d.y * t;
  return y >= y0 && y <= y1 ? t : null;
}

function closestToPoint(o: P3, d: P3, maxT: number, x: number, y: number, z: number): { d: number; at: P3 } {
  const t = Math.max(0, Math.min(maxT, (x - o.x) * d.x + (y - o.y) * d.y + (z - o.z) * d.z));
  const at = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  return { d: Math.hypot(at.x - x, at.y - y, at.z - z), at };
}

// ------------------------------------------------------------------ the band

/** The camp's crates round its fire (x east, z south of it), solid for the player and drawn by render/camp.ts. */
export const CAMP_CRATES: readonly { x: number; z: number; hx: number; hy: number; hz: number; yawRad: number }[] = [
  { x: 2.6, z: 1.8, hx: 0.45, hy: 0.25, hz: 0.3, yawRad: 0.3 },
  { x: 3.2, z: 2.6, hx: 0.35, hy: 0.2, hz: 0.25, yawRad: -0.2 },
];

export interface LootDrop {
  pos: P3;
  ammo: number;
  medkit: boolean;
}

export class GuerrillaBand {
  readonly members: Guerrilla[] = [];
  readonly bullets = new EnemyBullets();
  /** Where the camp is (its fire), and the patrol's loop along the edge of the beach. */
  readonly camp: P3;
  readonly route: P3[];
  /** Loot left by the dead this step, for the game to place as pick-ups. */
  readonly drops: LootDrop[] = [];
  private nextId = 1000;
  private raidS: number;
  private readonly respawn: { role: GuerrillaRole; s: number }[] = [];
  private readonly trees: readonly { x: number; z: number }[];

  constructor(rng: Rng, trees: readonly { x: number; z: number }[], collision?: CollisionWorld) {
    this.trees = trees;
    this.camp = findCamp(rng, trees);
    if (collision) {
      for (const c of CAMP_CRATES) {
        const x = this.camp.x + c.x;
        const z = this.camp.z + c.z;
        collision.add({ kind: 'box', x, y: heightAt(x, z) + c.hy, z, hx: c.hx, hy: c.hy, hz: c.hz, yawRad: c.yawRad, surface: 'wood' });
      }
    }
    this.route = patrolRoute(this.camp);
    this.raidS = rng.range(GUERRILLA.raidEveryS[0], GUERRILLA.raidEveryS[1]);
  }

  populate(rng: Rng): void {
    for (let i = 0; i < GUERRILLA.campSize; i++) {
      const a = (i / GUERRILLA.campSize) * Math.PI * 2;
      const at = { x: this.camp.x + Math.cos(a) * 3, y: 0, z: this.camp.z + Math.sin(a) * 3 };
      at.y = heightAt(at.x, at.z);
      this.members.push(new Guerrilla(this.nextId++, 'camp', at, bearing(at.x, at.z, this.camp.x, this.camp.z) + Math.PI, this.route));
    }
    const start = this.route[Math.floor(this.route.length / 2)] ?? this.camp;
    for (let i = 0; i < GUERRILLA.patrolSize; i++) {
      const at = { x: start.x + i * 2, y: 0, z: start.z + i * 1.5 };
      at.y = heightAt(at.x, at.z);
      const g = new Guerrilla(this.nextId++, 'patrol', at, rng.range(0, Math.PI * 2), this.route);
      g.routeIndex = Math.floor(this.route.length / 2) + 1;
      this.members.push(g);
    }
  }

  step(ctx: ThreatContext, raidsAllowed: boolean): void {
    this.drops.length = 0;
    for (const g of this.members) {
      g.step(ctx, this);
      // However it died (the player's rounds land after this step), its kit drops once.
      if (!g.alive && !g.looted) {
        g.looted = true;
        this.died(g, ctx);
      }
    }
    this.bullets.step(ctx);
    // The dead lie two minutes, then are gone; a replacement walks back into the camp later.
    for (let i = this.members.length - 1; i >= 0; i--) {
      const g = this.members[i] as Guerrilla;
      if (g.alive || g.deathS < 120) continue;
      this.members.splice(i, 1);
      if (g.role !== 'raider') this.respawn.push({ role: g.role, s: GUERRILLA.respawnS });
    }
    for (let i = this.respawn.length - 1; i >= 0; i--) {
      const r = this.respawn[i] as { role: GuerrillaRole; s: number };
      r.s -= ctx.dt;
      const p = ctx.player.pos;
      if (r.s > 0 || Math.hypot(p.x - this.camp.x, p.z - this.camp.z) < 70) continue;
      this.respawn.splice(i, 1);
      const at = { x: this.camp.x + ctx.rng.range(-3, 3), y: 0, z: this.camp.z + ctx.rng.range(-3, 3) };
      at.y = heightAt(at.x, at.z);
      this.members.push(new Guerrilla(this.nextId++, r.role, at, 0, this.route));
    }
    // A raid on the shelter every few minutes while the player is about it.
    this.raidS -= ctx.dt;
    if (raidsAllowed && this.raidS <= 0) {
      const p = ctx.player.pos;
      if (Math.hypot(p.x - OUTPOST_CENTRE.x, p.z - OUTPOST_CENTRE.z) < 45 && !ctx.playerDown) {
        this.raid(ctx);
        this.raidS = ctx.rng.range(GUERRILLA.raidEveryS[0], GUERRILLA.raidEveryS[1]);
      } else this.raidS = 20;
    }
  }

  /** Sends a party at the shelter from the jungle, out of sight of the player. */
  raid(ctx: ThreatContext): boolean {
    const raiders = this.members.filter((g) => g.alive && g.role === 'raider').length;
    if (raiders >= GUERRILLA.raidSize) return false;
    const p = ctx.player.pos;
    for (let i = 0; i < 200; i++) {
      const a = ctx.rng.range(0, Math.PI * 2);
      const r = ctx.rng.range(70, 95);
      const x = OUTPOST_CENTRE.x + Math.cos(a) * r;
      const z = OUTPOST_CENTRE.z + Math.sin(a) * r;
      if (shoreDistance(x, z) < beachWidth(x, z) + 6 || !flatEnough(x, z) || Math.hypot(x - p.x, z - p.z) < 60) continue;
      if (sightLine(ctx.collision, ctx.eye, { x, y: heightAt(x, z) + 1.4, z }) > 0) continue;
      for (let k = 0; k < GUERRILLA.raidSize; k++) {
        const at = { x: x + ctx.rng.range(-3, 3), y: 0, z: z + ctx.rng.range(-3, 3) };
        at.y = heightAt(at.x, at.z);
        const g = new Guerrilla(this.nextId++, 'raider', at, bearing(at.x, at.z, OUTPOST_CENTRE.x, OUTPOST_CENTRE.z), this.route);
        g.setLastKnown(OUTPOST_CENTRE.x + ctx.rng.range(-6, 6), OUTPOST_CENTRE.z + ctx.rng.range(-6, 6));
        g.awareness = 0.5;
        this.members.push(g);
      }
      ctx.events.push({ type: 'threatCall', pos: { x, y: heightAt(x, z) + 1.6, z }, kind: 'guerrilla', call: 'shout' });
      return true;
    }
    return false;
  }

  /** One sees the player: everyone within earshot comes to the place. */
  alertOthers(caller: Guerrilla, ctx: ThreatContext): void {
    for (const g of this.members) {
      if (g === caller || !g.alive || g.state === 'engage') continue;
      if (Math.hypot(g.pos.x - caller.pos.x, g.pos.z - caller.pos.z) > 90) continue;
      g.setLastKnown(caller.lastKnown.x, caller.lastKnown.z);
      g.awareness = Math.max(g.awareness, 0.7);
      g.setState('alert');
    }
    void ctx;
  }

  /** A trunk to stand beside within `radiusM`, on the side away from the player, or null. */
  coverNear(at: P3, radiusM: number, ctx: ThreatContext): P3 | null {
    const p = ctx.player.pos;
    let best: P3 | null = null;
    let bestD = radiusM;
    for (const t of this.trees) {
      const d = Math.hypot(t.x - at.x, t.z - at.z);
      if (d > bestD || d < 1) continue;
      const toP = Math.hypot(p.x - t.x, p.z - t.z);
      if (toP < GUERRILLA.engageMinM) continue;
      // Stand 0.8 m behind the trunk as seen from the player.
      const ux = (t.x - p.x) / toP;
      const uz = (t.z - p.z) / toP;
      const x = t.x + ux * 0.8;
      const z = t.z + uz * 0.8;
      if (depthAt(x, z) > 0.2) continue;
      best = { x, y: heightAt(x, z), z };
      bestD = d;
    }
    return best;
  }

  private died(g: Guerrilla, ctx: ThreatContext): void {
    ctx.events.push({ type: 'threatCall', pos: { x: g.pos.x, y: g.pos.y + 1.2, z: g.pos.z }, kind: 'guerrilla', call: 'die' });
    this.drops.push({ pos: { x: g.pos.x + g.deathDir.x * 0.6, y: g.pos.y, z: g.pos.z + g.deathDir.z * 0.6 }, ammo: ctx.rng.int(10, 25), medkit: ctx.rng.next() < 0.35 });
  }
}

function flatEnough(x: number, z: number): boolean {
  const n = { x: 0, y: 1, z: 0 };
  normalAt(x, z, n);
  return n.y > 0.85;
}

/** A level clearing in the jungle west of the shelter, 60–100 m from it, no trunk within five metres. */
function findCamp(rng: Rng, trees: readonly { x: number; z: number }[]): P3 {
  for (let i = 0; i < 2000; i++) {
    const a = Math.PI + rng.range(-0.7, 0.5);
    const r = rng.range(60, 100);
    const x = OUTPOST_CENTRE.x + Math.cos(a) * r;
    const z = OUTPOST_CENTRE.z + Math.sin(a) * r;
    if (shoreDistance(x, z) < beachWidth(x, z) + 12 || !flatEnough(x, z)) continue;
    if (Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z) > LAGOON_PLAYER.borderStartM - 20) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 5)) continue;
    return { x, y: heightAt(x, z), z };
  }
  return { x: OUTPOST_CENTRE.x - 80, y: heightAt(OUTPOST_CENTRE.x - 80, OUTPOST_CENTRE.z), z: OUTPOST_CENTRE.z };
}

/**
 * The patrol: from the camp down to the jungle's edge, east along it behind the sand (passing the
 * shelter), and back. Points where the beach meets the trees, found by walking out from the lagoon.
 */
function patrolRoute(camp: P3): P3[] {
  const pts: P3[] = [{ ...camp }];
  for (let k = 0; k <= 8; k++) {
    // Angles across the lagoon's south side, west to east.
    const a = Math.PI * (0.92 - k * 0.1);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    for (let r = 40; r < 160; r += 2) {
      const x = LAGOON_CENTRE.x + dx * r * 1.25;
      const z = LAGOON_CENTRE.z + dz * r;
      if (shoreDistance(x, z) >= beachWidth(x, z) + 3) {
        if (flatEnough(x, z) || k % 2 === 0) pts.push({ x, y: heightAt(x, z), z });
        break;
      }
    }
  }
  // And back the same way.
  for (let i = pts.length - 2; i > 0; i--) pts.push({ ...(pts[i] as P3) });
  return pts;
}
