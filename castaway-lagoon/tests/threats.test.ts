import { describe, expect, it } from 'vitest';
import { HEALTH, LAGOON_PLAYER, SPECIES, WATER_LEVEL_M } from '../src/config.ts';
import type { LagoonEvent } from '../src/game/events.ts';
import { boarGround, crocGround, sharkWater, tigerGround } from '../src/game/fauna.ts';
import { emptyIntent, LagoonGame, type LagoonIntent, THREATS_AFTER_S } from '../src/game/game.ts';
import { Guerrilla } from '../src/game/guerrillas.ts';
import { heightAt, LAGOON_CENTRE, OUTPOST_CENTRE } from '../src/game/terrain.ts';

// The lagoon's threats, headless: each species on its own ground does what it
// is meant to (and leaves alone whoever it is meant to), a guerrilla in plain
// view shoots and hits, the player's weapons kill them, and the player blacks
// out, wakes at the shelter and can treat wounds.

const DT = 1 / 60;

function run(game: LagoonGame, steps: number, intent: (i: LagoonIntent, n: number) => void = () => {}): LagoonEvent[] {
  const out: LagoonEvent[] = [];
  for (let n = 0; n < steps; n++) {
    const i = emptyIntent();
    intent(i, n);
    game.step(i, DT);
    out.push(...game.events.drain());
  }
  return out;
}

/** A game with nothing in it but what the test places, past the opening grace period. */
function emptyGame(time: 'noon' | 'night' = 'noon'): LagoonGame {
  const g = new LagoonGame(4321, time, 'clear', { threats: true });
  g.fauna?.creatures.splice(0);
  g.band?.members.splice(0);
  g.timeSeconds = THREATS_AFTER_S + 1;
  return g;
}

function place(game: LagoonGame, x: number, z: number, yawRad = 0): void {
  const p = game.player;
  p.pos.x = p.prev.x = x;
  p.pos.z = p.prev.z = z;
  p.pos.y = p.prev.y = Math.max(heightAt(x, z), WATER_LEVEL_M - 1);
  p.yawRad = yawRad;
  p.grounded = true;
}

/** A spot on some ground, searched in rings round the lagoon (deterministic). */
function spotWhere(ok: (x: number, z: number) => boolean, near: { x: number; z: number } = LAGOON_CENTRE): { x: number; z: number } {
  for (let r = 20; r < 200; r += 3) {
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      const x = near.x + Math.cos(a) * r;
      const z = near.z + Math.sin(a) * r;
      if (ok(x, z)) return { x, z };
    }
  }
  throw new Error('no such ground');
}

function hurtBy(events: LagoonEvent[], cause: string): number {
  return events.filter((e) => e.type === 'hurt' && e.cause === cause).reduce((s, e) => s + (e.type === 'hurt' ? e.amount : 0), 0);
}

describe('creatures', () => {
  it('populates the lagoon with every species on its own ground', () => {
    const g = new LagoonGame(4321, 'noon', 'clear', { threats: true });
    const kinds = new Set(g.fauna?.creatures.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(['boar', 'croc', 'shark', 'tiger']);
    for (const c of g.fauna?.creatures ?? []) {
      expect(Math.hypot(c.pos.x - g.player.pos.x, c.pos.z - g.player.pos.z)).toBeGreaterThan(60);
    }
    expect(g.band?.members.length).toBe(5);
  });

  it('a tiger that has the player’s scent stalks, charges, leaps and wounds', () => {
    const g = emptyGame();
    const at = spotWhere(tigerGround, OUTPOST_CENTRE);
    place(g, at.x, at.z);
    const t = g.fauna!.spawn('tiger', { x: at.x + 22, y: heightAt(at.x + 22, at.z), z: at.z }, Math.PI / 2);
    t.awareness = 1;
    t.setState('stalk');
    const events = run(g, 60 * 20);
    expect(hurtBy(events, 'tiger')).toBeGreaterThanOrEqual(SPECIES.tiger.damage);
    expect(events.some((e) => e.type === 'threatCall' && e.call === 'roar')).toBe(true);
  });

  it('a tiger will not close on someone by a burning fire at night', () => {
    const g = emptyGame('night');
    const fire = g.firePitPos;
    place(g, fire.x + 2, fire.z + 1);
    const tx = fire.x + 25;
    const tz = fire.z - 20;
    const t = g.fauna!.spawn('tiger', { x: tx, y: heightAt(tx, tz), z: tz }, 0);
    t.awareness = 1;
    t.setState('stalk');
    const events = run(g, 60 * 15);
    expect(g.fire.lit).toBe(true);
    expect(hurtBy(events, 'tiger')).toBe(0);
  });

  it('a boar charges someone who walks up to it, and the knife kills it', () => {
    const g = emptyGame();
    const at = spotWhere(boarGround);
    const b = g.fauna!.spawn('boar', { x: at.x, y: heightAt(at.x, at.z), z: at.z }, 0);
    // Stand 7 m in front of it.
    place(g, at.x, at.z - 7, Math.PI);
    const events = run(g, 60 * 6);
    expect(hurtBy(events, 'boar')).toBeGreaterThan(0);
    // Knife it: held in front of the player (it would gore and dodge otherwise), slash until it dies.
    g.inventory.add('knife', 1);
    g.equipment.switchTo('knife');
    run(g, 40);
    let killed = false;
    for (let k = 0; k < 10 && !killed; k++) {
      const ev = run(g, 40, (i, n) => {
        i.triggers.firePressed = n === 0;
        g.player.health = HEALTH.max;
        g.player.yawRad = 0;
        g.player.pitchRad = -0.6;
        b.setState('idle');
        b.speedMs = 0;
        b.yawRad = 0;
        b.pos.x = g.player.pos.x;
        b.pos.z = g.player.pos.z - 1.2;
        b.pos.y = heightAt(b.pos.x, b.pos.z);
        b.updateSpheres();
      });
      killed = ev.some((e) => e.type === 'threatHit' && e.killed);
    }
    expect(killed).toBe(true);
    expect(b.alive).toBe(false);
  });

  it('a shark circles and bites a swimmer, and leaves someone on the boat alone', () => {
    const g = emptyGame();
    const at = spotWhere(sharkWater);
    // The swimmer, floating, and a shark twenty metres off.
    place(g, at.x, at.z);
    g.player.swimming = true;
    g.player.pos.y = g.player.prev.y = WATER_LEVEL_M - LAGOON_PLAYER.eyeHeightM + LAGOON_PLAYER.floatEyeAboveWaterM;
    g.player.grounded = false;
    const s = g.fauna!.spawn('shark', { x: at.x + 15, y: WATER_LEVEL_M - 2, z: at.z }, 0);
    const events = run(g, 60 * 40);
    expect(hurtBy(events, 'shark')).toBeGreaterThan(0);
    expect(s.alive).toBe(true);
    // In the boat: nothing.
    const g2 = emptyGame();
    g2.fauna!.spawn('shark', { x: g2.boat.pos.x + 8, y: WATER_LEVEL_M - 2, z: g2.boat.pos.z }, 0);
    g2.player.inBoat = true;
    const events2 = run(g2, 60 * 30);
    expect(hurtBy(events2, 'shark')).toBe(0);
  });

  it('a crocodile lunges at someone wading close to it', () => {
    const g = emptyGame();
    const at = spotWhere(crocGround);
    g.fauna!.spawn('croc', { x: at.x, y: WATER_LEVEL_M - 0.25, z: at.z }, 0);
    // Wading a body length or two away, in the shallows toward the beach.
    let placed = false;
    for (let r = 3; r < 8 && !placed; r += 0.5) {
      for (let a = 0; a < Math.PI * 2 && !placed; a += 0.1) {
        const x = at.x + Math.cos(a) * r;
        const z = at.z + Math.sin(a) * r;
        const depth = WATER_LEVEL_M - heightAt(x, z);
        if (depth > 0.25 && depth < 1.1) {
          place(g, x, z);
          placed = true;
        }
      }
    }
    expect(placed).toBe(true);
    const events = run(g, 60 * 8);
    expect(hurtBy(events, 'croc')).toBeGreaterThan(0);
  });

  it('dies to rifle fire and lies there', () => {
    const g = emptyGame();
    const at = spotWhere(boarGround);
    const b = g.fauna!.spawn('boar', { x: at.x, y: heightAt(at.x, at.z), z: at.z }, 0);
    b.setState('idle');
    let killed = false;
    for (let shot = 0; shot < 6 && !killed; shot++) {
      b.health = Math.max(b.health, 1);
      b.updateSpheres();
      const target = b.hitSpheres[1]!;
      const from = { x: target.x, y: target.y + 0.5, z: target.z + 6 };
      const d = { x: 0, y: -0.5 / Math.hypot(0.5, 6), z: -6 / Math.hypot(0.5, 6) };
      g.bullets.fire(from, d);
      const ev = run(g, 5, () => {});
      killed = ev.some((e) => e.type === 'threatHit' && e.killed);
      b.setState(b.alive ? 'idle' : 'dead');
    }
    expect(killed).toBe(true);
  });
});

describe('guerrillas', () => {
  it('one in plain view on the beach sees the player, shoots and hits', () => {
    const g = emptyGame();
    place(g, -10, 2);
    const gx = 18;
    const gz = 0;
    const man = new Guerrilla(1, 'patrol', { x: gx, y: heightAt(gx, gz), z: gz }, Math.PI / 2, []);
    g.band!.members.push(man);
    const events = run(g, 60 * 15);
    expect(events.some((e) => e.type === 'enemyShot')).toBe(true);
    expect(hurtBy(events, 'guerrilla')).toBeGreaterThan(0);
    expect(man.state).toBe('engage');
  });

  it('cannot see through the ridge, but hears the rifle and comes to look', () => {
    const g = emptyGame();
    place(g, -10, 2);
    // Far round behind the outpost's hill, facing away.
    const man = new Guerrilla(2, 'camp', { x: g.band!.camp.x, y: g.band!.camp.y, z: g.band!.camp.z }, 0, []);
    g.band!.members.push(man);
    run(g, 60 * 3);
    expect(man.state).toBe('camp');
    g.inventory.add('rifle', 1);
    g.equipment.switchTo('rifle');
    g.equipment.magazineRounds = 30;
    run(g, 40);
    run(g, 6, (i) => {
      i.triggers.fireHeld = true;
      i.triggers.firePressed = true;
    });
    expect(['alert', 'search', 'engage']).toContain(man.state);
  });

  it('dies to three body hits and drops ammunition', () => {
    const g = emptyGame();
    place(g, -10, 2);
    const man = new Guerrilla(3, 'patrol', { x: 5, y: heightAt(5, 2), z: 2 }, -Math.PI / 2, []);
    g.band!.members.push(man);
    const before = g.interactables.filter((i) => i.item === 'ammo762' && i.alive).length;
    // Two hits stand him; the third, a real round, kills, and the band drops his kit.
    for (let k = 0; k < 2; k++) man.hurt(42, 'torso', { x: 1, y: 0, z: 0 }, true);
    expect(man.alive).toBe(true);
    const ev: LagoonEvent[] = [];
    g.bullets.fire({ x: -8, y: man.hitSpheres[1]!.y, z: 2 }, { x: 1, y: 0, z: 0 });
    ev.push(...run(g, 3));
    expect(ev.some((e) => e.type === 'threatHit' && e.kind === 'guerrilla' && e.killed)).toBe(true);
    const after = g.interactables.filter((i) => i.item === 'ammo762' && i.alive).length;
    expect(after).toBe(before + 1);
  });
});

describe('the player’s wounds', () => {
  it('blacks out at zero and wakes at the shelter, patched up', () => {
    const g = emptyGame();
    g.hurt(150, null, 'tiger');
    expect(g.downS).toBeGreaterThan(0);
    const events = run(g, Math.ceil(HEALTH.blackoutS * 60) + 5);
    expect(events.some((e) => e.type === 'wake')).toBe(true);
    expect(g.player.health).toBeCloseTo(HEALTH.max * HEALTH.respawnFraction, 0);
    expect(Math.hypot(g.player.pos.x - OUTPOST_CENTRE.x, g.player.pos.z - OUTPOST_CENTRE.z)).toBeLessThan(8);
  });

  it('heals by itself only half way; a herb does the rest', () => {
    const g = emptyGame();
    g.hurt(80, null, 'boar');
    run(g, 60 * 40);
    expect(g.player.health).toBeCloseTo(HEALTH.max * HEALTH.regenCapFraction, 0);
    g.inventory.add('herb', 1);
    const events = run(g, 60 * 8, (i, n) => {
      i.heal = n === 0;
    });
    expect(events.some((e) => e.type === 'treat')).toBe(true);
    expect(g.player.health).toBeCloseTo(HEALTH.max * HEALTH.regenCapFraction + 30, 0);
    expect(g.inventory.has('herb')).toBe(false);
  });

  it('a long fall hurts', () => {
    const g = emptyGame();
    place(g, -4.5, 4);
    g.player.pos.y += 9;
    g.player.prev.y = g.player.pos.y;
    g.player.grounded = false;
    const events = run(g, 120);
    expect(hurtBy(events, 'fall')).toBeGreaterThan(0);
  });
});
