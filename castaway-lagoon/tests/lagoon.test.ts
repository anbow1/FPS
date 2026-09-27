import { describe, expect, it } from 'vitest';
import { ENVIRONMENT, RIFLE, WEATHER } from '../src/config.ts';
import { airMass, computeDaylight, Environment } from '../src/game/environment.ts';
import type { LagoonEvent } from '../src/game/events.ts';
import { emptyIntent, LagoonGame, type LagoonIntent } from '../src/game/game.ts';
import { Inventory } from '../src/game/inventory.ts';
import { heightAt, LAGOON_CENTRE, surfaceAt } from '../src/game/terrain.ts';
import type { Interactable } from '../src/game/world.ts';
import { Rng } from '../src/core/rng.ts';
import { EventQueue } from '../src/game/events.ts';

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

/** Stand the player a step from a target and aim the eye at it. */
function lookAt(game: LagoonGame, target: Interactable, standoffM = 1.2): void {
  const p = game.player;
  const dx0 = p.pos.x - target.pos.x;
  const dz0 = p.pos.z - target.pos.z;
  const d0 = Math.hypot(dx0, dz0) || 1;
  p.pos.x = target.pos.x + (dx0 / d0) * standoffM;
  p.pos.z = target.pos.z + (dz0 / d0) * standoffM;
  p.pos.y = game.world.collision.groundAt(p.pos.x, p.pos.z, target.pos.y + 0.5, 0.45);
  const eyeY = p.pos.y + 1.68;
  const dx = target.pos.x - p.pos.x;
  const dz = target.pos.z - p.pos.z;
  const dy = target.pos.y + Math.min(0.25, target.radiusM * 0.5) - eyeY;
  p.yawRad = Math.atan2(-dx, -dz);
  p.pitchRad = Math.atan2(dy, Math.hypot(dx, dz));
}

function newGame(): LagoonGame {
  return new LagoonGame(1234, 'noon', 'clear');
}

describe('lagoon terrain', () => {
  it('puts the spawn on dry sand with deep water in the middle of the lagoon', () => {
    const g = newGame();
    const s = g.world.spawn.pos;
    expect(heightAt(s.x, s.z)).toBeGreaterThan(0.1);
    expect(surfaceAt(s.x, s.z)).toMatch(/sand/);
    expect(heightAt(LAGOON_CENTRE.x, LAGOON_CENTRE.z)).toBeLessThan(-4);
  });

  it('raises a volcano across the sea that stands above the lagoon hills', () => {
    expect(heightAt(420, -1250)).toBeGreaterThan(400);
  });
});

describe('inventory', () => {
  it('stacks stones but holds a tool only once', () => {
    const inv = new Inventory();
    inv.add('stone', 2);
    inv.add('stone', 3);
    inv.add('rifle', 1);
    inv.add('rifle', 1);
    expect(inv.count('stone')).toBe(5);
    expect(inv.count('rifle')).toBe(1);
  });

  it('removes no more than it holds and forgets empty stacks', () => {
    const inv = new Inventory();
    inv.add('herb', 2);
    expect(inv.remove('herb', 5)).toBe(2);
    expect(inv.has('herb')).toBe(false);
    expect(inv.entries()).toEqual([]);
  });

  it('rejects a zero count', () => {
    expect(() => new Inventory().add('stone', 0)).toThrow(/positive whole count/);
  });
});

describe('stones', () => {
  it('can be picked up from the beach, thrown into the lagoon, and splash', () => {
    const g = newGame();
    const stone = g.interactables.find((i) => i.model === 'stone') as Interactable;
    lookAt(g, stone);
    const events = run(g, 60, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.inventory.count('stone')).toBe(1);
    expect(stone.alive).toBe(false);
    expect(events.some((e) => e.type === 'itemGained' && e.itemId === 'stone')).toBe(true);
    expect(g.equipment.slot).toBe('stone');
    // Face the lagoon, wind up for half a second, let go.
    g.player.yawRad = 0;
    g.player.pitchRad = 0.25;
    const thrown = run(g, 400, (i, n) => {
      i.triggers.firePressed = n === 0;
      i.triggers.fireHeld = n < 30;
    });
    expect(thrown.some((e) => e.type === 'stoneThrown')).toBe(true);
    const splash = thrown.find((e) => e.type === 'splash');
    expect(splash).toBeDefined();
    if (splash?.type === 'splash') expect(splash.speedMs).toBeGreaterThan(8);
    expect(g.inventory.count('stone')).toBe(0);
  });

  it('skips off the water when thrown flat and fast', () => {
    const g = newGame();
    g.bodies.throwStone({ x: 0, y: 0.4, z: -30 }, { x: 0, y: -1.5, z: -20 });
    const events = run(g, 120);
    const splashes = events.filter((e) => e.type === 'splash');
    expect(splashes.length).toBeGreaterThan(1);
    expect(splashes[0]?.type === 'splash' && splashes[0].skip).toBe(true);
  });

  it('sinks when dropped steeply into deep water', () => {
    const g = newGame();
    g.bodies.throwStone({ x: 0, y: 3, z: -50 }, { x: 0, y: -8, z: -1 });
    const events = run(g, 60);
    const splash = events.find((e) => e.type === 'splash');
    expect(splash?.type === 'splash' && splash.skip).toBe(false);
  });
});

describe('rifle', () => {
  it('is picked up from the shelter with spare rounds and fires, hits and reloads', () => {
    const g = newGame();
    const rifle = g.interactables.find((i) => i.model === 'rifle') as Interactable;
    lookAt(g, rifle, 1.0);
    run(g, 90, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.inventory.has('rifle')).toBe(true);
    expect(g.inventory.count('ammo762')).toBe(RIFLE.startReserveRounds);
    expect(g.equipment.slot).toBe('rifle');
    expect(g.equipment.busy).toBe(false);
    // Shoot at the beach in front of the shelter.
    g.player.pitchRad = -0.35;
    const events = run(g, 30, (i) => {
      i.triggers.fireHeld = true;
    });
    const shots = events.filter((e) => e.type === 'shot').length;
    expect(shots).toBeGreaterThanOrEqual(4);
    expect(g.equipment.magazineRounds).toBe(RIFLE.magazineRounds - shots);
    expect(events.some((e) => e.type === 'bulletImpact')).toBe(true);
    const reload = run(g, 200, (i, n) => {
      i.triggers.reloadPressed = n === 0;
    });
    expect(reload.filter((e) => e.type === 'reloadStage').length).toBe(2);
    expect(g.equipment.magazineRounds).toBe(RIFLE.magazineRounds);
    expect(g.inventory.count('ammo762')).toBe(RIFLE.startReserveRounds - shots);
  });

  it('dry-fires on an empty magazine with no reserve', () => {
    const g = newGame();
    g.inventory.add('rifle', 1);
    g.equipment.magazineRounds = 0;
    run(g, 2, (i, n) => {
      i.triggers.selectSlot = n === 0 ? 'rifle' : null;
    });
    run(g, 60);
    const events = run(g, 3, (i) => {
      i.triggers.firePressed = true;
      i.triggers.fireHeld = true;
    });
    expect(events.some((e) => e.type === 'dryFire')).toBe(true);
    expect(g.equipment.action.kind).toBe('idle');
  });
});

describe('outpost interactions', () => {
  it('opens the supply crate and reveals its contents', () => {
    const g = newGame();
    const crate = g.interactables.find((i) => i.kind === 'crate') as Interactable;
    lookAt(g, crate, 1.1);
    const before = g.interactables.length;
    const events = run(g, 90, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(crate.open).toBe(1);
    expect(events.some((e) => e.type === 'crateOpened')).toBe(true);
    expect(g.interactables.length).toBe(before + 3);
    expect(g.interactables.some((i) => i.item === 'ammo762' && i.alive)).toBe(true);
  });

  it('harvests a plant into the inventory and removes it', () => {
    const g = newGame();
    const herb = g.interactables.find((i) => i.model === 'herb') as Interactable;
    lookAt(g, herb, 1.0);
    run(g, 80, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(herb.alive).toBe(false);
    expect(g.inventory.count('herb')).toBe(2);
  });

  it('shows an examine text and closes it when interact is pressed again', () => {
    const g = newGame();
    const journal = g.interactables.find((i) => i.model === 'journal') as Interactable;
    lookAt(g, journal, 0.9);
    const events = run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(events.some((e) => e.type === 'examine' && e.text.startsWith('Day 41'))).toBe(true);
    expect(g.equipment.action.kind).toBe('examine');
    run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.equipment.action.kind).toBe('idle');
  });
});

describe('player', () => {
  it('stops at chest-deep water instead of walking into the lagoon', () => {
    const g = newGame();
    g.player.yawRad = 0.0;
    run(g, 60 * 25, (i) => {
      i.move.moveForward = 1;
    });
    expect(-heightAt(g.player.pos.x, g.player.pos.z)).toBeLessThanOrEqual(1.3);
    expect(g.player.wadingDepthM).toBeGreaterThan(0.5);
  });

  it('accelerates instead of reaching full speed on the first step', () => {
    const g = newGame();
    run(g, 1, (i) => {
      i.move.moveForward = 1;
    });
    expect(g.player.speedMs).toBeGreaterThan(0);
    expect(g.player.speedMs).toBeLessThan(3.2);
  });
});

describe('time of day and weather', () => {
  it('uses the Kasten–Young air mass: ~1 at the zenith and ~38 at the horizon', () => {
    expect(airMass(Math.PI / 2)).toBeCloseTo(1, 2);
    expect(airMass(0)).toBeGreaterThan(37);
    expect(airMass(0)).toBeLessThan(39);
  });

  it('lights clear noon near the lighting sheet (≈100 000 lx on the ground, EV ≈ 15)', () => {
    const d = computeDaylight(12.4, { ...WEATHER.clear });
    const ground = d.sunNormalLux * Math.sin(d.sunElevationRad) + d.skyLux;
    expect(ground).toBeGreaterThan(80000);
    expect(ground).toBeLessThan(120000);
    expect(d.anchorEv).toBeGreaterThan(14.5);
    expect(d.anchorEv).toBeLessThan(16);
  });

  it('puts the golden-hour sun low and warm and night far darker', () => {
    const golden = computeDaylight(17.95, { ...WEATHER.clear });
    const night = computeDaylight(22.5, { ...WEATHER.clear });
    expect(golden.sunElevationRad).toBeLessThan(0.2);
    expect(golden.sunElevationRad).toBeGreaterThan(0.02);
    expect(golden.sunColourK).toBeLessThan(4000);
    expect(night.sunNormalLux).toBe(0);
    expect(night.night).toBe(1);
    expect(golden.anchorEv - night.anchorEv).toBeGreaterThan(8);
  });

  it('dims the sun under a storm deck', () => {
    const clear = computeDaylight(12.4, { ...WEATHER.clear });
    const storm = computeDaylight(12.4, { ...WEATHER.storm });
    expect(storm.sunNormalLux / clear.sunNormalLux).toBeLessThan(0.05);
  });

  it('blends into rain over the transition and soaks the ground', () => {
    const env = new Environment('noon', 'clear');
    const rng = new Rng(1);
    const events = new EventQueue();
    env.setWeather('rain');
    for (let t = 0; t < ENVIRONMENT.weatherTransitionSeconds + 20; t += DT) env.step(DT, rng, events);
    expect(env.weather.rainRate).toBeCloseTo(WEATHER.rain.rainRate, 5);
    expect(env.wetness).toBeGreaterThan(0.5);
  });

  it('sweeps the clock forward through the evening to reach night', () => {
    const env = new Environment('sunset', 'clear');
    env.setTime('night');
    const rng = new Rng(1);
    const events = new EventQueue();
    let sawPastNine = false;
    for (let t = 0; t < ENVIRONMENT.timeTransitionSeconds + 0.1; t += DT) {
      env.step(DT, rng, events);
      if (env.hour > 21) sawPastNine = true;
      expect(env.hour).toBeGreaterThanOrEqual(17.9);
    }
    expect(sawPastNine).toBe(true);
    expect(env.hour).toBeCloseTo(22.5, 5);
  });
});
