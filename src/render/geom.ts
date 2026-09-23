import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural hard-surface helpers. Every result is non-indexed with position + normal only,
 * so parts can be freely merged per material (one draw call per material per part).
 */

const _c = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();

function finish(positions: number[]): THREE.BufferGeometry {
  // Orient every triangle outward relative to the solid centroid, then flat normals.
  const pos = new Float32Array(positions);
  _c.set(0, 0, 0);
  const count = pos.length / 3;
  for (let i = 0; i < count; i++) _c.add(_a.fromArray(pos, i * 3));
  _c.divideScalar(count);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  for (let t = 0; t < count; t += 3) {
    p0.fromArray(pos, t * 3);
    p1.fromArray(pos, t * 3 + 3);
    p2.fromArray(pos, t * 3 + 6);
    _a.subVectors(p1, p0);
    _b.subVectors(p2, p0);
    _n.crossVectors(_a, _b);
    const mid = _a.copy(p0).add(p1).add(p2).divideScalar(3).sub(_c);
    if (_n.dot(mid) < 0) {
      p1.toArray(pos, t * 3 + 6);
      p2.toArray(pos, t * 3 + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Solid between two rings with the same vertex count (convex caps). */
export function loft(bottom: THREE.Vector3[], top: THREE.Vector3[], capAxis: 'x' | 'y' | 'z'): THREE.BufferGeometry {
  const out: number[] = [];
  const n = bottom.length;
  const push = (v: THREE.Vector3) => out.push(v.x, v.y, v.z);
  for (let i = 0; i < n; i++) {
    const a = bottom[i]!;
    const b = bottom[(i + 1) % n]!;
    const c = top[(i + 1) % n]!;
    const d = top[i]!;
    push(a); push(b); push(c);
    push(a); push(c); push(d);
  }
  for (const ring of [bottom, top]) {
    const pts2 = ring.map((v) =>
      capAxis === 'y' ? new THREE.Vector2(v.x, v.z) : capAxis === 'x' ? new THREE.Vector2(v.z, v.y) : new THREE.Vector2(v.x, v.y),
    );
    const tris = THREE.ShapeUtils.triangulateShape(pts2, []);
    for (const [i0, i1, i2] of tris) {
      push(ring[i0!]!); push(ring[i1!]!); push(ring[i2!]!);
    }
  }
  return finish(out);
}

/** Vertical prism from an XZ polygon; optional different top polygon for taper. */
export function prismY(poly: [number, number][], y0: number, y1: number, topPoly?: [number, number][]): THREE.BufferGeometry {
  const b = poly.map(([x, z]) => new THREE.Vector3(x, y0, z));
  const t = (topPoly ?? poly).map(([x, z]) => new THREE.Vector3(x, y1, z));
  return loft(b, t, 'y');
}

/** Side profile in (z, y) extruded across x — hulls, glacis plates, fenders. */
export function prismX(profile: [number, number][], x0: number, x1: number): THREE.BufferGeometry {
  const a = profile.map(([z, y]) => new THREE.Vector3(x0, y, z));
  const b = profile.map(([z, y]) => new THREE.Vector3(x1, y, z));
  return loft(a, b, 'x');
}

export function box(w: number, h: number, d: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.deleteAttribute('uv');
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

/** Cylinder along an axis. */
export function cyl(
  r0: number, r1: number, len: number, seg: number, axis: 'x' | 'y' | 'z',
  x = 0, y = 0, z = 0, open = false,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, open).toNonIndexed();
  g.deleteAttribute('uv');
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** Lathe around the X axis (wheels). profile: [radius, x] pairs. */
export function latheX(profile: [number, number][], seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), seg).toNonIndexed();
  g.deleteAttribute('uv');
  g.rotateZ(-Math.PI / 2);
  return g;
}

export function sphereCap(rx: number, ry: number, rz: number, wSeg: number, hSeg: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, wSeg, hSeg, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  g.deleteAttribute('uv');
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return g;
}

export function xform(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(m);
  return g;
}

/** Merge, stripping everything but position + normal. Adds a `tankPos` attribute = position + offset. */
export function mergeParts(parts: THREE.BufferGeometry[], offset = new THREE.Vector3()): THREE.BufferGeometry {
  const clean = parts.map((p) => {
    let g = p.index ? p.toNonIndexed() : p;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    return g;
  });
  const merged = mergeGeometries(clean, false);
  if (!merged) throw new Error('merge failed');
  const pos = merged.getAttribute('position') as THREE.BufferAttribute;
  const tp = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    tp[i * 3] = pos.getX(i) + offset.x;
    tp[i * 3 + 1] = pos.getY(i) + offset.y;
    tp[i * 3 + 2] = pos.getZ(i) + offset.z;
  }
  merged.setAttribute('tankPos', new THREE.BufferAttribute(tp, 3));
  merged.computeBoundingSphere();
  return merged;
}

/** 2D convex hull (monotone chain). */
export function convexHull2(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
