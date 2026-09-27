import { Rng } from '../core/rng.ts';
import { INTERACT, KNIFE, LAGOON_PLAYER, RIFLE, STONE, type TimeOfDayId, type WeatherId } from '../config.ts';
import { Bodies, type BodyRest, knockCan } from './bodies.ts';
import { Bullets } from './bullets.ts';
import { newHit, type RayHit } from './colliders.ts';
import { Environment } from './environment.ts';
import { type ActionKind, Equipment, type Triggers } from './equipment.ts';
import { type EquipSlot, EventQueue, type P3 } from './events.ts';
import { Inventory } from './inventory.ts';
import { ITEMS } from './items.ts';
import { type MoveIntent, Player } from './player.ts';
import { heightAt } from './terrain.ts';
import { buildWorld, crateContents, type Interactable, type LagoonWorld } from './world.ts';

// The lagoon's game logic, headless (rules §10: no THREE here). One fixed
// update order, written down in `step`:
//   1. environment (clock, weather, wetness, lightning)
//   2. look, then walk
//   3. what the eye is on (interaction focus)
//   4. interaction and tool input → actions
//   5. action timeline: mid-action moments (release, hit, pick-up) and completions
//   6. free bodies (stones, shells, cans), then bullets

export interface LagoonIntent {
  move: Omit<MoveIntent, 'slowed'>;
  lookYawRad: number;
  lookPitchRad: number;
  triggers: Triggers;
  interactPressed: boolean;
  cycleTime: boolean;
  cycleWeather: boolean;
  setTime: TimeOfDayId | null;
  setWeather: WeatherId | null;
}

export function emptyIntent(): LagoonIntent {
  return {
    move: { moveRight: 0, moveForward: 0, sprint: false, jump: false },
    lookYawRad: 0,
    lookPitchRad: 0,
    triggers: { firePressed: false, fireHeld: false, fireReleased: false, aimHeld: false, reloadPressed: false, selectSlot: null },
    interactPressed: false,
    cycleTime: false,
    cycleWeather: false,
    setTime: null,
    setWeather: null,
  };
}

const HANDS_ACTIONS: readonly ActionKind[] = ['pickup', 'harvest', 'openCrate'];

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
  /** Interactable under the crosshair, or null. */
  focus: Interactable | null = null;
  /** Bumped whenever interactables are added or removed, so render can re-sync. */
  interactablesVersion = 0;
  private nextInteractableId = 10000;
  private readonly hit: RayHit = newHit();
  private readonly eye: P3 = { x: 0, y: 0, z: 0 };
  private readonly fwd: P3 = { x: 0, y: 0, z: 0 };
  private readonly rested: BodyRest[] = [];

  constructor(seed: number, time: TimeOfDayId, weather: WeatherId) {
    this.rng = new Rng(seed);
    this.world = buildWorld(seed);
    this.player = new Player(this.world.spawn.pos, this.world.spawn.yawRad);
    this.env = new Environment(time, weather);
    this.bodies = new Bodies(this.world.collision, this.events);
    this.bullets = new Bullets(this.world.collision, this.events);
  }

  get interactables(): readonly Interactable[] {
    return this.world.interactables;
  }

  step(intent: LagoonIntent, dt: number): void {
    // 1. Environment.
    if (intent.setTime) this.env.setTime(intent.setTime);
    else if (intent.cycleTime) this.env.cycleTime();
    if (intent.setWeather) this.env.setWeather(intent.setWeather);
    else if (intent.cycleWeather) this.env.cycleWeather();
    this.env.step(dt, this.rng, this.events);

    // 2. Look and walk.
    const eq = this.equipment;
    this.player.look(intent.lookYawRad, intent.lookPitchRad);
    const slowed = eq.adsBlend > 0.5 || HANDS_ACTIONS.includes(eq.action.kind) || eq.action.kind === 'windup';
    this.player.step({ ...intent.move, slowed }, dt, this.world.collision, this.events);
    this.player.eye(this.eye);
    this.player.forward(this.fwd);

    // 3. Focus.
    this.focus = this.findFocus();

    // 4. Interaction and tools.
    if (intent.interactPressed) this.interact();
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

    // 6. Bodies and bullets.
    this.rested.length = 0;
    this.bodies.step(dt, this.world.cans, this.rested);
    for (const r of this.rested) {
      const depth = -heightAt(r.body.pos.x, r.body.pos.z);
      if (r.underwater && depth > LAGOON_PLAYER.maxWadeDepthM * 0.7) continue; // lost to the lagoon floor
      this.addInteractable({ kind: 'pickup', model: 'stone', item: 'stone', count: 1, pos: { x: r.body.pos.x, y: r.body.pos.y - STONE.radiusM, z: r.body.pos.z }, yawRad: r.body.rot.y, radiusM: 0.2, name: 'Stone' });
    }
    this.bullets.step(dt, this.world.cans);
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
    if (eq.action.kind === 'examine') {
      eq.finish();
      return;
    }
    const it = this.focus;
    if (!it || !eq.canInteract()) return;
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
    const inv = this.inventory;
    const missing = slot === 'rifle' ? !inv.has('rifle') : slot === 'knife' ? !inv.has('knife') : slot === 'stone' ? !inv.has('stone') : false;
    if (missing) {
      const text = slot === 'rifle' ? 'No rifle — there is one in the shelter' : slot === 'knife' ? 'No knife — check the shelter table' : 'No stones — pick one up on the beach';
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
    } else if (eq.slot === 'stone') {
      if (t.firePressed && idle && this.inventory.has('stone')) {
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
    else if (kind === 'throw' && crossed(STONE.releaseSeconds)) this.releaseStone();
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
    } else if (kind === 'throw' && !this.inventory.has('stone')) {
      eq.switchTo('hands');
    }
  }

  private take(it: Interactable): void {
    if (!it.item) return;
    it.alive = false;
    this.interactablesVersion++;
    this.events.push({ type: 'interactableRemoved', id: it.id });
    const count = it.item === 'rifle' ? 1 : it.count;
    this.inventory.add(it.item, count);
    this.events.push({ type: 'itemGained', itemId: it.item, count, name: ITEMS[it.item].name });
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

  private releaseStone(): void {
    const eq = this.equipment;
    if (this.inventory.remove('stone', 1) === 0) return;
    const p = this.player;
    const speed = STONE.minThrowSpeedMs + (STONE.maxThrowSpeedMs - STONE.minThrowSpeedMs) * eq.charge;
    // Released a little above the line of sight, as an overarm throw does.
    const dir = { ...this.fwd };
    dir.y += 0.07;
    normalize(dir);
    const right = { x: Math.cos(p.yawRad), z: -Math.sin(p.yawRad) };
    const from = { x: this.eye.x + right.x * 0.18 + dir.x * 0.3, y: this.eye.y + 0.02, z: this.eye.z + right.z * 0.18 + dir.z * 0.3 };
    this.bodies.throwStone(from, { x: dir.x * speed + p.vel.x, y: dir.y * speed + p.vel.y, z: dir.z * speed + p.vel.z });
    this.events.push({ type: 'stoneThrown', pos: from, speedMs: speed });
  }

  private knifeHit(): void {
    const reach = KNIFE.reachM;
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
