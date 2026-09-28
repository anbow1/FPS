import { type BufferGeometry, Group, InstancedMesh, type Material, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { Rng } from '../core/rng.ts';
import { GRAPHICS } from '../config.ts';
import { OUTPOST } from '../game/outpost.ts';
import { beachWidth, heightAt, normalAt, shoreDistance } from '../game/terrain.ts';
import type { LagoonWorld } from '../game/world.ts';
import { addSway, barkMaterial, leafMaterial, swayingSolid } from './foliageMaterials.ts';
import { pathWeight } from './ground.ts';
import { card, foldedStrip, merge, rand, tube } from './meshkit.ts';

// Everything under the canopy: ferns, broadleaf shrubs, banana plants, tall
// grass, small plants sprouting from the beach sand, and vines hanging from
// the trees at the jungle's edge. One InstancedMesh per plant variant (see addAll).

interface Placement {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  scale: number;
}

type Kind = 'fern' | 'shrub' | 'banana' | 'grass' | 'sprout' | 'vine';

function fernGeometry(fronds: number, lengthM: number, seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rand(seed, f) * 0.5;
    const elev = 1.05 - rand(seed, f + 50) * 0.7;
    const L = lengthM * (0.75 + rand(seed, f + 90) * 0.4);
    const h = new Vector3(Math.cos(a), 0, Math.sin(a));
    const spine: Vector3[] = [];
    const sides: Vector3[] = [];
    const hw: number[] = [];
    const fold: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const s = i / 6;
      spine.push(new Vector3(h.x * L * s * Math.cos(elev), 0.05 + L * s * Math.sin(elev) - L * 0.75 * s * s, h.z * L * s * Math.cos(elev)));
      sides.push(new Vector3(-h.z, 0, h.x));
      hw.push(L * 0.2);
      fold.push(0.25);
    }
    parts.push(foldedStrip(spine, sides, hw, fold, new Vector3(0, 0.1, 0), 0.4));
  }
  const g = merge(parts, 'fern');
  addSway(g, 0.02, (x, _y, z) => Math.min(1, Math.hypot(x, z) / lengthM));
  return g;
}

function shrubGeometry(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const centre = new Vector3(0, 0.65, 0);
  for (let c = 0; c < 14; c++) {
    const theta = rand(seed, c) * Math.PI * 2;
    const v = rand(seed, c + 30) * 1.3 - 0.3;
    const phi = Math.acos(Math.max(-1, Math.min(1, v)));
    const out = new Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    const g = card(1.1, 1.1);
    g.rotateX(-Math.PI / 2 - out.y * 0.8 + 0.3);
    g.rotateY(-theta - Math.PI / 2);
    g.translate(centre.x + out.x * 0.45, Math.max(0.1, centre.y + out.y * 0.35), centre.z + out.z * 0.45);
    parts.push(g);
  }
  const g = merge(parts, 'shrub');
  addSway(g, 0.03, () => 0.7);
  return g;
}

function bananaGeometry(seed: number): { stem: BufferGeometry; leaves: BufferGeometry } {
  const H = 1.4 + rand(seed, 1) * 0.8;
  const stem = tube([new Vector3(0, -0.1, 0), new Vector3(0.02, H * 0.5, 0), new Vector3(0, H, 0.02)], [0.13, 0.1, 0.07], 8, 0.8);
  addSway(stem, 0.04, () => 0, H);
  const parts: BufferGeometry[] = [];
  for (let l = 0; l < 7; l++) {
    const a = (l / 7) * Math.PI * 2 + rand(seed, l) * 0.6;
    const h = new Vector3(Math.cos(a), 0, Math.sin(a));
    const elev = 0.9 - rand(seed, l + 20) * 0.7;
    const L = 1.8 + rand(seed, l + 40) * 0.8;
    const spine: Vector3[] = [];
    const sides: Vector3[] = [];
    const hw: number[] = [];
    const fold: number[] = [];
    for (let i = 0; i <= 8; i++) {
      const s = i / 8;
      spine.push(new Vector3(h.x * L * s * Math.cos(elev), H + L * s * Math.sin(elev) - L * 0.55 * s * s, h.z * L * s * Math.cos(elev)));
      sides.push(new Vector3(-h.z, 0, h.x));
      hw.push(0.36);
      fold.push(0.18);
    }
    parts.push(foldedStrip(spine, sides, hw, fold, new Vector3(0, H, 0), 0.3));
  }
  const leaves = merge(parts, 'banana leaves');
  addSway(leaves, 0.04, (x, _y, z) => Math.min(1, Math.hypot(x, z) / 2), H);
  return { stem, leaves };
}

function grassGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const g = card(0.8, 0.62);
    g.rotateY((i * Math.PI) / 3);
    parts.push(g);
  }
  const g = merge(parts, 'grass');
  addSway(g, 0.2, (_x, y) => y * 1.5, 0.62);
  return g;
}

function sproutGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const g = card(0.22, 0.34);
    g.rotateX(-0.5);
    g.rotateY((i / 5) * Math.PI * 2);
    parts.push(g);
  }
  const g = merge(parts, 'sprout');
  addSway(g, 0.1, (_x, y) => y * 2, 0.3);
  return g;
}

function vineGeometry(seed: number): { rope: BufferGeometry; leaves: BufferGeometry } {
  const L = 6 + rand(seed, 3) * 5;
  const pts: Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new Vector3(Math.sin(t * 5 + seed) * 0.15, -L * t, Math.cos(t * 4) * 0.1));
  }
  const rope = tube(pts, pts.map(() => 0.025), 5, 0.5);
  const parts: BufferGeometry[] = [];
  for (let k = 0; k < 16; k++) {
    const t = rand(seed, k) * 0.9;
    const g = card(0.35, 0.35);
    g.rotateY(rand(seed, k + 50) * Math.PI * 2);
    g.translate(Math.sin(t * 5 + seed) * 0.15, -L * t - 0.15, Math.cos(t * 4) * 0.1);
    parts.push(g);
  }
  const leaves = merge(parts, 'vine leaves');
  // Vines hang: they swing from the top, so weight grows downward.
  const swing = (g: BufferGeometry): void => {
    addSway(g, 0, () => 0);
    const pos = g.getAttribute('position');
    const sway = g.getAttribute('sway');
    for (let i = 0; i < pos.count; i++) sway.setXY(i, (-pos.getY(i) / L) * 0.6, 0.4);
  };
  swing(rope);
  swing(leaves);
  return { rope, leaves };
}

export function buildUndergrowth(world: LagoonWorld, quality: 'high' | 'low'): Group {
  const group = new Group();
  group.name = 'undergrowth';
  const rng = new Rng(4242);
  const density = GRAPHICS.grassDensity[quality];
  const keepClear = world.interactables.map((i) => ({ x: i.pos.x, z: i.pos.z }));
  const clear = (x: number, z: number, r: number): boolean => {
    if (Math.hypot(x - OUTPOST.x, z - OUTPOST.z) < 5.5 + r) return false;
    if (pathWeight(x, z) > 0.1) return false;
    for (const k of keepClear) if (Math.abs(k.x - x) < r + 0.5 && Math.abs(k.z - z) < r + 0.5) return false;
    return true;
  };
  const lists: Record<Kind, Placement[]> = { fern: [], shrub: [], banana: [], grass: [], sprout: [], vine: [] };
  const n = { x: 0, y: 1, z: 0 };
  const scatter = (kind: Kind, count: number, test: (x: number, z: number, inland: number) => boolean, scale: [number, number], r: number): void => {
    for (let tries = 0; tries < count * 10 && lists[kind].length < count; tries++) {
      const x = rng.range(-150, 130);
      const z = rng.range(-210, 80);
      const inland = shoreDistance(x, z) - beachWidth(x, z);
      if (!test(x, z, inland)) continue;
      normalAt(x, z, n);
      if (n.y < 0.72 || !clear(x, z, r)) continue;
      lists[kind].push({ x, y: heightAt(x, z) - 0.05, z, yawRad: rng.range(0, Math.PI * 2), scale: rng.range(scale[0], scale[1]) });
    }
  };
  const nearBay = (x: number, z: number): boolean => Math.hypot(x + 10, z - 10) < 120 || Math.hypot(x, z + 58) < 150;
  scatter('fern', Math.round(1800 * density), (x, z, d) => d > 1 && d < 60 && nearBay(x, z), [0.8, 1.4], 0.6);
  scatter('shrub', Math.round(900 * density), (x, z, d) => d > 2 && d < 70 && nearBay(x, z), [0.8, 1.8], 0.9);
  scatter('banana', Math.round(160 * density), (x, z, d) => d > 1 && d < 25 && nearBay(x, z), [0.9, 1.3], 1.2);
  scatter('grass', Math.round(16000 * density), (x, z, d) => d > -1.5 && d < 16 && Math.hypot(x + 5, z - 5) < 110, [0.7, 1.5], 0.25);
  scatter('sprout', Math.round(700 * density), (_x, _z, d) => d > -9 && d < 0 && shoreDistanceOk(_x, _z), [0.6, 1.3], 0.2);
  // Vines hang from trees near the beach and the shelter.
  for (const t of world.trees) {
    if (lists.vine.length >= 40) break;
    const inland = shoreDistance(t.x, t.z) - beachWidth(t.x, t.z);
    if (inland > 25 || Math.hypot(t.x - OUTPOST.x, t.z - OUTPOST.z) > 90) continue;
    lists.vine.push({ x: t.x + Math.cos(t.yawRad) * t.heightM * 0.22, y: t.y + t.heightM * 0.72, z: t.z + Math.sin(t.yawRad) * t.heightM * 0.22, yawRad: t.yawRad, scale: t.heightM / 16 });
  }

  const fernMat = leafMaterial('fern');
  const shrubMat = leafMaterial('broadleaf');
  const bananaMat = leafMaterial('banana');
  const grassMat = leafMaterial('grass', false);
  const stemMat = swayingSolid(0x5b6a32, 0.7);
  const vineRope = barkMaterial('jungle');
  const variants = (kind: Kind, count: number, build: (seed: number) => [BufferGeometry, Material][], shadows: boolean): void => {
    const list = lists[kind];
    for (let v = 0; v < count; v++) {
      const subset = list.filter((_, i) => i % count === v);
      for (const [geo, mat] of build(v * 31 + 7)) addAll(group, geo, mat, subset, shadows);
    }
  };
  variants('fern', 3, (s) => [[fernGeometry(9, 1.2, s), fernMat]], quality === 'high');
  variants('shrub', 2, (s) => [[shrubGeometry(s), shrubMat]], quality === 'high');
  variants('banana', 2, (s) => {
    const b = bananaGeometry(s);
    return [
      [b.stem, stemMat],
      [b.leaves, bananaMat],
    ];
  }, true);
  variants('grass', 1, () => [[grassGeometry(), grassMat]], false);
  variants('sprout', 1, () => [[sproutGeometry(), fernMat]], false);
  variants('vine', 2, (s) => {
    const v = vineGeometry(s);
    return [
      [v.rope, vineRope],
      [v.leaves, shrubMat],
    ];
  }, true);
  return group;
}

function shoreDistanceOk(x: number, z: number): boolean {
  // Beach sprouts stay on dry sand, clear of the waterline.
  return shoreDistance(x, z) > 2.5;
}

/**
 * One InstancedMesh per plant variant over the whole bay. It used to be split
 * into 40 m chunks for frustum culling, but three r186 builds a shader per
 * InstancedMesh, so every chunk that first came into view mid-game compiled
 * its own (a stutter), and each cost a draw call per shadow cascade. The bay
 * is small enough to draw each plant kind in one call.
 */
function addAll(group: Group, geo: BufferGeometry, mat: Material, list: readonly Placement[], shadows: boolean): void {
  if (list.length === 0) return;
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const s = new Vector3();
  const pos = new Vector3();
  const mesh = new InstancedMesh(geo, mat, list.length);
  list.forEach((p, i) => {
    q.setFromAxisAngle(up, p.yawRad);
    m.compose(pos.set(p.x, p.y, p.z), q, s.setScalar(p.scale));
    mesh.setMatrixAt(i, m);
  });
  mesh.computeBoundingSphere();
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  group.add(mesh);
}
