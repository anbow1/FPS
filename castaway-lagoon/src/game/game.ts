import { Rng } from '../core/rng.ts';
import { BOAT, FIRE, HEALTH, INTERACT, JEEP, KNIFE, LAGOON_PLAYER, LOG, RIFLE, STONE, TIME_OF_DAY, type TimeOfDayId, WATER_LEVEL_M, WEAPON_DAMAGE, type WeatherId } from '../config.ts';
import { Bodies, type BodyRest, knockCan } from './bodies.ts';
import { Bullets } from './bullets.ts';
import { newHit, type RayHit } from './colliders.ts';
import { Environment } from './environment.ts';
import { Boat } from './boat.ts';
import { Campfire } from './fire.ts';
import { Jeep } from './jeep.ts';
import { DOCK, FURNITURE, outpostToWorld, OUTPOST } from './outpost.ts';
import { type ActionKind, Equipment, type Triggers } from './equipment.ts';
import { type EquipSlot, EventQueue, type P3, type ThreatKind } from './events.ts';
import { Fauna } from './fauna.ts';
import { GuerrillaBand } from './guerrillas.ts';
import { rayTargets, type Target } from './targets.ts';
import type { ThreatContext } from './threatContext.ts';
import { Inventory } from './inventory.ts';
import { type ItemId, ITEMS } from './items.ts';
import { type MoveIntent, Player } from './player.ts';
import { heightAt } from './terrain.ts';
import { waterSurfaceY, waveScale } from './waves.ts';
import { buildWorld, crateContents, type Interactable, type LagoonWorld } from './world.ts';

// The lagoon's game logic, headless (rules §10: no THREE here). One fixed
// update order, written down in `step`:
//   1. environment (clock, weather, wetness, lightning)
//   2. look, then walk
//   3. what the eye is on (interaction focus)
//   4. interaction and tool input → actions
//   5. action timeline: mid-action moments (release, hit, pick-up) and completions
//   6. the threats: creatures and guerrillas sense, move and strike
//   7. free bodies (stones, shells, cans), then bullets (which hit the threats)
//   8. the player's wounds: regeneration, treatment, blackout and waking

export interface LagoonIntent {
  move: Omit<MoveIntent, 'slowed'>;
  lookYawRad: number;
  lookPitchRad: number;
  triggers: Triggers;
  interactPressed: boolean;
  toggleLamp: boolean;
  cycleTime: boolean;
  cycleWeather: boolean;
  setTime: TimeOfDayId | null;
  setWeather: WeatherId | null;
  /** Q: treat wounds with the best thing carried (HEALTH.treatments). */
  heal: boolean;
}

export function emptyIntent(): LagoonIntent {
  return {
    move: { moveRight: 0, moveForward: 0, sprint: false, jump: false, dive: false, rise: false },
    lookYawRad: 0,
    lookPitchRad: 0,
    triggers: { firePressed: false, fireHeld: false, fireReleased: false, aimHeld: false, reloadPressed: false, selectSlot: null },
    interactPressed: false,
    toggleLamp: false,
    cycleTime: false,
    cycleWeather: false,
    setTime: null,
    setWeather: null,
    heal: false,
  };
}

export interface GameOptions {
  /** Creatures and guerrillas (off for tests of other mechanics, and ?peaceful). */
  threats: boolean;
}

/** Nothing hunts the player in the first moments, while they find their feet (s of game time). */
export const THREATS_AFTER_S = 45;
/** How far a noise carries to ears that listen for it (m): a rifle shot, a knife on wood. */
const SHOT_HEARD_M = 220;

const HANDS_ACTIONS: readonly ActionKind[] = ['pickup', 'harvest', 'openCrate', 'sleep'];

/** Where a sleep on the cot ends: evenings and nights sleep to morning, days to the golden hour. */
export function sleepUntil(now: TimeOfDayId): TimeOfDayId {
  return now === 'sunset' || now === 'night' ? 'morning' : 'sunset';
}

export class LagoonGame {
  readonly world: LagoonWorld;
  readonly events = new EventQueue();
  readonly rng: Rng;
  readonly player: Player;
  readonly inventory = new Inventory();
  readonly equipment = new Equipment();
  readonly env: Environment;
  readonly bodies: Bodies;
  readonly bullets: Bullets;
  timeSeconds = 0;
  readonly fire = new Campfire();
  readonly boat: Boat;
  private boatSpot: Interactable | null = null;
  readonly jeep: Jeep;
  /** Driver's door, passenger's door and bonnet: where E reaches them, moved with the jeep. */
  private readonly jeepSpots: Interactable[] = [];
  /** The driver's door swings shut this long after getting in or out. */
  private jeepDoorTimerS = 0;
  /** Centre of the fire pit on the ground, world space. */
  readonly firePitPos: P3;
  /** The carried kerosene lamp is burning. */
  lampLit = false;
  /** Interactable under the crosshair, or null. */
  focus: Interactable | null = null;
  /** Bumped whenever interactables are added or removed, so render can re-sync. */
  interactablesVersion = 0;
  private nextInteractableId = 10000;
  private readonly hit: RayHit = newHit();
  private readonly eye: P3 = { x: 0, y: 0, z: 0 };
  private readonly fwd: P3 = { x: 0, y: 0, z: 0 };
  private readonly rested: BodyRest[] = [];
  /** The lagoon's animals and the guerrillas (null with threats off). */
  readonly fauna: Fauna | null;
  readonly band: GuerrillaBand | null;
  /** A loud noise made this step, for the threats' ears. */
  private noise: { pos: P3; radiusM: number } | null = null;
  /** Seconds since the player was last hurt. */
  sinceHurtS = 99;
  /** Healing still to come from a treatment (hit points), and its rate (per s). */
  healPool = 0;
  private healRate = 0;
  /** Blacked out: seconds until waking at the shelter (0 when up). */
  downS = 0;
  /** What last hurt the player (HUD, the blackout message). */
  lastCause: ThreatKind | 'fall' | null = null;
  private readonly ctx: ThreatContext;
  private readonly targetList: Target[] = [];

  constructor(seed: number, time: TimeOfDayId, weather: WeatherId, options: GameOptions = { threats: true }) {
    this.rng = new Rng(seed);
    this.world = buildWorld(seed);
    this.player = new Player(this.world.spawn.pos, this.world.spawn.yawRad);
    this.env = new Environment(time, weather);
    this.bodies = new Bodies(this.world.collision, this.events);
    this.bullets = new Bullets(this.world.collision, this.events);
    this.firePitPos = outpostToWorld(FURNITURE.firePit.x, -OUTPOST.deckHeightM, FURNITURE.firePit.z, { x: 0, y: 0, z: 0 });
    this.firePitPos.y = heightAt(this.firePitPos.x, this.firePitPos.z);
    // Moored alongside the end of the dock, on its starboard side, bow out.
    const s = Math.sin(DOCK.yawRad);
    const c = Math.cos(DOCK.yawRad);
    const along = DOCK.lengthM - 2.2;
    const off = DOCK.halfWidthM + BOAT.beamM * 0.5 + 0.35;
    this.boat = new Boat({ x: DOCK.x - s * along + c * off, y: 0, z: DOCK.z - c * along - s * off }, DOCK.yawRad);
    this.addInteractable({ kind: 'boat', model: 'none', item: null, count: 0, pos: { ...this.boat.pos }, yawRad: 0, radiusM: 1.4, name: 'Boat' });
    this.boatSpot = this.world.interactables[this.world.interactables.length - 1] ?? null;
    // Parked beside the shelter, nose toward the lagoon.
    this.jeep = new Jeep(outpostToWorld(5.8, 0, -0.4, { x: 0, y: 0, z: 0 }), OUTPOST.yawRad);
    for (const [model, name] of [
      ['jeepDriver', 'Jeep'],
      ['jeepPassenger', "Jeep's door"],
      ['jeepBonnet', 'Bonnet'],
    ] as const) {
      this.addInteractable({ kind: 'jeep', model, item: null, count: 0, pos: { x: 0, y: 0, z: 0 }, yawRad: 0, radiusM: 0.45, name });
      this.jeepSpots.push(this.world.interactables[this.world.interactables.length - 1] as Interactable);
    }
    this.placeJeepSpots();
    this.ctx = {
      dt: 0,
      timeS: 0,
      rng: this.rng,
      events: this.events,
      collision: this.world.collision,
      player: this.player,
      eye: this.eye,
      look: this.fwd,
      playerDown: false,
      night: 0,
      fire: null,
      lampLit: false,
      noise: null,
      hurtPlayer: (amount, from, cause) => this.hurt(amount, from, cause),
    };
    if (options.threats) {
      this.fauna = new Fauna();
      this.fauna.populate(this.ctx);
      this.band = new GuerrillaBand(this.rng, this.world.trees);
      this.band.populate(this.rng);
    } else {
      this.fauna = null;
      this.band = null;
    }
  }

  /** Everything the player's weapons can hit this step. */
  targets(): readonly Target[] {
    const out = this.targetList;
    out.length = 0;
    if (this.fauna) for (const c of this.fauna.creatures) if (c.alive) out.push(c);
    if (this.band) for (const g of this.band.members) if (g.alive) out.push(g);
    return out;
  }

  /** Damage to the player from `from` (null: no direction), by `cause`. Blacks out at zero. */
  hurt(amount: number, from: P3 | null, cause: ThreatKind | 'fall'): void {
    const p = this.player;
    if (this.downS > 0 || amount <= 0) return;
    p.health = Math.max(0, p.health - amount);
    this.sinceHurtS = 0;
    this.lastCause = cause;
    this.events.push({ type: 'hurt', amount, from: from ? { ...from } : null, cause });
    if (p.health > 0) return;
    // Down: tools away, out of the boat or the jeep, the screen goes dark.
    this.downS = HEALTH.blackoutS;
    this.healPool = 0;
    const eq = this.equipment;
    eq.finish();
    if (eq.slot !== 'hands') eq.switchTo('hands');
    if (p.inBoat) this.leaveBoat();
    if (p.inJeep) this.leaveJeep();
    this.events.push({ type: 'blackout', cause });
  }

  /** Wakes at the shelter's cot, patched up; whatever was on the player has gone off elsewhere. */
  private wake(): void {
    const p = this.player;
    const cot = this.world.interactables.find((i) => i.kind === 'sleep');
    const at = cot ? cot.pos : this.world.spawn.pos;
    p.pos.x = at.x + 0.6;
    p.pos.z = at.z;
    p.pos.y = this.world.collision.groundAt(p.pos.x, p.pos.z, at.y + 1, 1.5);
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.swimming = false;
    p.underwater = false;
    p.airS = LAGOON_PLAYER.breathSeconds;
    p.health = HEALTH.max * HEALTH.respawnFraction;
    this.sinceHurtS = 0;
    // Hunters lose the trail; raiders go back into the jungle.
    if (this.fauna) for (const c of this.fauna.creatures) if (c.alive) {
      c.awareness = 0;
      if (Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z) < 60) {
        const spot = this.fauna.findSpot(c.kind, this.rng, p.pos, null);
        if (spot) {
          c.pos.x = c.prev.x = spot.x;
          c.pos.y = c.prev.y = spot.y;
          c.pos.z = c.prev.z = spot.z;
          c.home.x = spot.x;
          c.home.z = spot.z;
        }
      }
      c.setState(c.kind === 'croc' ? 'lurk' : c.kind === 'shark' ? 'cruise' : 'wander');
    }
    if (this.band) {
      for (let i = this.band.members.length - 1; i >= 0; i--) {
        const g = this.band.members[i];
        if (!g) continue;
        if (g.role === 'raider') this.band.members.splice(i, 1);
        else if (g.alive) {
          g.awareness = 0;
          g.setState(g.role === 'patrol' ? 'patrol' : 'camp');
        }
      }
    }
    this.downS = 0;
    this.events.push({ type: 'wake' });
  }

  /** Q: the best treatment carried (a dressing first), healing over a few seconds. */
  private treat(): void {
    const p = this.player;
    if (this.downS > 0) return;
    if (p.health >= HEALTH.max - 0.5) {
      this.events.push({ type: 'message', text: 'No wounds to treat' });
      return;
    }
    if (this.healPool > 0) {
      this.events.push({ type: 'message', text: 'Still treating the last wound' });
      return;
    }
    const t = HEALTH.treatments.find((tr) => this.inventory.has(tr.item as ItemId));
    if (!t) {
      this.events.push({ type: 'message', text: 'Nothing to treat wounds with — jungle herbs grow at the edge of the trees' });
      return;
    }
    this.inventory.remove(t.item as ItemId, 1);
    this.healPool = t.hp;
    this.healRate = t.hp / t.seconds;
    this.events.push({ type: 'treat', item: t.item, hp: t.hp, text: t.verb });
  }

  /** Regeneration up to a cap, treatment over time. */
  private heal(dt: number): void {
    const p = this.player;
    this.sinceHurtS += dt;
    if (this.healPool > 0) {
      const h = Math.min(this.healPool, this.healRate * dt);
      this.healPool -= h;
      p.health = Math.min(HEALTH.max, p.health + h);
      if (p.health >= HEALTH.max) this.healPool = 0;
    }
    const cap = HEALTH.max * HEALTH.regenCapFraction;
    if (this.sinceHurtS > HEALTH.regenDelayS && p.health < cap) p.health = Math.min(cap, p.health + HEALTH.regenPerS * dt);
  }

  /** The threats' turn: context for their senses, then the animals and the band. */
  private stepThreats(dt: number): void {
    if (!this.fauna && !this.band) return;
    const c = this.ctx;
    c.dt = dt;
    c.timeS = this.timeSeconds;
    c.playerDown = this.downS > 0;
    c.night = this.env.daylight.night;
    c.fire = this.fire.lit ? this.firePitPos : null;
    c.lampLit = this.lampLit;
    c.noise = this.noise;
    if (this.timeSeconds < THREATS_AFTER_S) return;
    this.fauna?.step(c);
    if (this.band) {
      this.band.step(c, true);
      for (const d of this.band.drops) {
        const y = heightAt(d.pos.x, d.pos.z);
        this.addInteractable({ kind: 'pickup', model: 'ammoBox', item: 'ammo762', count: d.ammo, pos: { x: d.pos.x, y, z: d.pos.z }, yawRad: this.rng.range(0, 6.28), radiusM: 0.25, name: `${d.ammo} rounds of 7.62` });
        if (d.medkit) this.addInteractable({ kind: 'pickup', model: 'medkit', item: 'medkit', count: 1, pos: { x: d.pos.x + 0.4, y: heightAt(d.pos.x + 0.4, d.pos.z + 0.2), z: d.pos.z + 0.2 }, yawRad: this.rng.range(0, 6.28), radiusM: 0.2, name: 'Field Dressing' });
      }
    }
  }

  get interactables(): readonly Interactable[] {
    return this.world.interactables;
  }

  step(intent: LagoonIntent, dt: number): void {
    this.noise = null;
    // Blacked out: nothing the player does counts until waking.
    if (this.downS > 0) {
      const m = intent.move;
      m.moveForward = m.moveRight = 0;
      m.jump = m.sprint = m.dive = m.rise = false;
      intent.triggers = { firePressed: false, fireHeld: false, fireReleased: false, aimHeld: false, reloadPressed: false, selectSlot: null };
      intent.interactPressed = false;
      intent.heal = false;
      intent.lookYawRad = 0;
      intent.lookPitchRad = 0;
    }
    // 1. Environment.
    if (intent.setTime) this.env.setTime(intent.setTime);
    else if (intent.cycleTime) this.env.cycleTime();
    if (intent.setWeather) this.env.setWeather(intent.setWeather);
    else if (intent.cycleWeather) this.env.cycleWeather();
    this.env.step(dt, this.rng, this.events);
    this.fire.step(dt, this.env.weather.rainRate, this.events);

    // 2. Look and walk.
    const eq = this.equipment;
    this.player.look(intent.lookYawRad, intent.lookPitchRad);
    const slowed = eq.adsBlend > 0.5 || HANDS_ACTIONS.includes(eq.action.kind) || eq.action.kind === 'windup';
    // Asleep: nobody walks.
    if (eq.action.kind === 'sleep') {
      intent.move.moveForward = 0;
      intent.move.moveRight = 0;
      intent.move.jump = false;
    }
    const water = { timeS: this.timeSeconds, waveScale: waveScale(this.env.weather.rainRate, this.env.weather.windMs) };
    const inBoat = this.player.inBoat;
    const inJeep = this.player.inJeep;
    this.jeep.occupied = inJeep;
    this.jeep.step(inJeep ? { throttle: intent.move.moveForward, steer: intent.move.moveRight } : { throttle: 0, steer: 0 }, dt, this.world.collision, this.events);
    this.placeJeepSpots();
    this.jeepDoorTimerS = Math.max(0, this.jeepDoorTimerS - dt);
    if (this.jeepDoorTimerS === 0) this.jeep.doorTarget.driver = 0;
    this.boat.occupied = inBoat;
    this.boat.step(inBoat ? { throttle: intent.move.moveForward, steer: intent.move.moveRight } : { throttle: 0, steer: 0 }, dt, water.timeS, water.waveScale, this.world.collision, this.events);
    if (inBoat) this.ride();
    else if (inJeep) this.driveSeat();
    else {
      this.player.step({ ...intent.move, slowed }, dt, this.world.collision, this.events, water);
      if (this.player.landingMs > HEALTH.fallSafeMs) this.hurt((this.player.landingMs - HEALTH.fallSafeMs) * HEALTH.fallDamagePerMs, null, 'fall');
    }
    if (this.boatSpot) this.boat.toWorld(-0.3, 0.2, 0, this.boatSpot.pos);
    // Both hands are for swimming: whatever was held goes on the back.
    if (this.player.swimming && eq.slot !== 'hands' && eq.action.kind !== 'lower') {
      eq.finish();
      eq.switchTo('hands');
      this.events.push({ type: 'equip', slot: 'hands' });
    }
    this.player.eye(this.eye);
    this.player.forward(this.fwd);

    // L: the headlights while driving, otherwise the lamp; a dunking puts the lamp out.
    if (intent.toggleLamp && this.player.inJeep) {
      this.jeep.headlights = !this.jeep.headlights;
      this.events.push({ type: 'jeep', what: 'lights' });
    } else if (intent.toggleLamp && this.inventory.has('lamp') && !this.player.underwater) this.setLamp(!this.lampLit);
    if (this.lampLit && this.player.underwater) {
      this.setLamp(false);
      this.events.push({ type: 'message', text: 'The lamp went out' });
    }

    // 3. Focus.
    this.focus = this.findFocus();

    // 4. Interaction and tools.
    if (intent.interactPressed) this.interact();
    if (intent.heal) this.treat();
    if (intent.triggers.selectSlot) this.select(intent.triggers.selectSlot);
    this.useTool(intent.triggers);

    // 5. Timeline.
    const before = eq.action.elapsedSeconds;
    const kindBefore = eq.action.kind;
    const targetBefore = eq.action.targetId;
    const durationBefore = eq.action.durationSeconds;
    const emptyBefore = eq.action.empty;
    const pitchBefore = eq.recoilPitchRad;
    const done = eq.tick(dt, intent.triggers);
    this.player.pitchRad -= pitchBefore - eq.recoilPitchRad; // recoil recovery pulls the aim back down
    const after = done === kindBefore ? Number.POSITIVE_INFINITY : eq.action.elapsedSeconds;
    this.midAction(kindBefore, targetBefore, durationBefore, emptyBefore, before, after);
    if (done) this.complete(done, targetBefore);
    if (eq.action.kind === 'examine') {
      const target = this.byId(eq.action.targetId);
      if (!target || distance(target.pos, this.player.pos) > 3.2) eq.finish();
    }

    // 6. Threats.
    this.stepThreats(dt);

    // 7. Bodies and bullets.
    this.rested.length = 0;
    this.bodies.step(dt, this.world.cans, this.rested);
    for (const r of this.rested) {
      if (r.body.kind === 'log') {
        this.logLanded(r.body.pos, r.body.rot.y);
        continue;
      }
      const depth = -heightAt(r.body.pos.x, r.body.pos.z);
      if (r.underwater && depth > LAGOON_PLAYER.maxWadeDepthM * 0.7) continue; // lost to the lagoon floor
      this.addInteractable({ kind: 'pickup', model: 'stone', item: 'stone', count: 1, pos: { x: r.body.pos.x, y: r.body.pos.y - STONE.radiusM, z: r.body.pos.z }, yawRad: r.body.rot.y, radiusM: 0.2, name: 'Stone' });
    }
    this.bullets.step(dt, this.world.cans, this.targets());

    // 8. Wounds.
    this.heal(dt);
    if (this.downS > 0) {
      this.downS -= dt;
      if (this.downS <= 0) this.wake();
    }
    this.timeSeconds += dt;
  }

  private byId(id: number): Interactable | undefined {
    return this.world.interactables.find((i) => i.id === id && i.alive);
  }

  private addInteractable(partial: Omit<Interactable, 'id' | 'alive' | 'open' | 'seed' | 'text'>): void {
    this.world.interactables.push({ ...partial, id: this.nextInteractableId++, alive: true, open: 0, seed: this.rng.int(0, 1e6), text: '' });
    this.interactablesVersion++;
  }

  private findFocus(): Interactable | null {
    let best: Interactable | null = null;
    let bestT = Number.POSITIVE_INFINITY;
    const e = this.eye;
    const f = this.fwd;
    for (const it of this.world.interactables) {
      if (!it.alive || (it.kind === 'crate' && it.open >= 1)) continue;
      const cy = it.pos.y + Math.min(0.25, it.radiusM * 0.5);
      const vx = it.pos.x - e.x;
      const vy = cy - e.y;
      const vz = it.pos.z - e.z;
      const t = vx * f.x + vy * f.y + vz * f.z;
      if (t < 0.2 || t > LAGOON_PLAYER.interactRangeM + it.radiusM) continue;
      const px = vx - f.x * t;
      const py = vy - f.y * t;
      const pz = vz - f.z * t;
      if (Math.hypot(px, py, pz) > it.radiusM + 0.04) continue;
      if (t >= bestT) continue;
      if (this.world.collision.raycast(e, f, t, this.hit, false) && this.hit.distanceM < t - it.radiusM - 0.6) continue;
      best = it;
      bestT = t;
    }
    return best;
  }

  private interact(): void {
    const eq = this.equipment;
    if (this.player.inBoat) {
      this.leaveBoat();
      return;
    }
    if (this.player.inJeep) {
      this.leaveJeep();
      return;
    }
    if (eq.action.kind === 'examine') {
      eq.finish();
      return;
    }
    const it = this.focus;
    if (!it || !eq.canInteract()) return;
    if (it.kind === 'sleep') {
      if (this.player.swimming) return;
      const until = sleepUntil(this.env.timeId);
      eq.start('sleep', INTERACT.sleepSeconds, it.id);
      this.events.push({ type: 'sleep', until });
      return;
    }
    if (it.kind === 'fire') {
      this.tendFire();
      return;
    }
    if (it.kind === 'boat') {
      this.board();
      return;
    }
    if (it.kind === 'jeep') {
      this.useJeep(it.model);
      return;
    }
    if (it.kind === 'examine') {
      eq.start('examine', Number.POSITIVE_INFINITY, it.id);
      this.events.push({ type: 'examine', id: it.id, title: it.name, text: it.text });
      return;
    }
    const kind = it.kind === 'pickup' ? 'pickup' : it.kind === 'harvest' ? 'harvest' : 'openCrate';
    const dur = kind === 'pickup' ? INTERACT.pickupSeconds : kind === 'harvest' ? INTERACT.harvestSeconds : INTERACT.crateOpenSeconds;
    eq.start(kind, dur, it.id);
    this.events.push({ type: 'actionStart', kind });
  }

  private select(slot: EquipSlot): void {
    const eq = this.equipment;
    if (HANDS_ACTIONS.includes(eq.action.kind) || eq.action.kind === 'windup' || eq.action.kind === 'throw') return;
    if ((this.player.swimming || this.player.inJeep) && slot !== 'hands') {
      this.events.push({ type: 'message', text: this.player.inJeep ? 'Not while driving' : 'Not while swimming' });
      return;
    }
    const inv = this.inventory;
    const missing = slot === 'rifle' ? !inv.has('rifle') : slot === 'knife' ? !inv.has('knife') : slot === 'stone' ? !inv.has('stone') : slot === 'log' ? !inv.has('log') : false;
    if (missing) {
      const text =
        slot === 'rifle' ? 'No rifle — there is one in the shelter' : slot === 'knife' ? 'No knife — check the shelter table' : slot === 'log' ? 'No firewood — the stack is beside the shelter' : 'No stones — pick one up on the beach';
      this.events.push({ type: 'message', text });
      return;
    }
    if (eq.action.kind === 'examine') eq.finish();
    eq.switchTo(slot);
    this.events.push({ type: 'equip', slot: eq.action.kind === 'lower' ? slot : eq.slot });
  }

  private useTool(t: Triggers): void {
    const eq = this.equipment;
    const idle = eq.action.kind === 'idle';
    if (eq.slot === 'rifle') {
      const reserve = this.inventory.count('ammo762');
      if (t.reloadPressed && idle && eq.magazineRounds < RIFLE.magazineRounds && reserve > 0) this.startReload();
      else if (t.fireHeld && idle && eq.cooldownSeconds <= 0) {
        if (eq.magazineRounds > 0) this.fireRifle();
        else if (t.firePressed) {
          this.events.push({ type: 'dryFire' });
          if (reserve > 0) this.startReload();
        }
      }
    } else if (eq.slot === 'knife') {
      if ((t.firePressed || t.fireHeld) && idle) {
        eq.start('swing', KNIFE.swingSeconds);
        this.events.push({ type: 'knifeSwing', side: eq.action.side });
      }
    } else if (eq.slot === 'stone' || eq.slot === 'log') {
      if (t.firePressed && idle && this.inventory.has(eq.slot)) {
        eq.start('windup', Number.POSITIVE_INFINITY);
        eq.charge = 0;
        this.events.push({ type: 'stoneWindup' });
      } else if (!t.fireHeld && eq.action.kind === 'windup') {
        eq.start('throw', STONE.releaseSeconds + STONE.recoverSeconds);
      }
    }
  }

  private startReload(): void {
    const eq = this.equipment;
    const empty = eq.magazineRounds === 0;
    eq.start('reload', empty ? RIFLE.reloadEmptySeconds : RIFLE.reloadSeconds);
    eq.action.empty = empty;
    this.events.push({ type: 'reloadStart', empty });
  }

  private fireRifle(): void {
    const eq = this.equipment;
    const p = this.player;
    eq.magazineRounds--;
    eq.shotsFired++;
    eq.cooldownSeconds = 60 / RIFLE.roundsPerMinute;
    const spread = RIFLE.hipSpreadRad + (RIFLE.adsSpreadRad - RIFLE.hipSpreadRad) * eq.adsBlend + Math.min(0.02, p.speedMs * 0.004);
    const dir = { ...this.fwd };
    const a = this.rng.range(0, Math.PI * 2);
    const r = spread * Math.sqrt(this.rng.next());
    const right = { x: Math.cos(p.yawRad), y: 0, z: -Math.sin(p.yawRad) };
    const up = cross(right, dir);
    dir.x += (right.x * Math.cos(a) + up.x * Math.sin(a)) * r;
    dir.y += (right.y * Math.cos(a) + up.y * Math.sin(a)) * r;
    dir.z += (right.z * Math.cos(a) + up.z * Math.sin(a)) * r;
    normalize(dir);
    this.bullets.fire(this.eye, dir);
    this.events.push({ type: 'shot', origin: { ...this.eye }, dir });
    this.noise = { pos: { ...this.eye }, radiusM: SHOT_HEARD_M };
    // Aim kick moves the view; the viewmodel gets its own visual kick.
    const kick = RIFLE.recoilPitchRad * (1 - eq.adsBlend * 0.35);
    p.pitchRad += kick;
    eq.recoilPitchRad += kick;
    p.yawRad += this.rng.gauss() * RIFLE.recoilYawRad;
    eq.kickM = Math.min(0.06, eq.kickM + 0.035);
    const port = { x: this.eye.x + right.x * 0.12 + this.fwd.x * 0.35, y: this.eye.y - 0.12, z: this.eye.z + right.z * 0.12 + this.fwd.z * 0.35 };
    const s = RIFLE.shellEjectSpeedMs * this.rng.range(0.8, 1.15);
    this.bodies.ejectShell(port, { x: right.x * s + p.vel.x - this.fwd.x * 0.4, y: 1.8 + this.rng.range(0, 0.8), z: right.z * s + p.vel.z - this.fwd.z * 0.4 });
    this.events.push({ type: 'shellEject' });
  }

  /** Moments inside an action, fired once as the timeline crosses them. */
  private midAction(kind: ActionKind, targetId: number, durationSeconds: number, empty: boolean, before: number, after: number): void {
    const crossed = (at: number): boolean => before < at && after >= at;
    const target = this.byId(targetId);
    if (kind === 'pickup' && crossed(INTERACT.pickupSeconds * 0.55) && target) this.take(target);
    else if (kind === 'harvest' && crossed(INTERACT.harvestSeconds * 0.62) && target) this.take(target);
    else if (kind === 'openCrate' && target) target.open = Math.min(0.999, smooth(Math.min(after, INTERACT.crateOpenSeconds) / INTERACT.crateOpenSeconds)); // 1 only once opened
    else if (kind === 'sleep' && crossed(durationSeconds * 0.5)) {
      // Under the fade: the hours pass at once, weather and all.
      const until = sleepUntil(this.env.timeId);
      this.env.setTime(until, true);
      this.events.push({ type: 'message', text: `You slept until ${TIME_OF_DAY[until].label.toLowerCase()}` });
    } else if (kind === 'throw' && crossed(STONE.releaseSeconds)) this.release();
    else if (kind === 'swing' && crossed(KNIFE.swingSeconds * KNIFE.hitAtFraction)) this.knifeHit();
    else if (kind === 'reload') {
      const d = durationSeconds;
      if (crossed(d * 0.22)) this.events.push({ type: 'reloadStage', stage: 'magOut' });
      if (crossed(d * 0.58)) this.events.push({ type: 'reloadStage', stage: 'magIn' });
      if (empty && crossed(d * 0.84)) this.events.push({ type: 'reloadStage', stage: 'charge' });
    }
  }

  private complete(kind: ActionKind, targetId: number): void {
    const eq = this.equipment;
    if (kind === 'reload') {
      const need = RIFLE.magazineRounds - eq.magazineRounds;
      eq.magazineRounds += this.inventory.remove('ammo762', need);
    } else if (kind === 'openCrate') {
      const crate = this.byId(targetId);
      if (crate && crate.kind === 'crate' && crate.open < 1) {
        crate.open = 1;
        for (const c of crateContents(crate)) this.addInteractable(c);
        this.events.push({ type: 'crateOpened', id: crate.id });
      }
    } else if (kind === 'throw' && (eq.slot === 'stone' || eq.slot === 'log') && !this.inventory.has(eq.slot)) {
      eq.switchTo('hands');
    }
  }

  private take(it: Interactable): void {
    if (!it.item) return;
    // The woodpile gives a log each time and stays.
    if (it.model !== 'woodpile') {
      it.alive = false;
      this.interactablesVersion++;
      this.events.push({ type: 'interactableRemoved', id: it.id });
    }
    const count = it.item === 'rifle' ? 1 : it.count;
    this.inventory.add(it.item, count);
    this.events.push({ type: 'itemGained', itemId: it.item, count, name: ITEMS[it.item].name });
    if (it.item === 'backpack') {
      // Its contents come with it.
      for (const id of ['lighter', 'fishhooks'] as const) {
        this.inventory.add(id, 1);
        this.events.push({ type: 'itemGained', itemId: id, count: 1, name: ITEMS[id].name });
      }
    }
    if (it.item === 'lamp') this.setLamp(true);
    if (it.item === 'rifle') {
      // The rifle comes with a spare magazine's worth of loose rounds.
      this.inventory.add('ammo762', RIFLE.startReserveRounds);
      this.events.push({ type: 'itemGained', itemId: 'ammo762', count: RIFLE.startReserveRounds, name: ITEMS.ammo762.name });
    }
    const eq = this.equipment;
    const tool = it.item === 'rifle' ? 'rifle' : it.item === 'knife' ? 'knife' : it.item === 'stone' && (eq.slot === 'hands' || eq.slot === 'stone') ? 'stone' : null;
    if (tool && eq.slot !== tool) {
      eq.finish();
      eq.switchTo(tool);
      this.events.push({ type: 'equip', slot: tool });
    }
  }

  private setLamp(lit: boolean): void {
    if (lit === this.lampLit) return;
    this.lampLit = lit;
    this.events.push({ type: 'lamp', lit });
  }

  private board(): void {
    const p = this.player;
    p.inBoat = true;
    p.swimming = false;
    p.underwater = false;
    p.gasping = false;
    p.grounded = true;
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    this.ride();
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    this.events.push({ type: 'boat', what: 'board' });
  }

  /** Seated at the tiller: the player moves and turns with the hull. */
  private ride(): void {
    const p = this.player;
    const b = this.boat;
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    const seat = BOAT.seat;
    b.toWorld(seat.along, seat.up, seat.across, p.pos);
    p.pos.y += BOAT.seatedEyeM - LAGOON_PLAYER.eyeHeightM;
    p.yawRad += b.yawRad - b.prevYawRad;
    p.vel.x = b.vel.x;
    p.vel.y = b.vel.y;
    p.vel.z = b.vel.z;
    p.surface = 'wood';
    p.wadingDepthM = 0;
    p.sprinting = false;
  }

  /** Step out over the side onto the dock or the shore if there is one, into the water if not. */
  private leaveBoat(): void {
    const p = this.player;
    const b = this.boat;
    const out = { x: 0, y: 0, z: 0 };
    let best: { x: number; y: number; z: number } | null = null;
    // The higher side wins: the dock over wading water, wading water over swimming.
    for (const across of [BOAT.beamM * 0.5 + 0.7, -(BOAT.beamM * 0.5 + 0.7)]) {
      b.toWorld(-0.3, 0, across, out);
      const ground = this.world.collision.groundAt(out.x, out.z, WATER_LEVEL_M + 1, 1.2);
      if (ground > WATER_LEVEL_M - LAGOON_PLAYER.swimDepthM + 0.1 && (!best || ground > best.y)) best = { x: out.x, y: ground, z: out.z };
    }
    p.inBoat = false;
    p.vel.x = p.vel.y = p.vel.z = 0;
    if (best) {
      p.pos.x = best.x;
      p.pos.y = best.y;
      p.pos.z = best.z;
      p.grounded = true;
    } else {
      // Over the side into deep water: swimming right away.
      b.toWorld(-0.3, 0, BOAT.beamM * 0.5 + 0.7, out);
      const depth = WATER_LEVEL_M - heightAt(out.x, out.z);
      const surf = waterSurfaceY(out.x, out.z, this.timeSeconds, waveScale(this.env.weather.rainRate, this.env.weather.windMs), depth);
      p.pos.x = out.x;
      p.pos.z = out.z;
      p.pos.y = Math.max(heightAt(out.x, out.z), surf - LAGOON_PLAYER.eyeHeightM + LAGOON_PLAYER.floatEyeAboveWaterM);
      p.swimming = depth > LAGOON_PLAYER.swimDepthM;
      p.grounded = !p.swimming;
    }
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    this.events.push({ type: 'boat', what: 'leave' });
  }

  /** Door and bonnet handles follow the jeep: the driver's door on the left, the bonnet at the nose. */
  private placeJeepSpots(): void {
    const j = this.jeep;
    const [driver, passenger, bonnet] = this.jeepSpots;
    if (driver) j.toWorld(-0.1, 0.35, -JEEP.widthM / 2 - 0.1, driver.pos);
    if (passenger) j.toWorld(-0.1, 0.35, JEEP.widthM / 2 + 0.1, passenger.pos);
    if (bonnet) j.toWorld(JEEP.lengthM / 2 - 0.25, 0.45, 0, bonnet.pos);
  }

  private useJeep(model: string): void {
    const j = this.jeep;
    if (model === 'jeepBonnet') {
      j.bonnetTarget = j.bonnetTarget > 0.5 ? 0 : 1;
      this.events.push({ type: 'jeep', what: 'bonnet' });
      return;
    }
    if (model === 'jeepPassenger') {
      j.doorTarget.passenger = j.doorTarget.passenger > 0.5 ? 0 : 1;
      this.events.push({ type: 'jeep', what: 'door' });
      return;
    }
    // In behind the wheel: the door opens, the tool goes away, the door swings shut.
    const p = this.player;
    const eq = this.equipment;
    if (eq.slot !== 'hands') {
      eq.finish();
      eq.switchTo('hands');
      this.events.push({ type: 'equip', slot: 'hands' });
    }
    p.inJeep = true;
    p.swimming = false;
    p.grounded = true;
    // Nobody drives off with the bonnet up: it is shut on the way round to the door.
    if (j.bonnetTarget > 0) {
      j.bonnetTarget = 0;
      this.events.push({ type: 'jeep', what: 'bonnet' });
    }
    j.doorTarget.driver = 1;
    this.jeepDoorTimerS = 1.2;
    this.driveSeat();
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    this.events.push({ type: 'jeep', what: 'enter' });
  }

  /** Behind the wheel: the player moves and turns with the jeep. */
  private driveSeat(): void {
    const p = this.player;
    const j = this.jeep;
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    const seat = JEEP.seat;
    j.toWorld(seat.along, seat.up, seat.across, p.pos);
    p.pos.y += JEEP.seatedEyeM - LAGOON_PLAYER.eyeHeightM;
    p.yawRad += j.yawRad - j.prevYawRad;
    const { fx, fz } = j.axes();
    p.vel.x = fx * j.speedMs;
    p.vel.y = 0;
    p.vel.z = fz * j.speedMs;
    p.surface = 'metal';
    p.wadingDepthM = 0;
    p.sprinting = false;
  }

  /** Out of the driver's door onto the ground beside it. */
  private leaveJeep(): void {
    const p = this.player;
    const j = this.jeep;
    const out = j.toWorld(-0.2, 0, -JEEP.widthM / 2 - 0.55, { x: 0, y: 0, z: 0 });
    p.inJeep = false;
    p.pos.x = out.x;
    p.pos.z = out.z;
    p.pos.y = this.world.collision.groundAt(out.x, out.z, j.pos.y + 0.5, 1.5);
    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.grounded = true;
    j.doorTarget.driver = 1;
    this.jeepDoorTimerS = 1.2;
    this.events.push({ type: 'jeep', what: 'exit' });
  }

  /** E at the pit: put a log on, or light the wood that is there. */
  private tendFire(): void {
    const f = this.fire;
    const inv = this.inventory;
    if (!f.lit && f.fuelS > 0) {
      if (!inv.has('lighter')) this.events.push({ type: 'message', text: 'The wood is laid — you need a lighter (the backpack in the shelter)' });
      else f.light(this.events);
      return;
    }
    if (!inv.has('log')) {
      this.events.push({ type: 'message', text: 'No firewood — the stack is beside the shelter' });
      return;
    }
    if (f.addLog(this.events)) inv.remove('log', 1);
    else this.events.push({ type: 'message', text: 'The fire has all the wood it can take' });
  }

  /** A thrown log at rest: on the fire if it landed in the pit, otherwise a pick-up where it lies. */
  private logLanded(pos: P3, yawRad: number): void {
    const pit = this.firePitPos;
    const d = Math.hypot(pos.x - pit.x, pos.z - pit.z);
    if (d < FURNITURE.firePit.radiusM + FIRE.catchM && pos.y < pit.y + 0.8 && this.fire.addLog(this.events)) return;
    this.addInteractable({ kind: 'pickup', model: 'log', item: 'log', count: 1, pos: { x: pos.x, y: pos.y - LOG.radiusM, z: pos.z }, yawRad, radiusM: 0.3, name: 'Firewood' });
  }

  /** Throws what is in hand: a stone overarm, a log in an underhand lob. */
  private release(): void {
    const eq = this.equipment;
    const kind = eq.slot === 'log' ? 'log' : 'stone';
    if (this.inventory.remove(kind, 1) === 0) return;
    const p = this.player;
    const spec = kind === 'log' ? LOG : STONE;
    const speed = spec.minThrowSpeedMs + (spec.maxThrowSpeedMs - spec.minThrowSpeedMs) * eq.charge;
    // Released a little above the line of sight, as an overarm throw does.
    const dir = { ...this.fwd };
    dir.y += 0.07;
    normalize(dir);
    const right = { x: Math.cos(p.yawRad), z: -Math.sin(p.yawRad) };
    const from = { x: this.eye.x + right.x * 0.18 + dir.x * 0.3, y: this.eye.y + 0.02, z: this.eye.z + right.z * 0.18 + dir.z * 0.3 };
    const vel = { x: dir.x * speed + p.vel.x, y: dir.y * speed + p.vel.y, z: dir.z * speed + p.vel.z };
    if (kind === 'log') this.bodies.throwLog(from, vel);
    else this.bodies.throwStone(from, vel);
    this.events.push({ type: 'stoneThrown', pos: from, speedMs: speed });
  }

  private knifeHit(): void {
    const reach = KNIFE.reachM;
    // A creature or a man within reach: the blade goes in.
    const th = rayTargets(this.eye, this.fwd, reach + 0.3, this.targets());
    if (th) {
      const killed = th.target.hurt(WEAPON_DAMAGE.knife, th.part, this.fwd, true);
      this.events.push({ type: 'threatHit', pos: { x: th.x, y: th.y, z: th.z }, dir: { ...this.fwd }, kind: th.target.kind, part: th.part, killed });
      return;
    }
    const f = this.focus;
    if (f && f.kind === 'harvest' && distance(f.pos, this.eye) < reach + 0.6) {
      this.take(f); // a clean cut: the knife harvests without kneeling
      return;
    }
    for (const c of this.world.cans) {
      if (distance(c.pos, this.eye) > reach) continue;
      const vx = c.pos.x - this.eye.x;
      const vy = c.pos.y - this.eye.y;
      const vz = c.pos.z - this.eye.z;
      const t = vx * this.fwd.x + vy * this.fwd.y + vz * this.fwd.z;
      if (t > 0 && Math.hypot(vx - this.fwd.x * t, vy - this.fwd.y * t, vz - this.fwd.z * t) < 0.25) {
        knockCan(c, this.fwd, 0.4);
        this.events.push({ type: 'canHit', id: c.id });
        return;
      }
    }
    if (this.world.collision.raycast(this.eye, this.fwd, reach, this.hit, true)) {
      const h = this.hit;
      this.events.push({ type: 'knifeHit', pos: { x: h.x, y: h.y, z: h.z }, normal: { x: h.nx, y: h.ny, z: h.nz }, surface: h.surface });
    }
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function distance(a: P3, b: P3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cross(a: P3, b: P3): P3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v: P3): void {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  v.x /= l;
  v.y /= l;
  v.z /= l;
}
