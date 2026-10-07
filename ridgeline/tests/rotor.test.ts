import { describe, expect, it } from 'vitest';
import { HELICOPTERS, type HeliId, PHYSICS } from '../src/config.ts';
import { Vec3 } from '../src/core/vec.ts';
import { Helicopter, type HeliInput, neutralHeliInput } from '../src/sim/helicopter.ts';

// The rotorcraft's behaviour against the brief's acceptance list, flown by a
// simple test pilot (PD loops on attitude, heading and climb rate) because a
// helicopter cannot be left alone in a hover — that is the point.

const flat = (): number => 0;

function attitude(h: Helicopter): { pitch: number; roll: number; heading: number } {
  const fwd = h.orientation.rotate(new Vec3(0, 0, -1));
  const right = h.orientation.rotate(new Vec3(1, 0, 0));
  return { pitch: Math.asin(fwd.y), roll: Math.asin(-right.y), heading: Math.atan2(-fwd.x, -fwd.z) };
}

interface Goal {
  pitch?: number;
  vy?: number;
  speed?: number;
  holdPosition?: boolean;
  collective?: number;
  pedal?: number;
}

/** The test pilot: one step of PD control towards the goal. Returns the input it flew. */
function fly(h: Helicopter, goal: Goal, inp: HeliInput, heading0: number): HeliInput {
  const att = attitude(h);
  const w = h.angular;
  // Velocity in heading axes.
  const fwdV = -(Math.sin(att.heading) * h.velocity.x + Math.cos(att.heading) * h.velocity.z);
  const rightV = Math.cos(att.heading) * h.velocity.x - Math.sin(att.heading) * h.velocity.z;
  let pitchTarget = goal.pitch ?? 0;
  let rollTarget = 0;
  if (goal.holdPosition) {
    pitchTarget = Math.max(-0.2, Math.min(0.2, 0.04 * fwdV));
    rollTarget = Math.max(-0.2, Math.min(0.2, -0.04 * rightV));
  } else if (goal.speed !== undefined) {
    pitchTarget = Math.max(-0.25, Math.min(0.2, 0.03 * (fwdV - goal.speed)));
    rollTarget = Math.max(-0.2, Math.min(0.2, -0.04 * rightV));
  }
  inp.cyclicY = Math.max(-1, Math.min(1, 3 * (pitchTarget - att.pitch) - 1.2 * w.x));
  inp.cyclicX = Math.max(-1, Math.min(1, 3 * (rollTarget - att.roll) + 1.0 * w.z));
  let dh = att.heading - heading0;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  inp.pedal = goal.pedal ?? Math.max(-1, Math.min(1, inp.pedal + (2.0 * dh + 2.5 * w.y) * PHYSICS.stepSeconds * 2));
  if (goal.collective !== undefined) inp.collective = goal.collective;
  else if (goal.vy !== undefined) inp.collective = Math.max(0, Math.min(1, inp.collective + (goal.vy - h.velocity.y) * 0.02 - 0.02 * 0));
  return inp;
}

function run(h: Helicopter, seconds: number, goal: Goal, inp: HeliInput, ground = flat): HeliInput {
  const heading0 = attitude(h).heading;
  const steps = Math.round(seconds / PHYSICS.stepSeconds);
  for (let i = 0; i < steps; i++) {
    fly(h, goal, inp, heading0);
    h.step(inp, ground);
  }
  return inp;
}

function hovering(id: HeliId, altitudeM = 600): { h: Helicopter; inp: HeliInput } {
  const h = new Helicopter(HELICOPTERS[id]);
  h.placeInFlight(0, altitudeM, 0, 0, 0);
  const inp: HeliInput = { ...neutralHeliInput(), collective: 0.5, brake: false };
  run(h, 40, { vy: 0, holdPosition: true }, inp);
  return { h, inp };
}

describe('rotorcraft flight model', () => {
  it('hovers at a mid collective and a believable torque', () => {
    for (const id of ['warden', 'bulat'] as const) {
      const { h, inp } = hovering(id);
      expect(h.crashed).toBe(false);
      expect(Math.abs(h.velocity.y)).toBeLessThan(0.3);
      // The test pilot holds position on drift alone, so it settles with a little sideways drift: the
      // roll it needs against the tail rotor's push (a real hover is flown a few degrees wing-low).
      expect(h.velocity.length()).toBeLessThan(3.5);
      expect(inp.collective).toBeGreaterThan(0.35);
      expect(inp.collective).toBeLessThan(0.75);
      expect(h.torquePct).toBeGreaterThan(55);
      expect(h.torquePct).toBeLessThan(92);
      expect(h.rpmPct).toBeGreaterThan(98);
      expect(h.rpmPct).toBeLessThan(102);
    }
  });

  it('swings the nose with collective until the pedals follow', () => {
    for (const [id, sign] of [
      ['warden', -1],
      ['bulat', 1],
    ] as const) {
      const { h, inp } = hovering(id);
      const pedal = inp.pedal;
      run(h, 1.5, { collective: Math.min(1, inp.collective + 0.15), pedal, holdPosition: true }, { ...inp, sas: false });
      // Warden's rotor turns counter-clockwise: more torque swings the nose right (yaw rate negative).
      expect(Math.sign(h.angular.y)).toBe(sign);
      expect(Math.abs(h.angular.y)).toBeGreaterThan(0.05);
    }
  });

  it('needs less power in forward flight than in a hover (translational lift)', () => {
    const { h } = hovering('warden');
    const hoverTorque = h.torquePct;
    const inp: HeliInput = { ...neutralHeliInput(), collective: 0.5, brake: false };
    h.placeInFlight(0, 600, 0, 0, 35);
    run(h, 40, { vy: 0, speed: 35 }, inp);
    expect(Math.abs(h.velocity.y)).toBeLessThan(0.5);
    expect(h.torquePct).toBeLessThan(hoverTorque * 0.8);
  });

  it('hovers on less power in ground effect', () => {
    const high = hovering('warden', 600).h.torquePct;
    const h = new Helicopter(HELICOPTERS.warden);
    h.placeInFlight(0, 2.5, 0, 0, 0);
    const inp: HeliInput = { ...neutralHeliInput(), collective: 0.45, brake: false };
    run(h, 30, { vy: 0, holdPosition: true }, inp);
    expect(h.crashed).toBe(false);
    expect(h.rotor.groundEffect).toBeGreaterThan(0.1);
    expect(h.torquePct).toBeLessThan(high * 0.92);
  });

  it('keeps the rotor turning in an autorotation', () => {
    const h = new Helicopter(HELICOPTERS.warden);
    h.placeInFlight(0, 900, 0, 0, 35);
    const inp: HeliInput = { ...neutralHeliInput(), collective: 0.5, brake: false };
    run(h, 10, { vy: 0, speed: 35 }, inp);
    inp.engines = false;
    run(h, 20, { collective: 0.12, speed: 33 }, inp);
    expect(h.regime).toBe('autorotation');
    expect(h.rpmPct).toBeGreaterThan(90);
    expect(h.rpmPct).toBeLessThan(118);
    expect(h.velocity.y).toBeGreaterThan(-20);
    expect(h.velocity.y).toBeLessThan(-4);
  });

  it('enters a vortex ring when sinking slowly under power, and leaves it with forward speed', () => {
    const { h, inp } = hovering('warden', 1500);
    const hoverCollective = inp.collective;
    // Let it sink to ~9 m/s, then try to stop the descent with collective alone.
    run(h, 6, { collective: hoverCollective - 0.12, holdPosition: true }, inp);
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      run(h, 1 / 60, { collective: Math.min(1, hoverCollective + 0.05), holdPosition: true }, inp);
      peak = Math.max(peak, h.rotor.vortexRing);
    }
    expect(peak).toBeGreaterThan(0.5);
    // The recovery: forward cyclic flies out of the ring.
    run(h, 8, { collective: hoverCollective, pitch: -0.2 }, inp);
    expect(h.rotor.vortexRing).toBeLessThan(0.15);
  });

  it('stalls the retreating blade past its speed limit', () => {
    const h = new Helicopter(HELICOPTERS.warden);
    h.placeInFlight(0, 600, 0, 0, 95);
    const inp: HeliInput = { ...neutralHeliInput(), collective: 0.75, brake: false };
    run(h, 0.5, { vy: 0, speed: 95 }, inp);
    expect(h.rotor.bladeStall).toBeGreaterThan(0.5);
    expect(h.vibration).toBeGreaterThan(0.5);
  });

  it('sits on its wheels when parked', () => {
    const h = new Helicopter(HELICOPTERS.warden);
    h.placeOnGround(0, 0, 0, 0);
    const inp: HeliInput = { ...neutralHeliInput(), collective: 0 };
    for (let i = 0; i < 300; i++) h.step(inp, flat);
    expect(h.crashed).toBe(false);
    expect(h.onGround).toBe(true);
    expect(h.velocity.length()).toBeLessThan(0.05);
    expect(Math.abs(attitude(h).roll)).toBeLessThan(0.02);
  });
});
