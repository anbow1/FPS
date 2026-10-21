import { describe, expect, it } from 'vitest';
import { PEOPLE, STREET } from '../src/config.ts';
import { buildPlan } from '../src/city/plan.ts';
import { Crowd } from '../src/life/crowd.ts';

describe('crowd', () => {
  const plan = buildPlan(1859);

  it('keeps walkers on the pavements, off the terraces, within the span', () => {
    const crowd = new Crowd(plan, 48, -6);
    for (let k = 0; k < 1500; k++) crowd.step(0.02, -6 + k * 0.02, true);
    for (const p of crowd.people.filter((q) => q.mode === 'walk')) {
      const ax = Math.abs(p.x);
      expect(ax).toBeGreaterThan(STREET.treeXM + 0.3);
      expect(ax).toBeLessThan(STREET.facadeHalfM - 0.4);
      expect(p.z).toBeLessThanOrEqual(PEOPLE.spanNearZM + 0.1);
      expect(p.z).toBeGreaterThanOrEqual(PEOPLE.spanFarZM - 0.1);
      for (const c of plan.cafes) {
        if (Math.sign(p.x) === c.side && p.z > c.zMin && p.z < c.zMax) expect(ax).toBeLessThan(STREET.facadeHalfM - 3.1);
      }
    }
  });

  it('walks at people speeds', () => {
    const crowd = new Crowd(plan, 48, -6);
    for (let k = 0; k < 500; k++) crowd.step(0.02, -6 + k * 0.02, true);
    const speeds = crowd.people.filter((q) => q.mode === 'walk').map((q) => q.speedMs);
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    expect(mean).toBeGreaterThan(1.0);
    expect(mean).toBeLessThan(1.6);
  });

  it('sends the waiting people across the boulevard while it is red', () => {
    const crowd = new Crowd(plan, 48, -6);
    const waiting = crowd.people.filter((q) => q.mode === 'wait');
    expect(waiting.length).toBeGreaterThan(0);
    for (let k = 0; k < 1200; k++) crowd.step(0.02, -6 + k * 0.02, true);
    // 24 s later, everyone who set off has reached the far side and joined the walkers.
    for (const p of waiting) expect(p.mode).toBe('walk');
  });
});
