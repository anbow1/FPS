import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { placeTrucks, Trucks } from '../src/world/trucks';

const flat = { heightAt: (): number => 5 };

describe('trucks', () => {
  it('park on dry, level ground, apart, their boxes standing on it', () => {
    const list = placeTrucks(flat, () => false, 7);
    expect(list.length).toBeGreaterThan(5);
    for (const t of list) {
      expect(t.obb.y0).toBeLessThan(5);
      expect(t.obb.y1).toBeGreaterThan(6.5);
      for (const u of list) if (u !== t) expect(Math.hypot(u.x - t.x, u.z - t.z)).toBeGreaterThanOrEqual(14);
    }
    expect(placeTrucks({ heightAt: (): number => -2 }, () => false, 7)).toHaveLength(0);
    expect(placeTrucks(flat, () => true, 7)).toHaveLength(0);
  });

  it('burn from a tank round, from a long burst, not from a few rounds', () => {
    const trucks = new Trucks(placeTrucks(flat, () => false, 7));
    const t = trucks.list[0]!;
    const p = new Vector3(t.x, t.y + 1.5, t.z);
    expect(trucks.at(p, 0.3)).toBe(0);
    expect(trucks.at(new Vector3(t.x, t.y + 40, t.z), 0.3)).toBe(-1);
    expect(trucks.damage(0, 100, p)).toBe(true);
    expect(t.state).toBe('burnt');
    expect(t.obb.y1).toBeLessThan(t.top);
    const u = trucks.list[1]!;
    for (let k = 0; k < 10; k++) trucks.damage(1, 70 * 0.02, p);
    expect(u.state).toBe('parked');
    for (let k = 0; k < 80; k++) trucks.damage(1, 70 * 0.02, p);
    expect(u.state).toBe('burnt');
  });

  it('are flattened by a tank and stand again for a new battle', () => {
    const trucks = new Trucks(placeTrucks(flat, () => false, 7));
    const t = trucks.list[2]!;
    const y = t.y;
    expect(trucks.crush(2)).toBe(true);
    expect(trucks.crush(2)).toBe(false);
    expect(t.obb.y1).toBeLessThan(t.top);
    trucks.damage(3, 100, new Vector3());
    trucks.reset();
    for (const u of trucks.list) {
      expect(u.state).toBe('parked');
      expect(u.obb.y1).toBe(u.top);
    }
    expect(trucks.list[2]!.y).toBe(y);
    expect(trucks.list[3]!.state).toBe('parked');
  });
});
