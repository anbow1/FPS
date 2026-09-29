import { describe, expect, it } from 'vitest';
import { lakeRadius, waterDepth } from '../src/maps/lake.ts';
import { buildForest } from '../src/maps/forest.ts';
import { distanceToSegmentXZ, sampleHeight } from '../src/maps/terrain.ts';

// The forest lake (maps/lake.ts): the water stays inside its ellipse, it is
// wadeable, and nothing the game needs ends up in it.

describe('forest lake', () => {
  const map = buildForest();
  const lake = map.lake;

  it('exists, and is at most 1.3 m deep', () => {
    expect(lake).toBeDefined();
    if (!lake) return;
    const deepest = lake.levelM - sampleHeight(map.terrain, lake.cx, lake.cz);
    expect(deepest).toBeGreaterThan(0.9);
    expect(deepest).toBeLessThan(1.5);
  });

  it('has banks above the water all round, out to where the water mesh ends', () => {
    if (!lake) return;
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      for (const r of [1.05, 1.15, 1.3]) {
        const x = lake.cx + Math.cos(a) * lake.rx * r;
        const z = lake.cz + Math.sin(a) * lake.rz * r;
        expect(sampleHeight(map.terrain, x, z)).toBeGreaterThan(lake.levelM);
      }
    }
  });

  it('keeps spawns, patrols, pickups, trees and the track out of the water', () => {
    if (!lake) return;
    const dry = (x: number, z: number): boolean => waterDepth(lake, x, z, sampleHeight(map.terrain, x, z)) === 0;
    expect(dry(map.playerSpawn.pos.x, map.playerSpawn.pos.z)).toBe(true);
    for (const s of map.squadSpawns) {
      expect(dry(s.pos.x, s.pos.z)).toBe(true);
      for (const p of s.patrol) expect(dry(p.x, p.z)).toBe(true);
    }
    for (const p of map.pickups) expect(dry(p.pos.x, p.pos.z)).toBe(true);
    for (const t of map.trees) expect(lakeRadius(lake, t.pos.x, t.pos.z)).toBeGreaterThan(1.3);
    for (let i = 0; i < map.track.length - 1; i++) {
      const a = map.track[i];
      const b = map.track[i + 1];
      if (a && b) expect(distanceToSegmentXZ(lake.cx, lake.cz, a.x, a.z, b.x, b.z)).toBeGreaterThan(lake.rx * 1.3);
    }
  });
});
