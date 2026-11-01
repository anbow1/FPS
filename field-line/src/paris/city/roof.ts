import { CylinderGeometry, Vector3 } from 'three/webgpu';
import { BUILDING } from '../config.ts';
import { hash2 } from '../rng.ts';
import { corniceY, type Lot } from './plan.ts';
import { type FacadeBuilders, type FacadeWriter, WINDOW_KIND } from './facade.ts';

// The Paris roofline: a zinc mansard behind every cornice — the steep brisis
// with a dormer (lucarne) over each bay, the flatter terrasson above — and
// the party-wall chimney stacks with their rows of terracotta pots, the
// silhouette that says Paris before any facade does.

/** Depth of the building behind the front: the roof runs back this far (courtyards beyond are not seen). */
const BUILDING_DEPTH_M = 14;
/** The flat top: the mansard's ridge set back from the front. */
const TERRASSON_BACK_M = 6.5;

export function writeRoof(fw: FacadeWriter, b: FacadeBuilders, lot: Lot, pots: Vector3[]): void {
  const W = lot.widthM;
  const yc = corniceY(lot) + 0.62;
  const rise = BUILDING.mansardRiseM;
  const w0 = -0.15;
  const w1 = w0 - rise / Math.tan(BUILDING.mansardSteepRad);
  const y1 = yc + rise;
  const y2 = y1 + BUILDING.mansardTopRiseM;
  const z = b.zinc;
  const out = new Vector3(lot.nx, 0, lot.nz);
  const p = (u: number, v: number, w: number): Vector3 => fw.p(u, v, w);
  const bay = W / lot.bays;
  // The cornice's top, a strip of zinc flashing between it and the brisis.
  z.set('ao', 0.9);
  z.quad(p(0, yc, 0.62), p(W, yc, 0.62), p(W, yc, w0), p(0, yc, w0), [[0, 0.77], [W, 0.77], [W, 0], [0, 0]], new Vector3(0, 1, 0));
  // Brisis, broken by the dormers: the slope in strips between them, and under and over them.
  const slopeN = new Vector3(0, 1, 0).multiplyScalar(Math.cos(BUILDING.mansardSteepRad)).addScaledVector(out, Math.sin(BUILDING.mansardSteepRad));
  const dormerW = Math.min(1.15, bay - 0.8);
  const dv0 = 0.55;
  const dv1 = 2.35;
  const wAt = (v: number): number => w0 - (v - yc) / Math.tan(BUILDING.mansardSteepRad);
  const slope = (u0: number, u1: number, v0: number, v1: number): void => {
    if (u1 - u0 < 1e-3) return;
    const s0 = (v0 - yc) / Math.sin(BUILDING.mansardSteepRad);
    const s1 = (v1 - yc) / Math.sin(BUILDING.mansardSteepRad);
    z.quad(p(u0, v0, wAt(v0)), p(u1, v0, wAt(v0)), p(u1, v1, wAt(v1)), p(u0, v1, wAt(v1)), [[u0, s0], [u1, s0], [u1, s1], [u0, s1]], slopeN);
  };
  z.set('ao', 1);
  slope(0, W, yc, yc + dv0);
  slope(0, W, yc + dv1 + 0.35, y1);
  let u = 0;
  for (let i = 0; i < lot.bays; i++) {
    const cu = (i + 0.5) * bay;
    slope(u, cu - dormerW / 2, yc + dv0, yc + dv1 + 0.35);
    u = cu + dormerW / 2;
    dormer(fw, b, lot, cu, yc + dv0, yc + dv1, dormerW, w0 + 0.05, wAt);
  }
  slope(u, W, yc + dv0, yc + dv1 + 0.35);
  // Terrasson: the flatter top, then the flat roof back to the courtyard side.
  const tN = new Vector3(0, 1, 0).multiplyScalar(0.94).addScaledVector(out, 0.34).normalize();
  z.quad(p(0, y1, w1), p(W, y1, w1), p(W, y2, -TERRASSON_BACK_M), p(0, y2, -TERRASSON_BACK_M), [[0, 0], [W, 0], [W, 5.5], [0, 5.5]], tN);
  z.quad(p(0, y2, -TERRASSON_BACK_M), p(W, y2, -TERRASSON_BACK_M), p(W, y2, -BUILDING_DEPTH_M), p(0, y2, -BUILDING_DEPTH_M), [[0, 0], [W, 0], [W, 8], [0, 8]], new Vector3(0, 1, 0));
  // Party walls at both ends: the mansard's profile in rendered masonry, standing a little proud of the zinc.
  const s = b.stone;
  s.set('rustic', 0).set('ao', 0.92);
  for (const [ue, sgn] of [[0, -1], [W, 1]] as const) {
    if ((ue === 0 && lot.cornerStart) || (ue === W && lot.cornerEnd)) continue;
    const n = new Vector3(lot.tx, 0, lot.tz).multiplyScalar(sgn);
    const prof: [number, number][] = [[0.62, yc - 0.05], [w0, yc], [w1, y1], [-TERRASSON_BACK_M, y2], [-BUILDING_DEPTH_M, y2], [-BUILDING_DEPTH_M, yc - 0.05]];
    const top = 0.18;
    for (let k = 0; k + 1 < prof.length; k++) {
      const [wa, va] = prof[k] as [number, number];
      const [wb, vb] = prof[k + 1] as [number, number];
      s.quad(p(ue, yc - 0.05, wa), p(ue, yc - 0.05, wb), p(ue, vb + top, wb), p(ue, va + top, wa), [[wa, yc], [wb, yc], [wb, vb], [wa, va]], n);
    }
  }
  // Chimney stacks on the party walls, a row of pots on each.
  if (!lot.cornerStart) chimney(fw, lot, 0, y2, pots);
  if (hash2(Math.round(lot.ox), Math.round(lot.oz), 21) < 0.5) chimney(fw, lot, W * 0.5, y2, pots);
}

/** A dormer: a stone front with a window and a small pediment, zinc cheeks back into the slope. */
function dormer(fw: FacadeWriter, b: FacadeBuilders, lot: Lot, cu: number, v0: number, v1: number, width: number, w: number, wAt: (v: number) => number): void {
  const p = (u: number, v: number, ww: number): Vector3 => fw.p(u, v, ww);
  const out = new Vector3(lot.nx, 0, lot.nz);
  const along = new Vector3(lot.tx, 0, lot.tz);
  const u0 = cu - width / 2;
  const u1 = cu + width / 2;
  const s = b.stone;
  s.set('rustic', 0).set('ao', 1);
  // The front: a stone surround with the window set into it.
  const inset = 0.13;
  const g = b.glass;
  g.set('win', width - 2 * inset, v1 - v0 - 0.32, hash2(Math.round(cu * 10), Math.round(lot.oz + lot.ox), 4), WINDOW_KIND.dormer).set('ao', 0.95);
  g.quad(p(u0 + inset, v0 + 0.2, w - 0.12), p(u1 - inset, v0 + 0.2, w - 0.12), p(u1 - inset, v1 - 0.12, w - 0.12), p(u0 + inset, v1 - 0.12, w - 0.12), [[0, 0], [1, 0], [1, 1], [0, 1]], out);
  const q = (a: [number, number], c: [number, number]): void => {
    s.quad(p(a[0], a[1], w), p(c[0], a[1], w), p(c[0], c[1], w), p(a[0], c[1], w), [[a[0], a[1]], [c[0], a[1]], [c[0], c[1]], [a[0], c[1]]], out);
  };
  q([u0, v0], [u1, v0 + 0.2]);
  q([u0, v1 - 0.12], [u1, v1]);
  q([u0, v0 + 0.2], [u0 + inset, v1 - 0.12]);
  q([u1 - inset, v0 + 0.2], [u1, v1 - 0.12]);
  // Window reveals of the dormer.
  for (const [ua, ub, n] of [[u0 + inset, u0 + inset, along], [u1 - inset, u1 - inset, along.clone().negate()]] as const) {
    s.quad(p(ua, v0 + 0.2, w), p(ub, v0 + 0.2, w - 0.12), p(ub, v1 - 0.12, w - 0.12), p(ua, v1 - 0.12, w), [[0, 0], [0.12, 0], [0.12, 1], [0, 1]], n);
  }
  // Cheeks: from the front back to where the slope meets them.
  const z = b.zinc;
  z.set('ao', 0.85);
  for (const [ue, n] of [[u0, along.clone().negate()], [u1, along]] as const) {
    z.quad(p(ue, v0, w), p(ue, v0, wAt(v0)), p(ue, v1, wAt(v1)), p(ue, v1, w), [[0, v0], [w - wAt(v0), v0], [w - wAt(v1), v1], [0, v1]], n);
  }
  // A small pitched roof of zinc over it, and a stone pediment on the front.
  const ridge = v1 + 0.42;
  const back = wAt(ridge);
  const l = p(u0 - 0.06, v1, w + 0.06);
  const r = p(u1 + 0.06, v1, w + 0.06);
  const t = p(cu, ridge, w + 0.06);
  s.tri(p(u0, v1, w), p(u1, v1, w), p(cu, ridge - 0.04, w), [[0, 0], [width, 0], [width / 2, 0.4]], out);
  const lb = p(u0 - 0.06, v1, back);
  const rb = p(u1 + 0.06, v1, back);
  const tb = p(cu, ridge, back);
  const upL = new Vector3().subVectors(t, l).cross(along).normalize();
  z.quad(l, t, tb, lb, [[0, 0], [0.8, 0], [0.8, 2], [0, 2]], upL.y > 0 ? upL : upL.negate());
  const upR = new Vector3().subVectors(r, t).cross(along).normalize();
  z.quad(t, r, rb, tb, [[0, 0], [0.8, 0], [0.8, 2], [0, 2]], upR.y > 0 ? upR : upR.negate());
}

/** A chimney stack across a party wall, rendered masonry, its pots (terracotta) collected in `pots`. */
function chimney(fw: FacadeWriter, lot: Lot, u: number, roofY: number, pots: Vector3[]): void {
  const h = 1.6 + hash2(Math.round(lot.ox * 3), Math.round(lot.oz * 3 + u), 8) * 1.2;
  const depth = 2.6;
  const wc = -TERRASSON_BACK_M + 1.2 - depth / 2;
  fw.boxF(u, roofY + h / 2 - 0.3, wc, 0.62, h + 0.6, depth, 1);
  fw.boxF(u, roofY + h, wc, 0.74, 0.12, depth + 0.12, 1);
  const n = Math.max(3, Math.floor(depth / 0.32));
  for (let k = 0; k < n; k++) pots.push(fw.p(u, roofY + h + 0.06, wc - depth / 2 + 0.2 + (k * (depth - 0.4)) / (n - 1)));
}

/** One chimney pot: a terracotta cylinder flaring at the top, base at y = 0. */
export function potGeometry(): CylinderGeometry {
  return new CylinderGeometry(0.1, 0.12, 0.62, 10).translate(0, 0.31, 0) as CylinderGeometry;
}
