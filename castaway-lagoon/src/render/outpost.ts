import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { vec3 } from 'three/tsl';
import { BoxGeometry, type BufferGeometry, BufferAttribute, CylinderGeometry, Group, type Material, Mesh, MeshBasicNodeMaterial, PlaneGeometry, PointLight, SphereGeometry, TorusGeometry, Vector3 } from 'three/webgpu';
import { CAN_LOG, DOCK, FURNITURE, OUTPOST } from '../game/outpost.ts';
import { heightAt } from '../game/terrain.ts';
import { merge, rand, tube } from './meshkit.ts';
import { propMaterials } from './propMaterials.ts';
import { U } from './uniforms.ts';

// The survival outpost: a lean-to on a plank deck — log posts, a canvas tarp
// sagging between bamboo rafters, a lashed bamboo back wall, hides hung along
// the left side — with a table, a camp cot, a lantern and a fire pit outside.
// Built in the shelter's own frame from the same layout the colliders use
// (game/outpost.ts). Geometry is merged per material, so the whole shelter is
// a handful of draw calls. Pieces under the tarp carry `dry` = 1 so rain does
// not darken them.

type Bucket = Map<Material, BufferGeometry[]>;

export interface OutpostView {
  group: Group;
  dock: Group;
  lantern: PointLight;
  /**
   * The kerosene lamp itself — caps, glass, bail, flame and the lantern light — as one group,
   * so it can come off its hook and be carried (view.ts reparents and swings it).
   */
  lanternRig: Group;
  fire: PointLight;
  /** Where flames and embers rise from, world space. */
  firePos: Vector3;
  lanternPos: Vector3;
}

const GROUND_Y = -OUTPOST.deckHeightM; // shelter-local height of the clearing

export function buildOutpost(): OutpostView {
  const M = propMaterials();
  const dry: Bucket = new Map();
  const wet: Bucket = new Map();
  const put = (b: Bucket, m: Material, g: BufferGeometry): void => {
    const list = b.get(m) ?? [];
    list.push(g);
    b.set(m, list);
  };
  const log = (b: Bucket, a: Vector3, c: Vector3, r: number, seed: number): void => {
    const pts: Vector3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      pts.push(a.clone().lerp(c, t).add(new Vector3((rand(seed, i) - 0.5) * r * 0.4, 0, (rand(seed, i + 9) - 0.5) * r * 0.4)));
      radii.push(r * (1 - t * 0.12));
    }
    put(b, M.logBark, tube(pts, radii, 7, 0.8, true));
  };
  const board = (b: Bucket, m: Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, seed: number, yaw = 0): void => {
    const g = plankGeometry(sx, sy, sz);
    scaleUv(g, Math.max(sx, sz) / 1.6, rand(seed, 1));
    g.rotateY(yaw);
    g.translate(x, y, z);
    put(b, m, g);
  };
  /** Two nail heads across a board at (x, z) on its top face `y`, along the board's width (`yaw` as the board). */
  const nails = (b: Bucket, x: number, y: number, z: number, acrossM: number, yaw: number, seed: number): void => {
    for (const s of [-1, 1]) {
      const ox = (rand(seed, s + 7) - 0.5) * 0.02;
      const oz = s * acrossM * 0.28;
      put(b, M.rustyIron, nailHead().translate(x + ox * Math.cos(yaw) + oz * Math.sin(yaw), y, z - ox * Math.sin(yaw) + oz * Math.cos(yaw)));
    }
  };

  // ── Deck: log joists on stilts, planks across.
  const hx = OUTPOST.deckHalfX;
  const hz = OUTPOST.deckHalfZ;
  for (const z of [-hz + 0.25, 0, hz - 0.25]) {
    log(dry, new Vector3(-hx - 0.1, -0.13, z), new Vector3(hx + 0.1, -0.13, z), 0.09, Math.round(z * 10));
    for (const x of [-hx + 0.2, hx - 0.2]) log(wet, new Vector3(x, GROUND_Y - 0.3, z), new Vector3(x, -0.2, z), 0.08, Math.round(x * 7 + z));
  }
  const plankW = 0.19;
  for (let i = 0, z = -hz + plankW / 2; z < hz; i++, z += plankW + 0.012) {
    const x0 = (rand(i, 3) - 0.5) * 0.06;
    const y0 = -0.02 + (rand(i, 4) - 0.5) * 0.008;
    const yaw = (rand(i, 5) - 0.5) * 0.012;
    board(dry, i % 5 === 3 ? M.darkWood : M.planks, x0, y0, z, hx * 2 + 0.1, 0.04, plankW, i, yaw);
    // Nailed down over the stilts and the middle.
    for (const x of [-hx + 0.2, 0, hx - 0.2]) nails(dry, x, y0 + 0.02, z - (x - x0) * yaw, plankW, yaw, i * 3 + Math.round(x * 10));
  }

  // ── Frame: corner posts, beams, bamboo rafters.
  const fh = OUTPOST.frontPostHeightM;
  const bh = OUTPOST.backPostHeightM;
  const px = hx - 0.12;
  const pz = hz - 0.1;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) log(wet, new Vector3(sx * px, GROUND_Y - 0.4, sz * pz), new Vector3(sx * px, sz < 0 ? fh : bh, sz * pz), OUTPOST.postRadiusM, sx * 3 + sz);
    log(dry, new Vector3(sx * px, fh - 0.08, -pz - 0.05), new Vector3(sx * px, bh - 0.08, pz + 0.05), 0.055, sx * 11); // side beams
    // Rope lashings where the beams sit on the posts: there are no nails in a frame like this.
    for (const sz of [-1, 1]) {
      const top = sz < 0 ? fh : bh;
      for (let k = 0; k < 4; k++) {
        const g = new TorusGeometry(OUTPOST.postRadiusM + 0.02, 0.011, 5, 14).rotateX(Math.PI / 2 + (k % 2 ? 0.25 : -0.25)).translate(sx * px, top - 0.2 + k * 0.024, sz * pz);
        put(dry, M.rope, g);
      }
    }
  }
  log(dry, new Vector3(-px - 0.25, fh - 0.1, -pz), new Vector3(px + 0.25, fh - 0.1, -pz), 0.07, 21);
  log(dry, new Vector3(-px - 0.25, bh - 0.1, pz), new Vector3(px + 0.25, bh - 0.1, pz), 0.065, 22);
  const roofY = (z: number): number => fh + ((z + pz) / (2 * pz)) * (bh - fh);
  for (const x of [-px, -px / 3, px / 3, px]) {
    const g = new CylinderGeometry(0.035, 0.035, 2 * pz + 0.9, 7, 1, true);
    g.rotateX(Math.PI / 2 + Math.atan2(fh - bh, 2 * pz));
    g.translate(x, (fh + bh) / 2 + 0.02, 0);
    put(dry, M.bamboo, g);
  }

  // ── Tarp: sags between rafters, hangs over the front, flutters where it is loose.
  put(wet, M.tarp, tarpGeometry(px, pz, roofY));

  // ── Back wall: lashed bamboo.
  for (let x = -hx + 0.05; x <= hx - 0.04; x += 0.085) {
    const h = bh - 0.05 + (rand(Math.round(x * 100), 1) - 0.5) * 0.1;
    const g = new CylinderGeometry(0.038, 0.042, h + 0.3, 7, 1, false);
    g.translate(x, (h + 0.3) / 2 - 0.3, pz + 0.06);
    scaleUv(g, h / 0.9, rand(Math.round(x * 100), 2));
    put(dry, M.bamboo, g);
  }
  for (const y of [0.35, 1.2]) put(dry, M.rope, new CylinderGeometry(0.012, 0.012, hx * 2, 5, 1, true).rotateZ(Math.PI / 2).translate(0, y, pz + 0.01));

  // ── Hides along the left side, pinned to the side beam.
  FURNITURE.sideHides.forEach((h, i) => {
    const g = new PlaneGeometry(h.widthM, h.lengthM, 6, 8);
    wave(g, 0.03, i);
    g.rotateY(Math.PI / 2);
    const top = roofY(h.z) - 0.15;
    g.translate(-px - 0.06, top - h.lengthM / 2, h.z);
    put(dry, M.hides[i % M.hides.length] as Material, g);
  });

  // ── Table, stool, cot.
  const t = FURNITURE.table;
  // In the table's own frame (x along its length, z across), turned to the world by its yaw.
  const onTable = (ox: number, oz: number): [number, number] => [t.x + ox * Math.cos(t.yawRad) + oz * Math.sin(t.yawRad), t.z - ox * Math.sin(t.yawRad) + oz * Math.cos(t.yawRad)];
  const topW = t.sz / 5 - 0.008;
  for (let k = 0; k < 5; k++) {
    const oz = -t.sz / 2 + (k + 0.5) * (t.sz / 5);
    // Hand-made: each board a few millimetres proud or shy of the next.
    const y = t.heightM - 0.025 + (rand(40 + k, 6) - 0.5) * 0.004;
    const [bx, bz] = onTable((rand(40 + k, 7) - 0.5) * 0.03, oz);
    board(dry, M.planks, bx, y, bz, t.sx, 0.045, topW, 40 + k, t.yawRad + (rand(40 + k, 8) - 0.5) * 0.01);
    // Nailed to the battens under each end.
    for (const e of [-1, 1]) {
      const [nx, nz] = onTable(e * (t.sx / 2 - 0.09), oz);
      nails(dry, nx, y + 0.0225, nz, topW, t.yawRad, 90 + k * 2 + e);
    }
  }
  // Battens across under the ends, and a stretcher low between each end's legs, as a bush table is braced.
  for (const e of [-1, 1]) {
    const [bx, bz] = onTable(e * (t.sx / 2 - 0.09), 0);
    board(dry, M.darkWood, bx, t.heightM - 0.075, bz, 0.07, 0.05, t.sz - 0.06, 46 + e, t.yawRad);
    const [sx0, sz0] = onTable(e * (t.sx / 2 - 0.08), -(t.sz / 2 - 0.08));
    const [sx1, sz1] = onTable(e * (t.sx / 2 - 0.08), t.sz / 2 - 0.08);
    log(dry, new Vector3(sx0, 0.22, sz0), new Vector3(sx1, 0.24, sz1), 0.022, 56 + e);
  }
  // A shelf of three boards resting on the end stretchers, for whatever needs to be off the floor.
  for (let k = 0; k < 3; k++) {
    const oz = (k - 1) * 0.17;
    const [sx, sz] = onTable((rand(60 + k, 1) - 0.5) * 0.02, oz);
    board(dry, k === 1 ? M.darkWood : M.planks, sx, 0.262, sz, t.sx - 0.1, 0.03, 0.155, 60 + k, t.yawRad + (rand(60 + k, 2) - 0.5) * 0.02);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const [lx, lz] = onTable(sx * (t.sx / 2 - 0.08), sz * (t.sz / 2 - 0.08));
      log(dry, new Vector3(lx, 0, lz), new Vector3(lx, t.heightM - 0.05, lz), 0.035, 50 + sx * 2 + sz);
    }
  }
  const st = FURNITURE.stool;
  const stump = new CylinderGeometry(st.radiusM * 0.95, st.radiusM, st.heightM, 12, 1, true).translate(st.x, st.heightM / 2, st.z);
  put(dry, M.logBark, stump);
  put(dry, M.darkWood, new CylinderGeometry(st.radiusM * 0.95, st.radiusM * 0.95, 0.02, 12).translate(st.x, st.heightM, st.z));
  buildCot(dry, put);

  // ── Storage: jerry can and ammo box.
  const j = FURNITURE.jerryCan;
  board(dry, M.olivePaint, j.x, j.sy / 2, j.z, j.sx, j.sy, j.sz, 60, j.yawRad);
  board(dry, M.olivePaint, j.x, j.sy + 0.02, j.z - j.sz * 0.25, 0.03, 0.03, 0.12, 61, j.yawRad);
  const a = FURNITURE.ammoBox;
  board(dry, M.olivePaint, a.x, a.sy / 2, a.z, a.sx, a.sy, a.sz, 62, a.yawRad);

  // ── Outside: fire pit, drying rack, firewood, bucket, guy lines.
  const firePos = buildFirePit(wet, put);
  buildRack(wet, put);
  const fw = FURNITURE.firewood;
  for (let k = 0; k < 14; k++) {
    const row = Math.floor(k / 5);
    const x0 = fw.x - fw.sx / 2 + ((k % 5) + 0.5) * (fw.sx / 5) + row * 0.05;
    log(wet, new Vector3(x0, GROUND_Y + 0.08 + row * 0.15, fw.z - fw.sz / 2), new Vector3(x0 + 0.02, GROUND_Y + 0.08 + row * 0.15, fw.z + fw.sz / 2), 0.07, 70 + k);
  }
  const b = FURNITURE.bucket;
  put(wet, M.tin, new CylinderGeometry(0.15, 0.12, 0.28, 14, 1, true).translate(b.x, GROUND_Y + 0.14, b.z));
  put(wet, M.tin, new CylinderGeometry(0.12, 0.12, 0.01, 14).translate(b.x, GROUND_Y + 0.01, b.z));
  for (const sx of [-1, 1]) {
    const corner = new Vector3(sx * (px + 0.5), fh - 0.15, -pz - 0.55);
    const stake = new Vector3(sx * (px + 1.3), GROUND_Y, -pz - 1.6);
    put(wet, M.rope, tube([corner, stake], [0.008, 0.008], 4, 0.5));
    log(wet, stake.clone().add(new Vector3(0, -0.2, 0)), stake.clone().add(new Vector3(0, 0.15, 0)), 0.025, 80 + sx);
  }

  // ── Lantern hanging from the front beam.
  const L = FURNITURE.lantern;
  put(dry, M.steel, tube([new Vector3(L.x, fh - 0.15, L.z), new Vector3(L.x, L.y + 0.14, L.z)], [0.003, 0.003], 4, 0.5));
  const lanternRig = buildLantern();
  lanternRig.position.set(L.x, L.y, L.z);

  const group = new Group();
  group.name = 'outpost';
  for (const [bucket, isDry] of [
    [dry, 1],
    [wet, 0],
  ] as const) {
    for (const [mat, parts] of bucket) {
      const g = merge(parts, `outpost-${mat.name}`);
      markDry(g, isDry);
      if (mat === M.tarp) markFlap(g, px, pz);
      const mesh = new Mesh(g, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  const lantern = new PointLight(0xffb070, 0, 9, 2);
  lanternRig.add(lantern);
  const fire = new PointLight(0xff9048, 0, 14, 2);
  fire.position.copy(firePos).add(new Vector3(0, 0.45, 0));
  group.add(lanternRig, fire);
  group.position.set(OUTPOST.x, OUTPOST.groundY + OUTPOST.deckHeightM, OUTPOST.z);
  group.rotation.y = OUTPOST.yawRad;
  group.updateMatrixWorld(true);
  const toWorld = (v: Vector3): Vector3 => v.clone().applyMatrix4(group.matrixWorld);
  return { group, dock: buildDock(), lantern, lanternRig, fire, firePos: toWorld(firePos), lanternPos: toWorld(new Vector3(L.x, L.y, L.z)) };
}

/** The hurricane lamp around its own centre (the middle of the glass): caps, glass, wire bail, flame. */
function buildLantern(): Group {
  const M = propMaterials();
  const rig = new Group();
  rig.name = 'lantern';
  const part = (g: BufferGeometry, m: Material): Mesh => {
    markDry(g, 1);
    const mesh = new Mesh(g, m);
    rig.add(mesh);
    return mesh;
  };
  part(new CylinderGeometry(0.07, 0.085, 0.05, 12).translate(0, 0.1, 0), M.olivePaint);
  part(new CylinderGeometry(0.08, 0.08, 0.04, 12).translate(0, -0.1, 0), M.olivePaint);
  part(new TorusGeometry(0.075, 0.003, 4, 16, Math.PI).translate(0, 0.12, 0), M.steel);
  part(new CylinderGeometry(0.055, 0.055, 0.15, 14, 1, true), M.glass);
  // The flame: a small bright teardrop whose radiance follows the lamp (U.lampGlow, pre-exposed).
  const flameMat = new MeshBasicNodeMaterial({ name: 'lamp flame' });
  flameMat.colorNode = vec3(1, 0.62, 0.3).mul(U.lampGlow);
  const flame = part(new SphereGeometry(0.012, 8, 6).scale(1, 2.2, 1).translate(0, -0.02, 0), flameMat);
  flame.castShadow = false;
  return rig;
}

function tarpGeometry(px: number, pz: number, roofY: (z: number) => number): BufferGeometry {
  const w = px * 2 + 0.7;
  const d = pz * 2 + 1.0;
  const g = new PlaneGeometry(w, d, 28, 20);
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i) - 0.15;
    const between = Math.abs(Math.sin((Math.PI * (x + px)) / ((2 * px) / 3))); // sag between the four rafters
    const beyondFront = Math.max(0, -pz - z);
    const beyondSide = Math.max(0, Math.abs(x) - px);
    const y = roofY(Math.max(-pz, Math.min(pz, z))) + 0.06 - between * 0.09 - beyondFront * 0.55 - beyondSide * 0.8 - Math.max(0, z - pz) * 0.5;
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

/** Cloth looseness: 0 on rafters and beams, 1 at the free edges and mid-spans. */
function markFlap(g: BufferGeometry, px: number, pz: number): void {
  const pos = g.getAttribute('position');
  const flap = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const between = Math.abs(Math.sin((Math.PI * (x + px)) / ((2 * px) / 3)));
    const edge = Math.max(0, -pz - z) * 2 + Math.max(0, Math.abs(x) - px) * 2.5;
    flap[i] = Math.min(1.5, between * 0.5 + edge);
  }
  g.setAttribute('flap', new BufferAttribute(flap, 1));
}

export function markDry(g: BufferGeometry, value: number): void {
  const n = g.getAttribute('position').count;
  g.setAttribute('dry', new BufferAttribute(new Float32Array(n).fill(value), 1));
}

/**
 * A sawn board with its arrises eased: a rounded box with one bevel segment. A hard-edged box catches no
 * light along its edges, and in close-up the deck and the table read as flat slabs; the soft edge picks
 * up a highlight the way a worn board does.
 */
function plankGeometry(sx: number, sy: number, sz: number): BufferGeometry {
  return new RoundedBoxGeometry(sx, sy, sz, 1, Math.min(0.007, sy * 0.3));
}

/** A cut nail's head, centred on the board's top face: half driven in, a millimetre and a half proud. */
function nailHead(): BufferGeometry {
  return new CylinderGeometry(0.0055, 0.006, 0.003, 6);
}

/** Box UVs stretched to the board's length so the grain is not smeared; offset per board. */
function scaleUv(g: BufferGeometry, uScale: number, offset: number): void {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uScale + offset, uv.getY(i) * 0.25 + offset * 3);
}

function wave(g: BufferGeometry, amp: number, seed: number): void {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) + Math.sin(pos.getX(i) * 7 + seed) * amp + Math.sin(pos.getY(i) * 5 + seed * 2) * amp);
  g.computeVertexNormals();
}

type Put = (b: Bucket, m: Material, g: BufferGeometry) => void;

function buildCot(dry: Bucket, put: Put): void {
  const M = propMaterials();
  const c = FURNITURE.cot;
  const cos = Math.cos(c.yawRad);
  const sin = Math.sin(c.yawRad);
  const at = (lx: number, ly: number, lz: number): Vector3 => new Vector3(c.x + lx * cos + lz * sin, ly, c.z - lx * sin + lz * cos);
  const hw = c.sz / 2;
  const hl = c.sx / 2;
  for (const s of [-1, 1]) put(dry, M.darkWood, tube([at(-hl, c.heightM, s * hw), at(hl, c.heightM, s * hw)], [0.022, 0.022], 6, 0.6, true));
  for (const x of [-hl + 0.05, 0, hl - 0.05]) {
    put(dry, M.darkWood, tube([at(x - 0.02, 0, -hw), at(x + 0.02, c.heightM, hw)], [0.015, 0.015], 5, 0.5));
    put(dry, M.darkWood, tube([at(x + 0.02, 0, hw), at(x - 0.02, c.heightM, -hw)], [0.015, 0.015], 5, 0.5));
  }
  const bed = new PlaneGeometry(c.sx - 0.06, c.sz - 0.02, 18, 6);
  bed.rotateX(-Math.PI / 2);
  const pos = bed.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const sag = Math.cos((pos.getZ(i) / hw) * (Math.PI / 2)) * Math.cos((pos.getX(i) / hl) * (Math.PI / 2)) * 0.045;
    pos.setY(i, c.heightM + 0.01 - sag);
  }
  bed.computeVertexNormals();
  bed.rotateY(c.yawRad);
  bed.translate(c.x, 0, c.z);
  put(dry, M.cotCanvas, bed);
  // A rolled blanket at the head, a folded one at the foot, a rolled-shirt pillow.
  const roll = new CylinderGeometry(0.09, 0.09, c.sz - 0.12, 14).rotateX(Math.PI / 2);
  roll.rotateY(c.yawRad);
  const head = at(hl - 0.2, c.heightM + 0.08, 0);
  roll.translate(head.x, head.y, head.z);
  put(dry, M.blanket, roll);
  const folded = new BoxGeometry(0.4, 0.07, c.sz - 0.16);
  folded.rotateY(c.yawRad + 0.08);
  const foot = at(-hl + 0.3, c.heightM + 0.02, 0.02);
  folded.translate(foot.x, foot.y, foot.z);
  put(dry, M.blanket, folded);
}

function buildFirePit(wet: Bucket, put: Put): Vector3 {
  const M = propMaterials();
  const f = FURNITURE.firePit;
  const centre = new Vector3(f.x, GROUND_Y, f.z);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const s = new SphereGeometry(0.11 + rand(k, 1) * 0.05, 8, 6);
    s.scale(1.2, 0.7, 1);
    s.rotateY(a);
    s.translate(centre.x + Math.cos(a) * f.radiusM, centre.y + 0.03, centre.z + Math.sin(a) * f.radiusM);
    put(wet, M.charcoal, s);
  }
  put(wet, M.charcoal, new CylinderGeometry(f.radiusM * 0.85, f.radiusM * 0.9, 0.03, 16).translate(centre.x, centre.y + 0.01, centre.z));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.3;
    const d = new Vector3(Math.cos(a), 0, Math.sin(a));
    const g = tube([centre.clone().addScaledVector(d, 0.45).setY(centre.y + 0.05), centre.clone().addScaledVector(d, 0.05).setY(centre.y + 0.22)], [0.045, 0.035], 6, 0.5, true);
    put(wet, M.charcoal, g);
  }
  // Cooking tripod.
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    put(wet, M.logBark, tube([centre.clone().add(new Vector3(Math.cos(a) * 0.7, 0, Math.sin(a) * 0.7)), centre.clone().add(new Vector3(0, 1.15, 0))], [0.025, 0.02], 5, 0.5));
  }
  put(wet, M.tin, new CylinderGeometry(0.13, 0.11, 0.16, 14, 1, true).translate(centre.x, centre.y + 0.62, centre.z));
  put(wet, M.rope, tube([centre.clone().add(new Vector3(0, 1.13, 0)), centre.clone().add(new Vector3(0, 0.71, 0))], [0.004, 0.004], 4, 0.3));
  return centre;
}

function buildRack(wet: Bucket, put: Put): void {
  const M = propMaterials();
  const r = FURNITURE.dryingRack;
  const cos = Math.cos(r.yawRad);
  const sin = Math.sin(r.yawRad);
  const at = (lx: number, ly: number): Vector3 => new Vector3(r.x + lx * cos, GROUND_Y + ly, r.z - lx * sin);
  for (const s of [-1, 1]) put(wet, M.logBark, tube([at((s * r.widthM) / 2, -0.3), at((s * r.widthM) / 2, r.heightM)], [0.05, 0.04], 6, 0.6, true));
  put(wet, M.logBark, tube([at(-r.widthM / 2 - 0.1, r.heightM - 0.08), at(r.widthM / 2 + 0.1, r.heightM - 0.08)], [0.035, 0.035], 6, 0.6, true));
  put(wet, M.logBark, tube([at(-r.widthM / 2, 0.35), at(r.widthM / 2, 0.35)], [0.03, 0.03], 6, 0.6, true));
  const hide = new PlaneGeometry(r.widthM * 0.8, r.heightM * 0.7, 6, 6);
  wave(hide, 0.02, 7);
  hide.rotateY(r.yawRad);
  const c = at(0, r.heightM * 0.55);
  hide.translate(c.x, c.y, c.z);
  put(wet, M.hides[0] as Material, hide);
}

function buildDock(): Group {
  const M = propMaterials();
  const group = new Group();
  group.name = 'dock';
  const planks: BufferGeometry[] = [];
  const logs: BufferGeometry[] = [];
  const piles: BufferGeometry[] = [];
  const rope: BufferGeometry[] = [];
  const iron: BufferGeometry[] = [];
  const stringerX = DOCK.halfWidthM - 0.15;
  for (let i = 0, d = 0.1; d < DOCK.lengthM; i++, d += 0.2) {
    const w = DOCK.halfWidthM * 2 + (rand(i, 1) - 0.5) * 0.1;
    // Each board cups and twists a little as it dries: turned a few hundredths of a radian about its length.
    const g = plankGeometry(w, 0.045, 0.185).rotateX((rand(i, 5) - 0.5) * 0.03);
    scaleUv(g, 1.2, rand(i, 2));
    const x = (rand(i, 3) - 0.5) * 0.05;
    const y = DOCK.deckY - 0.022 + (rand(i, 4) - 0.5) * 0.01;
    g.translate(x, y, -d);
    planks.push(g);
    // Two nails into each stringer.
    for (const s of [-1, 1]) for (const k of [-1, 1]) iron.push(nailHead().translate(s * stringerX + (rand(i, s + 9) - 0.5) * 0.02, y + 0.0225, -d + k * 0.05));
  }
  const pileTops: Vector3[][] = [[], []];
  for (const s of [-1, 1]) {
    logs.push(tube([new Vector3(s * stringerX, DOCK.deckY - 0.12, 0.3), new Vector3(s * stringerX, DOCK.deckY - 0.12, -DOCK.lengthM)], [0.08, 0.08], 7, 0.8, true));
    for (let d = 1.2; d < DOCK.lengthM; d += DOCK.pileSpacingM) {
      const top = new Vector3(s * (DOCK.halfWidthM + 0.05), DOCK.deckY + 0.35, -d);
      piles.push(tube([top.clone().setY(-4), top], [0.12, 0.11], 8, 0.8, true));
      pileTops[s < 0 ? 0 : 1]?.push(top);
      // A lashing round the pile where the stringer is tied to it, and the rail rope's turns at the top.
      for (const [y, turns] of [
        [DOCK.deckY - 0.12, 3],
        [DOCK.deckY + 0.26, 2],
      ] as const) {
        for (let k = 0; k < turns; k++) rope.push(new TorusGeometry(0.125, 0.012, 5, 16).rotateX(Math.PI / 2).rotateZ((k - 1) * 0.12).translate(top.x, y + k * 0.026, top.z));
      }
    }
  }
  // Rope rails from pile to pile, sagging between them.
  for (const tops of pileTops) {
    for (let k = 0; k + 1 < tops.length; k++) {
      const a = tops[k] as Vector3;
      const b = tops[k + 1] as Vector3;
      const pts: Vector3[] = [];
      for (let j = 0; j <= 8; j++) {
        const u = j / 8;
        pts.push(a.clone().lerp(b, u).add(new Vector3(0, -0.09 - 4 * u * (1 - u) * 0.14, 0)));
      }
      rope.push(tube(pts, pts.map(() => 0.011), 5, 0.5));
    }
  }
  const end = -DOCK.lengthM + 0.3;
  rope.push(tube([new Vector3(-DOCK.halfWidthM - 0.05, DOCK.deckY + 0.3, end), new Vector3(-DOCK.halfWidthM - 0.35, 0.05, end - 1.4)], [0.012, 0.012], 5, 0.5));
  for (const [parts, mat] of [
    [planks, M.weatheredPlanks],
    [logs, M.logBark],
    [piles, M.piles],
    [rope, M.rope],
    [iron, M.rustyIron],
  ] as const) {
    const g = merge(parts, 'dock');
    markDry(g, 0);
    const mesh = new Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.position.set(DOCK.x, 0, DOCK.z);
  group.rotation.y = DOCK.yawRad;
  // Driftwood: the target-practice log, and two more washed up along the beach.
  const drift: BufferGeometry[] = [];
  const logAt = (x: number, z: number, yaw: number, len: number, r: number): void => {
    const d = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const y = heightAt(x, z) + r * 0.7;
    const g = tube([new Vector3(x, y, z).addScaledVector(d, -len / 2), new Vector3(x, y + 0.03, z), new Vector3(x, y, z).addScaledVector(d, len / 2)], [r, r * 1.05, r * 0.8], 9, 0.8, true);
    drift.push(g.translate(-DOCK.x, 0, -DOCK.z).rotateY(-DOCK.yawRad));
  };
  logAt(CAN_LOG.x, CAN_LOG.z, CAN_LOG.yawRad, CAN_LOG.lengthM, CAN_LOG.radiusM);
  logAt(-24, 2.5, 1.1, 3.2, 0.2);
  logAt(19, 1.2, -0.4, 2.1, 0.14);
  const dg = merge(drift, 'driftwood');
  markDry(dg, 0);
  const driftMesh = new Mesh(dg, M.logBark);
  driftMesh.castShadow = true;
  driftMesh.receiveShadow = true;
  group.add(driftMesh);
  return group;
}
