import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, LatheGeometry, Vector2, Vector3 } from 'three/webgpu';
import { merge } from './meshkit.ts';

// Parked cars, invented and unbadged, modelled to read as real ones from a
// few metres: a hatchback (4.2 m) and a saloon (4.4 m), both 1.8 m wide on a
// 2.6 m wheelbase with 205/55 R16 tyres (r 0.316 m).
//
// The body is lofted: rounded cross-sections every few centimetres along the
// car, from the bumper nose to the tail, with the sill lifted into a wheel
// arch over each axle (a full-width tunnel; a narrow floor fills it between
// the wheels, so the arch shows from the side and nothing shows through).
// The greenhouse is a second loft, a trapezoid that narrows to the roof
// (tumblehome) and rises along the windscreen rake. Every quad of both lofts
// is sorted into a part by where it sits — body paint, glass, black trim
// (window seals, B-pillar, door shut lines, sills) — so the shut lines and
// window edges are real edges in the mesh, not texture. Rings are placed
// exactly on every such boundary, so the edges are crisp at any distance.
//
// Front is −Z (the game's forward). Everything rests on y = 0.

export type CarVariant = 'hatch' | 'saloon';
export type CarPart = 'paint' | 'glass' | 'trim' | 'headlamp' | 'taillamp' | 'plate' | 'tyre' | 'rim';
export type CarGeometry = Partial<Record<CarPart, BufferGeometry>>;

interface Key {
  z: number;
  /** Half width at the sill and at the shoulder (tumblehome). */
  hwBottom: number;
  hwTop: number;
  yBottom: number;
  yTop: number;
  /** Corner radius of the section. */
  r: number;
}

interface Spec {
  lengthM: number;
  body: Key[];
  /** Greenhouse: windscreen base, roof start, roof end, rear-glass end (z); roof height. */
  glassFrontZ: number;
  roofFrontZ: number;
  roofRearZ: number;
  glassRearZ: number;
  roofY: number;
  /** Side windows: front edge, B-pillar centre, rear edge (z). */
  winFrontZ: number;
  bPillarZ: number;
  winRearZ: number;
  /** Door shut lines (z). */
  shutZ: number[];
}

const WHEEL_R = 0.316;
const WHEEL_W = 0.205;
const TRACK_HALF = 0.76;
const AXLE_Z = [-1.3, 1.3];
const ARCH_R = 0.375;
const ARCH_Y = 0.33;
const BELT_Y = 0.97;

const SPECS: Record<CarVariant, Spec> = {
  hatch: {
    lengthM: 4.2,
    body: [
      { z: -2.1, hwBottom: 0.5, hwTop: 0.46, yBottom: 0.33, yTop: 0.55, r: 0.08 },
      { z: -2.085, hwBottom: 0.68, hwTop: 0.64, yBottom: 0.28, yTop: 0.62, r: 0.11 },
      { z: -2.04, hwBottom: 0.79, hwTop: 0.76, yBottom: 0.24, yTop: 0.68, r: 0.13 },
      { z: -1.92, hwBottom: 0.86, hwTop: 0.83, yBottom: 0.21, yTop: 0.74, r: 0.14 },
      { z: -1.6, hwBottom: 0.88, hwTop: 0.86, yBottom: 0.2, yTop: 0.8, r: 0.14 },
      { z: -0.62, hwBottom: 0.89, hwTop: 0.87, yBottom: 0.19, yTop: BELT_Y - 0.02, r: 0.12 },
      { z: 1.55, hwBottom: 0.89, hwTop: 0.87, yBottom: 0.19, yTop: BELT_Y + 0.03, r: 0.12 },
      { z: 1.85, hwBottom: 0.88, hwTop: 0.85, yBottom: 0.21, yTop: BELT_Y + 0.03, r: 0.13 },
      { z: 2.0, hwBottom: 0.84, hwTop: 0.8, yBottom: 0.25, yTop: BELT_Y + 0.02, r: 0.14 },
      { z: 2.08, hwBottom: 0.74, hwTop: 0.7, yBottom: 0.3, yTop: BELT_Y - 0.01, r: 0.13 },
      { z: 2.1, hwBottom: 0.56, hwTop: 0.52, yBottom: 0.36, yTop: 0.92, r: 0.09 },
    ],
    glassFrontZ: -0.62,
    roofFrontZ: 0.2,
    roofRearZ: 1.58,
    glassRearZ: 1.98,
    roofY: 1.46,
    winFrontZ: -0.5,
    bPillarZ: 0.6,
    winRearZ: 1.6,
    shutZ: [-0.56, 0.6, 1.62],
  },
  saloon: {
    lengthM: 4.4,
    body: [
      { z: -2.2, hwBottom: 0.5, hwTop: 0.46, yBottom: 0.33, yTop: 0.55, r: 0.08 },
      { z: -2.185, hwBottom: 0.68, hwTop: 0.64, yBottom: 0.28, yTop: 0.62, r: 0.11 },
      { z: -2.14, hwBottom: 0.79, hwTop: 0.76, yBottom: 0.24, yTop: 0.67, r: 0.13 },
      { z: -2.0, hwBottom: 0.86, hwTop: 0.83, yBottom: 0.21, yTop: 0.73, r: 0.14 },
      { z: -1.6, hwBottom: 0.88, hwTop: 0.86, yBottom: 0.2, yTop: 0.8, r: 0.14 },
      { z: -0.7, hwBottom: 0.89, hwTop: 0.87, yBottom: 0.19, yTop: BELT_Y - 0.03, r: 0.12 },
      { z: 1.3, hwBottom: 0.89, hwTop: 0.87, yBottom: 0.19, yTop: BELT_Y + 0.02, r: 0.12 },
      { z: 1.95, hwBottom: 0.88, hwTop: 0.85, yBottom: 0.21, yTop: BELT_Y + 0.05, r: 0.13 },
      { z: 2.1, hwBottom: 0.84, hwTop: 0.8, yBottom: 0.25, yTop: BELT_Y + 0.04, r: 0.14 },
      { z: 2.18, hwBottom: 0.74, hwTop: 0.7, yBottom: 0.3, yTop: BELT_Y + 0.01, r: 0.13 },
      { z: 2.2, hwBottom: 0.56, hwTop: 0.52, yBottom: 0.36, yTop: 0.93, r: 0.09 },
    ],
    glassFrontZ: -0.7,
    roofFrontZ: 0.1,
    roofRearZ: 0.95,
    glassRearZ: 1.45,
    roofY: 1.43,
    winFrontZ: -0.58,
    bPillarZ: 0.5,
    winRearZ: 1.3,
    shutZ: [-0.64, 0.5, 1.33],
  },
};

/**
 * Every part of one car, in its own frame (front −Z, ground y = 0). `coarse`: the distant version
 * (~1/5 of the triangles: fewer rings and section points, no small parts), same parts and materials.
 */
export function buildCar(variant: CarVariant, coarse = false): CarGeometry {
  const spec = SPECS[variant];
  const out = new Map<CarPart, BufferGeometry[]>();
  const add = (part: CarPart, g: BufferGeometry): void => {
    const list = out.get(part) ?? [];
    list.push(g);
    out.set(part, list);
  };
  for (const [part, g] of lowerBody(spec, coarse)) add(part, g);
  for (const [part, g] of greenhouse(spec, coarse)) add(part, g);
  details(spec, add, coarse);
  for (const z of AXLE_Z) for (const side of [-1, 1]) wheel(side * TRACK_HALF, z, add, coarse);
  const result: CarGeometry = {};
  for (const [part, list] of out) result[part] = merge(list, `car-${variant}-${part}`);
  return result;
}

// ------------------------------------------------------------------ body

function sectionAt(keys: readonly Key[], z: number): Key {
  if (z <= (keys[0] as Key).z) return { ...(keys[0] as Key), z };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] as Key;
    const b = keys[i] as Key;
    if (z <= b.z) {
      const t0 = (z - a.z) / (b.z - a.z);
      const t = t0 * t0 * (3 - 2 * t0); // eased, so the body has no creases at the key stations
      const lerp = (p: number, q: number): number => p + (q - p) * t;
      return { z, hwBottom: lerp(a.hwBottom, b.hwBottom), hwTop: lerp(a.hwTop, b.hwTop), yBottom: lerp(a.yBottom, b.yBottom), yTop: lerp(a.yTop, b.yTop), r: lerp(a.r, b.r) };
    }
  }
  return { ...(keys[keys.length - 1] as Key), z };
}

/** The sill lifted into the wheel arches. */
function sillY(z: number, base: number): number {
  let y = base;
  for (const az of AXLE_Z) {
    const dz = z - az;
    if (Math.abs(dz) < ARCH_R) y = Math.max(y, ARCH_Y + Math.sqrt(ARCH_R * ARCH_R - dz * dz));
  }
  return y;
}

/**
 * Closed ring of a rounded section, counter-clockwise seen from +Z, starting at the bottom centre:
 * bottom edge, lower corner, side (leaning in by the tumblehome), upper corner, top, then the mirror.
 */
function ring(hwBottom: number, hwTop: number, yBottom: number, yTop: number, rBottom: number, rTop: number, coarse = false): Vector2[] {
  const half: Vector2[] = [];
  const arc = coarse ? 1 : 3;
  const flat = coarse ? 1 : 2;
  const rb = Math.min(rBottom, (yTop - yBottom) * 0.45);
  const rt = Math.min(rTop, (yTop - yBottom) * 0.45);
  for (let i = 0; i <= flat; i++) half.push(new Vector2(((hwBottom - rb) * i) / flat, yBottom));
  for (let i = 1; i <= arc; i++) {
    const a = -Math.PI / 2 + (i / arc) * (Math.PI / 2);
    half.push(new Vector2(hwBottom - rb + Math.cos(a) * rb, yBottom + rb + Math.sin(a) * rb));
  }
  for (let i = 1; i <= (coarse ? 1 : 3); i++) {
    const t = i / (coarse ? 2 : 4);
    half.push(new Vector2(hwBottom + (hwTop - hwBottom) * t, yBottom + rb + (yTop - rt - yBottom - rb) * t));
  }
  for (let i = 0; i <= arc; i++) {
    const a = (i / arc) * (Math.PI / 2);
    half.push(new Vector2(hwTop - rt + Math.cos(a) * rt, yTop - rt + Math.sin(a) * rt));
  }
  for (let i = 1; i <= flat; i++) half.push(new Vector2((hwTop - rt) * (1 - i / flat), yTop));
  // half runs bottom centre → top centre on the right (+X). The left side mirrors it back down.
  const full = [...half];
  for (let i = half.length - 2; i >= 1; i--) {
    const p = half[i] as Vector2;
    full.push(new Vector2(-p.x, p.y));
  }
  return full;
}

/** Ring stations along the car: a regular step plus every boundary, so part edges fall on rings. */
function stations(z0: number, z1: number, stepM: number, extra: readonly number[]): number[] {
  const zs = new Set<number>();
  for (let z = z0; z < z1; z += stepM) zs.add(Math.round(z * 1000) / 1000);
  zs.add(z1);
  for (const e of extra) if (e > z0 && e < z1) zs.add(Math.round(e * 1000) / 1000);
  return [...zs].sort((a, b) => a - b);
}

type Classify = (centre: Vector3, normal: Vector3) => CarPart;

/**
 * Loft rings into a skin with smooth normals, then hand each quad to `classify` (by its centre and normal):
 * one geometry per part, seams falling on ring and ring-point edges. Ends closed by fans.
 */
function loft(rings: Vector3[][], classify: Classify, capPart: CarPart): Map<CarPart, BufferGeometry> {
  const n = (rings[0] as Vector3[]).length;
  const m = rings.length;
  const normals = rings.map((r) => r.map(() => new Vector3()));
  const quadN = (i: number, j: number): Vector3 => {
    const a = (rings[i] as Vector3[])[j] as Vector3;
    const b = (rings[i + 1] as Vector3[])[j] as Vector3;
    const c = (rings[i + 1] as Vector3[])[(j + 1) % n] as Vector3;
    const d = (rings[i] as Vector3[])[(j + 1) % n] as Vector3;
    // Winding (a, c, b) + (a, d, c) faces out for counter-clockwise rings marching +Z.
    return new Vector3().subVectors(c, a).cross(new Vector3().subVectors(b, d));
  };
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < n; j++) {
      const fn = quadN(i, j);
      for (const [ii, jj] of [
        [i, j],
        [i + 1, j],
        [i + 1, (j + 1) % n],
        [i, (j + 1) % n],
      ] as const)
        ((normals[ii] as Vector3[])[jj] as Vector3).add(fn);
    }
  }
  for (const r of normals) for (const v of r) v.normalize();
  const buckets = new Map<CarPart, { pos: number[]; nor: number[]; uv: number[] }>();
  const bucket = (p: CarPart): { pos: number[]; nor: number[]; uv: number[] } => {
    let b = buckets.get(p);
    if (!b) {
      b = { pos: [], nor: [], uv: [] };
      buckets.set(p, b);
    }
    return b;
  };
  const centre = new Vector3();
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < n; j++) {
      const ids: [number, number][] = [
        [i, j],
        [i + 1, j],
        [i + 1, (j + 1) % n],
        [i, (j + 1) % n],
      ];
      centre.set(0, 0, 0);
      for (const [ii, jj] of ids) centre.add((rings[ii] as Vector3[])[jj] as Vector3);
      centre.multiplyScalar(0.25);
      const fn = quadN(i, j).normalize();
      const b = bucket(classify(centre, fn));
      for (const k of [0, 2, 1, 0, 3, 2]) {
        const [ii, jj] = ids[k] as [number, number];
        const p = (rings[ii] as Vector3[])[jj] as Vector3;
        const nv = (normals[ii] as Vector3[])[jj] as Vector3;
        b.pos.push(p.x, p.y, p.z);
        b.nor.push(nv.x, nv.y, nv.z);
        b.uv.push(p.z, p.y + Math.abs(p.x));
      }
    }
  }
  // End caps: fans, facing −Z at the front and +Z at the rear.
  for (const [ri, sign] of [
    [0, -1],
    [m - 1, 1],
  ] as const) {
    const r = rings[ri] as Vector3[];
    const c = r.reduce((acc, p) => acc.add(p), new Vector3()).multiplyScalar(1 / n);
    const b = bucket(capPart);
    for (let j = 0; j < n; j++) {
      const p = r[j] as Vector3;
      const q = r[(j + 1) % n] as Vector3;
      const tri = sign < 0 ? [c, q, p] : [c, p, q];
      for (const v of tri) {
        b.pos.push(v.x, v.y, v.z);
        b.nor.push(0, 0, sign);
        b.uv.push(v.x, v.y);
      }
    }
  }
  const result = new Map<CarPart, BufferGeometry>();
  for (const [part, b] of buckets) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(b.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(b.uv), 2));
    result.set(part, g);
  }
  return result;
}

const SHUT_HALF_M = 0.006;

function lowerBody(spec: Spec, coarse: boolean): Map<CarPart, BufferGeometry> {
  const keys = spec.body;
  const z0 = (keys[0] as Key).z;
  const z1 = (keys[keys.length - 1] as Key).z;
  const extra: number[] = [];
  if (!coarse) for (const s of spec.shutZ) extra.push(s - SHUT_HALF_M, s + SHUT_HALF_M);
  const archSteps = coarse ? 2 : 4;
  for (const az of AXLE_Z) for (let k = -archSteps; k <= archSteps; k++) extra.push(az + (k / archSteps) * ARCH_R * 0.999);
  // The ends turn through 90° in a few centimetres: rings close together there.
  for (const d of coarse ? [0.015, 0.06, 0.2] : [0.006, 0.015, 0.03, 0.05, 0.08, 0.12, 0.18, 0.26]) extra.push(z0 + d, z1 - d);
  const rings = stations(z0, z1, coarse ? 0.45 : 0.14, extra).map((z) => {
    const k = sectionAt(keys, z);
    const yb = sillY(z, k.yBottom);
    return ring(k.hwBottom, k.hwTop, yb, k.yTop, k.r * 0.6, k.r, coarse).map((p) => new Vector3(p.x, p.y, z));
  });
  const shutTop = BELT_Y - 0.01;
  return loft(
    rings,
    (c, n) => {
      const side = Math.abs(n.x) > 0.6;
      // Shut lines of the doors, between sill and waist.
      if (side && c.y > 0.3 && c.y < shutTop && spec.shutZ.some((s) => Math.abs(c.z - s) < SHUT_HALF_M)) return 'trim';
      // Sills and the lower bumper lip are black plastic.
      if (c.y < 0.25 && n.y > -0.7) return 'trim';
      // Arch liners: the underside of the lifted sill.
      if (n.y < -0.5 && c.y > 0.3) return 'trim';
      return 'paint';
    },
    'paint',
  );
}

function roofAt(spec: Spec, z: number): number {
  const ease = (t: number): number => t * t * (3 - 2 * t);
  if (z <= spec.glassFrontZ) return BELT_Y;
  if (z < spec.roofFrontZ) {
    const t = (z - spec.glassFrontZ) / (spec.roofFrontZ - spec.glassFrontZ);
    // The windscreen is nearly flat, curving into the roof only near its top.
    return BELT_Y + (spec.roofY - BELT_Y) * (t < 0.8 ? t * 0.95 : 0.76 + ease((t - 0.8) / 0.2) * 0.24);
  }
  if (z <= spec.roofRearZ) return spec.roofY - 0.025 * ((z - spec.roofFrontZ) / (spec.roofRearZ - spec.roofFrontZ));
  const t = Math.min(1, (z - spec.roofRearZ) / (spec.glassRearZ - spec.roofRearZ));
  return spec.roofY - 0.025 - (spec.roofY - 0.025 - BELT_Y - 0.04) * ease(t);
}

function greenhouse(spec: Spec, coarse: boolean): Map<CarPart, BufferGeometry> {
  const extra = [spec.winFrontZ, spec.winRearZ, spec.bPillarZ - 0.04, spec.bPillarZ + 0.04, spec.roofFrontZ, spec.roofRearZ, spec.roofFrontZ - 0.03, spec.roofRearZ + 0.03];
  const rings = stations(spec.glassFrontZ, spec.glassRearZ, coarse ? 0.3 : 0.12, extra).map((z) => {
    const top = Math.max(roofAt(spec, z), BELT_Y + 0.005);
    const yb = BELT_Y - 0.06;
    return ring(0.855, 0.68, yb, top, 0, 0.07, coarse).map((p) => new Vector3(p.x, p.y, z));
  });
  return loft(
    rings,
    (c, n) => {
      const roof = roofAt(spec, c.z);
      if (Math.abs(n.x) > 0.55) {
        // Side glass between the window line and the roof rail, with black seals round it.
        const inWin = c.z > spec.winFrontZ && c.z < spec.winRearZ && c.y > BELT_Y + 0.015 && c.y < roof - 0.05;
        if (!inWin) return c.y < BELT_Y + 0.015 ? 'trim' : 'paint';
        if (Math.abs(c.z - spec.bPillarZ) < 0.04) return 'trim';
        return 'glass';
      }
      if (n.y < -0.3) return 'trim'; // hidden underside
      // Top: the roof panel is paint; windscreen and rear glass with painted pillars at their edges.
      if (c.z > spec.roofFrontZ - 0.03 && c.z < spec.roofRearZ + 0.03) return 'paint';
      return Math.abs(c.x) > 0.6 ? 'paint' : 'glass';
    },
    'trim',
  );
}

// ------------------------------------------------------------------ details

function boxAt(sx: number, sy: number, sz: number, x: number, y: number, z: number, rotX = 0, rotY = 0): BufferGeometry {
  return new BoxGeometry(sx, sy, sz).rotateX(rotX).rotateY(rotY).translate(x, y, z);
}

function details(spec: Spec, add: (part: CarPart, g: BufferGeometry) => void, coarse: boolean): void {
  const rear = (spec.body[spec.body.length - 1] as Key).z;
  // Lamps, grille, intakes and plates are patches laid on the skin of the nose and tail, so they wrap
  // round its curves flush instead of standing off it as boxes.
  const patch = (part: CarPart, end: -1 | 1, x0: number, x1: number, y0: number, y1: number, liftM: number, inset = 0): void => {
    add(part, skinPatch(spec, end, x0, x1, y0, y1, liftM, inset, coarse));
  };
  for (const s of [-1, 1]) {
    const xs = (a: number, b: number): [number, number] => (s > 0 ? [a, b] : [-b, -a]);
    // Headlamps: wide, narrowing towards the grille, swept round the corner.
    patch('headlamp', -1, ...xs(0.4, 0.8), 0.6, 0.7, 0.004, s * 0.05);
    // Fog lamps in the bumper.
    if (!coarse) patch('trim', -1, ...xs(0.55, 0.72), 0.36, 0.42, 0.003);
    // Tail lamps, wrapping round the rear corners.
    patch('taillamp', 1, ...xs(0.42, 0.84), 0.74, 0.92, 0.004, -s * 0.05);
    // Mirrors: a housing on a short stalk at the front of the door glass.
    add('paint', boxAt(0.19, 0.11, 0.08, s * 1.0, BELT_Y + 0.06, spec.winFrontZ + 0.07, 0, s * 0.15));
    add('trim', boxAt(0.13, 0.04, 0.05, s * 0.9, BELT_Y + 0.02, spec.winFrontZ + 0.08));
    add('glass', boxAt(0.15, 0.08, 0.01, s * 1.0, BELT_Y + 0.06, spec.winFrontZ + 0.115, 0, s * 0.15));
    if (coarse) continue;
    // Door handles.
    add('trim', boxAt(0.02, 0.025, 0.13, s * 0.895, 0.88, (spec.shutZ[0] as number) + 0.62));
    add('trim', boxAt(0.02, 0.025, 0.13, s * 0.895, 0.88, spec.bPillarZ + 0.55));
  }
  patch('trim', -1, -0.36, 0.36, 0.5, 0.6, 0.003); // grille
  patch('trim', -1, -0.5, 0.5, 0.29, 0.34, 0.003); // lower intake
  patch('plate', -1, -0.26, 0.26, 0.38, 0.49, 0.008);
  patch('plate', 1, -0.26, 0.26, 0.58, 0.69, 0.008);
  patch('trim', 1, -0.62, 0.62, 0.36, 0.44, 0.003); // rear diffuser
  // Floor between the wheels, filling the arch tunnels from below the sill.
  add('trim', boxAt(1.2, 0.2, spec.lengthM - 0.5, 0, 0.3, 0));
  if (coarse) return;
  // Wipers resting on the cowl.
  add('trim', boxAt(0.55, 0.012, 0.02, -0.25, BELT_Y + 0.02, spec.glassFrontZ + 0.08, 0, 0.12));
  add('trim', boxAt(0.55, 0.012, 0.02, 0.3, BELT_Y + 0.02, spec.glassFrontZ + 0.08, 0, 0.12));
  // Exhaust.
  add('trim', new CylinderGeometry(0.03, 0.03, 0.2, 10).rotateX(Math.PI / 2).translate(0.5, 0.22, rear - 0.12));
}

function insidePolygon(poly: readonly Vector2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vector2;
    const b = poly[j] as Vector2;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** z of the body skin at (x, y), seen from the front (end −1) or the rear (end +1). */
function skinZ(spec: Spec, end: -1 | 1, x: number, y: number): number {
  const keys = spec.body;
  const zEnd = end < 0 ? (keys[0] as Key).z : (keys[keys.length - 1] as Key).z;
  const contains = (z: number): boolean => {
    const k = sectionAt(keys, z);
    return insidePolygon(ring(k.hwBottom, k.hwTop, sillY(z, k.yBottom), k.yTop, k.r * 0.6, k.r), x, y);
  };
  // March in from the end until the section holds the point, then bisect the crossing.
  let outside = zEnd;
  let inside = zEnd;
  for (let k = 1; k <= 200; k++) {
    const z = zEnd - end * k * 0.004;
    if (contains(z)) {
      inside = z;
      break;
    }
    outside = z;
  }
  for (let k = 0; k < 12; k++) {
    const mid = (outside + inside) / 2;
    if (contains(mid)) inside = mid;
    else outside = mid;
  }
  return (outside + inside) / 2;
}

/**
 * A grid laid on the skin over [x0, x1] × [y0, y1], lifted `liftM` off it; `inset` (m) narrows the
 * bottom edge towards the centre line, so a lamp can taper. Faces out of the end it sits on.
 */
function skinPatch(spec: Spec, end: -1 | 1, x0: number, x1: number, y0: number, y1: number, liftM: number, inset: number, coarse: boolean): BufferGeometry {
  const nx = coarse ? 3 : 8;
  const ny = coarse ? 1 : 3;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const y = y0 + (y1 - y0) * v;
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      // Inset the bottom edge's inner end: lamps narrow towards the centre line.
      const xa = x0 + (inset > 0 ? inset * (1 - v) : 0);
      const xb = x1 + (inset < 0 ? inset * (1 - v) : 0);
      const x = xa + (xb - xa) * u;
      pos.push(x, y, skinZ(spec, end, x, y) + end * liftM);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      // Counter-clockwise seen from outside: from the front (−Z) x runs right-to-left.
      if (end < 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Tyre (rounded sidewall and tread) and a five-spoke rim with its hub, axis along X. */
function wheel(x: number, z: number, add: (part: CarPart, g: BufferGeometry) => void, coarse: boolean): void {
  const hw = WHEEL_W / 2;
  const rimR = 0.205;
  const tyreProfile: Vector2[] = [];
  // Lathe profile (radius, axial): inner bead → sidewall bulge → shoulder → tread → mirror.
  const pts: [number, number][] = [
    [rimR, -hw * 0.85],
    [rimR + 0.03, -hw],
    [WHEEL_R - 0.03, -hw * 0.98],
    [WHEEL_R - 0.008, -hw * 0.85],
    [WHEEL_R, -hw * 0.6],
    [WHEEL_R, hw * 0.6],
    [WHEEL_R - 0.008, hw * 0.85],
    [WHEEL_R - 0.03, hw * 0.98],
    [rimR + 0.03, hw],
    [rimR, hw * 0.85],
  ];
  for (const [r, a] of coarse ? pts.filter((_, k) => k % 3 !== 1) : pts) tyreProfile.push(new Vector2(r, a));
  const outer = Math.sign(x);
  const place = (g: BufferGeometry): BufferGeometry => g.rotateZ(-Math.PI / 2).translate(x, WHEEL_R, z);
  add('tyre', place(new LatheGeometry(tyreProfile, coarse ? 10 : 18)));
  // Rim face: a shallow dish set into the tyre, a hub and five spokes, on the outer side.
  const dish = new LatheGeometry(
    [new Vector2(0.001, outer * hw * 0.3), new Vector2(0.06, outer * hw * 0.35), new Vector2(rimR - 0.015, outer * hw * 0.5), new Vector2(rimR, outer * hw * 0.8)],
    coarse ? 8 : 14,
  );
  add('rim', place(dish));
  if (coarse) return;
  const spokes: BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    spokes.push(new BoxGeometry(0.035, 0.15, 0.02).translate(0, 0.11, 0).rotateZ(a).rotateY(Math.PI / 2).translate(x + outer * hw * 0.72, WHEEL_R, z));
  }
  spokes.push(new CylinderGeometry(0.05, 0.05, 0.03, 8).rotateZ(Math.PI / 2).translate(x + outer * hw * 0.68, WHEEL_R, z));
  add('rim', merge(spokes, 'spokes'));
}
