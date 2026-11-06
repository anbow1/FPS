import { attribute, texture, uv } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, CylinderGeometry, Group, type Material, Mesh, MeshStandardNodeMaterial, type Texture, Vector3 } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The player's three weapons from downloaded models (shared/weapons, CC BY; prepared by
// paris/tools/vehicles/prepare_gun.py with their moving parts as nodes, makers' marks and serials painted
// out). weaponModels.ts builds each from its model when it loaded, in the procedural one's frame (metres,
// facing −Z, the sight line at y = 0) and with the same handles, so the viewmodel animates them alike.
//
// Each prepared file stands on its lowest point (y = 0) and is centred along its length; the points below
// were read from the files' own vertices:
// - carbine: the holographic sight's rear window 0.3156 m up (its middle) and 0.1238 m behind the middle;
//   the barrel's end 0.287 m ahead, its bore 0.243 m up (the suppressor's axis);
// - precision rifle: the scope's axis 0.1937 m up (objective and eyepiece alike), the eyepiece's rim
//   0.3143 m behind the middle, 17 mm across; the bore 0.138 m up (barrel and bolt alike), the muzzle 0.6 m
//   ahead;
// - pistol: the sights' tops 0.1449 m up (post 0.1454, rear blade 0.1443), the rear blade 0.067 m behind the
//   middle; the bore 0.122 m up, the muzzle 0.093 m ahead.

type Part = { geometry: BufferGeometry; material: MeshStandardNodeMaterial };
type Gun = Map<string, Part>;

const URLS = {
  carbine: new URL('../../../shared/weapons/carbine_ar/carbine_ar.glb', import.meta.url).href,
  precision: new URL('../../../shared/weapons/rifle_bolt/rifle_bolt.glb', import.meta.url).href,
  pistol: new URL('../../../shared/weapons/pistol_9mm/pistol_9mm.glb', import.meta.url).href,
} as const;

/** Each file's frame → the weapon's: the sight line down to y = 0, the eye's reference point to its z. */
const SHIFTS: Record<keyof typeof URLS, Vector3> = {
  // The window's rear face to z = 0.05, where the procedural carbine's optic window is.
  carbine: new Vector3(0, -0.3156, 0.05 - 0.1238),
  // The eyepiece's rim to z = 0.149, where the procedural scope's ocular is.
  precision: new Vector3(0, -0.1937, 0.149 - 0.3143),
  // The rear blade to z = 0.065, where the procedural pistol's rear sight is.
  pistol: new Vector3(0, -0.1449, 0.065 - 0.067),
};

const guns: Partial<Record<keyof typeof URLS, Gun>> = {};

function materialFor(src: Material): MeshStandardNodeMaterial {
  const s = src as MeshStandardNodeMaterial;
  const name = src.name.toLowerCase();
  const m = new MeshStandardNodeMaterial({ name: `gun ${src.name}`, roughness: 0.5, metalness: 0.5 });
  if (s.map) m.colorNode = texture(s.map as Texture, uv()).rgb;
  if (s.normalMap) {
    m.normalMap = s.normalMap;
    m.normalScale.copy(s.normalScale);
  }
  // The model's own wear (glTF: roughness in green, metalness in blue), times its factors.
  if (s.roughnessMap) {
    const mr = texture(s.roughnessMap as Texture, uv());
    m.roughnessNode = mr.g.mul(s.roughness);
    m.metalnessNode = mr.b.mul(s.metalness);
  }
  m.aoNode = attribute('color_1', 'vec3').x;
  if (name.includes('glass')) {
    m.transparent = true;
    m.opacity = 0.25;
    m.depthWrite = false;
  }
  return m;
}

async function loadGun(id: keyof typeof URLS): Promise<void> {
  try {
    const scene = (await new GLTFLoader().loadAsync(URLS[id])).scene;
    scene.updateMatrixWorld(true);
    const made = new Map<Material, MeshStandardNodeMaterial>();
    const parts: Gun = new Map();
    const shift = SHIFTS[id];
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      g.translate(shift.x, shift.y, shift.z);
      // The procedural finishes read `edge` (gunkit.ts); these models carry their wear in their textures.
      g.setAttribute('edge', new BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
      const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material;
      let mat = made.get(src);
      if (!mat) {
        mat = materialFor(src);
        made.set(src, mat);
      }
      // A node with several materials loads as a group of meshes: the node's name is the group's.
      const name = o.parent && o.parent !== scene ? o.parent.name : o.name;
      const key = parts.has(name) ? `${name}#${parts.size}` : name;
      parts.set(key, { geometry: g, material: mat });
    });
    if (!parts.has('body')) throw new Error(`${id} model without a body`);
    guns[id] = parts;
  } catch (err) {
    console.warn(`the ${id} model did not load; the procedural one stands in:`, err);
  }
}

/** Loads the three weapons' models; each failure leaves that weapon procedural (logged, not thrown). */
export async function loadGunModels(): Promise<void> {
  await Promise.all([loadGun('carbine'), loadGun('precision'), loadGun('pistol')]);
}

export function gunLoaded(id: keyof typeof URLS): boolean {
  return guns[id] !== undefined;
}

/** Every mesh of the named node (and its numbered siblings from a multi-material node). */
function meshesOf(gun: Gun, name: string): Mesh[] {
  const out: Mesh[] = [];
  for (const [key, p] of gun) {
    if (key !== name && !key.startsWith(`${name}#`)) continue;
    const m = new Mesh(p.geometry, p.material);
    m.name = name;
    m.castShadow = false; // the player's own weapon casts no shadow into the world view
    m.receiveShadow = true;
    out.push(m);
  }
  return out;
}

/** One mesh for a moving part, its geometry about `rest` and the mesh placed there. */
function partAt(gun: Gun, name: string, rest: Vector3): Mesh {
  const ms = meshesOf(gun, name);
  const first = ms[0];
  if (!first) return new Mesh();
  const m = new Mesh(first.geometry.clone().translate(-rest.x, -rest.y, -rest.z), first.material);
  m.name = name;
  m.position.copy(rest);
  m.receiveShadow = true;
  return m;
}

export interface ModelGunCommon {
  root: Group;
  magazine: Mesh;
  muzzle: Vector3;
  gripRight: Vector3;
  gripLeft: Vector3;
}

/** The carbine: body, magazine, charging handle, the holographic sight's two windows, its own suppressor. */
export function modelCarbine(magRestY: number): (ModelGunCommon & { bolt: Mesh; dotLens: Mesh; suppressor: Mesh; eyeZ: number }) | null {
  const gun = guns.carbine;
  if (!gun) return null;
  const root = new Group();
  root.name = 'rifle';
  for (const m of meshesOf(gun, 'body')) root.add(m);
  const magazine = partAt(gun, 'magazine', new Vector3(0, magRestY, 0));
  const bolt = partAt(gun, 'bolt', new Vector3());
  // The front window stays glass; the rear one carries the collimated dot (viewmodel.ts).
  for (const m of meshesOf(gun, 'glassA')) root.add(m);
  const dotLens = meshesOf(gun, 'glassB')[0] ?? new Mesh();
  const suppressor = meshesOf(gun, 'suppressor')[0] ?? new Mesh();
  root.add(magazine, bolt, dotLens, suppressor);
  return {
    root,
    magazine,
    bolt,
    dotLens,
    suppressor,
    // A cheek on the stock puts the eye ~0.22 m behind the window.
    eyeZ: 0.27,
    muzzle: new Vector3(0, -0.0724, -0.361),
    gripRight: new Vector3(0, -0.17, 0.1),
    gripLeft: new Vector3(-0.02, -0.11, -0.24),
  };
}

const BORE_PRECISION = new Vector3(0, 0.138 - 0.1937, 0);

/**
 * The precision rifle: body with its scope, magazine, and the bolt as a group on the bore's axis at z
 * `boltRestZ`, its geometry turned back by `boltDownRad` so the viewmodel's rest rotation puts the handle
 * where the model has it. The ocular is a disc just behind the eyepiece's rim, inside its 17 mm.
 */
export function modelPrecision(magRestY: number, boltRestZ: number, boltDownRad: number): (ModelGunCommon & { bolt: Group; ocular: Mesh; ocularRadiusM: number; eyeZ: number; suppressorAt: Vector3 }) | null {
  const gun = guns.precision;
  if (!gun) return null;
  const root = new Group();
  root.name = 'sniper';
  for (const name of ['body', 'scope', 'trigger', 'release']) for (const m of meshesOf(gun, name)) root.add(m);
  const magazine = partAt(gun, 'magazine', new Vector3(0, magRestY, 0));
  const bolt = new Group();
  bolt.position.set(0, BORE_PRECISION.y, boltRestZ);
  for (const m of meshesOf(gun, 'bolt')) {
    m.geometry = m.geometry.clone().translate(0, -BORE_PRECISION.y, -boltRestZ).rotateZ(-boltDownRad);
    bolt.add(m);
  }
  const ocularRadiusM = 0.0155;
  const ocular = new Mesh(new CylinderGeometry(ocularRadiusM, ocularRadiusM, 0.002, 32).rotateX(Math.PI / 2), new MeshStandardNodeMaterial());
  ocular.name = 'ocular';
  ocular.position.set(0, 0, 0.15);
  root.add(magazine, bolt, ocular);
  const muzzle = new Vector3(0, BORE_PRECISION.y, -0.6 + SHIFTS.precision.z);
  return {
    root,
    magazine,
    bolt,
    ocular,
    ocularRadiusM,
    // Eye relief: 85 mm behind the ocular (config SCOPE.eyeReliefM), as the procedural scope.
    eyeZ: 0.15 + 0.085,
    muzzle,
    // The suppressor's middle, half its 0.16 m ahead of the muzzle.
    suppressorAt: muzzle.clone().add(new Vector3(0, 0, -0.08)),
    gripRight: new Vector3(0, -0.15, 0.15),
    gripLeft: new Vector3(-0.02, -0.12, -0.33),
  };
}

/** The pistol: frame, slide (it recoils), magazine; iron sights only (no red dot on this one). */
export function modelPistol(magRestY: number): (ModelGunCommon & { slide: Mesh; dotLens: Mesh; sightY: number; eyeZ: number }) | null {
  const gun = guns.pistol;
  if (!gun) return null;
  const root = new Group();
  root.name = 'pistol';
  for (const m of meshesOf(gun, 'body')) root.add(m);
  const magazine = partAt(gun, 'magazine', new Vector3(0, magRestY, 0));
  const slide = partAt(gun, 'slide', new Vector3());
  // No reflex sight: the dot's window is kept (the viewmodel gives it the dot's material) but never shown.
  const dotLens = new Mesh();
  dotLens.visible = false;
  root.add(magazine, slide, dotLens);
  return {
    root,
    magazine,
    slide,
    dotLens,
    sightY: 0,
    eyeZ: 0.065 + 0.45,
    muzzle: new Vector3(0, 0.122 - 0.1449, -0.093 + SHIFTS.pistol.z),
    gripRight: new Vector3(0, -0.095, 0.05),
    gripLeft: new Vector3(-0.01, -0.115, 0.04),
  };
}
