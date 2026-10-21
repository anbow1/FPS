import { describe, expect, it } from 'vitest';
import { STREET } from '../src/config.ts';
import { buildPlan, corniceY, groundY, inCrossing } from '../src/city/plan.ts';

describe('street plan', () => {
  const plan = buildPlan(1859);

  it('fills each boulevard front between the crossings with lots that neither overlap nor leave gaps', () => {
    for (const side of [-1, 1]) {
      const lots = plan.lots.filter((l) => l.boulevard && l.side === side).sort((a, b) => b.zMax - a.zMax);
      for (let i = 1; i < lots.length; i++) {
        const prev = lots[i - 1]!;
        const cur = lots[i]!;
        // Either the next lot starts where this one ends, or a cross street lies between.
        const touching = Math.abs(prev.zMin - cur.zMax) < 1e-6;
        expect(touching || inCrossing((prev.zMin + cur.zMax) / 2) !== null).toBe(true);
      }
      for (const l of lots) expect(l.zMax - l.zMin).toBeGreaterThan(10);
    }
  });

  it('keeps the cornice line near 20 m, as the 1859 and 1884 rules have it', () => {
    for (const l of plan.lots) {
      expect(corniceY(l)).toBeGreaterThan(16);
      expect(corniceY(l)).toBeLessThan(21);
    }
  });

  it('plants no tree and parks no car in a crossing', () => {
    for (const t of plan.trees) expect(inCrossing(t.z, 2)).toBeNull();
    for (const p of plan.parked) expect(inCrossing(p.z, 8)).toBeNull();
  });

  it('puts the pavement a kerb above the carriageway', () => {
    expect(groundY(0, -20)).toBe(0);
    expect(groundY(12, -20)).toBeCloseTo(STREET.kerbM);
    // In a cross street's carriageway the ground is road level again.
    const c = STREET.crossings[0];
    expect(groundY(12, c.zM)).toBe(0);
  });

  it('is the same street for the same seed', () => {
    expect(JSON.stringify(buildPlan(1859))).toBe(JSON.stringify(plan));
  });
});
