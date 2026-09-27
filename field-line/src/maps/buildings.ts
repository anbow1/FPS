import { LOCAL_LIGHTS } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import { CITY_SCALE as S, type MapBuilder, type Opening } from './builder.ts';
import type { BoxLook } from './types.ts';

// Enterable city building: real interiors, a stair flight per storey, holes in
// the slabs above each flight, glazed windows at sill height, a front shop
// entrance and a back door, and a flat roof with a parapet reached by the last
// flight. Built in a local frame (front = +Z) and turned by quarter turns so
// every wall stays axis aligned for the wall builder.

export interface BuildingSpec {
  cx: number;
  cz: number;
  widthM: number; // along local X
  depthM: number; // along local Z
  storeys: number;
  quarterTurns: 0 | 1 | 2 | 3; // 1 = front faces +X
  baseY: number;
  wallLook: BoxLook;
  floorLook: BoxLook;
}

const BAY_M = 3.0;
const PARAPET_M = 1.0;

export function enterableBuilding(b: MapBuilder, spec: BuildingSpec): void {
  const { widthM: W, depthM: D, storeys, baseY } = spec;
  if (storeys < 1) throw new Error(`building needs at least one storey, got ${storeys}`);
  if (W < 10 || D < 9) throw new Error(`building ${W}×${D} m is too small for a stairwell and two rooms`);
  const t = S.wallThicknessM;
  const q = spec.quarterTurns;
  const cos = [1, 0, -1, 0][q] as number;
  const sin = [0, 1, 0, -1][q] as number;
  // Local → world: rotate about Y by q·90° (same sense as box yaw), then translate.
  const wx = (lx: number, lz: number): number => spec.cx + cos * lx + sin * lz;
  const wz = (lx: number, lz: number): number => spec.cz - sin * lx + cos * lz;
  const swap = q % 2 === 1;
  const box = (look: BoxLook, lx: number, baseLocalY: number, lz: number, sx: number, sy: number, sz: number, blocksVision = true): void => {
    b.boxOnBase(look, wx(lx, lz), baseLocalY, wz(lx, lz), swap ? sz : sx, sy, swap ? sx : sz, 0, { interior: true, blocksVision });
  };
  const wall = (look: BoxLook, lx0: number, lz0: number, lx1: number, lz1: number, y: number, h: number, thick: number, openings: Opening[]): void => {
    b.wall(look, wx(lx0, lz0), wz(lx0, lz0), wx(lx1, lz1), wz(lx1, lz1), y, h, thick, openings, true);
  };

  const x0 = -W / 2;
  const x1 = W / 2;
  const z0 = -D / 2;
  const z1 = D / 2;
  // U-shaped stairwell along the inside of the +X wall: two lanes side by
  // side. Even storeys climb lane A toward +Z, odd storeys lane B toward -Z,
  // so each flight lands where the next one starts.
  const laneAX = x1 - t - S.stairWidthM / 2;
  const laneBX = laneAX - S.stairWidthM;
  const stairZ0 = z0 + t + 1.3; // 1.3 m landing against the back wall
  const stairRun = Math.round(S.storeyM / S.stairRiserM) * S.stairTreadM;
  const stairZ1 = stairZ0 + stairRun;
  const wellX0 = x1 - t - 2 * S.stairWidthM;
  const partitionZ = Math.min(z0 + D * 0.45, stairZ1 + 1.5);
  /** Hole above flight `s`, cut into the slab at level s + 1. */
  const holeFor = (s: number): Hole => {
    const laneX = s % 2 === 0 ? laneAX : laneBX;
    return { x0: laneX - S.stairWidthM / 2, x1: laneX + S.stairWidthM / 2, z0: stairZ0 - 0.1, z1: stairZ1 + 0.05 };
  };

  const windowsFor = (lengthM: number, groundFront: boolean, back: boolean): Opening[] => {
    const bays = Math.max(1, Math.floor(lengthM / BAY_M));
    const margin = (lengthM - bays * BAY_M) / 2;
    const out: Opening[] = [];
    const doorBay = Math.floor(bays / 2);
    for (let i = 0; i < bays; i++) {
      const bayStart = margin + i * BAY_M;
      if (groundFront && i === doorBay) {
        out.push({ startM: bayStart + (BAY_M - S.shopDoorWidthM) / 2, widthM: S.shopDoorWidthM, bottomM: 0, topM: S.doorHeightM + 0.3, glass: false });
      } else if (back && i === 0) {
        out.push({ startM: bayStart + (BAY_M - S.doorWidthM) / 2, widthM: S.doorWidthM, bottomM: 0, topM: S.doorHeightM, glass: false });
      } else if (groundFront) {
        // Shop window: low sill, tall glass.
        out.push({ startM: bayStart + 0.3, widthM: BAY_M - 0.6, bottomM: 0.5, topM: 2.6, glass: true });
      } else {
        out.push({ startM: bayStart + (BAY_M - S.windowWidthM) / 2, widthM: S.windowWidthM, bottomM: S.windowSillM, topM: S.windowHeadM, glass: true });
      }
    }
    return out;
  };

  for (let s = 0; s < storeys; s++) {
    const y = baseY + s * S.storeyM;
    const ground = s === 0;
    // Outer walls. Front (+Z) and back (-Z) run the full width; sides fit between.
    wall(spec.wallLook, x0, z1 - t / 2, x1, z1 - t / 2, y, S.storeyM, t, windowsFor(W, ground, false));
    wall(spec.wallLook, x1, z0 + t / 2, x0, z0 + t / 2, y, S.storeyM, t, windowsFor(W, false, ground));
    wall(spec.wallLook, x0 + t / 2, z0 + t, x0 + t / 2, z1 - t, y, S.storeyM, t, windowsFor(D - 2 * t, false, false));
    wall(spec.wallLook, x1 - t / 2, z1 - t, x1 - t / 2, z0 + t, y, S.storeyM, t, windowsFor(D - 2 * t, false, false));

    // Floor: a thin finish on the ground, a slab with the stair hole above.
    if (ground) {
      box(spec.floorLook, 0, y, 0, W - 2 * t, 0.04, D - 2 * t);
    } else {
      const hole = holeFor(s - 1);
      slabWithHole(box, spec.floorLook, x0 + t, x1 - t, z0 + t, z1 - t, hole, y - S.slabThicknessM);
      // Rail along the room side of the hole.
      box('metalDark', hole.x0 - 0.03, y, (hole.z0 + hole.z1) / 2, 0.05, 0.95, hole.z1 - hole.z0, false);
    }

    // Partition with a door (1.2 m on the ground floor so the AI nav fits through).
    const doorW = ground ? 1.2 : S.doorWidthM;
    const partLen = wellX0 - 0.4 - (x0 + t);
    const doorAt = Math.max(0.5, partLen * 0.5 - doorW / 2);
    wall('plaster', x0 + t, partitionZ, wellX0 - 0.4, partitionZ, y, S.storeyM, 0.12, [
      { startM: doorAt, widthM: doorW, bottomM: 0, topM: S.doorHeightM, glass: false },
    ]);

    // Stair flight up to the next floor (or the roof).
    const even = s % 2 === 0;
    const flight = stairFlightLocal(even ? laneAX : laneBX, even ? stairZ0 : stairZ1, even ? 1 : -1);
    for (const step of flight) box('concrete', step.x, y, step.z, S.stairWidthM, step.h, S.stairTreadM);

    // Two bulbs per storey, one per room, at ceiling height.
    const ceil = y + S.storeyM - S.slabThicknessM - 0.15;
    b.bulb(wx((x0 + wellX0) / 2, (z0 + partitionZ) / 2), ceil, wz((x0 + wellX0) / 2, (z0 + partitionZ) / 2), LOCAL_LIGHTS.interiorBulbCd);
    b.bulb(wx(0, (partitionZ + z1) / 2), ceil, wz(0, (partitionZ + z1) / 2), LOCAL_LIGHTS.interiorBulbCd);
  }

  // Roof slab with the last hole, a parapet round the edge.
  const roofY = baseY + storeys * S.storeyM;
  const roofHole = holeFor(storeys - 1);
  slabWithHole(box, 'roofTar', x0, x1, z0, z1, roofHole, roofY - S.slabThicknessM);
  box('metalDark', roofHole.x0 - 0.03, roofY, (roofHole.z0 + roofHole.z1) / 2, 0.05, 0.95, roofHole.z1 - roofHole.z0, false);
  box(spec.wallLook, 0, roofY, z1 - 0.15, W, PARAPET_M, 0.3);
  box(spec.wallLook, 0, roofY, z0 + 0.15, W, PARAPET_M, 0.3);
  box(spec.wallLook, x0 + 0.15, roofY, 0, 0.3, PARAPET_M, D - 0.6);
  box(spec.wallLook, x1 - 0.15, roofY, 0, 0.3, PARAPET_M, D - 0.6);

  const cornerA = new Vec3(wx(x0 + t, z0 + t), baseY, wz(x0 + t, z0 + t));
  const cornerB = new Vec3(wx(x1 - t, z1 - t), roofY, wz(x1 - t, z1 - t));
  b.interiors.push({
    min: new Vec3(Math.min(cornerA.x, cornerB.x), baseY, Math.min(cornerA.z, cornerB.z)),
    max: new Vec3(Math.max(cornerA.x, cornerB.x), roofY - S.slabThicknessM, Math.max(cornerA.z, cornerB.z)),
  });
}

interface Hole {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Solid step boxes for one storey-high flight starting at zStart, climbing along dirZ. */
function stairFlightLocal(x: number, zStart: number, dirZ: 1 | -1): { x: number; z: number; h: number }[] {
  const steps = Math.round(S.storeyM / S.stairRiserM);
  const riser = S.storeyM / steps;
  const out: { x: number; z: number; h: number }[] = [];
  for (let i = 0; i < steps; i++) out.push({ x, z: zStart + dirZ * (i + 0.5) * S.stairTreadM, h: (i + 1) * riser });
  return out;
}

type LocalBox = (look: BoxLook, lx: number, baseY: number, lz: number, sx: number, sy: number, sz: number, blocksVision?: boolean) => void;

/** A floor slab over [xa, xb] × [za, zb] with a rectangular hole cut out of it. */
function slabWithHole(box: LocalBox, look: BoxLook, xa: number, xb: number, za: number, zb: number, h: Hole, y: number): void {
  const th = S.slabThicknessM;
  const piece = (ax: number, bx: number, az: number, bz: number): void => {
    if (bx - ax > 0.01 && bz - az > 0.01) box(look, (ax + bx) / 2, y, (az + bz) / 2, bx - ax, th, bz - az);
  };
  piece(xa, h.x0, za, zb);
  piece(h.x1, xb, za, zb);
  piece(h.x0, h.x1, za, h.z0);
  piece(h.x0, h.x1, h.z1, zb);
}
