import { describe, expect, it } from 'vitest';
import { CITY, PLAY_HALF } from '../src/config';
import { CityPlan, halfX, halfZ, lineX, lineZ, type Lot } from '../src/world/cityPlan';
import { LAKES } from '../src/world/layout';
import { BuildingIndex } from '../src/world/buildingIndex';
import { segmentObb, type Obb } from '../src/world/buildings';
import { Rng } from '../src/core/rng';

const plan = new CityPlan(20260923 + 31);

/** The four corners of a lot's footprint, world xz. */
function corners(l: Lot): [number, number][] {
  const c = Math.cos(l.rotRad);
  const s = Math.sin(l.rotRad);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const x = (sx! * l.w) / 2;
    const z = (sz! * l.d) / 2;
    return [l.x + x * c + z * s, l.z - x * s + z * c];
  });
}

describe('town plan', () => {
  it('covers about a third of the play area', () => {
    const area = (CITY.x1M - CITY.x0M) * (CITY.z1M - CITY.z0M);
    const share = area / (2 * PLAY_HALF) ** 2;
    expect(share).toBeGreaterThan(0.29);
    expect(share).toBeLessThan(0.37);
  });

  it('has a church square, tenements, estates, works and parks', () => {
    const kinds = new Set(plan.blocks.map((b) => b.kind));
    for (const k of ['square', 'tenement', 'estate', 'industrial', 'park'] as const) expect(kinds.has(k)).toBe(true);
    expect(plan.lots.length).toBeGreaterThan(450);
  });

  it('keeps every house off the carriageways and pavements', () => {
    for (const l of plan.lots) {
      for (const [x, z] of corners(l)) {
        const g = plan.surfaceAt(x, z);
        expect(g === 'street' || g === 'walk', `lot at ${l.x.toFixed(1)},${l.z.toFixed(1)} corner on the ${g}`).toBe(false);
      }
    }
  });

  it('builds nothing on the lake or its shore', () => {
    for (const l of plan.lots) for (const lake of LAKES) expect(Math.hypot(l.x - lake.x, l.z - lake.z)).toBeGreaterThan(lake.r * 1.5);
  });

  it('gives windowed gable ends only to corner houses, whose ends face a street', () => {
    for (const l of plan.lots.filter((q) => q.windows === 1 || q.windows === 2)) {
      if (!l.openLeft && !l.openRight) continue;
      // a step 3 m outside an open end lands on a pavement or a carriageway
      const c = Math.cos(l.rotRad);
      const s = Math.sin(l.rotRad);
      const side = l.openLeft ? -1 : 1;
      const x = (side * (l.w / 2 + 3));
      const g = plan.surfaceAt(l.x + x * c, l.z - x * s);
      expect(g === 'walk' || g === 'street', `open end of ${l.x.toFixed(1)},${l.z.toFixed(1)} faces ${g}`).toBe(true);
    }
  });

  it('makes frontages and corner-house depths whole even numbers of bays', () => {
    for (const l of plan.lots) {
      const bays = l.w / l.bayM;
      expect(Math.abs(bays - Math.round(bays))).toBeLessThan(1e-6);
      expect(Math.round(bays) % 2).toBe(0);
      if (l.openLeft || l.openRight) {
        const deep = l.d / l.bayM;
        expect(Math.abs(deep - Math.round(deep))).toBeLessThan(1e-6);
        expect(Math.round(deep) % 2).toBe(0);
      }
    }
  });

  it('puts the lamps at the kerb and outside the junctions', () => {
    expect(plan.lamps.length).toBeGreaterThan(500);
    for (const p of plan.lamps) {
      expect(plan.surfaceAt(p.x, p.z)).toBe('walk');
    }
  });

  it('snaps a goal in a courtyard onto a street', () => {
    const b = plan.blocks.find((q) => q.kind === 'tenement')!;
    const out = { x: 0, z: 0 };
    expect(plan.snapToStreet((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, out)).toBe(true);
    expect(plan.isStreet(out.x, out.z)).toBe(true);
  });

  it('reads the ring streets on the rectangle edges as carriageway', () => {
    const mid = (CITY.z0M + CITY.z1M) / 2;
    expect(plan.surfaceAt(lineX(0) + halfX(0) - 0.5, mid + 13)).not.toBe('outside');
    expect(plan.surfaceAt(CITY.x0M + 10, lineZ(CITY.blocksZ) - halfZ(CITY.blocksZ) + 0.5)).toBe('street');
  });
});

describe('building index', () => {
  const rng = new Rng(5);
  const items: Obb[] = [];
  for (let k = 0; k < 400; k++) {
    items.push({ x: rng.range(-900, 900), z: rng.range(-900, 900), y0: 0, y1: 20, hw: rng.range(2, 25), hd: rng.range(2, 12), rot: rng.range(0, Math.PI) });
  }
  const index = new BuildingIndex(items);

  it('finds every collider a segment hits, as a full scan does', () => {
    const out: number[] = [];
    for (let k = 0; k < 300; k++) {
      const ax = rng.range(-1000, 1000);
      const az = rng.range(-1000, 1000);
      const bx = ax + rng.range(-800, 800);
      const bz = az + rng.range(-800, 800);
      const brute = items.map((c, i) => (segmentObb(c, ax, 10, az, bx, 10, bz) >= 0 ? i : -1)).filter((i) => i >= 0);
      const cand = new Set(index.alongSegment(ax, az, bx, bz, out));
      for (const i of brute) expect(cand.has(i), `segment ${k} missed collider ${i}`).toBe(true);
    }
  });

  it('returns each collider once from a circle query', () => {
    const out = index.near(0, 0, 200, []);
    expect(new Set(out).size).toBe(out.length);
  });
});
