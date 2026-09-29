import type { SurfaceKind } from '../config.ts';
import type { Vec3 } from '../core/vec.ts';
import type { BoxSpec, Heightfield } from '../game/collision.ts';
import type { Lake } from './lake.ts';

// Pure map data. Built once by a map generator, then read by the collision
// world (logic) and by the render layer (visuals). No THREE in here.

export type MapId = 'range' | 'city' | 'forest';

/** Render look for a box. Several looks can share a surface kind. */
export type BoxLook =
  | 'brick'
  | 'brickDark'
  | 'concrete'
  | 'plaster'
  | 'woodFloor'
  | 'tiles'
  | 'glass'
  | 'roofTar'
  | 'metalDark'
  | 'wood'
  | 'kerb'
  | 'pavement'
  | 'facadeGlass'
  | 'stone'
  | 'sandbag'
  | 'targetSteel'
  | 'invisible';

export interface MapBox extends BoxSpec {
  look: BoxLook;
  /** Façade boxes get a procedural window pattern on their sides. */
  facade?: { storeyM: number; bayM: number; seed: number };
  interior?: boolean; // part of an enterable building's inside
}

export type PropKind =
  | 'car'
  | 'carWreck'
  | 'lampPost'
  | 'streetTree'
  | 'barrier'
  | 'container'
  | 'bench'
  | 'trashBin'
  | 'rock'
  | 'rangeSign'
  | 'hayBale'
  | 'beam'
  | 'crate'
  | 'dummy';

export interface MapProp {
  kind: PropKind;
  pos: Vec3;
  yawRad: number;
  scale: number;
  seed: number;
  colourIndex?: number;
  label?: string; // range distance signs
}

export interface TreeInstance {
  pos: Vec3;
  heightM: number;
  yawRad: number;
  seed: number;
}

export interface InteriorVolume {
  min: Vec3;
  max: Vec3;
}

export interface Bulb {
  pos: Vec3;
  intensityCd: number;
}

export interface Pickup {
  kind: 'medKit' | 'ammoPack' | 'grenade';
  pos: Vec3;
}

export interface SquadSpawn {
  pos: Vec3;
  patrol: Vec3[];
}

export interface RangeTarget {
  pos: Vec3; // centre of the plate
  sizeM: number;
  distanceM: number;
}

export interface MapData {
  id: MapId;
  label: string;
  halfSizeM: number; // playable square is [-half, half]²
  terrain: Heightfield;
  boxes: MapBox[];
  props: MapProp[];
  trees: TreeInstance[];
  bushes: TreeInstance[];
  roads: { a: Vec3; b: Vec3; widthM: number }[];
  track: Vec3[]; // forest dirt track polyline
  playerSpawn: { pos: Vec3; yawRad: number };
  squadSpawns: SquadSpawn[];
  reinforcementSpawns: Vec3[];
  interiors: InteriorVolume[];
  bulbs: Bulb[];
  pickups: Pickup[];
  extraction: { hold: Vec3; exit: Vec3 };
  rangeTargets: RangeTarget[];
  groundSurface: SurfaceKind;
  wetDefault: boolean;
  /** Where render-only undergrowth (grass tufts, bracken) grows; absent on maps without any. */
  undergrowth?: UndergrowthArea;
  /** A shallow lake carved into the terrain (maps/lake.ts). */
  lake?: Lake;
}

/** Rectangles as [minX, minZ, maxX, maxZ] in metres. */
export interface UndergrowthArea {
  bounds: [number, number, number, number];
  /** Kept short: firing lanes and yards, where tall grass would hide targets or look wrong. */
  mown: [number, number, number, number][];
  /** Bracken under and between the trees (forest only). */
  ferns: boolean;
}
