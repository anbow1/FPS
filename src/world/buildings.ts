import * as THREE from 'three';
import { Rng } from '../core/rng';
import { buildingMaterial, type SurfaceKind } from '../render/buildingMaterial';
import { box, cyl, prismX } from '../render/geom';
import { stdMat } from '../render/palette';
import { addThermalConst } from '../render/shaderPatch';
import type { Heightfield } from './heightfield';
import { SITES } from './layout';
import { hyp2 } from '../core/mathx';

/** Oriented box collider on the ground (buildings, walls). */
export interface Obb {
  x: number;
  z: number;
  y0: number;
  y1: number;
  hw: number;
  hd: number;
  rot: number;
}

type Kind = SurfaceKind | 'glass';

/** Per-material accumulator; every part carries its building-frame position for the facade shader. */
class PartSet {
  private pos: Record<string, number[]> = {};
  private nrm: Record<string, number[]> = {};
  private loc: Record<string, number[]> = {};
  private info: Record<string, number[]> = {};
  add(kind: Kind, g: THREE.BufferGeometry, m: THREE.Matrix4, base: number, seed: number): void {
    const geo = g.index ? g.toNonIndexed() : g;
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const P = (this.pos[kind] ??= []);
    const N = (this.nrm[kind] ??= []);
    const L = (this.loc[kind] ??= []);
    const I = (this.info[kind] ??= []);
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      L.push(v.x, v.y, v.z);
      v.applyMatrix4(m);
      P.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      N.push(v.x, v.y, v.z);
      I.push(base, seed);
    }
  }
  build(kind: Kind): THREE.BufferGeometry | null {
    const P = this.pos[kind];
    if (!P?.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm[kind]!, 3));
    g.setAttribute('aLocal', new THREE.Float32BufferAttribute(this.loc[kind]!, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info[kind]!, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Farm houses and barns: brick or rendered walls, clay-tile or corrugated roofs, framed windows
 * with sills, eaves boards, gutters and chimneys. All geometry is merged per material, so the whole
 * village costs one draw call per surface type.
 */
export function buildBuildings(hf: Heightfield, seed: number): { group: THREE.Group; colliders: Obb[] } {
  const rng = new Rng(seed);
  const parts = new PartSet();
  const colliders: Obb[] = [];
  const place = (x: number, z: number, w: number, d: number, h: number, rot: number, kind: 'house' | 'barn') => {
    for (const c of colliders) if (hyp2(c.x - x, c.z - z) < Math.max(c.hw, c.hd) + Math.max(w, d) / 2 + 4) return false;
    const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]] as const;
    for (const [cx, cz] of [...corners, [0, 0] as const]) {
      const px = x + cx * Math.cos(rot) + cz * Math.sin(rot);
      const pz = z - cx * Math.sin(rot) + cz * Math.cos(rot);
      if (hf.roadAt(px, pz) > 0.05) return false;
    }
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const [cx, cz] of corners) {
      const y = hf.heightAt(x + cx * Math.cos(rot) + cz * Math.sin(rot), z - cx * Math.sin(rot) + cz * Math.cos(rot));
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
    }
    if (ymax - ymin > 2.2) return false;
    const y0 = ymin - 0.4;
    const base = ymax + 0.3; // floor level on a plinth
    const m = new THREE.Matrix4().makeRotationY(rot).setPosition(x, 0, z);
    const sd = rng.next() * 100;
    const add = (k: Kind, g: THREE.BufferGeometry) => parts.add(k, g, m, base, sd);
    const barn = kind === 'barn';
    const wall: Kind = barn ? 'wood' : rng.next() < 0.5 ? 'brick' : 'plaster';
    const top = base + h;
    // walls and plinth
    add(wall, box(w, top - base, d, 0, (base + top) / 2, 0));
    add('concrete', box(w + 0.16, base - y0 + 0.05, d + 0.16, 0, (y0 + base + 0.05) / 2, 0));
    // gable roof along the long side
    const ridge = barn ? 3.6 : 2.7;
    const over = 0.55;
    const ry = top + ridge;
    const roofKind: Kind = barn || rng.next() < 0.2 ? 'metal' : 'tiles';
    add(roofKind, prismX([[-d / 2 - over, top - 0.3], [d / 2 + over, top - 0.3], [0, ry]], -w / 2 - over, w / 2 + over));
    // gable ends
    for (const sx of [-1, 1]) add(wall, prismX([[-d / 2, top], [d / 2, top], [0, ry - 0.25]], sx * w / 2 - (sx > 0 ? 0.2 : 0), sx * w / 2 + (sx < 0 ? 0.2 : 0)));
    // ridge cap, fascia boards, gutters
    add('frame', box(w + over * 2 + 0.05, 0.12, 0.26, 0, ry + 0.02, 0));
    for (const sz of [-1, 1]) {
      add('wood', box(w + over * 2, 0.2, 0.05, 0, top - 0.38, sz * (d / 2 + over)));
      add('metal', cyl(0.07, 0.07, w + over * 2, 8, 'x', 0, top - 0.5, sz * (d / 2 + over + 0.07)));
    }
    if (!barn) {
      // framed windows with sills and lintels on both long sides
      const nWin = Math.max(2, Math.floor(w / 2.8));
      for (let i = 0; i < nWin; i++) {
        const wx = -w / 2 + (i + 0.5) * (w / nWin);
        const wy = base + 1.55;
        for (const s of [-1, 1]) {
          const z0 = s * (d / 2);
          add('glass', box(0.92, 1.22, 0.04, wx, wy, z0 - s * 0.06));
          add('frame', box(1.04, 0.07, 0.12, wx, wy + 0.63, z0));
          add('frame', box(1.04, 0.07, 0.12, wx, wy - 0.63, z0));
          add('frame', box(0.07, 1.3, 0.12, wx - 0.5, wy, z0));
          add('frame', box(0.07, 1.3, 0.12, wx + 0.5, wy, z0));
          add('frame', box(0.05, 1.2, 0.08, wx, wy, z0)); // mullion
          add('concrete', box(1.2, 0.07, 0.24, wx, wy - 0.7, z0 + s * 0.08));
          if (wall === 'brick') add('concrete', box(1.2, 0.14, 0.1, wx, wy + 0.72, z0 + s * 0.02));
        }
      }
      // door with frame and step
      const dx = w / 2 - 1.3;
      add('wood', box(1.0, 2.1, 0.08, dx, base + 1.05, d / 2 + 0.01));
      add('frame', box(1.16, 0.08, 0.12, dx, base + 2.14, d / 2 + 0.02));
      add('frame', box(0.08, 2.18, 0.12, dx - 0.54, base + 1.07, d / 2 + 0.02));
      add('frame', box(0.08, 2.18, 0.12, dx + 0.54, base + 1.07, d / 2 + 0.02));
      add('concrete', box(1.4, 0.2, 0.6, dx, base - 0.1, d / 2 + 0.3));
      // chimney with cap
      add('brick', box(0.6, ridge + 1.4, 0.6, w * 0.25, top + (ridge + 1.4) / 2, d * 0.12));
      add('concrete', box(0.78, 0.1, 0.78, w * 0.25, top + ridge + 1.45, d * 0.12));
    } else {
      // barn doors, cross-braced
      add('wood', box(3.4, 3.5, 0.12, 0, base + 1.75, d / 2 + 0.04));
      add('frame', box(3.6, 0.12, 0.16, 0, base + 3.55, d / 2 + 0.05));
      add('wood', box(0.14, 4.4, 0.06, 0, base + 1.75, d / 2 + 0.12, 0, 0, Math.atan2(3.4, 3.5)));
      add('wood', box(0.14, 4.4, 0.06, 0, base + 1.75, d / 2 + 0.12, 0, 0, -Math.atan2(3.4, 3.5)));
    }
    colliders.push({ x, z, y0, y1: ry, hw: w / 2, hd: d / 2, rot });
    return true;
  };

  SITES.forEach((s, idx) => {
    const houses = idx === 0 ? 14 : 2;
    let placed = 0;
    for (let a = 0; a < 300 && placed < houses; a++) {
      const ang = rng.next() * Math.PI * 2;
      const dist = Math.sqrt(rng.next()) * s.r * 0.8;
      const barn = idx !== 0 ? placed === 1 : rng.next() < 0.2;
      const w = barn ? rng.range(12, 18) : rng.range(8, 12);
      const d = barn ? rng.range(8, 10) : rng.range(6, 8);
      const h = barn ? rng.range(4, 5) : rng.range(2.8, 5.8);
      const rot = Math.round(rng.next() * 4) * (Math.PI / 2) + rng.range(-0.15, 0.15);
      if (place(s.x + Math.cos(ang) * dist, s.z + Math.sin(ang) * dist, w, d, h, rot, barn ? 'barn' : 'house')) placed++;
    }
  });

  const glass = stdMat('windowGlass', { color: 0x151c20, roughness: 0.04 });
  addThermalConst(glass, 0.05);
  const group = new THREE.Group();
  for (const k of ['brick', 'plaster', 'tiles', 'wood', 'frame', 'metal', 'concrete', 'glass'] as Kind[]) {
    const g = parts.build(k);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, k === 'glass' ? glass : buildingMaterial(k));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, colliders };
}

/** Push a circle (x,z,r) out of an OBB. Returns true if it was touching. */
export function pushOutObb(c: Obb, p: { x: number; z: number }, r: number): boolean {
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  // into box frame (rotation about Y by -rot)
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const qx = Math.max(-c.hw, Math.min(c.hw, lx));
  const qz = Math.max(-c.hd, Math.min(c.hd, lz));
  let ex = lx - qx;
  let ez = lz - qz;
  let d = hyp2(ex, ez);
  if (d >= r) return false;
  if (d < 1e-6) {
    // centre inside: push out along the shallow axis
    const px = c.hw - Math.abs(lx);
    const pz = c.hd - Math.abs(lz);
    if (px < pz) {
      ex = Math.sign(lx) || 1;
      ez = 0;
      d = -px;
    } else {
      ex = 0;
      ez = Math.sign(lz) || 1;
      d = -pz;
    }
  } else {
    ex /= d;
    ez /= d;
  }
  const push = r - d;
  const nlx = qx + ex * (d + push);
  const nlz = qz + ez * (d + push);
  // back to world
  p.x = c.x + nlx * cos + nlz * sin;
  p.z = c.z - nlx * sin + nlz * cos;
  return true;
}

/** Segment vs OBB (ray-cast for shells and line of sight). Returns t in [0,1] or -1. */
export function segmentObb(c: Obb, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  // quick reject: segment vs. the footprint's bounding circle (most rays pass far away)
  const sx = bx - ax;
  const sz = bz - az;
  const l2 = sx * sx + sz * sz;
  const tc = l2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - ax) * sx + (c.z - az) * sz) / l2)) : 0;
  const ex = ax + sx * tc - c.x;
  const ez = az + sz * tc - c.z;
  const br = c.hw + c.hd;
  if (ex * ex + ez * ez > br * br) return -1;
  // slab test in the box frame, scalar only (runs for every ray against every building)
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const adx = ax - c.x;
  const adz = az - c.z;
  const bdx = bx - c.x;
  const bdz = bz - c.z;
  const alx = adx * cos - adz * sin;
  const alz = adx * sin + adz * cos;
  const blx = bdx * cos - bdz * sin;
  const blz = bdx * sin + bdz * cos;
  const range = { tmin: 0, tmax: 1 };
  if (!slab(alx, blx - alx, c.hw, range)) return -1;
  if (!slab(ay - (c.y0 + c.y1) / 2, by - ay, (c.y1 - c.y0) / 2, range)) return -1;
  if (!slab(alz, blz - alz, c.hd, range)) return -1;
  return range.tmin;
}

function slab(o: number, d: number, h: number, r: { tmin: number; tmax: number }): boolean {
  if (Math.abs(d) < 1e-9) return Math.abs(o) <= h;
  let t0 = (-h - o) / d;
  let t1 = (h - o) / d;
  if (t0 > t1) {
    const t = t0;
    t0 = t1;
    t1 = t;
  }
  if (t0 > r.tmin) r.tmin = t0;
  if (t1 < r.tmax) r.tmax = t1;
  return r.tmin <= r.tmax;
}
