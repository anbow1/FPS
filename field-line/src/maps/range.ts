import { MODES, type SurfaceKind } from '../config.ts';
import { fbm2 } from '../core/noise.ts';
import { Vec3 } from '../core/vec.ts';
import { MapBuilder } from './builder.ts';
import { makeHeightfield } from './terrain.ts';
import type { MapData, RangeTarget, TreeInstance } from './types.ts';

// Shooting range (brief: build this first). A flat 80 m wide lane with side
// berms runs 850 m north from a covered firing line to a backstop berm.
// Steel plates stand at 100–800 m, staggered so near plates never mask far
// ones, sized to about 3.5 mil so every plate reads the same through the scope.
// The two training dummies at 25 m are spawned by the game (range mode).

const TERRAIN_HALF_M = 880;
const PLAYABLE_HALF_M = 100; // nav grid and AI only need the firing area
const LANE_HALF_M = 40;
const BACKSTOP_Z_M = -845;

function heightAt(x: number, z: number): number {
  const outside = fbm2(x / 150, z / 150, 4, 3) * 6 + 3;
  const side = Math.abs(x) - LANE_HALF_M;
  let h = 0;
  if (side > 0) h = Math.min(1, side / 14) * 6 + Math.max(0, side - 14) * 0.05 + outside * Math.min(1, Math.max(0, side - 20) / 40);
  if (z < BACKSTOP_Z_M) h = Math.max(h, Math.min(15, (BACKSTOP_Z_M - z) * 0.9));
  if (z > 60) h = Math.max(h, Math.min(8, (z - 60) * 0.25) + outside * Math.min(1, (z - 60) / 60));
  return h;
}

export function buildRange(): MapData {
  const terrain = makeHeightfield(TERRAIN_HALF_M, 5, heightAt, (): SurfaceKind => 'soil');
  const b = new MapBuilder(terrain, 1901);

  // Covered firing line: a concrete pad, a roof on posts, a bench and sandbag rests.
  b.boxOnBase('concrete', 0, 0, 1.5, 24, 0.12, 6);
  // A timber roof: boarded underneath, felt only on top. The whole slab was felt (albedo ~0.04), so its
  // underside, lit only by what the pad and the grass bounce up, read as a black band across the view;
  // so did the dark steel posts against the sky. Both are timber now: the map's existing wood look, so
  // the merged world mesh gains neither a material nor a draw call.
  b.boxOnBase('wood', 0, 3.1, 2.0, 24, 0.21, 7);
  b.boxOnBase('roofTar', 0, 3.31, 2.0, 24, 0.04, 7);
  for (const x of [-11.5, -4, 4, 11.5]) {
    b.boxOnBase('wood', x, 0.12, -1.2, 0.2, 3.0, 0.2);
    b.boxOnBase('wood', x, 0.12, 5.2, 0.2, 3.0, 0.2);
  }
  b.boxOnBase('wood', 3.5, 0.12, -0.6, 2.2, 0.8, 0.8); // bench
  b.boxOnBase('sandbag', -3.0, 0.12, -1.0, 1.6, 0.35, 0.6); // prone rest
  b.boxOnBase('sandbag', -6.0, 0.12, -1.0, 1.6, 0.35, 0.6);
  b.prop('crate', 6.5, 1.0, 0.3, { baseY: 0.12, scale: 0.8 });

  // Steel plates: plate centre 1.0 m above ground on two posts, staggered in X.
  const rangeTargets: RangeTarget[] = [];
  MODES.rangeTargetDistancesM.forEach((d, i) => {
    const x = -17.5 + i * 5;
    const z = -d;
    const size = Math.max(0.3, d * 0.0035);
    const pos = new Vec3(x, 1.0 + size / 2, z);
    b.box('targetSteel', pos.x, pos.y, pos.z, size, size, 0.03);
    b.boxOnBase('wood', x - size * 0.35, 0, z + 0.06, 0.08, 1.0 + size * 0.3, 0.08, 0, { blocksVision: false });
    b.boxOnBase('wood', x + size * 0.35, 0, z + 0.06, 0.08, 1.0 + size * 0.3, 0.08, 0, { blocksVision: false });
    b.prop('rangeSign', x + size / 2 + 1.4, z + 0.5, 0, { label: `${d}` });
    rangeTargets.push({ pos, sizeM: size, distanceM: d });
  });

  // A tree line behind the side berms: scale and a wind cue out to 800 m.
  const trees: TreeInstance[] = [];
  for (let z = 40; z > BACKSTOP_Z_M - 20; z -= 9) {
    for (const side of [-1, 1]) {
      const x = side * (LANE_HALF_M + 26 + b.rng.range(0, 22));
      trees.push({ pos: new Vec3(x, b.ground(x, z), z), heightM: b.rng.range(15, 24), yawRad: b.rng.range(0, 6.28), seed: b.rng.int(0, 1e6) });
    }
  }

  return {
    id: 'range',
    label: 'Range',
    halfSizeM: PLAYABLE_HALF_M,
    terrain,
    boxes: b.boxes,
    props: b.props,
    trees,
    bushes: [],
    roads: [],
    track: [],
    playerSpawn: { pos: new Vec3(0, 0.12, 1.0), yawRad: 0 },
    squadSpawns: [],
    reinforcementSpawns: [],
    interiors: [],
    bulbs: [],
    pickups: [{ kind: 'ammoPack', pos: new Vec3(3.5, 0.95, -0.6) }],
    extraction: { hold: new Vec3(0, 0, -50), exit: new Vec3(0, 0, 0) },
    rangeTargets,
    groundSurface: 'soil',
    wetDefault: false,
    // Rough grass on the berms and beyond; the lane itself and the firing line are mown.
    undergrowth: { bounds: [-220, BACKSTOP_Z_M - 20, 220, 160], mown: [[-LANE_HALF_M + 4, BACKSTOP_Z_M, LANE_HALF_M - 4, 60], [-16, -6, 16, 10]], ferns: false },
  };
}
