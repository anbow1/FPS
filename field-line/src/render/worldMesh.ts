import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Group, InstancedMesh, type Material, Matrix4, Mesh, Quaternion, Vector3 } from 'three/webgpu';
import type { BoxLook, MapBox, MapData } from '../maps/types.ts';
import { awningMaterial, facadeTrim } from './facadeTrim.ts';
import type { MaterialLibrary } from './materials.ts';

// Static world geometry. Map boxes are merged per material into a few large
// meshes (draw calls stay far under the 2500 / 1500 ceiling), with world-space
// UVs so walls built from many pieces keep one continuous brick pattern.
// Glass panes are instanced one per pane because bullets and grenades break
// them one at a time.

export interface StaticWorld {
  group: Group;
  glass: InstancedMesh | null;
  /** For each glass instance, the collider id (= map box index) that backs it. */
  glassColliderIds: number[];
}

class GeometryBuffer {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  /** Per vertex (bay, storey) in metres on façade meshes, for the rooms behind the windows; empty elsewhere. */
  readonly tiles: number[] = [];
  readonly indices: number[] = [];
  readonly groups: { start: number; count: number; materialIndex: number }[] = [];

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    if (this.tiles.length > 0) g.setAttribute('tileSize', new BufferAttribute(new Float32Array(this.tiles), 2));
    g.setIndex(this.positions.length / 3 > 65535 ? new BufferAttribute(new Uint32Array(this.indices), 1) : new BufferAttribute(new Uint16Array(this.indices), 1));
    for (const gr of this.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.computeBoundingSphere();
    return g;
  }
}

// Local face frames: normal, right (u), up (v). Right = up × normal, so the
// pattern reads left to right when seen from outside.
const FACES: { n: [number, number, number]; r: [number, number, number]; u: [number, number, number] }[] = [
  { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
  { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
];

interface UvRule {
  tileU: number;
  tileV: number;
  baseY: number; // v origin for side faces
}

/** Appends one yaw-rotated box. `sideGroup` / `capGroup` pick the material index for the faces. */
function appendBox(buf: GeometryBuffer, box: MapBox, rule: UvRule, capRule: UvRule, sideGroup: number, capGroup: number, pending: Map<number, number[]>, tileSize = false): void {
  const yaw = box.yawRad ?? 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const rot = (v: [number, number, number]): [number, number, number] => [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
  const hx = box.size.x / 2;
  const hy = box.size.y / 2;
  const hz = box.size.z / 2;
  for (const f of FACES) {
    const side = f.n[1] === 0;
    const group = side ? sideGroup : capGroup;
    const r = side ? rule : capRule;
    const n = rot(f.n);
    const right = rot(f.r);
    const up = rot(f.u);
    // Half extents along this face's normal, right and up (local axes).
    const along = (v: [number, number, number]): number => Math.abs(v[0]) * hx + Math.abs(v[1]) * hy + Math.abs(v[2]) * hz;
    const dn = along(f.n);
    const dr = along(f.r);
    const du = along(f.u);
    const base = buf.positions.length / 3;
    // Façade sides: a whole number of bays from corner to corner (the bay stretched to fit), so no window
    // is cut by a corner; u starts at the face's left corner, plus a whole-number offset per building so
    // neighbouring blocks do not repeat each other's rooms (roomInteriors.ts hashes the bay index).
    const fitted = side && tileSize;
    const bays = fitted ? Math.max(1, Math.round((2 * dr) / r.tileU)) : 1;
    const tileU = fitted ? (2 * dr) / bays : r.tileU;
    const leftU = box.center.x * right[0] + box.center.z * right[2] - dr;
    const offsetU = fitted ? ((box.facade?.seed ?? 0) % 89) * 3 : 0;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const px = box.center.x + n[0] * dn + right[0] * dr * a + up[0] * du * b;
      const py = box.center.y + n[1] * dn + right[1] * dr * a + up[1] * du * b;
      const pz = box.center.z + n[2] * dn + right[2] * dr * a + up[2] * du * b;
      buf.positions.push(px, py, pz);
      buf.normals.push(n[0], n[1], n[2]);
      if (tileSize) buf.tiles.push(tileU, rule.tileV);
      if (fitted) buf.uvs.push((px * right[0] + pz * right[2] - leftU) / tileU + offsetU, (py - r.baseY) / r.tileV);
      else if (side) buf.uvs.push((px * right[0] + pz * right[2]) / r.tileU, (py - r.baseY) / r.tileV);
      else buf.uvs.push((px * right[0] + pz * right[2]) / r.tileU, (px * up[0] + pz * up[2]) / r.tileV);
    }
    let list = pending.get(group);
    if (!list) {
      list = [];
      pending.set(group, list);
    }
    list.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function flush(buf: GeometryBuffer, pending: Map<number, number[]>): void {
  for (const [group, list] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    buf.groups.push({ start: buf.indices.length, count: list.length, materialIndex: group });
    for (const i of list) buf.indices.push(i);
  }
}

export function buildStaticWorld(map: MapData, lib: MaterialLibrary): StaticWorld {
  const group = new Group();
  group.name = 'staticWorld';
  const byLook = new Map<BoxLook, MapBox[]>();
  const facades = new Map<BoxLook, MapBox[]>();
  const glassBoxes: { box: MapBox; index: number }[] = [];
  map.boxes.forEach((box, index) => {
    if (box.look === 'invisible') return;
    if (box.look === 'glass' || box.look === 'facadeGlass') {
      glassBoxes.push({ box, index });
      return;
    }
    const target = box.facade ? facades : byLook;
    let list = target.get(box.look);
    if (!list) {
      list = [];
      target.set(box.look, list);
    }
    list.push(box);
  });

  for (const [look, boxes] of byLook) {
    const lm = lib.look(look);
    const rule = { tileU: lm.tileM, tileV: lm.tileM, baseY: 0 };
    const buf = new GeometryBuffer();
    const pending = new Map<number, number[]>();
    for (const b of boxes) appendBox(buf, b, rule, rule, 0, 0, pending);
    flush(buf, pending);
    group.add(staticMesh(buf.toGeometry(), lm.material, `boxes-${look}`));
  }

  // Façade blocks: sides get the bay pattern (one tile per bay × storey), tops the roof.
  const roof = lib.look('roofTar');
  for (const [look, boxes] of facades) {
    const buf = new GeometryBuffer();
    const pending = new Map<number, number[]>();
    for (const b of boxes) {
      const f = b.facade;
      if (!f) continue;
      appendBox(buf, b, { tileU: f.bayM, tileV: f.storeyM, baseY: b.center.y - b.size.y / 2 }, { tileU: roof.tileM, tileV: roof.tileM, baseY: 0 }, 0, 1, pending, true);
    }
    flush(buf, pending);
    group.add(staticMesh(buf.toGeometry(), [lib.facade(look).material, roof.material], `facade-${look}`));
  }
  const pipes = drainpipes([...facades.values()].flat());
  if (pipes) group.add(staticMesh(pipes, lib.look('metalDark').material, 'drainpipes'));
  const trim = facadeTrim([...facades.values()].flat(), { stoneM: lib.look('concrete').tileM, plinthM: lib.look('stone').tileM, wallM: (look) => lib.look(look).tileM }, map.halfSizeM - 25);
  if (trim.stone) group.add(staticMesh(trim.stone, lib.look('concrete').material, 'cornices'));
  if (trim.plinth) group.add(staticMesh(trim.plinth, lib.look('stone').material, 'plinths'));
  for (const [look, g] of trim.parapets) group.add(staticMesh(g, lib.look(look).material, `parapets-${look}`));
  if (trim.details) {
    const sills = staticMesh(trim.details, lib.look('concrete').material, 'sills');
    sills.castShadow = false;
    group.add(sills);
  }
  if (trim.awnings) group.add(staticMesh(trim.awnings, awningMaterial(), 'awnings'));

  let glass: InstancedMesh | null = null;
  const glassColliderIds: number[] = [];
  if (glassBoxes.length > 0) {
    glass = new InstancedMesh(new BoxGeometry(1, 1, 1), lib.get('windowGlass'), glassBoxes.length);
    glass.name = 'glass';
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    glassBoxes.forEach(({ box, index }, i) => {
      q.setFromAxisAngle(up, box.yawRad ?? 0);
      m.compose(new Vector3(box.center.x, box.center.y, box.center.z), q, new Vector3(box.size.x, box.size.y, box.size.z));
      glass?.setMatrixAt(i, m);
      glassColliderIds.push(index);
    });
    glass.computeBoundingSphere();
    group.add(glass);
  }

  if (map.roads.length > 0) group.add(roadMarkings(map, lib));
  return { group, glass, glassColliderIds };
}

/**
 * Rainwater downpipes on two diagonal corners of every façade block: roof to pavement, held off the wall
 * by brackets every 2 m, with a shoe at the foot turned out over the drain.
 */
function drainpipes(boxes: readonly MapBox[]): BufferGeometry | null {
  const parts: BufferGeometry[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  for (const b of boxes) {
    const yaw = b.yawRad ?? 0;
    q.setFromAxisAngle(up, yaw);
    const base = b.center.y - b.size.y / 2;
    const top = b.center.y + b.size.y / 2;
    for (const [sx, sz] of [
      [1, 1],
      [-1, -1],
    ] as const) {
      // Just off the corner, on the wall facing ±X (local), 12 cm from the edge.
      const lx = sx * (b.size.x / 2 + 0.07);
      const lz = sz * (b.size.z / 2 - 0.12);
      const local: BufferGeometry[] = [new CylinderGeometry(0.05, 0.05, top - base - 0.25, 8, 1, true).translate(lx, base + 0.25 + (top - base - 0.25) / 2, lz)];
      for (let y = base + 1.5; y < top - 0.3; y += 2) local.push(new BoxGeometry(0.1, 0.03, 0.12).translate(lx - sx * 0.04, y, lz));
      // Shoe: a short elbow at the foot, out over the pavement.
      local.push(new CylinderGeometry(0.05, 0.05, 0.3, 8).rotateZ(sx * 0.9).translate(lx + sx * 0.08, base + 0.17, lz));
      // Hopper under the roof edge.
      local.push(new CylinderGeometry(0.1, 0.05, 0.18, 8).translate(lx, top - 0.18, lz));
      for (const g of local) {
        m.compose(new Vector3(b.center.x, 0, b.center.z), q, new Vector3(1, 1, 1));
        const ng = g.index ? g.toNonIndexed() : g;
        ng.applyMatrix4(m);
        parts.push(ng);
      }
    }
  }
  if (parts.length === 0) return null;
  return mergeGeometries(parts, false);
}

function staticMesh(geometry: BufferGeometry, material: Material | Material[], name: string): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Lane markings: a solid double centre line and dashed lane dividers, broken at junctions. */
function roadMarkings(map: MapData, lib: MaterialLibrary): Mesh {
  const buf = new GeometryBuffer();
  const pending = new Map<number, number[]>();
  const quad = (x0: number, z0: number, x1: number, z1: number): void => {
    const base = buf.positions.length / 3;
    buf.positions.push(x0, 0.004, z1, x1, 0.004, z1, x1, 0.004, z0, x0, 0.004, z0);
    for (let i = 0; i < 4; i++) buf.normals.push(0, 1, 0);
    buf.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    let list = pending.get(0);
    if (!list) {
      list = [];
      pending.set(0, list);
    }
    list.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const crossings = map.roads.map((r) => (r.a.x === r.b.x ? r.a.x : r.a.z));
  // Lane lines stop short of each junction, leaving room for the crossing and the stop line.
  const clearOfJunction = (a: number, half: number): boolean => crossings.every((c) => Math.abs(a - c) > half + 6);
  // At every junction, on each of its four approaches: a zebra crossing (0.5 m bars, 0.5 m gaps, 3 m long)
  // just outside the junction and a stop line across the incoming lanes behind it (traffic on the right).
  const zCentres = map.roads.filter((r) => r.a.x === r.b.x).map((r) => r.a.x);
  const xCentres = map.roads.filter((r) => r.a.z === r.b.z).map((r) => r.a.z);
  for (const cx of zCentres) {
    for (const cz of xCentres) {
      const half = (map.roads[0]?.widthM ?? 14) / 2;
      for (const dir of [-1, 1]) {
        // The road along Z, approached from the ±Z side.
        for (let x = cx - half + 0.75; x + 0.5 <= cx + half - 0.5; x += 1) quad(x, Math.min(cz + dir * (half + 1), cz + dir * (half + 4)), x + 0.5, Math.max(cz + dir * (half + 1), cz + dir * (half + 4)));
        const sz = cz + dir * (half + 4.8);
        const sx0 = dir > 0 ? cx + 0.2 : cx - half + 0.3;
        quad(sx0, Math.min(sz, sz + dir * 0.3), sx0 + half - 0.5, Math.max(sz, sz + dir * 0.3));
        // The road along X, approached from the ±X side.
        for (let z = cz - half + 0.75; z + 0.5 <= cz + half - 0.5; z += 1) quad(Math.min(cx + dir * (half + 1), cx + dir * (half + 4)), z, Math.max(cx + dir * (half + 1), cx + dir * (half + 4)), z + 0.5);
        const sx = cx + dir * (half + 4.8);
        const sz0 = dir > 0 ? cz - half + 0.3 : cz + 0.2;
        quad(Math.min(sx, sx + dir * 0.3), sz0, Math.max(sx, sx + dir * 0.3), sz0 + half - 0.5);
      }
    }
  }
  for (const road of map.roads) {
    const alongZ = road.a.x === road.b.x;
    const c = alongZ ? road.a.x : road.a.z;
    const from = alongZ ? road.a.z : road.a.x;
    const to = alongZ ? road.b.z : road.b.x;
    const half = road.widthM / 2;
    for (let a = from; a < to; a += 3) {
      if (!clearOfJunction(a + 1.5, half) || !clearOfJunction(a, half)) continue;
      const put = (offset: number, width: number, length: number): void => {
        if (alongZ) quad(c + offset - width / 2, a, c + offset + width / 2, a + length);
        else quad(a, c + offset - width / 2, a + length, c + offset + width / 2);
      };
      put(-0.12, 0.12, 3); // double centre line
      put(0.12, 0.12, 3);
      if (Math.round(a / 3) % 3 === 0) {
        put(-3.5, 0.12, 3); // lane dividers: 3 m dash, 6 m gap
        put(3.5, 0.12, 3);
      }
    }
  }
  flush(buf, pending);
  const mesh = new Mesh(buf.toGeometry(), lib.get('roadPaint'));
  mesh.name = 'roadMarkings';
  mesh.receiveShadow = true;
  return mesh;
}
