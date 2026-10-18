import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The ambush infantry's body parts, after Field Line's soldiers (its
// render/actors.ts): men in loose combat clothes, not boxes and sticks. Limbs
// are lathed through measured profiles with an oval section and the cloth's
// folds pressed in where it bunches; the torso wears a plate carrier with
// pouches and an assault pack; the head has a face under a helmet with a rim;
// boots come from a side profile; the rifle and the launcher have their real
// outlines. Seen through a gunner's sight at a few hundred metres the
// silhouette is all there is, and a box with a ball on it reads as a target
// dummy.
//
// Frame: +Z forward, +Y up, metres. Limbs are built at unit length along +Y
// (the pose stretches each between two joints). Every part carries `color`
// (linear), `shade` (the cloth's creases) and `camo` (1 on the uniform, which
// takes each man's own colour) for the uniform material.

type V3 = [number, number, number];

const UNIFORM: V3 = lin(0x5a5e48);
/** Uniform colours (linear) a squad's men wear, one each: woodland green, arid tan, urban grey, dark olive. */
export const UNIFORM_COLOURS: readonly V3[] = [[0.1, 0.11, 0.065], [0.26, 0.21, 0.14], [0.15, 0.15, 0.15], [0.06, 0.075, 0.045]];
const ARMOUR: V3 = lin(0x4b5340);
const KHAKI: V3 = lin(0x5c5b3e);
const WEBBING: V3 = lin(0x50503a);
const BOOT: V3 = lin(0x3a332b);
const SOLE: V3 = lin(0x232220);
const GLOVE: V3 = lin(0x3e3328);

function lin(hex: number): V3 {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Colour and shade on a part, non-indexed, position/normal/uv only besides. */
function paint(g: THREE.BufferGeometry, colour: V3, shade?: Float32Array): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(src.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'shade') src.deleteAttribute(k);
  if (!src.getAttribute('uv')) src.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(src.getAttribute('position').count * 2), 2));
  const n = src.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(colour, i * 3);
  src.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (shade) src.setAttribute('shade', new THREE.BufferAttribute(shade, 1));
  else if (!src.getAttribute('shade')) src.setAttribute('shade', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  // 1 on the uniform itself, which takes each man's own colour (infantry.ts); 0 on kit, boots and gloves.
  src.setAttribute('camo', new THREE.BufferAttribute(new Float32Array(n).fill(colour === UNIFORM ? 1 : 0), 1));
  return src;
}

function join(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('infantry part merge failed');
  return g;
}

/** A cloth fold: where along the limb (0 at the first joint … 1 at the second), how wide a band, how deep (m). */
type Fold = [centre: number, width: number, depthM: number];

/**
 * A clothed limb at unit length along +Y: a lathe through `profile` ([fraction, radius m] pairs, eased),
 * its section `depth` times as deep front to back as wide, domed at both ends, the folds pressed in as rings
 * that wander round it, creases darker. Built at its real `lengthM` (so folds and domes keep their size)
 * and divided down: the pose stretches it back.
 */
export function limb(lengthM: number, profile: readonly [number, number][], depth: number, folds: readonly Fold[], seed: number, colour: V3 = UNIFORM): THREE.BufferGeometry {
  const radiusAt = (t: number): number => {
    for (let k = 1; k < profile.length; k++) {
      const [t1, r1] = profile[k] as [number, number];
      const [t0, r0] = profile[k - 1] as [number, number];
      if (t <= t1) {
        const u = (t - t0) / Math.max(1e-6, t1 - t0);
        return r0 + (r1 - r0) * u * u * (3 - 2 * u);
      }
    }
    return (profile[profile.length - 1] as [number, number])[1];
  };
  const r0 = radiusAt(0);
  const r1 = radiusAt(1);
  const rings: [number, number, number][] = [];
  for (let k = 0; k < 3; k++) {
    const a = (Math.PI / 2) * (1 - k / 3);
    rings.push([-Math.sin(a) * r0 * 0.7, Math.cos(a) * r0, -1]);
  }
  for (let k = 0; k <= 16; k++) rings.push([(k / 16) * lengthM, radiusAt(k / 16), k / 16]);
  for (let k = 1; k <= 3; k++) {
    const a = (Math.PI / 2) * (k / 3);
    rings.push([lengthM + Math.sin(a) * r1 * 0.7, Math.cos(a) * r1, -1]);
  }
  const SEG = 10;
  const deepest = folds.reduce((m, f) => Math.max(m, f[2]), 1e-6);
  const pos: number[] = [];
  const shade: number[] = [];
  rings.forEach(([y, r, t]) => {
    for (let j = 0; j <= SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      let d = 0;
      if (t >= 0) for (const [c, w, amp] of folds) d += amp * Math.exp(-(((t - c) / w) ** 2)) * Math.sin(((t * lengthM) / 0.05) * Math.PI * 2 + 1.6 * Math.sin(th * 2 + seed) + Math.cos(th) * 0.8 + seed);
      const rr = Math.max(0.004, r + d);
      pos.push(Math.cos(th) * rr, y / lengthM, Math.sin(th) * rr * depth);
      shade.push(1 + Math.min(0, d / deepest) * 0.28);
    }
  });
  const idx: number[] = [];
  for (let k = 0; k < rings.length - 1; k++) {
    for (let j = 0; j < SEG; j++) {
      const a = k * (SEG + 1) + j;
      const b = a + SEG + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('shade', new THREE.BufferAttribute(new Float32Array(shade), 1));
  g.setIndex(idx);
  // Normals at the real length, or the stretch would bend them.
  const real = g.clone();
  const rp = real.getAttribute('position');
  for (let i = 0; i < rp.count; i++) rp.setY(i, rp.getY(i) * lengthM);
  real.computeVertexNormals();
  g.setAttribute('normal', real.getAttribute('normal'));
  return paint(g, colour);
}

/** A section lofted up +Y through rings of (y, half-width, half-depth, z offset), closed at both ends. */
function loft(rings: readonly [number, number, number, number][]): THREE.BufferGeometry {
  const SEG = 16;
  const first = rings[0] as [number, number, number, number];
  const last = rings[rings.length - 1] as [number, number, number, number];
  const all: [number, number, number, number][] = [[first[0], 0.001, 0.001, first[3]], ...rings, [last[0], 0.001, 0.001, last[3]]];
  const pos: number[] = [];
  all.forEach(([y, rx, rz, z]) => {
    for (let j = 0; j <= SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      pos.push(Math.cos(th) * rx, y, z + Math.sin(th) * rz);
    }
  });
  const idx: number[] = [];
  for (let k = 0; k < all.length - 1; k++) {
    for (let j = 0; j < SEG; j++) {
      const a = k * (SEG + 1) + j;
      const b = a + SEG + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, c: V3): THREE.BufferGeometry => paint(new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z), c);

/** Torso from the hip (y = 0) to the neck (0.62): shirt, plate carrier, pouches, pack. */
export function torsoGeometry(): THREE.BufferGeometry {
  const body = loft([
    [0.0, 0.17, 0.12, 0],
    [0.12, 0.16, 0.115, 0],
    [0.3, 0.175, 0.12, 0],
    [0.44, 0.2, 0.12, -0.005],
    [0.54, 0.19, 0.11, 0],
    [0.6, 0.08, 0.07, 0],
    [0.66, 0.06, 0.06, 0.005],
  ]);
  return join([
    paint(body, UNIFORM),
    // Shoulders over the arm sockets.
    paint(new THREE.SphereGeometry(0.075, 10, 8).scale(1, 0.9, 1).translate(-0.2, 0.5, 0), UNIFORM),
    paint(new THREE.SphereGeometry(0.075, 10, 8).scale(1, 0.9, 1).translate(0.2, 0.5, 0), UNIFORM),
    // Plate carrier: front and back plates, cummerbund, shoulder straps.
    box(0.3, 0.32, 0.05, 0, 0.33, 0.12, ARMOUR),
    box(0.3, 0.34, 0.05, 0, 0.34, -0.12, ARMOUR),
    box(0.37, 0.16, 0.22, 0, 0.22, 0, ARMOUR),
    box(0.06, 0.03, 0.25, -0.1, 0.52, 0, ARMOUR),
    box(0.06, 0.03, 0.25, 0.1, 0.52, 0, ARMOUR),
    // Magazine pouches and an admin pouch on the front.
    box(0.075, 0.11, 0.045, -0.085, 0.22, 0.165, KHAKI),
    box(0.075, 0.11, 0.045, 0, 0.22, 0.165, KHAKI),
    box(0.075, 0.11, 0.045, 0.085, 0.22, 0.165, KHAKI),
    box(0.17, 0.08, 0.03, 0, 0.38, 0.155, KHAKI),
    // Assault pack, its straps and a bedroll on top.
    box(0.28, 0.34, 0.14, 0, 0.3, -0.21, KHAKI),
    box(0.24, 0.1, 0.05, 0, 0.2, -0.29, WEBBING),
    paint(new THREE.CylinderGeometry(0.055, 0.055, 0.3, 10).rotateZ(Math.PI / 2).translate(0, 0.5, -0.2), WEBBING),
    // Battle belt.
    box(0.36, 0.06, 0.26, 0, 0.02, 0, WEBBING),
  ]);
}

/** A head facing +Z: brow, nose, cheekbones and jaw pressed into a sphere. Skin material, no colour. */
export function headGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.1, 16, 12).scale(0.8, 1.06, 0.95);
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  const bump = (x: number, y: number, z: number, r: number): number => Math.exp(-((v.x - x) ** 2 + (v.y - y) ** 2 + (v.z - z) ** 2) / (r * r));
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const front = Math.max(0, v.z / 0.095);
    const out =
      0.016 * bump(0, -0.012, 0.095, 0.022) +
      0.006 * bump(0, 0.03, 0.088, 0.035) +
      0.005 * (bump(-0.045, 0, 0.07, 0.025) + bump(0.045, 0, 0.07, 0.025)) -
      0.006 * (bump(-0.032, 0.018, 0.088, 0.018) + bump(0.032, 0.018, 0.088, 0.018));
    const jaw = v.y < -0.03 ? 1 - Math.min(0.18, (-0.03 - v.y) * 2.2) * (1 - front) : 1;
    pos.setXYZ(i, v.x * jaw, v.y, v.z + out * front);
  }
  g.computeVertexNormals();
  return g;
}

/** A combat helmet: the shell, its rim, a cover's band and side rails. Helmet material. */
export function helmetGeometry(): THREE.BufferGeometry {
  return join(
    [
      new THREE.SphereGeometry(0.128, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(0.95, 0.86, 1.05).translate(0, 0.02, -0.005),
      new THREE.CylinderGeometry(0.124, 0.127, 0.014, 18, 1, true).scale(0.95, 1, 1.05).translate(0, 0.024, -0.005),
      new THREE.TorusGeometry(0.122, 0.006, 4, 24).rotateX(Math.PI / 2).scale(0.95, 1, 1.05).translate(0, 0.06, -0.005),
      new THREE.BoxGeometry(0.012, 0.022, 0.1).translate(-0.12, 0.04, -0.005),
      new THREE.BoxGeometry(0.012, 0.022, 0.1).translate(0.12, 0.04, -0.005),
    ].map((p) => {
      const n = p.index ? p.toNonIndexed() : p;
      for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
      return n;
    }),
  );
}

/** A boot from its side profile, the foot point at the origin, sole on y = −0.03, toe toward +Z. */
export function bootGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.075, -0.068);
  s.lineTo(-0.08, 0.02);
  s.quadraticCurveTo(-0.075, 0.1, -0.045, 0.11);
  s.lineTo(0.03, 0.11);
  s.quadraticCurveTo(0.055, 0.04, 0.09, 0.0);
  s.quadraticCurveTo(0.17, -0.025, 0.195, -0.05);
  s.quadraticCurveTo(0.205, -0.068, 0.185, -0.068);
  s.lineTo(-0.075, -0.068);
  const upper = new THREE.ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.016, bevelSize: 0.012, bevelSegments: 2, curveSegments: 6 });
  // Shape (u, v) → boot (z = u, y = v), extruded across x and centred; up 6 cm, as the pose's foot point
  // is the ankle's lowest reach, 3 cm off the ground.
  upper.rotateY(-Math.PI / 2).translate(0.035, 0.06, 0);
  const sole = new THREE.BoxGeometry(0.1, 0.022, 0.29).translate(0, -0.02, 0.055);
  return join([paint(upper, BOOT), paint(sole, SOLE)]);
}

/** A gloved hand gripping, hanging from the wrist (origin) along −Y, the fingers curled toward +Z. */
export function handGeometry(): THREE.BufferGeometry {
  return join([
    paint(new THREE.SphereGeometry(1, 10, 8).scale(0.043, 0.052, 0.026).translate(0, -0.05, 0), GLOVE),
    paint(new THREE.CapsuleGeometry(0.016, 0.052, 3, 8).rotateZ(Math.PI / 2).translate(0, -0.092, 0.012), GLOVE),
    paint(new THREE.CapsuleGeometry(0.012, 0.035, 2, 6).rotateZ(0.5).translate(-0.036, -0.052, 0.02), GLOVE),
  ]);
}

/** An assault rifle along +Z from the shoulder: stock, receiver, magazine, handguard, barrel, sights. Gun material. */
export function rifleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(0.04, 0.11, 0.26).translate(0, -0.03, -0.06), // stock
    new THREE.BoxGeometry(0.035, 0.03, 0.08).translate(0, 0.025, -0.1), // cheek rest
    new THREE.BoxGeometry(0.05, 0.075, 0.3).translate(0, 0.0, 0.2), // receiver
    new THREE.BoxGeometry(0.03, 0.09, 0.04).rotateX(0.3).translate(0, -0.075, 0.13), // pistol grip
    new THREE.BoxGeometry(0.03, 0.17, 0.065).rotateX(-0.25).translate(0, -0.1, 0.26), // magazine
    new THREE.CylinderGeometry(0.03, 0.03, 0.24, 10).rotateX(Math.PI / 2).translate(0, 0.005, 0.46), // handguard
    new THREE.CylinderGeometry(0.0095, 0.0095, 0.22, 8).rotateX(Math.PI / 2).translate(0, 0.005, 0.68), // barrel
    new THREE.CylinderGeometry(0.014, 0.014, 0.05, 8).rotateX(Math.PI / 2).translate(0, 0.005, 0.8), // muzzle device
    new THREE.BoxGeometry(0.02, 0.04, 0.03).translate(0, 0.055, 0.12), // rear sight
    new THREE.BoxGeometry(0.012, 0.045, 0.02).translate(0, 0.05, 0.56), // front sight
  ];
  return join(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
}

/** A shoulder-fired launcher along +Z, centred on the shooter's shoulder: tube, grips, sight, flared breech. Tube material. */
export function launcherGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.042, 0.042, 1.0, 12, 1, true).rotateX(Math.PI / 2),
    new THREE.CylinderGeometry(0.05, 0.05, 0.22, 12).rotateX(Math.PI / 2).translate(0, 0, 0.05), // heat shield
    new THREE.CylinderGeometry(0.065, 0.042, 0.12, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.53), // breech flare
    new THREE.BoxGeometry(0.03, 0.1, 0.04).rotateX(0.25).translate(0, -0.08, 0.05), // grip
    new THREE.BoxGeometry(0.03, 0.09, 0.04).rotateX(0.25).translate(0, -0.075, 0.2), // fore grip
    new THREE.BoxGeometry(0.03, 0.05, 0.1).translate(-0.05, 0.05, 0.12), // optical sight
  ];
  return join(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
}

/** The grenade: an ogive head on a body, the motor's fins at its tail, sitting in the muzzle. Gun material. */
export function warheadGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.ConeGeometry(0.075, 0.2, 12).rotateX(Math.PI / 2).translate(0, 0, 0.7), new THREE.CylinderGeometry(0.075, 0.045, 0.1, 12).rotateX(Math.PI / 2).translate(0, 0, 0.55)];
  return join(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
}
