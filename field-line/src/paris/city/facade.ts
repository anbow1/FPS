import { Vector3 } from 'three/webgpu';
import { BUILDING, STREET } from '../config.ts';
import { hash2 } from '../rng.ts';
import type { Lot } from './plan.ts';
import type { MeshBuilder } from './meshBuilder.ts';

// One Haussmann front as geometry, not as a picture of one: the windows are
// real openings with reveals 24 cm deep (a low sun draws their shadow lines),
// the balconies of the étage noble and the 5th floor stand out on corbels,
// string courses and the main cornice overhang, the ground floor and
// entresol are rusticated. What is flat is drawn by the materials: ashlar
// joints and grime (stone), the joinery, panes and rooms (window), railings
// (iron), shopfronts (shop).
//
// Facade frame: u along the front from the lot's start, v up (world y), w out
// toward the street (the wall's face at w = 0, recesses at w < 0).

export interface FacadeBuilders {
  /** uv in metres; tone (stone shade per lot), rustic (bossage grooves), ao (baked occlusion). */
  stone: MeshBuilder;
  /** uv in metres; ao. */
  zinc: MeshBuilder;
  /** uv 0…1 over the opening; win = (width m, height m, seed, kind); ao. */
  glass: MeshBuilder;
  /** uv 0…1 over the shopfront; shop = (width m, height m, seed, kind); paint index. */
  shop: MeshBuilder;
  /** uv in metres; rail = (kind, height m). */
  iron: MeshBuilder;
  /** uv 0…1; paint index. */
  awning: MeshBuilder;
}

export const WINDOW_KIND = { french: 0, entresol: 1, dormer: 2, tall: 3 } as const;
export const SHOP_KIND = { shop: 0, cafe: 1, door: 2 } as const;

export interface Storey {
  y0: number;
  h: number;
  kind: 'ground' | 'entresol' | 'noble' | 'upper' | 'fifth';
}

/** The storeys of a lot from the pavement up to the cornice. */
export function storeysOf(lot: Lot): Storey[] {
  const B = BUILDING;
  const out: Storey[] = [];
  let y = STREET.kerbM;
  const push = (h: number, kind: Storey['kind']): void => {
    out.push({ y0: y, h, kind });
    y += h;
  };
  push(B.groundStoreyM, 'ground');
  push(B.entresolM, 'entresol');
  push(B.nobleM, 'noble');
  for (let k = 0; k < lot.upperStoreys - 2; k++) push(B.upperM, 'upper');
  push(B.fifthM, 'fifth');
  return out;
}

/** Window opening per storey: width, height and sill above the floor (m). */
function openingOf(kind: Storey['kind'], bay: number): { w: number; h: number; sill: number } {
  const w = Math.min(BUILDING.windowWidthM, bay - 0.9);
  switch (kind) {
    case 'entresol':
      return { w, h: 1.85, sill: 0.62 };
    case 'noble':
      return { w, h: 2.62, sill: 0.04 };
    case 'upper':
      return { w, h: 2.3, sill: 0.04 };
    case 'fifth':
      return { w, h: 2.12, sill: 0.04 };
    case 'ground':
      return { w: bay - 0.72, h: 3.85, sill: 0 };
  }
}

export class FacadeWriter {
  private lot!: Lot;
  private readonly up = new Vector3(0, 1, 0);
  private readonly out = new Vector3();
  private readonly along = new Vector3();

  constructor(private readonly b: FacadeBuilders) {}

  /** Writes the front of `lot` (its wall, openings, balconies, cornices); the roof is roof.ts's. */
  write(lot: Lot): void {
    this.lot = lot;
    this.out.set(lot.nx, 0, lot.nz);
    this.along.set(lot.tx, 0, lot.tz);
    const W = lot.widthM;
    const bay = W / lot.bays;
    const storeys = storeysOf(lot);
    const s = this.b.stone;
    s.set('tone', lot.stoneTone);
    for (const st of storeys) {
      s.set('rustic', st.kind === 'ground' || st.kind === 'entresol' ? 1 : 0);
      const op = openingOf(st.kind, bay);
      const depth = st.kind === 'ground' ? 0.16 : BUILDING.revealM;
      // The wall of this storey round its openings: below, above, and the piers between.
      s.set('ao', 1);
      this.wallRect(0, W, st.y0, st.y0 + op.sill);
      this.wallRect(0, W, st.y0 + op.sill + op.h, st.y0 + st.h);
      for (let i = 0; i <= lot.bays; i++) {
        const u0 = i === 0 ? 0 : (i - 0.5) * bay + op.w / 2;
        const u1 = i === lot.bays ? W : (i + 0.5) * bay - op.w / 2;
        this.wallRect(u0, u1, st.y0 + op.sill, st.y0 + op.sill + op.h);
      }
      for (let i = 0; i < lot.bays; i++) {
        const cu = (i + 0.5) * bay;
        this.reveal(cu - op.w / 2, cu + op.w / 2, st.y0 + op.sill, st.y0 + op.sill + op.h, depth);
        if (st.kind === 'ground') this.shopfront(i, cu, op, st, depth);
        else this.window(cu, op, st, depth, i);
      }
      this.stringCourse(st);
      if (st.kind === 'noble' || st.kind === 'fifth') this.balcony(st.y0, W, bay);
    }
    const top = storeys[storeys.length - 1] as Storey;
    this.cornice(top.y0 + top.h, W);
    if (lot.ground === 'cafe' && lot.boulevard) this.awning(0.3, W - 0.3, STREET.kerbM + 2.75, 3.1, lot.paint);
  }

  /** World point of facade (u, v, w). */
  p(u: number, v: number, w: number, out = new Vector3()): Vector3 {
    const l = this.lot;
    return out.set(l.ox + l.tx * u + l.nx * w, v, l.oz + l.tz * u + l.nz * w);
  }

  /** A flat piece of wall at depth w, uvs in metres. */
  private wallRect(u0: number, u1: number, v0: number, v1: number, w = 0): void {
    if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return;
    this.b.stone.quad(this.p(u0, v0, w), this.p(u1, v0, w), this.p(u1, v1, w), this.p(u0, v1, w), [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ], this.out);
  }

  /** The four sides of an opening, from the face back to the joinery; occlusion deepening inward. */
  private reveal(u0: number, u1: number, v0: number, v1: number, d: number): void {
    const s = this.b.stone;
    const sides: [Vector3, Vector3, Vector3, Vector3, Vector3, [number, number][]][] = [
      // sill (faces up), head (faces down), jambs (face inward)
      [this.p(u0, v0, 0), this.p(u1, v0, 0), this.p(u1, v0, -d), this.p(u0, v0, -d), this.up, [[u0, 0], [u1, 0], [u1, d], [u0, d]]],
      [this.p(u0, v1, 0), this.p(u1, v1, 0), this.p(u1, v1, -d), this.p(u0, v1, -d), this.up.clone().negate(), [[u0, 0], [u1, 0], [u1, d], [u0, d]]],
      [this.p(u0, v0, 0), this.p(u0, v1, 0), this.p(u0, v1, -d), this.p(u0, v0, -d), this.along, [[0, v0], [0, v1], [d, v1], [d, v0]]],
      [this.p(u1, v0, 0), this.p(u1, v1, 0), this.p(u1, v1, -d), this.p(u1, v0, -d), this.along.clone().negate(), [[0, v0], [0, v1], [d, v1], [d, v0]]],
    ];
    for (const [a, bb, c, dd, n, uv] of sides) {
      s.set('ao', 0.82);
      s.quad(a, bb, c, dd, uv, n);
    }
  }

  private window(cu: number, op: { w: number; h: number; sill: number }, st: Storey, d: number, i: number): void {
    const g = this.b.glass;
    const u0 = cu - op.w / 2;
    const u1 = cu + op.w / 2;
    const v0 = st.y0 + op.sill;
    const v1 = v0 + op.h;
    const seed = hash2(Math.round(u0 * 10 + this.lot.ox * 7), Math.round(v0 * 10 + this.lot.oz * 3), 11);
    g.set('win', op.w, op.h, seed, st.kind === 'entresol' ? WINDOW_KIND.entresol : WINDOW_KIND.french);
    g.set('ao', 1);
    g.quad(this.p(u0, v0, -d), this.p(u1, v0, -d), this.p(u1, v1, -d), this.p(u0, v1, -d), [[0, 0], [1, 0], [1, 1], [0, 1]], this.out);
    const s = this.b.stone;
    s.set('rustic', 0);
    if (st.kind !== 'entresol') {
      // Moulded surround (chambranle) and a stone sill.
      this.frameAround(u0, u1, v0, v1, 0.13, 0.045);
      this.boxF(cu, v0 - 0.06, 0.06, op.w + 0.3, 0.12, 0.12, 0.85);
      // Balconnets on the storeys without a continuous balcony.
      if (st.kind === 'upper') this.rail(u0 - 0.06, u1 + 0.06, v0, 0.95, 0.1, 1);
    }
    if (st.kind === 'noble') {
      // The étage noble's windows carry hoods on small consoles; every other one a pediment.
      this.boxF(cu, v1 + 0.32, 0.1, op.w + 0.5, 0.12, 0.26, 0.9);
      this.boxF(cu, v1 + 0.2, 0.06, op.w + 0.36, 0.12, 0.16, 0.85);
      for (const e of [-1, 1]) this.boxF(cu + e * (op.w / 2 + 0.14), v1 + 0.08, 0.07, 0.12, 0.3, 0.16, 0.85);
      if (i % 2 === 0) this.pediment(cu, v1 + 0.38, op.w + 0.5, 0.42, 0.24);
    } else if (st.kind === 'upper') {
      this.boxF(cu, v1 + 0.18, 0.06, op.w + 0.3, 0.1, 0.14, 0.9);
    }
  }

  private shopfront(i: number, cu: number, op: { w: number; h: number; sill: number }, st: Storey, d: number): void {
    const l = this.lot;
    const doorBay = l.ground === 'door' && i === Math.floor(l.bays / 2);
    const bank = l.ground === 'bank' && !doorBay;
    const u0 = cu - op.w / 2;
    const u1 = cu + op.w / 2;
    const v0 = st.y0;
    const v1 = st.y0 + op.h;
    if (bank) {
      // Stone below tall windows with grilles.
      this.b.stone.set('rustic', 1).set('ao', 0.9);
      this.wallRect(u0, u1, v0, v0 + 0.9, -d);
      this.b.stone.set('rustic', 0);
      const g = this.b.glass;
      g.set('win', op.w, op.h - 1.3, hash2(i, Math.round(l.oz), 5), WINDOW_KIND.tall).set('ao', 0.9);
      g.quad(this.p(u0, v0 + 0.9, -d), this.p(u1, v0 + 0.9, -d), this.p(u1, v1 - 0.4, -d), this.p(u0, v1 - 0.4, -d), [[0, 0], [1, 0], [1, 1], [0, 1]], this.out);
      this.b.stone.set('rustic', 1);
      this.wallRect(u0, u1, v1 - 0.4, v1, -d);
      return;
    }
    const sh = this.b.shop;
    const kind = doorBay ? SHOP_KIND.door : l.ground === 'cafe' ? SHOP_KIND.cafe : SHOP_KIND.shop;
    sh.set('shop', op.w, op.h, hash2(i, Math.round(l.oz * 3 + l.ox), 9), kind);
    sh.set('paint', l.paint);
    sh.quad(this.p(u0, v0, -d), this.p(u1, v0, -d), this.p(u1, v1, -d), this.p(u0, v1, -d), [[0, 0], [1, 0], [1, 1], [0, 1]], this.out);
    // A shop's own small awning, rolled out on some.
    if (!doorBay && l.ground === 'shop' && hash2(i, Math.round(l.oz), 3) < 0.35) this.awning(u0 - 0.1, u1 + 0.1, v1 - 0.6, 1.2, l.paint);
  }

  /** A moulded surround round an opening: four flat bars `width` wide, `depth` proud of the face. */
  private frameAround(u0: number, u1: number, v0: number, v1: number, width: number, depth: number): void {
    const cu = (u0 + u1) / 2;
    const cv = (v0 + v1) / 2;
    this.boxF(cu, v1 + width / 2, depth / 2, u1 - u0 + 2 * width, width, depth, 0.95);
    this.boxF(u0 - width / 2, cv, depth / 2, width, v1 - v0, depth, 0.95);
    this.boxF(u1 + width / 2, cv, depth / 2, width, v1 - v0, depth, 0.95);
  }

  /** A triangular pediment over a window: two sloping bars on the face. */
  private pediment(cu: number, v: number, width: number, rise: number, depth: number): void {
    const s = this.b.stone;
    s.set('ao', 0.95);
    const a = this.p(cu - width / 2, v, depth);
    const b = this.p(cu + width / 2, v, depth);
    const c = this.p(cu, v + rise, depth);
    s.tri(a, b, c, [[0, 0], [width, 0], [width / 2, rise]], this.out);
    const a0 = this.p(cu - width / 2, v, 0);
    const b0 = this.p(cu + width / 2, v, 0);
    const c0 = this.p(cu, v + rise, 0);
    const slopeL = new Vector3().subVectors(c, a).cross(this.out).normalize().negate();
    s.quad(a0, a, c, c0, [[0, 0], [depth, 0], [depth, rise], [0, rise]], slopeL.y > 0 ? slopeL : slopeL.negate());
    const slopeR = new Vector3().subVectors(b, c).cross(this.out).normalize().negate();
    s.quad(c0, c, b, b0, [[0, 0], [depth, 0], [depth, rise], [0, rise]], slopeR.y > 0 ? slopeR : slopeR.negate());
    s.quad(a0, b0, b, a, [[0, 0], [width, 0], [width, depth], [0, depth]], this.up.clone().negate());
  }

  /** A band along the whole front under each storey's floor line. */
  private stringCourse(st: Storey): void {
    if (st.kind === 'ground') return;
    this.b.stone.set('rustic', 0);
    this.boxF(this.lot.widthM / 2, st.y0 - 0.1, 0.05, this.lot.widthM, 0.2, 0.1, 0.92);
  }

  /** A continuous balcony: the slab on corbels and its railing along the front and round the ends. */
  private balcony(y: number, W: number, bay: number): void {
    const D = BUILDING.balconyDepthM;
    this.b.stone.set('rustic', 0);
    this.boxF(W / 2, y - 0.1, D / 2, W - 0.3, 0.2, D, 0.95);
    this.boxF(W / 2, y - 0.25, D / 2 - 0.06, W - 0.4, 0.1, D - 0.12, 0.75);
    for (let i = 0; i <= this.lot.bays; i++) {
      const u = Math.min(W - 0.35, Math.max(0.35, i * bay));
      this.boxF(u, y - 0.42, 0.24, 0.16, 0.44, 0.46, 0.7);
    }
    this.rail(0.2, W - 0.2, y, 1.02, D - 0.05, 0);
    for (const u of [0.2, W - 0.2]) this.railSide(u, y, 1.02, D - 0.05);
  }

  /** A railing panel along the front at depth w, from floor y, `h` tall. */
  private rail(u0: number, u1: number, y: number, h: number, w: number, kind: number): void {
    const r = this.b.iron;
    r.set('rail', kind, h);
    r.quad(this.p(u0, y, w), this.p(u1, y, w), this.p(u1, y + h, w), this.p(u0, y + h, w), [[u0, 0], [u1, 0], [u1, h], [u0, h]], this.out);
  }

  private railSide(u: number, y: number, h: number, w: number): void {
    const r = this.b.iron;
    r.set('rail', 0, h);
    r.quad(this.p(u, y, 0), this.p(u, y, w), this.p(u, y + h, w), this.p(u, y + h, 0), [[0, 0], [w, 0], [w, h], [0, h]], this.along);
  }

  /** The main cornice: three stepped mouldings overhanging 0.62 m, its shadow line the strongest on the front. */
  private cornice(y: number, W: number): void {
    this.b.stone.set('rustic', 0);
    this.boxF(W / 2, y + 0.12, 0.09, W, 0.24, 0.18, 0.8);
    this.boxF(W / 2, y + 0.33, 0.2, W, 0.18, 0.4, 0.85);
    this.boxF(W / 2, y + 0.52, 0.31, W, 0.2, 0.62, 0.95);
    // Modillions under the corona, every ~0.6 m.
    for (let u = 0.3; u < W - 0.2; u += 0.62) this.boxF(u, y + 0.36, 0.48, 0.12, 0.14, 0.26, 0.7);
  }

  /** An awning of striped canvas from the face out to `reach`, its valance hanging at the front. */
  private awning(u0: number, u1: number, y: number, reach: number, paint: number): void {
    const a = this.b.awning;
    a.set('paint', paint);
    const drop = reach * 0.42;
    const back0 = this.p(u0, y + drop, 0);
    const back1 = this.p(u1, y + drop, 0);
    const f0 = this.p(u0, y, reach);
    const f1 = this.p(u1, y, reach);
    const slope = new Vector3().subVectors(f0, back0).cross(this.along).normalize();
    a.quad(back0, back1, f1, f0, [[0, 1], [1, 1], [1, 0.25], [0, 0.25]], slope.y > 0 ? slope : slope.negate());
    a.quad(f0, f1, this.p(u1, y - 0.28, reach), this.p(u0, y - 0.28, reach), [[0, 0.25], [1, 0.25], [1, 0], [0, 0]], this.out);
  }

  /** A stone box in facade coordinates: centre (u, v, w), sizes along u, v and w; `ao` on all of it. */
  boxF(u: number, v: number, w: number, su: number, sv: number, sw: number, ao: number): void {
    const s = this.b.stone;
    s.set('ao', ao);
    s.box(this.p(u, v, w), this.along.clone().multiplyScalar(su / 2), this.up.clone().multiplyScalar(sv / 2), this.out.clone().multiplyScalar(sw / 2), true);
  }
}
