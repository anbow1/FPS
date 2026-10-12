import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  type Material,
  Mesh,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Path,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three/webgpu';

// First-person weapon and hand models in metres, facing −Z, with the sight
// axis on the local origin's Y = 0 line so aiming down sights just moves the
// model until that line meets the eye. Invented designs of the usual layouts
// (gas carbine, bolt-action precision rifle, polymer pistol), no markings.
//
// What makes them read as real at 30 cm from the eye:
//   - side profiles extruded with a small bevel, so every edge catches a
//     highlight the way a machined or moulded edge does (boxes have none);
//   - the parts you see on the real thing: rail teeth, slotted handguard,
//     ports, levers, screws, a curved magazine, sight bells and turrets;
//   - holes drawn as near-black "cavity" parts, which reads as depth.
// Materials follow the sheet: parkerised and anodised metal (metal 0 — the
// finish is a dielectric coating), polymer furniture, rubber pads, bare
// steel only where it shows, brass on the grenade spoon.

export const VM_MATERIALS = {
  // Double-sided: optic and scope tubes are open cylinders you look straight through.
  parkerised: new MeshStandardNodeMaterial({ name: 'parkerised', color: 0x3c3c3e, roughness: 0.62, metalness: 0, side: DoubleSide }),
  // Hard-anodised aluminium (receivers, handguard): a touch lighter and smoother than phosphate.
  anodised: new MeshStandardNodeMaterial({ name: 'anodised', color: 0x343538, roughness: 0.48, metalness: 0, side: DoubleSide }),
  polymer: new MeshStandardNodeMaterial({ name: 'polymer', color: 0x2b2b2d, roughness: 0.75, metalness: 0 }),
  rubber: new MeshStandardNodeMaterial({ name: 'rubber', color: 0x1f1f21, roughness: 0.92, metalness: 0 }),
  cavity: new MeshStandardNodeMaterial({ name: 'cavity', color: 0x0c0c0d, roughness: 0.9, metalness: 0 }),
  steel: new MeshStandardNodeMaterial({ name: 'steel', color: 0xc6c6c8, roughness: 0.35, metalness: 1 }),
  glove: new MeshPhysicalNodeMaterial({ name: 'glove', color: 0x3e3328, roughness: 0.85, sheen: 0.3, sheenRoughness: 0.8, sheenColor: 0x3e3328 }),
  gloveLeather: new MeshPhysicalNodeMaterial({ name: 'gloveLeather', color: 0x2e2620, roughness: 0.6, sheen: 0.2, sheenRoughness: 0.6, sheenColor: 0x2e2620 }),
  sleeve: new MeshPhysicalNodeMaterial({ name: 'sleeve', color: 0x5a5e48, roughness: 0.9, sheen: 0.4, sheenRoughness: 0.8, sheenColor: 0x5a5e48 }),
  frag: new MeshStandardNodeMaterial({ name: 'frag', color: 0x4b5340, roughness: 0.7, metalness: 0 }),
  brass: new MeshStandardNodeMaterial({ name: 'brass', color: 0xf5e4ae, roughness: 0.25, metalness: 1 }),
  medkit: new MeshPhysicalNodeMaterial({ name: 'medkit', color: 0x6e2a24, roughness: 0.9, sheen: 0.3, sheenColor: 0x6e2a24 }),
  ammoPouch: new MeshPhysicalNodeMaterial({ name: 'ammoPouch', color: 0x5c5b3e, roughness: 0.9, sheen: 0.3, sheenColor: 0x5c5b3e }),
} as const;

// ------------------------------------------------------------------ geometry helpers

function merged(parts: BufferGeometry[]): BufferGeometry {
  const clean = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const key of Object.keys(n.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'uv') n.deleteAttribute(key);
    return n;
  });
  const g = mergeGeometries(clean, false);
  if (!g) throw new Error('weapon geometry merge failed');
  return g;
}

function mesh(g: BufferGeometry, m: Material, name: string): Mesh {
  const out = new Mesh(g, m);
  out.name = name;
  out.castShadow = false; // the player's own weapon casts no shadow into the world view
  out.receiveShadow = true;
  return out;
}

const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry => new BoxGeometry(sx, sy, sz).translate(x, y, z);
const rod = (r: number, len: number, seg = 12): CylinderGeometry => new CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2);

/**
 * A side profile, (z, y) points in the gun frame, extruded `widthM` across X and centred on x = 0, with
 * a bevel of `bevelM` on every edge. `holes` cut through it (a trigger guard's opening).
 */
function profile(points: readonly [number, number][], widthM: number, bevelM = 0.0012, holes: readonly (readonly [number, number][])[] = []): BufferGeometry {
  const shape = new Shape(points.map(([z, y]) => new Vector2(z, y)));
  for (const h of holes) shape.holes.push(new Path(h.map(([z, y]) => new Vector2(z, y))));
  const depth = Math.max(1e-4, widthM - 2 * bevelM);
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: bevelM > 0, bevelThickness: bevelM, bevelSize: bevelM, bevelSegments: 1, curveSegments: 4 });
  g.translate(0, 0, -depth / 2);
  // Shape x → gun z, extrusion → gun x.
  g.rotateY(-Math.PI / 2);
  return g;
}

/** Turned part along Z: (radius, z) points, revolved. */
function lathe(points: readonly [number, number][], seg = 20): BufferGeometry {
  return new LatheGeometry(
    points.map(([r, z]) => new Vector2(r, z)),
    seg,
  ).rotateX(Math.PI / 2);
}

/** Picatinny-style rail along Z at height `topY`: a base with cross-slot teeth every 10 mm. */
function rail(z0: number, z1: number, topY: number, widthM = 0.022): BufferGeometry {
  const parts: BufferGeometry[] = [box(widthM * 0.75, 0.006, z1 - z0, 0, topY - 0.007, (z0 + z1) / 2)];
  for (let z = z0 + 0.004; z < z1 - 0.003; z += 0.01) parts.push(box(widthM, 0.004, 0.0052, 0, topY - 0.002, z));
  return merged(parts);
}

// ------------------------------------------------------------------ carbine

export interface RifleModel {
  root: Group;
  magazine: Mesh;
  bolt: Mesh;
  /** Glass disc at the rear of the red dot tube; the dot is drawn on it. */
  dotLens: Mesh;
  /** Distance (m) from the model origin, along the sight line, at which the eye sits when aimed. */
  eyeZ: number;
}

/** 5.56 carbine with a tube red dot. Sight line: y = 0, the optic sits at z ≈ −0.05…0.07. */
export function buildRifle(): RifleModel {
  const root = new Group();
  root.name = 'rifle';
  const P = VM_MATERIALS;
  const railY = -0.042; // rail top
  const boreY = railY - 0.04;
  const recTop = railY - 0.007;
  const recBot = railY - 0.058;

  // Upper and lower receivers, handguard and rail: anodised aluminium.
  const upper = profile(
    [
      [0.19, recTop],
      [-0.07, recTop],
      [-0.07, recBot + 0.004],
      [-0.03, recBot],
      [0.19, recBot],
    ],
    0.03,
  );
  const lower = profile(
    [
      [0.19, recBot],
      [-0.03, recBot],
      [-0.036, railY - 0.106],
      [-0.031, railY - 0.112],
      [0.06, railY - 0.112],
      [0.066, railY - 0.084],
      [0.19, railY - 0.072],
    ],
    0.031,
  );
  const guard = profile(
    [
      [0.066, railY - 0.084],
      [0.066, railY - 0.104],
      [0.14, railY - 0.104],
      [0.15, railY - 0.084],
    ],
    0.011,
    0.001,
    [
      [
        [0.072, railY - 0.088],
        [0.072, railY - 0.099],
        [0.135, railY - 0.099],
        [0.142, railY - 0.088],
      ],
    ],
  );
  // Handguard: an eight-sided tube round the barrel, flat on top, carrying the rail forward.
  const hg = new CylinderGeometry(0.026, 0.026, 0.36, 8, 1, false).rotateY(Math.PI / 8).rotateX(Math.PI / 2).translate(0, boreY + 0.004, -0.25);
  const handguardRing = new CylinderGeometry(0.028, 0.028, 0.012, 8).rotateY(Math.PI / 8).rotateX(Math.PI / 2).translate(0, boreY + 0.004, -0.072);
  root.add(mesh(merged([upper, lower, guard, hg, handguardRing, rail(-0.43, 0.19, railY)]), P.anodised, 'receiver'));

  // Dark detail: ejection port, handguard slots, muzzle ports, the magwell mouth.
  const cavities: BufferGeometry[] = [box(0.002, 0.016, 0.06, 0.0155, railY - 0.032, 0.1), box(0.024, 0.004, 0.05, 0, railY - 0.113, 0.015)];
  for (let z = -0.1; z > -0.41; z -= 0.055) {
    for (const s of [-1, 1]) cavities.push(box(0.002, 0.008, 0.032, s * 0.0255, boreY + 0.004, z));
    cavities.push(box(0.008, 0.002, 0.032, 0, boreY + 0.004 - 0.0255, z));
  }
  for (let k = 0; k < 3; k++) cavities.push(box(0.004, 0.003, 0.009, 0, boreY + 0.0112, -0.578 - k * 0.012));
  root.add(mesh(merged(cavities), P.cavity, 'cavities'));

  // Barrel and muzzle device (steel, parkerised), buffer tube, forward assist, levers.
  const barrel = merged([
    lathe(
      [
        [0.0, -0.43],
        [0.0095, -0.43],
        [0.0095, -0.555],
        [0.0118, -0.556],
        [0.0118, -0.608],
        [0.0105, -0.612],
        [0.004, -0.612],
      ],
      16,
    ).translate(0, boreY, 0),
    rod(0.0155, 0.18, 16).translate(0, boreY + 0.008, 0.28),
    rod(0.0175, 0.012, 16).translate(0, boreY + 0.008, 0.196), // castle nut
    new CylinderGeometry(0.0065, 0.0065, 0.018, 12).rotateZ(Math.PI / 2).translate(0.021, railY - 0.022, 0.15), // forward assist
    box(0.003, 0.006, 0.02, -0.017, railY - 0.068, 0.155), // selector
    new CylinderGeometry(0.004, 0.004, 0.006, 10).rotateZ(Math.PI / 2).translate(0.018, railY - 0.075, 0.01), // magazine catch
    box(0.006, 0.012, 0.006, 0, railY - 0.078, 0.1), // trigger
    box(0.012, 0.012, 0.03, 0, railY + 0.008, -0.415), // folded front sight
    box(0.012, 0.01, 0.026, 0, railY + 0.007, 0.165), // folded rear sight
  ]);
  root.add(mesh(barrel, P.parkerised, 'barrel'));

  // Furniture: pistol grip, adjustable stock with its rubber pad, vertical grip.
  const grip = profile(
    [
      [0.132, railY - 0.078],
      [0.178, railY - 0.076],
      [0.19, railY - 0.084],
      [0.212, railY - 0.188],
      [0.2, railY - 0.196],
      [0.168, railY - 0.193],
      [0.16, railY - 0.168],
      [0.152, railY - 0.148],
      [0.15, railY - 0.128],
      [0.142, railY - 0.106],
    ],
    0.031,
    0.003,
  );
  const stock = profile(
    [
      [0.255, boreY + 0.03],
      [0.4, boreY + 0.034],
      [0.428, boreY + 0.03],
      [0.432, boreY - 0.074],
      [0.408, boreY - 0.08],
      [0.33, boreY - 0.028],
      [0.255, boreY - 0.02],
    ],
    0.042,
    0.004,
  );
  const vgrip = merged([new CylinderGeometry(0.0135, 0.0155, 0.07, 14).translate(0, boreY - 0.06, -0.28), box(0.02, 0.008, 0.04, 0, boreY - 0.027, -0.28)]);
  root.add(mesh(merged([grip, stock, vgrip]), P.polymer, 'furniture'));
  root.add(mesh(box(0.044, 0.112, 0.012, 0, boreY - 0.025, 0.437), P.rubber, 'butt pad'));

  // Curved polymer magazine with stiffening ribs and a wider base plate. The mesh sits at the magwell,
  // the geometry hangs below it (reloads move the mesh).
  const magazine = mesh(
    merged([
      profile(
        [
          [-0.031, 0.006],
          [0.031, 0.006],
          [0.024, -0.06],
          [0.006, -0.12],
          [-0.012, -0.165],
          [-0.058, -0.162],
          [-0.044, -0.11],
          [-0.034, -0.05],
        ],
        0.024,
        0.0015,
      ),
      box(0.027, 0.012, 0.052, 0, -0.17, -0.034).rotateX(0.38),
      box(0.026, 0.004, 0.04, 0, -0.03, -0.006),
      box(0.026, 0.004, 0.04, 0, -0.06, -0.012),
    ]),
    P.polymer,
    'magazine',
  );
  magazine.position.set(0, railY - 0.1, -0.02);
  root.add(magazine);
  const bolt = mesh(merged([box(0.042, 0.007, 0.012, 0, 0, 0), box(0.012, 0.006, 0.03, 0, 0, -0.016)]), P.parkerised, 'charging handle');
  bolt.position.set(0, railY - 0.012, 0.192);
  root.add(bolt);

  // Red dot: a 30 mm tube with a sunshade, windage and elevation turrets, on a riser with a cross-bolt.
  const optic = merged([
    lathe(
      [
        [0.0205, -0.055],
        [0.0205, -0.035],
        [0.018, -0.028],
        [0.018, 0.04],
        [0.0195, 0.046],
        [0.0195, 0.052],
      ],
      24,
    ),
    rod(0.0085, 0.016, 14).rotateX(Math.PI / 2).translate(0, 0.024, 0.005), // elevation turret
    rod(0.0085, 0.016, 14).rotateY(Math.PI / 2).translate(0.024, 0, 0.005), // windage turret
    box(0.022, 0.016, 0.05, 0, -0.022, 0.005), // riser
    box(0.026, 0.008, 0.044, 0, railY + 0.006, 0.005), // clamp
    new CylinderGeometry(0.0035, 0.0035, 0.032, 8).rotateZ(Math.PI / 2).translate(0, railY + 0.004, -0.008), // cross-bolt
    box(0.004, 0.012, 0.022, -0.016, railY + 0.008, 0.012), // throw lever
  ]);
  root.add(mesh(optic, P.anodised, 'optic'));
  const lensGeo = new CylinderGeometry(0.0165, 0.0165, 0.002, 24).rotateX(Math.PI / 2);
  const front = mesh(lensGeo, new MeshPhysicalNodeMaterial({ color: 0xe6ebeb, roughness: 0.02, transparent: true, opacity: 0.12, ior: 1.52 }), 'optic front');
  front.position.set(0, 0, -0.05);
  root.add(front);
  const dotLens = mesh(lensGeo, new MeshStandardNodeMaterial(), 'optic rear');
  dotLens.position.set(0, 0, 0.05);
  root.add(dotLens);
  return { root, magazine, bolt, dotLens, eyeZ: 0.05 + 0.2 };
}

// ------------------------------------------------------------------ precision rifle

export interface SniperModel {
  root: Group;
  magazine: Mesh;
  bolt: Group;
  /** Ocular lens: shows the scope's render target. */
  ocular: Mesh;
  eyeZ: number;
  ocularRadiusM: number;
}

/** Bolt-action magnum rifle with a variable scope. Sight line y = 0; ocular at z = +0.12. */
export function buildSniper(): SniperModel {
  const root = new Group();
  root.name = 'sniper';
  const P = VM_MATERIALS;
  const boreY = -0.065; // scope height over bore, matches the round's sight height

  // Stock: forend, action bed, vertical grip, raised comb and a long butt, in one moulded profile.
  const stock = profile(
    [
      [-0.45, boreY - 0.045],
      [-0.45, boreY - 0.012],
      [0.13, boreY - 0.012],
      [0.165, boreY - 0.03],
      [0.24, boreY - 0.004],
      [0.46, boreY + 0.008],
      [0.476, boreY + 0.002],
      [0.476, boreY - 0.115],
      [0.44, boreY - 0.12],
      [0.27, boreY - 0.07],
      [0.252, boreY - 0.078],
      [0.238, boreY - 0.15],
      [0.198, boreY - 0.152],
      [0.178, boreY - 0.07],
      [0.12, boreY - 0.058],
      [-0.06, boreY - 0.058],
      [-0.12, boreY - 0.05],
    ],
    0.05,
    0.004,
  );
  const cheek = box(0.036, 0.012, 0.15, 0, boreY + 0.012, 0.36);
  root.add(mesh(merged([stock, cheek]), P.polymer, 'stock'));
  root.add(mesh(box(0.052, 0.118, 0.014, 0, boreY - 0.057, 0.483), P.rubber, 'butt pad'));

  // Action, heavy fluted barrel, muzzle brake, scope base, trigger guard, bipod folded under the forend.
  const action = merged([
    rod(0.017, 0.24, 20).translate(0, boreY, 0.05),
    lathe(
      [
        [0.017, 0.17],
        [0.014, 0.19],
        [0.009, 0.2],
        [0.0, 0.2],
      ],
      16,
    ).translate(0, boreY, 0),
    lathe(
      [
        [0.0, -0.07],
        [0.0135, -0.07],
        [0.0135, -0.6],
        [0.0115, -0.62],
        [0.0115, -0.85],
        [0.0175, -0.852],
        [0.0175, -0.93],
        [0.012, -0.932],
        [0.0, -0.932],
      ],
      18,
    ).translate(0, boreY, 0),
    rail(-0.07, 0.17, boreY + 0.03, 0.02),
    profile(
      [
        [0.07, boreY - 0.058],
        [0.07, boreY - 0.085],
        [0.15, boreY - 0.085],
        [0.17, boreY - 0.058],
      ],
      0.012,
      0.001,
      [
        [
          [0.077, boreY - 0.062],
          [0.077, boreY - 0.079],
          [0.143, boreY - 0.079],
          [0.158, boreY - 0.062],
        ],
      ],
    ),
    box(0.006, 0.016, 0.006, 0, boreY - 0.068, 0.11), // trigger
    box(0.012, 0.03, 0.03, 0, boreY - 0.06, -0.4), // bipod head
    box(0.01, 0.01, 0.2, -0.01, boreY - 0.068, -0.29), // folded legs
    box(0.01, 0.01, 0.2, 0.01, boreY - 0.068, -0.29),
  ]);
  root.add(mesh(action, P.parkerised, 'action'));
  const flutes: BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    flutes.push(box(0.0035, 0.002, 0.2, 0, 0.0122, -0.73).rotateZ(a).translate(0, boreY, 0));
  }
  for (let k = 0; k < 4; k++) for (const s of [-1, 1]) flutes.push(box(0.002, 0.008, 0.011, s * 0.0176, boreY, -0.868 - k * 0.017));
  root.add(mesh(merged(flutes), P.cavity, 'flutes'));

  const magazine = mesh(merged([box(0.03, 0.06, 0.09, 0, 0, 0), box(0.034, 0.008, 0.094, 0, -0.03, 0)]), P.parkerised, 'magazine');
  magazine.position.set(0, boreY - 0.06, 0.02);
  root.add(magazine);
  const bolt = new Group();
  bolt.add(mesh(new CylinderGeometry(0.004, 0.0045, 0.06, 10).rotateZ(Math.PI / 2).translate(0.03, 0, 0), P.steel, 'bolt handle'));
  bolt.add(mesh(new SphereGeometry(0.0095, 14, 10).scale(1, 1, 1.15).translate(0.062, 0, 0), P.polymer, 'bolt knob'));
  bolt.position.set(0.012, boreY, 0.13);
  root.add(bolt);

  // Scope: 30 mm tube, 50 mm objective bell, 40 mm ocular with its focus ring, turret saddle, rings.
  const scope = merged([
    lathe(
      [
        [0.026, -0.215],
        [0.028, -0.208],
        [0.028, -0.17],
        [0.016, -0.135],
        [0.015, -0.13],
        [0.015, 0.06],
        [0.017, 0.07],
        [0.02, 0.1],
        [0.021, 0.115],
        [0.0215, 0.12],
        [0.0215, 0.148],
        [0.0205, 0.15],
      ],
      28,
    ),
    box(0.034, 0.03, 0.05, 0, 0, -0.02), // saddle
    new CylinderGeometry(0.012, 0.012, 0.022, 18).translate(0, 0.026, -0.02), // elevation
    new CylinderGeometry(0.0125, 0.0125, 0.006, 18).translate(0, 0.039, -0.02),
    new CylinderGeometry(0.011, 0.011, 0.02, 18).rotateZ(Math.PI / 2).translate(0.026, 0, -0.02), // windage
    new CylinderGeometry(0.008, 0.008, 0.016, 14).rotateZ(Math.PI / 2).translate(-0.024, 0, -0.02), // parallax
    new TorusGeometry(0.017, 0.004, 6, 20).translate(0, 0, -0.08),
    new TorusGeometry(0.017, 0.004, 6, 20).translate(0, 0, 0.045),
    box(0.014, 0.042, 0.016, 0, -0.03, -0.08),
    box(0.014, 0.042, 0.016, 0, -0.03, 0.045),
    box(0.03, 0.008, 0.02, 0, -0.0505, -0.08),
    box(0.03, 0.008, 0.02, 0, -0.0505, 0.045),
  ]);
  root.add(mesh(scope, P.anodised, 'scope'));
  // Knurled grip bands on the turrets and the magnification ring: dark ridges.
  const knurl: BufferGeometry[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    knurl.push(box(0.0018, 0.012, 0.0018, Math.cos(a) * 0.0122, 0.026, -0.02 + Math.sin(a) * 0.0122));
    knurl.push(box(0.002, 0.002, 0.016, 0, 0.0216, 0.132).rotateZ(a));
  }
  root.add(mesh(merged(knurl), P.cavity, 'knurling'));
  const ocularRadiusM = 0.019;
  const ocular = mesh(new CylinderGeometry(ocularRadiusM, ocularRadiusM, 0.002, 32).rotateX(Math.PI / 2), new MeshStandardNodeMaterial(), 'ocular');
  ocular.position.set(0, 0, 0.149);
  root.add(ocular);
  // Eye relief: the eye sits 85 mm behind the ocular when aimed (config SCOPE.eyeReliefM).
  return { root, magazine, bolt, ocular, eyeZ: 0.149 + 0.085, ocularRadiusM };
}

// ------------------------------------------------------------------ pistol

export interface PistolModel {
  root: Group;
  magazine: Mesh;
  slide: Mesh;
  eyeZ: number;
}

/** 9 mm polymer pistol with iron sights; sight line y = 0. */
export function buildPistol(): PistolModel {
  const root = new Group();
  root.name = 'pistol';
  const P = VM_MATERIALS;
  // Slide: bevelled top edges, sights, the barrel hood at the port; the serrations and port are cavities.
  const slideBody = profile(
    [
      [-0.118, -0.006],
      [0.07, -0.006],
      [0.074, -0.012],
      [0.074, -0.034],
      [-0.118, -0.034],
      [-0.121, -0.02],
    ],
    0.026,
    0.0025,
  );
  const slide = mesh(
    merged([
      slideBody,
      box(0.004, 0.006, 0.008, 0, -0.003, -0.106), // front sight
      box(0.007, 0.006, 0.008, -0.0055, -0.003, 0.064), // rear sight, two ears round the notch
      box(0.007, 0.006, 0.008, 0.0055, -0.003, 0.064),
      box(0.016, 0.006, 0.036, 0, -0.007, -0.005), // barrel hood showing in the port
    ]),
    P.parkerised,
    'slide',
  );
  const serrations: BufferGeometry[] = [box(0.004, 0.012, 0.042, 0.011, -0.006, -0.005)];
  for (let k = 0; k < 7; k++) for (const s of [-1, 1]) serrations.push(box(0.0015, 0.02, 0.0018, s * 0.0131, -0.02, 0.035 + k * 0.0045));
  serrations.push(rod(0.0055, 0.002, 12).translate(0, -0.019, -0.122)); // muzzle
  slide.add(mesh(merged(serrations), P.cavity, 'slide cavities'));
  root.add(slide);
  const frame = profile(
    [
      [-0.112, -0.034],
      [0.072, -0.034],
      [0.088, -0.046],
      [0.084, -0.058],
      [0.112, -0.158],
      [0.104, -0.17],
      [0.058, -0.17],
      [0.032, -0.09],
      [0.02, -0.097],
      [-0.035, -0.097],
      [-0.045, -0.085],
      [-0.045, -0.058],
      [-0.112, -0.058],
    ],
    0.026,
    0.002,
    [
      [
        [0.022, -0.06],
        [0.015, -0.089],
        [-0.03, -0.089],
        [-0.036, -0.06],
      ],
    ],
  );
  const railGrooves: BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) railGrooves.push(box(0.027, 0.004, 0.006, 0, -0.054, -0.1 + k * 0.012));
  root.add(mesh(merged([frame, box(0.005, 0.016, 0.006, 0, -0.07, 0.002).rotateX(0.2)]), P.polymer, 'frame'));
  // Stippled grip panels: a slightly rougher, darker skin on both sides.
  const panels: BufferGeometry[] = [];
  for (const s of [-1, 1]) panels.push(box(0.002, 0.07, 0.034, s * 0.0128, -0.12, 0.08).rotateX(-0.26));
  root.add(mesh(merged([...panels, ...railGrooves]), P.rubber, 'grip panels'));
  const magazine = mesh(merged([box(0.022, 0.1, 0.034, 0, 0, 0), box(0.026, 0.008, 0.04, 0, -0.054, 0.002)]), P.parkerised, 'magazine');
  magazine.position.set(0, -0.11, 0.045);
  magazine.rotation.x = -0.25;
  root.add(magazine);
  return { root, magazine, slide, eyeZ: 0.065 + 0.45 };
}

// ------------------------------------------------------------------ hands and kit

/**
 * A gloved hand closed round a grip, and its sleeve. Palm at the origin, fingers forward (−Z) and curled
 * down (−Y) round an axis along X, the thumb on the `side` (+1 right hand, −1 left), the forearm back (+Z).
 */
export function buildHand(side: 1 | -1 = 1): Group {
  const g = new Group();
  const P = VM_MATERIALS;
  const palm = merged([new BoxGeometry(0.078, 0.03, 0.09).translate(0, 0, 0), new SphereGeometry(0.04, 12, 8).scale(1, 0.4, 1.1).translate(0, 0.004, 0.005)]);
  const fingers: BufferGeometry[] = [];
  const lengths = [0.04, 0.045, 0.043, 0.035];
  lengths.forEach((len, i) => {
    const x = -0.028 + i * 0.0187;
    // Three phalanges curling down by ~70° each: the hand closes on something ~35 mm across.
    let py = 0;
    let pz = -0.045;
    let ang = 0.25;
    for (const [k, frac] of [0.42, 0.33, 0.25].entries()) {
      const segLen = len * frac * 1.6;
      const r = 0.0095 - k * 0.0009;
      const seg = new CapsuleGeometry(r, segLen, 3, 8).rotateX(Math.PI / 2 - ang).translate(x, py - Math.sin(ang) * segLen * 0.5, pz - Math.cos(ang) * segLen * 0.5);
      fingers.push(seg);
      py -= Math.sin(ang) * segLen;
      pz -= Math.cos(ang) * segLen;
      ang += 1.15;
    }
  });
  // Thumb: from the heel of the palm, along the grip on the near side.
  fingers.push(new CapsuleGeometry(0.011, 0.04, 3, 8).rotateX(Math.PI / 2).rotateY(side * 0.5).translate(side * 0.042, -0.012, -0.03));
  fingers.push(new CapsuleGeometry(0.0095, 0.03, 3, 8).rotateX(Math.PI / 2 - 0.5).rotateY(side * 0.2).translate(side * 0.05, -0.022, -0.065));
  g.add(mesh(merged([palm, ...fingers]), P.glove, 'glove'));
  // Leather palm and knuckle pad.
  g.add(mesh(merged([box(0.07, 0.006, 0.07, 0, -0.016, 0), box(0.07, 0.012, 0.028, 0, 0.017, -0.035)]), P.gloveLeather, 'glove pads'));
  // Cuff and sleeve: a wrinkled tube widening up the forearm.
  const cuff = lathe(
    [
      [0.038, 0.035],
      [0.04, 0.05],
      [0.04, 0.075],
      [0.037, 0.08],
    ],
    14,
  );
  const sleevePts: [number, number][] = [];
  for (let k = 0; k <= 12; k++) {
    const z = 0.075 + k * 0.025;
    // Folds gathered at the wrist, smoothing out up the arm.
    const fold = Math.sin(k * 2.3) * 0.0025 * (1 - k / 14);
    sleevePts.push([0.041 + k * 0.0012 + fold, z]);
  }
  g.add(mesh(cuff, P.gloveLeather, 'cuff'));
  g.add(mesh(lathe(sleevePts, 14), P.sleeve, 'sleeve'));
  return g;
}

export function buildFrag(): Mesh {
  const body = merged([
    lathe(
      [
        [0.0, -0.04],
        [0.018, -0.038],
        [0.03, -0.024],
        [0.033, 0.0],
        [0.03, 0.024],
        [0.02, 0.036],
        [0.011, 0.04],
        [0.0, 0.04],
      ],
      18,
    ).rotateX(-Math.PI / 2),
    new CylinderGeometry(0.009, 0.01, 0.022, 12).translate(0, 0.05, 0), // fuze
  ]);
  const m = mesh(body, VM_MATERIALS.frag, 'grenade');
  // Spoon along the side and the pull ring.
  m.add(mesh(merged([box(0.008, 0.07, 0.003, 0.03, 0.02, 0).rotateZ(-0.08), box(0.012, 0.004, 0.02, 0.012, 0.062, 0)]), VM_MATERIALS.brass, 'spoon'));
  m.add(mesh(new TorusGeometry(0.011, 0.0015, 6, 16).rotateY(Math.PI / 2).translate(-0.018, 0.056, 0), VM_MATERIALS.steel, 'pin ring'));
  return m;
}

export function buildMedKit(): Mesh {
  const m = mesh(new BoxGeometry(0.16, 0.1, 0.07), VM_MATERIALS.medkit, 'med kit');
  // Zip and carry strap.
  m.add(mesh(merged([box(0.164, 0.006, 0.074, 0, 0.02, 0), box(0.02, 0.104, 0.074, 0.04, 0, 0)]), VM_MATERIALS.polymer, 'med kit strap'));
  return m;
}

export function buildAmmoPouch(): Mesh {
  const m = mesh(merged([new BoxGeometry(0.12, 0.14, 0.06), new BoxGeometry(0.026, 0.12, 0.065).translate(0.02, 0.1, 0)]), VM_MATERIALS.ammoPouch, 'ammo pouch');
  m.add(mesh(merged([box(0.124, 0.03, 0.064, 0, 0.055, 0), box(0.03, 0.05, 0.004, 0, 0.03, 0.033)]), VM_MATERIALS.polymer, 'pouch flap'));
  return m;
}
