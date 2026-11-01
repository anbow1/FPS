import { describe, expect, it } from 'vitest';
import { MODES } from '../src/config.ts';
import { Vec3 } from '../src/core/vec.ts';
import { CollisionWorld } from '../src/game/collision.ts';
import { EventQueue } from '../src/game/events.ts';
import { Player } from '../src/game/player.ts';
import { MapBuilder } from '../src/maps/builder.ts';
import { enterableBuilding } from '../src/maps/buildings.ts';
import { buildMap } from '../src/maps/index.ts';
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
