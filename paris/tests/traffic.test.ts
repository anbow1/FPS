import { describe, expect, it } from 'vitest';
import { TRAFFIC } from '../src/config.ts';
import { idmAccel, lights, Traffic } from '../src/life/traffic.ts';

describe('intelligent driver model', () => {
  it('accelerates on a free road and stops accelerating at the desired speed', () => {
    expect(idmAccel(0, 12, 1e4, 0)).toBeCloseTo(TRAFFIC.maxAccelMs2, 3);
    expect(Math.abs(idmAccel(12, 12, 1e4, 0))).toBeLessThan(0.01);
  });

  it('brakes hard when closing fast on a standing car', () => {
    expect(idmAccel(12, 12, 15, 12)).toBeLessThan(-TRAFFIC.comfortDecelMs2);
  });
});

describe('traffic', () => {
  it('holds the boulevard at the red light, then lets it go on green', () => {
    const traffic = new Traffic(1889);
    const dt = 0.01;
    let t = -6;
    const away = traffic.lanes[0]!;
    const inLane = traffic.vehicles.filter((v) => v.lane === away);
    // Run up to just before green: nobody standing short of the line has crossed it.
    while (t < TRAFFIC.greenAtS - 0.05) {
      traffic.step(dt, t);
      t += dt;
    }
    const stopS = away.stopS as number;
    const queued = inLane.filter((v) => v.s < stopS && v.s > stopS - 40);
    expect(queued.length).toBeGreaterThan(0);
    for (const v of queued) expect(v.s + v.lengthM / 2).toBeLessThanOrEqual(stopS + 0.6);
    // The first in the queue stands at the line (those behind may still be rolling up to it).
    expect(queued.reduce((a, b) => (a.s > b.s ? a : b)).v).toBeLessThan(0.3);
    // Five seconds of green: the head of the queue has gone over the line.
    while (t < TRAFFIC.greenAtS + 5) {
      traffic.step(dt, t);
      t += dt;
    }
    const head = queued.reduce((a, b) => (a.s > b.s ? a : b));
    expect(head.s).toBeGreaterThan(stopS + 3);
  });

  it('never lets a car drive into the one ahead', () => {
    const traffic = new Traffic(7);
    for (let k = 0; k < 2000; k++) traffic.step(0.01, -6 + k * 0.01);
    for (const lane of traffic.lanes) {
      const list = traffic.vehicles.filter((v) => v.lane === lane).sort((a, b) => a.s - b.s);
      for (let i = 1; i < list.length; i++) expect(list[i]!.s - list[i - 1]!.s).toBeGreaterThan((list[i]!.lengthM + list[i - 1]!.lengthM) / 2 - 0.05);
    }
  });

  it('gives the cross street its green while the boulevard waits', () => {
    expect(lights(0)).toEqual({ boulevard: false, cross: true });
    expect(lights(TRAFFIC.greenAtS + 0.1)).toEqual({ boulevard: true, cross: false });
  });
});
