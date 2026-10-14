import { describe, expect, it } from 'vitest';
import { WakeFoam } from '../src/render/wakeFoam.ts';

const make = (): WakeFoam => new WakeFoam({ cells: 64, cellM: 0.5, lifeS: 9, spreadM2PerS: 0.08 });

describe('wake foam', () => {
  it('stays where it was stamped when the window follows the camera', () => {
    const f = make();
    f.update(0, 0, 0);
    f.stamp(3.2, -2.1, 0.6, 1);
    const before = f.amountAt(3.2, -2.1);
    expect(before).toBeGreaterThan(0.5);
    // Far enough to re-centre the window (16 cells = 8 m), close enough to keep the spot inside it.
    f.update(0, 9.5, 4.2);
    expect(f.amountAt(3.2, -2.1)).toBeCloseTo(before, 6);
    expect(f.amountAt(9.5, 4.2)).toBe(0);
  });

  it('fades and widens with time, then clears', () => {
    const f = make();
    f.update(0, 0, 0);
    f.stamp(0, 0, 0.5, 1.2);
    const centre0 = f.amountAt(0, 0);
    const side0 = f.amountAt(2, 0);
    for (let k = 0; k < 15 * 5; k++) f.update(1 / 15, 0, 0);
    const centre5 = f.amountAt(0, 0);
    expect(centre5).toBeLessThan(centre0 * 0.6);
    expect(f.amountAt(2, 0)).toBeGreaterThan(side0);
    for (let k = 0; k < 15 * 60; k++) f.update(1 / 15, 0, 0);
    expect(f.amountAt(0, 0)).toBe(0);
  });

  it('draws an unbroken line however long the frame', () => {
    const f = make();
    f.update(0, 0, 0);
    // 6 m in one frame (a long frame at speed); jumps past 8 m are teleports and draw no line.
    f.stampLine(-3, 0, 3, 0, 0.4, 2);
    const along: number[] = [];
    for (let x = -2.5; x <= 2.5; x += 0.5) along.push(f.amountAt(x, 0));
    // Even along its length: no gaps between the stamps.
    expect(Math.min(...along)).toBeGreaterThan(Math.max(...along) * 0.4);
  });
});
