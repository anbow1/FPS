import { abs, attribute, float, mix, mx_noise_float, positionGeometry, smoothstep, step, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, Color, ConeGeometry, CylinderGeometry, Group, InstancedMesh, LatheGeometry, Matrix4, MeshPhysicalNodeMaterial, type Node, SphereGeometry, Vector2 } from 'three/webgpu';
import type { SpeciesId } from '../config.ts';
import type { Creature } from '../game/fauna.ts';
import { merge } from './meshkit.ts';

// The lagoon's animals as articulated figures of rigid segments, each segment
// one InstancedMesh per species shared by every animal of it, posed per frame
// from the logic's state (game/fauna.ts) — no skinning, no animation clips:
//
//   tiger  a gait whose leg phases follow the speed (a walk's lateral sequence
//          blending into a rotary gallop), the body lowered and the head down
//          while stalking, legs flung out in the leap, the tail swinging; the
//          coat's stripes drawn by the shader round the body and the limbs.
//   boar   a trot on short legs, head down to charge, tusks, a bristled coat.
//   croc   a lateral wave down the body and tail (stronger swimming), legs
//          tucked back in the water and sprawled on land, the jaw open in a
//          lunge, the death roll.
//   shark  a tail beat running down the body with speed, banking into turns,
//          the dorsal fin cutting the surface when it swims shallow.
//
// The dead fall on their side (tiger, boar) or turn belly up (croc, shark).
// Sizes follow the hit spheres (game/fauna.ts), so what you see is what you hit.

const MAX_PER_SPECIES = 8;

type Kind = 0 | 1 | 2 | 3 | 4 | 5;
/** Plain hard parts (eyes, teeth, claws, nose): the tint as is. */
const PLAIN: Kind = 0;
/** Tiger coat, stripes across the segment's long (z) axis. */
const STRIPE_Z: Kind = 1;
/** Tiger coat on limbs and the tail: stripes across the y axis. */
const STRIPE_Y: Kind = 2;
/** Bristled coat: coarse light and dark hairs. */
const BRISTLE: Kind = 3;
/** Crocodile hide: scale plates, darker on the back. */
const SCUTE: Kind = 4;
/** Shark skin: countershaded, smooth. */
const SKIN: Kind = 5;

// ------------------------------------------------------------------ the shared material

function creatureMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'creature', metalness: 0, sheenRoughness: 0.7 });
  const tint = attribute('tint', 'vec3');
  const kind = attribute('kind', 'float');
  // Each segment's own (pre-instance) space: positionLocal is already instanced here, so patterns keyed
  // to it would crawl over a moving animal and the countershading would follow world height.
  const p = positionGeometry;
  const is = (k: number): Node<'float'> => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  // Tiger stripes: narrow dark bands round the body, broken and forked by noise.
  const n1 = mx_noise_float(p.mul(3.1));
  const bandZ = abs(mx_noise_float(vec3(p.z.mul(9), p.x.mul(1.2).add(n1.mul(0.9)), p.y.mul(1.4))));
  const bandY = abs(mx_noise_float(vec3(p.y.mul(11), p.x.mul(1.5).add(n1), p.z.mul(1.5))));
  const stripeZ = smoothstep(0.1, 0.05, bandZ);
  const stripeY = smoothstep(0.09, 0.045, bandY);
  const stripe = mix(stripeZ, stripeY, is(2)).mul(is(1).add(is(2)));
  // Boar bristles: fine dark and pale hairs.
  const hair = mx_noise_float(p.mul(vec3(90, 40, 90)));
  const bristle = mix(float(0.7), float(1.25), smoothstep(-0.3, 0.4, hair)).mul(is(3)).add(float(1).sub(is(3)));
  // Crocodile scutes: a cell pattern, the gaps darker; the belly (local −y) pale.
  const cells = abs(mx_noise_float(p.mul(vec3(14, 6, 14))));
  const scute = mix(float(0.55), float(1.05), smoothstep(0.02, 0.12, cells));
  const belly = smoothstep(-0.03, -0.11, p.y);
  const crocColour = mix(tint.mul(scute), vec3(0.32, 0.3, 0.2), belly.mul(0.8));
  // Shark: slate grey above, white below, a soft line between.
  const under = smoothstep(0.03, -0.05, p.y);
  const sharkColour = mix(tint, vec3(0.62, 0.62, 0.6), under);
  let colour = mix(tint.mul(bristle), vec3(0.015, 0.012, 0.01), stripe.mul(0.92));
  colour = mix(colour, crocColour, is(4));
  colour = mix(colour, sharkColour, is(5));
  m.colorNode = colour;
  // Fur is matte with sheen; hide a little shinier; wet shark skin smooth; eyes and teeth glossy.
  const fur = is(1).add(is(2)).add(is(3));
  m.roughnessNode = mix(mix(mix(float(0.35), float(0.85), fur), float(0.6), is(4)), float(0.42), is(5));
  m.sheenNode = colour.mul(fur.mul(0.5));
  return m;
}

// ------------------------------------------------------------------ geometry helpers

function linear(hex: number): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

function tag(g: BufferGeometry, hex: number, kind: Kind): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  const count = n.getAttribute('position').count;
  const [r, gr, b] = linear(hex);
  const tint = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) tint.set([r, gr, b], i * 3);
  n.setAttribute('tint', new BufferAttribute(tint, 3));
  n.setAttribute('kind', new BufferAttribute(new Float32Array(count).fill(kind), 1));
  return n;
}

function joined(parts: BufferGeometry[], name: string): BufferGeometry {
  const tints: number[] = [];
  const kinds: number[] = [];
  for (const p of parts) {
    tints.push(...(p.getAttribute('tint').array as Float32Array));
    kinds.push(...(p.getAttribute('kind').array as Float32Array));
  }
  const g = merge(parts, name);
  g.setAttribute('tint', new BufferAttribute(new Float32Array(tints), 3));
  g.setAttribute('kind', new BufferAttribute(new Float32Array(kinds), 1));
  return g;
}

/** An ellipsoid of semi-axes (x, y, z) centred at (cx, cy, cz). */
function ell(x: number, y: number, z: number, cx = 0, cy = 0, cz = 0, seg = 14): BufferGeometry {
  return new SphereGeometry(1, seg, Math.max(6, Math.round(seg * 0.65))).scale(x, y, z).translate(cx, cy, cz);
}

/** A limb hanging down local −y from the origin: tapered, rounded at both ends. */
function limb(length: number, r0: number, r1: number): BufferGeometry {
  return merge([new CylinderGeometry(r0, r1, length, 10, 1, true).translate(0, -length / 2, 0), new SphereGeometry(r0, 10, 7), new SphereGeometry(r1, 10, 7).translate(0, -length, 0)], 'limb');
}

/**
 * A body of revolution along +Z from `z0` (front) to `z0 + length` (back), radii from front to back,
 * flattened by `flatY`. The animals face −Z, so the front is the more negative end.
 */
function along(z0: number, radii: [number, number][], flatY = 1, seg = 16): BufferGeometry {
  return new LatheGeometry(
    radii.map(([r, t]) => new Vector2(Math.max(r, 0.0005), t)),
    seg,
  )
    .rotateX(Math.PI / 2)
    .scale(1, flatY, 1)
    .translate(0, 0, z0);
}

// ------------------------------------------------------------------ pose stack

class Pose {
  private readonly stack: Matrix4[] = [];
  m = new Matrix4();
  private readonly tmp = new Matrix4();

  set(root: Matrix4): this {
    this.m.copy(root);
    this.stack.length = 0;
    return this;
  }

  push(): this {
    this.stack.push(this.m.clone());
    return this;
  }

  pop(): this {
    const top = this.stack.pop();
    if (top) this.m.copy(top);
    return this;
  }

  t(x: number, y: number, z: number): this {
    this.m.multiply(this.tmp.makeTranslation(x, y, z));
    return this;
  }

  rx(a: number): this {
    this.m.multiply(this.tmp.makeRotationX(a));
    return this;
  }

  ry(a: number): this {
    this.m.multiply(this.tmp.makeRotationY(a));
    return this;
  }

  rz(a: number): this {
    this.m.multiply(this.tmp.makeRotationZ(a));
    return this;
  }

  s(k: number): this {
    this.m.multiply(this.tmp.makeScale(k, k, k));
    return this;
  }

  emit(mesh: InstancedMesh, index: number): this {
    mesh.setMatrixAt(index, this.m);
    return this;
  }
}

// ------------------------------------------------------------------ species models

interface SpeciesModel {
  meshes: Record<string, InstancedMesh>;
  /** Instances per creature of each segment. */
  per: Record<string, number>;
}

const COLOURS = {
  tiger: 0xc2621c,
  tigerWhite: 0xe8dfcc,
  nose: 0x5a3a34,
  eye: 0xb88a28,
  dark: 0x16120e,
  tooth: 0xe8e2d0,
  claw: 0x2a2620,
  boar: 0x3e342c,
  snout: 0x6a524a,
  croc: 0x4a5034,
  shark: 0x5c6670,
} as const;

function tigerGeometry(): Record<string, BufferGeometry> {
  const T = COLOURS;
  return {
    // The chest carries the barrel of the belly back to the hips: two ellipsoids end to end pinch at the waist.
    chest: joined(
      [
        tag(ell(0.25, 0.32, 0.5, 0, 0, 0), T.tiger, STRIPE_Z),
        tag(ell(0.2, 0.16, 0.42, 0, -0.18, 0.02), T.tigerWhite, STRIPE_Z),
        tag(ell(0.235, 0.27, 0.44, 0, -0.01, 0.38), T.tiger, STRIPE_Z),
        tag(ell(0.17, 0.12, 0.36, 0, -0.16, 0.38), T.tigerWhite, STRIPE_Z),
      ],
      'tiger chest',
    ),
    hips: joined([tag(ell(0.24, 0.28, 0.46, 0, 0, 0), T.tiger, STRIPE_Z), tag(ell(0.18, 0.13, 0.36, 0, -0.16, -0.02), T.tigerWhite, STRIPE_Z)], 'tiger hips'),
    neck: joined([tag(ell(0.17, 0.2, 0.26, 0, 0, -0.1), T.tiger, STRIPE_Z), tag(ell(0.14, 0.12, 0.2, 0, -0.1, -0.12), T.tigerWhite, STRIPE_Z)], 'tiger neck'),
    head: joined(
      [
        tag(ell(0.16, 0.15, 0.17, 0, 0, 0), T.tiger, STRIPE_Z),
        // Cheek ruffs and the white of the muzzle and over the eyes.
        tag(ell(0.08, 0.08, 0.1, -0.11, -0.04, 0.0), T.tigerWhite, STRIPE_Z),
        tag(ell(0.08, 0.08, 0.1, 0.11, -0.04, 0.0), T.tigerWhite, STRIPE_Z),
        tag(ell(0.095, 0.075, 0.11, 0, -0.04, -0.15), T.tigerWhite, PLAIN),
        tag(ell(0.06, 0.035, 0.03, 0, 0.0, -0.245), T.nose, PLAIN),
        tag(ell(0.022, 0.016, 0.012, -0.065, 0.055, -0.145), T.eye, PLAIN),
        tag(ell(0.022, 0.016, 0.012, 0.065, 0.055, -0.145), T.eye, PLAIN),
        tag(new ConeGeometry(0.045, 0.07, 8).translate(-0.1, 0.15, 0.04), T.tiger, PLAIN),
        tag(new ConeGeometry(0.045, 0.07, 8).translate(0.1, 0.15, 0.04), T.tiger, PLAIN),
        tag(ell(0.03, 0.03, 0.01, -0.1, 0.14, 0.025), T.dark, PLAIN),
        tag(ell(0.03, 0.03, 0.01, 0.1, 0.14, 0.025), T.dark, PLAIN),
        // Upper canines, seen when the jaw drops.
        tag(new ConeGeometry(0.01, 0.05, 6).rotateX(Math.PI).translate(-0.035, -0.09, -0.21), T.tooth, PLAIN),
        tag(new ConeGeometry(0.01, 0.05, 6).rotateX(Math.PI).translate(0.035, -0.09, -0.21), T.tooth, PLAIN),
      ],
      'tiger head',
    ),
    // Lower jaw, hinged at its back end (origin), along −Z.
    jaw: joined([tag(ell(0.07, 0.035, 0.12, 0, -0.02, -0.11), T.tigerWhite, PLAIN), tag(ell(0.05, 0.02, 0.09, 0, 0.012, -0.12), 0x7a2a2a, PLAIN)], 'tiger jaw'),
    upperFore: joined([tag(limb(0.34, 0.13, 0.09), T.tiger, STRIPE_Y)], 'tiger upper fore'),
    lowerFore: joined([tag(limb(0.36, 0.085, 0.068), T.tiger, STRIPE_Y)], 'tiger lower fore'),
    upperHind: joined([tag(limb(0.38, 0.155, 0.095), T.tiger, STRIPE_Y)], 'tiger upper hind'),
    lowerHind: joined([tag(limb(0.4, 0.08, 0.06), T.tiger, STRIPE_Y)], 'tiger lower hind'),
    paw: joined([tag(ell(0.07, 0.04, 0.09, 0, -0.02, -0.03), T.tigerWhite, STRIPE_Y), tag(ell(0.05, 0.012, 0.02, 0, -0.035, -0.11), T.claw, PLAIN)], 'tiger paw'),
    // Tail segments hang along −Y from the origin; the last one ends in a black tip.
    tail: joined([tag(limb(0.25, 0.045, 0.04), T.tiger, STRIPE_Y)], 'tiger tail'),
    tailTip: joined([tag(limb(0.22, 0.04, 0.03), T.dark, PLAIN)], 'tiger tail tip'),
  };
}

function boarGeometry(): Record<string, BufferGeometry> {
  const B = COLOURS;
  return {
    body: joined(
      [
        tag(ell(0.24, 0.3, 0.55, 0, 0, 0), B.boar, BRISTLE),
        // The high shoulders and the mane of a boar.
        tag(ell(0.21, 0.24, 0.25, 0, 0.12, -0.25), B.boar, BRISTLE),
        tag(ell(0.05, 0.08, 0.35, 0, 0.32, -0.15), 0x1e1a16, BRISTLE),
      ],
      'boar body',
    ),
    head: joined(
      [
        // A wedge from the poll to the snout disc, along −Z.
        tag(along(-0.43, [[0.001, 0], [0.07, 0.01], [0.1, 0.11], [0.15, 0.29], [0.15, 0.39], [0.001, 0.43]], 0.95), B.boar, BRISTLE),
        tag(new CylinderGeometry(0.065, 0.065, 0.03, 14).rotateX(Math.PI / 2).translate(0, 0, -0.43), B.snout, PLAIN),
        tag(ell(0.012, 0.012, 0.012, -0.025, 0.0, -0.447), B.dark, PLAIN),
        tag(ell(0.012, 0.012, 0.012, 0.025, 0.0, -0.447), B.dark, PLAIN),
        // Tusks curving up out of the jaw.
        tag(new ConeGeometry(0.014, 0.08, 6).rotateX(-0.7).translate(-0.07, 0.02, -0.33), B.tooth, PLAIN),
        tag(new ConeGeometry(0.014, 0.08, 6).rotateX(-0.7).translate(0.07, 0.02, -0.33), B.tooth, PLAIN),
        tag(ell(0.015, 0.015, 0.01, -0.08, 0.07, -0.18), 0x0c0a08, PLAIN),
        tag(ell(0.015, 0.015, 0.01, 0.08, 0.07, -0.18), 0x0c0a08, PLAIN),
        tag(new ConeGeometry(0.05, 0.11, 6).rotateX(0.4).translate(-0.1, 0.15, 0.0), B.boar, BRISTLE),
        tag(new ConeGeometry(0.05, 0.11, 6).rotateX(0.4).translate(0.1, 0.15, 0.0), B.boar, BRISTLE),
      ],
      'boar head',
    ),
    upperLeg: joined([tag(limb(0.22, 0.07, 0.045), B.boar, BRISTLE)], 'boar upper leg'),
    lowerLeg: joined([tag(limb(0.22, 0.035, 0.028), B.boar, BRISTLE)], 'boar lower leg'),
    hoof: joined([tag(ell(0.03, 0.03, 0.04, 0, -0.02, -0.01), 0x1a1612, PLAIN)], 'boar hoof'),
    tail: joined([tag(limb(0.16, 0.018, 0.01), 0x1e1a16, BRISTLE)], 'boar tail'),
  };
}

function crocGeometry(): Record<string, BufferGeometry> {
  const K = COLOURS;
  const ridgeColour = 0x2e3222;
  return {
    // Head: from its back (the origin, the jaw's hinge) forward 0.66 m to the snout, flat.
    head: joined(
      [
        tag(along(-0.66, [[0.001, 0], [0.09, 0.04], [0.12, 0.21], [0.18, 0.41], [0.19, 0.6], [0.001, 0.66]], 0.42), K.croc, SCUTE),
        // Eyes and nostrils standing proud: what shows above the water.
        tag(ell(0.035, 0.03, 0.04, -0.075, 0.075, -0.1), 0x3a3a24, SCUTE),
        tag(ell(0.035, 0.03, 0.04, 0.075, 0.075, -0.1), 0x3a3a24, SCUTE),
        tag(ell(0.018, 0.014, 0.014, -0.075, 0.09, -0.12), 0xc8a030, PLAIN),
        tag(ell(0.018, 0.014, 0.014, 0.075, 0.09, -0.12), 0xc8a030, PLAIN),
        tag(ell(0.04, 0.025, 0.03, 0, 0.045, -0.62), 0x3a3a24, SCUTE),
        // A row of teeth along each side.
        ...[-1, 1].flatMap((sx) => [0.18, 0.28, 0.38, 0.48, 0.56].map((z) => tag(new ConeGeometry(0.008, 0.03, 5).rotateX(Math.PI).translate(sx * (0.17 - z * 0.13), -0.03, -z), K.tooth, PLAIN))),
      ],
      'croc head',
    ),
    jaw: joined([tag(along(-0.62, [[0.001, 0], [0.07, 0.02], [0.1, 0.17], [0.16, 0.37], [0.17, 0.57], [0.001, 0.62]], 0.25).translate(0, -0.03, 0), K.croc, SCUTE), tag(ell(0.1, 0.01, 0.28, 0, -0.012, -0.3), 0x8a6a50, PLAIN)], 'croc jaw'),
    // Body: neck to hips, 1.7 m, centred on its origin, with two ridges of scutes down the back.
    body: joined(
      [
        tag(ell(0.38, 0.2, 0.85), K.croc, SCUTE),
        tag(ell(0.025, 0.05, 0.75, -0.13, 0.17, 0, 8), ridgeColour, SCUTE),
        tag(ell(0.025, 0.05, 0.75, 0.13, 0.17, 0, 8), ridgeColour, SCUTE),
        tag(ell(0.22, 0.14, 0.3, 0, 0.0, -0.8), K.croc, SCUTE), // the neck into the head
      ],
      'croc body',
    ),
    // One tail segment: 0.42 m back (+Z) from its joint, tapering, a scute crest on top.
    tail: joined([tag(along(0, [[0.2, 0], [0.17, 0.4], [0.001, 0.42]], 0.75), K.croc, SCUTE), tag(ell(0.018, 0.06, 0.18, 0, 0.13, 0.2, 8), ridgeColour, SCUTE)], 'croc tail'),
    upperLeg: joined([tag(limb(0.22, 0.07, 0.05), K.croc, SCUTE)], 'croc upper leg'),
    lowerLeg: joined([tag(limb(0.2, 0.05, 0.035), K.croc, SCUTE)], 'croc lower leg'),
    foot: joined([tag(ell(0.06, 0.02, 0.08, 0, -0.01, -0.05), K.croc, SCUTE)], 'croc foot'),
  };
}

function sharkGeometry(): Record<string, BufferGeometry> {
  const S = COLOURS.shark;
  return {
    // Head: from the gills (its joint, the origin) forward 0.8 m to the snout.
    head: joined(
      [
        tag(along(-0.8, [[0.001, 0], [0.12, 0.08], [0.22, 0.3], [0.27, 0.6], [0.28, 0.8]], 0.85), S, SKIN),
        tag(ell(0.022, 0.022, 0.012, -0.15, 0.05, -0.38), 0x0a0a0a, PLAIN),
        tag(ell(0.022, 0.022, 0.012, 0.15, 0.05, -0.38), 0x0a0a0a, PLAIN),
        // Gill slits just ahead of the joint.
        ...[-1, 1].flatMap((sx) => [0.05, 0.1, 0.15, 0.2].map((z) => tag(ell(0.004, 0.07, 0.008, sx * 0.265, -0.01, -z), 0x2a3036, PLAIN))),
      ],
      'shark head',
    ),
    // The lower jaw under the head, hinged at its back.
    jaw: joined([tag(along(-0.42, [[0.001, 0], [0.1, 0.08], [0.17, 0.42]], 0.35).translate(0, -0.12, -0.1), 0x9a9a98, SKIN), ...[-0.08, -0.04, 0, 0.04, 0.08].map((x) => tag(new ConeGeometry(0.008, 0.03, 4).translate(x, -0.08, -0.45 + Math.abs(x)), COLOURS.tooth, PLAIN))], 'shark jaw'),
    // Body: the gills back to the second dorsal, 0.8 m, with the dorsal fin and the pectorals.
    body: joined(
      [
        tag(along(0, [[0.28, 0], [0.3, 0.35], [0.24, 0.8]], 0.9), S, SKIN),
        tag(new ConeGeometry(0.2, 0.42, 4, 1).scale(0.12, 1, 1).rotateX(-0.5).translate(0, 0.42, 0.3), S, SKIN),
        tag(new ConeGeometry(0.16, 0.5, 4, 1).scale(1, 0.12, 1).rotateZ(Math.PI / 2 + 0.35).rotateY(0.4).translate(-0.42, -0.1, 0.12), S, SKIN),
        tag(new ConeGeometry(0.16, 0.5, 4, 1).scale(1, 0.12, 1).rotateZ(-Math.PI / 2 - 0.35).rotateY(-0.4).translate(0.42, -0.1, 0.12), S, SKIN),
      ],
      'shark body',
    ),
    rear: joined([tag(along(0, [[0.24, 0], [0.15, 0.5], [0.07, 0.7]], 0.85), S, SKIN), tag(new ConeGeometry(0.06, 0.12, 4).scale(0.15, 1, 1).rotateX(-0.5).translate(0, 0.2, 0.35), S, SKIN)], 'shark rear'),
    // Caudal fin on a short keel: the upper lobe long and swept back, the lower shorter.
    tail: joined(
      [
        // Broad at the root (a narrow cone reads as a stick from any angle off the side).
        tag(new ConeGeometry(0.19, 0.68, 4, 1).scale(0.1, 1, 1).rotateX(0.95).translate(0, 0.24, 0.2), S, SKIN),
        tag(new ConeGeometry(0.14, 0.4, 4, 1).scale(0.1, 1, 1).rotateX(Math.PI - 0.85).translate(0, -0.15, 0.13), S, SKIN),
        tag(ell(0.06, 0.07, 0.12, 0, 0, 0.06, 8), S, SKIN),
      ],
      'shark tail',
    ),
  };
}

function buildModel(geos: Record<string, BufferGeometry>, per: Record<string, number>, material: MeshPhysicalNodeMaterial, group: Group, name: string): SpeciesModel {
  const meshes: Record<string, InstancedMesh> = {};
  for (const [seg, g] of Object.entries(geos)) {
    const mesh = new InstancedMesh(g, material, MAX_PER_SPECIES * (per[seg] ?? 1));
    mesh.name = `${name}-${seg}`;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    meshes[seg] = mesh;
    group.add(mesh);
  }
  return { meshes, per };
}

// ------------------------------------------------------------------ the view

export class CreatureView {
  readonly group = new Group();
  private readonly models: Record<SpeciesId, SpeciesModel>;
  private readonly phase = new Map<number, number>();
  private readonly pose = new Pose();
  private readonly root = new Matrix4();
  private readonly tmp = new Matrix4();
  private time = 0;

  constructor() {
    this.group.name = 'creatures';
    const mat = creatureMaterial();
    this.models = {
      tiger: buildModel(tigerGeometry(), { upperFore: 2, lowerFore: 2, upperHind: 2, lowerHind: 2, paw: 4, tail: 3 }, mat, this.group, 'tiger'),
      boar: buildModel(boarGeometry(), { upperLeg: 4, lowerLeg: 4, hoof: 4 }, mat, this.group, 'boar'),
      croc: buildModel(crocGeometry(), { tail: 5, upperLeg: 4, lowerLeg: 4, foot: 4 }, mat, this.group, 'croc'),
      shark: buildModel(sharkGeometry(), {}, mat, this.group, 'shark'),
    };
  }

  update(creatures: readonly Creature[], alpha: number, dt: number): void {
    this.time += dt;
    const counts: Record<SpeciesId, number> = { tiger: 0, boar: 0, croc: 0, shark: 0 };
    for (const c of creatures) {
      const i = counts[c.kind];
      if (i >= MAX_PER_SPECIES) continue;
      counts[c.kind] = i + 1;
      // Gait phase: one stride per body length or so, faster with speed.
      const stride = c.kind === 'tiger' ? (c.speedMs > 4 ? 2.6 : 1.4) : c.kind === 'boar' ? 0.9 : c.kind === 'croc' ? 1.6 : 2.2;
      let ph = this.phase.get(c.id) ?? c.id * 1.3;
      if (c.alive) ph += ((c.speedMs + (c.kind === 'shark' || (c.kind === 'croc' && c.submerge > 0.3) ? 0.6 : 0)) / stride) * Math.PI * 2 * dt;
      this.phase.set(c.id, ph);
      const x = c.prev.x + (c.pos.x - c.prev.x) * alpha;
      const y = c.prev.y + (c.pos.y - c.prev.y) * alpha;
      const z = c.prev.z + (c.pos.z - c.prev.z) * alpha;
      const yaw = c.prevYawRad + wrap(c.yawRad - c.prevYawRad) * alpha;
      this.root.makeTranslation(x, y, z).multiply(this.tmp.makeRotationY(yaw));
      const turn = wrap(c.yawRad - c.prevYawRad) / Math.max(dt, 1e-3);
      if (c.kind === 'tiger') this.tiger(c, i, ph, turn);
      else if (c.kind === 'boar') this.boar(c, i, ph);
      else if (c.kind === 'croc') this.croc(c, i, ph);
      else this.shark(c, i, ph, turn);
    }
    for (const kind of Object.keys(this.models) as SpeciesId[]) {
      const model = this.models[kind];
      for (const [seg, mesh] of Object.entries(model.meshes)) {
        mesh.count = counts[kind] * (model.per[seg] ?? 1);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.phase.size > 64) this.phase.clear();
  }

  /** The dead: tipped onto their side over ~0.8 s. */
  private fallen(c: Creature): number {
    if (c.alive) return 0;
    const t = Math.min(1, c.deathS / 0.8);
    return t * t;
  }

  private tiger(c: Creature, i: number, ph: number, turn: number): void {
    const M = this.models.tiger.meshes;
    const P = this.pose;
    const fall = this.fallen(c);
    const crouch = c.crouch;
    const run = Math.min(1, Math.max(0, (c.speedMs - 2.5) / 6));
    const air = c.airborne;
    const amp = (0.25 + 0.45 * run) * Math.min(1, c.speedMs / 1.2);
    const bodyY = 0.86 - crouch * 0.28 - fall * 0.52 + Math.abs(Math.sin(ph)) * 0.03 * run;
    P.set(this.root).rz(fall * 1.45).t(0, bodyY, 0).rx(c.pitchRad - run * 0.04 + crouch * 0.05);
    const flex = Math.sin(ph * 2) * 0.06 * run;
    // Chest and hips, flexing at the spine in a gallop.
    P.push().t(0, 0.02, -0.38).rx(flex).emit(M.chest as InstancedMesh, i);
    // Neck and head, low and level while stalking, up and forward running, the jaw open to strike.
    P.push()
      .t(0, 0.12, -0.42)
      .rx(-0.35 + crouch * 0.45 - run * 0.2)
      .emit(M.neck as InstancedMesh, i)
      .t(0, 0.02, -0.28)
      .rx(0.35 - crouch * 0.4 + run * 0.15 + Math.sin(this.time * 0.6 + c.id) * 0.05)
      .ry(turn * 0.08)
      .emit(M.head as InstancedMesh, i)
      .t(0, -0.075, -0.06)
      .rx(c.jaw * 0.7)
      .emit(M.jaw as InstancedMesh, i)
      .pop();
    // Fore legs from the shoulders.
    for (const side of [0, 1] as const) {
      const sx = side === 0 ? -1 : 1;
      // Walk: lateral sequence; gallop: rotary, the fore pair close in phase.
      const off = (side === 0 ? 0.25 : 0.75) * (1 - run) + (side === 0 ? 0 : 0.12) * run;
      const a = ph + off * Math.PI * 2;
      const swing = air > 0 ? -0.9 * air : Math.sin(a) * amp;
      const lift = air > 0 ? 0.2 : Math.max(0, Math.cos(a)) * amp * 1.3;
      P.push()
        .t(sx * 0.14, -0.05, -0.22)
        .rx(swing - flex - 0.3 - crouch * 0.9)
        .emit(M.upperFore as InstancedMesh, i * 2 + side)
        .t(0, -0.34, 0)
        .rx(0.3 + crouch * 1.4 - lift)
        .emit(M.lowerFore as InstancedMesh, i * 2 + side)
        .t(0, -0.36, 0)
        .rx(lift - swing + flex - crouch * 0.5)
        .emit(M.paw as InstancedMesh, i * 4 + side)
        .pop();
    }
    P.pop();
    P.push().t(0, 0, 0.36).rx(-flex).ry(-turn * 0.06).emit(M.hips as InstancedMesh, i);
    for (const side of [0, 1] as const) {
      const sx = side === 0 ? -1 : 1;
      const off = (side === 0 ? 0 : 0.5) * (1 - run) + (side === 0 ? 0.5 : 0.62) * run;
      const a = ph + off * Math.PI * 2;
      const swing = air > 0 ? 0.9 * air : Math.sin(a) * amp;
      const lift = air > 0 ? 0.3 : Math.max(0, Math.cos(a)) * amp * 1.2;
      P.push()
        .t(sx * 0.15, 0.0, 0.15)
        .rx(swing + 0.3 + flex + crouch * 0.5)
        .emit(M.upperHind as InstancedMesh, i * 2 + side)
        .t(0, -0.38, 0)
        .rx(-0.55 - lift * 0.5 - crouch * 1.1)
        .emit(M.lowerHind as InstancedMesh, i * 2 + side)
        .t(0, -0.4, 0)
        .rx(0.25 - swing - flex + lift * 0.5 + crouch * 0.6)
        .emit(M.paw as InstancedMesh, i * 4 + 2 + side)
        .pop();
    }
    // The tail: down and back from the rump (a negative rx swings the hanging −Y back), swinging,
    // the end curling up; held out level behind at a run, the tip twitching while it stalks.
    P.push().t(0, 0.12, 0.42).rx(-0.45 - run * 0.75 - crouch * 0.15);
    for (let k = 0; k < 4; k++) {
      const twitch = k === 3 ? Math.sin(this.time * 5.3 + c.id) * 0.3 * crouch : 0;
      const sway = Math.sin(this.time * 1.7 - k * 0.7 + c.id) * (0.12 + 0.08 * k) * (1 - fall) + twitch;
      P.rz(sway).rx(-0.12 - (k === 3 ? 0.35 : 0));
      if (k < 3) P.emit(M.tail as InstancedMesh, i * 3 + k).t(0, -0.24, 0);
      else P.emit(M.tailTip as InstancedMesh, i);
    }
    P.pop();
    P.pop();
  }

  private boar(c: Creature, i: number, ph: number): void {
    const M = this.models.boar.meshes;
    const P = this.pose;
    const fall = this.fallen(c);
    const charging = c.state === 'charge';
    const amp = Math.min(0.6, c.speedMs * 0.11);
    const bodyY = 0.52 - fall * 0.28 + Math.abs(Math.sin(ph * 2)) * 0.02 * amp;
    P.set(this.root).rz(fall * 1.45).t(0, bodyY, 0).emit(M.body as InstancedMesh, i);
    // Head: rooting down at rest, low and forward to charge.
    const root = c.state === 'idle' ? 0.35 + Math.sin(this.time * 2 + c.id) * 0.12 : 0;
    P.push().t(0, 0.05, -0.5).rx(-0.25 - (charging ? 0.25 : 0) - root).emit(M.head as InstancedMesh, i).pop();
    // Legs: a trot (diagonal pairs together).
    const legs: [number, number, number][] = [
      [-0.12, -0.32, 0],
      [0.12, -0.32, 0.5],
      [-0.12, 0.32, 0.5],
      [0.12, 0.32, 0],
    ];
    legs.forEach(([lx, lz, off], k) => {
      const a = ph + off * Math.PI * 2;
      const swing = Math.sin(a) * amp;
      const lift = Math.max(0, Math.cos(a)) * amp;
      P.push()
        .t(lx, -0.12, lz)
        .rx(swing)
        .emit(M.upperLeg as InstancedMesh, i * 4 + k)
        .t(0, -0.21, 0)
        .rx(lz < 0 ? -lift : lift)
        .emit(M.lowerLeg as InstancedMesh, i * 4 + k)
        .t(0, -0.21, 0)
        .rx(-swing)
        .emit(M.hoof as InstancedMesh, i * 4 + k)
        .pop();
    });
    // Tail: hanging and swishing; a charging boar runs with it straight up.
    P.push()
      .t(0, 0.12, 0.55)
      .rx(charging ? -2.8 : -0.3)
      .rz(Math.sin(this.time * 6 + c.id) * (charging ? 0.1 : 0.4))
      .emit(M.tail as InstancedMesh, i)
      .pop();
  }

  private croc(c: Creature, i: number, ph: number): void {
    const M = this.models.croc.meshes;
    const P = this.pose;
    const swim = Math.min(1, c.submerge * 1.5);
    const dead = this.fallen(c);
    // A lateral wave down the body and the tail, stronger swimming.
    const wave = (k: number): number => Math.sin(ph - k * 0.9) * (0.06 + 0.1 * swim) * Math.min(1, 0.3 + c.speedMs * 0.5);
    // On land it stands its belly off the sand; afloat the body rides at the logic's height.
    const lift = (1 - swim) * 0.2;
    P.set(this.root).t(0, lift, 0).rz(c.rollRad + dead * Math.PI);
    P.push().t(0, 0, -0.45).ry(wave(0)).emit(M.body as InstancedMesh, i);
    // Head on the front of the body, the jaw hinged under it.
    P.push()
      .t(0, 0.02, -0.85)
      .ry(-wave(0) * 1.2)
      .rx(-c.jaw * 0.15)
      .emit(M.head as InstancedMesh, i)
      .t(0, -0.02, -0.02)
      .rx(c.jaw * 0.55)
      .emit(M.jaw as InstancedMesh, i)
      .pop();
    // Legs: sprawled and walking on land, tucked back along the body in the water.
    const legs: [number, number, number][] = [
      [-0.32, -0.55, 0],
      [0.32, -0.55, 0.5],
      [-0.3, 0.6, 0.5],
      [0.3, 0.6, 0],
    ];
    legs.forEach(([lx, lz, off], k) => {
      const a = ph + off * Math.PI * 2;
      const sx = Math.sign(lx);
      const step = (1 - swim) * Math.min(1, c.speedMs) * 0.5;
      P.push()
        .t(lx, -0.05, lz)
        .rz(sx * (1.3 - swim * 0.2))
        .ry(sx * (Math.sin(a) * step + swim * (lz < 0 ? 0.9 : 1.2)))
        .emit(M.upperLeg as InstancedMesh, i * 4 + k)
        .t(0, -0.21, 0)
        .rz(-sx * (1.4 - swim * 0.6))
        .emit(M.lowerLeg as InstancedMesh, i * 4 + k)
        .t(0, -0.2, 0)
        .rz(sx * 0.2)
        .emit(M.foot as InstancedMesh, i * 4 + k)
        .pop();
    });
    // Tail: five segments back from the hips, each following the wave and a size smaller.
    P.t(0, 0, 0.82);
    for (let k = 0; k < 5; k++) {
      P.ry(wave(k + 1) * 1.6).emit(M.tail as InstancedMesh, i * 5 + k);
      P.t(0, 0, 0.4).s(0.84);
    }
    P.pop();
  }

  private shark(c: Creature, i: number, ph: number, turn: number): void {
    const M = this.models.shark.meshes;
    const P = this.pose;
    const dead = this.fallen(c);
    // The tail beat: a wave running back down the body, larger toward the tail, faster with speed.
    const beat = (k: number): number => Math.sin(ph - k * 1.2) * (0.05 + 0.08 * k) * Math.min(1.4, 0.4 + c.speedMs * 0.25);
    const bank = Math.max(-0.6, Math.min(0.6, -turn * 0.25)) + c.rollRad * 0.5;
    P.set(this.root).rx(c.pitchRad).rz(bank + dead * Math.PI).t(0, 0, -0.6);
    // Body from the gills (z −0.6) back to +0.2; the head pivots at the gills.
    P.push().ry(beat(0) * 0.3).emit(M.body as InstancedMesh, i).pop();
    P.push().ry(-beat(0) * 0.5).emit(M.head as InstancedMesh, i).rx(c.jaw * 0.45).emit(M.jaw as InstancedMesh, i).pop();
    P.t(0, 0, 0.8).ry(beat(1)).emit(M.rear as InstancedMesh, i).t(0, 0, 0.66).ry(beat(2) * 1.6).emit(M.tail as InstancedMesh, i);
  }
}

function wrap(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}
