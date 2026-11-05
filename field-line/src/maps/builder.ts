import { carModelInfo, carModelOf } from './vehicles.ts';
import type { SurfaceKind } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { Vec3 } from '../core/vec.ts';
import type { Heightfield } from '../game/collision.ts';
import { sampleHeight } from './terrain.ts';
import type { BoxLook, Bulb, InteriorVolume, MapBox, MapData, MapProp, PropKind } from './types.ts';

// Accumulates boxes, props and lights while a map generator runs, and knows
// how to build the recurring pieces: walls with door and window openings,
// stair flights, and the collider set for each prop kind.
//
// Building dimensions come from the city grey-box column of
// scale-reference.png: door 2.10 × 0.90 m, storey 3.0 m, stair riser 0.17 m /
// tread 0.28 m, window sill 0.90 m.

export const CITY_SCALE = {
  doorHeightM: 2.1,
  doorWidthM: 0.9,
  shopDoorWidthM: 1.8, // double door: also wide enough for the AI nav grid
  storeyM: 3.0,
  stairRiserM: 0.17,
  stairTreadM: 0.28,
  stairWidthM: 1.2,
  windowSillM: 0.9,
  windowHeadM: 2.2,
  windowWidthM: 1.4,
  wallThicknessM: 0.3,
  slabThicknessM: 0.2,
  kerbM: 0.15,
  laneM: 3.5,
} as const;

export const SURFACE_OF_LOOK: Record<BoxLook, SurfaceKind> = {
  brick: 'brick',
  brickDark: 'brick',
  concrete: 'concrete',
  plaster: 'brick', // plaster over block work
  paint: 'brick', // painted plaster on masonry (interiors)
  woodFloor: 'wood',
  tiles: 'concrete',
  glass: 'glass',
  roofTar: 'concrete',
  metalDark: 'sheetMetal',
  wood: 'wood',
  kerb: 'concrete',
  pavement: 'concrete',
  facadeGlass: 'glass',
  stone: 'rock',
  sandbag: 'soil',
  targetSteel: 'armourPlate',
  invisible: 'concrete',
};

/** One opening cut into a wall run, measured along the wall from its start. */
export interface Opening {
  startM: number;
  widthM: number;
  bottomM: number; // above the wall base
  topM: number;
  glass: boolean;
}

export class MapBuilder {
  readonly boxes: MapBox[] = [];
  readonly props: MapProp[] = [];
  readonly bulbs: Bulb[] = [];
  readonly interiors: InteriorVolume[] = [];
  readonly paint: NonNullable<MapData['paint']> = [];
  readonly rng: Rng;

  constructor(
    readonly terrain: Heightfield,
    seed: number,
  ) {
    this.rng = new Rng(seed);
  }

  ground(x: number, z: number): number {
    return sampleHeight(this.terrain, x, z);
  }

  /** Axis box from its centre and full size. Surface follows the look unless given. */
  box(look: BoxLook, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yawRad = 0, extra: Partial<MapBox> = {}): MapBox {
    if (sx <= 0 || sy <= 0 || sz <= 0) throw new Error(`map box '${look}' at (${cx}, ${cy}, ${cz}) has a non-positive size ${sx}×${sy}×${sz} m`);
    const b: MapBox = {
      look,
      center: new Vec3(cx, cy, cz),
      size: new Vec3(sx, sy, sz),
      yawRad,
      surface: extra.surface ?? SURFACE_OF_LOOK[look],
      ...extra,
    };
    this.boxes.push(b);
    return b;
  }

  /** Box from a base height: y is the bottom face. */
  boxOnBase(look: BoxLook, cx: number, baseY: number, cz: number, sx: number, sy: number, sz: number, yawRad = 0, extra: Partial<MapBox> = {}): MapBox {
    return this.box(look, cx, baseY + sy / 2, cz, sx, sy, sz, yawRad, extra);
  }

  /**
   * A straight wall from (x0, z0) to (x1, z1) — axis aligned only — with
   * rectangular openings. Solid parts become piers, sills and lintels; glazed
   * openings get a pane that bullets and grenades can break.
   */
  wall(look: BoxLook, x0: number, z0: number, x1: number, z1: number, baseY: number, heightM: number, thicknessM: number, openings: readonly Opening[], interior: boolean): void {
    const alongX = Math.abs(z1 - z0) < 1e-6;
    if (!alongX && Math.abs(x1 - x0) > 1e-6) throw new Error(`wall (${x0}, ${z0}) → (${x1}, ${z1}) must be axis aligned`);
    const lengthM = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const sign = alongX ? Math.sign(x1 - x0) || 1 : Math.sign(z1 - z0) || 1;
    const sorted = [...openings].sort((a, b) => a.startM - b.startM);
    const place = (fromM: number, toM: number, bottomM: number, topM: number, pieceLook: BoxLook): void => {
      const len = toM - fromM;
      const h = topM - bottomM;
      if (len < 0.02 || h < 0.02) return;
      const mid = (fromM + toM) / 2;
      const cx = alongX ? x0 + sign * mid : x0;
      const cz = alongX ? z0 : z0 + sign * mid;
      const sx = alongX ? len : thicknessM;
      const sz = alongX ? thicknessM : len;
      const pane = pieceLook === 'glass';
      this.boxOnBase(pieceLook, cx, baseY + bottomM, cz, pane ? (alongX ? len : 0.02) : sx, h, pane ? (alongX ? 0.02 : len) : sz, 0, { interior });
    };
    let cursor = 0;
    for (const o of sorted) {
      if (o.startM < cursor - 1e-6 || o.startM + o.widthM > lengthM + 1e-6) {
        throw new Error(`wall opening at ${o.startM} m (${o.widthM} m wide) overlaps another or runs past the ${lengthM} m wall`);
      }
      place(cursor, o.startM, 0, heightM, look);
      place(o.startM, o.startM + o.widthM, 0, o.bottomM, look);
      place(o.startM, o.startM + o.widthM, o.topM, heightM, look);
      if (o.glass) {
        place(o.startM, o.startM + o.widthM, o.bottomM, o.topM, 'glass');
        this.windowFrame(alongX, sign, x0, z0, baseY, thicknessM, o, interior);
      }
      cursor = o.startM + o.widthM;
    }
    place(cursor, lengthM, 0, heightM, look);
  }

  /**
   * The frame round a glazed opening (head, jambs, a bottom rail, a mullion in a wide one), set in the plane
   * of the pane, and a sill under it that stands proud of both faces of the wall (stone outside, a board
   * inside). Without them a window is a hole with glass in it.
   */
  private windowFrame(alongX: boolean, sign: number, x0: number, z0: number, baseY: number, thicknessM: number, o: Opening, interior: boolean): void {
    const F = 0.065;
    const depth = 0.1;
    const strip = (fromM: number, toM: number, bottomM: number, topM: number, look: BoxLook, deep: number): void => {
      const mid = (fromM + toM) / 2;
      const len = toM - fromM;
      const cx = alongX ? x0 + sign * mid : x0;
      const cz = alongX ? z0 : z0 + sign * mid;
      this.boxOnBase(look, cx, baseY + bottomM, cz, alongX ? len : deep, topM - bottomM, alongX ? deep : len, 0, { interior, blocksVision: false });
    };
    const a = o.startM;
    const b = o.startM + o.widthM;
    strip(a, b, o.topM - F, o.topM, 'metalDark', depth);
    strip(a, a + F, o.bottomM, o.topM - F, 'metalDark', depth);
    strip(b - F, b, o.bottomM, o.topM - F, 'metalDark', depth);
    strip(a + F, b - F, o.bottomM, o.bottomM + F, 'metalDark', depth);
    if (o.widthM > 1.3) strip((a + b) / 2 - F / 2, (a + b) / 2 + F / 2, o.bottomM + F, o.topM - F, 'metalDark', depth);
    // Windows only (a glazed door reaches the floor and has no sill).
    if (o.bottomM > 0.3) strip(a - 0.06, b + 0.06, o.bottomM - 0.05, o.bottomM, 'concrete', thicknessM + 0.14);
  }

  /**
   * One straight stair flight rising along +X or -X / +Z or -Z from (x, baseY, z),
   * built from solid step boxes so the capsule controller climbs it as steps.
   */
  stairFlight(x: number, z: number, baseY: number, riseM: number, dirX: number, dirZ: number, look: BoxLook): { endX: number; endZ: number; runM: number } {
    const steps = Math.round(riseM / CITY_SCALE.stairRiserM);
    const riser = riseM / steps;
    const tread = CITY_SCALE.stairTreadM;
    const w = CITY_SCALE.stairWidthM;
    for (let i = 0; i < steps; i++) {
      const along = (i + 0.5) * tread;
      const h = (i + 1) * riser;
      const cx = x + dirX * along;
      const cz = z + dirZ * along;
      this.boxOnBase(look, cx, baseY, cz, dirX !== 0 ? tread : w, h, dirZ !== 0 ? tread : w, 0, { interior: true });
    }
    const runM = steps * tread;
    return { endX: x + dirX * runM, endZ: z + dirZ * runM, runM };
  }

  /** A visual prop plus the simple colliders that stand in for it (rules §5). */
  prop(kind: PropKind, x: number, z: number, yawRad: number, opts: { scale?: number; colourIndex?: number; label?: string; baseY?: number } = {}): MapProp {
    const baseY = opts.baseY ?? this.ground(x, z);
    const scale = opts.scale ?? 1;
    const p: MapProp = { kind, pos: new Vec3(x, baseY, z), yawRad, scale, seed: Math.floor(this.rng.next() * 1e9) };
    if (opts.colourIndex !== undefined) p.colourIndex = opts.colourIndex;
    if (opts.label !== undefined) p.label = opts.label;
    this.props.push(p);
    this.addPropColliders(p);
    return p;
  }

  private addPropColliders(p: MapProp): void {
    const c = Math.cos(p.yawRad);
    const s = Math.sin(p.yawRad);
    // Local (x right, z back) offset → world, same yaw convention as collision.ts.
    const at = (lx: number, lz: number): [number, number] => [p.pos.x + c * lx + s * lz, p.pos.z - s * lx + c * lz];
    const k = p.scale;
    const inv = (surface: SurfaceKind, lx: number, lz: number, baseY: number, sx: number, sy: number, sz: number, blocksVision = true): void => {
      const [wx, wz] = at(lx, lz);
      this.boxOnBase('invisible', wx, p.pos.y + baseY, wz, sx, sy, sz, p.yawRad, { surface, blocksVision });
    };
    switch (p.kind) {
      case 'car': {
        // The shared model this car is (maps/vehicles.ts): its lower body to the waistline, and the cabin
        // above it, a little narrower and about half the length, set back from the bonnet.
        const [w, h, l] = carModelInfo(carModelOf(p)).size;
        const waist = h * 0.55;
        inv('sheetMetal', 0, 0, 0.22, w * 0.94, waist - 0.22, l * 0.98);
        inv('sheetMetal', 0, l * 0.06, waist, w * 0.84, h - waist, l * 0.5);
        break;
      }
      case 'carWreck':
        // The procedural hatchback burnt out, L 4.2 × W 1.8 × H 1.45 m: body and cabin.
        inv('sheetMetal', 0, 0, 0.25, 1.8, 0.75, 4.2);
        inv('sheetMetal', 0, 0.25, 1.0, 1.6, 0.35, 2.2);
        break;
      case 'container':
        inv('sheetMetal', 0, 0, 0, 2.44, 2.59, 6.06); // ISO 20 ft box
        break;
      case 'barrier':
        inv('concrete', 0, 0, 0, 0.6, 0.81, 3.0); // jersey barrier
        break;
      case 'lampPost':
        inv('sheetMetal', 0, 0, 0, 0.16, 6.5, 0.16, false);
        break;
      case 'streetTree':
        inv('wood', 0, 0, 0, 0.3 * k, 3.0 * k, 0.3 * k, false);
        break;
      case 'bench':
        inv('wood', 0, 0, 0, 1.8, 0.45, 0.5, false);
        break;
      case 'trashBin':
        inv('sheetMetal', 0, 0, 0, 0.6, 1.0, 0.6);
        break;
      case 'rock':
        inv('rock', 0, 0, -0.3 * k, 2.4 * k, 1.6 * k, 2.0 * k);
        break;
      case 'stump':
        inv('wood', 0, 0, 0, 1.1 * k, 0.5 * k, 1.2 * k, false); // the scanned stump, 1.4 m across its roots
        break;
      case 'deadLog':
        inv('wood', 0, 0, 0, 3.0 * k, 0.3 * k, 0.3 * k, false); // the scanned trunk lies along its local x
        break;
      case 'hayBale':
        inv('fabric', 0, 0, 0, 1.2, 1.2, 1.8);
        break;
      case 'crate':
        inv('wood', 0, 0, 0, 1.0 * k, 1.0 * k, 1.0 * k);
        break;
      case 'beam':
        inv('wood', 0, 0, 0, 0.25, 0.25, 4.0 * k, false);
        break;
      case 'rangeSign':
        inv('wood', 0, 0, 0, 1.2, 1.6, 0.08, false);
        break;
      case 'kiosk':
        inv('sheetMetal', 0, 0, 0, 2.5, 2.5, 2.3);
        break;
      case 'planter':
        inv('concrete', 0, 0, 0, 2.2, 0.55, 0.9); // waist-high cover; the hedge above it hides, it does not stop
        break;
      case 'bollard':
        inv('sheetMetal', 0, 0, 0, 0.15, 0.95, 0.15, false);
        break;
      case 'busShelter':
        inv('glass', 0, -0.56, 0, 3.6, 2.4, 0.08, false);
        inv('sheetMetal', 1.75, 0, 0, 0.16, 2.0, 1.15);
        break;
      case 'roadBarrier':
        inv('fabric', 0, 0, 0, 1.4, 1.0, 0.3, false);
        break;
      case 'cone':
        inv('fabric', 0, 0, 0, 0.35, 0.75, 0.35, false);
        break;
      case 'hydrant':
        inv('sheetMetal', 0, 0, 0, 0.35, 0.8, 0.35, false);
        break;
      case 'cafeSet':
        inv('sheetMetal', 0, 0, 0, 0.8, 0.75, 0.8, false);
        break;
      case 'memorial':
        inv('concrete', 0, 0, 0, 3.4, 0.6, 3.4);
        inv('concrete', 0, 0, 0, 1.5, 7.6, 1.5);
        break;
      case 'dummy':
        break; // dummies are soldiers; their hitboxes do the work
    }
  }

  bulb(x: number, y: number, z: number, intensityCd: number): void {
    this.bulbs.push({ pos: new Vec3(x, y, z), intensityCd });
  }
}
