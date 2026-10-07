import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.ts';
import { Vec3 } from '../src/core/vec.ts';
import { Aircraft } from '../src/sim/aircraft.ts';
import { steer } from '../src/sim/autopilot.ts';
import { Combat, createEvents, type Orders } from '../src/sim/combat.ts';
import { neutralInput } from '../src/sim/controlLaws.ts';
import { Opponent } from '../src/sim/opponent.ts';

const flat = (): number => 0;

describe('flight director', () => {
  it('turns onto a new heading and holds its altitude', () => {
    const ac = new Aircraft('talon', 0.6);
    ac.placeInFlight(0, 5000, 0, 0, 230);
    const input = neutralInput();
    // Fly east (+x).
    for (let t = 0; t < 40; t += 1 / 60) {
      steer(ac, { direction: new Vec3(1, 0, 0), speedMs: 240, maxG: 5 }, input);
      ac.step(input, 1 / 60, flat);
    }
    const v = ac.velocity.clone().normalize();
    expect(v.x).toBeGreaterThan(0.95);
    expect(Math.abs(ac.position.y - 5000)).toBeLessThan(600);
    expect(ac.crashed).toBe(false);
  });
});

describe('duel', () => {
  it('two AI pilots find each other, fight, and neither flies into the ground', () => {
    const rng = new Rng(7);
    const combat = new Combat(() => rng.next());
    const a = combat.add('wraith', false);
    const b = combat.add('talon', false);
    a.aircraft.placeInFlight(0, 6000, 0, 0, 250);
    b.aircraft.placeInFlight(0, 7000, -40_000, Math.PI, 250);
    const ai = [new Opponent(a, combat, 'hard', new Vec3(0, 6000, 0), () => rng.next()), new Opponent(b, combat, 'hard', new Vec3(0, 7000, -40_000), () => rng.next())];
    const eyes = (): boolean => false;
    const sun = new Vec3(0.3, 0.8, 0.5).normalize();
    let launches = 0;
    let sawDefend = false;
    for (let t = 0; t < 150 && a.alive && b.alive; t += 1 / 60) {
      const orders = new Map<number, Orders>();
      for (const o of ai) {
        orders.set(o.me.id, o.update(1 / 60, flat, eyes));
        if (o.state === 'defend') sawDefend = true;
      }
      const ev = createEvents();
      combat.step(1 / 60, orders, flat, sun, ev);
      launches += ev.launches.length;
      for (const f of combat.fighters) {
        expect(Number.isFinite(f.aircraft.position.x + f.aircraft.position.y + f.aircraft.position.z)).toBe(true);
      }
    }
    expect(launches).toBeGreaterThan(0);
    expect(sawDefend).toBe(true);
    // Shot down is fine; flying into the ground is not.
    for (const f of combat.fighters) expect(f.aircraft.crashed && f.health > 0).toBe(false);
  });
});
