import { abs, add, cameraPosition, dot, float, fract, fwidth, max, mix, mx_noise_float, normalize, normalWorld, positionLocal, positionWorld, screenUV, smoothstep, time, uniform, vec2, vec3, viewportSharedTexture } from 'three/tsl';
import { Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node, type BufferGeometry } from 'three/webgpu';
import { AIRCRAFT, type AircraftId } from '../config.ts';
import { blackbody } from '../core/blackbody.ts';
import { OVERLAY_LAYER, overlayBlending, overlayVisibility } from './stage.ts';
import { lathe, loft, type Section, surface } from './airframe.ts';

// Procedural models of the two aircraft, built to the scale sheet
// (Wraith 15.70 × 10.70 × 4.33 m, Talon 21.90 × 15.30 × 5.90 m). Origin near
// the centre of mass, nose towards −z. Paint and canopy values from the PBR
// sheet: "aircraft grey, matte" #6A6D71 rough 0.58 with panel-line AO for the
// stealth type, "blue-grey camo" #7B8898 rough 0.62 for the twin; canopy
// acrylic rough 0.05 (gold-tinted on the Wraith). Invented types, no markings
// (rules §13).

export interface JetModel {
  root: Group;
  /** Stabilators: rotate about x for pitch, opposite for roll. */
  stabs: { left: Group; right: Group };
  rudders: Group[];
  /** Afterburner flame size and brightness 0…1, set per frame. */
  burner: { value: number };
  /** Exhaust heat 0…1 (core spool, more with the burner) for the shimmer, set per frame. */
  heat: { value: number };
  /** Heat-shimmer volumes behind the nozzles (hidden on Low: they need a copy of the frame). */
  shimmer: Mesh[];
  /** Nozzle positions for effects (contrails, heat shimmer): [x, y, z] in model space. */
  nozzles: [number, number, number][];
  /** Wingtips for vapour trails. */
  wingtips: [number, number, number][];
  /** Pilot's eye in model space. */
  eye: [number, number, number];
  /** One group per gear leg (pivot at the attachment), with the strut and wheel. */
  gearLegs: { pivot: Group; strut: Mesh; wheel: Mesh; travelM: number; nose: boolean }[];
}

const srgb = (hex: number): Color => new Color(hex);

function paintMaterial(name: string, baseHex: number, roughness: number, camo: { light: number; dark: number } | null): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, roughness, metalness: 0 });
  const p = positionLocal;
  // Panel lines: thin seams on a ~1.1 m × 0.9 m grid in the aircraft's own frame, kept at least a
  // pixel wide (fwidth) so they never alias into moiré.
  const seam = (coord: Node<'float'>, pitchM: number): Node<'float'> => {
    const toLine = float(0.5).sub(abs(fract(coord.div(pitchM)).sub(0.5))).mul(pitchM);
    return float(1).sub(smoothstep(float(0.006), fwidth(coord).mul(1.5).add(0.006), toLine));
  };
  const seams = max(seam(p.z, 1.15), seam(p.x, 0.9));
  let base: Node<'vec3'> = vec3(srgb(baseHex).r, srgb(baseHex).g, srgb(baseHex).b);
  if (camo) {
    // Two-tone splinter camouflage from low-frequency noise in model space.
    const n = mx_noise_float(p.mul(0.22));
    const light = srgb(camo.light);
    const dark = srgb(camo.dark);
    base = mix(base, vec3(light.r, light.g, light.b), smoothstep(0.15, 0.2, n));
    base = mix(base, vec3(dark.r, dark.g, dark.b), smoothstep(0.15, 0.2, n.negate()));
  }
  // Subtle weathering so the paint is not a showroom finish (rules §5.4).
  const grime = mx_noise_float(p.mul(1.7)).mul(0.04).add(1);
  m.colorNode = base.mul(float(1).sub(seams.mul(0.18))).mul(grime);
  m.roughnessNode = float(roughness).add(seams.mul(0.1));
  return m;
}

function canopyMaterial(tint: number): MeshPhysicalNodeMaterial {
  const c = srgb(tint);
  const m = new MeshPhysicalNodeMaterial({ name: 'canopy', color: c, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.32, clearcoat: 1, clearcoatRoughness: 0.03, side: DoubleSide });
  m.depthWrite = false;
  return m;
}

/** Pre-exposure for emissive surfaces given in physical luminance (cd/m²): set per frame from the lighting. */
export const EMISSIVE_EXPOSURE = uniform(1);

/** Afterburner luminance at full reheat (cd/m²): bright enough to read at noon, not to blind at dusk. */
const FLAME_LUMINANCE = 60_000;

function flameMaterial(burner: { value: number } & Node<'float'>, lengthM: number, z0: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ name: 'afterburner', transparent: true, depthWrite: false, side: DoubleSide });
  // Pure addition of light: a flame hides nothing behind it.
  overlayBlending(m, true);
  // Emission, not reflection: a ~1900 K core cooling to ~1300 K along the plume (black-body colour),
  // plus the blue-violet of the shock diamonds (band emission, not black body), in physical
  // luminance pre-exposed like everything else — so the same flame is subtle at noon and vivid at dusk.
  const hot = blackbody(1900);
  const cool = blackbody(1300);
  const along = positionLocal.z.sub(z0).div(lengthM).clamp(0, 1);
  const diamonds = abs(fract(along.mul(5.5)).sub(0.5)).mul(2).oneMinus().pow(6).mul(0.5);
  const core = mix(vec3(...hot), vec3(...cool), along).mul(float(1).sub(along).pow(1.6));
  const plume = vec3(0.35, 0.4, 1.0).mul(diamonds).mul(float(1).sub(along));
  m.colorNode = add(core, plume).mul(burner.mul(burner)).mul(EMISSIVE_EXPOSURE).mul(FLAME_LUMINANCE).mul(overlayVisibility());
  return m;
}

/** One shared copy of the frame for every shimmer volume (each viewport texture node keeps its own). */
const frameCopy = viewportSharedTexture();

/**
 * Hot exhaust bends the light behind the nozzle: the volume redraws the frame behind it with a small
 * screen-space offset from animated noise, strongest at the nozzle and towards the volume's centre.
 */
function shimmerMaterial(heat: { value: number } & Node<'float'>, lengthM: number, z0: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ name: 'heat shimmer', transparent: true, depthWrite: false });
  const along = positionLocal.z.sub(z0).div(lengthM).clamp(0, 1);
  const facing = abs(dot(normalWorld, normalize(cameraPosition.sub(positionWorld))));
  const flow = positionLocal.mul(vec3(3.5, 3.5, 0.9)).add(vec3(0, 0, time.mul(-24)));
  const n = vec2(mx_noise_float(flow), mx_noise_float(flow.add(17.3)));
  const strength = heat.mul(float(1).sub(along).pow(1.5)).mul(facing.pow(2));
  // Offset in screen units shrinks with distance, as a real refraction of a fixed size would.
  const dist = positionWorld.sub(cameraPosition).length();
  const offset = n.mul(strength).mul(float(0.18).div(dist.max(2)));
  m.colorNode = frameCopy.sample(screenUV.add(offset)).rgb;
  m.opacityNode = smoothstep(0, 0.05, strength);
  return m;
}

function mesh(g: BufferGeometry, m: MeshStandardNodeMaterial | MeshPhysicalNodeMaterial | MeshBasicNodeMaterial, cast = true): Mesh {
  const out = new Mesh(g, m);
  out.castShadow = cast;
  out.receiveShadow = true;
  return out;
}

export function buildJet(id: AircraftId): JetModel {
  const model = id === 'wraith' ? buildWraith() : buildTalon();
  // Landing gear from the logic's leg positions (config.ts), so the wheels sit where the springs act.
  const metal = new MeshStandardNodeMaterial({ name: 'gear leg', color: srgb(0xc6c6c8), roughness: 0.35, metalness: 1 });
  const tyre = new MeshStandardNodeMaterial({ name: 'tyre', color: srgb(0x2c2c2e), roughness: 0.86, metalness: 0 });
  for (const leg of AIRCRAFT[id].gear.legs) {
    const pivot = new Group();
    pivot.position.set(leg.x, leg.y, leg.z);
    const strut = mesh(new CylinderGeometry(0.07, 0.09, 1, 10), metal);
    const r = leg.nose ? 0.3 : 0.42;
    const wheel = mesh(new CylinderGeometry(r, r, leg.nose ? 0.18 : 0.3, 18).rotateZ(Math.PI / 2), tyre);
    pivot.add(strut, wheel);
    model.root.add(pivot);
    model.gearLegs.push({ pivot, strut, wheel, travelM: leg.travelM, nose: leg.nose });
  }
  return model;
}

/** Gear position 0 (up) … 1 (down) and per-leg compression (m). */
export function poseGear(model: JetModel, position: number, compression: readonly number[]): void {
  model.gearLegs.forEach((leg, i) => {
    leg.pivot.visible = position > 0.02;
    // Retracts by swinging forward (mains) or aft (nose) into the bays.
    leg.pivot.rotation.x = (1 - position) * (leg.nose ? -1.5 : 1.5);
    const extension = leg.travelM - (compression[i] ?? 0);
    const radius = leg.nose ? 0.3 : 0.42;
    leg.strut.scale.y = Math.max(0.05, extension);
    leg.strut.position.y = -extension / 2;
    leg.wheel.position.y = -extension + radius;
  });
}

function buildWraith(): JetModel {
  const root = new Group();
  root.name = 'wraith';
  const paint = paintMaterial('wraith paint', 0x6a6d71, 0.58, null);
  const dark = new MeshStandardNodeMaterial({ name: 'nozzle ceramic', color: srgb(0x3c3c3e), roughness: 0.6, metalness: 0 });
  const inlet = new MeshStandardNodeMaterial({ name: 'inlet', color: srgb(0x2b2b2d), roughness: 0.9, metalness: 0 });
  const sections: Section[] = [
    { z: -7.85, halfWidthM: 0.03, halfHeightM: 0.03, centreYM: 0.05, exponent: 1.6 },
    { z: -7.2, halfWidthM: 0.3, halfHeightM: 0.26, centreYM: 0.06, exponent: 1.5, bellyScale: 0.8 },
    { z: -6.0, halfWidthM: 0.62, halfHeightM: 0.5, centreYM: 0.15, exponent: 1.6, bellyScale: 0.75 },
    { z: -4.6, halfWidthM: 0.86, halfHeightM: 0.72, centreYM: 0.22, exponent: 1.8, bellyScale: 0.7 },
    { z: -3.2, halfWidthM: 1.55, halfHeightM: 0.82, centreYM: 0.18, exponent: 1.9, bellyScale: 0.7 },
    { z: -1.0, halfWidthM: 1.78, halfHeightM: 0.86, centreYM: 0.15, exponent: 2.2, bellyScale: 0.7 },
    { z: 1.5, halfWidthM: 1.72, halfHeightM: 0.84, centreYM: 0.15, exponent: 2.2, bellyScale: 0.7 },
    { z: 4.0, halfWidthM: 1.45, halfHeightM: 0.78, centreYM: 0.18, exponent: 2.1, bellyScale: 0.75 },
    { z: 6.0, halfWidthM: 0.98, halfHeightM: 0.7, centreYM: 0.2, exponent: 2.0 },
    { z: 6.9, halfWidthM: 0.66, halfHeightM: 0.64, centreYM: 0.2, exponent: 2.0 },
  ];
  root.add(mesh(loft(sections, 40), paint));
  // Caret inlets on the flanks, with dark inlet faces.
  for (const side of [1, -1]) {
    const inletFace = lathe(
      [
        [-3.5, 0.0],
        [-3.49, 0.42],
        [-1.5, 0.45],
      ],
      side * 1.25,
      0.25,
      14,
    );
    root.add(mesh(inletFace, inlet, false));
  }
  // Wing: LE sweep ~34°, TE slightly forward-swept, 5 % → 4 % thick.
  root.add(mesh(surface({ rootX: 1.4, rootY: 0.1, rootLeZ: -1.7, rootChordM: 4.9, spanM: 3.95, tipLeZ: 0.95, tipChordM: 1.45, rootThickness: 0.05, tipThickness: 0.04, dihedralRad: -0.03, mirror: true }), paint));
  // Twin canted fins (~25° outboard).
  const finCant = (65 * Math.PI) / 180;
  root.add(mesh(surface({ rootX: 0.95, rootY: 0.75, rootLeZ: 3.4, rootChordM: 2.7, spanM: 2.05, tipLeZ: 5.3, tipChordM: 1.2, rootThickness: 0.05, tipThickness: 0.04, dihedralRad: finCant, mirror: true }), paint));
  // Stabilators, pivoting about their root quarter-chord.
  const stabs = { left: new Group(), right: new Group() };
  for (const [side, g] of [
    [1, stabs.right],
    [-1, stabs.left],
  ] as const) {
    g.position.set(side * 1.0, 0.12, 5.65);
    g.add(mesh(surface({ rootX: 0, rootY: 0, rootLeZ: -0.65, rootChordM: 2.4, spanM: 2.5, tipLeZ: 0.85, tipChordM: 0.95, rootThickness: 0.04, tipThickness: 0.03, dihedralRad: 0, mirror: false }), paint));
    if (side < 0) g.scale.x = -1;
    root.add(g);
  }
  // Nozzle and flame.
  root.add(mesh(lathe([[6.85, 0.66], [7.4, 0.6], [7.85, 0.56], [7.86, 0.0]], 0, 0.2, 24), dark));
  const burner = uniform(0);
  const heat = uniform(0);
  const flame = mesh(lathe([[7.86, 0.5], [8.6, 0.42], [10.5, 0.22], [12.2, 0.0]], 0, 0.2, 18, true), flameMaterial(burner, 4.3, 7.86), false);
  flame.renderOrder = 5;
  flame.layers.set(OVERLAY_LAYER);
  root.add(flame);
  const shimmer = [mesh(lathe([[7.9, 0.5], [9.5, 0.75], [13.5, 1.1], [17.9, 1.3]], 0, 0.2, 16, true), shimmerMaterial(heat, 10, 7.9), false)];
  shimmer[0]!.renderOrder = 4;
  root.add(shimmer[0]!);
  // Canopy bubble.
  const canopy = loft(
    [
      { z: -5.9, halfWidthM: 0.05, halfHeightM: 0.05, centreYM: 0.78, exponent: 2 },
      { z: -5.2, halfWidthM: 0.48, halfHeightM: 0.32, centreYM: 0.85, exponent: 2.1 },
      { z: -4.0, halfWidthM: 0.55, halfHeightM: 0.42, centreYM: 0.92, exponent: 2.2 },
      { z: -2.7, halfWidthM: 0.45, halfHeightM: 0.3, centreYM: 0.92, exponent: 2.2 },
      { z: -2.1, halfWidthM: 0.05, halfHeightM: 0.05, centreYM: 0.9, exponent: 2 },
    ],
    28,
  );
  const glass = mesh(canopy, canopyMaterial(0xc4b98e), false);
  glass.renderOrder = 4;
  root.add(glass);
  return {
    root,
    stabs,
    rudders: [],
    burner,
    heat,
    shimmer,
    nozzles: [[0, 0.2, 7.9]],
    wingtips: [
      [5.35, 0.0, 1.6],
      [-5.35, 0.0, 1.6],
    ],
    eye: [0, 1.05, -4.1],
    gearLegs: [],
  };
}

function buildTalon(): JetModel {
  const root = new Group();
  root.name = 'talon';
  const paint = paintMaterial('talon paint', 0x7b8898, 0.62, { light: 0xa7b3c0, dark: 0x5d6a7a });
  const dark = new MeshStandardNodeMaterial({ name: 'nozzle metal', color: srgb(0xb8b2aa), roughness: 0.5, metalness: 1 });
  const radome = new MeshStandardNodeMaterial({ name: 'radome', color: srgb(0x9aa3a8), roughness: 0.5, metalness: 0 });
  const sections: Section[] = [
    { z: -10.95, halfWidthM: 0.04, halfHeightM: 0.04, centreYM: 0.35, exponent: 2 },
    { z: -9.6, halfWidthM: 0.45, halfHeightM: 0.45, centreYM: 0.38, exponent: 2 },
    { z: -8.0, halfWidthM: 0.68, halfHeightM: 0.7, centreYM: 0.45, exponent: 2 },
    { z: -6.4, halfWidthM: 0.8, halfHeightM: 0.88, centreYM: 0.5, exponent: 2.1, bellyScale: 0.85 },
    { z: -4.6, halfWidthM: 1.25, halfHeightM: 0.85, centreYM: 0.42, exponent: 2.0, bellyScale: 0.7 },
    { z: -2.0, halfWidthM: 2.1, halfHeightM: 0.7, centreYM: 0.25, exponent: 2.4, bellyScale: 0.6 },
    { z: 1.0, halfWidthM: 2.35, halfHeightM: 0.72, centreYM: 0.15, exponent: 2.5, bellyScale: 0.6 },
    { z: 4.5, halfWidthM: 2.2, halfHeightM: 0.7, centreYM: 0.15, exponent: 2.5, bellyScale: 0.6 },
    { z: 7.4, halfWidthM: 1.4, halfHeightM: 0.55, centreYM: 0.25, exponent: 2.2 },
    { z: 9.6, halfWidthM: 0.55, halfHeightM: 0.35, centreYM: 0.35, exponent: 2 },
    { z: 10.9, halfWidthM: 0.2, halfHeightM: 0.2, centreYM: 0.38, exponent: 2 },
  ];
  root.add(mesh(loft(sections, 40), paint));
  root.add(mesh(lathe([[-10.95, 0.0], [-10.9, 0.12], [-10.2, 0.36], [-9.6, 0.45]], 0, 0.36, 20), radome));
  // Engine nacelles under the wing roots, with nozzles and flames.
  const burner = uniform(0);
  const heat = uniform(0);
  const nozzles: [number, number, number][] = [];
  const shimmer: Mesh[] = [];
  const flameMat = flameMaterial(burner, 5.2, 9.85);
  const shimmerMat = shimmerMaterial(heat, 10, 9.9);
  for (const side of [1, -1]) {
    const x = side * 1.3;
    root.add(mesh(lathe([[-3.4, 0.55], [-2.6, 0.68], [6.5, 0.7], [9.0, 0.62], [9.4, 0.6]], x, -0.35, 24, true), paint));
    root.add(mesh(lathe([[9.0, 0.6], [9.85, 0.5], [9.86, 0.0]], x, -0.35, 24), dark));
    const flame = mesh(lathe([[9.86, 0.45], [10.8, 0.38], [12.8, 0.18], [15.0, 0.0]], x, -0.35, 18, true), flameMat, false);
    flame.renderOrder = 5;
    flame.layers.set(OVERLAY_LAYER);
    root.add(flame);
    const haze = mesh(lathe([[9.9, 0.45], [11.5, 0.7], [15.5, 1.05], [19.9, 1.25]], x, -0.35, 16, true), shimmerMat, false);
    haze.renderOrder = 4;
    root.add(haze);
    shimmer.push(haze);
    nozzles.push([x, -0.35, 9.9]);
  }
  // Wing (LE sweep ~42°) and the leading-edge root extensions.
  root.add(mesh(surface({ rootX: 1.9, rootY: 0.05, rootLeZ: -1.6, rootChordM: 6.0, spanM: 5.75, tipLeZ: 3.6, tipChordM: 1.45, rootThickness: 0.05, tipThickness: 0.035, dihedralRad: -0.04, mirror: true }), paint));
  root.add(mesh(surface({ rootX: 0.9, rootY: 0.3, rootLeZ: -7.0, rootChordM: 5.6, spanM: 1.2, tipLeZ: -2.2, tipChordM: 0.9, rootThickness: 0.03, tipThickness: 0.02, dihedralRad: -0.02, mirror: true }), paint));
  // Twin vertical tails on the engine booms.
  root.add(mesh(surface({ rootX: 1.85, rootY: 0.55, rootLeZ: 4.9, rootChordM: 3.5, spanM: 3.2, tipLeZ: 7.4, tipChordM: 1.2, rootThickness: 0.045, tipThickness: 0.035, dihedralRad: (87 * Math.PI) / 180, mirror: true }), paint));
  const stabs = { left: new Group(), right: new Group() };
  for (const [side, g] of [
    [1, stabs.right],
    [-1, stabs.left],
  ] as const) {
    g.position.set(side * 2.2, -0.05, 8.0);
    g.add(mesh(surface({ rootX: 0, rootY: 0, rootLeZ: -0.9, rootChordM: 3.3, spanM: 2.75, tipLeZ: 1.2, tipChordM: 1.3, rootThickness: 0.04, tipThickness: 0.03, dihedralRad: 0, mirror: false }), paint));
    if (side < 0) g.scale.x = -1;
    root.add(g);
  }
  const canopy = loft(
    [
      { z: -7.8, halfWidthM: 0.05, halfHeightM: 0.05, centreYM: 1.15, exponent: 2 },
      { z: -7.1, halfWidthM: 0.48, halfHeightM: 0.32, centreYM: 1.22, exponent: 2.1 },
      { z: -5.9, halfWidthM: 0.52, halfHeightM: 0.42, centreYM: 1.3, exponent: 2.2 },
      { z: -4.7, halfWidthM: 0.42, halfHeightM: 0.3, centreYM: 1.3, exponent: 2.2 },
      { z: -4.1, halfWidthM: 0.05, halfHeightM: 0.05, centreYM: 1.25, exponent: 2 },
    ],
    28,
  );
  const glass = mesh(canopy, canopyMaterial(0xe0e8ec), false);
  glass.renderOrder = 4;
  root.add(glass);
  return {
    root,
    stabs,
    rudders: [],
    burner,
    heat,
    shimmer,
    nozzles,
    wingtips: [
      [7.65, -0.15, 5.0],
      [-7.65, -0.15, 5.0],
    ],
    eye: [0, 1.45, -6.0],
    gearLegs: [],
  };
}

/** Moves the control surfaces from the control-law moments (normalised −1…1). */
export function poseSurfaces(model: JetModel, pitch: number, roll: number): void {
  const maxRad = (20 * Math.PI) / 180;
  const p = Math.max(-1, Math.min(1, pitch));
  const r = Math.max(-1, Math.min(1, roll)) * 0.5;
  model.stabs.right.rotation.x = -(p + r) * maxRad;
  model.stabs.left.rotation.x = -(p - r) * maxRad;
}

