import { abs, cameraPosition, dot, float, fract, mix, mx_noise_float, normalize, normalWorld, positionLocal, positionWorld, screenUV, smoothstep, time, uniform, vec2, vec3, viewportSharedTexture } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DoubleSide, Group, type Material, Mesh, MeshBasicNodeMaterial, type Node, SphereGeometry, Vector3 } from 'three/webgpu';
import { AIRCRAFT, type AircraftId } from '../config.ts';
import { blackbody } from '../core/blackbody.ts';
import { bellyY, box, fuselage, lathe, type Station, type Surface, surface, surfacePoint, tube } from './airframe.ts';
import { bakeAmbientOcclusion } from './aoBake.ts';
import { canopyMaterial, nozzleMaterial, type PaintSpec, paintMaterial, plain } from './jetMaterials.ts';
import { addCanopyRain } from './canopyRain.ts';
import { OVERLAY_LAYER, overlayBlending, overlayVisibility } from './stage.ts';

// Procedural models of the two aircraft, built to the scale sheet
// (Wraith 15.70 × 10.70 × 4.33 m, Talon 21.90 × 15.30 × 5.90 m, height with
// the gear down). Origin near the centre of mass, nose towards −z.
//
//   V-17 Wraith  single-engine stealth type: chined nose flowing into a
//                blended body, caret inlets with a bump ahead of each mouth,
//                34° wing with leading-edge flaps and flaperons, canted twin
//                fins with rudders, all-moving tailplanes, a faceted nozzle in a
//                dark coating, gold-coated frameless canopy, internal weapons.
//   K-27 Talon   twin-engine heavy fighter: ogive radome and pitot, raised
//                cockpit with a framed canopy and a sensor ball, wide
//                leading-edge root extensions, engines in separate nacelles with
//                rectangular inlets, 42° wing, twin fins on the booms, ventral
//                fins, tailplanes on the booms, titanium thrust-vectoring
//                nozzles, missiles on rails and pylons.
//
// Moving parts are hinged on their real hinge lines and driven by the control
// laws' moments (poseSurfaces). Invented types: no national markings (rules §13).

export interface Hinge {
  pivot: Group;
  /** Hinge axis in model space, oriented so a positive angle moves the trailing edge down / right. */
  axis: Vector3;
  kind: 'stab' | 'flaperon' | 'lef' | 'rudder' | 'tvc';
  side: 1 | -1;
  maxRad: number;
}

export interface JetModel {
  root: Group;
  hinges: Hinge[];
  /** Afterburner flame size and brightness 0…1, set per frame. */
  burner: { value: number };
  /** Exhaust heat 0…1 (core spool, more with the burner) for the shimmer and the turbine glow. */
  heat: { value: number };
  /** Heat-shimmer volumes behind the nozzles (hidden on Low: they need a copy of the frame). */
  shimmer: Mesh[];
  /** Nozzle exits for effects (contrails, heat shimmer): [x, y, z] in model space. */
  nozzles: [number, number, number][];
  /** Wingtips for vapour trails. */
  wingtips: [number, number, number][];
  /** Pilot's eye in model space. */
  eye: [number, number, number];
  /** One group per gear leg (pivot at the bay roof), with its parts and doors. */
  gearLegs: GearLeg[];
  /** Fuselage stations, for flush gear doors and the like. */
  stations: Station[];
}

export interface GearLeg {
  pivot: Group;
  upper: Mesh;
  piston: Mesh;
  wheels: Group;
  doors: { door: Mesh; openRad: number; axis: 'z' | 'x' }[];
  bay: Mesh;
  /** Attachment height of the logic's spring (the wheel's travel is measured from it). */
  logicY: number;
  travelM: number;
  wheelR: number;
  nose: boolean;
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
  m.colorNode = core.add(plume).mul(burner.mul(burner)).mul(EMISSIVE_EXPOSURE).mul(FLAME_LUMINANCE).mul(overlayVisibility());
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

/** The turbine face deep in the nozzle: a dull red glow with core spool (black body ~800 K). */
function turbineMaterial(heat: { value: number } & Node<'float'>): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ name: 'turbine glow' });
  const c = blackbody(800);
  m.colorNode = vec3(...c).mul(heat.mul(heat).mul(heat).mul(900)).mul(EMISSIVE_EXPOSURE).add(vec3(0.004));
  return m;
}

/** A small emissive light (nav, formation, strobe), luminance in cd/m². */
function lightMaterial(rgb: [number, number, number], luminance: number, strobe = false): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ name: 'light' });
  const flash = strobe ? smoothstep(0.92, 0.94, fract(time.mul(0.9))).mul(float(1).sub(smoothstep(0.97, 0.99, fract(time.mul(0.9))))) : float(1);
  m.colorNode = vec3(...rgb).mul(luminance).mul(flash).mul(EMISSIVE_EXPOSURE);
  return m;
}

function mesh(g: BufferGeometry, m: Material, cast = true): Mesh {
  const out = new Mesh(g, m);
  out.castShadow = cast;
  out.receiveShadow = true;
  return out;
}

/** A hinged piece of a lifting surface: the panel between chord `c0…c1` and span `s0…s1`, pivoting on its hinge line at chord `hingeC`. */
function hinged(sf: Surface, panel: { c0?: number; c1?: number; s0: number; s1: number }, hingeC: number, kind: Hinge['kind'], maxDeg: number, mat: Material): { mesh: Mesh; hinge: Hinge } {
  const side = sf.side ?? 1;
  const g = surface(sf, { ...panel, gapM: 0.012 });
  const a = new Vector3(...surfacePoint(sf, hingeC, panel.s0));
  const b = new Vector3(...surfacePoint(sf, hingeC, panel.s1));
  g.translate(-a.x, -a.y, -a.z);
  const pivot = new Group();
  pivot.position.copy(a);
  const m = mesh(g, mat);
  pivot.add(m);
  const axis = b.clone().sub(a).normalize();
  // Orient the axis so a positive angle means trailing edge down (horizontal) or right (vertical).
  if (Math.abs(axis.x) >= Math.abs(axis.y) ? axis.x < 0 : axis.y < 0) axis.negate();
  return { mesh: m, hinge: { pivot, axis, kind, side, maxRad: (maxDeg * Math.PI) / 180 } };
}

/** A wing built from fixed panels and its moving surfaces (leading-edge flap, flaperon). */
function wing(root: Group, hinges: Hinge[], sf: Surface, mat: Material, layout: { lef?: [number, number, number]; flaperon?: [number, number, number][] }): void {
  const lefC = layout.lef?.[0] ?? 0;
  const lefS0 = layout.lef?.[1] ?? 1;
  const lefS1 = layout.lef?.[2] ?? 1;
  const tc = layout.flaperon?.[0]?.[0] ?? 1;
  // Fixed structure: root strip ahead of the moving surfaces, the box between, and trailing-edge fillers.
  root.add(mesh(surface(sf, { s0: 0, s1: lefS0 }), mat));
  root.add(mesh(surface(sf, { c0: lefC, c1: tc, s0: lefS0, s1: lefS1 }), mat));
  if (lefS1 < 1) root.add(mesh(surface(sf, { s0: lefS1, s1: 1 }), mat));
  if (layout.lef) {
    const lef = hinged(sf, { c0: 0, c1: lefC, s0: lefS0, s1: lefS1 }, lefC, 'lef', 25, mat);
    root.add(lef.hinge.pivot);
    hinges.push(lef.hinge);
  }
  // Trailing edge: alternate fixed fillers and flaperons along the span.
  let s = lefS0;
  for (const [c, s0, s1] of layout.flaperon ?? []) {
    if (s0 > s) root.add(mesh(surface(sf, { c0: c, s0: s, s1: s0 }), mat));
    const f = hinged(sf, { c0: c, s0, s1 }, c, 'flaperon', 22, mat);
    root.add(f.hinge.pivot);
    hinges.push(f.hinge);
    s = s1;
  }
  if (s < lefS1) root.add(mesh(surface(sf, { c0: tc, s0: s, s1: lefS1 }), mat));
}

/** A fin with its rudder. */
function fin(root: Group, hinges: Hinge[], sf: Surface, mat: Material, rudder: [number, number, number]): void {
  const [c, s0, s1] = rudder;
  root.add(mesh(surface(sf, { c1: c, s0: 0, s1: 1 }), mat));
  root.add(mesh(surface(sf, { c0: c, s0: 0, s1: s0 }), mat));
  root.add(mesh(surface(sf, { c0: c, s0: s1, s1: 1 }), mat));
  const r = hinged(sf, { c0: c, s0, s1 }, c, 'rudder', 25, mat);
  root.add(r.hinge.pivot);
  hinges.push(r.hinge);
}

/** An all-moving tailplane pivoting at its root quarter-chord. */
function stab(root: Group, hinges: Hinge[], sf: Surface, mat: Material): void {
  const side = sf.side ?? 1;
  const g = surface(sf);
  const [px, py, pz] = surfacePoint(sf, 0.3, 0);
  g.translate(-px, -py, -pz);
  const pivot = new Group();
  pivot.position.set(px, py, pz);
  pivot.add(mesh(g, mat));
  root.add(pivot);
  hinges.push({ pivot, axis: new Vector3(1, 0, 0), kind: 'stab', side: side as 1 | -1, maxRad: (24 * Math.PI) / 180 });
}

/** A short-range or medium-range missile, nose towards −z, centred on its body axis. */
export function missile(lengthM: number, radiusM: number, finSpanM: number, bands: Material, body: Material, seeker: Material): Group {
  const g = new Group();
  const L = lengthM;
  const r = radiusM;
  g.add(mesh(lathe([[-L / 2, 0.0], [-L / 2 + r * 0.5, r * 0.75], [-L / 2 + r * 2.2, r], [L / 2 - r * 0.6, r], [L / 2, r * 0.8]], 0, 0, 16, true), body));
  g.add(mesh(lathe([[-L / 2 - 0.002, 0.0], [-L / 2 + r * 0.45, r * 0.72], [-L / 2 + r * 0.5, r * 0.76]], 0, 0, 16), seeker, false));
  // Warhead and motor bands.
  g.add(mesh(lathe([[-L * 0.18, r * 1.004], [-L * 0.14, r * 1.004]], 0, 0, 16), bands, false));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    for (const [z0, chord, span] of [
      [L / 2 - L * 0.16, L * 0.14, finSpanM],
      [-L / 2 + L * 0.12, L * 0.07, finSpanM * 0.55],
    ] as const) {
      const f = surface({ rootX: r * 0.9, rootY: 0, rootLeZ: z0, rootChordM: chord, spanM: span, tipLeZ: z0 + chord * 0.6, tipChordM: chord * 0.35, rootThickness: 0.06, tipThickness: 0.05, dihedralRad: 0 }, {}, 8, 2);
      f.rotateZ(a);
      g.add(mesh(f, body));
    }
  }
  return g;
}

/** The pilot as seen through the canopy: seat, shoulders, helmet and visor. Eye at (0, 0, 0). */
function pilot(): Group {
  const g = new Group();
  const seat = plain('seat', 0x2e3032, 0.8);
  const suit = plain('flight suit', 0x4f5642, 0.9);
  const helmet = plain('helmet', 0xd8d8d2, 0.55);
  const visor = canopyMaterial(0x2a2a20, 0xc9a24a);
  visor.opacity = 0.85;
  g.add(mesh(box(-0.3, -0.85, 0.18, 0.3, -0.1, 0.45), seat));
  g.add(mesh(box(-0.2, -0.05, 0.22, 0.2, 0.2, 0.36), seat));
  g.add(mesh(box(-0.24, -0.6, -0.05, 0.24, -0.15, 0.2), suit));
  const head = mesh(new SphereGeometry(0.135, 18, 12), helmet);
  head.position.set(0, 0.06, 0.06);
  g.add(head);
  const vis = mesh(new SphereGeometry(0.14, 18, 8, -Math.PI * 0.85, Math.PI * 0.7, Math.PI * 0.32, Math.PI * 0.3), visor, false);
  vis.position.set(0, 0.06, 0.06);
  g.add(vis);
  return g;
}

/** A wheel (tyre and hub) with its axle along x. */
function wheel(r: number, width: number, tyre: Material, hub: Material): Group {
  const g = new Group();
  const w = width / 2;
  const t = lathe([[-w, r * 0.62], [-w, r * 0.86], [-w * 0.75, r * 0.98], [0, r], [w * 0.75, r * 0.98], [w, r * 0.86], [w, r * 0.62]], 0, 0, 24);
  t.rotateY(Math.PI / 2);
  g.add(mesh(t, tyre));
  const h = lathe([[-w * 0.9, 0.0], [-w * 0.9, r * 0.62], [w * 0.9, r * 0.62], [w * 0.9, 0.0]], 0, 0, 16);
  h.rotateY(Math.PI / 2);
  g.add(mesh(h, hub));
  return g;
}

interface GearSpec {
  doors: { side: number; widthM: number; lengthM: number; axis: 'z' | 'x' }[];
  twin: boolean;
}

/**
 * Landing gear from the logic's leg positions (config.ts): the wheel sits where the spring acts, the strut
 * runs up to the bay roof in the belly. Doors are hinged along the bay edges.
 */
function buildGear(model: JetModel, id: AircraftId, paint: Material): void {
  const metal = plain('gear leg', 0xd7d7d2, 0.45);
  const chrome = plain('oleo', 0xc6c6c8, 0.15, 1);
  const tyre = plain('tyre', 0x2c2c2e, 0.86);
  const hub = plain('hub', 0xb9bbbd, 0.35, 1);
  const bayMat = plain('gear bay', 0x3a3c3b, 0.8);
  for (const leg of AIRCRAFT[id].gear.legs) {
    const roofY = bellyY(model.stations, leg.x, leg.z) + 0.04;
    const pivot = new Group();
    pivot.position.set(leg.x, roofY, leg.z);
    const r = leg.nose ? (id === 'talon' ? 0.33 : 0.3) : id === 'talon' ? 0.52 : 0.42;
    const upper = mesh(lathe([[0, 0.085], [1, 0.085]], 0, 0, 12).rotateX(Math.PI / 2), metal);
    const piston = mesh(lathe([[0, 0.06], [1, 0.06]], 0, 0, 12).rotateX(Math.PI / 2), chrome);
    const wheels = new Group();
    const spec: GearSpec = leg.nose ? { twin: id === 'talon', doors: [{ side: 1, widthM: 0.32, lengthM: 1.1, axis: 'z' }, { side: -1, widthM: 0.32, lengthM: 1.1, axis: 'z' }] } : { twin: false, doors: [{ side: Math.sign(leg.x) || 1, widthM: 0.65, lengthM: 1.5, axis: 'z' }] };
    const widthM = leg.nose ? 0.18 : id === 'talon' ? 0.32 : 0.28;
    if (spec.twin) {
      for (const sx of [-0.13, 0.13]) {
        const w = wheel(r, widthM, tyre, hub);
        w.position.x = sx;
        wheels.add(w);
      }
    } else wheels.add(wheel(r, widthM, tyre, hub));
    pivot.add(upper, piston, wheels);
    // The bay: a dark-grey well just under the skin, shown while the doors are open.
    const bay = mesh(box(-0.36, -0.03, -0.75, 0.36, 0.0, 0.75), bayMat, false);
    bay.position.set(leg.x, roofY - 0.06, leg.z);
    model.root.add(bay);
    const doors: GearLeg['doors'] = [];
    for (const d of spec.doors) {
      // Hinged on the bay's outer edge, the plate reaching inwards; opening swings it down.
      const inward = -d.widthM * d.side;
      const door = mesh(box(Math.min(0, inward), -0.012, -d.lengthM / 2, Math.max(0, inward), 0.0, d.lengthM / 2), paint);
      door.position.set(leg.x + 0.36 * d.side, roofY - 0.05, leg.z);
      model.root.add(door);
      doors.push({ door, openRad: 1.45 * d.side, axis: d.axis });
    }
    model.root.add(pivot);
    model.gearLegs.push({ pivot, upper, piston, wheels, doors, bay, logicY: leg.y, travelM: leg.travelM, wheelR: r, nose: leg.nose });
  }
}

/** Gear position 0 (up) … 1 (down) and per-leg compression (m). */
export function poseGear(model: JetModel, position: number, compression: readonly number[]): void {
  model.gearLegs.forEach((leg, i) => {
    const down = position > 0.02;
    leg.pivot.visible = down;
    leg.bay.visible = down;
    // Doors open first and close last.
    const doorOpen = Math.min(1, position * 3);
    for (const d of leg.doors) {
      if (d.axis === 'z') d.door.rotation.z = d.openRad * doorOpen;
      else d.door.rotation.x = d.openRad * doorOpen;
    }
    // Retracts by swinging forward (mains) or aft (nose) into the bay.
    leg.pivot.rotation.x = (1 - position) * (leg.nose ? -1.5 : 1.5);
    // Wheel centre where the logic's spring puts it, relative to the bay roof.
    const extension = leg.travelM - (compression[i] ?? 0);
    const wheelY = leg.logicY - extension + leg.wheelR - leg.pivot.position.y;
    const len = Math.max(0.1, -wheelY);
    // Upper cylinder: fixed 60 % of the full length; the chrome piston slides out of it.
    const full = Math.max(0.1, -(leg.logicY - leg.travelM + leg.wheelR - leg.pivot.position.y));
    leg.upper.scale.set(1, full * 0.62, 1);
    leg.upper.position.y = 0;
    leg.piston.scale.set(1, Math.max(0.05, len - full * 0.45), 1);
    leg.piston.position.y = -full * 0.45;
    leg.wheels.position.y = wheelY;
  });
}

// ---------------------------------------------------------------------------------------------- Wraith

function buildWraith(): JetModel {
  const root = new Group();
  root.name = 'wraith';
  // Saw-toothed door edges in plan view, as on a stealth airframe: two weapon bays and the gear doors
  // underneath, the refuelling door on the spine.
  const spec: PaintSpec = {
    name: 'wraith coating',
    base: 0x6a6d71,
    roughness: 0.58,
    panels: { frameM: 1.05, splitM: 0.75, seamM: 0.0035, access: 0.3, rivets: false, tape: true },
    soot: { fromZ: 5.4, toZ: 7.2 },
    doors: [
      { x0: 0.3, x1: 1.12, z0: -2.5, z1: 1.3, saw: 0.26, up: false },
      { x0: -1.12, x1: -0.3, z0: -2.5, z1: 1.3, saw: 0.26, up: false },
      { x0: 1.2, x1: 1.95, z0: 0.1, z1: 1.7, saw: 0.2, up: false },
      { x0: -1.95, x1: -1.2, z0: 0.1, z1: 1.7, saw: 0.2, up: false },
      { x0: -0.26, x1: 0.26, z0: -5.25, z1: -4.0, saw: 0.18, up: false },
      { x0: -0.24, x1: 0.24, z0: 0.5, z1: 1.15, saw: 0.16, up: true },
    ],
  };
  const paint = paintMaterial(spec);
  // Wings and tails: the same coating with the leading-edge band.
  const surfPaint = paintMaterial({ ...spec, name: 'wraith coating, surfaces', doors: [], leadingEdge: true });
  const hinges: Hinge[] = [];
  // Chined nose (sharp side edge), a steep cheek at the inlets, a blended body, round at the nozzle.
  const S = (z: number, top: number, bot: number, w: number, yc: number, tw: number, bw: number, su: number, sl: number): Station => ({ z, top, bot, w, yc, tw, bw, su, sl });
  const stations: Station[] = [
    S(-7.85, 0.02, -0.02, 0.02, 0.0, 0.3, 0.3, 0.9, 0.9),
    S(-7.5, 0.16, -0.13, 0.17, 0.0, 0.25, 0.3, 0.95, 0.9),
    S(-6.6, 0.46, -0.38, 0.5, -0.02, 0.3, 0.4, 0.95, 0.85),
    S(-5.5, 0.7, -0.58, 0.72, -0.04, 0.35, 0.45, 0.9, 0.8),
    S(-4.3, 0.84, -0.7, 0.9, -0.02, 0.4, 0.5, 0.85, 0.8),
    S(-3.62, 0.9, -0.74, 1.0, 0.02, 0.42, 0.55, 0.85, 0.8),
    S(-3.32, 0.98, -0.76, 1.6, 0.05, 0.48, 0.6, 0.85, 0.8),
    S(-1.0, 1.06, -0.78, 1.78, 0.08, 0.55, 0.62, 0.85, 0.8),
    S(2.0, 1.0, -0.74, 1.76, 0.08, 0.55, 0.62, 0.85, 0.8),
    S(4.0, 0.94, -0.68, 1.45, 0.1, 0.5, 0.6, 0.75, 0.7),
    S(5.4, 0.84, -0.56, 1.0, 0.14, 0.48, 0.55, 0.5, 0.45),
    S(6.3, 0.77, -0.48, 0.74, 0.15, 0.55, 0.55, 0.15, 0.15),
    S(6.85, 0.74, -0.44, 0.62, 0.15, 0.55, 0.55, 0.0, 0.0),
  ];
  root.add(mesh(fuselage(stations, { stepM: 0.06, perQuarter: 22 }), paint));
  // Caret inlets on the cheek face: a raked trapezoid mouth (top lip ahead of the bottom), a sharp lip,
  // and the diverterless bump on the body side ahead of it.
  const inletDark = plain('inlet duct', 0x18191b, 0.9);
  for (const side of [1, -1]) {
    const xi = side * 1.0;
    const xo = side * 1.56;
    const corners: [number, number, number][] = [
      [xi, 0.62, -3.66],
      [xo, 0.48, -3.6],
      [xo * 0.98, -0.22, -3.44],
      [xi, -0.3, -3.4],
    ];
    root.add(mesh(mouth(corners, 0.7), inletDark, false));
    root.add(mesh(tube([...corners, corners[0]!], 0.018, 6, false), paint));
    const bump = lathe([[-4.75, 0.0], [-4.35, 0.12], [-3.95, 0.15], [-3.66, 0.02]], 0, 0, 16, true);
    bump.scale(1, 2.2, 1).translate(side * 0.86, 0.18, 0);
    root.add(mesh(bump, paint));
  }
  // Tail booms either side of the engine, carrying the fins and tailplanes past the nozzle.
  for (const side of [1, -1] as const) {
    root.add(mesh(fuselage([S(3.0, 0.5, 0.0, 0.05, 0.25, 0.5, 0.5, 0.4, 0.4), S(4.4, 0.78, -0.16, 0.27, 0.3, 0.55, 0.55, 0.6, 0.5), S(7.3, 0.72, -0.12, 0.25, 0.3, 0.55, 0.55, 0.6, 0.5), S(8.05, 0.46, 0.06, 0.07, 0.26, 0.5, 0.5, 0.4, 0.4)], { offsetX: side * 1.12, stepM: 0.08, perQuarter: 10 }), paint));
  }
  // Wing: 34° leading-edge sweep, forward-swept trailing edge; leading-edge flaps and flaperons.
  for (const side of [1, -1] as const) {
    const sf: Surface = { rootX: 1.2, rootY: 0.08, rootLeZ: -2.05, rootChordM: 5.25, spanM: 4.15, tipLeZ: 0.75, tipChordM: 1.45, rootThickness: 0.05, tipThickness: 0.035, dihedralRad: -0.03, side };
    wing(root, hinges, sf, surfPaint, { lef: [0.14, 0.14, 1], flaperon: [[0.8, 0.24, 0.86]] });
    // Canted fins (25° outboard) on the booms, with rudders.
    fin(root, hinges, { rootX: 1.12, rootY: 0.7, rootLeZ: 3.9, rootChordM: 2.7, spanM: 1.6, tipLeZ: 5.5, tipChordM: 1.1, rootThickness: 0.05, tipThickness: 0.04, dihedralRad: (65 * Math.PI) / 180, side }, surfPaint, [0.7, 0.1, 0.92]);
    // All-moving tailplanes on the booms, trailing edges past the nozzle.
    stab(root, hinges, { rootX: 1.15, rootY: 0.28, rootLeZ: 5.4, rootChordM: 2.5, spanM: 2.25, tipLeZ: 6.9, tipChordM: 1.0, rootThickness: 0.04, tipThickness: 0.03, dihedralRad: 0, side }, surfPaint);
  }
  // Nozzle: a twelve-petal faceted shroud in a dark coating with a saw-tooth exit edge, the turbine
  // glowing deep inside.
  const burner = uniform(0);
  const heat = uniform(0);
  const petals = (a: number, f: number): number => {
    const n = 12;
    const seg = (Math.PI * 2) / n;
    const local = ((a % seg) + seg) % seg - seg / 2;
    return f > 0.3 ? Math.cos(seg / 2) / Math.cos(local) : 1;
  };
  const teeth = (a: number, f: number): number => {
    if (f < 1) return 0;
    const t = ((a / (Math.PI * 2)) * 12) % 1;
    return -0.1 * Math.abs(t - 0.5) * 2;
  };
  root.add(mesh(lathe([[6.8, 0.63], [7.3, 0.6], [7.9, 0.54]], 0, 0.15, 48, false, petals, teeth), nozzleMaterial('ceramic', 6.8, 7.9)));
  const inner = plain('nozzle liner', 0x2a2a2c, 0.7);
  inner.side = DoubleSide;
  root.add(mesh(lathe([[7.86, 0.5], [7.2, 0.46]], 0, 0.15, 24), inner, false));
  const turbine = mesh(lathe([[7.2, 0.46], [7.2, 0.0]], 0, 0.15, 24), turbineMaterial(heat), false);
  root.add(turbine);
  const flame = mesh(lathe([[7.86, 0.47], [8.6, 0.4], [10.5, 0.22], [12.2, 0.0]], 0, 0.15, 18), flameMaterial(burner, 4.3, 7.86), false);
  flame.renderOrder = 5;
  flame.layers.set(OVERLAY_LAYER);
  root.add(flame);
  const shimmer = [mesh(lathe([[7.9, 0.5], [9.5, 0.75], [13.5, 1.1], [17.9, 1.3]], 0, 0.15, 16), shimmerMaterial(heat, 10, 7.9), false)];
  shimmer[0]!.renderOrder = 4;
  root.add(shimmer[0]!);
  // Single-piece canopy with a gold metallised coating; a dark sill frame and the aft bow.
  const canopyStations = [S(-5.8, 0.66, 0.6, 0.05, 0.63, 0.4, 0.4, 0.2, 0.2), S(-5.2, 1.08, 0.6, 0.44, 0.7, 0.45, 0.4, 0.3, 0.0), S(-4.25, 1.38, 0.65, 0.54, 0.82, 0.5, 0.4, 0.2, 0.0), S(-3.2, 1.28, 0.7, 0.5, 0.88, 0.5, 0.4, 0.25, 0.0), S(-2.6, 1.08, 0.8, 0.3, 0.92, 0.45, 0.4, 0.4, 0.0)];
  const glassMat = canopyMaterial(0x4a4636, 0xd9c590);
  addCanopyRain(glassMat);
  const glass = mesh(fuselage(canopyStations, { stepM: 0.06, perQuarter: 16 }), glassMat, false);
  glass.name = 'canopy glass';
  glass.renderOrder = 4;
  root.add(glass);
  const frameMat = plain('canopy frame', 0x3c3e40, 0.6);
  for (const side of [1, -1]) {
    const sill: [number, number, number][] = [];
    for (let z = -5.7; z <= -2.75; z += 0.15) {
      const st = stationAt2(canopyStations, z);
      sill.push([side * st.w * 0.97, st.yc + 0.01, z]);
    }
    root.add(mesh(tube(sill, 0.03, 6, false), frameMat));
  }
  root.add(mesh(tube(fuselageRing(canopyStations, -2.8, 0.01), 0.045, 6, false), frameMat));
  const cockpit = pilot();
  cockpit.position.set(0, 1.1, -4.25);
  root.add(cockpit);
  root.add(mesh(box(-0.5, 0.62, -5.4, 0.5, 0.84, -2.8), plain('cockpit tub', 0x26282a, 0.9), false));
  // Sensor window under the nose (faceted sapphire), aperture windows round the body, antenna blades.
  const sapphire = canopyMaterial(0x1d2228, 0xb0a070);
  sapphire.opacity = 0.9;
  const eots = lathe([[-6.55, 0.0], [-6.35, 0.13], [-5.95, 0.15], [-5.75, 0.0]], 0, -0.36, 7, false);
  eots.scale(1, 0.55, 1);
  root.add(mesh(eots, sapphire, false));
  for (const [x, y, z, ry] of [
    [0, 1.07, -1.9, 0],
    [0, -0.79, 0.3, Math.PI],
    [0.66, 0.42, -5.3, -0.9],
    [-0.66, 0.42, -5.3, 0.9],
  ] as const) {
    const w = mesh(lathe([[-0.11, 0.0], [-0.08, 0.06], [0.08, 0.06], [0.11, 0.0]], 0, 0, 4, false), sapphire, false);
    w.scale.set(1, 0.15, 1);
    w.position.set(x, y, z);
    w.rotation.z = ry;
    root.add(w);
  }
  root.add(mesh(box(-0.006, 1.04, 0.2, 0.006, 1.2, 0.45), paint));
  root.add(mesh(box(-0.006, -0.84, -1.2, 0.006, -0.68, -0.95), paint));
  addLights(root, [[5.33, 0.02, 1.4], [-5.33, 0.02, 1.4]], [0, 1.07, 2.6], [0, 0.75, 6.75]);
  const model: JetModel = {
    root,
    hinges,
    burner,
    heat,
    shimmer,
    nozzles: [[0, 0.15, 7.9]],
    wingtips: [
      [5.35, 0.0, 1.6],
      [-5.35, 0.0, 1.6],
    ],
    eye: [0, 1.12, -4.25],
    gearLegs: [],
    stations,
  };
  buildGear(model, 'wraith', paint);
  return model;
}

/**
 * An inlet mouth: the front face through four corners (inner top, outer top, outer bottom, inner bottom)
 * and the duct walls running `depthM` aft into the body, dark inside.
 */
function mouth(c: [number, number, number][], depthM: number): BufferGeometry {
  const back = c.map(([x, y, z]) => [x * 0.92, y * 0.9 + 0.02, z + depthM] as [number, number, number]);
  const pos: number[] = [];
  const quad = (a: number[], b: number[], d: number[], e: number[]): void => {
    pos.push(...a, ...b, ...d, ...a, ...d, ...e);
  };
  // The front face is drawn from both sides; the walls show the duct turning away inside.
  quad(c[0]!, c[1]!, c[2]!, c[3]!);
  quad(c[0]!, c[3]!, c[2]!, c[1]!);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(c[i]!, back[i]!, back[j]!, c[j]!);
    quad(c[i]!, c[j]!, back[j]!, back[i]!);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/** Wingtip nav lights (green right, red left), a strobe on the spine and a white tail light. */
function addLights(root: Group, tips: [number, number, number][], strobe: [number, number, number], tail: [number, number, number]): void {
  const geo = new SphereGeometry(0.04, 10, 6);
  const green = mesh(geo, lightMaterial([0.1, 1, 0.3], 20_000), false);
  green.position.set(...tips[0]!);
  const red = mesh(geo, lightMaterial([1, 0.05, 0.03], 20_000), false);
  red.position.set(...tips[1]!);
  const white = mesh(geo, lightMaterial([1, 1, 1], 15_000), false);
  white.position.set(...tail);
  const flash = mesh(geo, lightMaterial([1, 0.95, 0.9], 400_000, true), false);
  flash.position.set(...strobe);
  root.add(green, red, white, flash);
}

// ---------------------------------------------------------------------------------------------- Talon

function buildTalon(): JetModel {
  const root = new Group();
  root.name = 'talon';
  const spec: PaintSpec = {
    name: 'talon paint',
    base: 0x7b8898,
    roughness: 0.62,
    belly: 0xb4c0cc,
    camo: { dark: 0x56657a, light: 0xa3afbd, scaleM: 3.2 },
    panels: { frameM: 0.85, splitM: 0.6, seamM: 0.003, access: 0.35, rivets: true, tape: false },
    soot: { fromZ: 7.8, toZ: 9.6 },
  };
  const paint = paintMaterial(spec);
  const hinges: Hinge[] = [];
  const S = (z: number, top: number, bot: number, w: number, yc: number, tw: number, bw: number, su: number, sl: number): Station => ({ z, top, bot, w, yc, tw, bw, su, sl });
  // Central body: round forward fuselage behind the radome, the cockpit hump, sharp-edged leading-edge
  // root extensions spreading into the flat centre section between the engines, a tail stinger.
  const stations: Station[] = [
    S(-9.0, 0.79, -0.09, 0.44, 0.35, 0.55, 0.55, 0.0, 0.0),
    S(-7.6, 1.08, -0.26, 0.66, 0.4, 0.55, 0.55, 0.1, 0.05),
    S(-6.0, 1.22, -0.33, 0.8, 0.42, 0.55, 0.55, 0.2, 0.1),
    S(-4.6, 1.2, -0.32, 1.15, 0.38, 0.55, 0.55, 0.65, 0.35),
    S(-3.2, 1.12, -0.28, 2.05, 0.3, 0.55, 0.55, 0.95, 0.75),
    S(-1.4, 1.02, -0.24, 2.2, 0.22, 0.55, 0.6, 0.95, 0.8),
    S(0.6, 0.95, -0.22, 1.7, 0.2, 0.6, 0.6, 0.9, 0.8),
    S(4.0, 0.86, -0.18, 1.35, 0.2, 0.6, 0.6, 0.85, 0.8),
    S(7.6, 0.66, -0.02, 0.6, 0.3, 0.55, 0.55, 0.4, 0.3),
    S(9.6, 0.55, 0.15, 0.28, 0.35, 0.55, 0.55, 0.1, 0.1),
    S(10.95, 0.42, 0.28, 0.1, 0.35, 0.55, 0.55, 0.0, 0.0),
  ];
  root.add(mesh(fuselage(stations, { stepM: 0.1, perQuarter: 20 }), paint));
  // Radome (lighter grey, no panel lines) and the pitot boom.
  const radome = plain('radome', 0x9aa3a8, 0.5);
  root.add(mesh(lathe([[-10.42, 0.0], [-10.38, 0.05], [-10.1, 0.19], [-9.7, 0.32], [-9.3, 0.4], [-9.0, 0.44]], 0, 0.35, 32), radome));
  root.add(mesh(tube([[0, 0.35, -10.4], [0, 0.35, -10.95]], 0.018, 8), plain('pitot', 0xc6c6c8, 0.3, 1)));
  // Engine nacelles: rectangular inlets with dark ducts, rounding towards the nozzles.
  const inletDark = plain('inlet duct', 0x1e1f21, 0.85);
  inletDark.side = DoubleSide;
  const nozzles: [number, number, number][] = [];
  const burner = uniform(0);
  const heat = uniform(0);
  const shimmer: Mesh[] = [];
  // Flame and shimmer live in the nozzle's pivot group: their z starts at the exit, 1.3 m aft of the pivot.
  const flameMat = flameMaterial(burner, 5.2, 1.31);
  const shimmerMat = shimmerMaterial(heat, 10, 1.3);
  const titanium = nozzleMaterial('titanium', 8.6, 9.9);
  const inner = plain('nozzle liner', 0x2a2a2c, 0.7);
  inner.side = DoubleSide;
  const turbineMat = turbineMaterial(heat);
  const petals = (a: number, f: number): number => {
    const n = 16;
    const seg = (Math.PI * 2) / n;
    const local = ((a % seg) + seg) % seg - seg / 2;
    return f > 0.2 ? Math.cos(seg / 2) / Math.cos(local) : 1;
  };
  for (const side of [1, -1] as const) {
    const x = side * 1.32;
    const nac: Station[] = [S(-3.5, 0.18, -0.92, 0.46, -0.37, 0.92, 0.92, 0.0, 0.0), S(-1.2, 0.24, -0.98, 0.6, -0.37, 0.85, 0.85, 0.0, 0.0), S(3.5, 0.22, -0.98, 0.68, -0.37, 0.65, 0.65, 0.0, 0.0), S(8.6, 0.25, -0.95, 0.6, -0.35, 0.55, 0.55, 0.0, 0.0)];
    root.add(mesh(fuselage(nac, { offsetX: x, capStart: false, capEnd: false, stepM: 0.12, perQuarter: 12 }), paint));
    root.add(mesh(fuselage([S(-3.45, 0.12, -0.86, 0.4, -0.37, 0.92, 0.92, 0.0, 0.0), S(-1.2, 0.05, -0.75, 0.32, -0.35, 0.8, 0.8, 0.0, 0.0)], { offsetX: x, capStart: false, stepM: 0.25, perQuarter: 8 }), inletDark, false));
    // Thrust-vectoring nozzle on its own pivot: petals in heat-tinted titanium, flame and shimmer with it.
    const tvc = new Group();
    tvc.position.set(x, -0.35, 8.6);
    tvc.add(mesh(lathe([[0, 0.6], [0.6, 0.57], [1.3, 0.5]], 0, 0, 40, false, petals), titanium));
    tvc.add(mesh(lathe([[1.29, 0.46], [0.4, 0.44]], 0, 0, 24), inner, false));
    tvc.add(mesh(lathe([[0.4, 0.44], [0.4, 0.0]], 0, 0, 24), turbineMat, false));
    const flame = mesh(lathe([[1.31, 0.44], [2.2, 0.38], [4.2, 0.18], [6.4, 0.0]], 0, 0, 18), flameMat, false);
    flame.renderOrder = 5;
    flame.layers.set(OVERLAY_LAYER);
    tvc.add(flame);
    const haze = mesh(lathe([[1.35, 0.45], [2.9, 0.7], [6.9, 1.05], [11.3, 1.25]], 0, 0, 16), shimmerMat, false);
    haze.renderOrder = 4;
    tvc.add(haze);
    shimmer.push(haze);
    root.add(tvc);
    hinges.push({ pivot: tvc, axis: new Vector3(1, 0, 0), kind: 'tvc', side, maxRad: (15 * Math.PI) / 180 });
    nozzles.push([x, -0.35, 9.9]);
  }
  // Wing: 42° leading-edge sweep, full-span leading-edge flaps, flaperons; launch rails at the tips.
  const body = plain('missile body', 0xd6d8d4, 0.5);
  const band = plain('missile band', 0xc9a227, 0.6);
  const seeker = canopyMaterial(0x2a2f33, 0x8899aa);
  seeker.opacity = 0.9;
  const pylonMat = paint;
  for (const side of [1, -1] as const) {
    const sf: Surface = { rootX: 1.5, rootY: 0.1, rootLeZ: -1.4, rootChordM: 6.2, spanM: 6.15, tipLeZ: 4.14, tipChordM: 1.45, rootThickness: 0.05, tipThickness: 0.035, dihedralRad: -0.04, side };
    wing(root, hinges, sf, paint, { lef: [0.15, 0.08, 1], flaperon: [[0.78, 0.12, 0.6], [0.76, 0.62, 0.94]] });
    // Tail boom outboard of the nacelle, carrying the fin and the tailplane.
    root.add(mesh(fuselage([S(1.0, 0.12, -0.12, 0.05, 0.0, 0.5, 0.5, 0.3, 0.3), S(3.0, 0.34, -0.2, 0.22, 0.05, 0.6, 0.6, 0.3, 0.3), S(8.0, 0.36, -0.2, 0.24, 0.05, 0.6, 0.6, 0.3, 0.3), S(10.2, 0.2, -0.12, 0.08, 0.04, 0.5, 0.5, 0.2, 0.2)], { offsetX: side * 2.12, stepM: 0.15, perQuarter: 8 }), paint));
    // Twin fins on the booms (slight cant) with rudders; ventral fins below the nacelles.
    fin(root, hinges, { rootX: 2.1, rootY: 0.25, rootLeZ: 4.45, rootChordM: 3.6, spanM: 2.78, tipLeZ: 7.0, tipChordM: 1.4, rootThickness: 0.045, tipThickness: 0.035, dihedralRad: (85 * Math.PI) / 180, side }, paint, [0.72, 0.1, 0.9]);
    root.add(mesh(surface({ rootX: 1.95, rootY: -0.75, rootLeZ: 5.0, rootChordM: 1.7, spanM: 0.85, tipLeZ: 5.7, tipChordM: 0.8, rootThickness: 0.05, tipThickness: 0.04, dihedralRad: (-75 * Math.PI) / 180, side }), paint));
    stab(root, hinges, { rootX: 2.3, rootY: -0.12, rootLeZ: 7.25, rootChordM: 3.2, spanM: 2.6, tipLeZ: 9.0, tipChordM: 1.2, rootThickness: 0.04, tipThickness: 0.03, dihedralRad: 0, side }, paint);
    // Tip rail with a short-range missile; two pylons with medium-range missiles under the wing.
    const tip = surfacePoint(sf, 0.45, 1);
    root.add(mesh(box(tip[0] - 0.05, tip[1] - 0.09, tip[2] - 1.4, tip[0] + 0.05, tip[1] + 0.03, tip[2] + 1.3), pylonMat));
    const srm = missile(2.9, 0.064, 0.2, band, body, seeker);
    srm.position.set(tip[0] + 0.12 * side, tip[1], tip[2] - 0.2);
    root.add(srm);
    for (const [s, c, len, rad, fin] of [
      [0.32, 0.4, 3.7, 0.1, 0.22],
      [0.62, 0.42, 3.0, 0.064, 0.2],
    ] as const) {
      const [px, py, pz] = surfacePoint(sf, c, s);
      root.add(mesh(box(px - 0.06, py - 0.42, pz - 1.0, px + 0.06, py - 0.03, pz + 0.9), pylonMat));
      const mm = missile(len, rad, fin, band, body, seeker);
      mm.position.set(px, py - 0.42 - rad, pz - 0.2);
      root.add(mm);
    }
  }
  // Raised framed canopy, the windscreen bow frame, the sensor ball ahead of it.
  const canopyStations = [S(-7.75, 0.98, 0.95, 0.06, 0.96, 0.4, 0.4, 0.2, 0.0), S(-7.1, 1.42, 0.95, 0.48, 1.05, 0.45, 0.4, 0.35, 0.0), S(-6.2, 1.74, 0.98, 0.56, 1.12, 0.5, 0.4, 0.2, 0.0), S(-5.0, 1.62, 1.0, 0.5, 1.12, 0.5, 0.4, 0.25, 0.0), S(-4.2, 1.28, 1.05, 0.26, 1.12, 0.45, 0.4, 0.45, 0.0)];
  const glassMat = canopyMaterial(0x39424a, null);
  addCanopyRain(glassMat);
  const glass = mesh(fuselage(canopyStations, { stepM: 0.08, perQuarter: 14 }), glassMat, false);
  glass.name = 'canopy glass';
  glass.renderOrder = 4;
  root.add(glass);
  const frameMat = plain('canopy frame', 0x5d6a7a, 0.6);
  for (const z of [-6.62, -4.7]) {
    const sec = canopyStations;
    const st = fuselageRing(sec, z, 0.015);
    root.add(mesh(tube(st, 0.035, 6, false), frameMat));
  }
  const cockpit = pilot();
  cockpit.position.set(0, 1.45, -6.1);
  root.add(cockpit);
  root.add(mesh(box(-0.5, 0.95, -7.3, 0.5, 1.12, -4.5), plain('cockpit tub', 0x26282a, 0.9), false));
  const ball = mesh(new SphereGeometry(0.19, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), canopyMaterial(0x30363c, 0x9fb0c0), false);
  ball.position.set(0.22, 1.08, -8.0);
  root.add(ball);
  addLights(root, [[7.72, -0.05, 4.8], [-7.72, -0.05, 4.8]], [0, 1.2, -1.0], [0, 0.42, 10.95]);
  const model: JetModel = {
    root,
    hinges,
    burner,
    heat,
    shimmer,
    nozzles,
    wingtips: [
      [7.65, -0.15, 5.0],
      [-7.65, -0.15, 5.0],
    ],
    eye: [0, 1.5, -6.05],
    gearLegs: [],
    stations,
  };
  buildGear(model, 'talon', paint);
  return model;
}

/** The upper arc of a canopy section at z, lifted `lift` m off the glass, as a path from sill to sill. */
function fuselageRing(stations: Station[], z: number, lift: number): [number, number, number][] {
  const s = stationAt2(stations, z);
  const pts: [number, number, number][] = [];
  const n = 12;
  for (let i = -n; i <= n; i++) {
    const t = (i / n) * (Math.PI / 2);
    const x = Math.sin(t) * (s.w + lift);
    const y = s.yc + Math.cos(t) * (s.top - s.yc + lift);
    pts.push([x, y, z]);
  }
  return pts;
}

function stationAt2(stations: Station[], z: number): Station {
  let i = 0;
  while (i < stations.length - 2 && stations[i + 1]!.z < z) i++;
  const a = stations[i]!;
  const b = stations[i + 1]!;
  const f = Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z)));
  const l = (p: number, q: number): number => p + (q - p) * f;
  return { z, top: l(a.top, b.top), bot: l(a.bot, b.bot), w: l(a.w, b.w), yc: l(a.yc, b.yc), tw: l(a.tw, b.tw), bw: l(a.bw, b.bw), su: l(a.su, b.su), sl: l(a.sl, b.sl) };
}

export function buildJet(id: AircraftId): JetModel {
  const model = id === 'wraith' ? buildWraith() : buildTalon();
  const t0 = performance.now();
  bakeAmbientOcclusion(model.root);
  console.log(`${id}: ambient occlusion baked in ${(performance.now() - t0).toFixed(0)} ms`);
  return model;
}

export interface SurfaceCommand {
  /** Normalised control-law moments −1…1. */
  pitch: number;
  roll: number;
  yaw: number;
  /** Angle of attack (rad), for the leading-edge flap schedule. */
  alphaRad: number;
  /** Weight on wheels: flaps down for take-off and landing. */
  gearDown: boolean;
}

/** Moves every hinged surface from the control-law moments. */
export function poseSurfaces(model: JetModel, cmd: SurfaceCommand): void {
  const p = Math.max(-1, Math.min(1, cmd.pitch));
  const r = Math.max(-1, Math.min(1, cmd.roll));
  const y = Math.max(-1, Math.min(1, cmd.yaw));
  // Leading-edge flaps droop with angle of attack (0 at 3°, full by 25°), and for landing.
  const lef = Math.max(cmd.gearDown ? 0.45 : 0, Math.min(1, ((cmd.alphaRad * 180) / Math.PI - 3) / 22));
  for (const h of model.hinges) {
    let angle = 0;
    switch (h.kind) {
      case 'stab':
        // Pitch up: trailing edges up; roll right: right tailplane trailing edge up.
        angle = -(p + r * 0.5 * h.side) * h.maxRad;
        break;
      case 'flaperon':
        angle = (-r * h.side + (cmd.gearDown ? 0.6 : 0)) * h.maxRad;
        break;
      case 'lef':
        angle = -lef * h.maxRad;
        break;
      case 'rudder':
        angle = -y * h.maxRad;
        break;
      case 'tvc':
        // Pitch up: nozzle exits move up.
        angle = -p * h.maxRad;
        break;
    }
    h.pivot.quaternion.setFromAxisAngle(h.axis, Math.max(-h.maxRad, Math.min(h.maxRad, angle)));
  }
}
