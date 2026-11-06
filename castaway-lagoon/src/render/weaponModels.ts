import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxGeometry, BufferAttribute, type BufferGeometry, CylinderGeometry, ExtrudeGeometry, Group, IcosahedronGeometry, type Material, Mesh, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Shape, TorusGeometry, Vector3 } from 'three/webgpu';
import { tileFbm, tileFbmXY, tileNoiseXY } from '../core/noise.ts';
import { makeTextureSet } from './textureSet.ts';
import { arc, sectionPart, sidePart, steelMaterial, taperX, woodMaterial } from './gunkit.ts';
import { merge, rand, tube } from './meshkit.ts';
import { hex } from './patterns.ts';
import { modelKnife, modelRifle, rifleModelLoaded } from './rifleModel.ts';

// The hand-held models: an AK-pattern rifle, a clip-point survival knife and
// a beach stone. Metres, facing −Z. The rifle's iron-sight line is y = 0 (rear
// notch at z = 0, front post at z ≈ −0.5), so aiming only moves the model
// until that line meets the eye. Proportions from public dimensions (overall
// ~0.88 m, barrel ~0.41 m); nothing here goes beyond shape and finish.

const woodSet = makeTextureSet(
  256,
  (u, v, t) => {
    const c = hex(0x7a3e22);
    const grain = tileFbmXY(u * 2, v * 24, 2, 24, 4, 401);
    const figure = tileNoiseXY(u * 8, v * 64, 8, 64, 403);
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
  // AKM finish: a black phosphate-and-paint, worn to bright steel on the edges hands and slings rub.
  receiver: steelMaterial('ak receiver', [0.022, 0.022, 0.024], 1),
  // The barrel and gas tube: blued, smoother, worn less.
  barrel: steelMaterial('ak barrel', [0.018, 0.018, 0.02], 0.6, 0.42),
  // Where the finish is gone altogether (the bolt carrier and its handle): bare steel.
  bare: new MeshStandardNodeMaterial({ name: 'ak bare steel', color: 0xb9b9b9, roughness: 0.3, metalness: 1 }),
  wood: woodMaterial('ak wood', woodSet.map, [7, 3.5]),
  blade: new MeshStandardNodeMaterial({ name: 'blade', color: 0xc4c6c8, roughness: 0.22, metalness: 1 }),
  guard: new MeshStandardNodeMaterial({ name: 'guard', color: 0x2a2a2c, roughness: 0.5, metalness: 0 }),
  cord: new MeshStandardNodeMaterial({ name: 'paracord', color: 0x3f4430, roughness: 0.95, metalness: 0 }),
  stone: new MeshStandardNodeMaterial({ name: 'stone', color: 0x8d877c, roughness: 0.7, metalness: 0 }),
  brass: new MeshStandardNodeMaterial({ name: 'brass', color: 0xe8cf8a, roughness: 0.3, metalness: 1 }),
  // The red dot and its side mount: black anodised aluminium, and the objective's coated glass.
  optic: steelMaterial('optic', [0.02, 0.021, 0.023], 0.5, 0.38),
  glass: new MeshPhysicalNodeMaterial({ name: 'optic glass', color: 0xe6ebeb, roughness: 0.02, transparent: true, opacity: 0.12, ior: 1.52 }),
} as const;

function mesh(g: BufferGeometry, m: Material, name: string): Mesh {
  // The worn finishes read `edge` (gunkit.ts); a part built without bevels has none.
  if (!g.getAttribute('edge')) g.setAttribute('edge', new BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
  const out = new Mesh(g, m);
  out.name = name;
  out.castShadow = true;
  out.receiveShadow = true;
  return out;
}

/** Parts merged for one material: every part non-indexed with position, normal, uv and `edge` (0 where it has none). */
function parts(list: BufferGeometry[], name: string): BufferGeometry {
  const clean = list.map((g0) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const n = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2));
    if (!g.getAttribute('edge')) g.setAttribute('edge', new BufferAttribute(new Float32Array(n), 1));
    for (const key of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'edge'].includes(key)) g.deleteAttribute(key);
    g.clearGroups();
    return g;
  });
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error(`geometry merge failed for '${name}'`);
  return out;
}

/** A small part with rounded edges (sights, blocks, levers): a filleted rectangle in (z, y), bevelled. */
function block(w: number, h: number, d: number, x: number, y: number, z: number, r = 0.0015): BufferGeometry {
  return sidePart(
    [
      [z - d / 2, y - h / 2],
      [z + d / 2, y - h / 2],
      [z + d / 2, y + h / 2],
      [z - d / 2, y + h / 2],
    ],
    w,
    Math.min(r, w / 3),
    Math.min(r * 1.5, h / 3, d / 3),
    x,
    2,
  );
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
  /** The red dot's rear window (the collimated dot's material goes on it), when the rifle carries one. */
  dotLens: Mesh | null;
  /** Height of the sight line used to aim over the iron sights' (y = 0): the red dot's axis when fitted. */
  sightY: number;
}

/**
 * The magazine's side edges (local: its top centre at the origin, −Z forward): the 30-round curve, front
 * and back concentric about a centre ahead of it, the body narrowing a little toward the floor plate.
 * A point a fraction `f` of the way from the front edge to the back, `i` steps down.
 */
function magazineEdges(): { front: [number, number][]; back: [number, number][] } {
  const front: [number, number][] = [];
  const back: [number, number][] = [];
  const n = 10;
  const step = 0.2 / n;
  let z = 0;
  let y = 0;
  let a = 0.1;
  for (let i = 0; i <= n; i++) {
    const half = (0.066 - (i / n) * 0.01) / 2;
    // The curve's forward-pointing normal: the front edge leads, the back edge trails.
    front.push([z - Math.cos(a) * half, y + Math.sin(a) * half]);
    back.push([z + Math.cos(a) * half, y - Math.sin(a) * half]);
    z -= Math.sin(a) * step;
    y -= Math.cos(a) * step;
    a += 2.6 * step;
  }
  return { front, back };
}

/** The strip between fractions f0 and f1 of the way from the front edge to the back, over the whole length. */
function magazineBand(e: { front: [number, number][]; back: [number, number][] }, f0: number, f1: number): [number, number][] {
  const at = (i: number, f: number): [number, number] => {
    const p = e.front[i] as [number, number];
    const q = e.back[i] as [number, number];
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  };
  const n = e.front.length;
  const out: [number, number][] = [];
  // Counter-clockwise in (z, y): down the front side, up the back side.
  for (let i = 0; i < n; i++) out.push(at(i, f0));
  for (let i = n - 1; i >= 0; i--) out.push(at(i, f1));
  return out;
}

/**
 * The red dot on its side mount, added to a rifle's root (the procedural one or the model's: both share the
 * receiver's frame, the dust cover's top ~0.03 m under the sight line). Returns the window the dot is drawn on
 * and the optic's axis height over the irons.
 *
 * An open reflex sight, not a tube: a 30 mm tube this close to the eye filled a quarter of the hip view, and
 * from behind and to the side its open bore showed its far wall only, the near one culled, so it read as
 * a tube sawn in half. The reflex is a low body on the bridge, a hood round one window and the battery cap
 * on its right; the eye looks through the window over the irons.
 */
function addRedDot(root: Group): { dotLens: Mesh; sightY: number } {
  const W = WEAPON_MATERIALS;
  // A side mount: the rail on the receiver's left wall, a clamp arm rising from it and a bridge over the
  // dust cover, so the cover still comes off. (On an AK the optic cannot sit on the cover itself: it moves.)
  const DOT_Y = 0.04;
  const z0 = 0.08;
  // The window: 24 × 18 mm, its middle on the dot's axis, toward the front of the body.
  const winW = 0.024;
  const winH = 0.018;
  const winZ = z0 - 0.012;
  const mount = parts(
    [
      block(0.005, 0.016, 0.11, -0.0205, -0.062, 0.09, 0.001), // side rail
      block(0.008, 0.07, 0.07, -0.027, -0.03, z0, 0.002), // clamp arm
      new CylinderGeometry(0.006, 0.006, 0.012, 14).rotateZ(Math.PI / 2).translate(-0.034, -0.055, z0), // clamp knob
      block(0.036, 0.008, 0.07, -0.01, 0.007, z0, 0.0015), // bridge over the cover
      block(0.022, 0.012, 0.05, 0, 0.016, z0, 0.0015), // riser
      block(0.03, 0.009, 0.046, 0, 0.0265, z0, 0.002), // the sight's body, under the window
      // The hood: two posts and a top bar round the window, a little deeper than the glass.
      block(0.004, winH + 0.008, 0.014, -(winW / 2 + 0.002), DOT_Y + 0.001, winZ, 0.0012),
      block(0.004, winH + 0.008, 0.014, winW / 2 + 0.002, DOT_Y + 0.001, winZ, 0.0012),
      block(winW + 0.008, 0.004, 0.014, 0, DOT_Y + winH / 2 + 0.003, winZ, 0.0012),
      // The emitter's housing at the rear of the body, low (under the line of sight), and the battery cap.
      block(0.012, 0.004, 0.01, 0, 0.033, z0 + 0.016, 0.001),
      new CylinderGeometry(0.0065, 0.0065, 0.006, 16).rotateZ(Math.PI / 2).translate(0.018, 0.0265, z0 + 0.008),
    ],
    'ak red dot',
  );
  root.add(mesh(mount, W.optic, 'red dot'));
  const dotLens = new Mesh(new BoxGeometry(winW, winH, 0.0015), W.glass);
  dotLens.position.set(0, DOT_Y, winZ);
  root.add(dotLens);
  return { dotLens, sightY: DOT_Y };
}

/** `optic`: a red dot on a side mount over the receiver (the player's rifle; the guerrillas shoot irons). */
export function buildRifle(options: { optic?: boolean; procedural?: boolean } = {}): RifleModel {
  // The downloaded model when it loaded (rifleModel.ts), in this same frame and with the same handles;
  // `procedural` keeps the drawn one (the guerrillas' merged rifles, which tell wood from steel by part).
  if (rifleModelLoaded() && !options.procedural) {
    const r = modelRifle();
    const optic = options.optic ? addRedDot(r.root) : { dotLens: null, sightY: 0 };
    return { ...r, ...optic };
  }
  const W = WEAPON_MATERIALS;
  const root = new Group();
  root.name = 'ak';
  const bore = -0.047;
  const recTop = -0.03;
  const recBot = -0.096;
  const RW = 0.036; // receiver width

  // Receiver: the stamped box, its corners rounded, the dust cover on top with its stiffening ribs, the
  // rear sight block and leaf, the trunnions, the dimples over the magazine well, rivets, the trigger guard.
  const receiver = parts(
    [
      sidePart(
        [
          [-0.064, recBot],
          [0.205, recBot],
          [0.205, recTop - 0.004],
          [-0.064, recTop - 0.004],
        ],
        RW,
        0.0012,
        [0.004, 0.006, 0.003, 0.003],
      ),
      // Dust cover: half a rounded tube over the top, a hair wider than the box, its rear end squared.
      sectionPart(arc(0, recTop - 0.004, 0.0185, 0.011, 0, Math.PI, 12), -0.045, 0.207, 0.0012, 0.001),
      ...[0.17, 0.182, 0.194].map((z) => sectionPart(arc(0, recTop - 0.004, 0.0191, 0.0115, 0, Math.PI, 12), z - 0.002, z + 0.002, 0.0006, 0.0008)),
      block(0.03, 0.03, 0.05, 0, recTop - 0.004, -0.075, 0.002), // rear sight block
      block(0.024, 0.008, 0.075, 0, -0.004, -0.05, 0.0012), // rear sight leaf
      block(0.012, 0.01, 0.012, 0, -0.012, -0.03, 0.001), // its slide
      block(0.032, 0.036, 0.032, 0, bore + 0.01, -0.095, 0.002), // front trunnion
      block(0.03, 0.03, 0.035, 0, bore + 0.006, -0.41, 0.002), // gas block
      block(0.022, 0.036, 0.03, 0, bore + 0.012, -0.495, 0.002), // front sight block
      block(0.004, 0.03, 0.004, 0, -0.013, -0.5, 0.0008), // front post (tip at y ≈ 0)
      sectionPart(arc(0, -0.006, 0.011, 0.012, -0.15, Math.PI + 0.15, 10).concat(arc(0, -0.006, 0.0085, 0.0095, Math.PI + 0.15, -0.15, 10)), -0.508, -0.492, 0.0005, 0.0005), // post hood
      // Dimples pressed into the receiver over the magazine well (AKM), and the rivets.
      ...[-1, 1].map((sx) => block(0.002, 0.008, 0.02, sx * (RW / 2 + 0.0004), recBot + 0.022, -0.035, 0.0008)),
      ...[-0.052, -0.04, -0.028, 0.04, 0.188, 0.2].flatMap((z, i) => [-1, 1].map((sx) => new CylinderGeometry(0.0026, 0.0026, 0.002, 10).rotateZ(Math.PI / 2).translate(sx * (RW / 2 + 0.0005), recBot + (i % 2 ? 0.016 : 0.03), z))),
      tube([new Vector3(0, recBot, 0.09), new Vector3(0, recBot - 0.03, 0.08), new Vector3(0, recBot - 0.034, 0.03), new Vector3(0, recBot, 0.015)], [0.0032, 0.0032, 0.0032, 0.0032], 8, 0.2), // trigger guard
      block(0.005, 0.022, 0.006, 0, recBot - 0.01, 0.055, 0.001), // trigger
      // Selector: the long stamped lever on the right side, pivot at the back, finger tab at the front.
      sidePart(
        [
          [0.178, -0.044],
          [0.02, -0.058],
          [0.012, -0.074],
          [0.026, -0.078],
          [0.04, -0.066],
          [0.178, -0.054],
        ],
        0.0025,
        0.0007,
        0.003,
        RW / 2 + 0.0015,
        2,
      ),
      new CylinderGeometry(0.006, 0.006, 0.004, 14).rotateZ(Math.PI / 2).translate(RW / 2 + 0.002, -0.049, 0.172), // its pivot
    ],
    'ak receiver',
  );
  root.add(mesh(receiver, W.receiver, 'receiver'));

  const barrel = parts(
    [
      new CylinderGeometry(0.0105, 0.0105, 0.23, 18).rotateX(Math.PI / 2).translate(0, bore, -0.4),
      // Slant muzzle brake, the gas tube and its forward end, the bayonet lug and cleaning rod under it.
      new CylinderGeometry(0.0128, 0.0135, 0.052, 18).rotateX(Math.PI / 2).translate(0, bore, -0.541),
      new CylinderGeometry(0.009, 0.009, 0.3, 14).rotateX(Math.PI / 2).translate(0, bore + 0.028, -0.26),
      block(0.008, 0.012, 0.02, 0, bore - 0.017, -0.47, 0.001),
      new CylinderGeometry(0.003, 0.003, 0.36, 8).rotateX(Math.PI / 2).translate(0, bore - 0.018, -0.33),
    ],
    'ak barrel',
  );
  root.add(mesh(barrel, W.barrel, 'barrel'));

  // Laminated wood: the stock from its real side profile, swelling to the butt; the pistol grip with its
  // swell; the lower handguard with palm swells round the barrel; the gas-tube cover over it.
  const stock = taperX(
    sidePart(
      [
        [0.205, -0.094],
        [0.33, -0.121],
        [0.466, -0.155],
        [0.461, -0.028],
        [0.33, -0.031],
        [0.205, -0.036],
      ],
      0.042,
      0.004,
      [0.004, 0.02, 0.006, 0.006, 0.03, 0.004],
    ),
    (z) => 0.86 + Math.min(1, Math.max(0, (z - 0.2) / 0.26)) * 0.14,
  );
  const grip = sidePart(
    [
      [0.116, -0.096],
      [0.166, -0.096],
      [0.174, -0.13],
      [0.181, -0.172],
      [0.176, -0.204],
      [0.16, -0.214],
      [0.143, -0.211],
      [0.135, -0.186],
      [0.131, -0.16],
      [0.122, -0.128],
    ],
    0.03,
    0.0045,
    [0.002, 0.004, 0.01, 0.01, 0.01, 0.008, 0.008, 0.012, 0.012, 0.006],
  );
  const lower = taperX(
    sectionPart(arc(0, bore - 0.004, 0.0245, 0.023, Math.PI * 0.08, -Math.PI * 1.08, 14).concat(arc(0, bore - 0.004, 0.0165, 0.0155, -Math.PI * 1.08, Math.PI * 0.08, 14)), -0.305, -0.105, 0.003, 0.0015),
    (z) => 1 + 0.07 * Math.sin(Math.min(1, Math.max(0, (z + 0.29) / 0.17)) * Math.PI),
  );
  const upper = sectionPart(arc(0, bore + 0.028, 0.0185, 0.0165, -0.12, Math.PI + 0.12, 12).concat(arc(0, bore + 0.028, 0.0122, 0.0105, Math.PI + 0.12, -0.12, 12)), -0.28, -0.11, 0.0025, 0.0012);
  root.add(mesh(parts([stock, grip, lower, upper], 'ak wood'), W.wood, 'furniture'));
  const butt = mesh(
    parts(
      [
        sidePart(
          [
            [0.4655, -0.157],
            [0.4775, -0.159],
            [0.4715, -0.026],
            [0.4605, -0.026],
          ],
          0.0425,
          0.0015,
          0.004,
        ),
      ],
      'ak butt plate',
    ),
    W.receiver,
    'butt plate',
  );
  root.add(butt);

  // Curved steel magazine: its side outline, two ribs pressed along each side, the floor plate's lip.
  const edges = magazineEdges();
  const last = edges.front.length - 1;
  const fb = edges.front[last] as [number, number];
  const bb = edges.back[last] as [number, number];
  const floor: [number, number][] = [
    [fb[0] - 0.004, fb[1] + 0.004],
    [fb[0] - 0.004, fb[1] - 0.007],
    [bb[0] + 0.004, bb[1] - 0.007],
    [bb[0] + 0.004, bb[1] + 0.004],
  ];
  const magParts = [sidePart(magazineBand(edges, 0, 1), 0.027, 0.0015, 0.003), sidePart(floor, 0.031, 0.0015, 0.002)];
  for (const f of [0.28, 0.66]) for (const sx of [-1, 1]) magParts.push(sidePart(magazineBand(edges, f - 0.05, f + 0.05), 0.0016, 0.0005, 0.002, sx * 0.0142, 1));
  const magazine = mesh(parts(magParts, 'ak magazine'), W.receiver, 'magazine');
  magazine.position.set(0, recBot + 0.012, -0.028);
  root.add(magazine);
  const chargingHandle = mesh(parts([new CylinderGeometry(0.004, 0.004, 0.025, 10).rotateZ(Math.PI / 2).translate(0.03, 0, 0), new CylinderGeometry(0.007, 0.0065, 0.01, 14).rotateZ(Math.PI / 2).translate(0.045, 0, 0)], 'charging handle'), W.bare, 'charging handle');
  chargingHandle.position.set(0, -0.045, -0.02);
  root.add(chargingHandle);
  const optic = options.optic ? addRedDot(root) : { dotLens: null, sightY: 0 };
  const { dotLens, sightY } = optic;
  return {
    root,
    magazine,
    chargingHandle,
    dotLens,
    sightY,
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
  // The downloaded model when it loaded (rifleModel.ts), in this same frame.
  const model = modelKnife();
  if (model) return model;
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
