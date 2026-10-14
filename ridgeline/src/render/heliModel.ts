import { atan, float, fract, length, max, min, mix, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type MeshPhysicalNodeMaterial,
  type Node,
  RingGeometry,
  SphereGeometry,
} from 'three/webgpu';
import { HELICOPTERS, type HeliId } from '../config.ts';
import type { Hardpoints } from '../sim/weapons.ts';
import { box, fuselage, lathe, type Station, surface, tube } from './airframe.ts';
import { bakeAmbientOcclusion } from './aoBake.ts';
import { bandMaterials, bladeAntenna, dispenser, irJammer, missile, navLight, opticsMaterial, rocketPod, sensorTurret, step, suppressor, wireCutter } from './heliDetail.ts';
import { canopyMaterial, paintMaterial, plain } from './jetMaterials.ts';
import { addCanopyRain } from './canopyRain.ts';

// The two helicopters, procedural (no model files), in body axes (x right,
// y up, −z forward, origin at the centre of gravity) so they line up with the
// flight model: hub, wheels, tail rotor and eyes are the config's numbers.
//
//   Warden   (AH-64 class) a narrow fuselage with flat sides and long cheek
//            fairings; the tandem cockpit under a faceted flat-plate canopy,
//            the pilot's seat stepped up behind the gunner's, a blast shield
//            between them; the sensor turret on the nose — a drum with two
//            sensor "ears" below and a small night-vision turret above; the
//            chin cannon on its turret; engines in pods either side of the
//            mast with intakes in front and exhaust suppressors turned out; a
//            radar dome over the rotor; stub wings with rocket pods inboard
//            and anti-armour missile racks outboard; a long boom to a swept
//            fin, a low stabilator, the scissor tail rotor on the left, and a
//            tail wheel under it; main gear on trailing struts;
//   Bulat    (Mi-28 class) the same layout, bulkier and blunter, five blades,
//            no radar dome, the tail rotor on the right.
//
// The rotors: real blades at low RPM; above ~40 % they cross-fade into a disc
// whose shader draws each blade as the arc it sweeps during one frame's exposure
// — darkest at the leading edge, fading behind — so at 100 % the rotor reads as
// a disc with moving blade shadows, as in film, and never as strobing ghosts
// (TAA and motion blur alone smear a fast rotor; the brief calls that out).

export interface HeliModel {
  root: Group;
  /** The main rotor: tilted with the disc; spins via `rotorAngle`. */
  rotor: Group;
  /** Rotor blades as meshes (spun on the CPU at low RPM). */
  bladeHub: Group;
  tailHub: Group;
  /** Uniforms the rotor discs read. */
  rotorAngle: { value: number };
  tailAngle: { value: number };
  /** Swept angle per frame (rad): the exposure smear. */
  rotorSmear: { value: number };
  tailSmear: { value: number };
  /** 0 = blades only, 1 = disc only. */
  discBlend: { value: number };
  bladeMaterials: MeshStandardNodeMaterial[];
  /** The canopy glass (nearly clear from inside: the cockpit views lower its opacity). */
  glass: MeshPhysicalNodeMaterial;
  /** The crew figures, hidden for the seat the camera is in. */
  pilotFigure: Group;
  gunnerFigure: Group;
  /** The cannon: azimuth (rotation.y) and elevation (rotation.x) groups, pivoting at the breech. */
  gunYaw: Group;
  gunPitch: Group;
  /** The missiles on the rails, in firing order (hidden as they go). */
  missileRounds: Group[];
  /** Launch points in body axes for the weapons simulation. */
  hardpoints: Hardpoints;
}

type F = Node<'float'>;

function mesh(g: BufferGeometry, m: Material, cast = true): Mesh {
  const out = new Mesh(g, m);
  out.castShadow = cast;
  out.receiveShadow = true;
  return out;
}

/**
 * A rotor disc in its local XZ plane (axis +y): each blade drawn as its exposure smear. `direction` +1 turns
 * counter-clockwise seen from +y.
 */
function discMaterial(blades: number, chordM: number, radiusM: number, angle: { value: number } & F, smear: { value: number } & F, blend: { value: number } & F, direction: 1 | -1, hex: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'rotor disc', transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.6 });
  const p = positionLocal;
  const r = length(p.xz);
  // Polar angle, counter-clockwise from +x seen from +y (−z is "up" in that view).
  const phi = atan(p.z.negate(), p.x).mul(direction);
  const arc = max(smear, float(chordM).div(max(r, 0.3)));
  // The blade's own width as an angle at this radius: the smear spreads that much coverage over `arc`
  // (doubled: the eye integrates longer than one frame and sees the blade darker than its duty cycle).
  const density = min(float(chordM).div(max(r, 0.3)).div(arc).mul(2.2), 1);
  // A faint whole disc underneath: the persistence of vision a camera frame does not have, but a viewer does.
  let alpha: F = float(blades * chordM)
    .div(max(r, 0.3).mul(Math.PI * 2))
    .mul(0.7)
    .min(0.12);
  for (let b = 0; b < blades; b++) {
    const theta = angle.add((b / blades) * Math.PI * 2);
    // How far behind the blade this pixel is (rad), 0…2π.
    const behind = fract(theta.sub(phi).div(Math.PI * 2)).mul(Math.PI * 2);
    alpha = max(alpha, density.mul(float(1).sub(smoothstep(arc.mul(0.55), arc, behind))));
  }
  // Root and tip: blades start a little out from the hub and taper at the tip; the tips carry a lighter paint band.
  alpha = alpha.mul(smoothstep(0.45, 0.8, r)).mul(float(1).sub(smoothstep(radiusM - 0.05, radiusM, r)));
  const tip = smoothstep(radiusM - 0.45, radiusM - 0.4, r);
  const c = new Color(hex);
  m.colorNode = mix(vec3(c.r, c.g, c.b), vec3(0.55, 0.55, 0.5), tip);
  m.opacityNode = alpha.mul(blend).mul(0.92);
  return m;
}

/** The pilot or gunner in the seat: helmet, suit, seat. */
function crew(): Group {
  const g = new Group();
  const seat = plain('seat', 0x2e3032, 0.8);
  const suit = plain('flight suit', 0x4f5642, 0.9);
  const helmet = plain('helmet', 0x4a4d45, 0.6);
  g.add(mesh(box(-0.28, -0.85, 0.15, 0.28, -0.12, 0.42), seat));
  g.add(mesh(box(-0.22, -0.62, -0.08, 0.22, -0.15, 0.2), suit));
  const head = mesh(new SphereGeometry(0.135, 18, 12), helmet);
  head.position.set(0, 0.06, 0.04);
  g.add(head);
  return g;
}

interface CanopySection {
  z: number;
  sillY: number;
  sillHalf: number;
  roofY: number;
  roofHalf: number;
}

interface Shape {
  stations: Station[];
  /** Cheek fairings along the lower fuselage sides: centre offset, stations. */
  cheeks: { x: number; stations: Station[] };
  paint: number;
  nose: number;
  canopy: CanopySection[];
  /** Index of the canopy section where the gunner's and the pilot's glazing meet (blast shield). */
  shieldAt: number;
  nacelleX: number;
  nacelleY: number;
  nacelleZ: [number, number];
  nacelleR: number;
  wing: { y: number; z: number; span: number; chord: number };
  finTopY: number;
  tailSide: 1 | -1;
  radarDome: boolean;
  /** Sensor turret: nose tip z, drum radius. */
  turretZ: number;
  turretR: number;
  gunZ: number;
}

const st = (z: number, top: number, bot: number, w: number, yc: number, tw = 0.5, bw = 0.6, su = 0.75, sl = 0.6): Station => ({ z, top, bot, w, yc, tw, bw, su, sl });

const SHAPES: Record<HeliId, Shape> = {
  warden: {
    stations: [
      st(-6.45, -0.08, -0.55, 0.16, -0.32, 0.3, 0.3, 0.3, 0.3),
      st(-6.05, 0.12, -0.82, 0.36, -0.38, 0.45, 0.5, 0.8, 0.6),
      st(-5.3, 0.14, -0.98, 0.46, -0.35),
      st(-3.4, 0.14, -1.04, 0.49, -0.22),
      st(-2.6, 0.42, -1.02, 0.5, -0.12),
      st(-1.0, 0.56, -0.98, 0.52, -0.02),
      st(0.25, 1.12, -0.95, 0.54, 0.05, 0.55, 0.6, 0.55, 0.55),
      st(1.6, 0.98, -0.72, 0.5, 0.1, 0.5, 0.5, 0.5, 0.5),
      st(2.8, 0.74, -0.22, 0.38, 0.25, 0.45, 0.4, 0.4, 0.4),
      st(4.0, 0.6, 0.05, 0.26, 0.32, 0.4, 0.4, 0.3, 0.3),
      st(8.2, 0.48, 0.18, 0.17, 0.33, 0.4, 0.4, 0.3, 0.3),
      st(9.35, 0.44, 0.22, 0.12, 0.33, 0.4, 0.4, 0.3, 0.3),
    ],
    cheeks: {
      x: 0.6,
      stations: [st(-4.6, -0.3, -0.62, 0.05, -0.46, 0.4, 0.4, 0.5, 0.5), st(-4.0, -0.12, -0.86, 0.3, -0.46), st(0.6, -0.1, -0.86, 0.34, -0.45), st(1.6, -0.25, -0.62, 0.12, -0.45, 0.4, 0.4, 0.5, 0.5)],
    },
    // A real attack-helicopter green (sRGB ~#434A35): darker than this swallowed every detail.
    paint: 0x434a35,
    nose: 0x3a4032,
    canopy: [
      { z: -5.42, sillY: 0.1, sillHalf: 0.45, roofY: 0.16, roofHalf: 0.3 },
      { z: -4.6, sillY: 0.1, sillHalf: 0.47, roofY: 0.74, roofHalf: 0.3 },
      { z: -3.15, sillY: 0.12, sillHalf: 0.48, roofY: 0.8, roofHalf: 0.3 },
      { z: -2.85, sillY: 0.36, sillHalf: 0.5, roofY: 0.84, roofHalf: 0.31 },
      { z: -2.15, sillY: 0.46, sillHalf: 0.5, roofY: 1.3, roofHalf: 0.32 },
      { z: -0.95, sillY: 0.56, sillHalf: 0.5, roofY: 1.3, roofHalf: 0.3 },
      { z: -0.45, sillY: 0.62, sillHalf: 0.44, roofY: 1.16, roofHalf: 0.24 },
    ],
    shieldAt: 3,
    nacelleX: 0.98,
    nacelleY: 0.66,
    nacelleZ: [-0.9, 2.5],
    nacelleR: 0.4,
    wing: { y: -0.08, z: -0.15, span: 2.1, chord: 1.15 },
    finTopY: 2.65,
    tailSide: -1,
    radarDome: true,
    turretZ: -6.55,
    turretR: 0.3,
    gunZ: -3.9,
  },
  bulat: {
    stations: [
      st(-7.9, -0.15, -0.7, 0.18, -0.42, 0.3, 0.3, 0.3, 0.3),
      st(-7.4, 0.12, -1.0, 0.46, -0.45, 0.45, 0.5, 0.8, 0.6),
      st(-6.3, 0.2, -1.2, 0.6, -0.4),
      st(-4.2, 0.22, -1.28, 0.66, -0.3),
      st(-3.3, 0.58, -1.28, 0.7, -0.2),
      st(-1.3, 0.72, -1.25, 0.74, -0.05),
      st(0.2, 1.28, -1.2, 0.76, 0.0, 0.6, 0.65, 0.6, 0.55),
      st(1.8, 1.12, -0.9, 0.7, 0.1, 0.5, 0.5, 0.5, 0.5),
      st(3.2, 0.9, -0.4, 0.5, 0.3, 0.45, 0.4, 0.4, 0.4),
      st(4.6, 0.72, 0.05, 0.34, 0.38, 0.4, 0.4, 0.3, 0.3),
      st(9.4, 0.62, 0.25, 0.2, 0.42, 0.4, 0.4, 0.3, 0.3),
      st(10.9, 0.58, 0.3, 0.14, 0.42, 0.4, 0.4, 0.3, 0.3),
    ],
    cheeks: {
      x: 0.78,
      stations: [st(-5.6, -0.35, -0.75, 0.06, -0.55, 0.4, 0.4, 0.5, 0.5), st(-5.0, -0.15, -1.05, 0.36, -0.55), st(0.8, -0.15, -1.05, 0.4, -0.55), st(1.9, -0.3, -0.75, 0.14, -0.55, 0.4, 0.4, 0.5, 0.5)],
    },
    paint: 0x464a37,
    nose: 0x34372e,
    canopy: [
      { z: -6.6, sillY: 0.16, sillHalf: 0.58, roofY: 0.24, roofHalf: 0.38 },
      { z: -5.7, sillY: 0.16, sillHalf: 0.62, roofY: 0.86, roofHalf: 0.4 },
      { z: -4.25, sillY: 0.2, sillHalf: 0.64, roofY: 0.92, roofHalf: 0.4 },
      { z: -3.9, sillY: 0.5, sillHalf: 0.68, roofY: 0.96, roofHalf: 0.4 },
      { z: -3.1, sillY: 0.62, sillHalf: 0.7, roofY: 1.48, roofHalf: 0.42 },
      { z: -1.5, sillY: 0.72, sillHalf: 0.7, roofY: 1.48, roofHalf: 0.4 },
      { z: -0.9, sillY: 0.8, sillHalf: 0.62, roofY: 1.3, roofHalf: 0.3 },
    ],
    shieldAt: 3,
    nacelleX: 1.2,
    nacelleY: 0.86,
    nacelleZ: [-0.8, 2.9],
    nacelleR: 0.48,
    wing: { y: 0.0, z: -0.35, span: 2.5, chord: 1.3 },
    finTopY: 3.05,
    tailSide: 1,
    radarDome: false,
    turretZ: -7.95,
    turretR: 0.34,
    gunZ: -5.2,
  },
};

/** Flat-shaded triangles from a list of quads (each four [x,y,z] corners). */
function quads(list: [number, number, number][][]): BufferGeometry {
  const pos: number[] = [];
  for (const q of list) {
    const [a, b, c, d] = q as [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/** The faceted canopy: flat panes lofted between trapezoid sections, and the frame along every edge. */
function canopy(sections: CanopySection[], glassMat: Material, frameMat: Material): Group {
  const g = new Group();
  const corners = sections.map((s) => [
    [-s.sillHalf, s.sillY, s.z],
    [-s.roofHalf, s.roofY, s.z],
    [s.roofHalf, s.roofY, s.z],
    [s.sillHalf, s.sillY, s.z],
  ]) as [number, number, number][][];
  const panes: [number, number, number][][] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[i + 1]!;
    for (let k = 0; k < 3; k++) panes.push([a[k]!, a[k + 1]!, b[k + 1]!, b[k]!]);
  }
  panes.push(corners[0]!.slice() as [number, number, number][]);
  const glass = new Mesh(quads(panes), glassMat);
  glass.renderOrder = 1;
  g.add(glass);
  // Frames: along the four edges, and a bow round every section.
  for (let k = 0; k < 4; k++)
    g.add(
      mesh(
        tube(
          corners.map((c) => c[k]!),
          0.022,
          6,
        ),
        frameMat,
      ),
    );
  corners.forEach((c, i) => {
    const r = i === 0 || i === corners.length - 1 ? 0.03 : 0.024;
    g.add(mesh(tube(c, r, 6), frameMat));
  });
  return g;
}

export function buildHeli(id: HeliId): HeliModel {
  const cfg = HELICOPTERS[id];
  const s = SHAPES[id];
  const root = new Group();
  // Satin rather than dead matte (0.8 read as felt): the shape shows in the sky's sheen. Soot from the
  // turned-out exhausts streaks the boom's upper sides behind them.
  const skin = paintMaterial({
    name: `${id} paint`,
    base: s.paint,
    roughness: 0.7,
    panels: { frameM: 0.5, splitM: 0.6, seamM: 0.003, access: 0.3, rivets: true, tape: false },
    sootPatch: { z0: s.nacelleZ[1] - 0.1, z1: s.nacelleZ[1] + 2.6, minY: 0.12 },
  });
  const darker = plain('fittings', 0x232622, 0.7);
  const metal = plain('hub metal', 0x3a3b3c, 0.45, 0.6);
  const flat = plain(`${id} flat`, s.paint, 0.82);
  const black = plain('black', 0x111212, 0.6);

  // ---- body: fuselage and boom, and the cheek fairings along the lower sides
  root.add(mesh(fuselage(s.stations, { stepM: 0.1, perQuarter: 16 }), skin));
  for (const side of [-1, 1]) root.add(mesh(fuselage(s.cheeks.stations, { stepM: 0.12, perQuarter: 8, offsetX: side * s.cheeks.x }), skin));

  // ---- canopy, blast shield, crew
  const glass = canopyMaterial(0x2c363c, null);
  glass.side = DoubleSide;
  addCanopyRain(glass);
  root.add(canopy(s.canopy, glass, flat));
  const sh = s.canopy[s.shieldAt]!;
  const shieldMat = canopyMaterial(0x3a444a, null);
  shieldMat.opacity = 0.18;
  const shield = mesh(new BoxGeometry(sh.sillHalf * 1.9, 0.62, 0.02), shieldMat, false);
  shield.position.set(0, sh.sillY + 0.08, sh.z + 0.02);
  root.add(shield);
  const gunnerFigure = crew();
  gunnerFigure.position.set(...cfg.gunnerEye);
  const pilotFigure = crew();
  pilotFigure.position.set(...cfg.pilotEye);
  root.add(gunnerFigure, pilotFigure);

  // ---- nose: sensor turret (drum, side housings with their coated windows) and the night-flying turret above
  const nose = plain('turret', s.nose, 0.5);
  const optics = opticsMaterial();
  root.add(sensorTurret(s.turretZ, -0.7, s.turretR, s.stations[1]!.z, nose, darker, optics));

  // ---- chin cannon on its turret: the ring is fixed; azimuth turns `gunYaw`, elevation `gunPitch` (pivot at the breech)
  const ring = mesh(new CylinderGeometry(0.24, 0.27, 0.2, 18), darker);
  ring.position.set(0, -1.12, s.gunZ);
  root.add(ring);
  const gunYaw = new Group();
  gunYaw.position.set(0, -1.28, s.gunZ);
  root.add(gunYaw);
  const gunPitch = new Group();
  gunYaw.add(gunPitch);
  gunPitch.add(mesh(box(-0.1, -0.12, -0.55, 0.1, 0.1, 0.2), darker));
  const barrel = mesh(new CylinderGeometry(0.035, 0.045, 1.6, 10), black);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, -0.02, -1.25);
  gunPitch.add(barrel);
  const jacket = mesh(new CylinderGeometry(0.06, 0.06, 0.5, 10), darker);
  jacket.rotation.x = Math.PI / 2;
  jacket.position.set(0, -0.01, -0.7);
  gunPitch.add(jacket);
  const hardpoints: Hardpoints = { gun: [0, -1.28, s.gunZ], pods: [], rails: [] };
  const podMat = plain('rocket pod', 0x3d4234, 0.72);
  const missileMat = plain('missile', 0x3f4639, 0.6);
  const seekerMat = opticsMaterial();
  const bands = bandMaterials();
  const missileRounds: Group[] = [];

  // ---- engines: pods with intakes in front and exhaust suppressors turned out
  for (const side of [-1, 1]) {
    const [z0, z1] = s.nacelleZ;
    const R = s.nacelleR;
    const pod = lathe(
      [
        [z0, R * 0.78],
        [z0 + 0.15, R * 0.95],
        [z0 + 0.6, R],
        [z1 - 0.9, R],
        [z1 - 0.3, R * 0.85],
        [z1, R * 0.7],
      ],
      side * s.nacelleX,
      s.nacelleY,
      28,
      true,
      // A rounded-square section (superellipse, n = 3), not a tube: the cowlings are flat-sided.
      (t) => 1 / Math.cbrt(Math.abs(Math.cos(t)) ** 3 + Math.abs(Math.sin(t)) ** 3),
    );
    root.add(mesh(pod, skin));
    const intake = mesh(new CylinderGeometry(R * 0.66, R * 0.66, 0.05, 20), black, false);
    intake.rotation.x = Math.PI / 2;
    intake.position.set(side * s.nacelleX, s.nacelleY, z0 - 0.01);
    root.add(intake);
    const spinner = mesh(new SphereGeometry(R * 0.22, 12, 8), metal);
    spinner.position.set(side * s.nacelleX, s.nacelleY, z0 + 0.02);
    root.add(spinner);
    // The suppressor: a flattened duct turning out and a little down from the pod's tail.
    root.add(suppressor(side as 1 | -1, side * s.nacelleX, s.nacelleY, z1, skin, black));
    // Pylon fairing joining the pod to the body.
    root.add(mesh(box(side * 0.35 - 0.12 * side, s.nacelleY - 0.3, z0 + 0.4, side * (s.nacelleX - R * 0.5), s.nacelleY + 0.1, z1 - 0.6).translate(0, 0, 0), flat));

    // ---- stub wing, pylons, stores
    const w = s.wing;
    const sf = {
      rootX: 0.5,
      rootY: w.y,
      rootLeZ: w.z - w.chord / 2,
      rootChordM: w.chord,
      spanM: w.span,
      tipLeZ: w.z - w.chord / 2 + 0.12,
      tipChordM: w.chord * 0.82,
      rootThickness: 0.16,
      tipThickness: 0.13,
      dihedralRad: -0.06,
      side: side as 1 | -1,
    };
    root.add(mesh(surface(sf), skin));
    const ty = w.y - 0.06 - w.span * 0.5 * 0.06;
    const inboard = side * (0.5 + w.span * 0.38);
    const outboard = side * (0.5 + w.span * 0.82);
    for (const px of [inboard, outboard]) root.add(mesh(box(px - 0.05, ty - 0.32, w.z - 0.32, px + 0.05, w.y, w.z + 0.3), darker));
    // Inboard: a rocket pod, its end faces a honeycomb of tubes.
    root.add(rocketPod(inboard, ty - 0.55, w.z - 0.05, podMat, darker));
    hardpoints.pods.push([inboard, ty - 0.55, w.z - 1.0]);
    // Outboard: a launcher (body and two rail arms) with four anti-armour missiles.
    root.add(mesh(box(outboard - 0.06, ty - 0.48, w.z - 0.75, outboard + 0.06, ty - 0.3, w.z + 0.7), darker));
    for (const dy of [-0.42, -0.68]) root.add(mesh(box(outboard - 0.2, ty + dy + 0.085, w.z - 0.6, outboard + 0.2, ty + dy + 0.11, w.z + 0.55), darker));
    for (const [dx, dy] of [
      [-0.12, -0.42],
      [0.12, -0.42],
      [-0.12, -0.68],
      [0.12, -0.68],
    ] as const) {
      const round = missile(missileMat, seekerMat, darker, bands);
      round.position.set(outboard + dx, ty + dy, w.z - 0.05 - 0.08);
      root.add(round);
      missileRounds.push(round);
      hardpoints.rails.push([outboard + dx, ty + dy, w.z - 0.9]);
    }
    // Position light on the wing tip: red to port, green to starboard.
    root.add(navLight(side * (0.5 + w.span) + side * 0.02, w.y - w.span * 0.06 - 0.02, w.z, side < 0 ? 0xff2a1a : 0x2aff5a, darker));
  }

  // ---- small parts: antennas, wire cutters, IR jammer, flare dispensers, boarding steps
  const topAt = (z: number): { top: number; bot: number; w: number } => {
    const st0 = s.stations.find((q, i) => i + 1 < s.stations.length && q.z <= z && s.stations[i + 1]!.z >= z) ?? s.stations[0]!;
    const st1 = s.stations[s.stations.indexOf(st0) + 1] ?? st0;
    const f = st1.z === st0.z ? 0 : (z - st0.z) / (st1.z - st0.z);
    return { top: st0.top + (st1.top - st0.top) * f, bot: st0.bot + (st1.bot - st0.bot) * f, w: st0.w + (st1.w - st0.w) * f };
  };
  root.add(bladeAntenna(0, topAt(3.3).top - 0.02, 3.3, 0.2, 0.22, darker));
  root.add(bladeAntenna(0, topAt(-1.6).bot + 0.02, -1.6, 0.16, 0.2, darker, true));
  root.add(bladeAntenna(0, topAt(5.6).bot + 0.02, 5.6, 0.14, 0.18, darker, true));
  const roof = s.canopy[2]!;
  root.add(wireCutter(0, roof.roofY - 0.02, roof.z - 0.35, 0.2, darker));
  root.add(wireCutter(0, s.canopy[4]!.roofY - 0.02, s.canopy[4]!.z + 0.15, 0.14, darker));
  root.add(wireCutter(0, topAt(s.turretZ + 1.5).bot + 0.05, s.turretZ + 1.5, 0.26, darker, true));
  root.add(irJammer(0, topAt(1.15).top - 0.04, 1.15, darker, optics));
  for (const side of [-1, 1] as const) {
    const zb = 4.6;
    root.add(dispenser(side * (topAt(zb).w * 0.92 + 0.03), (topAt(zb).top + topAt(zb).bot) / 2 + 0.05, zb, side, darker, black));
    for (const zs of [-2.6, -1.6]) root.add(step(side * (s.cheeks.x + 0.33), -0.3, zs, side, metal));
  }

  // ---- tail: swept fin, low stabilator, tail wheel
  const tailZ = s.stations[s.stations.length - 1]!.z;
  root.add(
    mesh(
      surface({
        rootX: 0,
        rootY: 0.4,
        rootLeZ: tailZ - 1.75,
        rootChordM: 1.55,
        spanM: s.finTopY - 0.4,
        tipLeZ: tailZ - 0.55,
        tipChordM: 0.85,
        rootThickness: 0.12,
        tipThickness: 0.1,
        dihedralRad: Math.PI / 2,
      }),
      skin,
    ),
  );
  for (const side of [-1, 1] as const) {
    root.add(mesh(surface({ rootX: 0.1, rootY: 0.24, rootLeZ: tailZ - 1.3, rootChordM: 0.85, spanM: 1.65, tipLeZ: tailZ - 1.1, tipChordM: 0.65, rootThickness: 0.11, tipThickness: 0.1, dihedralRad: 0, side }), skin));
  }
  // Anti-collision light on the fin tip.
  const beacon = new Mesh(new SphereGeometry(0.06, 10, 8), new MeshBasicNodeMaterial({ color: 0xff2a1a }));
  beacon.position.set(0, s.finTopY + 0.03, tailZ - 0.2);
  root.add(beacon);

  // ---- landing gear: trailing struts to the main wheels, a fork for the tail wheel
  const tyre = plain('tyre', 0x1b1b1b, 0.9);
  for (const [wx, wy, wz] of cfg.wheels) {
    const tail = wz > 0;
    const r = tail ? 0.2 : 0.33;
    const wheel = mesh(new CylinderGeometry(r, r, tail ? 0.14 : 0.2, 20), tyre);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, wy + r, wz);
    root.add(wheel);
    const hub = mesh(new CylinderGeometry(r * 0.5, r * 0.5, tail ? 0.16 : 0.22, 12), metal);
    hub.rotation.z = Math.PI / 2;
    hub.position.copy(wheel.position);
    root.add(hub);
    if (tail) {
      root.add(
        mesh(
          tube(
            [
              [wx, wy + r, wz],
              [wx, 0.25, wz - 0.35],
            ],
            0.045,
            8,
          ),
          darker,
        ),
      );
    } else {
      // Strut from the cheek fairing down and back to the axle, and a drag brace forward.
      const top: [number, number, number] = [Math.sign(wx) * (s.cheeks.x + 0.2), -0.55, wz - 0.4];
      root.add(mesh(tube([top, [wx, wy + r, wz]], 0.065, 10), darker));
      root.add(
        mesh(
          tube(
            [
              [Math.sign(wx) * (s.cheeks.x + 0.15), -0.7, wz - 1.2],
              [wx, wy + r + 0.1, wz - 0.05],
            ],
            0.04,
            8,
          ),
          darker,
        ),
      );
    }
  }

  // ---- main rotor: mast, hub, blades and the smear disc
  const rc = cfg.rotor;
  const rotor = new Group();
  rotor.position.set(0, rc.hubHeightM, 0);
  root.add(rotor);
  // The mast from the top of the fuselage; it does not tilt with the disc (the hub does).
  const mastLen = rc.hubHeightM - 1.05;
  const mast = mesh(new CylinderGeometry(0.15, 0.2, mastLen, 14), metal);
  mast.position.set(0, 1.05 + mastLen / 2, 0);
  root.add(mast);
  const rotorAngle = uniform(0);
  const tailAngle = uniform(0);
  const rotorSmear = uniform(0.3);
  const tailSmear = uniform(0.6);
  const discBlend = uniform(0);
  const bladeHub = new Group();
  rotor.add(bladeHub);
  // Hub: the swashplate below, the hub plates, a grip and a pitch link per blade.
  const swash = mesh(new CylinderGeometry(0.36, 0.36, 0.06, 20), metal);
  swash.position.y = -0.32;
  rotor.add(swash);
  bladeHub.add(mesh(new CylinderGeometry(0.34, 0.38, 0.22, 18), metal));
  if (s.radarDome) {
    // The radar above the rotor: a squat dome on a short post.
    const post = mesh(new CylinderGeometry(0.1, 0.12, 0.5, 10), metal);
    post.position.y = 0.36;
    rotor.add(post);
    const dome = mesh(new SphereGeometry(0.62, 24, 12), plain('radome', 0x3b4232, 0.7));
    dome.scale.set(1, 0.38, 1);
    dome.position.y = 0.72;
    rotor.add(dome);
  }
  const bladeMat = plain('blades', 0x2a2b2a, 0.6);
  bladeMat.transparent = true;
  const bladeMaterials = [bladeMat];
  const c = rc.chordM;
  for (let b = 0; b < rc.blades; b++) {
    const arm = new Group();
    arm.rotation.y = (b / rc.blades) * Math.PI * 2;
    bladeHub.add(arm);
    // Grip and pitch link.
    arm.add(mesh(box(0.25, -0.07, -0.09, 0.62, 0.07, 0.09), metal));
    arm.add(
      mesh(
        tube(
          [
            [0.3, -0.3, -0.12],
            [0.34, -0.05, -0.12],
          ],
          0.018,
          6,
        ),
        metal,
      ),
    );
    // The blade: an airfoil (leading edge ahead of the turning direction), a swept, tapered tip.
    const span = rc.radiusM - 0.62 - 0.45;
    const main = surface({ rootX: 0.62, rootY: 0, rootLeZ: -c * 0.25, rootChordM: c, spanM: span, tipLeZ: -c * 0.25, tipChordM: c, rootThickness: 0.11, tipThickness: 0.09, dihedralRad: 0 }, {}, 14, 6);
    const tip = surface({ rootX: 0.62 + span, rootY: 0, rootLeZ: -c * 0.25, rootChordM: c, spanM: 0.45, tipLeZ: -c * 0.25 + 0.28, tipChordM: c * 0.5, rootThickness: 0.09, tipThickness: 0.08, dihedralRad: 0 }, {}, 14, 3);
    for (const g of [main, tip]) {
      // A clockwise rotor leads with the other edge.
      if (rc.direction < 0) g.scale(1, 1, -1);
      arm.add(mesh(g, bladeMat));
    }
  }
  const disc = new RingGeometry(0.4, rc.radiusM, 128, 6);
  disc.rotateX(-Math.PI / 2);
  const discMesh = mesh(disc, discMaterial(rc.blades, rc.chordM, rc.radiusM, rotorAngle, rotorSmear, discBlend, rc.direction, 0x2a2b2a), false);
  discMesh.renderOrder = 2;
  rotor.add(discMesh);

  // ---- tail rotor on the side of the fin, axis along x
  const t = cfg.tail;
  const tailHub = new Group();
  const tailRotor = new Group();
  tailRotor.position.set(s.tailSide * 0.3, s.finTopY - 0.75, t.armM);
  tailRotor.rotation.z = (s.tailSide * Math.PI) / 2;
  root.add(tailRotor);
  tailRotor.add(tailHub);
  tailHub.add(mesh(new CylinderGeometry(0.12, 0.12, 0.22, 12), metal));
  // The western type's tail rotor is a "scissor": two blade pairs 55° apart, not 90°.
  const tailAngles = s.radarDome ? [0, 55, 180, 235] : [0, 90, 180, 270];
  for (const deg of tailAngles) {
    const g = surface({ rootX: 0.15, rootY: 0, rootLeZ: -0.06, rootChordM: 0.25, spanM: t.radiusM - 0.15, tipLeZ: -0.06, tipChordM: 0.22, rootThickness: 0.1, tipThickness: 0.08, dihedralRad: 0 }, {}, 10, 3);
    const blade = mesh(g, bladeMat);
    blade.rotation.y = (deg * Math.PI) / 180;
    tailHub.add(blade);
  }
  const tdisc = new RingGeometry(0.12, t.radiusM, 64, 3);
  tdisc.rotateX(-Math.PI / 2);
  const tdiscMesh = mesh(tdisc, discMaterial(4, 0.25, t.radiusM, tailAngle, tailSmear, discBlend, 1, 0x2a2b2a), false);
  tdiscMesh.renderOrder = 2;
  tailRotor.add(tdiscMesh);

  const t0 = performance.now();
  bakeAmbientOcclusion(root);
  console.log(`${id}: ambient occlusion baked in ${(performance.now() - t0).toFixed(0)} ms`);
  // Fire in a left-right order, so the aircraft stays balanced as the rails empty.
  const interleave = <T>(list: T[]): T[] => {
    const half = list.length / 2;
    const out: T[] = [];
    for (let i = 0; i < half; i++) out.push(list[i] as T, list[i + half] as T);
    return out;
  };
  return {
    root,
    rotor,
    bladeHub,
    tailHub,
    rotorAngle,
    tailAngle,
    rotorSmear,
    tailSmear,
    discBlend,
    bladeMaterials,
    glass,
    pilotFigure,
    gunnerFigure,
    gunYaw,
    gunPitch,
    missileRounds: interleave(missileRounds),
    hardpoints: { gun: hardpoints.gun, pods: hardpoints.pods, rails: interleave(hardpoints.rails) },
  };
}
