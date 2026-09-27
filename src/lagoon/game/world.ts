import { Rng } from '../../core/rng.ts';
import { CollisionWorld } from './colliders.ts';
import type { P3 } from './events.ts';
import type { ItemId } from './items.ts';
import { CAN_LOG, DOCK, FURNITURE, OUTPOST, outpostToWorld } from './outpost.ts';
import { beachWidth, cliffiness, heightAt, ISLETS, LAGOON_CENTRE, normalAt, shoreDistance } from './terrain.ts';

// Deterministic layout of everything placed in the lagoon: trees, rocks,
// pick-ups, plants, the outpost's colliders. One seed → the same island. The
// render layer reads the same lists to build meshes.

export interface PalmInstance {
  x: number;
  y: number;
  z: number;
  heightM: number;
  leanRad: number;
  leanDirRad: number; // yaw the trunk leans toward
  seed: number;
}

export interface TreeInstance {
  x: number;
  y: number;
  z: number;
  heightM: number;
  yawRad: number;
  seed: number;
}

export interface RockInstance {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yawRad: number;
  seed: number;
  moss: number; // 0..1: jungle rocks are furred with moss, surf-washed ones are bare
}

export type InteractableKind = 'pickup' | 'harvest' | 'crate' | 'examine';

export interface Interactable {
  id: number;
  kind: InteractableKind;
  /** What the render layer draws: an item id, or a named prop. */
  model: string;
  item: ItemId | null;
  count: number;
  pos: P3;
  yawRad: number;
  radiusM: number;
  name: string;
  alive: boolean;
  seed: number;
  /** Crate lid 0 (shut) → 1 (open). */
  open: number;
  text: string;
}

export interface TinCan {
  id: number;
  pos: P3;
  vel: P3;
  spin: P3; // rad/s about x, y, z — visual only
  rot: P3;
  resting: boolean;
  /** Its place on the log, so it can be stood back up. */
  home: P3;
}

export interface LagoonWorld {
  collision: CollisionWorld;
  palms: PalmInstance[];
  trees: TreeInstance[];
  rocks: RockInstance[];
  interactables: Interactable[];
  cans: TinCan[];
  spawn: { pos: P3; yawRad: number };
}

const EXAMINE_TEXT = {
  journal:
    'Day 41. Rain again last night — the tarp held. Fish in the shallows at dawn, parrots at noon, the fire at dusk. Radio still dead. If anyone reads this: I went up the ridge to find higher ground for the antenna.',
  map: 'A hand-drawn map on waxed paper. The lagoon, the channel north, a cross marked on the ridge above the shelter, and a note: "fresh water — follow the stream".',
  radio: 'A field radio with a cracked case. The battery terminals are green with corrosion. It hisses faintly, then nothing.',
  photo: 'A sun-bleached photograph pinned to the bamboo: two people on a harbour wall, laughing. Written on the back: "Come home soon."',
  backpack: 'Worn canvas backpack, straps repaired with fishing line. Inside: a spare shirt, fishhooks in a tin, and a half-empty lighter.',
} as const;

export function buildWorld(seed: number): LagoonWorld {
  const rng = new Rng(seed);
  const collision = new CollisionWorld();
  const interactables: Interactable[] = [];
  let nextId = 1;
  const add = (partial: Omit<Interactable, 'id' | 'alive' | 'open' | 'seed' | 'text' | 'yawRad'> & { text?: string; yawRad?: number }): Interactable => {
    const it: Interactable = { id: nextId++, alive: true, open: 0, seed: rng.int(0, 1e6), text: partial.text ?? '', yawRad: partial.yawRad ?? rng.range(0, Math.PI * 2), ...partial };
    interactables.push(it);
    return it;
  };

  buildOutpostColliders(collision);
  buildDockColliders(collision);
  const occupied: { x: number; z: number; r: number }[] = [
    { x: OUTPOST.x, z: OUTPOST.z, r: 7.5 },
    { x: DOCK.x, z: DOCK.z - DOCK.lengthM / 2, r: 3 },
    { x: CAN_LOG.x, z: CAN_LOG.z, r: 2.5 },
  ];
  const free = (x: number, z: number, r: number): boolean => occupied.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + r);

  // Palms line the back of the beach and lean out over the water.
  const palms: PalmInstance[] = [];
  const placePalm = (x: number, z: number, lagoonward: boolean): void => {
    const y = heightAt(x, z);
    const toWaterRad = Math.atan2(LAGOON_CENTRE.x - x, LAGOON_CENTRE.z - z);
    const palm: PalmInstance = {
      x,
      y,
      z,
      heightM: rng.range(7, 13.5),
      leanRad: lagoonward ? rng.range(0.12, 0.42) : rng.range(0.02, 0.15),
      leanDirRad: lagoonward ? toWaterRad + rng.range(-0.5, 0.5) : rng.range(0, Math.PI * 2),
      seed: rng.int(0, 1e6),
    };
    palms.push(palm);
    occupied.push({ x, z, r: 1.2 });
    collision.add({ kind: 'cylinder', x, z, radiusM: 0.2, y0: y - 1, y1: y + palm.heightM * 0.9, surface: 'wood' });
    const crown = trunkTop(palm);
    collision.leaves.push({ kind: 'sphere', x: crown.x, y: crown.y, z: crown.z, radiusM: 3.2, surface: 'leaves' });
  };
  for (let tries = 0; tries < 4000 && palms.length < 70; tries++) {
    const x = rng.range(-95, 95);
    const z = rng.range(-150, 34);
    const d = shoreDistance(x, z);
    const bw = beachWidth(x, z);
    if (d < 1.5 || d > bw + 16 || heightAt(x, z) > 9) continue;
    const n = { x: 0, y: 1, z: 0 };
    normalAt(x, z, n);
    if (n.y < 0.8 || !free(x, z, 3.2)) continue;
    placePalm(x, z, d < bw + 4);
  }
  for (const islet of ISLETS) {
    for (let k = 0; k < 4; k++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, islet.radiusM * 0.45);
      const x = islet.x + Math.cos(a) * r;
      const z = islet.z + Math.sin(a) * r;
      if (heightAt(x, z) > 0.4 && free(x, z, 2)) placePalm(x, z, true);
    }
  }

  // Broadleaf jungle behind the beach and up the hills.
  const trees: TreeInstance[] = [];
  for (let tries = 0; tries < 9000 && trees.length < 420; tries++) {
    const x = rng.range(-190, 190);
    const z = rng.range(-240, 110);
    const d = shoreDistance(x, z);
    if (d < beachWidth(x, z) + 3 || Math.hypot(x - LAGOON_CENTRE.x, z - LAGOON_CENTRE.z) > 230) continue;
    const n = { x: 0, y: 1, z: 0 };
    normalAt(x, z, n);
    if (n.y < 0.62 || !free(x, z, 3.2)) continue;
    const y = heightAt(x, z);
    const tree: TreeInstance = { x, y, z, heightM: rng.range(9, 22), yawRad: rng.range(0, Math.PI * 2), seed: rng.int(0, 1e6) };
    trees.push(tree);
    occupied.push({ x, z, r: 2 });
    collision.add({ kind: 'cylinder', x, z, radiusM: 0.25 + tree.heightM * 0.012, y0: y - 1, y1: y + tree.heightM * 0.7, surface: 'wood' });
    collision.leaves.push({ kind: 'sphere', x, y: y + tree.heightM * 0.78, z, radiusM: tree.heightM * 0.3, surface: 'leaves' });
  }

  // Rocks: cliff-foot boulders in the surf, beach stones, mossy jungle rocks, islet rocks.
  const rocks: RockInstance[] = [];
  const placeRock = (x: number, z: number, size: number, sink: number, moss: number): void => {
    const sx = size * rng.range(0.8, 1.4);
    const sy = size * rng.range(0.5, 0.9);
    const sz = size * rng.range(0.8, 1.3);
    const y = heightAt(x, z) - sy * sink;
    rocks.push({ x, y, z, sx, sy, sz, yawRad: rng.range(0, Math.PI * 2), seed: rng.int(0, 1e6), moss });
    occupied.push({ x, z, r: Math.max(sx, sz) * 0.8 });
    const r = Math.min(sx, sy, sz) * 0.95;
    collision.add({ kind: 'sphere', x, y: y + sy * 0.1, z, radiusM: Math.max(sx, sz) * 0.85, surface: 'rock' });
    if (r > 1.6) collision.add({ kind: 'sphere', x, y: y + sy * 0.45, z, radiusM: r * 0.8, surface: 'rock' });
  };
  for (let tries = 0; tries < 6000 && rocks.length < 150; tries++) {
    const x = rng.range(-120, 120);
    const z = rng.range(-190, 40);
    const d = shoreDistance(x, z);
    const cliff = cliffiness(x, z);
    if (d > -12 && d < 6 && cliff > 0.45 && free(x, z, 2)) placeRock(x, z, rng.range(1.2, 4.2), 0.35, d > 1 ? 0.5 : 0.1);
    else if (d > 2 && d < 70 && rng.next() < 0.08 && free(x, z, 2)) placeRock(x, z, rng.range(0.6, 2.2), 0.4, 0.95);
    else if (d > -6 && d < 2 && cliff < 0.4 && rng.next() < 0.05 && free(x, z, 1.5)) placeRock(x, z, rng.range(0.45, 1.3), 0.3, 0.05);
  }
  for (const islet of ISLETS) {
    for (let k = 0; k < 6; k++) {
      const a = rng.range(0, Math.PI * 2);
      const r = islet.radiusM * rng.range(0.55, 1.05);
      placeRock(islet.x + Math.cos(a) * r, islet.z + Math.sin(a) * r, rng.range(1.2, 3.5), 0.3, 0.3);
    }
  }

  // Throwing stones scattered along the south beach near the waterline.
  let stones = 0;
  for (let tries = 0; tries < 3000 && stones < 34; tries++) {
    const x = rng.range(-40, 40);
    const z = rng.range(-12, 10);
    const d = shoreDistance(x, z);
    if (d < -0.8 || d > 7 || !free(x, z, 0.3)) continue;
    add({ kind: 'pickup', model: 'stone', item: 'stone', count: 1, pos: { x, y: heightAt(x, z), z }, radiusM: 0.2, name: 'Stone' });
    stones++;
  }

  // Coconuts under the palms.
  for (const p of palms.slice(0, 14)) {
    const a = rng.range(0, Math.PI * 2);
    const x = p.x + Math.cos(a) * rng.range(0.8, 2.2);
    const z = p.z + Math.sin(a) * rng.range(0.8, 2.2);
    if (heightAt(x, z) < 0.1) continue;
    add({ kind: 'pickup', model: 'coconut', item: 'coconut', count: 1, pos: { x, y: heightAt(x, z), z }, radiusM: 0.3, name: 'Coconut' });
  }

  // Harvestable plants at the jungle edge and along the paths.
  const plant = (model: 'herb' | 'hibiscus' | 'aloe', item: ItemId, name: string, count: number, minD: number, maxD: number): void => {
    let placed = 0;
    for (let tries = 0; tries < 3000 && placed < count; tries++) {
      const x = rng.range(-70, 60);
      const z = rng.range(-40, 36);
      const d = shoreDistance(x, z) - beachWidth(x, z);
      if (d < minD || d > maxD || Math.hypot(x - OUTPOST.x, z - OUTPOST.z) > 55 || !free(x, z, 1.2)) continue;
      const n = { x: 0, y: 1, z: 0 };
      normalAt(x, z, n);
      if (n.y < 0.85) continue;
      add({ kind: 'harvest', model, item, count: model === 'herb' ? 2 : 1, pos: { x, y: heightAt(x, z), z }, radiusM: 0.55, name });
      occupied.push({ x, z, r: 1 });
      placed++;
    }
  };
  plant('herb', 'herb', 'Jungle Herb', 10, -1, 12);
  plant('hibiscus', 'hibiscus', 'Hibiscus', 7, 0, 14);
  plant('aloe', 'aloe', 'Aloe Vera', 6, -4, 4);

  buildOutpostInteractables(add);
  const cans = buildCans(collision);

  return { collision, palms, trees, rocks, interactables, cans, spawn: { pos: { x: -4.5, y: heightAt(-4.5, 4), z: 4 }, yawRad: 0.18 } };
}

/** Where the crown sits: the trunk leans and curves back up a little toward the top. */
export function trunkTop(p: PalmInstance): P3 {
  const off = Math.sin(p.leanRad) * p.heightM * 0.8;
  return { x: p.x + Math.sin(p.leanDirRad) * off, y: p.y + Math.cos(p.leanRad) * p.heightM, z: p.z + Math.cos(p.leanDirRad) * off };
}

function buildOutpostColliders(c: CollisionWorld): void {
  const w = { x: 0, y: 0, z: 0 };
  const yaw = OUTPOST.yawRad;
  const box = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, surface: 'wood' | 'fabric' | 'metal', extraYaw = 0): void => {
    outpostToWorld(lx, ly, lz, w);
    c.add({ kind: 'box', x: w.x, y: w.y, z: w.z, hx: sx / 2, hy: sy / 2, hz: sz / 2, yawRad: yaw + extraYaw, surface });
  };
  // Deck: from below the ground to the floor top.
  box(0, -0.35, 0, OUTPOST.deckHalfX * 2, 0.7, OUTPOST.deckHalfZ * 2, 'wood');
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      outpostToWorld(sx * (OUTPOST.deckHalfX - 0.12), 0, sz * (OUTPOST.deckHalfZ - 0.1), w);
      c.add({ kind: 'cylinder', x: w.x, z: w.z, radiusM: OUTPOST.postRadiusM, y0: w.y - 0.5, y1: w.y + (sz < 0 ? OUTPOST.frontPostHeightM : OUTPOST.backPostHeightM), surface: 'wood' });
    }
  }
  box(0, 1, OUTPOST.deckHalfZ - 0.05, OUTPOST.deckHalfX * 2, 2, 0.1, 'wood'); // back wall
  box(-OUTPOST.deckHalfX + 0.05, 1.1, 0, 0.1, 1.6, OUTPOST.deckHalfZ * 1.6, 'fabric'); // hides on the left side
  const f = FURNITURE;
  box(f.table.x, f.table.heightM / 2, f.table.z, f.table.sx, f.table.heightM, f.table.sz, 'wood', f.table.yawRad);
  box(f.cot.x, f.cot.heightM / 2, f.cot.z, f.cot.sx, f.cot.heightM, f.cot.sz, 'fabric', f.cot.yawRad);
  box(f.crate.x, f.crate.sy / 2, f.crate.z, f.crate.sx, f.crate.sy, f.crate.sz, 'wood', f.crate.yawRad);
  box(f.jerryCan.x, f.jerryCan.sy / 2, f.jerryCan.z, f.jerryCan.sx, f.jerryCan.sy, f.jerryCan.sz, 'metal', f.jerryCan.yawRad);
  outpostToWorld(f.firewood.x, 0, f.firewood.z, w);
  c.add({ kind: 'box', x: w.x, y: OUTPOST.groundY + f.firewood.sy / 2, z: w.z, hx: f.firewood.sx / 2, hy: f.firewood.sy / 2, hz: f.firewood.sz / 2, yawRad: yaw + f.firewood.yawRad, surface: 'wood' });
  outpostToWorld(f.stool.x, 0, f.stool.z, w);
  c.add({ kind: 'cylinder', x: w.x, z: w.z, radiusM: f.stool.radiusM, y0: w.y - 0.2, y1: w.y + f.stool.heightM, surface: 'wood' });
  outpostToWorld(f.firePit.x, 0, f.firePit.z, w);
  c.add({ kind: 'cylinder', x: w.x, z: w.z, radiusM: f.firePit.radiusM, y0: heightAt(w.x, w.z) - 0.2, y1: heightAt(w.x, w.z) + 0.25, surface: 'rock' });
  outpostToWorld(f.dryingRack.x, 0, f.dryingRack.z, w);
  for (const s of [-1, 1]) {
    const px = w.x + Math.cos(yaw + f.dryingRack.yawRad) * s * f.dryingRack.widthM * 0.5;
    const pz = w.z - Math.sin(yaw + f.dryingRack.yawRad) * s * f.dryingRack.widthM * 0.5;
    c.add({ kind: 'cylinder', x: px, z: pz, radiusM: 0.05, y0: heightAt(px, pz) - 0.3, y1: heightAt(px, pz) + f.dryingRack.heightM, surface: 'wood' });
  }
}

function buildDockColliders(c: CollisionWorld): void {
  const cos = Math.cos(DOCK.yawRad);
  const sin = Math.sin(DOCK.yawRad);
  // The dock runs toward −Z from its landward end at (x, z).
  const cx = DOCK.x - sin * (DOCK.lengthM / 2);
  const cz = DOCK.z - cos * (DOCK.lengthM / 2);
  const deckThickness = 0.1;
  c.add({ kind: 'box', x: cx, y: DOCK.deckY - deckThickness / 2, z: cz, hx: DOCK.halfWidthM, hy: deckThickness / 2, hz: DOCK.lengthM / 2, yawRad: DOCK.yawRad, surface: 'wood' });
  for (let d = 1.2; d < DOCK.lengthM; d += DOCK.pileSpacingM) {
    for (const s of [-1, 1]) {
      const x = DOCK.x - sin * d + cos * s * (DOCK.halfWidthM + 0.05);
      const z = DOCK.z - cos * d - sin * s * (DOCK.halfWidthM + 0.05);
      c.add({ kind: 'cylinder', x, z, radiusM: 0.12, y0: heightAt(x, z) - 0.5, y1: DOCK.deckY + 0.35, surface: 'wood' });
    }
  }
}

type AddFn = (partial: Omit<Interactable, 'id' | 'alive' | 'open' | 'seed' | 'text' | 'yawRad'> & { text?: string; yawRad?: number }) => Interactable;

function buildOutpostInteractables(add: AddFn): void {
  const f = FURNITURE;
  const at = (lx: number, ly: number, lz: number): P3 => outpostToWorld(lx, ly, lz, { x: 0, y: 0, z: 0 });
  const yaw = OUTPOST.yawRad;
  add({ kind: 'pickup', model: 'rifle', item: 'rifle', count: 1, pos: at(f.cot.x - 0.15, f.cot.heightM + 0.04, f.cot.z - 0.05), yawRad: yaw + 0.12, radiusM: 0.45, name: 'AK-47' });
  add({ kind: 'pickup', model: 'knife', item: 'knife', count: 1, pos: at(f.table.x + 0.25, f.table.heightM, f.table.z + 0.05), yawRad: yaw + 0.7, radiusM: 0.2, name: 'Survival Knife' });
  add({ kind: 'crate', model: 'crate', item: null, count: 0, pos: at(f.crate.x, f.crate.sy, f.crate.z), yawRad: yaw + f.crate.yawRad, radiusM: 0.5, name: 'Supply Crate' });
  add({ kind: 'pickup', model: 'canteen', item: 'canteen', count: 1, pos: at(f.table.x - 0.42, f.table.heightM, f.table.z - 0.18), yawRad: yaw, radiusM: 0.16, name: 'Canteen' });
  add({ kind: 'pickup', model: 'rope', item: 'rope', count: 1, pos: at(OUTPOST.deckHalfX - 0.12, 1.25, -OUTPOST.deckHalfZ + 0.2), yawRad: yaw, radiusM: 0.22, name: 'Rope Coil' });
  add({ kind: 'examine', model: 'journal', item: null, count: 0, pos: at(f.cot.x + 0.62, f.cot.heightM + 0.02, f.cot.z + 0.12), yawRad: yaw + 0.3, radiusM: 0.16, name: 'Journal', text: EXAMINE_TEXT.journal });
  add({ kind: 'examine', model: 'map', item: null, count: 0, pos: at(f.table.x - 0.05, f.table.heightM + 0.004, f.table.z + 0.02), yawRad: yaw - 0.15, radiusM: 0.22, name: 'Hand-drawn Map', text: EXAMINE_TEXT.map });
  add({ kind: 'examine', model: 'radio', item: null, count: 0, pos: at(f.table.x - 0.4, f.table.heightM, f.table.z + 0.22), yawRad: yaw + 0.2, radiusM: 0.18, name: 'Field Radio', text: EXAMINE_TEXT.radio });
  add({ kind: 'examine', model: 'photo', item: null, count: 0, pos: at(0.55, 1.35, OUTPOST.deckHalfZ - 0.12), yawRad: yaw, radiusM: 0.14, name: 'Photograph', text: EXAMINE_TEXT.photo });
  add({ kind: 'examine', model: 'backpack', item: null, count: 0, pos: at(f.backpack.x, 0, f.backpack.z), yawRad: yaw + f.backpack.yawRad, radiusM: 0.35, name: 'Backpack', text: EXAMINE_TEXT.backpack });
}

/** Crate contents appear once the lid is up. */
export function crateContents(crate: Interactable): Omit<Interactable, 'id' | 'alive' | 'open' | 'seed' | 'text'>[] {
  const c = Math.cos(crate.yawRad);
  const s = Math.sin(crate.yawRad);
  const at = (lx: number, ly: number, lz: number): P3 => ({ x: crate.pos.x + lx * c + lz * s, y: crate.pos.y + ly, z: crate.pos.z - lx * s + lz * c });
  return [
    { kind: 'pickup', model: 'ammoBox', item: 'ammo762', count: 90, pos: at(-0.2, -0.3, 0), yawRad: crate.yawRad, radiusM: 0.18, name: '7.62 Ammo Box' },
    { kind: 'pickup', model: 'beans', item: 'beans', count: 2, pos: at(0.1, -0.33, -0.05), yawRad: crate.yawRad, radiusM: 0.12, name: 'Canned Beans' },
    { kind: 'pickup', model: 'flare', item: 'flare', count: 1, pos: at(0.28, -0.35, 0.08), yawRad: crate.yawRad + 0.4, radiusM: 0.12, name: 'Signal Flare' },
  ];
}

function buildCans(c: CollisionWorld): TinCan[] {
  const cans: TinCan[] = [];
  const ground = heightAt(CAN_LOG.x, CAN_LOG.z);
  const logTop = ground + CAN_LOG.radiusM * 1.7;
  const cos = Math.cos(CAN_LOG.yawRad);
  const sin = Math.sin(CAN_LOG.yawRad);
  c.add({ kind: 'box', x: CAN_LOG.x, y: ground + CAN_LOG.radiusM * 0.7, z: CAN_LOG.z, hx: CAN_LOG.lengthM / 2, hy: CAN_LOG.radiusM, hz: CAN_LOG.radiusM, yawRad: CAN_LOG.yawRad, surface: 'wood' });
  for (let i = 0; i < CAN_LOG.canCount; i++) {
    const t = (i / (CAN_LOG.canCount - 1) - 0.5) * CAN_LOG.lengthM * 0.75;
    const home = { x: CAN_LOG.x + cos * t, y: logTop + 0.06, z: CAN_LOG.z - sin * t };
    cans.push({ id: i, home, pos: { ...home }, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: i * 1.3, z: 0 }, resting: true });
  }
  return cans;
}
