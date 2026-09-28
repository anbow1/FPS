import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BufferAttribute, BufferGeometry, Vector3 } from 'three/webgpu';

// Small geometry helpers shared by the plant, prop and arm builders. All sizes
// in metres; every geometry carries position, normal and uv so they merge.

export function merge(parts: BufferGeometry[], name: string): BufferGeometry {
  const clean = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of clean) {
    for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
  }
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error(`geometry merge failed for '${name}'`);
  return out;
}

/**
 * A tube along a polyline with a radius per point. u runs around, v along the
 * length in metres / vTileM. Open-ended unless `capEnd`.
 */
export function tube(points: readonly Vector3[], radii: readonly number[], radial: number, vTileM: number, capEnd = false): BufferGeometry {
  if (points.length < 2 || radii.length !== points.length) throw new Error(`tube needs ≥ 2 points and one radius per point, got ${points.length} / ${radii.length}`);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const tangent = new Vector3();
  const side = new Vector3();
  const up = new Vector3();
  const ref = new Vector3(1, 0, 0);
  let lengthM = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vector3;
    if (i > 0) lengthM += p.distanceTo(points[i - 1] as Vector3);
    const a = points[Math.max(0, i - 1)] as Vector3;
    const b = points[Math.min(points.length - 1, i + 1)] as Vector3;
    tangent.subVectors(b, a).normalize();
    if (Math.abs(tangent.dot(ref)) > 0.9) ref.set(0, 0, 1);
    side.crossVectors(tangent, ref).normalize();
    up.crossVectors(side, tangent).normalize();
    const r = radii[i] as number;
    for (let k = 0; k <= radial; k++) {
      const ang = (k / radial) * Math.PI * 2;
      const nx = side.x * Math.cos(ang) + up.x * Math.sin(ang);
      const ny = side.y * Math.cos(ang) + up.y * Math.sin(ang);
      const nz = side.z * Math.cos(ang) + up.z * Math.sin(ang);
      pos.push(p.x + nx * r, p.y + ny * r, p.z + nz * r);
      nor.push(nx, ny, nz);
      uv.push(k / radial, lengthM / vTileM);
    }
  }
  const ring = radial + 1;
  for (let i = 0; i < points.length - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * ring + k;
      const b = a + ring;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  if (capEnd) {
    const last = points[points.length - 1] as Vector3;
    const centre = pos.length / 3;
    pos.push(last.x, last.y, last.z);
    nor.push(tangent.x, tangent.y, tangent.z);
    uv.push(0.5, lengthM / vTileM);
    const base = (points.length - 1) * ring;
    for (let k = 0; k < radial; k++) idx.push(base + k, base + k + 1, centre);
  }
  return indexed(pos, nor, uv, idx);
}

export function indexed(pos: number[], nor: number[], uv: number[], idx: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/**
 * A card strip along a spine: `spine[i]` with `side[i]` (unit, across) and a
 * half-width. The two halves fold down by `foldRad` about the spine, like a
 * palm frond's two ranks of leaflets. u 0 → 1 across, v 0 → 1 along.
 * Normals are bent toward `bendFrom` → vertex, so a crown shades as a volume.
 */
export function foldedStrip(spine: readonly Vector3[], sides: readonly Vector3[], halfWidths: readonly number[], foldRad: readonly number[], bendFrom: Vector3 | null, bendK: number): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const t = new Vector3();
  const n = new Vector3();
  const e = new Vector3();
  const bent = new Vector3();
  for (let i = 0; i < spine.length; i++) {
    const p = spine[i] as Vector3;
    const s = sides[i] as Vector3;
    t.subVectors(spine[Math.min(spine.length - 1, i + 1)] as Vector3, spine[Math.max(0, i - 1)] as Vector3).normalize();
    n.crossVectors(s, t).normalize(); // the strip's "up"
    const w = halfWidths[i] as number;
    const f = foldRad[i] as number;
    const v = i / (spine.length - 1);
    for (const [u, sign] of [
      [0, -1],
      [0.5, 0],
      [1, 1],
    ] as const) {
      e.copy(p);
      if (sign !== 0) e.addScaledVector(s, sign * w * Math.cos(f)).addScaledVector(n, -w * Math.sin(f));
      pos.push(e.x, e.y, e.z);
      bent.copy(n);
      if (bendFrom) bent.multiplyScalar(1 - bendK).addScaledVector(e.clone().sub(bendFrom).normalize(), bendK);
      bent.normalize();
      nor.push(bent.x, bent.y, bent.z);
      uv.push(u, v);
    }
  }
  for (let i = 0; i < spine.length - 1; i++) {
    const a = i * 3;
    const b = a + 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  return indexed(pos, nor, uv, idx);
}

/** An upright quad card of the given size, base at y = 0, facing +Z. */
export function card(widthM: number, heightM: number): BufferGeometry {
  const w = widthM / 2;
  return indexed([-w, 0, 0, w, 0, 0, w, heightM, 0, -w, heightM, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3]);
}

/** Deterministic 0..1 from integers (for per-part variation in builders). */
export function rand(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
