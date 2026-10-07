import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three/webgpu';
import { box, fuselage, lathe, type Station, surface, tube } from '../src/render/airframe.ts';

// The airframe kernel must wind every face outwards (lighting and shadows depend on it):
// compare each vertex normal with the direction from the body's centre line to the vertex.

function outwardShare(g: BufferGeometry, centre: (x: number, y: number, z: number) => [number, number, number]): number {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  let ok = 0;
  let total = 0;
  for (let i = 0; i < p.count; i++) {
    const [cx, cy, cz] = centre(p.getX(i), p.getY(i), p.getZ(i));
    const dx = p.getX(i) - cx;
    const dy = p.getY(i) - cy;
    const dz = p.getZ(i) - cz;
    if (Math.hypot(dx, dy, dz) < 1e-3) continue;
    total++;
    if (dx * n.getX(i) + dy * n.getY(i) + dz * n.getZ(i) > 0) ok++;
  }
  return ok / total;
}

/** Every vertex whose normal is mostly along x or z (caps and cut faces) faces away from the panel's centre. */
function capsOutward(g: BufferGeometry): boolean {
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new (g.boundingBox!.min.constructor as new () => import('three/webgpu').Vector3)());
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  let bad = 0;
  for (let i = 0; i < p.count; i++) {
    const nx = n.getX(i);
    const nz = n.getZ(i);
    if (Math.abs(n.getY(i)) > 0.3) continue;
    if ((p.getX(i) - c.x) * nx + (p.getZ(i) - c.z) * nz < -1e-6) bad++;
  }
  // The two cap corners at the sharp trailing edge average opposite faces: allow them.
  return bad <= 2;
}

const stations: Station[] = [
  { z: -5, top: 0.05, bot: -0.05, w: 0.05, yc: 0, tw: 0.3, bw: 0.3, su: 0, sl: 0 },
  { z: -3, top: 0.6, bot: -0.5, w: 0.8, yc: 0, tw: 0.4, bw: 0.5, su: 0.5, sl: 0.6 },
  { z: 3, top: 0.7, bot: -0.6, w: 1.2, yc: 0.05, tw: 0.5, bw: 0.6, su: 0.8, sl: 0.8 },
  { z: 5, top: 0.4, bot: -0.3, w: 0.5, yc: 0.05, tw: 0.4, bw: 0.4, su: 0.2, sl: 0.2 },
];

describe('airframe kernel', () => {
  it('fuselage faces outwards', () => {
    expect(outwardShare(fuselage(stations), (_x, _y, z) => [0, 0.05, z])).toBeGreaterThan(0.97);
  });
  it('surfaces face outwards on both sides', () => {
    const sf = { rootX: 0.5, rootY: 0, rootLeZ: -1, rootChordM: 3, spanM: 4, tipLeZ: 1, tipChordM: 1, rootThickness: 0.06, tipThickness: 0.04, dihedralRad: 0 };
    for (const side of [1, -1] as const) {
      const g = surface({ ...sf, side });
      // Skin: upper vertices face up, lower down (mid-plane at y = 0); caps face away from the panel.
      expect(outwardShare(g, (x, _y, z) => [x, 0, z])).toBeGreaterThan(0.8);
      expect(capsOutward(g)).toBe(true);
      for (const panel of [{ c0: 0.75, s0: 0.3, s1: 0.8, gapM: 0.02 }, { c1: 0.75, s0: 0.3, s1: 0.8, gapM: 0.02 }]) {
        const part = surface({ ...sf, side }, panel);
        expect(outwardShare(part, (x, _y, z) => [x, 0, z])).toBeGreaterThan(0.6);
        expect(capsOutward(part)).toBe(true);
      }
    }
  });
  it('lathe, tube and box face outwards', () => {
    expect(outwardShare(lathe([[0, 0.5], [1, 0.6], [2, 0.3]], 1, 2, 24), (_x, _y, z) => [1, 2, z])).toBeGreaterThan(0.97);
    expect(outwardShare(tube([[0, 0, 0], [0, 0, 1], [0, 0, 2]], 0.05), (_x, _y, z) => [0, 0, z])).toBeGreaterThan(0.97);
    expect(outwardShare(box(0, 0, 0, 1, 2, 3), () => [0.5, 1, 1.5])).toBe(1);
  });
});
