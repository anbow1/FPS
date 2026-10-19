import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { tube } from './meshkit.ts';
import type { MapProp, PropKind } from '../maps/types.ts';
import type { MaterialLibrary } from './materials.ts';
import { streetTreeGeometry } from './streetTree.ts';
import { type ScanId, scanModel } from './scanModels.ts';
import { swayingMaterial } from './foliage.ts';
import { buildCar, type CarGeometry, type CarPart, type CarVariant } from './carModel.ts';
import { streetPropParts } from './streetProps.ts';

// Props: one InstancedMesh per (kind, material part), sized from real objects
// (scale sheet: light 4x4 4.60 m, a hatchback 4.2 m; ISO container 6.06 m).
// Colliders for the same props are added by the map builder (maps/builder.ts).

// Car paint palette, weighted like a real car park (repeats are the weights):
// mostly white, black, greys and silver, then blues and reds, the odd olive or
// beige; sheet car paint #6E2A24 among them. All inside the non-metal
// luminance range (silver here is its diffuse look, not a metal).
const CAR_COLOURS = [
  0xd8d8d3, 0xd8d8d3, 0xcdcac2, 0x1d1e20, 0x1d1e20, 0x26272a, 0x3c3c3e, 0x3c3c3e, 0x6b6d70, 0x6b6d70, 0xa8a9a7, 0xa8a9a7, 0x8f8b85, 0x2e3a4a, 0x34507a, 0x6e2a24,
  0x8e1f1c, 0x4b5340, 0x9c8f78,
];
/** Palette slot for a map's colour index (any non-negative integer). */
function carColour(index: number | undefined): number {
  return CAR_COLOURS[Math.abs(Math.trunc(index ?? 0)) % CAR_COLOURS.length] ?? 0x6e2a24;
}

interface Part {
  geometry: BufferGeometry;
  material: Material;
  tinted?: boolean;
  castShadow?: boolean;
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(sx, sy, sz).translate(x, y, z);
}

function nonIndexed(g: BufferGeometry): BufferGeometry {
  return g.index ? g.toNonIndexed() : g;
}

function merge(list: BufferGeometry[]): BufferGeometry {
  // Mixed indexed and non-indexed parts merge only as non-indexed.
  const g = mergeGeometries(list.map(nonIndexed), false);
  if (!g) throw new Error('prop geometry merge failed: parts have mismatched attributes');
  return g;
}

const CAR_MATERIAL: Record<CarPart, string> = {
  paint: 'carPaint',
  glass: 'darkGlass',
  trim: 'carTrim',
  headlamp: 'carHeadlamp',
  taillamp: 'carTaillamp',
  plate: 'carPlate',
  tyre: 'tyre',
  rim: 'carRim',
};

const carCache = new Map<string, CarGeometry>();

function carParts(variant: CarVariant, lib: MaterialLibrary, coarse = false): Part[] {
  const key = `${variant}:${coarse ? 'far' : 'near'}`;
  let car = carCache.get(key);
  if (!car) {
    car = buildCar(variant, coarse);
    carCache.set(key, car);
  }
  const parts: Part[] = [];
  for (const [part, geometry] of Object.entries(car) as [CarPart, BufferGeometry][]) {
    // Small, flush or under the body: their shadows are lost in the body's.
    const castShadow = part === 'paint' || part === 'tyre' || part === 'glass';
    parts.push({ geometry, material: lib.get(CAR_MATERIAL[part]), tinted: part === 'paint', castShadow });
  }
  return parts;
}

/** Cars within this range of the camera get the full model; the rest the coarse one (~1/5 the triangles). */
const CAR_NEAR_M = 45;
/** Re-sort cars between the two models when the camera has moved this far. */
const CAR_RESORT_M = 4;

/** Near and far versions of one car variant: the instances move between them as the camera moves. */
class CarLod {
  private readonly near: InstancedMesh[] = [];
  private readonly far: InstancedMesh[] = [];
  private readonly last = new Vector3(Infinity, 0, 0);

  constructor(
    private readonly cars: readonly MapProp[],
    variant: CarVariant,
    lib: MaterialLibrary,
    group: Group,
  ) {
    for (const [coarse, into] of [
      [false, this.near],
      [true, this.far],
    ] as const) {
      for (const part of carParts(variant, lib, coarse)) {
        const mesh = new InstancedMesh(part.geometry, part.material, cars.length);
        mesh.name = `prop-car-${coarse ? 'far' : 'near'}`;
        mesh.castShadow = part.castShadow ?? true;
        mesh.receiveShadow = true;
        // The instances change set as the camera moves, so stored bounds would go stale.
        mesh.frustumCulled = false;
        mesh.userData.tinted = part.tinted === true;
        mesh.count = 0;
        into.push(mesh);
        group.add(mesh);
      }
    }
  }

  update(camera: Vector3): void {
    if (this.last.distanceToSquared(camera) < CAR_RESORT_M * CAR_RESORT_M) return;
    this.last.copy(camera);
    let nNear = 0;
    let nFar = 0;
    for (const p of this.cars) {
      const isNear = Math.hypot(p.pos.x - camera.x, p.pos.z - camera.z) < CAR_NEAR_M;
      const slot = isNear ? nNear++ : nFar++;
      _q.setFromAxisAngle(_up, p.yawRad);
      _m.compose(_pos.set(p.pos.x, p.pos.y, p.pos.z), _q, _scale.setScalar(p.scale));
      _colour.setHex(carColour(p.colourIndex));
      for (const mesh of isNear ? this.near : this.far) {
        mesh.setMatrixAt(slot, _m);
        if (mesh.userData.tinted) mesh.setColorAt(slot, _colour);
      }
    }
    for (const [list, n] of [
      [this.near, nNear],
      [this.far, nFar],
    ] as const) {
      for (const mesh of list) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }
}

const _m = new Matrix4();
const _q = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _pos = new Vector3();
const _scale = new Vector3();
const _colour = new Color();

/** Which model a prop uses: cars alternate hatchback and saloon by a hash of their place. */
function variantOf(p: MapProp): string {
  // Six scanned rocks and two stumps, by the prop's seed.
  if (p.kind === 'rock') return `0${(p.seed % 6) + 1}`;
  if (p.kind === 'stump') return `0${(p.seed % 2) + 1}`;
  if (p.kind !== 'car') return '';
  const h = Math.abs(Math.round(p.pos.x * 7.3 + p.pos.z * 13.1)) % 5;
  return h < 3 ? 'hatch' : 'saloon';
}

function partsFor(kind: PropKind, variant: string, lib: MaterialLibrary): Part[] {
  const street = streetPropParts(kind, lib);
  if (street) return street;
  switch (kind) {
    case 'car':
      return carParts(variant === 'saloon' ? 'saloon' : 'hatch', lib);
    case 'carWreck': {
      // The hatchback burnt out: rust for the paint, no glass or tyres left, sitting on its rims.
      const car = buildCar('hatch');
      const sag = (g: BufferGeometry | undefined): BufferGeometry | null => (g ? g.clone().translate(0, -0.1, 0) : null);
      const parts: Part[] = [];
      const shell = sag(car.paint);
      const trim = sag(car.trim);
      const rims = sag(car.rim);
      if (shell) parts.push({ geometry: shell, material: lib.get('carWreck') });
      if (trim) parts.push({ geometry: trim, material: lib.get('tyre') });
      if (rims) parts.push({ geometry: rims, material: lib.get('carWreck') });
      return parts;
    }
    case 'container':
      return [{ geometry: containerGeometry(), material: lib.get('containerPaint') }];
    case 'barrier': {
      // Jersey barrier: wide foot, sloped face, narrow top (0.81 m tall).
      const g = merge([box(0.6, 0.08, 3.0, 0, 0.04, 0), box(0.48, 0.25, 3.0, 0, 0.2, 0), box(0.28, 0.5, 3.0, 0, 0.56, 0)]);
      return [{ geometry: g, material: lib.look('concrete').material }];
    }
    case 'lampPost': {
      // Tapered steel column on a plinth, a swept arm and a flat luminaire head (the lens under it lights the
      // street at night, render/cityLights.ts — its place is fixed: 1.3 m out, 6.23 m up).
      const g = merge([
        new CylinderGeometry(0.15, 0.19, 0.55, 12).translate(0, 0.275, 0),
        new CylinderGeometry(0.11, 0.15, 0.08, 12).translate(0, 0.59, 0),
        new CylinderGeometry(0.055, 0.09, 5.6, 10).translate(0, 3.4, 0),
        nonIndexed(tube([new Vector3(0, 6.0, 0), new Vector3(0, 6.25, 0.25), new Vector3(0, 6.36, 0.75), new Vector3(0, 6.33, 1.12)], [0.05, 0.042, 0.036, 0.032], 8, 1)),
        new SphereGeometry(1, 14, 8).scale(0.18, 0.075, 0.33).translate(0, 6.3, 1.3),
      ]);
      const lens = box(0.24, 0.02, 0.48, 0, 6.235, 1.3);
      return [
        { geometry: g, material: lib.look('metalDark').material },
        { geometry: lens, material: lib.get('lampLens'), castShadow: false },
      ];
    }
    case 'streetTree': {
      // Branching trunk and leaf-cluster cards (streetTree.ts), the crown swaying in the map's wind.
      const tree = streetTreeGeometry(7);
      return [
        { geometry: tree.wood, material: lib.get('bark') },
        { geometry: tree.leaves, material: swayingMaterial(lib.get('leaves'), 0.05) },
      ];
    }
    case 'bench': {
      // Park bench: cast-iron end frames with arm rests, and timber slats on seat and back.
      const slats: BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) slats.push(box(1.8, 0.03, 0.085, 0, 0.45, -0.16 + i * 0.1));
      for (let i = 0; i < 3; i++) slats.push(box(1.8, 0.075, 0.025, 0, 0.6 + i * 0.1, 0.2 + i * 0.016).rotateX(-0.16));
      const frame: BufferGeometry[] = [];
      for (const x of [-0.82, 0.82]) {
        frame.push(nonIndexed(tube([new Vector3(x, 0, -0.24), new Vector3(x, 0.2, -0.22), new Vector3(x, 0.42, -0.2), new Vector3(x, 0.42, 0.17), new Vector3(x, 0.66, 0.22), new Vector3(x, 0.9, 0.26)], [0.03, 0.026, 0.024, 0.024, 0.022, 0.02], 6, 1)));
        frame.push(nonIndexed(tube([new Vector3(x, 0, 0.22), new Vector3(x, 0.42, 0.16)], [0.028, 0.024], 6, 1)));
        frame.push(nonIndexed(tube([new Vector3(x, 0.42, -0.2), new Vector3(x, 0.63, -0.2), new Vector3(x, 0.66, 0.0), new Vector3(x, 0.64, 0.2)], [0.022, 0.02, 0.02, 0.02], 6, 1)));
      }
      return [
        { geometry: merge(slats), material: lib.look('wood').material },
        { geometry: merge(frame), material: lib.look('metalDark').material },
      ];
    }
    case 'trashBin': {
      // Litter bin: a ribbed steel drum with a rolled rim, dark inside.
      const body: BufferGeometry[] = [
        new LatheGeometry(
          [new Vector2(0.001, 0.03), new Vector2(0.25, 0.03), new Vector2(0.27, 0.08), new Vector2(0.29, 0.92), new Vector2(0.305, 0.95), new Vector2(0.29, 0.98), new Vector2(0.27, 0.97)],
          16,
        ),
        new TorusGeometry(0.295, 0.018, 6, 20).rotateX(Math.PI / 2).translate(0, 0.96, 0),
      ];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        body.push(box(0.025, 0.8, 0.02, Math.cos(a) * 0.29, 0.5, Math.sin(a) * 0.29));
      }
      return [
        { geometry: merge(body.map(nonIndexed)), material: lib.look('metalDark').material },
        { geometry: new CylinderGeometry(0.26, 0.26, 0.01, 16).translate(0, 0.9, 0), material: lib.get('carTrim'), castShadow: false },
      ];
    }
    case 'rock': {
      // Mossy forest rocks from one photoscanned set, 10 % wider than the unit they are normalised to,
      // the size the map's scale was chosen for.
      const scan = scanModel(`rock_moss_${variant}` as ScanId);
      // The scan is an ochre sandstone; in sun it read as golden lumps among the pines. Greyed toward the
      // granite of a conifer ridge, its moss kept.
      return [{ geometry: scan.geometry.clone().scale(1.1, 1.1, 1.1), material: lib.scan('rock_moss', scan, { saturation: 0.5, gain: 0.8 }) }];
    }
    case 'stump': {
      const scan = scanModel(`tree_stump_${variant}` as ScanId);
      return [{ geometry: scan.geometry, material: lib.scan(`tree_stump_${variant}`, scan) }];
    }
    case 'deadLog': {
      const scan = scanModel('dead_tree_trunk');
      return [{ geometry: scan.geometry, material: lib.scan('dead_tree_trunk', scan) }];
    }
    case 'hayBale':
      return [{ geometry: new CylinderGeometry(0.6, 0.6, 1.8, 14).rotateX(Math.PI / 2).translate(0, 0.6, 0), material: lib.get('hay') }];
    case 'beam':
      return [{ geometry: box(0.25, 0.25, 4.0, 0, 0.125, 0), material: lib.look('wood').material }];
    case 'crate':
      return [{ geometry: box(1, 1, 1, 0, 0.5, 0), material: lib.look('wood').material }];
    case 'rangeSign':
    case 'dummy':
      return []; // signs are built one by one (each has its own label); dummies are soldiers
    default:
      return []; // the street props (streetProps.ts), handled above
  }
}

/** ISO 20 ft container, 6.06 × 2.44 × 2.59 m, with corrugated sides. */
function containerGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(2.44, 2.59, 6.06, 0, 1.295, 0)];
  for (let z = -2.8; z <= 2.8; z += 0.28) {
    parts.push(box(2.48, 2.3, 0.1, 0, 1.3, z));
  }
  return merge(parts);
}

export interface PropsView {
  group: Group;
  /** Moves cars between their near and far models as the camera moves. */
  update(camera: Vector3): void;
}

export function buildProps(props: readonly MapProp[], lib: MaterialLibrary): PropsView {
  const group = new Group();
  group.name = 'props';
  const byKind = new Map<string, { kind: PropKind; variant: string; list: MapProp[] }>();
  for (const p of props) {
    const variant = variantOf(p);
    const key = `${p.kind}:${variant}`;
    let entry = byKind.get(key);
    if (!entry) {
      entry = { kind: p.kind, variant, list: [] };
      byKind.set(key, entry);
    }
    entry.list.push(p);
  }
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const colour = new Color();
  const lods: CarLod[] = [];
  for (const { kind, variant, list } of byKind.values()) {
    if (kind === 'rangeSign') {
      for (const p of list) group.add(rangeSign(p, lib));
      continue;
    }
    if (kind === 'car') {
      const lod = new CarLod(list, variant === 'saloon' ? 'saloon' : 'hatch', lib, group);
      // Everything in the far model until the first camera update: the warm-up compiles both.
      lod.update(new Vector3(Infinity, 0, Infinity));
      lods.push(lod);
      continue;
    }
    for (const part of partsFor(kind, variant, lib)) {
      const mesh = new InstancedMesh(part.geometry, part.material, list.length);
      mesh.name = `prop-${kind}`;
      mesh.castShadow = part.castShadow ?? true;
      mesh.receiveShadow = true;
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.yawRad);
        m.compose(new Vector3(p.pos.x, p.pos.y, p.pos.z), q, new Vector3(p.scale, p.scale, p.scale));
        mesh.setMatrixAt(i, m);
        if (part.tinted) mesh.setColorAt(i, colour.setHex(carColour(p.colourIndex)));
      });
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
  return {
    group,
    update(camera: Vector3): void {
      for (const lod of lods) lod.update(camera);
    },
  };
}

/** Range distance board: a painted board on a post, the distance in metres on it. */
function rangeSign(p: MapProp, lib: MaterialLibrary): Group {
  const g = new Group();
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable for range sign labels');
  ctx.fillStyle = '#d6d6d0'; // sheet road paint: never pure white
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#2b2b2c'; // sheet soot: never pure black
  ctx.font = 'bold 92px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.label ?? '', 128, 68);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const board = new Mesh(new BoxGeometry(1.2, 0.6, 0.04), new MeshStandardNodeMaterial({ map: tex, roughness: 0.6 }));
  board.position.set(0, 1.3, 0);
  const post = new Mesh(new BoxGeometry(0.08, 1.1, 0.08), lib.look('wood').material);
  post.position.set(0, 0.55, 0.03);
  board.castShadow = post.castShadow = true;
  g.add(board, post);
  g.position.set(p.pos.x, p.pos.y, p.pos.z);
  g.rotation.y = p.yawRad;
  return g;
}
