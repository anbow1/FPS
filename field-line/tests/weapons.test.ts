import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game.ts';
import { buildMap } from '../src/maps/index.ts';
import { idleIntent, STEP_S } from './helpers.ts';

describe('aiming down sights', () => {
  it('holds fully aimed while aim is held, instead of oscillating below 1', () => {
    const game = new Game(buildMap('range'), 'range', 5);
    const seen: number[] = [];
    for (let s = 0; s < 120; s++) {
      const i = idleIntent();
      i.weapon.aimHeld = true;
      i.player.aiming = true;
      game.step(i, STEP_S);
      if (s >= 60) seen.push(game.weapons.adsBlend);
    }
    expect(Math.min(...seen)).toBe(1);
  });

  it('returns to the hip when aim is released', () => {
    const game = new Game(buildMap('range'), 'range', 5);
    for (let s = 0; s < 60; s++) {
      const i = idleIntent();
      i.weapon.aimHeld = true;
      game.step(i, STEP_S);
    }
    for (let s = 0; s < 60; s++) game.step(idleIntent(), STEP_S);
    expect(game.weapons.adsBlend).toBe(0);
  });
});
