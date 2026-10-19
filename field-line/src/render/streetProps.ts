import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxGeometry, BufferAttribute, type BufferGeometry, Color, CylinderGeometry, LatheGeometry, type Material, MeshStandardNodeMaterial, SphereGeometry, Vector2 } from 'three/webgpu';
import type { PropKind } from '../maps/types.ts';
import { swayingMaterial } from './foliage.ts';
import type { MaterialLibrary } from './materials.ts';
import { streetTreeGeometry } from './streetTree.ts';

// The small things a lived-in street is full of, which a city of façades,
// cars and lamp posts still lacked against the reference footage (a three.js
// city whose plaza holds a statue, a kiosk with its awning, planters, café
// tables and roadworks): a newsstand with magazines on its racks, concrete
// planters with clipped shrubs, bollards, bus shelters, red-and-white road
// barriers and cones, hydrants, café tables under striped parasols, and a war
// memorial. Each is a handful of parts coloured per vertex, so a kind is one
// instanced draw per material (props.ts); sizes from the real things.
//
// Local frame: y up, the front (the side people use) toward +z.

/** One instanced draw of a prop: geometry, material, whether it casts a shadow. */
export interface StreetPart {
  geometry: BufferGeometry;
  material: Material;
  castShadow?: boolean;
}

type G = BufferGeometry;

/** Keeps position and normal, adds a uniform `color` (linear, from an sRGB hex). */
function tint(g: G, hex: number): G {
  const n = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(n.attributes)) if (key !== 'position' && key !== 'normal') n.deleteAttribute(key);
  const c = new Color(hex);
  const count = n.getAttribute('position').count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) col.set([c.r, c.g, c.b], i * 3);
  n.setAttribute('color', new BufferAttribute(col, 3));
  return n;
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number, hex: number): G {
  return tint(new BoxGeometry(sx, sy, sz).translate(x, y, z), hex);
}

function cyl(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, hex: number, seg = 12): G {
  return tint(new CylinderGeometry(rTop, rBottom, h, seg).translate(x, y, z), hex);
}

function merge(list: G[]): G {
  const g = mergeGeometries(list, false);
  if (!g) throw new Error('street prop merge failed: parts have mismatched attributes');
  return g;
}

/** Keeps position, normal and uv (a textured part). */
function plain(g: G): G {
  const n = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(n.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'uv') n.deleteAttribute(key);
  return n;
}

// ------------------------------------------------------------------ materials (vertex-coloured, by finish)

const finishes = new Map<string, MeshStandardNodeMaterial>();

function finish(name: 'paint' | 'plastic' | 'canvas' | 'metal' | 'rubber' | 'granite'): MeshStandardNodeMaterial {
  let m = finishes.get(name);
  if (!m) {
    const spec = { paint: [0.5, 0], plastic: [0.38, 0], canvas: [0.9, 0], metal: [0.38, 1], rubber: [0.92, 0], granite: [0.42, 0] }[name] as [number, number];
    m = new MeshStandardNodeMaterial({ name: `street ${name}`, vertexColors: true, roughness: spec[0], metalness: spec[1] });
    finishes.set(name, m);
  }
  return m;
}

const RED = 0xb02626;
const WHITE = 0xdcd9d0;
const ORANGE = 0xe0601c;
const STEEL_DARK = 0x2a2c2e;

// ------------------------------------------------------------------ the props

function kiosk(lib: MaterialLibrary): StreetPart[] {
  // A newsstand, 2.5 × 2.3 m and 2.6 m to the roof: green steel panels, a hatch over a counter, magazines
  // hanging on the front pillars and the counter, a striped awning.
  const green = 0x2b5a45;
  const p: G[] = [
    box(2.5, 0.12, 2.3, 0, 0.06, 0, 0x6e6c68),
    box(2.4, 2.3, 0.08, 0, 1.27, -1.06, green),
    box(0.08, 2.3, 2.2, -1.16, 1.27, 0, green),
    box(0.08, 2.3, 2.2, 1.16, 1.27, 0, green),
    box(2.4, 0.95, 0.08, 0, 0.6, 1.06, green),
    box(2.4, 0.42, 0.08, 0, 2.21, 1.06, 0x1f3e66),
    box(2.0, 0.08, 0.02, 0, 2.21, 1.11, 0xd8d4c6),
    box(0.3, 0.92, 0.1, -1.05, 1.53, 1.06, green),
    box(0.3, 0.92, 0.1, 1.05, 1.53, 1.06, green),
    box(2.55, 0.05, 0.4, 0, 1.1, 1.2, 0x5b5a56),
    box(2.85, 0.1, 2.75, 0, 2.47, 0.1, 0x3a3b3c),
  ];
  // Magazines: covers in print colours, hung on the pillars and laid on the counter and the low panel.
  const covers = [0xc8342c, 0x2a5aa8, 0xe2c23a, 0x1e1e20, 0xd9d6cc, 0x6b2f84, 0x2e8a4c, 0xe07a2c];
  let k = 0;
  for (const x of [-1.05, 1.05]) {
    for (let r = 0; r < 3; r++) p.push(box(0.2, 0.27, 0.012, x, 1.85 - r * 0.3, 1.12, covers[k++ % covers.length] as number));
  }
  for (let i = 0; i < 9; i++) p.push(box(0.21, 0.012, 0.28, -0.95 + i * 0.235, 1.135, 1.22, covers[(i * 3) % covers.length] as number));
  for (let r = 0; r < 2; r++) for (let i = 0; i < 8; i++) p.push(box(0.2, 0.27, 0.012, -0.9 + i * 0.255, 0.85 - r * 0.32, 1.11, covers[(i + r * 5) % covers.length] as number));
  // The awning: stripes across, sloping down and out from under the roof's front.
  const stripes: G[] = [];
  for (let i = 0; i < 10; i++) stripes.push(box(0.27, 0.015, 0.7, -1.215 + i * 0.27, 0, 0, i % 2 === 0 ? RED : WHITE));
  const awning = merge(stripes).rotateX(0.42).translate(0, 2.27, 1.62);
  const valance: G[] = [];
  for (let i = 0; i < 10; i++) valance.push(box(0.27, 0.16, 0.012, -1.215 + i * 0.27, 2.06, 1.94, i % 2 === 0 ? RED : WHITE));
  return [
    { geometry: merge(p), material: finish('paint') },
    { geometry: merge([awning, ...valance]), material: finish('canvas') },
    { geometry: plain(new BoxGeometry(2.0, 0.85, 0.02).translate(0, 1.55, 0.98)), material: lib.get('darkGlass') },
  ];
}

function planter(lib: MaterialLibrary): StreetPart[] {
  // A cast-concrete trough, 2.2 × 0.55 × 0.9 m, with a box hedge clipped flat on top (the street tree's leaf
  // cards squashed into a block: dense, and it sways a little in the wind like the trees).
  const shell = plain(new BoxGeometry(2.2, 0.55, 0.9).translate(0, 0.275, 0));
  const soil = tint(new BoxGeometry(2.05, 0.02, 0.75).translate(0, 0.5, 0), 0x2e2318);
  const leaves = streetTreeGeometry(11).leaves.clone();
  leaves.computeBoundingBox();
  const bb = leaves.boundingBox;
  if (!bb) throw new Error('hedge geometry has no bounds');
  const sx = 2.0 / (bb.max.x - bb.min.x);
  const sy = 0.55 / (bb.max.y - bb.min.y);
  const sz = 0.72 / (bb.max.z - bb.min.z);
  leaves.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2).scale(sx, sy, sz).translate(0, 0.45, 0);
  return [
    { geometry: shell, material: lib.look('concrete').material },
    { geometry: soil, material: finish('rubber'), castShadow: false },
    { geometry: leaves, material: swayingMaterial(lib.get('leaves'), 0.02) },
  ];
}

function bollard(): StreetPart[] {
  // A steel bollard, 0.95 m, domed, with two reflective bands.
  return [
    {
      geometry: merge([cyl(0.075, 0.075, 0.9, 0, 0.45, 0, STEEL_DARK), tint(new SphereGeometry(0.075, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.9, 0), STEEL_DARK), cyl(0.078, 0.078, 0.05, 0, 0.78, 0, WHITE), cyl(0.078, 0.078, 0.05, 0, 0.68, 0, WHITE)]),
      material: finish('paint'),
    },
  ];
}

function busShelter(lib: MaterialLibrary): StreetPart[] {
  // 3.6 m long, 1.2 m deep, 2.5 m high: four posts, a roof, a glass back and one glass end, an advert box at
  // the other end, a bench along the back. Open toward the kerb (+z).
  const frame = 0x3b3f44;
  const p: G[] = [];
  for (const x of [-1.75, 1.75]) for (const z of [-0.55, 0.55]) p.push(box(0.07, 2.4, 0.07, x, 1.2, z, frame));
  p.push(box(3.8, 0.1, 1.45, 0, 2.45, 0.05, frame), box(3.5, 0.05, 0.05, 0, 2.18, -0.55, frame), box(3.5, 0.05, 0.05, 0, 0.3, -0.55, frame));
  p.push(box(2.2, 0.04, 0.38, -0.3, 0.46, -0.32, 0x8a8f94), box(0.04, 0.42, 0.3, -1.3, 0.24, -0.32, frame), box(0.04, 0.42, 0.3, 0.7, 0.24, -0.32, frame));
  // The advert box at the +x end, its poster faces lit (a coloured panel each side).
  p.push(box(0.14, 1.75, 1.15, 1.75, 1.2, 0, 0x2f3236));
  const poster: G[] = [box(0.01, 1.55, 0.95, 1.83, 1.2, 0, 0x2b78b8), box(0.01, 1.55, 0.95, 1.67, 1.2, 0, 0xd8a43a), box(0.012, 0.35, 0.8, 1.835, 1.55, 0, 0xe8e4da), box(0.012, 0.35, 0.8, 1.665, 0.95, 0, 0xc23a32)];
  return [
    { geometry: merge(p), material: finish('paint') },
    { geometry: merge(poster), material: finish('plastic'), castShadow: false },
    { geometry: merge([plain(new BoxGeometry(3.4, 1.85, 0.02).translate(0, 1.25, -0.56)), plain(new BoxGeometry(0.02, 1.85, 1.05).translate(-1.75, 1.25, 0))]), material: lib.get('darkGlass'), castShadow: false },
  ];
}

function roadBarrier(): StreetPart[] {
  // A plastic road barrier, 1.4 m: a striped board on two A-frame legs.
  const p: G[] = [];
  for (let i = 0; i < 7; i++) p.push(box(0.2, 0.3, 0.05, -0.6 + i * 0.2, 0.8, 0, i % 2 === 0 ? RED : WHITE));
  for (const x of [-0.6, 0.6]) {
    p.push(tint(new BoxGeometry(0.05, 1.0, 0.05).rotateX(0.18).translate(x, 0.5, 0.09), WHITE));
    p.push(tint(new BoxGeometry(0.05, 1.0, 0.05).rotateX(-0.18).translate(x, 0.5, -0.09), WHITE));
    p.push(box(0.08, 0.06, 0.5, x, 0.03, 0, 0x2a2a2a));
  }
  return [{ geometry: merge(p), material: finish('plastic') }];
}

function cone(): StreetPart[] {
  // A traffic cone, 0.75 m: orange body, two white bands, a black square foot.
  const p: G[] = [box(0.4, 0.04, 0.4, 0, 0.02, 0, 0x1e1e1e)];
  const r = (y: number): number => 0.16 - (0.13 * (y - 0.04)) / 0.71;
  const bands: [number, number, number][] = [
    [0.04, 0.3, ORANGE],
    [0.3, 0.4, WHITE],
    [0.4, 0.5, ORANGE],
    [0.5, 0.58, WHITE],
    [0.58, 0.75, ORANGE],
  ];
  for (const [y0, y1, c] of bands) p.push(cyl(r(y1), r(y0), y1 - y0, 0, (y0 + y1) / 2, 0, c, 14));
  return [{ geometry: merge(p), material: finish('plastic') }];
}

function hydrant(): StreetPart[] {
  // A pillar hydrant, 0.8 m: flanged foot, barrel, domed cap with its nut, two side outlets.
  const red = 0xa8241f;
  const p: G[] = [
    cyl(0.14, 0.15, 0.08, 0, 0.04, 0, red),
    cyl(0.1, 0.11, 0.55, 0, 0.35, 0, red),
    cyl(0.125, 0.125, 0.05, 0, 0.62, 0, red),
    tint(new SphereGeometry(0.11, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.645, 0), red),
    cyl(0.03, 0.03, 0.06, 0, 0.78, 0, 0x6d6a64, 6),
    tint(new CylinderGeometry(0.045, 0.045, 0.32, 10).rotateZ(Math.PI / 2).translate(0, 0.45, 0), red),
    tint(new CylinderGeometry(0.055, 0.055, 0.03, 10).rotateZ(Math.PI / 2).translate(0.17, 0.45, 0), 0x6d6a64),
    tint(new CylinderGeometry(0.055, 0.055, 0.03, 10).rotateZ(Math.PI / 2).translate(-0.17, 0.45, 0), 0x6d6a64),
  ];
  return [{ geometry: merge(p), material: finish('paint') }];
}

function cafeSet(): StreetPart[] {
  // A round café table with two chairs and a striped parasol (2.3 m).
  const metal = 0x303235;
  const p: G[] = [cyl(0.4, 0.4, 0.025, 0, 0.74, 0, 0xc8c4ba, 20), cyl(0.025, 0.025, 0.72, 0, 0.37, 0, metal, 8), cyl(0.22, 0.24, 0.02, 0, 0.01, 0, metal, 16), cyl(0.02, 0.02, 2.3, 0, 1.15, 0, 0xdcd9d0, 8)];
  for (const side of [-1, 1]) {
    const x = side * 0.72;
    p.push(box(0.42, 0.03, 0.42, x, 0.46, 0, 0x7a4a2c));
    p.push(box(0.03, 0.42, 0.42, x + side * 0.2, 0.7, 0, 0x7a4a2c));
    for (const lx of [-0.18, 0.18]) for (const lz of [-0.18, 0.18]) p.push(box(0.025, 0.46, 0.025, x + lx, 0.23, lz, metal));
  }
  // The canopy: eight panels in turn red and white (each face coloured by its own angle).
  const canopy = new CylinderGeometry(0.04, 1.35, 0.42, 8, 1, true).translate(0, 2.12, 0).toNonIndexed();
  for (const key of Object.keys(canopy.attributes)) if (key !== 'position' && key !== 'normal') canopy.deleteAttribute(key);
  const pos = canopy.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const red = new Color(RED);
  const white = new Color(WHITE);
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const seg = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 8) % 2;
    const c = seg === 0 ? red : white;
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (t + k) * 3);
  }
  canopy.setAttribute('color', new BufferAttribute(col, 3));
  return [
    { geometry: merge(p), material: finish('paint') },
    { geometry: canopy, material: finish('canvas') },
  ];
}

function memorial(): StreetPart[] {
  // A war memorial: three granite steps, a pedestal with a bronze plaque, a tapering obelisk 5.5 m tall —
  // honed grey granite, the obelisk darker and polished. (The masonry look's coursed stones made it a wall.)
  const steps = [box(3.4, 0.3, 3.4, 0, 0.15, 0, 0x8c8984), box(2.6, 0.3, 2.6, 0, 0.45, 0, 0x85827d), box(1.5, 1.3, 1.5, 0, 1.25, 0, 0x6f6c68), box(1.7, 0.12, 1.7, 0, 1.96, 0, 0x7d7a75)];
  const obelisk = tint(new CylinderGeometry(0.3, 0.5, 5.2, 4, 1).rotateY(Math.PI / 4).translate(0, 4.62, 0), 0x55534f);
  const tip = tint(new CylinderGeometry(0, 0.3, 0.45, 4, 1).rotateY(Math.PI / 4).translate(0, 7.44, 0), 0x55534f);
  const plaque = merge([box(0.9, 0.55, 0.03, 0, 1.3, 0.765, 0x6b5233), box(0.75, 0.05, 0.035, 0, 1.45, 0.77, 0x8a6c44), box(0.75, 0.03, 0.035, 0, 1.3, 0.77, 0x8a6c44), box(0.6, 0.03, 0.035, 0, 1.18, 0.77, 0x8a6c44)]);
  // A wreath laid at the foot of the pedestal.
  const wreath = tint(new LatheGeometry([new Vector2(0.18, 0), new Vector2(0.26, 0.05), new Vector2(0.18, 0.1)], 16).rotateX(0.4).translate(0, 0.75, 0.95), 0x2f4a26);
  return [
    { geometry: merge([...steps, obelisk, tip]), material: finish('granite') },
    { geometry: plaque, material: finish('metal') },
    { geometry: wreath, material: finish('canvas') },
  ];
}

/** The parts of a street prop kind, or null when `kind` is not one of these. */
export function streetPropParts(kind: PropKind, lib: MaterialLibrary): StreetPart[] | null {
  switch (kind) {
    case 'kiosk':
      return kiosk(lib);
    case 'planter':
      return planter(lib);
    case 'bollard':
      return bollard();
    case 'busShelter':
      return busShelter(lib);
    case 'roadBarrier':
      return roadBarrier();
    case 'cone':
      return cone();
    case 'hydrant':
      return hydrant();
    case 'cafeSet':
      return cafeSet();
    case 'memorial':
      return memorial();
    default:
      return null;
  }
}
