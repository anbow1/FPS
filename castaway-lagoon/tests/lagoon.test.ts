import { describe, expect, it } from 'vitest';
import { ENVIRONMENT, FIRE, INTERACT, JEEP, LAGOON_PLAYER, RIFLE, WEATHER } from '../src/config.ts';
import { airMass, computeDaylight, Environment } from '../src/game/environment.ts';
import type { LagoonEvent } from '../src/game/events.ts';
import { emptyIntent, LagoonGame, type LagoonIntent, sleepUntil } from '../src/game/game.ts';
import { Inventory } from '../src/game/inventory.ts';
import { heightAt, LAGOON_CENTRE, surfaceAt } from '../src/game/terrain.ts';
import type { Interactable } from '../src/game/world.ts';
import { Rng } from '../src/core/rng.ts';
import { PROP_MODELS } from '../src/render/propModels.ts';
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
  return new LagoonGame(1234, 'noon', 'clear', { threats: false });
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

describe('shelter', () => {
  it('takes the backpack with what is in it', () => {
    const g = newGame();
    const pack = g.interactables.find((i) => i.model === 'backpack') as Interactable;
    lookAt(g, pack, 0.9);
    run(g, 60, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(pack.alive).toBe(false);
    for (const id of ['backpack', 'lighter', 'fishhooks'] as const) expect(g.inventory.count(id)).toBe(1);
  });

  it('takes the lamp down lit, puts it out with L, and a dunking puts it out', () => {
    const g = newGame();
    const lamp = g.interactables.find((i) => i.model === 'lantern') as Interactable;
    lookAt(g, lamp, 0.9);
    const events = run(g, 60, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.inventory.has('lamp')).toBe(true);
    expect(g.lampLit).toBe(true);
    expect(events.some((e) => e.type === 'lamp' && e.lit)).toBe(true);
    run(g, 2, (i, n) => {
      i.toggleLamp = n === 0;
    });
    expect(g.lampLit).toBe(false);
    run(g, 2, (i, n) => {
      i.toggleLamp = n === 0;
    });
    expect(g.lampLit).toBe(true);
    // swim out and dive
    g.player.yawRad = 0.0;
    g.player.pos.x = g.world.spawn.pos.x;
    g.player.pos.z = g.world.spawn.pos.z;
    g.player.pos.y = g.world.spawn.pos.y;
    run(g, 60 * 25, (i) => {
      i.move.moveForward = 1;
    });
    const dunk = run(g, 60 * 3, (i) => {
      i.move.dive = true;
    });
    expect(g.lampLit).toBe(false);
    expect(dunk.some((e) => e.type === 'message' && e.text === 'The lamp went out')).toBe(true);
  });

  it('sleeps on the cot from night until morning, standing still meanwhile', () => {
    const g = new LagoonGame(1234, 'night', 'clear', { threats: false });
    const cot = g.interactables.find((i) => i.kind === 'sleep') as Interactable;
    lookAt(g, cot, 0.8);
    expect(sleepUntil('night')).toBe('morning');
    const start = { ...g.player.pos };
    const events = run(g, Math.floor(60 * INTERACT.sleepSeconds) - 5, (i, n) => {
      i.interactPressed = n === 0;
      i.move.moveForward = 1; // ignored while asleep
    });
    expect(events.some((e) => e.type === 'sleep' && e.until === 'morning')).toBe(true);
    expect(Math.hypot(g.player.pos.x - start.x, g.player.pos.z - start.z)).toBeLessThan(0.05);
    run(g, 30);
    expect(g.equipment.action.kind).toBe('idle');
    expect(g.env.timeId).toBe('morning');
    expect(g.env.hour).toBeCloseTo(7.5, 5);
  });
});

describe('camp fire', () => {
  it('burns down and goes out, takes a log and needs the lighter to relight', () => {
    const g = newGame();
    expect(g.fire.lit).toBe(true);
    expect(g.fire.fuelS).toBe(FIRE.startFuelS);
    // the last second of a fire burning down (the whole 300 s is 18 000 game steps)
    g.fire.fuelS = 1;
    const out = run(g, 90);
    expect(out.some((e) => e.type === 'fire' && e.what === 'out')).toBe(true);
    expect(g.fire.strength).toBe(0);
    const pit = g.interactables.find((i) => i.kind === 'fire') as Interactable;
    g.inventory.add('log', 2);
    lookAt(g, pit, 1.4);
    run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.inventory.count('log')).toBe(1);
    expect(g.fire.fuelS).toBeCloseTo(FIRE.logBurnS, 5);
    const noLighter = run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(noLighter.some((e) => e.type === 'message' && e.text.includes('lighter'))).toBe(true);
    expect(g.fire.lit).toBe(false);
    g.inventory.add('lighter', 1);
    run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.fire.lit).toBe(true);
  });

  it('gives a log from the woodpile every time and keeps the pile', () => {
    const g = newGame();
    const pile = g.interactables.find((i) => i.model === 'woodpile') as Interactable;
    lookAt(g, pile, 1.1);
    for (let k = 0; k < 3; k++) {
      run(g, 60, (i, n) => {
        i.interactPressed = n === 0;
      });
    }
    expect(g.inventory.count('log')).toBe(3);
    expect(pile.alive).toBe(true);
  });

  it('feeds the fire with a log thrown into the pit', () => {
    const g = newGame();
    const before = g.fire.fuelS;
    const pit = g.firePitPos;
    // straight down onto the embers from above the pit
    g.bodies.throwLog({ x: pit.x, y: pit.y + 1.5, z: pit.z }, { x: 0, y: -1, z: 0 });
    const events = run(g, 120);
    expect(events.some((e) => e.type === 'fire' && e.what === 'fed')).toBe(true);
    expect(g.fire.fuelS).toBeGreaterThan(before + FIRE.logBurnS - 3);
    // one thrown on the sand stays there as a pick-up
    g.bodies.throwLog({ x: pit.x + 4, y: pit.y + 1.5, z: pit.z }, { x: 0, y: -1, z: 0 });
    run(g, 120);
    expect(g.interactables.some((i) => i.model === 'log' && i.alive)).toBe(true);
  });
});

describe('boat', () => {
  function boardBoat(g: LagoonGame): void {
    const spot = g.interactables.find((i) => i.kind === 'boat') as Interactable;
    // stand on the dock beside it (port side) and look down at it
    const onDock = g.boat.toWorld(-0.3, 0, -1.6, { x: 0, y: 0, z: 0 });
    g.player.pos.x = onDock.x;
    g.player.pos.z = onDock.z;
    lookAt(g, spot, Math.hypot(onDock.x - spot.pos.x, onDock.z - spot.pos.z));
    // on the dock beside the boat: look down at it and press E
    run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
  }

  it('floats level at its mooring', () => {
    const g = newGame();
    run(g, 300);
    const b = g.boat;
    expect(b.grounded).toBe(false);
    expect(Math.abs(b.pos.y)).toBeLessThan(0.08);
    expect(Math.abs(b.pitchRad)).toBeLessThan(0.06);
    expect(Math.abs(b.rollRad)).toBeLessThan(0.06);
  });

  it('is boarded from the dock, motors at about 5 m/s and turns with the tiller', () => {
    const g = newGame();
    boardBoat(g);
    expect(g.player.inBoat).toBe(true);
    const b = g.boat;
    const events = run(g, 60 * 10, (i) => {
      i.move.moveForward = 1;
    });
    expect(events.some((e) => e.type === 'boat' && e.what === 'engineStart')).toBe(true);
    expect(b.speedMs).toBeGreaterThan(4.3);
    expect(b.speedMs).toBeLessThan(6.5);
    // the player rides along, seated
    expect(Math.hypot(g.player.pos.x - b.pos.x, g.player.pos.z - b.pos.z)).toBeLessThan(1.5);
    const yaw0 = b.yawRad;
    run(g, 60 * 2, (i) => {
      i.move.moveForward = 1;
      i.move.moveRight = 1;
    });
    expect(b.yawRad).toBeLessThan(yaw0 - 0.8); // starboard turn: yaw decreases
  });

  it('runs aground on the beach instead of climbing it', () => {
    const g = newGame();
    boardBoat(g);
    run(g, 60 * 45, (i) => {
      i.move.moveForward = 1;
    });
    const b = g.boat;
    expect(heightAt(b.pos.x, b.pos.z)).toBeLessThan(0.1);
  });

  it('lets the player out onto the dock, or over the side into deep water', () => {
    const g = newGame();
    boardBoat(g);
    run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.player.inBoat).toBe(false);
    expect(g.player.swimming).toBe(false);
    expect(g.player.pos.y).toBeGreaterThan(0.4); // on the dock deck
    boardBoat(g);
    run(g, 60 * 8, (i) => {
      i.move.moveForward = 1;
    });
    run(g, 60 * 4);
    run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.player.inBoat).toBe(false);
    expect(g.player.swimming).toBe(true);
  });
});

describe('jeep', () => {
  function getIn(g: LagoonGame): void {
    (g as unknown as { useJeep: (m: string) => void }).useJeep('jeepDriver');
  }

  it('stays parked, and drives off, turns and brakes once the player is behind the wheel', () => {
    const g = newGame();
    const j = g.jeep;
    const p0 = { ...j.pos };
    run(g, 120);
    expect(Math.hypot(j.pos.x - p0.x, j.pos.z - p0.z)).toBeLessThan(0.01);
    getIn(g);
    expect(g.player.inJeep).toBe(true);
    const events = run(g, 90, (i) => {
      i.move.moveForward = 1;
    });
    expect(events.some((e) => e.type === 'jeep' && e.what === 'start')).toBe(true);
    expect(j.speedMs).toBeGreaterThan(4);
    // the driver rides along
    expect(Math.hypot(g.player.pos.x - j.pos.x, g.player.pos.z - j.pos.z)).toBeLessThan(1);
    const yaw0 = j.yawRad;
    run(g, 30, (i) => {
      i.move.moveForward = 1;
      i.move.moveRight = 1;
    });
    expect(j.yawRad).toBeLessThan(yaw0 - 0.1);
    run(g, 150, (i) => {
      i.move.moveForward = -1;
    });
    expect(j.speedMs).toBeLessThan(0.5);
  });

  it('will not drive into water deeper than its air intake', () => {
    const g = newGame();
    getIn(g);
    run(g, 60 * 12, (i) => {
      i.move.moveForward = 1;
    });
    const nose = g.jeep.toWorld(JEEP.lengthM * 0.45, 0, 0, { x: 0, y: 0, z: 0 });
    expect(-heightAt(nose.x, nose.z)).toBeLessThanOrEqual(JEEP.maxWadeM + 0.05);
  });

  it('switches headlights with L, opens the bonnet, and lets the driver out beside it', () => {
    const g = newGame();
    const j = g.jeep;
    (g as unknown as { useJeep: (m: string) => void }).useJeep('jeepBonnet');
    run(g, 120);
    expect(j.bonnet).toBeGreaterThan(0.9);
    getIn(g);
    expect(j.bonnetTarget).toBe(0); // shut before driving off
    run(g, 2, (i, n) => {
      i.toggleLamp = n === 0;
    });
    expect(j.headlights).toBe(true);
    run(g, 2, (i, n) => {
      i.interactPressed = n === 0;
    });
    expect(g.player.inJeep).toBe(false);
    const d = Math.hypot(g.player.pos.x - j.pos.x, g.player.pos.z - j.pos.z);
    expect(d).toBeGreaterThan(0.8);
    expect(d).toBeLessThan(2);
  });
});

describe('render contract', () => {
  it('knows how to draw (or deliberately not draw) every interactable a new game has', () => {
    // An unknown model throws while the props are built and the game never finishes loading.
    for (const time of ['noon', 'night'] as const) {
      const g = new LagoonGame(1234, time, 'clear', { threats: false });
      const unknown = g.interactables.filter((i) => !PROP_MODELS.has(i.model)).map((i) => i.model);
      expect(unknown).toEqual([]);
    }
  });
});

describe('player', () => {
  it('walks into the lagoon, then swims with the eye just above the waves', () => {
    const g = newGame();
    g.player.yawRad = 0.0;
    const events = run(g, 60 * 25, (i) => {
      i.move.moveForward = 1;
    });
    expect(events.some((e) => e.type === 'swim' && e.what === 'start')).toBe(true);
    expect(g.player.swimming).toBe(true);
    expect(-heightAt(g.player.pos.x, g.player.pos.z)).toBeGreaterThan(LAGOON_PLAYER.swimDepthM - 0.2);
    const eyeY = g.player.pos.y + LAGOON_PLAYER.eyeHeightM;
    expect(Math.abs(eyeY - g.player.waterY - LAGOON_PLAYER.floatEyeAboveWaterM)).toBeLessThan(0.1);
    expect(g.player.underwater).toBe(false);
  });

  it('dives while the dive key is held, runs out of air and is pushed back up', () => {
    const g = newGame();
    g.player.yawRad = 0.0;
    run(g, 60 * 25, (i) => {
      i.move.moveForward = 1;
    });
    expect(g.player.swimming).toBe(true);
    run(g, 60 * 3, (i) => {
      i.move.dive = true;
    });
    expect(g.player.underwater).toBe(true);
    const events = run(g, 60 * (LAGOON_PLAYER.breathSeconds + 2), (i) => {
      i.move.dive = true;
    });
    expect(events.some((e) => e.type === 'swim' && e.what === 'outOfAir')).toBe(true);
    expect(events.some((e) => e.type === 'swim' && e.what === 'surface')).toBe(true);
    expect(g.player.airS).toBeGreaterThan(0);
  });

  it('puts the tool away to swim and refuses to take one out in the water', () => {
    const g = newGame();
    g.inventory.add('knife', 1);
    run(g, 2, (i, n) => {
      i.triggers.selectSlot = n === 0 ? 'knife' : null;
    });
    run(g, 60);
    expect(g.equipment.slot).toBe('knife');
    g.player.yawRad = 0.0;
    run(g, 60 * 25, (i) => {
      i.move.moveForward = 1;
    });
    expect(g.player.swimming).toBe(true);
    expect(g.equipment.slot).toBe('hands');
    const events = run(g, 2, (i, n) => {
      i.triggers.selectSlot = n === 0 ? 'knife' : null;
    });
    expect(events.some((e) => e.type === 'message' && e.text === 'Not while swimming')).toBe(true);
  });

  it('is carried back by a current past the edge of the world', () => {
    const g = newGame();
    g.player.yawRad = 0.0;
    run(g, 60 * 25, (i) => {
      i.move.moveForward = 1;
    });
    const p = g.player;
    // put the swimmer out beyond the border, at sea north of the channel
    const r0 = (LAGOON_PLAYER.borderStartM + LAGOON_PLAYER.borderEndM) / 2;
    p.pos.x = LAGOON_CENTRE.x;
    p.pos.z = LAGOON_CENTRE.z - r0;
    run(g, 60 * 5);
    expect(Math.hypot(p.pos.x - LAGOON_CENTRE.x, p.pos.z - LAGOON_CENTRE.z)).toBeLessThan(r0 - 2);
    expect(p.current).toBeGreaterThanOrEqual(0);
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
