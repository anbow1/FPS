import { GRENADES, type GrenadeKind, WEAPONS, WORLD_WIND } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { directionFromYawPitch, Vec3 } from '../core/vec.ts';
import type { MapData } from '../maps/types.ts';
import type { BodyPart } from './actor.ts';
import { CollisionWorld } from './collision.ts';
import { EventQueue } from './events.ts';
import { type ExplosionTarget, Grenades } from './grenades.ts';
import { Items } from './items.ts';
import { Mode, type ModeId } from './modes.ts';
import { NavGrid } from './nav.ts';
import { Player, type PlayerIntent } from './player.ts';
import { Projectiles, type ShootableActor } from './projectiles.ts';
import { type AiContext, Soldier } from './soldier.ts';
import { Squad } from './squad.ts';
import { type WeaponIntent, WeaponSystem } from './weapons.ts';

// The whole simulation. One fixed update order, written down here (rules §10):
//
//   1. player movement and stance        5. AI squads (perception, brains, bodies)
//   2. items in use and pickups          6. bullets (ray-cast, penetration, hits)
//   3. weapons (fire spawns bullets)     7. grenades and smoke
//   4. grenade cook / throw              8. game mode (objectives, waves)
//
// Nothing in here imports THREE. The render layer reads this state.

export interface GameIntent {
  player: PlayerIntent;
  weapon: WeaponIntent;
  lookYawRad: number; // mouse delta this step
  lookPitchRad: number;
  grenadeHeld: boolean;
  grenadePressed: boolean;
  grenadeReleased: boolean;
  grenadeCyclePressed: boolean;
  medKitPressed: boolean;
  ammoPackPressed: boolean;
  rangeFinderPressed: boolean;
}

const RANGE_FINDER_MAX_M = 1500;

export class Game {
  readonly events = new EventQueue();
  readonly rng: Rng;
  readonly world: CollisionWorld;
  readonly nav: NavGrid;
  readonly player: Player;
  readonly weapons: WeaponSystem;
  readonly projectiles = new Projectiles();
  readonly grenades = new Grenades();
  readonly items = new Items();
  readonly squads: Squad[] = [];
  readonly soldiers: Soldier[] = [];
  readonly mode: Mode;
  readonly wind = new Vec3();
  timeSeconds = 0;
  flashAmount = 0; // white-out on screen, 0..1, decays
  rangeFinderM: number | null = null;
  rangeFinderAgeSeconds = 99;
  kills = 0;
  private nextActorId = 1;
  private readonly shootables: ShootableActor[] = [];
  private readonly blastTargets: ExplosionTarget[] = [];
  private readonly playerActor: ShootableActor & ExplosionTarget;
  private readonly aiContext: AiContext;
  private lastShotCounter = 0;
  private readonly rangeTargetBoxIds = new Map<number, number>();

  constructor(
    readonly map: MapData,
    modeId: ModeId,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.world = new CollisionWorld(map.terrain);
    for (const box of map.boxes) {
      const collider = this.world.addBox(box);
      if (box.look === 'targetSteel') {
        const t = map.rangeTargets.find((rt) => rt.pos.distanceTo(box.center) < rt.sizeM);
        if (t) this.rangeTargetBoxIds.set(collider.id, t.distanceM);
      }
    }
    this.nav = new NavGrid(this.world, map.halfSizeM, map.halfSizeM > 300 ? 2 : 1);
    const spawn = map.playerSpawn.pos.clone();
    spawn.y = Math.max(spawn.y, this.world.terrainHeight(spawn.x, spawn.z));
    this.player = new Player(spawn, map.playerSpawn.yawRad);
    this.weapons = new WeaponSystem(this.rng);
    const w = WORLD_WIND[map.id];
    this.wind.set(Math.sin(w.directionRad) * w.speedMs, 0, Math.cos(w.directionRad) * w.speedMs);
    this.projectiles.wind.copy(this.wind);
    this.projectiles.onBoxImpact = (boxId, _pos, byPlayer) => {
      const d = this.rangeTargetBoxIds.get(boxId);
      if (d !== undefined && byPlayer) this.mode.registerRangeHit(d);
    };
    for (const p of map.pickups) this.items.addPickup(p.kind, p.pos, false);

    this.playerActor = this.makePlayerActor();
    this.aiContext = {
      world: this.world,
      nav: this.nav,
      player: this.player,
      projectiles: this.projectiles,
      grenades: this.grenades,
      events: this.events,
      rng: this.rng,
      timeSeconds: 0,
      squadmates: (s) => this.squads.find((q) => q.members.includes(s))?.members ?? [],
    };
    this.mode = new Mode(modeId, map);
    const count = this.mode.initialSquadCount();
    for (let i = 0; i < count; i++) {
      const sp = map.squadSpawns[i];
      if (sp) this.spawnSquad(sp.pos, sp.patrol);
    }
    if (modeId === 'range') this.spawnDummies();
    this.rebuildTargetLists();
  }

  get enemiesAlive(): number {
    let n = 0;
    for (const s of this.soldiers) if (s.alive && s.state !== 'dormant') n++;
    return n;
  }

  spawnSquad(pos: Vec3, patrol: Vec3[]): Squad {
    const squad = new Squad(this.squads.length, patrol);
    for (let i = 0; i < 4; i++) {
      const offset = new Vec3((i % 2) * 2 - 1, 0, Math.floor(i / 2) * 2 - 1);
      const p = pos.clone().add(offset);
      const walk = this.nav.nearestWalkable(p.x, p.z, new Vec3());
      if (walk) p.set(walk.x, 0, walk.z);
      p.y = this.world.terrainHeight(p.x, p.z) + 0.05;
      const soldier = new Soldier(this.nextActorId++, Squad.roleFor(i), p, this.rng.range(-Math.PI, Math.PI));
      squad.members.push(soldier);
      this.soldiers.push(soldier);
    }
    this.squads.push(squad);
    this.rebuildTargetLists();
    return squad;
  }

  private spawnDummies(): void {
    const squad = new Squad(this.squads.length, []);
    for (const [i, x] of [-3, 3].entries()) {
      const p = new Vec3(x, 0, -25);
      p.y = this.world.terrainHeight(p.x, p.z);
      const dummy = new Soldier(this.nextActorId++, 'rifleman', p, 0);
      dummy.state = 'dormant';
      dummy.invulnerable = true;
      dummy.stance = i === 0 ? 'stand' : 'crouch';
      squad.members.push(dummy);
      this.soldiers.push(dummy);
    }
    this.squads.push(squad);
  }

  private rebuildTargetLists(): void {
    this.shootables.length = 0;
    this.blastTargets.length = 0;
    this.shootables.push(this.playerActor);
    this.blastTargets.push(this.playerActor);
    for (const s of this.soldiers) {
      this.shootables.push(s);
      this.blastTargets.push(s);
    }
  }

  step(intent: GameIntent, dt: number): void {
    this.timeSeconds += dt;
    this.aiContext.timeSeconds = this.timeSeconds;
    this.nav.beginStep();
    const p = this.player;
    this.flashAmount = Math.max(0, this.flashAmount - dt / GRENADES.flashBlindSeconds);
    this.rangeFinderAgeSeconds += dt;

    // 1. Player
    if (p.alive) {
      p.yawRad -= intent.lookYawRad;
      p.pitchRad = Math.max(-1.45, Math.min(1.45, p.pitchRad - intent.lookPitchRad));
    }
    p.update(intent.player, this.world, dt, this.events);

    // 2. Items
    if (intent.medKitPressed) this.items.startMedKit(p, this.weapons, this.events);
    if (intent.ammoPackPressed) this.items.startAmmoPack(p, this.weapons, this.events);
    this.items.update(p, this.weapons, this.events, dt);

    // 3. Weapons
    this.weapons.update(intent.weapon, p, this.projectiles, this.events, dt);
    if (this.weapons.shotCounter !== this.lastShotCounter) {
      this.lastShotCounter = this.weapons.shotCounter;
      this.broadcastPlayerShot();
    }
    if (intent.rangeFinderPressed) this.measureRange();

    // 4. Grenades in hand
    this.updateGrenadeHand(intent, dt);

    // 5. AI
    for (const squad of this.squads) {
      squad.update(this.aiContext, dt);
      for (const m of squad.members) {
        const wasAlive = m.alive;
        m.update(this.aiContext, dt);
        if (wasAlive && !m.alive) this.onSoldierDeath(m);
      }
    }

    // 6. Bullets
    this.projectiles.update(this.world, this.shootables, this.events, dt);
    for (const s of this.soldiers) if (!s.alive && s.deathSeconds === 0) this.onSoldierDeath(s);

    // 7. Grenades and smoke
    this.grenades.update(this.world, this.blastTargets, this.events, dt);

    // 8. Mode
    const wave = this.mode.update({ playerPos: p.body.position, playerAlive: p.alive, enemiesAlive: this.enemiesAlive, dt });
    if (wave) this.spawnReinforcements();
  }

  private readonly deathHandled = new Set<number>();

  private onSoldierDeath(s: Soldier): void {
    if (this.deathHandled.has(s.id)) return;
    this.deathHandled.add(s.id);
    if (s.state !== 'dormant') this.kills++;
    this.items.dropFromSoldier(s.body.position, this.rng);
    for (const squad of this.squads) {
      if (!squad.members.includes(s)) continue;
      const mate = squad.members.find((m) => m.alive);
      if (mate) this.events.push({ type: 'callout', pos: mate.body.position.clone(), text: 'man down' });
    }
  }

  private broadcastPlayerShot(): void {
    const st = this.weapons.state;
    const radius = st.suppressed ? st.spec.suppressedHearingRadiusM : st.spec.hearingRadiusM;
    const pos = this.player.body.position;
    for (const squad of this.squads) {
      const heard = squad.members.some((m) => m.alive && m.body.position.distanceTo(pos) < radius);
      if (!heard) continue;
      const dist = squad.members[0]?.body.position.distanceTo(pos) ?? 0;
      // Hearing is vague: the error grows with distance.
      squad.alertAll(pos, 2 + dist * 0.12, this.aiContext);
    }
  }

  private measureRange(): void {
    const yaw = this.weapons.viewYaw(this.player);
    const pitch = this.weapons.viewPitch(this.player);
    this.player.eyePosition(_eye);
    directionFromYawPitch(yaw, pitch, _dir);
    let best = RANGE_FINDER_MAX_M;
    for (const h of this.world.raycastBoxes(_eye, _dir, RANGE_FINDER_MAX_M, [])) {
      if (h.box.blocksVision && h.entryM > 0.3) {
        best = Math.min(best, h.entryM);
        break;
      }
    }
    const t = this.world.raycastTerrain(_eye, _dir, best);
    if (t) best = Math.min(best, t.distanceM);
    for (const s of this.soldiers) {
      const r = s.hitboxes.raycast(_eye, _dir, best);
      if (r) best = Math.min(best, r.hit.entryM);
    }
    this.rangeFinderM = best >= RANGE_FINDER_MAX_M ? null : best;
    this.rangeFinderAgeSeconds = 0;
  }

  private updateGrenadeHand(intent: GameIntent, dt: number): void {
    const p = this.player;
    const g = this.grenades;
    if (intent.grenadeCyclePressed && !g.cooking) {
      const order: GrenadeKind[] = ['frag', 'smoke', 'flash'];
      for (let i = 1; i <= 3; i++) {
        const next = order[(order.indexOf(p.grenadeKind) + i) % 3] as GrenadeKind;
        if (p.grenades[next] > 0) {
          p.grenadeKind = next;
          break;
        }
      }
    }
    if (intent.grenadePressed && !g.cooking && p.alive && p.grenades[p.grenadeKind] > 0 && this.weapons.isReady() && !p.itemInUse) {
      g.startCook(p.grenadeKind);
      this.weapons.startBusy(60);
    }
    if (!g.cooking) return;
    g.cooking.fuseSeconds -= dt;
    this.throwOrigin(_eye);
    Grenades.throwVelocity(p.yawRad, p.pitchRad, GRENADES.throwSpeedMs, p.body.velocity, _vel);
    g.computePreview(this.world, _eye, _vel);
    const kind = g.cooking.kind;
    if (g.cooking.fuseSeconds <= 0) {
      // Cooked too long: it goes off in hand.
      p.grenades[kind]--;
      g.cooking = null;
      g.previewCount = 0;
      this.weapons.action.kind = 'idle';
      g.detonate(kind, _eye, this.world, this.blastTargets, this.events);
      return;
    }
    if (intent.grenadeReleased || !intent.grenadeHeld || !p.alive) {
      p.grenades[kind]--;
      g.throw(kind, _eye, _vel, g.cooking.fuseSeconds, true, this.events);
      g.cooking = null;
      g.previewCount = 0;
      this.weapons.action.kind = 'idle';
      this.weapons.startBusy(0.55);
      if (p.grenades[p.grenadeKind] <= 0) {
        const other = (['frag', 'smoke', 'flash'] as GrenadeKind[]).find((k) => p.grenades[k] > 0);
        if (other) p.grenadeKind = other;
      }
    }
  }

  private throwOrigin(out: Vec3): Vec3 {
    this.player.eyePosition(out);
    const s = Math.sin(this.player.yawRad);
    const c = Math.cos(this.player.yawRad);
    // Right hand, slightly above the eye at release.
    out.x += c * 0.25 - s * 0.3;
    out.z += -s * 0.25 - c * 0.3;
    out.y += 0.1;
    return out;
  }

  private spawnReinforcements(): void {
    const spawns = this.map.reinforcementSpawns;
    if (spawns.length === 0) return;
    const pos = spawns[this.mode.wavesRequested % spawns.length] as Vec3;
    const squad = this.spawnSquad(pos, [this.map.extraction.hold]);
    squad.alertAll(this.player.body.position, 10, this.aiContext);
  }

  private makePlayerActor(): ShootableActor & ExplosionTarget {
    const p = this.player;
    const game = this;
    return {
      id: p.id,
      get alive() {
        return p.alive;
      },
      isPlayer: true,
      hitboxes: p.hitboxes,
      receiveHit(damage: number, part: BodyPart, dir: Vec3, _byPlayer: boolean, events: EventQueue): boolean {
        _from.copy(dir).scale(-1);
        return p.takeHit(damage, part, _from, events);
      },
      nearMiss(pos: Vec3, _byPlayer: boolean, events: EventQueue): void {
        events.push({ type: 'crack', pos: pos.clone() });
      },
      headPosition(out: Vec3): Vec3 {
        return p.eyePosition(out);
      },
      chestPosition(out: Vec3): Vec3 {
        return out.copy(p.hitboxes.partCenter('chest'));
      },
      facing(out: Vec3): Vec3 {
        return directionFromYawPitch(game.weapons.viewYaw(p), game.weapons.viewPitch(p), out);
      },
      receiveBlast(damage: number, fromDir: Vec3, events: EventQueue): void {
        _from.copy(fromDir).scale(-1);
        p.takeHit(damage, 'abdomen', _from, events);
      },
      receiveFlash(amount: number, events: EventQueue): void {
        game.flashAmount = Math.max(game.flashAmount, Math.min(1, amount * 1.2));
        events.push({ type: 'flashed', amount });
      },
    };
  }

  /** Spec lookup for the HUD. */
  weaponName(): string {
    return WEAPONS[this.weapons.current].displayName;
  }
}

const _eye = new Vec3();
const _dir = new Vec3();
const _vel = new Vec3();
const _from = new Vec3();
