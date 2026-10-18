import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, float, fract, mix, step, uv, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DoubleSide, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import { PARAPET_ZONE_M } from '../maps/city.ts';
import type { BoxLook, MapBox } from '../maps/types.ts';

// The architecture a flat façade box lacks, as geometry: a plinth at the foot,
// a string course over the shops, a cornice where the walls end — frieze, bed
// moulding and an overhanging corona that throws a shadow line across the
// wall — then a parapet above the roof with its coping; stone sills under the
// upper windows and a hood over each; canvas awnings over a share of the
// shops. All of it follows the façade's own layout (worldMesh.ts: a whole
// number of bays per face, whole storeys plus the parapet zone), so every sill
// sits under its window.
//
// Relief like this is what the eye reads a building by: the sun picks out
// every projection and the shadow under it. A box with painted windows reads
// as a box however good its texture.

/** Geometry by material: cast stone, rusticated plinth, the walls' own look (parapets), canvas. */
export interface FacadeTrim {
  /** Cornices, string courses, coping: they cast shadows. */
  stone: BufferGeometry | null;
  /** Sills and window hoods: small, so they skip the shadow map. */
  details: BufferGeometry | null;
  plinth: BufferGeometry | null;
  parapets: Map<BoxLook, BufferGeometry>;
  awnings: BufferGeometry | null;
  /** Roof plant: air-conditioning units, vents (painted metal). */
  roofPlant: BufferGeometry | null;
}

/** Tile sizes (m) of the materials the trim uses, for world-scaled UVs. */
export interface TrimTiles {
  stoneM: number;
  plinthM: number;
  wallM: (look: BoxLook) => number;
}

// Local face frames, as worldMesh.ts FACES (sides only): normal, right.
const SIDES: { n: [number, number, number]; r: [number, number, number] }[] = [
  { n: [1, 0, 0], r: [0, 0, -1] },
  { n: [-1, 0, 0], r: [0, 0, 1] },
  { n: [0, 0, 1], r: [1, 0, 0] },
  { n: [0, 0, -1], r: [-1, 0, 0] },
];

/** Where the façade pattern puts the window pane across a tile (patterns.ts `facade`). */
const PANE_U0 = 0.28;
const PANE_U1 = 0.72;

/**
 * A box in a face frame: `along` the face, `up`, `out` from it; `alongC`, `upC`, `outC` its centre.
 * UVs are metres / tileM on every face, like the rest of the world.
 */
function frameBox(f: Frame, alongC: number, upC: number, outC: number, along: number, up: number, out: number, tileM: number, skipBack = true): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const h = [along / 2, up / 2, out / 2];
  // Faces as (axis, sign): along ±, up ±, out ± (the back face, against the wall, is never seen).
  const faces: [number, number][] = [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
  ];
  if (!skipBack) faces.push([2, -1]);
  for (const [axis, sgn] of faces) {
    const a1 = (axis + 1) % 3;
    const a2 = (axis + 2) % 3;
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const local: number[][] = corners.map(([s1, s2]) => {
      const p = [0, 0, 0];
      p[axis] = sgn * (h[axis] as number);
      p[a1] = s1 * (h[a1] as number);
      p[a2] = s2 * (h[a2] as number);
      return p;
    });
    // Wind counter-clockwise seen from outside: swap when (a1 × a2) points against the face.
    const order = sgn > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const k of order) {
      const p = local[k] as number[];
      const w = f.toWorld(alongC + (p[0] as number), upC + (p[1] as number), outC + (p[2] as number));
      pos.push(w.x, w.y, w.z);
      const n = f.dir(axis === 0 ? sgn : 0, axis === 1 ? sgn : 0, axis === 2 ? sgn : 0);
      nor.push(n.x, n.y, n.z);
      // Metres across the face's two axes.
      uvs.push(((p[a1] as number) + (a1 === 0 ? alongC : a1 === 1 ? upC : 0)) / tileM, ((p[a2] as number) + (a2 === 0 ? alongC : a2 === 1 ? upC : 0)) / tileM);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  return g;
}

/** A building face: origin at its left corner on the wall plane, axes right / up / out. */
class Frame {
  readonly origin = new Vector3();
  readonly right = new Vector3();
  readonly normal = new Vector3();
  private readonly tmp = new Vector3();

  toWorld(along: number, up: number, out: number): Vector3 {
    return this.tmp.copy(this.origin).addScaledVector(this.right, along).addScaledVector(this.normal, out).setY(this.origin.y + up).clone();
  }

  dir(along: number, up: number, out: number): Vector3 {
    return new Vector3().addScaledVector(this.right, along).addScaledVector(this.normal, out).setY(up);
  }
}

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Awning cloth colours (linear albedo): the usual striped and plain canvases. */
const CANVAS: [number, number, number][] = [
  [0.32, 0.03, 0.03],
  [0.05, 0.16, 0.08],
  [0.03, 0.06, 0.16],
  [0.38, 0.22, 0.04],
  [0.12, 0.02, 0.05],
  [0.06, 0.06, 0.06],
];

export function facadeTrim(boxes: readonly MapBox[], tiles: TrimTiles, playHalfM: number): FacadeTrim {
  const stone: BufferGeometry[] = [];
  const details: BufferGeometry[] = [];
  const plinth: BufferGeometry[] = [];
  const parapets = new Map<BoxLook, BufferGeometry[]>();
  const awnings: BufferGeometry[] = [];
  const plant: BufferGeometry[] = [];
  const f = new Frame();
  for (const b of boxes) {
    const fac = b.facade;
    if (!fac) continue;
    const yaw = b.yawRad ?? 0;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const rot = (v: [number, number, number]): Vector3 => new Vector3(c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]);
    const base = b.center.y - b.size.y / 2;
    const top = base + b.size.y;
    const storey = fac.storeyM;
    const storeys = Math.max(1, Math.round((b.size.y - PARAPET_ZONE_M) / storey));
    const cornice = base + storeys * storey;
    // Buildings that close the map: only the face toward the play area gets the small detail.
    const edge = Math.max(Math.abs(b.center.x), Math.abs(b.center.z)) > playHalfM;
    const wallTile = tiles.wallM(b.look);
    const style = windowStyle(b, storeys);
    const walls = parapets.get(b.look) ?? [];
    parapets.set(b.look, walls);
    roofClutter(b, top, walls, plant, wallTile);
    SIDES.forEach((side, faceIndex) => {
      f.normal.copy(rot(side.n));
      f.right.copy(rot(side.r));
      const halfAlong = Math.abs(side.r[0]) * b.size.x * 0.5 + Math.abs(side.r[2]) * b.size.z * 0.5;
      const halfOut = Math.abs(side.n[0]) * b.size.x * 0.5 + Math.abs(side.n[2]) * b.size.z * 0.5;
      f.origin.set(b.center.x, base, b.center.z).addScaledVector(f.normal, halfOut).addScaledVector(f.right, -halfAlong);
      const L = halfAlong * 2;
      // Bands wrap the corners: on the ±X faces a band runs past both ends by its projection and so fills the
      // corner; on the ±Z faces it stops against them. Nothing overlaps, so no two faces fight.
      const fills = faceIndex < 2;
      const band = (y0: number, y1: number, out: number, depth: number, list: BufferGeometry[], tileM: number): void => {
        const len = fills ? L + 2 * out : L + 2 * out - 2 * depth;
        list.push(frameBox(f, L / 2, y0 - base + (y1 - y0) / 2, out - depth / 2, len, y1 - y0, depth, tileM));
      };
      band(base, base + 0.32, 0.05, 0.3, plinth, tiles.plinthM);
      band(base + storey - 0.02, base + storey + 0.2, 0.07, 0.3, stone, tiles.stoneM);
      // Cornice: frieze, bed moulding, corona.
      band(cornice, cornice + 0.3, 0.05, 0.35, stone, tiles.stoneM);
      band(cornice + 0.3, cornice + 0.42, 0.17, 0.45, stone, tiles.stoneM);
      band(cornice + 0.42, cornice + 0.56, 0.32, 0.6, stone, tiles.stoneM);
      // Parapet wall above the roof, in the building's own wall, and its coping.
      const parapetTop = top + 0.7;
      band(cornice + 0.56, parapetTop, 0.03, 0.28, walls, wallTile);
      band(parapetTop, parapetTop + 0.08, 0.07, 0.42, stone, tiles.stoneM);

      const facingIn = f.normal.x * -b.center.x + f.normal.z * -b.center.z > 0;
      if (edge && !facingIn) return;
      const bays = Math.max(1, Math.round(L / fac.bayM));
      const bay = L / bays;
      const paneW = (PANE_U1 - PANE_U0) * bay;
      for (let j = 0; j < bays; j++) {
        const u = (j + 0.5) * bay;
        for (let k = 1; k < storeys; k++) {
          const y = k * storey;
          details.push(frameBox(f, u, y + 0.28 * storey, 0.04, paneW + 0.14, 0.07, 0.12, tiles.stoneM));
          if (style.hoods) details.push(frameBox(f, u, y + 0.825 * storey, 0.025, paneW + 0.1, 0.1, 0.07, tiles.stoneM));
          if (style.balconies !== 'none' && hash(fac.seed + 3, faceIndex * 31 + k, j) < style.balconyShare) {
            balcony(f, u, y, paneW + 0.7, style.balconies, stone, plant, tiles.stoneM);
          } else if (hash(fac.seed + 5, faceIndex * 31 + k, j) < style.acShare) {
            // A window air conditioner hung under the sill, off to one side.
            const side = hash(fac.seed + 6, k, j) < 0.5 ? -1 : 1;
            plant.push(frameBox(f, u + side * paneW * 0.22, y + 0.28 * storey - 0.36, 0.17, 0.72, 0.48, 0.34, 1));
          }
        }
        // Awnings over a share of the shops (not on the map's closing wall).
        if (!edge && hash(fac.seed, faceIndex, j) < 0.42) awnings.push(awning(f, u, storey, bay, hash(fac.seed + 7, faceIndex, j)));
      }
    });
  }
  const join = (list: BufferGeometry[]): BufferGeometry | null => (list.length > 0 ? mergeGeometries(list, false) : null);
  const walls = new Map<BoxLook, BufferGeometry>();
  for (const [look, list] of parapets) {
    const g = join(list);
    if (g) walls.set(look, g);
  }
  return { stone: join(stone), details: join(details), plinth: join(plinth), parapets: walls, awnings: join(awnings), roofPlant: join(plant) };
}

interface WindowStyle {
  /** Stone hoods over the upper windows (the older, dressed façades). */
  hoods: boolean;
  /** Balconies: concrete-walled slabs, iron railings, or none. */
  balconies: 'none' | 'solid' | 'iron';
  /** Share of the upper windows with a balcony, and of the rest with an air conditioner hung below. */
  balconyShare: number;
  acShare: number;
}

/**
 * How one building dresses its windows, from its seed, so neighbours differ in relief as well as in paint
 * (materials.ts `buildingVariety`): one street of identical sills and hoods is the tell of a generated city.
 * Older brick and plaster fronts keep their hoods and get iron balconies; concrete blocks go plain, with
 * walled balconies; window air conditioners on the rest, more on the plainer ones.
 */
function windowStyle(b: MapBox, storeys: number): WindowStyle {
  const seed = b.facade?.seed ?? 0;
  const r = hash(seed, 91, 3);
  const old = b.look === 'brick' || b.look === 'brickDark' || b.look === 'plaster' || b.look === 'stone';
  const hoods = old ? r > 0.2 : r > 0.75;
  const hasBalconies = storeys >= 3 && hash(seed, 92, 5) < 0.3;
  const balconies = !hasBalconies ? 'none' : old && hash(seed, 93, 7) < 0.7 ? 'iron' : 'solid';
  // Shares held down for phones: the city has ~8000 windows, and every balcony is a handful of boxes.
  return { hoods, balconies, balconyShare: hasBalconies ? 0.2 + hash(seed, 94, 9) * 0.25 : 0, acShare: hoods ? 0.025 : 0.06 };
}

/**
 * A balcony at storey floor `y` in front of the window at `u`: a slab that throws its shadow down the
 * wall, and either a concrete parapet on three sides or an iron railing (top rail and bars).
 */
function balcony(f: Frame, u: number, y: number, width: number, kind: 'solid' | 'iron', stone: BufferGeometry[], plant: BufferGeometry[], tileM: number): void {
  const depth = 0.95;
  stone.push(frameBox(f, u, y - 0.08, depth / 2, width, 0.16, depth, tileM));
  if (kind === 'solid') {
    stone.push(frameBox(f, u, y + 0.5, depth - 0.05, width, 0.84, 0.1, tileM));
    for (const s of [-1, 1]) stone.push(frameBox(f, u + s * (width / 2 - 0.05), y + 0.5, (depth - 0.1) / 2, 0.1, 0.84, depth - 0.1, tileM));
    return;
  }
  const rail = 0.04;
  plant.push(frameBox(f, u, y + 1.0, depth - 0.03, width, rail, rail, 1));
  for (const s of [-1, 1]) plant.push(frameBox(f, u + s * (width / 2 - 0.02), y + 1.0, depth / 2, rail, rail, depth, 1));
  // Posts at the corners and every ~0.55 m, a bottom rail: read as a railing from the street at a fraction of
  // the boxes of real balusters.
  plant.push(frameBox(f, u, y + 0.1, depth - 0.03, width, rail * 0.75, rail * 0.75, 1));
  const posts = Math.max(2, Math.round(width / 0.55));
  for (let i = 0; i <= posts; i++) plant.push(frameBox(f, u - width / 2 + 0.02 + (i * (width - 0.04)) / posts, y + 0.5, depth - 0.03, 0.025, 1.0, 0.025, 1));
}

/**
 * What stands on a flat city roof: the stair and lift housing, air-conditioning units in a row, vent stacks,
 * and on brick buildings chimney stacks. Seen from any height a bare roof slab reads as a model, not a roof.
 */
function roofClutter(b: MapBox, roofY: number, walls: BufferGeometry[], plant: BufferGeometry[], wallTile: number): void {
  const seed = b.facade?.seed ?? 0;
  const yaw = b.yawRad ?? 0;
  const f = new Frame();
  f.normal.set(Math.sin(yaw), 0, Math.cos(yaw));
  f.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  // Frame origin at the roof's centre; along = local X, out = local Z.
  f.origin.set(b.center.x, roofY, b.center.z);
  const hx = b.size.x / 2 - 2;
  const hz = b.size.z / 2 - 2;
  if (hx < 1 || hz < 1) return;
  const at = (k: number): [number, number] => [(hash(seed, k, 1) * 2 - 1) * hx, (hash(seed, k, 2) * 2 - 1) * hz];
  // Stair and lift housing.
  const [sx, sz] = at(0);
  walls.push(frameBox(f, sx, 1.4, sz, 3.2, 2.8, 2.6, wallTile, false));
  // AC units in a row, on a pair of rails.
  const [ax, az] = at(1);
  const units = 2 + Math.floor(hash(seed, 3, 3) * 4);
  for (let i = 0; i < units; i++) plant.push(frameBox(f, ax + (i - units / 2) * 1.25, 0.5, az, 1.0, 0.85, 0.75, 1, false));
  plant.push(frameBox(f, ax - 0.6, 0.04, az, units * 1.25 + 0.4, 0.08, 0.1, 1, false));
  // Vent stacks.
  for (let i = 0; i < 3; i++) {
    const [vx, vz] = at(4 + i);
    plant.push(frameBox(f, vx, 0.6, vz, 0.28, 1.2, 0.28, 1, false));
    plant.push(frameBox(f, vx, 1.25, vz, 0.45, 0.1, 0.45, 1, false));
  }
  if (b.look === 'brick' || b.look === 'brickDark') {
    for (let i = 0; i < 2; i++) {
      const [cx, cz] = at(8 + i);
      walls.push(frameBox(f, cx, 0.8, cz, 0.7, 1.6, 1.4, wallTile, false));
    }
  }
}

/**
 * A shop awning: the canvas slopes out 1.25 m and down from just under the fascia, with a valance
 * hanging at the front and closed sides. Carries `color` (the canvas) and `stripe` (1 for striped).
 */
function awning(f: Frame, u: number, storey: number, bay: number, r: number): BufferGeometry {
  const w = bay * 0.86;
  const y0 = 0.755 * storey;
  const out = 1.25;
  const drop = 0.32;
  const valance = 0.16;
  const pos: number[] = [];
  const uvs: number[] = [];
  const quad = (a: Vector3, b: Vector3, c2: Vector3, d: Vector3, ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number]): void => {
    for (const [p, t] of [
      [a, ua],
      [b, ub],
      [c2, uc],
      [a, ua],
      [c2, uc],
      [d, ud],
    ] as [Vector3, [number, number]][]) {
      pos.push(p.x, p.y, p.z);
      uvs.push(t[0], t[1]);
    }
  };
  const P = (along: number, up: number, o: number): Vector3 => f.toWorld(u + along, up, o);
  const l = -w / 2;
  const rr = w / 2;
  // Canvas: back edge on the wall, front edge out and down.
  quad(P(l, y0, 0), P(rr, y0, 0), P(rr, y0 - drop, out), P(l, y0 - drop, out), [0, 0], [w, 0], [w, 1], [0, 1]);
  // Valance.
  quad(P(l, y0 - drop, out), P(rr, y0 - drop, out), P(rr, y0 - drop - valance, out), P(l, y0 - drop - valance, out), [0, 1], [w, 1], [w, 1.15], [0, 1.15]);
  // Sides: triangles from the wall to the front, as degenerate quads.
  for (const x of [l, rr]) quad(P(x, y0, 0), P(x, y0 - drop, out), P(x, y0 - drop - valance, out), P(x, y0 - drop - valance * 0.3, 0.05), [0, 0], [1.25, 0], [1.25, 0.15], [0, 0.1]);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.computeVertexNormals();
  const n = pos.length / 3;
  const col = CANVAS[Math.floor(r * CANVAS.length) % CANVAS.length] as [number, number, number];
  const striped = r > 0.55 ? 1 : 0;
  const colour = new Float32Array(n * 3);
  const stripe = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    colour.set(col, i * 3);
    stripe[i] = striped;
  }
  g.setAttribute('color', new BufferAttribute(colour, 3));
  g.setAttribute('stripe', new BufferAttribute(stripe, 1));
  return g;
}

/** Canvas: woven, matt, both sides; striped awnings alternate the colour with cream every 25 cm. */
export function awningMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.88, metalness: 0 });
  const base = attribute('color', 'vec3');
  const bands = step(0.5, fract(uv().x.div(0.25))).mul(attribute('stripe', 'float'));
  // A little weathering: the sun bleaches the slope, the valance keeps its colour.
  const bleach = mix(float(1.15), float(1), step(1, uv().y));
  m.colorNode = mix(base, vec3(0.62, 0.58, 0.48), bands).mul(bleach);
  return m;
}
