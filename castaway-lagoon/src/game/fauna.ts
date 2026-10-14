import { LAGOON_PLAYER, SPECIES, type SpeciesId, type SpeciesSpec, WATER_LEVEL_M } from '../config.ts';
import type { HitPart, P3 } from './events.ts';
import { type HitSphere, setSphere, type Target } from './targets.ts';
import { bearing, depthAt, sightLine, type ThreatContext, trunkAvoidance, turnToward, wrapAngle } from './threatContext.ts';
import { beachWidth, heightAt, LAGOON_CENTRE, normalAt, OUTPOST_CENTRE, shoreDistance } from './terrain.ts';

// The lagoon's dangerous animals, headless (rules §10). Each species keeps to
// its own ground and hunts its own way:
//
//   tiger      the jungle. Wanders its range; sights or hears the player,
//              stalks low and slow through the trees, then charges the last
//              fifteen metres and leaps. Backs off after a strike and comes
//              again; will not close on someone standing by a burning fire at
//              night; runs when badly hurt.
//   boar       the jungle edge, in a small herd that roots about. Too close, or
//              shot at, one charges straight through, turns and charges again;
//              the others scatter.
//   crocodile  the lagoon's edges, lying with only its eyes above water, or
//              basking on an islet's sand. Someone wading or swimming close, or
//              walking right past on the beach, gets a lunge and a bite, then
//              it sinks back into deeper water.
//   shark      the deep water. Ignores people on land and in the boat; someone
//              swimming gets circled, ever closer, its fin cutting the surface,
//              then a dash and a bite, and it circles again.
//
// Every one is a Target (targets.ts): spheres along its body for the rifle,
// the knife and stones. Dead ones lie for a while; a replacement comes back
// later, out of sight.

export type CreatureState = 'idle' | 'wander' | 'stalk' | 'charge' | 'pounce' | 'recover' | 'flee' | 'lurk' | 'bask' | 'lunge' | 'retreat' | 'cruise' | 'circle' | 'attack' | 'dead';

/** How long a body lies before it is cleared away (s). */
const CORPSE_S = 90;
/** Nothing is ever placed (or respawned) closer to the player than this, nor in plain view. */
const SPAWN_CLEAR_M = 70;

export class Creature implements Target {
  readonly kind: SpeciesId;
  readonly spec: SpeciesSpec;
  readonly pos: P3;
  readonly prev: P3;
  readonly home: P3;
  readonly target: P3 = { x: 0, y: 0, z: 0 };
  yawRad: number;
  prevYawRad: number;
  /** Nose up (+) or down, and roll (shark turns, a croc's death roll). */
  pitchRad = 0;
  rollRad = 0;
  speedMs = 0;
  health: number;
  alive = true;
  deathS = 0;
  state: CreatureState;
  stateS = 0;
  cooldownS = 0;
  /** 0 calm … 1 on to the player. */
  awareness = 0;
  /** Render cues: crouch (tiger stalking), jaw open, body under water (0 dry … 1 deep), in the air. */
  crouch = 0;
  jaw = 0;
  submerge = 0;
  airborne = 0;
  /** Charges and strikes in this bout (the boar gives up after three). */
  strikes = 0;
  /** Circling: the radius it is closing to (shark), and its direction. */
  circleM = 10;
  circleDir = 1;
  private readonly pounceFrom: P3 = { x: 0, y: 0, z: 0 };
  private struck = false;
  private callS = 0;
  readonly hitSpheres: HitSphere[] = [];

  constructor(
    readonly id: number,
    kind: SpeciesId,
    at: P3,
    yawRad: number,
  ) {
    this.kind = kind;
    this.spec = SPECIES[kind];
    this.pos = { ...at };
    this.prev = { ...at };
    this.home = { ...at };
    this.yawRad = yawRad;
    this.prevYawRad = yawRad;
    this.health = this.spec.health;
    this.state = kind === 'croc' ? 'lurk' : kind === 'shark' ? 'cruise' : 'wander';
    this.target.x = at.x;
    this.target.z = at.z;
    this.updateSpheres();
  }

  get forwardX(): number {
    return -Math.sin(this.yawRad);
  }

  get forwardZ(): number {
    return -Math.cos(this.yawRad);
  }

  hurt(amount: number, part: HitPart, _dir: P3, byPlayer: boolean): boolean {
    if (!this.alive) return false;
    const k = part === 'head' ? 1.6 : part === 'limb' ? 0.6 * this.spec.armour : this.spec.armour;
    this.health -= amount * k;
    if (byPlayer) this.awareness = 1;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.setState('dead');
      this.speedMs = 0;
      return true;
    }
    return false;
  }

  setState(s: CreatureState): void {
    this.state = s;
    this.stateS = 0;
    this.struck = false;
  }

  /** Lays the hit spheres along the body from the current pose. */
  updateSpheres(): void {
    const f = SPHERES[this.kind];
    const s = this.spec.scale;
    const fx = this.forwardX;
    const fz = this.forwardZ;
    const cp = Math.cos(this.pitchRad);
    const sp = Math.sin(this.pitchRad);
    const lift = this.kind === 'tiger' ? -this.crouch * 0.25 : 0;
    f.forEach(([along, up, r, part], i) => {
      const a = along * s * cp;
      const y = (up + lift) * s + along * s * sp;
      setSphere(this.hitSpheres, i, this.pos.x + fx * a, this.pos.y + y, this.pos.z + fz * a, r * s, part);
    });
  }

  /** Mouth position (m, world): where the bite lands. */
  mouth(out: P3): P3 {
    const [along, up] = SPHERES[this.kind][0] as [number, number, number, HitPart];
    const s = this.spec.scale;
    out.x = this.pos.x + this.forwardX * along * s * 1.15;
    out.y = this.pos.y + up * s;
    out.z = this.pos.z + this.forwardZ * along * s * 1.15;
    return out;
  }

  // ------------------------------------------------------------------ step

  step(ctx: ThreatContext): void {
    const dt = ctx.dt;
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
    this.prevYawRad = this.yawRad;
    this.stateS += dt;
    this.cooldownS = Math.max(0, this.cooldownS - dt);
    this.callS = Math.max(0, this.callS - dt);
    if (!this.alive) {
      this.deathS += dt;
      this.jaw = Math.max(0, this.jaw - dt);
      // A dead shark sinks slowly; a croc turns belly up in the water.
      if (this.kind === 'shark') this.pos.y = Math.max(heightAt(this.pos.x, this.pos.z) + 0.3, this.pos.y - dt * 0.25);
      if (this.kind === 'croc' && this.submerge > 0.3) this.rollRad = Math.min(Math.PI, this.rollRad + dt * 2);
      this.updateSpheres();
      return;
    }
    // A gunshot within earshot: the curious come to look, the timid get ready to run.
    if (ctx.noise && this.spec.hearM > 0) {
      const d = Math.hypot(ctx.noise.pos.x - this.pos.x, ctx.noise.pos.z - this.pos.z);
      if (d < Math.min(this.spec.hearM, ctx.noise.radiusM)) this.awareness = Math.max(this.awareness, this.kind === 'tiger' ? 0.6 : 0.8);
    }
    switch (this.kind) {
      case 'tiger':
        this.tiger(ctx);
        break;
      case 'boar':
        this.boar(ctx);
        break;
      case 'croc':
        this.croc(ctx);
        break;
      case 'shark':
        this.shark(ctx);
        break;
    }
    this.jaw = Math.max(0, this.jaw - dt * 2.5);
    this.updateSpheres();
  }

  // ------------------------------------------------------------------ shared helpers

  private distToPlayer(ctx: ThreatContext): number {
    const p = ctx.player.pos;
    return Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
  }

  /** Sight of the player: range by day or night (a lit lamp shows from further), field of view, the line through trees. */
  private sees(ctx: ThreatContext, fovRad = 2.6): boolean {
    if (ctx.playerDown) return false;
    const p = ctx.player.pos;
    const range = this.spec.sightM + (this.spec.nightSightM - this.spec.sightM) * ctx.night + (ctx.lampLit ? 15 * ctx.night : 0);
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > range) return false;
    if (d > 4 && Math.abs(wrapAngle(bearing(this.pos.x, this.pos.z, p.x, p.z) - this.yawRad)) > fovRad / 2) return false;
    const eye = { x: this.pos.x, y: this.pos.y + 0.8 * this.spec.scale, z: this.pos.z };
    const chest = { x: p.x, y: p.y + 1.2, z: p.z };
    return sightLine(ctx.collision, eye, chest) > (d < 12 ? 0.4 : 0.6);
  }

  /** Walks on land toward (tx, tz) at `speed`, steering round trunks; refuses to enter water deeper than `maxDepth`. */
  private walkTo(ctx: ThreatContext, tx: number, tz: number, speed: number, maxDepth = 0.25): boolean {
    const dt = ctx.dt;
    const want = bearing(this.pos.x, this.pos.z, tx, tz);
    const avoid = trunkAvoidance(ctx.collision, this.pos.x, this.pos.z, this.yawRad, 2 + speed * 0.3);
    this.yawRad = turnToward(this.yawRad, want + avoid * 0.9, this.spec.turnRadS * (speed > this.spec.walkMs * 2 ? 0.8 : 1), dt);
    // Turn first, then run: no sprinting sideways.
    const facing = Math.max(0.15, Math.cos(wrapAngle(want - this.yawRad)));
    this.speedMs += (speed * facing - this.speedMs) * Math.min(1, dt * 4);
    const nx = this.pos.x + this.forwardX * this.speedMs * dt;
    const nz = this.pos.z + this.forwardZ * this.speedMs * dt;
    if (depthAt(nx, nz) > maxDepth) {
      this.speedMs = 0;
      return false;
    }
    this.pos.x = nx;
    this.pos.z = nz;
    this.pos.y = Math.max(heightAt(nx, nz), WATER_LEVEL_M - 0.3);
    return true;
  }

  private call(ctx: ThreatContext, call: Parameters<typeof callEvent>[2], gapS: number): void {
    if (this.callS > 0) return;
    this.callS = gapS;
    callEvent(ctx, this, call);
  }

  /** The strike: damage once if the mouth is within reach of the player. */
  private strike(ctx: ThreatContext, reach = this.spec.reachM): boolean {
    if (this.struck || ctx.playerDown) return false;
    const m = this.mouth(_m);
    const p = ctx.player.pos;
    const near = Math.hypot(p.x - m.x, p.z - m.z) < reach && m.y > p.y - 0.6 && m.y < p.y + 2;
    if (!near) return false;
    this.struck = true;
    this.strikes++;
    this.jaw = 1;
    ctx.hurtPlayer(this.spec.damage, this.pos, this.kind);
    callEvent(ctx, this, 'bite');
    return true;
  }

  private wanderTarget(ctx: ThreatContext, radiusM: number, ok: (x: number, z: number) => boolean): void {
    for (let i = 0; i < 12; i++) {
      const a = ctx.rng.range(0, Math.PI * 2);
      const r = ctx.rng.range(radiusM * 0.3, radiusM);
      const x = this.home.x + Math.cos(a) * r;
      const z = this.home.z + Math.sin(a) * r;
      if (ok(x, z)) {
        this.target.x = x;
        this.target.z = z;
        return;
      }
    }
    this.target.x = this.home.x;
    this.target.z = this.home.z;
  }

  private fleeFrom(ctx: ThreatContext, speed: number, maxDepth = 0.25): void {
    const p = ctx.player.pos;
    const away = bearing(p.x, p.z, this.pos.x, this.pos.z);
    const tx = this.pos.x - Math.sin(away) * 20;
    const tz = this.pos.z - Math.cos(away) * 20;
    if (!this.walkTo(ctx, tx, tz, speed, maxDepth)) this.yawRad += ctx.dt * 2; // cornered by water: turn along it
  }

  // ------------------------------------------------------------------ tiger

  private tiger(ctx: ThreatContext): void {
    const s = this.spec;
    const p = ctx.player.pos;
    const d = this.distToPlayer(ctx);
    const seen = this.sees(ctx);
    if (seen) this.awareness = Math.min(1, this.awareness + ctx.dt * (0.5 + 20 / Math.max(d, 5)));
    else this.awareness = Math.max(0, this.awareness - ctx.dt * 0.03);
    // By a burning fire at night the player is safe from it: it prowls at the edge of the light.
    const fireSafe = ctx.fire !== null && ctx.night > 0.4 && Math.hypot(p.x - ctx.fire.x, p.z - ctx.fire.z) < 9;
    if (this.health < s.health * s.fleeFraction && this.state !== 'flee') this.setState('flee');
    this.crouch += ((this.state === 'stalk' ? 1 : 0) - this.crouch) * Math.min(1, ctx.dt * 3);
    switch (this.state) {
      case 'idle':
      case 'wander': {
        if (this.awareness > 0.5 && !ctx.playerDown && !ctx.player.swimming && !ctx.player.inBoat) {
          this.setState('stalk');
          break;
        }
        if (this.state === 'idle') {
          this.speedMs = Math.max(0, this.speedMs - ctx.dt * 3);
          if (this.stateS > 4 + (this.id % 5)) {
            this.wanderTarget(ctx, 60, tigerGround);
            this.setState('wander');
          }
          break;
        }
        const arrived = Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) < 2;
        if (arrived || !this.walkTo(ctx, this.target.x, this.target.z, s.walkMs) || this.stateS > 40) this.setState('idle');
        break;
      }
      case 'stalk': {
        // Slow and low toward the player; if the player turns and looks at it close by, it goes at once.
        if (ctx.playerDown || ctx.player.swimming || ctx.player.inBoat || this.awareness < 0.15) {
          this.setState('wander');
          break;
        }
        const looked = d < 22 && this.lookedAt(ctx) && seen;
        if (fireSafe) {
          // Circle at the edge of the firelight, growling.
          this.orbit(ctx, ctx.fire as P3, 13, s.stalkMs);
          this.call(ctx, 'growl', 5 + ctx.rng.range(0, 4));
          break;
        }
        if ((d < 16 || looked) && this.cooldownS <= 0) {
          this.setState('charge');
          callEvent(ctx, this, 'roar');
          break;
        }
        this.walkTo(ctx, p.x, p.z, s.stalkMs);
        if (d < 30) this.call(ctx, 'growl', 7 + ctx.rng.range(0, 6));
        break;
      }
      case 'charge': {
        if (fireSafe || ctx.playerDown) {
          this.setState('stalk');
          break;
        }
        // Run at where the player will be a moment from now.
        const lead = Math.min(0.5, d / s.runMs);
        const tx = p.x + ctx.player.vel.x * lead;
        const tz = p.z + ctx.player.vel.z * lead;
        this.walkTo(ctx, tx, tz, s.runMs);
        if (d < 5.5) {
          this.pounceFrom.x = this.pos.x;
          this.pounceFrom.y = this.pos.y;
          this.pounceFrom.z = this.pos.z;
          // Land a body length past the player's chest along the line of the leap.
          const k = (d + 0.6) / Math.max(d, 0.1);
          this.target.x = this.pos.x + (tx - this.pos.x) * k;
          this.target.z = this.pos.z + (tz - this.pos.z) * k;
          this.setState('pounce');
          callEvent(ctx, this, 'snarl');
        } else if (this.stateS > 6) this.setState('stalk');
        break;
      }
      case 'pounce': {
        const T = 0.55;
        const t = Math.min(1, this.stateS / T);
        const gx = this.pounceFrom.x + (this.target.x - this.pounceFrom.x) * t;
        const gz = this.pounceFrom.z + (this.target.z - this.pounceFrom.z) * t;
        const ground = heightAt(gx, gz);
        if (depthAt(gx, gz) < 0.3) {
          this.pos.x = gx;
          this.pos.z = gz;
        }
        this.airborne = Math.sin(Math.PI * t);
        this.pos.y = Math.max(ground, WATER_LEVEL_M - 0.3) + this.airborne * 0.9;
        this.pitchRad = (0.5 - t) * 0.5;
        this.speedMs = s.runMs * 0.8;
        if (t > 0.35) this.strike(ctx, s.reachM + 0.5);
        if (t >= 1) {
          this.airborne = 0;
          this.pitchRad = 0;
          this.cooldownS = s.cooldownS;
          this.setState('recover');
        }
        break;
      }
      case 'recover': {
        // Spring back off and circle, then come again.
        const back = bearing(p.x, p.z, this.pos.x, this.pos.z);
        if (this.stateS < 1.2) this.walkTo(ctx, this.pos.x - Math.sin(back) * 8, this.pos.z - Math.cos(back) * 8, s.runMs * 0.45);
        else this.orbit(ctx, p, 8, s.walkMs * 1.6);
        if (this.stateS > 1.2 && this.stateS % 2 < ctx.dt) this.call(ctx, 'snarl', 2.5);
        if (this.stateS > 3 && this.cooldownS <= 0) this.setState(ctx.playerDown || ctx.player.swimming ? 'wander' : 'charge');
        break;
      }
      case 'flee': {
        this.fleeFrom(ctx, s.runMs * 0.85);
        if (d > 70 || this.stateS > 14) {
          this.awareness = 0;
          // Licks its wounds: comes back to two thirds.
          this.health = Math.max(this.health, s.health * 0.66);
          this.home.x = this.pos.x;
          this.home.z = this.pos.z;
          this.setState('idle');
        }
        break;
      }
      default:
        this.setState('wander');
    }
  }

  /** Is the player looking at it (within ~12° of the centre of view)? */
  private lookedAt(ctx: ThreatContext): boolean {
    const dx = this.pos.x - ctx.eye.x;
    const dy = this.pos.y + 0.7 - ctx.eye.y;
    const dz = this.pos.z - ctx.eye.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    return (dx * ctx.look.x + dy * ctx.look.y + dz * ctx.look.z) / d > 0.978;
  }

  /** Moves round `centre` at `radius`, keeping the current sense of rotation. */
  private orbit(ctx: ThreatContext, centre: P3, radius: number, speed: number): void {
    const a = Math.atan2(this.pos.z - centre.z, this.pos.x - centre.x) + this.circleDir * (speed / Math.max(radius, 1)) * 1.2;
    const tx = centre.x + Math.cos(a) * radius;
    const tz = centre.z + Math.sin(a) * radius;
    if (!this.walkTo(ctx, tx, tz, speed)) this.circleDir *= -1;
  }

  // ------------------------------------------------------------------ boar

  private boar(ctx: ThreatContext): void {
    const s = this.spec;
    const p = ctx.player.pos;
    const d = this.distToPlayer(ctx);
    if (this.health < s.health * s.fleeFraction && this.state !== 'flee') this.setState('flee');
    switch (this.state) {
      case 'idle':
      case 'wander': {
        // Rooting about; too close, or shot at nearby, and it goes for the player.
        const provoked = !ctx.playerDown && !ctx.player.inBoat && !ctx.player.inJeep && ((d < 9 && this.sees(ctx, 3.6)) || (this.awareness > 0.7 && d < 30));
        if (provoked) {
          this.strikes = 0;
          this.setState('charge');
          callEvent(ctx, this, 'squeal');
          this.awareness = 0;
          break;
        }
        this.awareness = Math.max(0, this.awareness - ctx.dt * 0.1);
        if (this.state === 'idle') {
          this.speedMs = Math.max(0, this.speedMs - ctx.dt * 2);
          if (ctx.rng.next() < ctx.dt * 0.15) this.call(ctx, 'grunt', 3);
          if (this.stateS > 3 + (this.id % 4)) {
            this.wanderTarget(ctx, 14, boarGround);
            this.setState('wander');
          }
          break;
        }
        if (Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) < 1 || !this.walkTo(ctx, this.target.x, this.target.z, s.walkMs) || this.stateS > 20) this.setState('idle');
        break;
      }
      case 'charge': {
        if (ctx.playerDown) {
          this.setState('wander');
          break;
        }
        // Straight at the player; once committed (inside 4 m) it runs on through.
        if (d > 4 || this.stateS < 0.3) {
          this.target.x = p.x + (p.x - this.pos.x) / Math.max(d, 0.1) * 5;
          this.target.z = p.z + (p.z - this.pos.z) / Math.max(d, 0.1) * 5;
        }
        const ok = this.walkTo(ctx, this.target.x, this.target.z, s.runMs);
        this.strike(ctx);
        if (!ok || Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) < 1 || this.stateS > 5) {
          this.cooldownS = s.cooldownS;
          this.setState(this.strikes >= 3 ? 'flee' : 'recover');
        }
        break;
      }
      case 'recover': {
        // Skid round and face the player again.
        this.speedMs = Math.max(0, this.speedMs - ctx.dt * 9);
        this.yawRad = turnToward(this.yawRad, bearing(this.pos.x, this.pos.z, p.x, p.z), s.turnRadS * 1.5, ctx.dt);
        if (this.cooldownS <= 0) {
          const again = d < 25 && !ctx.playerDown;
          this.setState(again ? 'charge' : 'wander');
          if (again) callEvent(ctx, this, 'grunt');
        }
        break;
      }
      case 'flee': {
        this.fleeFrom(ctx, s.runMs * 0.8);
        if (d > 40 || this.stateS > 10) {
          this.home.x = this.pos.x;
          this.home.z = this.pos.z;
          this.setState('idle');
        }
        break;
      }
      default:
        this.setState('wander');
    }
  }

  // ------------------------------------------------------------------ crocodile

  private croc(ctx: ThreatContext): void {
    const s = this.spec;
    const dt = ctx.dt;
    const p = ctx.player.pos;
    const d = this.distToPlayer(ctx);
    const depth = depthAt(this.pos.x, this.pos.z);
    const inWater = depth > 0.45;
    // Its prey: someone in the water near it, or on the sand within a couple of body lengths.
    const pDepth = depthAt(p.x, p.z);
    const playerExposed = !ctx.playerDown && !ctx.player.inBoat && !ctx.player.inJeep;
    const reachable = playerExposed && ((pDepth > 0.2 && d < 9) || (d < 4.5 && pDepth > -1.2));
    if (this.health < s.health * s.fleeFraction && this.state !== 'retreat') this.setState('retreat');
    this.submerge += ((inWater ? (this.state === 'lunge' ? 0.45 : 0.82) : 0) - this.submerge) * Math.min(1, dt * 2);
    switch (this.state) {
      case 'lurk':
      case 'bask':
      case 'idle':
      case 'wander': {
        if (reachable && this.cooldownS <= 0) {
          this.setState('lunge');
          callEvent(ctx, this, inWater ? 'splash' : 'hiss');
          break;
        }
        // Drift: a slow paddle toward a spot near home, or lie still.
        if (this.state === 'wander') {
          if (Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) < 1 || this.stateS > 30 || !this.swimTo(ctx, this.target.x, this.target.z, s.walkMs)) this.setState(depth < 0.3 ? 'bask' : 'lurk');
        } else {
          this.speedMs = Math.max(0, this.speedMs - dt);
          this.settle(depth);
          if (this.stateS > 12 + (this.id % 7) * 3) {
            this.wanderTarget(ctx, 25, crocGround);
            this.setState('wander');
          }
          if (d < 8 && playerExposed && this.state === 'bask') this.call(ctx, 'hiss', 4);
        }
        break;
      }
      case 'lunge': {
        // A burst at the player, jaws open; it gives up after a second and a half.
        this.jaw = Math.min(1, this.jaw + dt * 6);
        // The head and body whip round first (a crocodile strikes sideways as fast as ahead).
        this.swimTo(ctx, p.x, p.z, s.runMs, 1.5, 4);
        this.strike(ctx);
        if (this.struck || this.stateS > 1.4 || !reachable) {
          this.cooldownS = s.cooldownS;
          if (this.struck) this.rollRad = 0.01; // the roll: render spins the body once
          this.setState('retreat');
        }
        break;
      }
      case 'retreat': {
        // Back into deeper water, away from the player.
        this.rollRad = this.rollRad > 0 ? this.rollRad + dt * 9 : 0;
        if (this.rollRad > Math.PI * 2) this.rollRad = 0;
        const away = bearing(p.x, p.z, this.pos.x, this.pos.z);
        const tx = this.pos.x - Math.sin(away) * 8;
        const tz = this.pos.z - Math.cos(away) * 8;
        this.swimTo(ctx, tx, tz, s.stalkMs * 2);
        if (this.stateS > 4) {
          if (this.health < s.health * s.fleeFraction) this.health = Math.min(s.health * 0.5, this.health + 1); // keeps away while weak
          this.setState('lurk');
        }
        break;
      }
      default:
        this.setState('lurk');
    }
  }

  /** Swims or crawls: water and the first few metres of land, never further inland. */
  private swimTo(ctx: ThreatContext, tx: number, tz: number, speed: number, landM = 5, turnK = 1): boolean {
    const dt = ctx.dt;
    const want = bearing(this.pos.x, this.pos.z, tx, tz);
    this.yawRad = turnToward(this.yawRad, want, this.spec.turnRadS * turnK, dt);
    const facing = Math.max(0.1, Math.cos(wrapAngle(want - this.yawRad)));
    this.speedMs += (speed * facing - this.speedMs) * Math.min(1, dt * 3);
    const nx = this.pos.x + this.forwardX * this.speedMs * dt;
    const nz = this.pos.z + this.forwardZ * this.speedMs * dt;
    const sd = shoreDistance(nx, nz);
    if (sd > landM || depthAt(nx, nz) > 7) {
      this.speedMs = 0;
      return false;
    }
    this.pos.x = nx;
    this.pos.z = nz;
    this.settle(depthAt(nx, nz));
    return true;
  }

  /** Height in the water: eyes and nostrils just out when floating, on the bottom in the shallows. */
  private settle(depth: number): void {
    const ground = heightAt(this.pos.x, this.pos.z);
    this.pos.y = depth > 0.45 ? WATER_LEVEL_M - 0.12 - 0.18 * this.submerge : Math.max(ground, WATER_LEVEL_M - 0.3);
  }

  // ------------------------------------------------------------------ shark

  private shark(ctx: ThreatContext): void {
    const s = this.spec;
    const dt = ctx.dt;
    const p = ctx.player.pos;
    const d = this.distToPlayer(ctx);
    const swimmer = !ctx.playerDown && ctx.player.swimming && !ctx.player.inBoat;
    // Someone in the water within its senses: the splashing carries far.
    const hunting = swimmer && d < 40 && depthAt(p.x, p.z) > 1.4;
    if (this.health < s.health * s.fleeFraction && this.state !== 'flee') this.setState('flee');
    switch (this.state) {
      case 'cruise':
      case 'idle':
      case 'wander': {
        if (hunting) {
          this.circleM = 11;
          this.circleDir = ctx.rng.next() < 0.5 ? 1 : -1;
          this.setState('circle');
          break;
        }
        if (Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) < 3 || this.stateS > 30) {
          this.wanderTarget(ctx, 45, sharkWater);
          this.stateS = 0;
        }
        this.swimDeep(ctx, this.target.x, this.target.z, s.walkMs, 2.2);
        break;
      }
      case 'circle': {
        if (!hunting) {
          this.setState('cruise');
          break;
        }
        // Closing circles, fin out of the water; the more the swimmer bleeds, the shorter the wait.
        const wounded = 1 - ctx.player.health / 100;
        this.circleM = Math.max(4, this.circleM - dt * (0.6 + wounded));
        const a = Math.atan2(this.pos.z - p.z, this.pos.x - p.x) + this.circleDir * (s.stalkMs / this.circleM) * dt * 1.6;
        this.swimDeep(ctx, p.x + Math.cos(a) * this.circleM, p.z + Math.sin(a) * this.circleM, s.stalkMs, 0.35);
        if (this.circleM <= 4.5 && this.cooldownS <= 0 && this.stateS > 5) this.setState('attack');
        break;
      }
      case 'attack': {
        if (!swimmer) {
          this.setState('cruise');
          break;
        }
        this.jaw = Math.min(1, this.jaw + dt * 4);
        this.swimDeep(ctx, p.x, p.z, s.runMs, 0.6);
        this.strike(ctx);
        if (this.struck || this.stateS > 2.5) {
          this.cooldownS = s.cooldownS;
          this.circleM = 14;
          this.setState('retreat');
          if (this.struck) callEvent(ctx, this, 'splash');
        }
        break;
      }
      case 'retreat': {
        const away = bearing(p.x, p.z, this.pos.x, this.pos.z);
        this.swimDeep(ctx, this.pos.x - Math.sin(away) * 10, this.pos.z - Math.cos(away) * 10, s.stalkMs * 1.5, 1.5);
        if (this.stateS > 3) this.setState(hunting ? 'circle' : 'cruise');
        break;
      }
      case 'flee': {
        const away = bearing(p.x, p.z, this.pos.x, this.pos.z);
        this.swimDeep(ctx, this.pos.x - Math.sin(away) * 20, this.pos.z - Math.cos(away) * 20, s.runMs * 0.7, 3);
        if (this.stateS > 8) {
          this.health = Math.max(this.health, s.health * 0.5);
          this.setState('cruise');
        }
        break;
      }
      default:
        this.setState('cruise');
    }
    // How much of it is under: the fin breaks the surface when it swims shallow.
    this.submerge = Math.min(1, (WATER_LEVEL_M - this.pos.y) / 1.2);
  }

  /** Swims at `depthM` below the surface (never into the bottom or shallower than its body). */
  private swimDeep(ctx: ThreatContext, tx: number, tz: number, speed: number, depthM: number): void {
    const dt = ctx.dt;
    const want = bearing(this.pos.x, this.pos.z, tx, tz);
    const before = this.yawRad;
    this.yawRad = turnToward(this.yawRad, want, this.spec.turnRadS, dt);
    this.rollRad += (wrapAngle(this.yawRad - before) / Math.max(dt, 1e-4) * -0.25 - this.rollRad) * Math.min(1, dt * 3);
    this.speedMs += (speed - this.speedMs) * Math.min(1, dt * 2);
    let nx = this.pos.x + this.forwardX * this.speedMs * dt;
    let nz = this.pos.z + this.forwardZ * this.speedMs * dt;
    if (depthAt(nx, nz) < 1.6) {
      // Shallows ahead: turn away from the shore instead.
      this.yawRad = turnToward(this.yawRad, bearing(this.pos.x, this.pos.z, LAGOON_CENTRE.x, LAGOON_CENTRE.z), this.spec.turnRadS * 2, dt);
      nx = this.pos.x;
      nz = this.pos.z;
      this.speedMs *= 0.9;
    }
    this.pos.x = nx;
    this.pos.z = nz;
    const floor = heightAt(nx, nz) + 0.45;
    const y = Math.max(floor, WATER_LEVEL_M - depthM);
    const prevY = this.pos.y;
    this.pos.y += (y - this.pos.y) * Math.min(1, dt * 1.5);
    this.pitchRad = Math.atan2(this.pos.y - prevY, Math.max(0.05, this.speedMs * dt));
  }
}

const _m: P3 = { x: 0, y: 0, z: 0 };

function callEvent(ctx: ThreatContext, c: Creature, call: 'growl' | 'roar' | 'snarl' | 'grunt' | 'squeal' | 'hiss' | 'bite' | 'splash' | 'pain' | 'die'): void {
  ctx.events.push({ type: 'threatCall', pos: { x: c.pos.x, y: c.pos.y + 0.6, z: c.pos.z }, kind: c.kind, call });
}

/**
 * Hit spheres per species in the creature's frame: along the body (+ forward), up from its origin
 * (the ground under it, or the waterline for a swimmer), radius, part. The first one is the head.
 */
const SPHERES: Record<SpeciesId, [number, number, number, HitPart][]> = {
  tiger: [
    [1.05, 0.82, 0.24, 'head'],
    [0.55, 0.72, 0.36, 'torso'],
    [0.05, 0.7, 0.34, 'torso'],
    [-0.45, 0.7, 0.32, 'torso'],
    [0.45, 0.32, 0.2, 'limb'],
    [-0.45, 0.32, 0.2, 'limb'],
  ],
  boar: [
    [0.62, 0.46, 0.17, 'head'],
    [0.18, 0.52, 0.28, 'torso'],
    [-0.3, 0.52, 0.27, 'torso'],
  ],
  croc: [
    [1.75, 0.12, 0.2, 'head'],
    [1.15, 0.16, 0.22, 'torso'],
    [0.45, 0.2, 0.32, 'torso'],
    [-0.3, 0.18, 0.3, 'torso'],
    [-1.1, 0.12, 0.2, 'limb'],
    [-1.75, 0.08, 0.13, 'limb'],
  ],
  shark: [
    [1.05, 0, 0.26, 'head'],
    [0.35, 0, 0.4, 'torso'],
    [-0.45, 0, 0.3, 'torso'],
    [-1.05, 0, 0.17, 'limb'],
  ],
};

// ------------------------------------------------------------------ where each lives

function slopeOk(x: number, z: number, minY: number): boolean {
  const n = { x: 0, y: 1, z: 0 };
  normalAt(x, z, n);
  return n.y > minY;
}

function fromOutpost(x: number, z: number): number {
  return Math.hypot(x - OUTPOST_CENTRE.x, z - OUTPOST_CENTRE.z);
}

/** Jungle away from the beach and the shelter's clearing. */
export function tigerGround(x: number, z: number): boolean {
  const d = shoreDistance(x, z);
  return d > beachWidth(x, z) + 10 && fromOutpost(x, z) > 40 && Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z) < LAGOON_PLAYER.borderStartM && slopeOk(x, z, 0.72);
}

/** The jungle's edge behind the sand. */
export function boarGround(x: number, z: number): boolean {
  const d = shoreDistance(x, z);
  const bw = beachWidth(x, z);
  return d > bw + 2 && d < bw + 35 && fromOutpost(x, z) > 25 && slopeOk(x, z, 0.8);
}

/** Lagoon edge water, half a metre to two metres deep, away from the dock. */
export function crocGround(x: number, z: number): boolean {
  const depth = depthAt(x, z);
  return depth > 0.5 && depth < 2.2 && fromOutpost(x, z) > 30 && Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z) < 140;
}

/** Deep water in the lagoon and its mouth. */
export function sharkWater(x: number, z: number): boolean {
  return depthAt(x, z) > 3 && Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z) < LAGOON_PLAYER.borderStartM;
}

const GROUND: Record<SpeciesId, (x: number, z: number) => boolean> = { tiger: tigerGround, boar: boarGround, croc: crocGround, shark: sharkWater };

/** How many of each roam the lagoon. */
export const POPULATION: Record<SpeciesId, number> = { tiger: 1, boar: 3, croc: 2, shark: 2 };

// ------------------------------------------------------------------ the population

export class Fauna {
  readonly creatures: Creature[] = [];
  private nextId = 1;
  private readonly respawnS = new Map<SpeciesId, number[]>();

  /** Places the starting animals; boars come as a herd round one spot. */
  populate(ctx: Pick<ThreatContext, 'rng' | 'player'>): void {
    for (const kind of Object.keys(POPULATION) as SpeciesId[]) {
      const herd = kind === 'boar' ? this.findSpot(kind, ctx.rng, ctx.player.pos, null) : null;
      for (let i = 0; i < POPULATION[kind]; i++) {
        const at = herd ? this.near(kind, herd, ctx.rng) : this.findSpot(kind, ctx.rng, ctx.player.pos, null);
        if (at) this.spawn(kind, at, ctx.rng.range(0, Math.PI * 2));
      }
    }
  }

  spawn(kind: SpeciesId, at: P3, yawRad: number): Creature {
    const c = new Creature(this.nextId++, kind, at, yawRad);
    this.creatures.push(c);
    return c;
  }

  step(ctx: ThreatContext): void {
    for (const c of this.creatures) c.step(ctx);
    // Clear old bodies; queue a replacement for each, to come back out of sight.
    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i] as Creature;
      if (c.alive || c.deathS < CORPSE_S) continue;
      this.creatures.splice(i, 1);
      const list = this.respawnS.get(c.kind) ?? [];
      list.push(c.spec.respawnS);
      this.respawnS.set(c.kind, list);
    }
    for (const [kind, list] of this.respawnS) {
      for (let i = list.length - 1; i >= 0; i--) {
        list[i] = (list[i] as number) - ctx.dt;
        if ((list[i] as number) > 0) continue;
        const at = this.findSpot(kind, ctx.rng, ctx.player.pos, ctx);
        if (!at) continue; // try again next step
        list.splice(i, 1);
        this.spawn(kind, at, ctx.rng.range(0, Math.PI * 2));
      }
    }
  }

  /** A place on the species' ground, far from the player and (given a context) out of the player's view. */
  findSpot(kind: SpeciesId, rng: ThreatContext['rng'], player: P3, ctx: ThreatContext | null): P3 | null {
    const ok = GROUND[kind];
    for (let i = 0; i < 400; i++) {
      const x = LAGOON_CENTRE.x + rng.range(-170, 170);
      const z = LAGOON_CENTRE.z + rng.range(-170, 170);
      if (!ok(x, z) || Math.hypot(x - player.x, z - player.z) < SPAWN_CLEAR_M) continue;
      const y = kind === 'shark' ? WATER_LEVEL_M - 2.2 : kind === 'croc' ? WATER_LEVEL_M - 0.25 : heightAt(x, z);
      if (ctx) {
        const eye = ctx.eye;
        const dx = x - eye.x;
        const dz = z - eye.z;
        const d = Math.hypot(dx, dz) || 1;
        const facing = (dx * ctx.look.x + dz * ctx.look.z) / d > 0.5;
        if (facing && sightLine(ctx.collision, eye, { x, y: y + 0.6, z }) > 0) continue;
      }
      return { x, y, z };
    }
    return null;
  }

  private near(kind: SpeciesId, at: P3, rng: ThreatContext['rng']): P3 {
    for (let i = 0; i < 30; i++) {
      const x = at.x + rng.range(-5, 5);
      const z = at.z + rng.range(-5, 5);
      if (GROUND[kind](x, z)) return { x, y: heightAt(x, z), z };
    }
    return { ...at };
  }
}
