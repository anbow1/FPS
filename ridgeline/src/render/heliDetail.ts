import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { float, length, min, mix, mod, positionGeometry, smoothstep, vec2, vec3 } from 'three/tsl';
import { type BufferGeometry, CircleGeometry, Color, CylinderGeometry, Group, type Material, Mesh, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, SphereGeometry, TorusGeometry } from 'three/webgpu';
import { tube } from './airframe.ts';

// The small parts that make a helicopter read as a machine rather than a
// model: the nose sensors with their coated optics, missiles with wings,
// fins and bands, a rocket pod's honeycomb of tubes, the turned-out exhaust
// suppressors, antennas, wire cutters, lights, the IR jammer and the flare
// dispensers. Learned from the STRIX helicopter scene (an AI-made three.js
// scene): its realism is mostly the number of parts and the grime between
// them, not any one material. Everything here is in body axes (x right,
// y up, −z forward) and invented — no markings.

export function mesh(g: BufferGeometry, m: Material, cast = true): Mesh {
  const out = new Mesh(g, m);
  out.castShadow = cast;
  out.receiveShadow = true;
  return out;
}

export function rbox(w: number, h: number, d: number, r: number): BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.999);
}

/** Coated optics: near-black glass with a gold-violet reflection, as on real sensor windows. */
export function opticsMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'sensor optics', color: new Color(0x040506), roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
  m.specularColor = new Color(0xd9b46a);
  m.specularIntensity = 1;
  return m;
}

/** A round window with a raised bezel, facing −z, centred at (x, y, z). */
function roundWindow(r: number, x: number, y: number, z: number, glass: Material, bezel: Material): Group {
  const g = new Group();
  const w = mesh(new CircleGeometry(r, 24), glass, false);
  w.rotation.y = Math.PI;
  w.position.set(x, y, z - 0.004);
  const ring = mesh(new TorusGeometry(r + 0.008, 0.009, 6, 24), bezel, false);
  ring.position.set(x, y, z - 0.006);
  g.add(w, ring);
  return g;
}

/** A rectangular window with a raised bezel, facing −z. */
function rectWindow(w: number, h: number, x: number, y: number, z: number, glass: Material, bezel: Material): Group {
  const g = new Group();
  const pane = mesh(rbox(w, h, 0.01, 0.012), glass, false);
  pane.position.set(x, y, z - 0.002);
  const frame = mesh(rbox(w + 0.03, h + 0.03, 0.012, 0.012), bezel, false);
  frame.position.set(x, y, z + 0.003);
  g.add(frame, pane);
  return g;
}

/**
 * The nose sight turret: a drum on a yoke turning in azimuth, two sensor housings either side
 * (day TV and direct view on the left, thermal on the right) with their coated windows, a laser
 * window in the drum, and the small night-flying turret above the nose.
 */
export function sensorTurret(tz: number, drumY: number, R: number, pnvsZ: number, housing: Material, bezel: Material, glass: Material): Group {
  const g = new Group();
  const yoke = mesh(new CylinderGeometry(0.16, 0.2, 0.24, 18), housing);
  yoke.position.set(0, drumY + 0.22, tz + 0.25);
  g.add(yoke);
  // Drum, its ends chamfered.
  const drum = new Group();
  drum.add(mesh(new CylinderGeometry(R, R, 0.46, 28), housing));
  for (const s of [-1, 1]) {
    const ch = mesh(new CylinderGeometry(R * 0.86, R, 0.06, 28), housing);
    ch.position.y = s * 0.26;
    if (s < 0) ch.rotation.x = Math.PI;
    drum.add(ch);
  }
  drum.rotation.z = Math.PI / 2;
  drum.position.set(0, drumY, tz);
  g.add(drum);
  // Laser window in the drum's face.
  g.add(rectWindow(0.12, 0.08, 0, drumY + 0.04, tz - R + 0.01, glass, bezel));
  // The two housings: rounded, deeper than tall, their faces a little ahead of the drum.
  for (const s of [-1, 1]) {
    const ear = mesh(rbox(0.22, 0.42, 0.52, 0.05), housing);
    ear.position.set(s * 0.43, drumY, tz - 0.02);
    g.add(ear);
    const face = tz - 0.28;
    if (s < 0) {
      g.add(rectWindow(0.13, 0.15, s * 0.43, drumY + 0.08, face, glass, bezel));
      g.add(roundWindow(0.04, s * 0.43 - 0.03, drumY - 0.1, face, glass, bezel));
      g.add(roundWindow(0.03, s * 0.43 + 0.05, drumY - 0.11, face, glass, bezel));
    } else {
      g.add(roundWindow(0.085, s * 0.43, drumY + 0.04, face, glass, bezel));
      g.add(rectWindow(0.08, 0.05, s * 0.43, drumY - 0.13, face, glass, bezel));
    }
    // A hinge line and two fasteners on the housing's side.
    const strap = mesh(rbox(0.012, 0.3, 0.02, 0.005), bezel, false);
    strap.position.set(s * 0.545, drumY, tz + 0.05);
    g.add(strap);
  }
  // Night-flying turret over the nose: a rounded head on a short base, one window forward.
  const base = mesh(new CylinderGeometry(0.13, 0.15, 0.08, 18), housing);
  base.position.set(0, 0.17, pnvsZ + 0.05);
  const head = mesh(rbox(0.26, 0.2, 0.26, 0.07), housing);
  head.position.set(0, 0.3, pnvsZ + 0.05);
  g.add(base, head);
  g.add(roundWindow(0.06, 0, 0.3, pnvsZ - 0.08, glass, bezel));
  return g;
}

/**
 * A rocket pod's end face: nineteen tubes on a hexagonal pitch, dark inside, with the light metal
 * web between them. Drawn in the cap's own plane (local x, z of the cylinder geometry).
 */
function honeycombMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'rocket tubes', roughness: 0.55, metalness: 0.4 });
  const pitch = 0.072;
  const q = positionGeometry.xz.div(pitch);
  const r = vec2(1, 1.7320508);
  const h = r.mul(0.5);
  const a = mod(q, r).sub(h);
  const b = mod(q.sub(h), r).sub(h);
  const d = min(length(a), length(b)).mul(pitch);
  const hole = smoothstep(0.031, 0.027, d);
  m.colorNode = mix(vec3(0.16, 0.16, 0.15), vec3(0.008, 0.008, 0.008), hole);
  m.roughnessNode = mix(float(0.5), float(0.9), hole);
  return m;
}

let tubes: MeshStandardNodeMaterial | null = null;

/** A 19-tube rocket pod along z centred at (x, y, z): body, rolled lips at both ends, honeycomb faces. */
export function rocketPod(x: number, y: number, z: number, body: Material, lip: Material): Group {
  tubes ??= honeycombMaterial();
  const g = new Group();
  const L = 1.6;
  const R = 0.21;
  const shell = mesh(new CylinderGeometry(R, R, L - 0.08, 24), body);
  shell.rotation.x = Math.PI / 2;
  g.add(shell);
  for (const s of [-1, 1]) {
    const rim = mesh(new CylinderGeometry(R * 0.97, R, 0.04, 24), lip);
    rim.rotation.x = Math.PI / 2;
    rim.position.z = s * (L / 2 - 0.02);
    g.add(rim);
    const face = mesh(new CylinderGeometry(R * 0.95, R * 0.95, 0.01, 24), tubes, false);
    face.rotation.x = Math.PI / 2;
    face.position.z = s * (L / 2 - 0.005);
    g.add(face);
  }
  // Two suspension lugs on top and a band where the halves meet.
  for (const dz of [-0.36, 0.36]) {
    const lug = mesh(rbox(0.05, 0.05, 0.08, 0.01), lip);
    lug.position.set(0, R + 0.02, dz);
    g.add(lug);
  }
  const band = mesh(new CylinderGeometry(R + 0.004, R + 0.004, 0.03, 24), lip);
  band.rotation.x = Math.PI / 2;
  g.add(band);
  g.position.set(x, y, z);
  return g;
}

const BAND_YELLOW = 0xb48f2c;
const BAND_BROWN = 0x5b4732;

/** An anti-armour missile along −z: body, seeker dome, coloured bands, mid wings and tail fins. */
export function missile(body: Material, seeker: Material, fin: Material, bands: { yellow: Material; brown: Material }): Group {
  const g = new Group();
  const R = 0.089;
  const shell = mesh(new CylinderGeometry(R, R, 1.42, 16), body);
  shell.rotation.x = Math.PI / 2;
  shell.position.z = 0.08;
  g.add(shell);
  const dome = mesh(new SphereGeometry(R, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.35, 1), seeker);
  dome.rotation.x = -Math.PI / 2;
  dome.position.z = -0.63;
  g.add(dome);
  for (const [z, m] of [
    [-0.5, bands.yellow],
    [0.18, bands.brown],
  ] as const) {
    const b = mesh(new CylinderGeometry(R + 0.002, R + 0.002, 0.05, 16), m, false);
    b.rotation.x = Math.PI / 2;
    b.position.z = z;
    g.add(b);
  }
  // Cruciform wings near the middle, smaller fins at the tail, set at 45°.
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    for (const [z, span, chord] of [
      [-0.2, 0.11, 0.2],
      [0.66, 0.08, 0.12],
    ] as const) {
      const w = mesh(rbox(0.006, span, chord, 0.003), fin, false);
      w.position.set(Math.cos(a) * (R + span / 2), Math.sin(a) * (R + span / 2), z);
      w.rotation.z = a - Math.PI / 2;
      g.add(w);
    }
  }
  return g;
}

export function bandMaterials(): { yellow: MeshStandardNodeMaterial; brown: MeshStandardNodeMaterial } {
  return {
    yellow: new MeshStandardNodeMaterial({ name: 'missile band yellow', color: new Color(BAND_YELLOW), roughness: 0.6 }),
    brown: new MeshStandardNodeMaterial({ name: 'missile band brown', color: new Color(BAND_BROWN), roughness: 0.7 }),
  };
}

/**
 * The exhaust suppressor: from the nacelle's tail a flattened duct turns out and a little down, the
 * hot gas leaving through an oval mouth well clear of the boom; a dark throat inside the mouth.
 */
export function suppressor(side: 1 | -1, x: number, y: number, z: number, skin: Material, throat: Material): Group {
  const g = new Group();
  // Built round the nacelle's tail and squashed vertically as a whole (a flattened duct).
  const inner = new Group();
  inner.scale.set(1, 0.82, 1);
  g.add(inner);
  const path: [number, number, number][] = [
    [0, 0, -0.15],
    [side * 0.08, 0.01, 0.15],
    [side * 0.24, -0.01, 0.38],
    [side * 0.42, -0.04, 0.55],
  ];
  inner.add(mesh(tube(path, 0.2, 18), skin));
  const end = path[path.length - 1]!;
  const prev = path[path.length - 2]!;
  const mouth = mesh(new CircleGeometry(0.18, 20), throat, false);
  mouth.position.set(end[0], end[1], end[2]);
  mouth.lookAt(end[0] + (end[0] - prev[0]) * 10, end[1] + (end[1] - prev[1]) * 10, end[2] + (end[2] - prev[2]) * 10);
  inner.add(mouth);
  g.position.set(x, y, z);
  return g;
}

/** A swept blade antenna standing `h` tall on a surface at (x, y, z), its base `chord` long. */
export function bladeAntenna(x: number, y: number, z: number, h: number, chord: number, m: Material, down = false): Mesh {
  const geo = rbox(0.012, h, chord, 0.005);
  // Sweep it: shear the top aft.
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + h / 2) / h;
    p.setZ(i, p.getZ(i) * (1 - 0.45 * t) + t * chord * 0.55);
  }
  geo.computeVertexNormals();
  const out = mesh(geo, m, false);
  out.position.set(x, y + (down ? -h / 2 : h / 2), z);
  if (down) out.rotation.z = Math.PI;
  return out;
}

/** Navigation or position light: a small lens on a fitting, glowing in its colour. */
export function navLight(x: number, y: number, z: number, hex: number, fitting: Material): Group {
  const g = new Group();
  const lens = new Mesh(new SphereGeometry(0.035, 10, 8), new MeshStandardNodeMaterial({ name: 'nav lens', color: new Color(hex), emissive: new Color(hex), emissiveIntensity: 4, roughness: 0.2 }));
  const base = mesh(new CylinderGeometry(0.03, 0.04, 0.03, 10), fitting, false);
  base.position.y = -0.02;
  g.add(lens, base);
  g.position.set(x, y, z);
  return g;
}

/** The infrared jammer behind the mast: a lantern of facets on a short pedestal. */
export function irJammer(x: number, y: number, z: number, housing: Material, glass: Material): Group {
  const g = new Group();
  const ped = mesh(new CylinderGeometry(0.1, 0.12, 0.14, 12), housing);
  ped.position.y = 0.07;
  const lantern = mesh(new CylinderGeometry(0.15, 0.15, 0.22, 8), glass);
  lantern.position.y = 0.25;
  const cap = mesh(new CylinderGeometry(0.1, 0.16, 0.06, 8), housing);
  cap.position.y = 0.39;
  g.add(ped, lantern, cap);
  g.position.set(x, y, z);
  return g;
}

/** Flare and chaff dispenser: a shallow box of cells on the boom's side. */
export function dispenser(x: number, y: number, z: number, side: 1 | -1, housing: Material, cells: Material): Group {
  const g = new Group();
  const box = mesh(rbox(0.07, 0.2, 0.34, 0.015), housing);
  g.add(box);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 6; c++) {
      const cell = mesh(new CircleGeometry(0.018, 8), cells, false);
      cell.rotation.y = (side * Math.PI) / 2;
      cell.position.set(side * 0.036, -0.06 + r * 0.06, -0.13 + c * 0.052);
      g.add(cell);
    }
  }
  g.position.set(x, y, z);
  return g;
}

/** Wire-strike cutter: a saw-edged blade on a short mount, standing along z. */
export function wireCutter(x: number, y: number, z: number, h: number, m: Material, down = false): Mesh {
  const geo = rbox(0.02, h, 0.12, 0.006);
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + h / 2) / h;
    // Leading edge raked forward toward the tip.
    p.setZ(i, p.getZ(i) - t * 0.1);
  }
  geo.computeVertexNormals();
  const out = mesh(geo, m, false);
  out.position.set(x, y + (down ? -h / 2 : h / 2), z);
  if (down) out.rotation.x = Math.PI;
  return out;
}

/** A boarding step: a short bar on two stand-offs. */
export function step(x: number, y: number, z: number, side: 1 | -1, m: Material): Group {
  const g = new Group();
  const bar = mesh(new CylinderGeometry(0.012, 0.012, 0.18, 8), m, false);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(side * 0.05, 0, 0);
  g.add(bar);
  for (const dz of [-0.08, 0.08]) {
    const leg = mesh(new CylinderGeometry(0.008, 0.008, 0.05, 6), m, false);
    leg.rotation.z = Math.PI / 2;
    leg.position.set(side * 0.025, 0, dz);
    g.add(leg);
  }
  g.position.set(x, y, z);
  return g;
}
