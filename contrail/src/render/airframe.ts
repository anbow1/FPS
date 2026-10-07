import { BufferAttribute, BufferGeometry } from 'three/webgpu';

// Geometry kernel for procedural airframes. Everything in metres in the
// aircraft's own frame: x right, y up, nose towards −z (rules §6: fix the
// orientation in the asset, never with a wrapper rotation).
//
//   fuselage  stations of a handful of parameters (crown, belly, chine width
//             and height, side slopes), interpolated along the body with a
//             monotone cubic (no overshoot between stations) and sampled every
//             few centimetres; each cross-section is two cubic Béziers per side
//             meeting at the chine. The chine is a vertex seam, so it is a crisp
//             edge when the slopes say so and smooth when they don't.
//   surface   wings, tails and control surfaces: a NACA 4-digit symmetric section
//             over a trapezoid, any chord × span sub-rectangle of it (so a
//             flaperon is cut out of the wing and hinged separately).
//   lathe     bodies of revolution with an optional radial modulation (nozzle
//             petals, serrated edges).
//
// Every vertex carries `surf` = (along, across) in metres on the skin: the
// paint shader draws panel lines, fasteners and weathering in it, so panels are
// never stretched by the shape.

export interface Station {
  z: number;
  /** Crown and belly heights at the centreline (m). */
  top: number;
  bot: number;
  /** Half-width at the chine and the chine's height (m). */
  w: number;
  yc: number;
  /** Crown and belly flatness 0…1: how far the horizontal tangent reaches out. */
  tw: number;
  bw: number;
  /** Side slopes 0…1 into the chine: 0 = vertical (round side), 1 = steep slope (sharp chine). */
  su: number;
  sl: number;
}

type Key = Exclude<keyof Station, 'z'>;
const KEYS: readonly Key[] = ['top', 'bot', 'w', 'yc', 'tw', 'bw', 'su', 'sl'];

/** Monotone cubic interpolation (Fritsch–Carlson) of ys over xs at x. */
function monotone(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let i = 0;
  while (x > xs[i + 1]!) i++;
  const h = (k: number): number => xs[k + 1]! - xs[k]!;
  const d = (k: number): number => (ys[k + 1]! - ys[k]!) / h(k);
  const tangent = (k: number): number => {
    if (k === 0) return d(0);
    if (k === n - 1) return d(n - 2);
    const a = d(k - 1);
    const b = d(k);
    if (a * b <= 0) return 0;
    const w1 = 2 * h(k) + h(k - 1);
    const w2 = h(k) + 2 * h(k - 1);
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const t = (x - xs[i]!) / h(i);
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h(i) * tangent(i) + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h(i) * tangent(i + 1);
}

/** The interpolated station at z. */
export function stationAt(stations: readonly Station[], z: number): Station {
  const xs = stations.map((s) => s.z);
  const out: Station = { z, top: 0, bot: 0, w: 0, yc: 0, tw: 0, bw: 0, su: 0, sl: 0 };
  for (const k of KEYS) out[k] = monotone(xs, stations.map((s) => s[k]), z);
  return out;
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Right half of a section, from the crown to the belly: [x, y] points, chine at index `perQuarter`. */
export function halfSection(s: Station, perQuarter: number): [number, number][] {
  const pts: [number, number][] = [];
  const hu = Math.max(s.top - s.yc, 1e-4);
  const hl = Math.max(s.yc - s.bot, 1e-4);
  // Upper quarter: crown (horizontal tangent) → chine.
  const u1x = s.tw * s.w;
  const u2x = s.w * (1 - 0.5 * s.su);
  const u2y = s.yc + hu * (0.45 + 0.25 * s.su);
  for (let i = 0; i <= perQuarter; i++) {
    const t = i / perQuarter;
    pts.push([bezier(0, u1x, u2x, s.w, t), bezier(s.top, s.top, u2y, s.yc, t)]);
  }
  // Lower quarter: chine → belly (horizontal tangent).
  const l1x = s.w * (1 - 0.5 * s.sl);
  const l1y = s.yc - hl * (0.45 + 0.25 * s.sl);
  const l2x = s.bw * s.w;
  for (let i = 1; i <= perQuarter; i++) {
    const t = i / perQuarter;
    pts.push([bezier(s.w, l1x, l2x, 0, t), bezier(s.yc, l1y, s.bot, s.bot, t)]);
  }
  return pts;
}

/** Height of the fuselage skin's underside at (x, z), for flush gear doors and pylons. */
export function bellyY(stations: readonly Station[], x: number, z: number): number {
  const half = halfSection(stationAt(stations, z), 24);
  const ax = Math.abs(x);
  let best = half[half.length - 1]![1];
  for (let i = half.length - 1; i > 24; i--) {
    const [x0, y0] = half[i]!;
    const [x1, y1] = half[i - 1]!;
    if ((ax >= x0 && ax <= x1) || (ax >= x1 && ax <= x0)) {
      const f = (ax - x0) / (x1 - x0 || 1);
      best = y0 + (y1 - y0) * f;
      break;
    }
  }
  return best;
}

class Builder {
  readonly pos: number[] = [];
  readonly surf: number[] = [];
  readonly idx: number[] = [];

  vertex(x: number, y: number, z: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.surf.push(u, v);
    return this.pos.length / 3 - 1;
  }

  /** A grid of rows × cols vertices (row-major) starting at `base`, quads wound so normals face `outward`. */
  grid(base: number, rows: number, cols: number, flip: boolean, wrap = false): void {
    const cc = wrap ? cols : cols - 1;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cc; c++) {
        const a = base + r * cols + c;
        const b = base + r * cols + ((c + 1) % cols);
        const d = base + (r + 1) * cols + c;
        const e = base + (r + 1) * cols + ((c + 1) % cols);
        if (flip) this.idx.push(a, b, d, b, e, d);
        else this.idx.push(a, d, b, b, d, e);
      }
    }
  }

  /** A fan from a new centre vertex to a run of existing vertices. */
  fan(cx: number, cy: number, cz: number, ring: number[], flip: boolean): void {
    const c = this.vertex(cx, cy, cz, 0, 0);
    for (let i = 0; i < ring.length - 1; i++) {
      if (flip) this.idx.push(c, ring[i + 1]!, ring[i]!);
      else this.idx.push(c, ring[i]!, ring[i + 1]!);
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('surf', new BufferAttribute(new Float32Array(this.surf), 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

export interface FuselageOptions {
  /** Ring spacing (m) and points per quarter section. */
  stepM?: number;
  perQuarter?: number;
  /** Skip rings in front of this z (a separate radome or nose cone covers it). */
  fromZ?: number;
  /** Lateral offset of the body's centre line (nacelles, inlet ducts). */
  offsetX?: number;
  /** Close the front / rear ends (an inlet mouth stays open). */
  capStart?: boolean;
  capEnd?: boolean;
}

/**
 * The fuselage skin from nose to tail. Two strips per ring — over the top between the chines, and under
 * the belly — so the chine is a crease exactly where the side slopes make one. Ends are capped.
 */
export function fuselage(stations: readonly Station[], opts: FuselageOptions = {}): BufferGeometry {
  const step = opts.stepM ?? 0.1;
  const q = opts.perQuarter ?? 18;
  const ox = opts.offsetX ?? 0;
  const z0 = Math.max(stations[0]!.z, opts.fromZ ?? -Infinity);
  const z1 = stations[stations.length - 1]!.z;
  const rings = Math.max(2, Math.ceil((z1 - z0) / step) + 1);
  const b = new Builder();
  // Upper strip: left chine → crown → right chine (2q + 1 points); lower: right chine → belly → left chine.
  const upperCols = 2 * q + 1;
  const lowerCols = 2 * q + 1;
  const upperBase = b.pos.length / 3;
  const upper: number[][] = [];
  const lower: number[][] = [];
  const sections: [number, number][][] = [];
  for (let r = 0; r < rings; r++) {
    const z = z0 + ((z1 - z0) * r) / (rings - 1);
    sections.push(halfSection(stationAt(stations, z), q));
  }
  for (let r = 0; r < rings; r++) {
    const z = z0 + ((z1 - z0) * r) / (rings - 1);
    const half = sections[r]!;
    // Arc lengths from the crown along the right half.
    const arc = [0];
    for (let i = 1; i < half.length; i++) arc.push(arc[i - 1]! + Math.hypot(half[i]![0] - half[i - 1]![0], half[i]![1] - half[i - 1]![1]));
    const row: number[] = [];
    for (let i = q; i >= 1; i--) row.push(b.vertex(ox - half[i]![0], half[i]![1], z, z, -arc[i]!));
    for (let i = 0; i <= q; i++) row.push(b.vertex(ox + half[i]![0], half[i]![1], z, z, arc[i]!));
    upper.push(row);
  }
  b.grid(upperBase, rings, upperCols, false);
  const lowerBase = b.pos.length / 3;
  for (let r = 0; r < rings; r++) {
    const z = z0 + ((z1 - z0) * r) / (rings - 1);
    const half = sections[r]!;
    const arc = [0];
    for (let i = 1; i < half.length; i++) arc.push(arc[i - 1]! + Math.hypot(half[i]![0] - half[i - 1]![0], half[i]![1] - half[i - 1]![1]));
    const row: number[] = [];
    for (let i = q; i <= 2 * q; i++) row.push(b.vertex(ox + half[i]![0], half[i]![1], z, z, arc[i]!));
    for (let i = 2 * q - 1; i >= q; i--) row.push(b.vertex(ox - half[i]![0], half[i]![1], z, z, -arc[i]!));
    lower.push(row);
  }
  b.grid(lowerBase, rings, lowerCols, false);
  // End caps.
  const caps: [number, boolean][] = [];
  if (opts.capStart ?? true) caps.push([0, false]);
  if (opts.capEnd ?? true) caps.push([rings - 1, true]);
  for (const [r, flip] of caps) {
    const s = sections[r]!;
    const z = z0 + ((z1 - z0) * r) / (rings - 1);
    const cy = (s[0]![1] + s[s.length - 1]![1]) / 2;
    const loop = [...upper[r]!, ...lower[r]!.slice(1)];
    // Duplicate the cap rim so the cap gets its own flat normal.
    const rim = loop.map((v) => b.vertex(b.pos[v * 3]!, b.pos[v * 3 + 1]!, z, z, 0));
    b.fan(ox, cy, z, rim, flip);
  }
  return b.geometry();
}

export interface Surface {
  /** Root leading edge position (m) and chord (m). */
  rootX: number;
  rootY: number;
  rootLeZ: number;
  rootChordM: number;
  /** Distance along the span direction from root to tip (m), tip leading edge and chord. */
  spanM: number;
  tipLeZ: number;
  tipChordM: number;
  /** Thickness / chord at root and tip. */
  rootThickness: number;
  tipThickness: number;
  /** Span direction from +x towards +y (rad): 0 = flat wing, π/2 = vertical fin. */
  dihedralRad: number;
  /** +1 right side, −1 mirrored to the left. */
  side?: 1 | -1;
}

export interface Panel {
  /** Chord fractions and span fractions of the sub-rectangle to build. */
  c0?: number;
  c1?: number;
  s0?: number;
  s1?: number;
  /** Gap left at chord cuts (m), so a hinged surface shows its slot. */
  gapM?: number;
}

/** NACA 4-digit symmetric half-thickness for thickness 1 (closed trailing edge). */
function naca(x: number): number {
  return 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

/** Point on the surface's mid-plane at chord fraction c, span fraction s. */
export function surfacePoint(sf: Surface, c: number, s: number): [number, number, number] {
  const side = sf.side ?? 1;
  const chord = sf.rootChordM + (sf.tipChordM - sf.rootChordM) * s;
  const le = sf.rootLeZ + (sf.tipLeZ - sf.rootLeZ) * s;
  return [(sf.rootX + Math.cos(sf.dihedralRad) * sf.spanM * s) * side, sf.rootY + Math.sin(sf.dihedralRad) * sf.spanM * s, le + c * chord];
}

/** A lifting surface, or the chord × span sub-rectangle `panel` of it, closed on every side. */
export function surface(sf: Surface, panel: Panel = {}, chordPoints = 22, spanPoints = 10): BufferGeometry {
  const side = sf.side ?? 1;
  const c0 = panel.c0 ?? 0;
  const c1 = panel.c1 ?? 1;
  const s0 = panel.s0 ?? 0;
  const s1 = panel.s1 ?? 1;
  const gap = panel.gapM ?? 0;
  const tx = -Math.sin(sf.dihedralRad) * side;
  const ty = Math.cos(sf.dihedralRad);
  const b = new Builder();
  const ringOf = (s: number): { pts: [number, number, number][]; uv: [number, number][] } => {
    const chord = sf.rootChordM + (sf.tipChordM - sf.rootChordM) * s;
    const thick = (sf.rootThickness + (sf.tipThickness - sf.rootThickness) * s) * chord;
    const g = gap / chord;
    const a = c0 > 0 ? c0 + g : c0;
    const e = c1 < 1 ? c1 - g : c1;
    const pts: [number, number, number][] = [];
    const uv: [number, number][] = [];
    const spanPos = sf.spanM * s;
    // Upper a → e, then lower e → a; cosine spacing clusters points at the leading edge.
    for (let k = 0; k < chordPoints * 2; k++) {
      const upper = k < chordPoints;
      const t = upper ? k / (chordPoints - 1) : 1 - (k - chordPoints) / (chordPoints - 1);
      const xc = a + (e - a) * (a === 0 ? (1 - Math.cos(t * Math.PI * 0.5)) : t);
      const half = naca(Math.min(Math.max(xc, 0), 1)) * thick * (upper ? 1 : -1);
      const [mx, my, mz] = surfacePoint(sf, xc, s);
      pts.push([mx + tx * half, my + ty * half, mz]);
      uv.push([xc * chord, (upper ? 1 : -1) * spanPos]);
    }
    return { pts, uv };
  };
  const rows: number[][] = [];
  const cols = chordPoints * 2;
  const base = b.pos.length / 3;
  for (let j = 0; j <= spanPoints; j++) {
    const s = s0 + ((s1 - s0) * j) / spanPoints;
    const ring = ringOf(s);
    rows.push(ring.pts.map((p, k) => b.vertex(p[0], p[1], p[2], ring.uv[k]![0], ring.uv[k]![1])));
  }
  b.grid(base, spanPoints + 1, cols, side > 0, true);
  // Caps at both span ends (fresh vertices: flat normals).
  for (const [j, flip] of [
    [0, side > 0],
    [spanPoints, side < 0],
  ] as const) {
    const ring = rows[j]!.map((v) => b.vertex(b.pos[v * 3]!, b.pos[v * 3 + 1]!, b.pos[v * 3 + 2]!, b.surf[v * 2]!, b.surf[v * 2 + 1]!));
    for (let k = 1; k < chordPoints - 1; k++) {
      const top = ring[k]!;
      const next = ring[k + 1]!;
      const bot = ring[cols - 1 - k]!;
      const botNext = ring[cols - 2 - k]!;
      if (flip) b.idx.push(top, botNext, next, top, bot, botNext);
      else b.idx.push(top, next, botNext, top, botNext, bot);
    }
  }
  // Chord-cut faces (where the section is open: upper and lower ends differ).
  const cuts: [number, number, boolean][] = [];
  if (c0 > 0) cuts.push([0, cols - 1, side < 0]);
  if (c1 < 1) cuts.push([chordPoints - 1, chordPoints, side > 0]);
  for (const [k0, k1, flip] of cuts) {
    const cutA = rows.map((r) => r[k0]!);
    const cutB = rows.map((r) => r[k1]!);
    const a = cutA.map((v) => b.vertex(b.pos[v * 3]!, b.pos[v * 3 + 1]!, b.pos[v * 3 + 2]!, 0, 0));
    const c = cutB.map((v) => b.vertex(b.pos[v * 3]!, b.pos[v * 3 + 1]!, b.pos[v * 3 + 2]!, 0, 0));
    for (let j = 0; j < spanPoints; j++) {
      if (flip) b.idx.push(a[j]!, c[j]!, a[j + 1]!, c[j]!, c[j + 1]!, a[j + 1]!);
      else b.idx.push(a[j]!, a[j + 1]!, c[j]!, c[j]!, a[j + 1]!, c[j + 1]!);
    }
  }
  return b.geometry();
}

/**
 * A body of revolution along z: `profile` is [z, radius] pairs centred at (x, y). `modulate(angle, f)`
 * scales the radius per angle (f = 0…1 along the profile) for petals; `shiftZ(angle, f)` moves a ring
 * along the axis per angle, for a serrated (saw-tooth) exit edge. Ends are open unless `capEnd`.
 */
export function lathe(profile: readonly (readonly [number, number])[], x: number, y: number, around = 24, capEnd = false, modulate?: (angleRad: number, f: number) => number, shiftZ?: (angleRad: number, f: number) => number): BufferGeometry {
  const b = new Builder();
  const base = b.pos.length / 3;
  let along = 0;
  for (let p = 0; p < profile.length; p++) {
    const [z, r] = profile[p]!;
    if (p > 0) along += Math.hypot(z - profile[p - 1]![0], r - profile[p - 1]![1]);
    const f = p / (profile.length - 1);
    for (let i = 0; i < around; i++) {
      const t = (i / around) * Math.PI * 2;
      const rr = r * (modulate ? modulate(t, f) : 1);
      b.vertex(x + Math.cos(t) * rr, y + Math.sin(t) * rr, z + (shiftZ ? shiftZ(t, f) : 0), along, t * r);
    }
  }
  b.grid(base, profile.length, around, true, true);
  if (capEnd) {
    const last = profile.length - 1;
    const ring: number[] = [];
    for (let i = 0; i <= around; i++) ring.push(base + last * around + (i % around));
    b.fan(x, y, profile[last]![0], ring, false);
  }
  return b.geometry();
}

/** A closed tube of radius `r` through the points (canopy frames, probes), with flat caps. */
export function tube(path: readonly [number, number, number][], r: number, around = 8, closed = false): BufferGeometry {
  const b = new Builder();
  const n = path.length;
  const base = b.pos.length / 3;
  let along = 0;
  for (let i = 0; i < n; i++) {
    const p = path[i]!;
    const prev = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const next = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    let dz = next[2] - prev[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    // A frame around the tangent: any vector not parallel to it.
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (Math.abs(dy) > 0.9) {
      ux = 1;
      uy = 0;
    }
    // n1 = normalize(u × d), n2 = d × n1
    let n1x = uy * dz - uz * dy;
    let n1y = uz * dx - ux * dz;
    let n1z = ux * dy - uy * dx;
    const l1 = Math.hypot(n1x, n1y, n1z) || 1;
    n1x /= l1;
    n1y /= l1;
    n1z /= l1;
    const n2x = dy * n1z - dz * n1y;
    const n2y = dz * n1x - dx * n1z;
    const n2z = dx * n1y - dy * n1x;
    if (i > 0) along += Math.hypot(p[0] - path[i - 1]![0], p[1] - path[i - 1]![1], p[2] - path[i - 1]![2]);
    for (let k = 0; k < around; k++) {
      const t = (k / around) * Math.PI * 2;
      const c = Math.cos(t) * r;
      const s = Math.sin(t) * r;
      b.vertex(p[0] + n1x * c + n2x * s, p[1] + n1y * c + n2y * s, p[2] + n1z * c + n2z * s, along, t * r);
    }
  }
  if (closed) {
    b.grid(base, n, around, true, true);
    for (let k = 0; k < around; k++) {
      const a = base + (n - 1) * around + k;
      const bb = base + (n - 1) * around + ((k + 1) % around);
      const c = base + k;
      const d = base + ((k + 1) % around);
      b.idx.push(a, bb, c, bb, d, c);
    }
  } else b.grid(base, n, around, true, true);
  return b.geometry();
}

/** An axis-aligned box from min to max corners, with `surf` in metres (pylons, rails, doors). */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BufferGeometry {
  const b = new Builder();
  const faces: [number[], number[], number[], number[]][] = [
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
  ];
  for (const f of faces) {
    const v = f.map((p) => b.vertex(p[0]!, p[1]!, p[2]!, p[2]!, p[0]! + p[1]!));
    b.idx.push(v[0]!, v[1]!, v[2]!, v[0]!, v[2]!, v[3]!);
  }
  return b.geometry();
}
