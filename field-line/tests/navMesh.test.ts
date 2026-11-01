import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec.ts';
import { CollisionWorld } from '../src/game/collision.ts';
import { NavMesh } from '../src/game/navMesh.ts';
import { moveCapsule } from '../src/game/movement.ts';
import { PLAYER } from '../src/config.ts';
import { boulevardPlan, PARIS_SHIFT_Z } from '../src/maps/boulevard.ts';
import { buildMap } from '../src/maps/index.ts';
import { storeysOf } from '../src/paris/city/facade.ts';

describe('navigation mesh (city maps)', () => {
  it('leads from the boulevard up the stairs of a house onto its étage noble', () => {
    const map = buildMap('boulevard');
    const world = new CollisionWorld(map.terrain);
    for (const box of map.boxes) world.addBox(box);
    const t0 = performance.now();
    const nav = new NavMesh(world, map.halfSizeM);
    const buildMs = performance.now() - t0;
    console.log(`boulevard navigation mesh: ${buildMs.toFixed(0)} ms`);
    const lot = boulevardPlan().lots.find((l) => l.enterable);
    if (!lot) throw new Error('no enterable lot');
    const at = (u: number, d: number, y: number): Vec3 => new Vec3(lot.ox + lot.tx * u - lot.nx * d, y, lot.oz + lot.tz * u - lot.nz * d + PARIS_SHIFT_Z);
    const noble = storeysOf(lot)[2];
    if (!noble) throw new Error('no noble storey');
    const street = at(lot.widthM / 2, -6, 0);
    const room = at(lot.widthM * 0.3, 6, noble.y0);
    const path = nav.findPath(street, room);
    expect(path).not.toBeNull();
    const end = (path as Vec3[])[(path as Vec3[]).length - 1] as Vec3;
    expect(end.distanceTo(room)).toBeLessThan(0.6);
    // It climbs: some waypoint stands on the entresol landing between the two flights.
    expect((path as Vec3[]).some((p) => p.y > 4 && p.y < 5)).toBe(true);
    // And a soldier's capsule, steered waypoint to waypoint as soldier.ts does, gets there.
    const body = { position: street.clone(), velocity: new Vec3(), heightM: PLAYER.heightStandM, radiusM: PLAYER.radiusM * 0.9, grounded: false, groundSurface: 'asphalt' as const, groundNormal: new Vec3(0, 1, 0) };
    const dt = 1 / 60;
    let i = 0;
    const route = path as Vec3[];
    for (let step = 0; step < 60 * 60 && i < route.length; step++) {
      const wp = route[i] as Vec3;
      const dx = wp.x - body.position.x;
      const dz = wp.z - body.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35 && Math.abs(wp.y - body.position.y) < 1.5) {
        i++;
        continue;
      }
      body.velocity.x = (dx / d) * 2.5;
      body.velocity.z = (dz / d) * 2.5;
      body.velocity.y -= 9.81 * dt;
      moveCapsule(world, body, dt, 0.42);
    }
    expect(i, `stalled at waypoint ${i} of ${route.length}, body at (${body.position.x.toFixed(1)}, ${body.position.y.toFixed(2)}, ${body.position.z.toFixed(1)})`).toBe(route.length);
    expect(body.position.y).toBeCloseTo(noble.y0, 0);
    nav.dispose();
  });

  it('city: every squad spawn reaches the extraction hold', () => {
    const map = buildMap('city');
    const world = new CollisionWorld(map.terrain);
    for (const box of map.boxes) world.addBox(box);
    const nav = new NavMesh(world, map.halfSizeM);
    for (const s of map.squadSpawns) {
      const from = nav.nearestWalkable(s.pos.x, s.pos.z, new Vec3());
      expect(from).not.toBeNull();
      expect(nav.findPath(from as Vec3, map.extraction.hold)).not.toBeNull();
    }
    nav.dispose();
  });
});
