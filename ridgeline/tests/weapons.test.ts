import { describe, expect, it } from 'vitest';
import { HELICOPTERS, PHYSICS, WEAPONS } from '../src/config.ts';
import { Rng } from '../src/core/rng.ts';
import { Vec3 } from '../src/core/vec.ts';
import { Helicopter } from '../src/sim/helicopter.ts';
import { armourFactor, GroundForce } from '../src/sim/targets.ts';
import { Armament, type Hardpoints } from '../src/sim/weapons.ts';

// The weapons against parked vehicles on flat ground, from a helicopter held
// still in the air (its flight is the rotor tests' business): rounds fly and
// fall, armour by aspect decides what a gun can kill, a missile locked before
// launch comes down on the roof, the ripple and the barrel heat behave.

const flat = (): number => 0;
const HP: Hardpoints = {
  gun: [0, -1.28, -3.9],
  pods: [
    [-1.3, -0.75, -1.2],
    [1.3, -0.75, -1.2],
  ],
  rails: [
    [-2.2, -0.6, -1.1],
    [2.2, -0.6, -1.1],
  ],
};

function setup(altitudeM: number): { h: Helicopter; arm: Armament; force: GroundForce } {
  const h = new Helicopter(HELICOPTERS.warden);
  h.placeInFlight(0, altitudeM, 0, 0, 0);
  const rng = new Rng(7);
  const arm = new Armament(HP, () => rng.next());
  const force = new GroundForce({ groundAt: flat, riverX: () => 0 });
  force.targets.length = 0;
  return { h, arm, force };
}

/** Runs the armament with the helicopter frozen in place, sighting `aim` from the gunner's eye. */
function run(s: ReturnType<typeof setup>, seconds: number, aim: Vec3, trigger: (t: number) => boolean): void {
  const eye = s.h.position.clone();
  const look = aim.clone().sub(eye).normalize();
  for (let t = 0; t < seconds; t += PHYSICS.stepSeconds) {
    s.arm.step(PHYSICS.stepSeconds, s.h, trigger(t), eye, look, aim, s.force, flat);
    s.force.step(PHYSICS.stepSeconds);
  }
}

describe('weapons', () => {
  it('scales damage by the side that is hit', () => {
    const { force } = setup(100);
    // Facing north (−z): a shot travelling south (+z) meets its front.
    const tank = force.add('tank', 0, -1000, 0, null);
    expect(armourFactor(tank, new Vec3(0, -0.1, 1))).toBe(0.08);
    expect(armourFactor(tank, new Vec3(1, -0.1, 0))).toBe(0.45);
    expect(armourFactor(tank, new Vec3(0, -0.1, -1))).toBe(0.8);
    expect(armourFactor(tank, new Vec3(0.2, -1, 0.1))).toBe(1);
  });

  it('kills a truck with a short burst, but the gun cannot get through a tank from the front', () => {
    const s = setup(60);
    const truck = s.force.add('truck', 30, -700, Math.PI / 2, null);
    // Facing the helicopter (south): the gun meets the front armour.
    const tank = s.force.add('tank', -40, -700, Math.PI, null);
    run(s, 4, GroundForce.centre(truck, new Vec3()), (t) => t < 2);
    expect(truck.alive).toBe(false);
    run(s, 8, GroundForce.centre(tank, new Vec3()), (t) => t < 5);
    expect(tank.alive).toBe(true);
    expect(tank.health).toBeGreaterThan(1.5);
    expect(s.arm.rounds).toBeLessThan(WEAPONS.gun.rounds - 60);
  });

  it('overheats in a long burst and cools down to fire again', () => {
    const s = setup(60);
    run(s, 14, new Vec3(0, 0, -900), () => true);
    expect(s.arm.overheated || s.arm.heat > 0.5).toBe(true);
    const fired = WEAPONS.gun.rounds - s.arm.rounds;
    // Without the heat limit 14 s would be 140 rounds.
    expect(fired).toBeLessThan(135);
    run(s, 10, new Vec3(0, 0, -900), () => false);
    expect(s.arm.overheated).toBe(false);
  });

  it('locks a tank in the sight and kills it from the front with a top-attack missile', () => {
    const s = setup(80);
    s.arm.selected = 'missile';
    const tank = s.force.add('tank', 0, -3200, Math.PI, null);
    let peak = 0;
    const aim = GroundForce.centre(tank, new Vec3());
    const eye = s.h.position.clone();
    const look = aim.clone().sub(eye).normalize();
    for (let t = 0; t < 20; t += PHYSICS.stepSeconds) {
      s.arm.step(PHYSICS.stepSeconds, s.h, t > 0.5 && t < 0.6, eye, look, aim, s.force, flat);
      for (const m of s.arm.shots) peak = Math.max(peak, m.position.y);
    }
    expect(s.arm.missiles).toBe(WEAPONS.missile.count - 1);
    expect(tank.alive).toBe(false);
    // It climbed above the launch height before diving.
    expect(peak).toBeGreaterThan(140);
  });

  it('will not lock a target hidden behind a ridge', () => {
    const s = setup(30);
    s.arm.selected = 'missile';
    const ridge = (_x: number, z: number): number => (z < -1000 && z > -1200 ? 120 : 0);
    const tank = s.force.add('tank', 0, -2500, 0, null);
    const aim = GroundForce.centre(tank, new Vec3());
    const eye = s.h.position.clone();
    s.arm.step(PHYSICS.stepSeconds, s.h, false, eye, aim.clone().sub(eye).normalize(), aim, s.force, ridge);
    expect(s.arm.lock).toBe(null);
    s.arm.step(PHYSICS.stepSeconds, s.h, false, eye, aim.clone().sub(eye).normalize(), aim, s.force, flat);
    expect(s.arm.lock).toBe(tank);
  });

  it('fires rockets in ripples and they land near the ballistic cue', () => {
    const s = setup(150);
    s.arm.selected = 'rockets';
    s.arm.cycleRipple();
    expect(s.arm.ripple).toBe(4);
    const cue = s.arm.rocketImpact(s.h, flat, new Vec3());
    expect(cue).not.toBe(null);
    run(s, 12, new Vec3(0, 0, -1000), (t) => t < 0.1);
    expect(s.arm.rockets).toBe(WEAPONS.rockets.count - 4);
    const hits = s.arm.blasts.filter((b) => b.kind === 'blast');
    expect(hits.length).toBe(4);
    // Fired almost level, they come down at a grazing angle: the ripple strings out along the line of
    // fire, but its centre is on the cue.
    const mean = hits.reduce((m, b) => m.add(b.position), new Vec3()).scale(1 / hits.length);
    expect(mean.distanceTo(cue ?? new Vec3())).toBeLessThan(40);
    for (const b of hits) expect(Math.abs(b.position.x - (cue?.x ?? 0))).toBeLessThan(25);
  });
});
