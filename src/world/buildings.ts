import * as THREE from 'three';
import { Rng } from '../core/rng';
import { box, mergeParts, prismX } from '../render/geom';
import { stdMat } from '../render/palette';
import { addThermalConst } from '../render/shaderPatch';
import type { Heightfield } from './heightfield';
import { SITES } from './layout';

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

/**
 * Farm houses and barns: brick or rendered walls, pitched roofs, dark glazing.
 * All geometry is merged per material — a whole village costs five draw calls.
 */
export function buildBuildings(hf: Heightfield, seed: number): { group: THREE.Group; colliders: Obb[] } {
  const rng = new Rng(seed);
  const parts: Record<'brick' | 'plaster' | 'roof' | 'glass' | 'wood', THREE.BufferGeometry[]> = {
    brick: [], plaster: [], roof: [], glass: [], wood: [],
  };
  const colliders: Obb[] = [];
  const place = (x: number, z: number, w: number, d: number, h: number, rot: number, kind: 'house' | 'barn') => {
    for (const c of colliders) if (Math.hypot(c.x - x, c.z - z) < Math.max(c.hw, c.hd) + Math.max(w, d) / 2 + 4) return false;
    // keep off the roads
    for (const [cx, cz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, 0]] as const) {
      const px = x + cx * Math.cos(rot) + cz * Math.sin(rot);
      const pz = z - cx * Math.sin(rot) + cz * Math.cos(rot);
      if (hf.roadAt(px, pz) > 0.05) return false;
    }
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const [cx, cz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]] as const) {
      const px = x + cx * Math.cos(rot) + cz * Math.sin(rot);
      const pz = z - cx * Math.sin(rot) + cz * Math.cos(rot);
      const y = hf.heightAt(px, pz);
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
    }
    if (ymax - ymin > 2.2) return false;
    const y0 = ymin - 0.4;
    const base = ymax;
    const m = new THREE.Matrix4().makeRotationY(rot).setPosition(x, 0, z);
    const wallKey = kind === 'barn' ? 'wood' : rng.next() < 0.55 ? 'brick' : 'plaster';
    const g: THREE.BufferGeometry[] = [];
    g.push(box(w, base - y0 + h, d, 0, (y0 + base + h) / 2, 0));
    parts[wallKey].push(...g.map((q) => q.applyMatrix4(m)));
    // plinth
    parts.plaster.push(box(w + 0.1, 0.5 + (base - y0), d + 0.1, 0, (y0 + base + 0.5) / 2, 0).applyMatrix4(m));
    // gable roof along the long side
    const ridge = kind === 'barn' ? 3.6 : 2.6;
    const over = 0.45;
    const roof = prismX(
      [[-d / 2 - over, base + h - 0.25], [d / 2 + over, base + h - 0.25], [0, base + h + ridge]],
      -w / 2 - over,
      w / 2 + over,
    );
    parts.roof.push(roof.applyMatrix4(m));
    // gable walls
    parts[wallKey].push(
      prismX([[-d / 2, base + h], [d / 2, base + h], [0, base + h + ridge - 0.3]], -w / 2, -w / 2 + 0.2).applyMatrix4(m),
      prismX([[-d / 2, base + h], [d / 2, base + h], [0, base + h + ridge - 0.3]], w / 2 - 0.2, w / 2).applyMatrix4(m),
    );
    if (kind === 'house') {
      // windows on both long sides + door
      const nWin = Math.max(2, Math.floor(w / 3));
      for (let i = 0; i < nWin; i++) {
        const wx = -w / 2 + (i + 0.5) * (w / nWin);
        for (const s of [-1, 1]) {
          parts.glass.push(box(0.9, 1.2, 0.06, wx, base + 1.5, s * (d / 2 + 0.01)).applyMatrix4(m));
          parts.wood.push(box(1.1, 0.12, 0.14, wx, base + 0.86, s * (d / 2 + 0.04)).applyMatrix4(m));
        }
      }
      parts.wood.push(box(1.0, 2.1, 0.08, w / 2 - 1.2, base + 1.05, d / 2 + 0.02).applyMatrix4(m));
      // chimney
      parts.brick.push(box(0.6, 2.0, 0.6, w * 0.25, base + h + ridge * 0.7, d * 0.12).applyMatrix4(m));
    } else {
      parts.wood.push(box(3.2, 3.4, 0.1, 0, base + 1.7, d / 2 + 0.03).applyMatrix4(m));
    }
    colliders.push({ x, z, y0, y1: base + h + ridge, hw: w / 2, hd: d / 2, rot });
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

  const mats = {
    brick: stdMat('brick'),
    plaster: stdMat('concrete', { color: 0xa39d92 }),
    roof: stdMat('rust', { color: 0x6b3a2c, roughness: 0.8 }),
    glass: stdMat('windowGlass', { color: 0x1a2226, roughness: 0.05 }),
    wood: stdMat('treeBark', { color: 0x5a4636, roughness: 0.85 }),
  };
  addThermalConst(mats.brick, 0.12);
  addThermalConst(mats.plaster, 0.11);
  addThermalConst(mats.roof, 0.1);
  addThermalConst(mats.glass, 0.05);
  addThermalConst(mats.wood, 0.09);
  const group = new THREE.Group();
  for (const k of Object.keys(parts) as (keyof typeof parts)[]) {
    if (!parts[k].length) continue;
    const mesh = new THREE.Mesh(mergeParts(parts[k]), mats[k]);
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
  let d = Math.hypot(ex, ez);
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
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const tl = (x: number, z: number): [number, number] => {
    const dx = x - c.x;
    const dz = z - c.z;
    return [dx * cos - dz * sin, dx * sin + dz * cos];
  };
  const [alx, alz] = tl(ax, az);
  const [blx, blz] = tl(bx, bz);
  const o = [alx, ay - (c.y0 + c.y1) / 2, alz];
  const d = [blx - alx, by - ay, blz - alz];
  const h = [c.hw, (c.y1 - c.y0) / 2, c.hd];
  let tmin = 0;
  let tmax = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-9) {
      if (Math.abs(o[i]!) > h[i]!) return -1;
      continue;
    }
    let t0 = (-h[i]! - o[i]!) / d[i]!;
    let t1 = (h[i]! - o[i]!) / d[i]!;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return -1;
  }
  return tmin;
}
