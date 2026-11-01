import { describe, expect, it } from 'vitest';
import { MODES } from '../src/config.ts';
import { Vec3 } from '../src/core/vec.ts';
import { CollisionWorld } from '../src/game/collision.ts';
import { EventQueue } from '../src/game/events.ts';
import { Player } from '../src/game/player.ts';
import { MapBuilder } from '../src/maps/builder.ts';
import { enterableBuilding } from '../src/maps/buildings.ts';
import { buildMap } from '../src/maps/index.ts';
import { boulevardPlan, PARIS_SHIFT_Z } from '../src/maps/boulevard.ts';
import { storeysOf } from '../src/paris/city/facade.ts';
import { makeHeightfield } from '../src/maps/terrain.ts';
import type { MapId } from '../src/maps/types.ts';
import { idleIntent, STEP_S } from './helpers.ts';

const MAP_IDS: MapId[] = ['range', 'city', 'forest', 'boulevard'];

describe('map generators', () => {
  it.each(MAP_IDS)('%s builds the same map twice (deterministic)', (id) => {
    const a = buildMap(id);
    const b = buildMap(id);
    expect(a.boxes.length).toBe(b.boxes.length);
    expect(a.props.length).toBe(b.props.length);
    expect(a.trees.length).toBe(b.trees.length);
  });

  it.each(MAP_IDS)('%s spawns the player on open ground, not inside a wall', (id) => {
    const map = buildMap(id);
    const world = new CollisionWorld(map.terrain);
    for (const box of map.boxes) world.addBox(box);
    const p = map.playerSpawn.pos;
    const blocked = world.lineBlocked(new Vec3(p.x, p.y + 0.5, p.z), new Vec3(p.x, p.y + 1.7, p.z), false);
    expect(blocked).toBe(false);
  });

  it('boulevard: every squad spawn, patrol point and pickup stands in the open', () => {
    const map = buildMap('boulevard');
    const world = new CollisionWorld(map.terrain);
    for (const box of map.boxes) world.addBox(box);
    const points = [...map.squadSpawns.flatMap((s) => [s.pos, ...s.patrol]), ...map.pickups.map((p) => p.pos), ...map.reinforcementSpawns, map.extraction.hold, map.extraction.exit];
    for (const p of points) {
      const blocked = world.lineBlocked(new Vec3(p.x, p.y + 0.5, p.z), new Vec3(p.x, p.y + 1.7, p.z), false);
      expect(blocked, `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).toBe(false);
      expect(Math.abs(p.x) < map.halfSizeM && Math.abs(p.z) < map.halfSizeM).toBe(true);
    }
  });

  it('city is 400 × 400 m with four enterable buildings and lit interiors', () => {
    const map = buildMap('city');
    expect(map.halfSizeM * 2).toBe(400);
    expect(map.interiors.length).toBe(4);
    expect(map.bulbs.length).toBeGreaterThanOrEqual(4 * 3 * 2);
    expect(map.boxes.some((b) => b.look === 'glass')).toBe(true);
  });

  it('forest is 800 × 800 m with a ridge high enough for long sightlines', () => {
    const map = buildMap('forest');
    expect(map.halfSizeM * 2).toBe(800);
    let maxH = -Infinity;
    let minH = Infinity;
    for (const h of map.terrain.heightsM) {
      maxH = Math.max(maxH, h);
      minH = Math.min(minH, h);
    }
    expect(maxH - minH).toBeGreaterThan(30);
    expect(map.trees.length).toBeGreaterThan(2000);
  });

  it('range plates stand at every listed distance, down the -Z lane', () => {
    const map = buildMap('range');
    expect(map.rangeTargets.map((t) => t.distanceM)).toEqual([...MODES.rangeTargetDistancesM]);
    for (const t of map.rangeTargets) expect(t.pos.z).toBeCloseTo(-t.distanceM, 5);
  });
});

describe('enterable building', () => {
  it('a player walking up the first flight reaches the first floor (riser 0.17 m)', () => {
    const terrain = makeHeightfield(40, 2, () => 0, () => 'concrete');
    const b = new MapBuilder(terrain, 1);
    // Front faces +Z; lane A climbs toward +Z along the inside of the +X wall.
    enterableBuilding(b, { cx: 0, cz: 0, widthM: 20, depthM: 14, storeys: 2, quarterTurns: 0, baseY: 0, wallLook: 'brick', floorLook: 'tiles' });
    const world = new CollisionWorld(terrain);
    for (const box of b.boxes) world.addBox(box);
    const laneAX = 10 - 0.3 - 0.6;
    const player = new Player(new Vec3(laneAX, 0.05, -7 + 0.3 + 0.6), Math.PI); // yaw π looks down +Z
    const events = new EventQueue();
    const intent = idleIntent();
    intent.player.moveForward = 1;
    for (let i = 0; i < 60 * 6; i++) player.update(intent.player, world, STEP_S, events);
    expect(player.body.position.y).toBeGreaterThan(2.9);
    expect(player.body.position.y).toBeLessThan(3.2);
  });
});

describe('Paris house with rooms (boulevard)', () => {
  it('a player goes in by the shop door, up both flights and out onto the noble balcony', () => {
    const map = buildMap('boulevard');
    const world = new CollisionWorld(map.terrain);
    for (const box of map.boxes) world.addBox(box);
    const lot = boulevardPlan().lots.find((l) => l.enterable);
    if (!lot) throw new Error('no enterable lot');
    const W = lot.widthM;
    const bay = W / lot.bays;
    // Lot frame → map: u along the front, d in from the façade.
    const at = (u: number, d: number): [number, number] => [lot.ox + lot.tx * u - lot.nx * d, lot.oz + lot.tz * u - lot.nz * d + PARIS_SHIFT_Z];
    const laneA = W - 0.3 - 0.6;
    const laneB = laneA - 1.2;
    const aEnd = 2 + Math.round(4.4 / 0.17) * 0.28;
    const bEnd = aEnd - Math.round(3.0 / 0.17) * 0.28;
    const door = (Math.floor(lot.bays / 2) + 0.5) * bay;
    const french = (Math.floor(lot.bays / 2) + 0.5) * bay;
    const route: [number, number][] = [at(door, -2.5), at(door, 1.2), at(laneA, 1.4), at(laneA, aEnd + 0.9), at(laneB, aEnd + 0.9), at(laneB, aEnd - 0.1), at(laneB, bEnd - 1.0), at(french, 1.2), at(french, -0.35)];
    const [sx, sz] = route[0] as [number, number];
    const player = new Player(new Vec3(sx, 0.2, sz), 0);
    const events = new EventQueue();
    const intent = idleIntent();
    intent.player.moveForward = 1;
    for (const [tx, tz] of route.slice(1)) {
      for (let i = 0; i < 60 * 12; i++) {
        const p = player.body.position;
        if (Math.hypot(tx - p.x, tz - p.z) < 0.25) break;
        // Yaw 0 looks down −Z: face the waypoint.
        player.yawRad = Math.atan2(-(tx - p.x), -(tz - p.z));
        player.update(intent.player, world, STEP_S, events);
      }
      const p = player.body.position;
      expect(Math.hypot(tx - p.x, tz - p.z), `stuck short of (${tx.toFixed(1)}, ${tz.toFixed(1)}) at (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`).toBeLessThan(0.4);
    }
    const noble = storeysOf(lot)[2];
    expect(player.body.position.y).toBeCloseTo(noble?.y0 ?? 0, 0);
  });
});
