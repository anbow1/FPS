import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat.ts';
import { Rng } from '../src/core/rng.ts';
import { Vec3 } from '../src/core/vec.ts';
import type { RadarBody } from '../src/sim/radar.ts';
import { createStores, type Decoy, dispense, GUN, gunImpact, MISSILES, Missile, predictShot, stepDecoy } from '../src/sim/weapons.ts';

// Game-abstraction checks: the numbers are invented, the behaviour is what the brief asks for.

function body(x: number, y: number, z: number, yawRad: number, speed: number): RadarBody {
  const q = new Quat().setFromYawPitchRoll(yawRad, 0, 0);
  return { id: 1, position: new Vec3(x, y, z), velocity: q.rotate(new Vec3(0, 0, -speed)), orientation: q, signatureFront: 1, signatureSide: 1, alive: true };
}

describe('gun', () => {
  it('takes about a second to reach 1 km and drops below the gun line', () => {
    const own = new Vec3(0, 3000, 0);
    const vel = new Vec3(0, 0, -250);
    const { point, tofS } = gunImpact(own, vel, new Vec3(0, 0, -1), 1000);
    expect(tofS).toBeGreaterThan(0.85);
    expect(tofS).toBeLessThan(1.4);
    expect(point.y).toBeLessThan(3000 - 3);
    expect(GUN.rounds).toBeGreaterThan(100);
  });
});

describe('missiles', () => {
  it('short range: a tail shot inside 4 km connects, one from 12 km does not', () => {
    const launch = new Vec3(0, 5000, 0);
    const vel = new Vec3(0, 0, -250);
    expect(predictShot(MISSILES.srm, launch, vel, body(0, 5000, -3500, 0, 250)).hit).toBe(true);
    expect(predictShot(MISSILES.srm, launch, vel, body(0, 5000, -12_000, 0, 280)).hit).toBe(false);
  });

  it('medium range: head-on at 30 km connects, a long shot at a beaming target runs out of energy', () => {
    const launch = new Vec3(0, 8000, 0);
    const vel = new Vec3(0, 0, -280);
    expect(predictShot(MISSILES.mrm, launch, vel, body(0, 8000, -30_000, Math.PI, 250)).hit).toBe(true);
    expect(predictShot(MISSILES.mrm, launch, vel, body(0, 8000, -70_000, Math.PI / 2, 280)).hit).toBe(false);
  });

  it('one salvo of flares decoys an infrared seeker sometimes, not always', () => {
    let decoyed = 0;
    for (let trial = 0; trial < 40; trial++) {
      const rng = new Rng(trial + 1);
      const target = body(0, 5000, -3000, 0, 250);
      const m = new Missile(MISSILES.srm, 0, 1, new Vec3(0, 5000, 0), new Vec3(0, 0, -250), target.position);
      const decoys: Decoy[] = [];
      const stores = createStores('talon');
      for (let t = 0; t < 15 && m.state === 'guiding'; t += 1 / 60) {
        target.position.addScaled(target.velocity, 1 / 60);
        // A single salvo a second after launch.
        if (decoys.length === 0 && t > 1) dispense(stores, 'flare', target.position, target.velocity, 1, decoys);
        for (const d of decoys) stepDecoy(d, 1 / 60);
        m.step(1 / 60, target, false, decoys, new Vec3(0, 1, 0), () => rng.next());
      }
      if (m.decoyed) decoyed++;
    }
    expect(decoyed).toBeGreaterThan(6);
    expect(decoyed).toBeLessThan(30);
  });
});
