import { Vec3 } from '../core/vec.ts';
import { RUNWAY, THRESHOLD_36_Z } from '../render/airbase.ts';
import { Combat, type Combatant, createEvents, type CombatEvents, type Orders } from '../sim/combat.ts';
import { Opponent } from '../sim/opponent.ts';
import type { GroundHeight } from '../sim/radar.ts';
import type { GameOptions } from '../ui/menu.ts';

// The game modes (brief §Game modes) on top of the combat simulation:
//
//   free       one aircraft, one sky, no enemy;
//   duel       1 v 1 with the chosen aircraft on each side, head-on 40 km apart;
//              both respawn after a kill and the score keeps count;
//   intercept  two enemy fighters inbound to the base, little fuel: shoot both
//              down, then land on the runway to win;
//   landing    a straight-in approach from 10 km; the touchdown is scored on
//              sink rate, centreline and distance from the aiming point.

export class Game {
  readonly combat: Combat;
  readonly player: Combatant;
  readonly ais: Opponent[] = [];
  message = '';
  private messageUntilS = 0;
  kills = 0;
  deaths = 0;
  private respawnAtS = -1;
  private readonly enemyRespawnAtS = new Map<number, number>();
  /** Landing challenge result, once scored. */
  landingScore: { score: number; sinkMs: number; offsetM: number; fromAimM: number } | null = null;
  private wasAirborne = false;
  private ended = false;

  constructor(
    readonly opts: GameOptions,
    private readonly rand: () => number,
  ) {
    this.combat = new Combat(rand);
    this.player = this.combat.add(opts.player, true);
    if (opts.mode === 'duel') this.addEnemy(opts.opponent);
    if (opts.mode === 'intercept') {
      this.addEnemy(opts.opponent);
      this.addEnemy(opts.opponent);
    }
    this.spawnAll();
  }

  private addEnemy(kind: GameOptions['opponent']): void {
    const c = this.combat.add(kind, false);
    this.ais.push(new Opponent(c, this.combat, this.opts.difficulty, new Vec3(0, 7000, -20_000), this.rand));
  }

  private say(text: string, seconds: number): void {
    this.message = text;
    this.messageUntilS = this.combat.nowS + seconds;
  }

  spawnAll(): void {
    const p = this.player;
    this.combat.rearm(p);
    const ac = p.aircraft;
    switch (this.opts.mode) {
      case 'free':
        if (this.opts.airStartM !== null) ac.placeInFlight(0, this.opts.airStartM, 12_000, 0, this.opts.airStartM > 6000 ? 260 : 200);
        else ac.placeOnGround(0, THRESHOLD_36_Z - 120, 0, RUNWAY.elevationM);
        break;
      case 'duel':
        ac.placeInFlight(0, 6000, 20_000, 0, 250);
        break;
      case 'intercept':
        ac.placeInFlight(0, 3000, 4000, 0, 220);
        ac.fuelKg = ac.cfg.mass.internalFuelKg * 0.45;
        break;
      case 'landing':
        // On the extended centreline, 10 km out, on a 3° path, gear down.
        ac.placeInFlight(0, RUNWAY.elevationM + 10_000 * Math.tan((3 * Math.PI) / 180), THRESHOLD_36_Z + 10_000, 0, 85, true);
        break;
    }
    this.ais.forEach((ai, i) => this.spawnEnemy(ai.me, i));
    this.wasAirborne = !ac.gear.weightOnWheels;
    this.landingScore = null;
    this.ended = false;
    if (this.opts.mode === 'duel') this.say('FIGHT’S ON', 3);
    if (this.opts.mode === 'intercept') this.say('TWO BANDITS INBOUND — DEFEND THE BASE', 4);
    if (this.opts.mode === 'landing') this.say('LAND ON RUNWAY 36', 4);
  }

  private spawnEnemy(c: Combatant, i: number): void {
    this.combat.rearm(c);
    const x = (i - (this.ais.length - 1) / 2) * 3000;
    if (this.opts.mode === 'intercept') c.aircraft.placeInFlight(x, 8000, -60_000, Math.PI, 260);
    else c.aircraft.placeInFlight(x, 7000, -20_000, Math.PI, 250);
  }

  /** One fixed step: the AI decides, everything flies, then the mode's rules. */
  step(dtS: number, playerOrders: Orders, groundAt: GroundHeight, sunDir: Vec3, canSee: (from: Combatant, to: Combatant) => boolean, events: CombatEvents = createEvents()): CombatEvents {
    const orders = new Map<number, Orders>();
    orders.set(this.player.id, playerOrders);
    for (const ai of this.ais) orders.set(ai.me.id, ai.update(dtS, groundAt, canSee));
    const playerWasAlive = this.player.alive;
    const enemiesAlive = this.ais.map((a) => a.me.alive);
    this.combat.step(dtS, orders, groundAt, sunDir, events);
    const now = this.combat.nowS;
    // Deaths and kills.
    if (playerWasAlive && !this.player.alive) {
      this.deaths++;
      this.say(this.player.aircraft.crashed && this.player.health > 0 ? 'CRASHED' : 'SHOT DOWN', 4);
      this.respawnAtS = now + 5;
    }
    this.ais.forEach((ai, i) => {
      if (enemiesAlive[i] && !ai.me.alive) {
        this.kills++;
        this.say('SPLASH ONE', 3);
        if (this.opts.mode === 'duel') this.enemyRespawnAtS.set(ai.me.id, now + 10);
      }
    });
    if (this.respawnAtS > 0 && now > this.respawnAtS) {
      this.respawnAtS = -1;
      this.spawnAll();
    }
    for (const ai of this.ais) {
      const at = this.enemyRespawnAtS.get(ai.me.id);
      if (at !== undefined && now > at) {
        this.enemyRespawnAtS.delete(ai.me.id);
        this.spawnEnemy(ai.me, this.ais.indexOf(ai));
        this.say('NEW BANDIT 40 KM NORTH', 3);
      }
    }
    this.modeRules();
    if (now > this.messageUntilS) this.message = '';
    return events;
  }

  private modeRules(): void {
    const ac = this.player.aircraft;
    const g = ac.gear;
    if (!g.weightOnWheels) this.wasAirborne = true;
    if (this.opts.mode === 'landing' && g.justTouchedDown && this.wasAirborne && !this.landingScore) {
      // Score the touchdown: gentle (< 1.5 m/s), on the centreline, near the 400 m aiming point.
      const sink = g.touchdownSinkMs;
      const offset = Math.abs(ac.position.x);
      const fromAim = THRESHOLD_36_Z - 400 - ac.position.z;
      const onRunway = offset < 22 && ac.position.z < THRESHOLD_36_Z && ac.position.z > -THRESHOLD_36_Z;
      let score = onRunway ? 100 : 0;
      score -= Math.max(0, sink - 1) * 25;
      score -= offset * 2;
      score -= Math.abs(fromAim) / 15;
      score = Math.max(0, Math.round(score));
      this.landingScore = { score, sinkMs: sink, offsetM: offset, fromAimM: fromAim };
      this.say(onRunway ? `TOUCHDOWN — SCORE ${score}` : 'OFF THE RUNWAY', 8);
    }
    if (this.opts.mode === 'intercept' && !this.ended) {
      const allDown = this.ais.every((a) => !a.me.alive);
      if (allDown && g.weightOnWheels && ac.speedMs < 30 && Math.abs(ac.position.x) < 400 && Math.abs(ac.position.z) < 1600) {
        this.ended = true;
        this.say('MISSION COMPLETE', 10);
      } else if (ac.fuelKg <= 0 && !g.weightOnWheels && this.player.alive) {
        this.say('BINGO — OUT OF FUEL', 4);
      }
    }
  }

  /** One line for the status bar. */
  status(): string {
    const m = this.opts.mode;
    if (m === 'free') return 'FREE FLIGHT';
    if (m === 'landing') return this.landingScore ? `LANDING · score ${this.landingScore.score} · sink ${this.landingScore.sinkMs.toFixed(1)} m/s · offset ${this.landingScore.offsetM.toFixed(1)} m · ${Math.round(this.landingScore.fromAimM)} m from aim` : 'LANDING · runway 36, straight in';
    const left = this.ais.filter((a) => a.me.alive).length;
    return `${m === 'duel' ? 'DUEL' : 'INTERCEPT'} · ${this.opts.difficulty} · kills ${this.kills} · losses ${this.deaths}${m === 'intercept' ? ` · bandits ${left}` : ''}`;
  }
}
