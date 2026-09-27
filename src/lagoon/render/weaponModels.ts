import { BoxGeometry, type BufferGeometry, CylinderGeometry, ExtrudeGeometry, Group, IcosahedronGeometry, type Material, Mesh, MeshStandardNodeMaterial, Shape, TorusGeometry, Vector3 } from 'three/webgpu';
import { tileFbm, tileNoise } from '../../core/noise.ts';
import { makeTextureSet } from '../../render/textures.ts';
import { merge, rand, tube } from './meshkit.ts';
import { hex } from './patterns.ts';

// The hand-held models: an AK-pattern rifle, a clip-point survival knife and
// a beach stone. Metres, facing −Z. The rifle's iron-sight line is y = 0 (rear
// notch at z = 0, front post at z ≈ −0.5), so aiming only moves the model
// until that line meets the eye. Proportions from public dimensions (overall
// ~0.88 m, barrel ~0.41 m); nothing here goes beyond shape and finish.

const woodSet = makeTextureSet(
  256,
  (u, v, t) => {
    const c = hex(0x7a3e22);
    const grain = tileFbm(u * 2, v * 24, 2, 4, 401);
    const figure = tileNoise(u * 8, v * 64, 8, 403);
    const wear = tileFbm(u * 4, v * 4, 4, 3, 405);
    const k = 0.75 + grain * 0.35 + figure * 0.08 + Math.max(0, wear - 0.65) * 0.6;
    t.r = c[0] * k;
    t.g = c[1] * k;
    t.b = c[2] * k;
    t.height = grain;
    t.rough = 0.4 + Math.max(0, wear - 0.6) * 0.8; // worn varnish goes matte
  },
  1.5,
);

export const WEAPON_MATERIALS = {
  // Blued / phosphated steel: a dark dielectric finish (PBR sheet: paint and phosphate are metal 0).
  receiver: new MeshStandardNodeMaterial({ name: 'ak receiver', color: 0x34363a, roughness: 0.4, metalness: 0 }),
  // Where the finish has worn through on the edges and the bolt carrier: bare steel.
  bare: new MeshStandardNodeMaterial({ name: 'ak bare steel', color: 0xb9b9b9, roughness: 0.3, metalness: 1 }),
  wood: new MeshStandardNodeMaterial({ name: 'ak wood', map: woodSet.map, normalMap: woodSet.normalMap, roughnessMap: woodSet.ormMap, roughness: 1, metalness: 0 }),
  blade: new MeshStandardNodeMaterial({ name: 'blade', color: 0xc4c6c8, roughness: 0.22, metalness: 1 }),
  guard: new MeshStandardNodeMaterial({ name: 'guard', color: 0x2a2a2c, roughness: 0.5, metalness: 0 }),
  cord: new MeshStandardNodeMaterial({ name: 'paracord', color: 0x3f4430, roughness: 0.95, metalness: 0 }),
  stone: new MeshStandardNodeMaterial({ name: 'stone', color: 0x8d877c, roughness: 0.7, metalness: 0 }),
  brass: new MeshStandardNodeMaterial({ name: 'brass', color: 0xe8cf8a, roughness: 0.3, metalness: 1 }),
} as const;

function mesh(g: BufferGeometry, m: Material, name: string): Mesh {
  const out = new Mesh(g, m);
  out.name = name;
  out.castShadow = true;
  out.receiveShadow = true;
  return out;
}

/** A box whose back (+Z) and front (−Z) faces have different heights and a vertical offset: stocks and grips. */
function taperBox(length: number, wBack: number, hBack: number, yBack: number, wFront: number, hFront: number, yFront: number): BufferGeometry {
  const g = new BoxGeometry(1, 1, length, 1, 1, 4);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getZ(i) / length + 0.5; // 0 front … 1 back
    const w = wFront + (wBack - wFront) * t;
    const h = hFront + (hBack - hFront) * t;
    const y = yFront + (yBack - yFront) * t;
    pos.setXYZ(i, pos.getX(i) * w, y + pos.getY(i) * h, pos.getZ(i));
  }
  g.computeVertexNormals();
  return g;
}

export interface RifleModel {
  root: Group;
  magazine: Mesh;
  chargingHandle: Mesh;
  /** Muzzle position in the model frame (flash origin). */
  muzzle: Vector3;
  /** Ejection port (shells fly from here). */
  port: Vector3;
  /** Distance behind the rear sight at which the eye sits when aimed. */
  eyeZ: number;
  /** Where the hands hold it, model frame. */
  gripRight: Vector3;
  gripLeft: Vector3;
}

export function buildRifle(): RifleModel {
  const W = WEAPON_MATERIALS;
  const root = new Group();
  root.name = 'ak';
  const bore = -0.047;
  const recTop = -0.03;
  const recBot = -0.096;
  // Receiver, dust cover, rear trunnion and sight block.
  const receiver = merge(
    [
      new BoxGeometry(0.036, recTop - recBot, 0.27).translate(0, (recTop + recBot) / 2, 0.075),
      new CylinderGeometry(0.018, 0.018, 0.25, 12, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).scale(1, 0.55, 1).translate(0, recTop, 0.08),
      new BoxGeometry(0.03, 0.03, 0.05).translate(0, recTop - 0.005, -0.075), // rear sight block
      new BoxGeometry(0.026, 0.012, 0.075).translate(0, -0.006, -0.05), // rear sight leaf
      new BoxGeometry(0.03, 0.035, 0.03).translate(0, bore + 0.01, -0.095), // front trunnion
      new BoxGeometry(0.03, 0.03, 0.035).translate(0, bore + 0.005, -0.41), // gas block
      new BoxGeometry(0.022, 0.035, 0.03).translate(0, bore + 0.012, -0.495), // front sight block
      new BoxGeometry(0.004, 0.03, 0.004).translate(0, -0.012, -0.5), // front post (tip at y ≈ 0)
      new TorusGeometry(0.011, 0.0025, 6, 12, Math.PI).translate(0, -0.006, -0.5), // post hood
      new BoxGeometry(0.004, 0.035, 0.09).translate(0.021, -0.07, 0.085), // selector lever
      tube([new Vector3(0, recBot, 0.09), new Vector3(0, recBot - 0.03, 0.08), new Vector3(0, recBot - 0.034, 0.03), new Vector3(0, recBot, 0.015)], [0.003, 0.003, 0.003, 0.003], 5, 0.2), // trigger guard
      new BoxGeometry(0.005, 0.02, 0.006).translate(0, recBot - 0.01, 0.055), // trigger
    ],
    'ak receiver',
  );
  root.add(mesh(receiver, W.receiver, 'receiver'));
  const barrel = merge(
    [
      new CylinderGeometry(0.0105, 0.0105, 0.23, 14).rotateX(Math.PI / 2).translate(0, bore, -0.4),
      new CylinderGeometry(0.0135, 0.0135, 0.055, 14).rotateX(Math.PI / 2).translate(0, bore, -0.54), // slant brake
      new CylinderGeometry(0.009, 0.009, 0.3, 12).rotateX(Math.PI / 2).translate(0, bore + 0.028, -0.26), // gas tube
    ],
    'ak barrel',
  );
  root.add(mesh(barrel, W.receiver, 'barrel'));
  // Laminated wood: stock, pistol grip, lower handguard, gas-tube cover.
  const wood = merge(
    [
      taperBox(0.26, 0.04, 0.13, -0.092, 0.034, 0.06, -0.064).translate(0, 0, 0.34),
      taperBox(0.1, 0.03, 0.036, -0.15, 0.03, 0.036, -0.12).rotateX(0.35).translate(0, 0, 0.135),
      new CylinderGeometry(0.024, 0.022, 0.2, 14).rotateX(Math.PI / 2).scale(1, 0.95, 1).translate(0, bore - 0.004, -0.205),
      new CylinderGeometry(0.017, 0.017, 0.16, 12).rotateX(Math.PI / 2).translate(0, bore + 0.03, -0.2),
    ],
    'ak wood',
  );
  root.add(mesh(wood, W.wood, 'furniture'));
  const butt = mesh(new BoxGeometry(0.041, 0.13, 0.008).translate(0, -0.093, 0.472), W.receiver, 'butt plate');
  root.add(butt);
  // Curved magazine: segments along an arc, sweeping forward as it drops.
  const segs: BufferGeometry[] = [];
  const n = 9;
  let y = 0;
  let z = 0;
  let a = 0.12;
  for (let i = 0; i < n; i++) {
    const len = 0.028;
    const g = new BoxGeometry(0.027, len + 0.002, 0.07 - i * 0.0015);
    g.rotateX(-a);
    g.translate(0, y - len / 2, z);
    segs.push(g);
    y -= Math.cos(a) * len;
    z -= Math.sin(a) * len;
    a += 0.07;
  }
  const magazine = mesh(merge(segs, 'ak magazine'), W.receiver, 'magazine');
  magazine.position.set(0, recBot + 0.01, -0.03);
  root.add(magazine);
  const chargingHandle = mesh(merge([new CylinderGeometry(0.004, 0.004, 0.025, 8).rotateZ(Math.PI / 2).translate(0.03, 0, 0), new CylinderGeometry(0.007, 0.007, 0.01, 10).rotateZ(Math.PI / 2).translate(0.045, 0, 0)], 'charging handle'), W.bare, 'charging handle');
  chargingHandle.position.set(0, -0.045, -0.02);
  root.add(chargingHandle);
  return {
    root,
    magazine,
    chargingHandle,
    muzzle: new Vector3(0, bore, -0.57),
    port: new Vector3(0.02, -0.04, 0.03),
    eyeZ: 0.33,
    gripRight: new Vector3(0, -0.14, 0.13),
    gripLeft: new Vector3(0, bore - 0.02, -0.2),
  };
}

export interface KnifeModel {
  root: Group;
  /** Blade tip, model frame. */
  tip: Vector3;
}

/** Clip-point survival knife, blade toward −Z, edge down, grip centred on the origin. */
export function buildKnife(): KnifeModel {
  const W = WEAPON_MATERIALS;
  const root = new Group();
  root.name = 'knife';
  const s = new Shape();
  s.moveTo(0, 0.016);
  s.lineTo(0.12, 0.016);
  s.lineTo(0.175, -0.002); // clipped spine down to the point
  s.quadraticCurveTo(0.15, -0.016, 0.1, -0.017);
  s.lineTo(0, -0.016);
  s.lineTo(0, 0.016);
  const blade = new ExtrudeGeometry(s, { depth: 0.002, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 1, curveSegments: 8 });
  blade.translate(0, 0, -0.001);
  blade.rotateY(Math.PI / 2); // +X → −Z
  blade.translate(0, 0, -0.07);
  root.add(mesh(blade, W.blade, 'blade'));
  root.add(mesh(new BoxGeometry(0.012, 0.055, 0.012).translate(0, 0, -0.065), W.guard, 'guard'));
  const wraps: BufferGeometry[] = [];
  for (let i = 0; i < 12; i++) wraps.push(new TorusGeometry(0.0135, 0.0035, 5, 12).translate(0, 0, 0).rotateY(0).translate(0, 0, -0.055 + i * 0.0095));
  wraps.push(new CylinderGeometry(0.012, 0.012, 0.115, 10).rotateX(Math.PI / 2).translate(0, 0, 0));
  root.add(mesh(merge(wraps, 'grip'), W.cord, 'grip'));
  root.add(mesh(new CylinderGeometry(0.014, 0.012, 0.015, 10).rotateX(Math.PI / 2).translate(0, 0, 0.065), W.guard, 'pommel'));
  return { root, tip: new Vector3(0, 0, -0.245) };
}

/** A smooth, slightly flattened beach pebble ~5–6 cm across. */
export function stoneGeometry(seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(0.028, 2);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const k = 1 + (rand(seed, i) - 0.5) * 0.12;
    pos.setXYZ(i, v.x * k * 1.15, v.y * k * 0.62, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** A spent 7.62 case, for the shell pool. */
export function shellGeometry(): BufferGeometry {
  return new CylinderGeometry(0.0055, 0.0056, 0.039, 8).rotateX(Math.PI / 2);
}
