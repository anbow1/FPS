import { CITY } from '../config';
import { hyp2 } from '../core/mathx';
import { Rng } from '../core/rng';
import { LAKES } from './layout';

// The town's plan: streets, blocks and the buildings on them, as plain data. Nothing here touches
// three.js, so the plan is tested headlessly (tests/cityPlan.test.ts) and the same numbers drive the
// terrain shader's paving (render/cityGround.ts), the geometry (world/cityBuildings.ts), the grass,
// the forests, the minimap and where the AI drives.
//
// The grid: CITY.blocksX + 1 street lines along z (at x = lineX(k)) and CITY.blocksZ + 1 along x;
// the outermost are the ring streets on the rectangle's edges. A block is the land between four
// lines, less their carriageways and pavements.

export type BlockKind = 'none' | 'tenement' | 'estate' | 'industrial' | 'park' | 'square';

/** What the ground is at a point, as the paving shader draws it. */
export type Surface = 'outside' | 'street' | 'walk' | 'square' | 'block' | 'park' | 'none';

export interface Block {
  i: number;
  j: number;
  kind: BlockKind;
  /** The land inside the pavements (m). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export type WallKind = 'plaster' | 'brick' | 'concrete' | 'metal';
export type RoofKind = 'flat' | 'gable';
/** Window scheme the facade shader draws (render/cityMaterial.ts reads the same numbers). */
export const WINDOWS = { none: 0, tenement: 1, shops: 2, prefab: 3, industrial: 4, church: 5 } as const;
export type WindowScheme = (typeof WINDOWS)[keyof typeof WINDOWS];

/**
 * One building. Its own frame: x along the frontage (`w`), z through the depth (`d`), the street
 * front at local +z; `rotRad` turns that frame about +y onto the world (local +z → (sin, 0, cos)).
 */
export interface Lot {
  x: number;
  z: number;
  rotRad: number;
  w: number;
  d: number;
  /** Height of the walls above the ground floor's level (m), excluding parapet and roof. */
  wallM: number;
  /** Storey height above the ground floor, and the ground floor's own (m). */
  floorM: number;
  groundM: number;
  bayM: number;
  wall: WallKind;
  roof: RoofKind;
  windows: WindowScheme;
  /** The gable ends (local −x, +x) face a street and have windows; party walls stay blank. */
  openLeft: boolean;
  openRight: boolean;
  balconies: boolean;
  /** A spire on top (the church tower) or a chimney stack (an old works). */
  extra: 'none' | 'spire' | 'chimney';
  seed: number;
}

export interface Spot {
  x: number;
  z: number;
  yawRad: number;
}

/** Grid pitch (m). */
export const PITCH_X = (CITY.x1M - CITY.x0M) / CITY.blocksX;
export const PITCH_Z = (CITY.z1M - CITY.z0M) / CITY.blocksZ;

export function lineX(k: number): number {
  return CITY.x0M + k * PITCH_X;
}
export function lineZ(k: number): number {
  return CITY.z0M + k * PITCH_Z;
}
/** Carriageway half-width and pavement width of grid line k along each axis (m). */
export function halfX(k: number): number {
  return k % CITY.avenueEveryX === 0 ? CITY.avenueHalfM : CITY.streetHalfM;
}
export function walkX(k: number): number {
  return k % CITY.avenueEveryX === 0 ? CITY.avenueWalkM : CITY.streetWalkM;
}
export function halfZ(k: number): number {
  return k % CITY.avenueEveryZ === 0 ? CITY.avenueHalfM : CITY.streetHalfM;
}
export function walkZ(k: number): number {
  return k % CITY.avenueEveryZ === 0 ? CITY.avenueWalkM : CITY.streetWalkM;
}

/** Furthest the ring streets reach outside the rectangle (m). */
export const RING_REACH_M = CITY.avenueHalfM + CITY.avenueWalkM;

/**
 * How far the terrain is levelled for the town: 1 within the ring streets, falling to 0 over 90 m
 * outside them. Depends only on the rectangle, so the heightfield can use it before the plan exists.
 */
export function cityFlattenWeight(x: number, z: number): number {
  const ox = Math.max(CITY.x0M - RING_REACH_M - x, 0, x - CITY.x1M - RING_REACH_M);
  const oz = Math.max(CITY.z0M - RING_REACH_M - z, 0, z - CITY.z1M - RING_REACH_M);
  const t = Math.min(1, hyp2(ox, oz) / 90);
  return 1 - t * t * (3 - 2 * t);
}

/** True within the ring streets' outer edge: the town's paving replaces the dirt roads there. */
export function insideCityBounds(x: number, z: number, marginM = 0): boolean {
  const r = RING_REACH_M + marginM;
  return x > CITY.x0M - r && x < CITY.x1M + r && z > CITY.z0M - r && z < CITY.z1M + r;
}

const ACTIVE: ReadonlySet<BlockKind> = new Set(['tenement', 'estate', 'industrial', 'park', 'square']);

export class CityPlan {
  readonly blocks: Block[] = [];
  readonly lots: Lot[] = [];
  readonly lamps: Spot[] = [];
  /** Street trees on the avenues and trees in the parks. */
  readonly trees: Spot[] = [];
  /** The square's block (the church stands on it). */
  readonly square: Block;

  constructor(seed: number) {
    const rng = new Rng(seed);
    const sq = { i: Math.floor((CITY.centreX - CITY.x0M) / PITCH_X), j: Math.floor((CITY.centreZ - CITY.z0M) / PITCH_Z) };
    for (let j = 0; j < CITY.blocksZ; j++) {
      for (let i = 0; i < CITY.blocksX; i++) {
        const b: Block = {
          i,
          j,
          kind: 'tenement',
          x0: lineX(i) + halfX(i) + walkX(i),
          x1: lineX(i + 1) - halfX(i + 1) - walkX(i + 1),
          z0: lineZ(j) + halfZ(j) + walkZ(j),
          z1: lineZ(j + 1) - halfZ(j + 1) - walkZ(j + 1),
        };
        b.kind = i === sq.i && j === sq.j ? 'square' : this.zoneKind(b, rng);
        this.blocks.push(b);
      }
    }
    this.square = this.block(sq.i, sq.j)!;
    for (const b of this.blocks) this.fillBlock(b, rng);
    this.placeLamps();
    this.placeStreetTrees();
  }

  block(i: number, j: number): Block | null {
    if (i < 0 || j < 0 || i >= CITY.blocksX || j >= CITY.blocksZ) return null;
    return this.blocks[j * CITY.blocksX + i]!;
  }

  /** A block that has streets round it (anything but the lake shore). */
  active(i: number, j: number): boolean {
    const b = this.block(i, j);
    return b !== null && ACTIVE.has(b.kind);
  }

  /** The ground at a point: the shader's paving and this agree (render/cityGround.ts). */
  surfaceAt(x: number, z: number): Surface {
    if (!insideCityBounds(x, z)) return 'outside';
    const qx = (x - CITY.x0M) / PITCH_X;
    const qz = (z - CITY.z0M) / PITCH_Z;
    const kx = clampInt(Math.round(qx), 0, CITY.blocksX);
    const kz = clampInt(Math.round(qz), 0, CITY.blocksZ);
    const ix = clampInt(Math.floor(qx), 0, CITY.blocksX - 1);
    const jz = clampInt(Math.floor(qz), 0, CITY.blocksZ - 1);
    const dx = Math.abs(x - lineX(kx));
    const dz = Math.abs(z - lineZ(kz));
    const actX = this.active(kx - 1, jz) || this.active(kx, jz);
    const actZ = this.active(ix, kz - 1) || this.active(ix, kz);
    if ((actX && dx < halfX(kx)) || (actZ && dz < halfZ(kz))) return 'street';
    if ((actX && dx < halfX(kx) + walkX(kx)) || (actZ && dz < halfZ(kz) + walkZ(kz))) return 'walk';
    const inRect = x >= CITY.x0M && x <= CITY.x1M && z >= CITY.z0M && z <= CITY.z1M;
    if (!inRect) return 'outside';
    const b = this.block(ix, jz)!;
    if (b.kind === 'square') return 'square';
    if (b.kind === 'park') return 'park';
    if (b.kind === 'none') return 'none';
    return 'block';
  }

  isStreet(x: number, z: number): boolean {
    return this.surfaceAt(x, z) === 'street';
  }

  /** Nearest point on the centreline of a street that exists; `out` unchanged outside the town. */
  snapToStreet(x: number, z: number, out: { x: number; z: number }): boolean {
    if (!insideCityBounds(x, z, 30)) return false;
    let best = Infinity;
    const cz = Math.min(CITY.z1M, Math.max(CITY.z0M, z));
    const cx = Math.min(CITY.x1M, Math.max(CITY.x0M, x));
    for (let k = 0; k <= CITY.blocksX; k++) {
      const px = lineX(k);
      const d = Math.abs(px - x) + Math.abs(cz - z);
      if (d < best && this.isStreet(px, cz)) {
        best = d;
        out.x = px;
        out.z = cz;
      }
    }
    for (let k = 0; k <= CITY.blocksZ; k++) {
      const pz = lineZ(k);
      const d = Math.abs(cx - x) + Math.abs(pz - z);
      if (d < best && this.isStreet(cx, pz)) {
        best = d;
        out.x = cx;
        out.z = pz;
      }
    }
    return best < Infinity;
  }

  /**
   * Lamps on both kerbs of every street, every CITY.lampSpacingM, none inside a junction. The
   * shader's light pools compute the same positions (render/cityGround.ts), so keep the rule here
   * and there identical: `lampSkipped`.
   */
  private placeLamps(): void {
    const S = CITY.lampSpacingM;
    // streets along z (on x-lines)
    for (let k = 0; k <= CITY.blocksX; k++) {
      for (let m = 0; (m + 0.5) * S + CITY.z0M < CITY.z1M; m++) {
        const z = CITY.z0M + (m + 0.5) * S;
        const jz = clampInt(Math.floor((z - CITY.z0M) / PITCH_Z), 0, CITY.blocksZ - 1);
        if (!(this.active(k - 1, jz) || this.active(k, jz)) || lampSkipped(z, 'z')) continue;
        for (const s of [-1, 1]) this.lamps.push({ x: lineX(k) + s * (halfX(k) + 0.6), z, yawRad: s > 0 ? -Math.PI / 2 : Math.PI / 2 });
      }
    }
    // streets along x (on z-lines)
    for (let k = 0; k <= CITY.blocksZ; k++) {
      for (let m = 0; (m + 0.5) * S + CITY.x0M < CITY.x1M; m++) {
        const x = CITY.x0M + (m + 0.5) * S;
        const ix = clampInt(Math.floor((x - CITY.x0M) / PITCH_X), 0, CITY.blocksX - 1);
        if (!(this.active(ix, k - 1) || this.active(ix, k)) || lampSkipped(x, 'x')) continue;
        for (const s of [-1, 1]) this.lamps.push({ x, z: lineZ(k) + s * (halfZ(k) + 0.6), yawRad: s > 0 ? Math.PI : 0 });
      }
    }
  }

  /** Lindens down the avenues' pavements, halfway between the lamps. */
  private placeStreetTrees(): void {
    const S = CITY.lampSpacingM;
    for (let k = 0; k <= CITY.blocksX; k += CITY.avenueEveryX) {
      for (let m = 1; m * S + CITY.z0M < CITY.z1M; m++) {
        const z = CITY.z0M + m * S;
        const jz = clampInt(Math.floor((z - CITY.z0M) / PITCH_Z), 0, CITY.blocksZ - 1);
        if (!(this.active(k - 1, jz) || this.active(k, jz)) || lampSkipped(z, 'z')) continue;
        for (const s of [-1, 1]) this.trees.push({ x: lineX(k) + s * (halfX(k) + walkX(k) * 0.55), z, yawRad: m * 1.7 + s });
      }
    }
    for (let k = 0; k <= CITY.blocksZ; k += CITY.avenueEveryZ) {
      for (let m = 1; m * S + CITY.x0M < CITY.x1M; m++) {
        const x = CITY.x0M + m * S;
        const ix = clampInt(Math.floor((x - CITY.x0M) / PITCH_X), 0, CITY.blocksX - 1);
        if (!(this.active(ix, k - 1) || this.active(ix, k)) || lampSkipped(x, 'x')) continue;
        for (const s of [-1, 1]) this.trees.push({ x, z: lineZ(k) + s * (halfZ(k) + walkZ(k) * 0.55), yawRad: m * 2.3 + s });
      }
    }
  }

  private zoneKind(b: Block, rng: Rng): BlockKind {
    // The lake shore: no streets within 1.3 lake radii (the carved banks reach ~1.35), a park belt to 1.75.
    for (const l of LAKES) {
      const cx = Math.min(b.x1, Math.max(b.x0, l.x));
      const cz = Math.min(b.z1, Math.max(b.z0, l.z));
      const d = hyp2(cx - l.x, cz - l.z);
      if (d < l.r * 1.3) return 'none';
      if (d < l.r * 1.75) return 'park';
    }
    const r = rng.next();
    if (r < 0.06) return 'park';
    if (b.i >= CITY.blocksX - 2 && r < 0.75) return 'industrial';
    if ((b.i <= 2 || b.j === CITY.blocksZ - 1) && r < 0.5) return 'estate';
    return 'tenement';
  }

  private fillBlock(b: Block, rng: Rng): void {
    switch (b.kind) {
      case 'tenement':
        this.perimeterBlock(b, rng);
        break;
      case 'estate':
        this.estate(b, rng);
        break;
      case 'industrial':
        this.works(b, rng);
        break;
      case 'square':
        this.church(b);
        break;
      case 'park':
        this.parkTrees(b, rng);
        break;
      case 'none':
        break;
    }
  }

  /** Distance of a block's middle from the downtown centre (m): sets the storeys. */
  private downtown(b: Block): number {
    return hyp2((b.x0 + b.x1) / 2 - CITY.centreX, (b.z0 + b.z1) / 2 - CITY.centreZ);
  }

  /**
   * Tenements round a courtyard: rows along the four edges, the north and south rows full width
   * (their end houses are the corner houses, open to both streets), the east and west rows between
   * them. Each row is cut into houses of an even number of bays.
   */
  private perimeterBlock(b: Block, rng: Rng): void {
    const setback = 0.3;
    const x0 = b.x0 + setback;
    const x1 = b.x1 - setback;
    const z0 = b.z0 + setback;
    const z1 = b.z1 - setback;
    // The north and south rows run the block's full width; their houses are four bays deep, so a
    // corner house's side to the cross street is a whole number of bays too (the facade shader
    // centres its windows on the bays).
    const bayOf = (len: number): number => len / Math.max(2, 2 * Math.round(len / (CITY.bayMinM + CITY.bayMaxM)));
    const depth = 4 * bayOf(x1 - x0);
    const dt = this.downtown(b);
    const base = dt < 280 ? 5 : dt < 560 ? 4 : 3;
    // A row: its start and end along the frontage, where its front line sits, which way it faces, and
    // whether its two end houses are corner houses.
    const rows: { a: number; e: number; at: number; axis: 'x' | 'z'; facing: 1 | -1; corners: boolean; avenue: boolean }[] = [
      { a: x0, e: x1, at: z0 + depth / 2, axis: 'x', facing: -1, corners: true, avenue: b.j % CITY.avenueEveryZ === 0 },
      { a: x0, e: x1, at: z1 - depth / 2, axis: 'x', facing: 1, corners: true, avenue: (b.j + 1) % CITY.avenueEveryZ === 0 },
      { a: z0 + depth, e: z1 - depth, at: x0 + depth / 2, axis: 'z', facing: -1, corners: false, avenue: b.i % CITY.avenueEveryX === 0 },
      { a: z0 + depth, e: z1 - depth, at: x1 - depth / 2, axis: 'z', facing: 1, corners: false, avenue: (b.i + 1) % CITY.avenueEveryX === 0 },
    ];
    for (const row of rows) {
      const len = row.e - row.a;
      const bay = bayOf(len);
      const bays = Math.round(len / bay);
      if (bays < 4) continue;
      let used = 0;
      while (used < bays) {
        const left = bays - used;
        let n = 2 * rng.int(2, 5);
        if (n > left || left - n < 4) n = left;
        const first = used === 0;
        const last = used + n === bays;
        used += n;
        const corner = row.corners && (first || last);
        // a gap here and there (a bombed-out or never-built lot), never on a corner
        if (!corner && rng.next() < 0.06) continue;
        const along = row.a + (used - n / 2) * bay;
        const w = n * bay;
        const floors = Math.max(2, base + rng.int(-1, 1));
        const shops = row.avenue || dt < 350 ? rng.next() < 0.8 : rng.next() < 0.2;
        const groundM = shops ? CITY.shopGroundM : CITY.tenementFloorM + 0.5;
        const wallR = rng.next();
        const wall: WallKind = wallR < 0.58 ? 'plaster' : wallR < 0.88 ? 'brick' : 'concrete';
        // The frame's local −x end lies at the row's start when the house faces +axis, at its end otherwise.
        const startIsLeft = row.axis === 'x' ? row.facing > 0 : row.facing < 0;
        const lot: Lot = {
          x: row.axis === 'x' ? along : row.at,
          z: row.axis === 'x' ? row.at : along,
          rotRad: row.axis === 'x' ? (row.facing > 0 ? 0 : Math.PI) : row.facing > 0 ? Math.PI / 2 : -Math.PI / 2,
          w,
          d: depth,
          wallM: groundM + (floors - 1) * CITY.tenementFloorM,
          floorM: CITY.tenementFloorM,
          groundM,
          bayM: bay,
          wall,
          roof: floors <= 5 && rng.next() < 0.35 ? 'gable' : 'flat',
          windows: shops ? WINDOWS.shops : WINDOWS.tenement,
          openLeft: corner && (startIsLeft ? first : last),
          openRight: corner && (startIsLeft ? last : first),
          balconies: rng.next() < 0.35,
          extra: 'none',
          seed: rng.next() * 100,
        };
        this.lots.push(lot);
      }
    }
  }

  /** A prefab estate: two or three slab blocks on the green, gables blank as on the real ones. */
  private estate(b: Block, rng: Rng): void {
    const width = b.x1 - b.x0;
    const deep = b.z1 - b.z0;
    const slabs = deep > 52 ? 2 : 1;
    const bay = 3.6;
    const bays = 2 * Math.floor((width - 14) / (2 * bay));
    if (bays < 6) return;
    const tall = rng.next() < 0.4;
    const floors = tall ? 11 : 5;
    for (let s = 0; s < slabs; s++) {
      const z = slabs === 1 ? (b.z0 + b.z1) / 2 : b.z0 + 8 + 6 + s * (deep - 28);
      this.lots.push({
        x: (b.x0 + b.x1) / 2 + rng.range(-3, 3),
        z,
        rotRad: s === 0 ? Math.PI : 0,
        w: bays * bay,
        d: 12,
        wallM: CITY.prefabFloorM + 0.6 + (floors - 1) * CITY.prefabFloorM,
        floorM: CITY.prefabFloorM,
        groundM: CITY.prefabFloorM + 0.6,
        bayM: bay,
        wall: 'concrete',
        roof: 'flat',
        windows: WINDOWS.prefab,
        openLeft: false,
        openRight: false,
        balconies: rng.next() < 0.7,
        extra: 'none',
        seed: rng.next() * 100,
      });
    }
  }

  /** Works on the east edge: sheds of corrugated steel or old brick halls, some with a stack. */
  private works(b: Block, rng: Rng): void {
    const width = b.x1 - b.x0;
    const deep = b.z1 - b.z0;
    const halls = width > 70 ? 2 : 1;
    for (let h = 0; h < halls; h++) {
      const brick = rng.next() < 0.4;
      const w = Math.min(width / halls - 8, rng.range(34, 46));
      const d = Math.min(deep - 10, rng.range(22, 34));
      const x = b.x0 + (h + 0.5) * (width / halls);
      const z = (b.z0 + b.z1) / 2 + rng.range(-3, 3);
      const wallM = rng.range(7, 10);
      this.lots.push({
        x,
        z,
        rotRad: rng.next() < 0.5 ? 0 : Math.PI,
        // whole pairs of 6 m bays both ways: the shader centres the windows on the bays
        w: Math.max(24, Math.round(w / 12) * 12),
        d: Math.max(24, Math.round(d / 12) * 12),
        wallM,
        floorM: wallM,
        groundM: 0,
        bayM: 6,
        wall: brick ? 'brick' : 'metal',
        roof: 'gable',
        windows: WINDOWS.industrial,
        openLeft: true,
        openRight: true,
        balconies: false,
        extra: brick && h === 0 && rng.next() < 0.6 ? 'chimney' : 'none',
        seed: rng.next() * 100,
      });
    }
  }

  /** The parish church on the square: nave and a west tower with a spire, the rest of it paved. */
  private church(b: Block): void {
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const nave = { w: 36, d: 18 };
    this.lots.push({
      x: cx + 4,
      z: cz,
      rotRad: Math.PI / 2,
      w: nave.d,
      d: nave.w,
      wallM: 14,
      floorM: 14,
      groundM: 0,
      bayM: 4.5,
      wall: 'brick',
      roof: 'gable',
      windows: WINDOWS.church,
      openLeft: true,
      openRight: true,
      balconies: false,
      extra: 'none',
      seed: 17,
    });
    this.lots.push({
      x: cx + 4 - nave.w / 2 - 4.5,
      z: cz,
      rotRad: -Math.PI / 2,
      w: 9,
      d: 9,
      wallM: 40,
      floorM: 40,
      groundM: 0,
      bayM: 4.5,
      wall: 'brick',
      roof: 'flat',
      windows: WINDOWS.church,
      openLeft: true,
      openRight: true,
      balconies: false,
      extra: 'spire',
      seed: 23,
    });
  }

  private parkTrees(b: Block, rng: Rng): void {
    const cell = 14;
    for (let z = b.z0 + cell / 2; z < b.z1; z += cell) {
      for (let x = b.x0 + cell / 2; x < b.x1; x += cell) {
        if (rng.next() > 0.65) continue;
        const px = x + rng.range(-4, 4);
        const pz = z + rng.range(-4, 4);
        // keep the paths (a cross through the middle) clear
        if (Math.abs(px - (b.x0 + b.x1) / 2) < 4 || Math.abs(pz - (b.z0 + b.z1) / 2) < 4) continue;
        this.trees.push({ x: px, z: pz, yawRad: rng.next() * Math.PI * 2 });
      }
    }
  }

  /**
   * Blocks as a texture for the paving shader, one texel per block: R = has streets round it,
   * G = paved all over (the square).
   */
  blockTexels(): Uint8Array {
    const out = new Uint8Array(CITY.blocksX * CITY.blocksZ * 4);
    for (const b of this.blocks) {
      const o = (b.j * CITY.blocksX + b.i) * 4;
      out[o] = ACTIVE.has(b.kind) ? 255 : 0;
      out[o + 1] = b.kind === 'square' ? 255 : 0;
      out[o + 2] = b.kind === 'park' ? 255 : 0;
      out[o + 3] = 255;
    }
    return out;
  }
}

/**
 * No lamp (and no street tree) within a junction or its crossings: the along-street coordinate `s`
 * is within the crossing street's width plus 3 m of a grid line. `axis` is the axis `s` runs on.
 */
export function lampSkipped(s: number, axis: 'x' | 'z'): boolean {
  const pitch = axis === 'z' ? PITCH_Z : PITCH_X;
  const origin = axis === 'z' ? CITY.z0M : CITY.x0M;
  const n = axis === 'z' ? CITY.blocksZ : CITY.blocksX;
  const k = clampInt(Math.round((s - origin) / pitch), 0, n);
  const reach = axis === 'z' ? halfZ(k) + walkZ(k) : halfX(k) + walkX(k);
  return Math.abs(s - (origin + k * pitch)) < reach + 3;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
