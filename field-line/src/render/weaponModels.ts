import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxGeometry, type BufferGeometry, CylinderGeometry, DoubleSide, Group, type Material, Mesh, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, SphereGeometry, TorusGeometry } from 'three/webgpu';

// First-person weapon and hand models, built from primitives in metres, facing
// −Z, with the sight axis on the local origin's Y = 0 line so aiming down
// sights just moves the model until that line meets the eye. Materials follow
// the sheet: parkerised receivers (#3C3C3E, metal 0), polymer furniture,
// bright steel only where bare metal shows, brass for the grenade spoon.

export const VM_MATERIALS = {
  // Double-sided: optic and scope tubes are open cylinders you look straight through.
  parkerised: new MeshStandardNodeMaterial({ name: 'parkerised', color: 0x3c3c3e, roughness: 0.62, metalness: 0, side: DoubleSide }),
  polymer: new MeshStandardNodeMaterial({ name: 'polymer', color: 0x2b2b2d, roughness: 0.75, metalness: 0 }),
  steel: new MeshStandardNodeMaterial({ name: 'steel', color: 0xc6c6c8, roughness: 0.35, metalness: 1 }),
  glove: new MeshPhysicalNodeMaterial({ name: 'glove', color: 0x3e3328, roughness: 0.85, sheen: 0.3, sheenRoughness: 0.8, sheenColor: 0x3e3328 }),
  sleeve: new MeshPhysicalNodeMaterial({ name: 'sleeve', color: 0x5a5e48, roughness: 0.9, sheen: 0.4, sheenRoughness: 0.8, sheenColor: 0x5a5e48 }),
  frag: new MeshStandardNodeMaterial({ name: 'frag', color: 0x4b5340, roughness: 0.7, metalness: 0 }),
  brass: new MeshStandardNodeMaterial({ name: 'brass', color: 0xf5e4ae, roughness: 0.25, metalness: 1 }),
  medkit: new MeshPhysicalNodeMaterial({ name: 'medkit', color: 0x6e2a24, roughness: 0.9, sheen: 0.3, sheenColor: 0x6e2a24 }),
  ammoPouch: new MeshPhysicalNodeMaterial({ name: 'ammoPouch', color: 0x5c5b3e, roughness: 0.9, sheen: 0.3, sheenColor: 0x5c5b3e }),
} as const;

function merged(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false);
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

const tube = (r: number, len: number, seg = 16): CylinderGeometry => new CylinderGeometry(r, r, len, seg, 1, true).rotateX(Math.PI / 2);

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
  const opticY = 0; // sight line
  const railY = -0.042;
  const boreY = railY - 0.04;
  const receiver = merged([
    new BoxGeometry(0.034, 0.05, 0.3).translate(0, railY - 0.03, 0.05), // upper
    new BoxGeometry(0.032, 0.045, 0.22).translate(0, railY - 0.075, 0.07), // lower
    new BoxGeometry(0.024, 0.01, 0.34).translate(0, railY - 0.002, 0.02), // top rail
    new BoxGeometry(0.046, 0.05, 0.3).translate(0, boreY + 0.006, -0.23), // handguard
    new BoxGeometry(0.03, 0.035, 0.06).translate(0, railY - 0.1, 0.12).rotateX(0), // trigger guard area
  ]);
  root.add(mesh(receiver, P.parkerised, 'receiver'));
  const barrel = merged([tube(0.009, 0.25).translate(0, boreY, -0.49), new CylinderGeometry(0.013, 0.013, 0.06, 12).rotateX(Math.PI / 2).translate(0, boreY, -0.63)]);
  root.add(mesh(barrel, P.parkerised, 'barrel'));
  const furniture = merged([
    new BoxGeometry(0.03, 0.09, 0.035).rotateX(-0.35).translate(0, railY - 0.13, 0.16), // pistol grip
    new BoxGeometry(0.04, 0.07, 0.2).translate(0, railY - 0.06, 0.32), // stock
    new BoxGeometry(0.045, 0.1, 0.03).translate(0, railY - 0.07, 0.43), // butt pad
    new BoxGeometry(0.02, 0.06, 0.03).translate(0, boreY - 0.05, -0.28), // vertical grip
  ]);
  root.add(mesh(furniture, P.polymer, 'furniture'));
  const magazine = mesh(merged([new BoxGeometry(0.026, 0.16, 0.065).rotateX(0.18).translate(0, -0.08, 0)]), P.polymer, 'magazine');
  magazine.position.set(0, railY - 0.1, -0.02);
  root.add(magazine);
  const bolt = mesh(new BoxGeometry(0.012, 0.012, 0.03), P.steel, 'charging handle');
  bolt.position.set(0.02, railY - 0.02, 0.17);
  root.add(bolt);

  // Red dot: a 30 mm tube on a riser; front and rear glass. The rear glass carries the dot.
  const optic = merged([tube(0.018, 0.1, 20).translate(0, opticY, 0.0), new BoxGeometry(0.02, 0.03, 0.05).translate(0, (railY + opticY) / 2 - 0.004, 0.0), new BoxGeometry(0.012, 0.012, 0.012).translate(0.022, opticY, 0.0)]);
  root.add(mesh(optic, P.parkerised, 'optic'));
  const lensGeo = new CylinderGeometry(0.0165, 0.0165, 0.002, 24).rotateX(Math.PI / 2);
  const front = mesh(lensGeo, new MeshPhysicalNodeMaterial({ color: 0xe6ebeb, roughness: 0.02, transparent: true, opacity: 0.12, ior: 1.52 }), 'optic front');
  front.position.set(0, opticY, -0.05);
  root.add(front);
  const dotLens = mesh(lensGeo, new MeshStandardNodeMaterial(), 'optic rear');
  dotLens.position.set(0, opticY, 0.05);
  root.add(dotLens);
  return { root, magazine, bolt, dotLens, eyeZ: 0.05 + 0.2 };
}

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
  const stock = merged([
    new BoxGeometry(0.05, 0.06, 0.62).translate(0, boreY - 0.02, 0.0),
    new BoxGeometry(0.045, 0.11, 0.26).translate(0, boreY - 0.05, 0.38),
    new BoxGeometry(0.03, 0.08, 0.04).rotateX(-0.3).translate(0, boreY - 0.08, 0.2),
  ]);
  root.add(mesh(stock, P.polymer, 'stock'));
  const action = merged([tube(0.016, 0.24).translate(0, boreY, 0.05), tube(0.011, 0.6).translate(0, boreY, -0.55), new CylinderGeometry(0.018, 0.018, 0.1, 12).rotateX(Math.PI / 2).translate(0, boreY, -0.88)]);
  root.add(mesh(action, P.parkerised, 'action'));
  const magazine = mesh(new BoxGeometry(0.03, 0.06, 0.09), P.parkerised, 'magazine');
  magazine.position.set(0, boreY - 0.06, 0.02);
  root.add(magazine);
  const bolt = new Group();
  bolt.add(mesh(new CylinderGeometry(0.004, 0.004, 0.06, 8).rotateZ(Math.PI / 2).translate(0.03, 0, 0), P.steel, 'bolt handle'));
  bolt.add(mesh(new SphereGeometry(0.009, 10, 8).translate(0.06, 0, 0), P.polymer, 'bolt knob'));
  bolt.position.set(0.012, boreY, 0.13);
  root.add(bolt);
  // Scope: 30 mm tube, 50 mm objective bell, 40 mm ocular bell, turrets, rings.
  const scope = merged([
    tube(0.015, 0.2, 20).translate(0, 0, -0.02),
    new CylinderGeometry(0.028, 0.015, 0.06, 20, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.15),
    tube(0.028, 0.05, 20).translate(0, 0, -0.205),
    new CylinderGeometry(0.015, 0.021, 0.04, 20, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.1),
    tube(0.021, 0.03, 20).translate(0, 0, 0.135),
    new CylinderGeometry(0.012, 0.012, 0.03, 12).translate(0, 0.028, -0.02),
    new CylinderGeometry(0.012, 0.012, 0.03, 12).rotateZ(Math.PI / 2).translate(0.028, 0, -0.02),
    new TorusGeometry(0.017, 0.004, 6, 16).translate(0, 0, -0.07),
    new TorusGeometry(0.017, 0.004, 6, 16).translate(0, 0, 0.04),
    new BoxGeometry(0.012, 0.05, 0.015).translate(0, -0.035, -0.07),
    new BoxGeometry(0.012, 0.05, 0.015).translate(0, -0.035, 0.04),
  ]);
  root.add(mesh(scope, P.parkerised, 'scope'));
  const ocularRadiusM = 0.019;
  const ocular = mesh(new CylinderGeometry(ocularRadiusM, ocularRadiusM, 0.002, 32).rotateX(Math.PI / 2), new MeshStandardNodeMaterial(), 'ocular');
  ocular.position.set(0, 0, 0.149);
  root.add(ocular);
  // Eye relief: the eye sits 85 mm behind the ocular when aimed (config SCOPE.eyeReliefM).
  return { root, magazine, bolt, ocular, eyeZ: 0.149 + 0.085, ocularRadiusM };
}

export interface PistolModel {
  root: Group;
  magazine: Mesh;
  slide: Mesh;
  eyeZ: number;
}

/** 9 mm pistol with iron sights; sight line y = 0. */
export function buildPistol(): PistolModel {
  const root = new Group();
  root.name = 'pistol';
  const P = VM_MATERIALS;
  const slide = mesh(merged([new BoxGeometry(0.028, 0.03, 0.19).translate(0, -0.018, -0.02), new BoxGeometry(0.006, 0.008, 0.008).translate(0, 0.0, -0.105), new BoxGeometry(0.02, 0.008, 0.008).translate(0, 0.0, 0.065)]), P.parkerised, 'slide');
  root.add(slide);
  root.add(mesh(merged([new BoxGeometry(0.026, 0.025, 0.16).translate(0, -0.045, -0.01), new BoxGeometry(0.028, 0.11, 0.045).rotateX(-0.25).translate(0, -0.1, 0.04)]), P.polymer, 'frame'));
  const magazine = mesh(new BoxGeometry(0.022, 0.1, 0.035), P.parkerised, 'magazine');
  magazine.position.set(0, -0.11, 0.045);
  magazine.rotation.x = -0.25;
  root.add(magazine);
  return { root, magazine, slide, eyeZ: 0.065 + 0.45 };
}

/** Gloved hands and sleeves as simple capsules; posed per weapon by the viewmodel. */
export function buildHand(): Group {
  const g = new Group();
  const P = VM_MATERIALS;
  g.add(mesh(new BoxGeometry(0.075, 0.035, 0.1).translate(0, 0, 0), P.glove, 'palm'));
  g.add(mesh(new CylinderGeometry(0.032, 0.04, 0.26, 10).rotateX(Math.PI / 2).translate(0, -0.005, 0.17), P.sleeve, 'forearm'));
  return g;
}

export function buildFrag(): Mesh {
  const g = merged([new SphereGeometry(0.032, 14, 10).scale(1, 1.25, 1), new BoxGeometry(0.012, 0.05, 0.01).translate(0.028, 0.02, 0)]);
  return mesh(g, VM_MATERIALS.frag, 'grenade');
}

export function buildMedKit(): Mesh {
  return mesh(new BoxGeometry(0.16, 0.1, 0.07), VM_MATERIALS.medkit, 'med kit');
}

export function buildAmmoPouch(): Mesh {
  return mesh(merged([new BoxGeometry(0.12, 0.14, 0.06), new BoxGeometry(0.026, 0.12, 0.065).translate(0.02, 0.1, 0)]), VM_MATERIALS.ammoPouch, 'ammo pouch');
}
