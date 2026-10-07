import { atan, float, fract, length, max, min, mix, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import { BoxGeometry, type BufferGeometry, Color, CylinderGeometry, DoubleSide, Group, type Material, Mesh, MeshStandardNodeMaterial, type Node, RingGeometry, SphereGeometry } from 'three/webgpu';
import { HELICOPTERS, type HeliId } from '../config.ts';
import { box, fuselage, lathe, type Station, surface } from './airframe.ts';
import { bakeAmbientOcclusion } from './aoBake.ts';
import { canopyMaterial, paintMaterial, plain } from './jetMaterials.ts';

// The two helicopters, procedural (no model files), in body axes (x right,
// y up, −z forward, origin at the centre of gravity) so they line up with the
// flight model: hub, wheels, tail rotor and eyes are the config's numbers.
//
//   Warden   tandem cockpits stepped up to the rear under a flat-plate canopy,
//            a sensor turret on the nose, engines in pods either side of the
//            mast, stub wings with two pylons each, a long boom to a swept fin
//            and a low stabilator, the tail rotor on the left of the fin;
//   Bulat    the same layout, bulkier: a longer nose, armoured slab sides, five
//            blades, the tail rotor on the right.
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
  let alpha: F = float(blades * chordM).div(max(r, 0.3).mul(Math.PI * 2)).mul(0.7).min(0.12);
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

interface Shape {
  stations: Station[];
  paint: number;
  nose: number;
  /** Canopy: z ranges of the gunner's and the pilot's glazing, sill height and roof heights. */
  canopy: { z0: number; z1: number; sill: number; roofFront: number; roofRear: number; halfW: number };
  nacelleX: number;
  nacelleY: number;
  nacelleZ: [number, number];
  nacelleR: number;
  wing: { y: number; z: number; span: number; chord: number };
  finTopY: number;
  tailSide: 1 | -1;
}

const SHAPES: Record<HeliId, Shape> = {
  warden: {
    stations: [
      { z: -6.75, top: -0.18, bot: -0.42, w: 0.12, yc: -0.3, tw: 0.3, bw: 0.3, su: 0.2, sl: 0.2 },
      { z: -6.3, top: 0.05, bot: -0.72, w: 0.38, yc: -0.3, tw: 0.4, bw: 0.5, su: 0.4, sl: 0.4 },
      { z: -4.9, top: 0.32, bot: -0.92, w: 0.5, yc: -0.25, tw: 0.5, bw: 0.6, su: 0.6, sl: 0.5 },
      { z: -3.0, top: 0.62, bot: -1.0, w: 0.56, yc: -0.15, tw: 0.5, bw: 0.65, su: 0.6, sl: 0.5 },
      { z: -1.1, top: 0.95, bot: -1.0, w: 0.62, yc: 0.0, tw: 0.55, bw: 0.65, su: 0.55, sl: 0.5 },
      { z: 1.0, top: 1.05, bot: -0.92, w: 0.6, yc: 0.0, tw: 0.55, bw: 0.6, su: 0.5, sl: 0.5 },
      { z: 2.6, top: 0.8, bot: -0.5, w: 0.48, yc: 0.1, tw: 0.5, bw: 0.4, su: 0.4, sl: 0.4 },
      { z: 4.0, top: 0.62, bot: 0.05, w: 0.28, yc: 0.3, tw: 0.4, bw: 0.4, su: 0.3, sl: 0.3 },
      { z: 8.0, top: 0.5, bot: 0.18, w: 0.17, yc: 0.33, tw: 0.4, bw: 0.4, su: 0.3, sl: 0.3 },
      { z: 9.3, top: 0.46, bot: 0.22, w: 0.12, yc: 0.33, tw: 0.4, bw: 0.4, su: 0.3, sl: 0.3 },
    ],
    paint: 0x3d4434,
    nose: 0x2c302a,
    canopy: { z0: -5.4, z1: -1.2, sill: 0.08, roofFront: 0.55, roofRear: 1.0, halfW: 0.46 },
    nacelleX: 0.95,
    nacelleY: 0.62,
    nacelleZ: [-0.7, 2.7],
    nacelleR: 0.4,
    wing: { y: -0.05, z: -0.2, span: 2.0, chord: 1.15 },
    finTopY: 2.6,
    tailSide: -1,
  },
  bulat: {
    stations: [
      { z: -8.0, top: -0.25, bot: -0.55, w: 0.14, yc: -0.4, tw: 0.3, bw: 0.3, su: 0.2, sl: 0.2 },
      { z: -7.4, top: 0.1, bot: -0.95, w: 0.46, yc: -0.4, tw: 0.4, bw: 0.5, su: 0.5, sl: 0.4 },
      { z: -5.6, top: 0.4, bot: -1.15, w: 0.62, yc: -0.3, tw: 0.55, bw: 0.65, su: 0.75, sl: 0.6 },
      { z: -3.4, top: 0.78, bot: -1.25, w: 0.7, yc: -0.2, tw: 0.6, bw: 0.7, su: 0.75, sl: 0.6 },
      { z: -1.2, top: 1.15, bot: -1.25, w: 0.78, yc: 0.0, tw: 0.6, bw: 0.7, su: 0.7, sl: 0.6 },
      { z: 1.2, top: 1.25, bot: -1.15, w: 0.76, yc: 0.0, tw: 0.6, bw: 0.65, su: 0.6, sl: 0.55 },
      { z: 3.0, top: 0.95, bot: -0.6, w: 0.6, yc: 0.15, tw: 0.5, bw: 0.45, su: 0.45, sl: 0.4 },
      { z: 4.6, top: 0.72, bot: 0.05, w: 0.34, yc: 0.35, tw: 0.4, bw: 0.4, su: 0.3, sl: 0.3 },
      { z: 9.4, top: 0.62, bot: 0.25, w: 0.2, yc: 0.42, tw: 0.4, bw: 0.4, su: 0.3, sl: 0.3 },
      { z: 10.9, top: 0.58, bot: 0.3, w: 0.14, yc: 0.42, tw: 0.4, bw: 0.4, su: 0.3, sl: 0.3 },
    ],
    paint: 0x4a4e3c,
    nose: 0x3a3d34,
    canopy: { z0: -6.5, z1: -1.4, sill: 0.15, roofFront: 0.62, roofRear: 1.2, halfW: 0.58 },
    nacelleX: 1.15,
    nacelleY: 0.85,
    nacelleZ: [-0.6, 3.0],
    nacelleR: 0.48,
    wing: { y: 0.0, z: -0.3, span: 2.4, chord: 1.3 },
    finTopY: 3.0,
    tailSide: 1,
  },
};

export function buildHeli(id: HeliId): HeliModel {
  const cfg = HELICOPTERS[id];
  const s = SHAPES[id];
  const root = new Group();
  const skin = paintMaterial({ name: `${id} paint`, base: s.paint, roughness: 0.74, panels: { frameM: 0.55, splitM: 0.7, seamM: 0.003, access: 0.25, rivets: true, tape: false } });
  const darker = plain('fittings', 0x262826, 0.7);
  const metal = plain('hub metal', 0x3a3b3c, 0.45, 0.6);
  const flat = plain(`${id} flat`, s.paint, 0.78);

  // Fuselage and boom.
  root.add(mesh(fuselage(s.stations, { stepM: 0.12, perQuarter: 14 }), skin));
  // Canopy: a faceted glasshouse, low at the front seat, stepped up over the rear seat.
  const c = s.canopy;
  const glass = canopyMaterial(0x30343a, null);
  const mid = (c.z0 + c.z1) / 2;
  const front = mesh(box(-c.halfW * 0.82, c.sill, c.z0, c.halfW * 0.82, c.roofFront, mid), glass, false);
  const rear = mesh(box(-c.halfW, c.sill + 0.1, mid - 0.15, c.halfW, c.roofRear, c.z1), glass, false);
  root.add(front, rear);
  // Canopy frames: the bows between the panes.
  for (const z of [c.z0, mid - 0.15, mid, c.z1]) root.add(mesh(box(-c.halfW - 0.02, c.sill, z - 0.03, c.halfW + 0.02, z < mid ? c.roofFront + 0.02 : c.roofRear + 0.02, z + 0.03), darker));
  // Crew under the glass.
  const gunner = crew();
  gunner.position.set(...cfg.gunnerEye);
  const pilot = crew();
  pilot.position.set(...cfg.pilotEye);
  root.add(gunner, pilot);
  // Nose sensor turret: a drum on a yoke below the nose tip.
  const turret = mesh(new CylinderGeometry(0.3, 0.3, 0.42, 20), plain('turret', s.nose, 0.55));
  turret.rotation.z = Math.PI / 2;
  turret.position.set(0, -0.3, s.stations[0]!.z - 0.05);
  root.add(turret);
  // Chin gun: a short barrel under the cockpit.
  const gun = mesh(new CylinderGeometry(0.05, 0.06, 1.6, 10), darker);
  gun.rotation.x = Math.PI / 2;
  gun.position.set(0, -1.05, s.stations[2]!.z - 0.3);
  root.add(gun);

  // Engine pods either side of the mast, with exhaust suppressors at the back.
  for (const side of [-1, 1]) {
    const [z0, z1] = s.nacelleZ;
    const R = s.nacelleR;
    const pod = lathe(
      [
        [z0, R * 0.55],
        [z0 + 0.25, R * 0.92],
        [z0 + 0.8, R],
        [z1 - 0.8, R],
        [z1 - 0.2, R * 0.8],
        [z1, R * 0.62],
      ],
      side * s.nacelleX,
      s.nacelleY,
      20,
      true,
    );
    root.add(mesh(pod, flat));
    const exhaust = mesh(new CylinderGeometry(R * 0.5, R * 0.62, 0.5, 14, 1, true), plain('exhaust', 0x1d1d1c, 0.8));
    exhaust.rotation.x = Math.PI / 2 - 0.5;
    exhaust.rotation.z = side * 0.6;
    exhaust.position.set(side * (s.nacelleX + 0.12), s.nacelleY + 0.05, z1 + 0.15);
    root.add(exhaust);
    // Stub wing with two pylons.
    const w = s.wing;
    const sf = { rootX: 0.5, rootY: w.y, rootLeZ: w.z - w.chord / 2, rootChordM: w.chord, spanM: w.span, tipLeZ: w.z - w.chord / 2 + 0.1, tipChordM: w.chord * 0.85, rootThickness: 0.14, tipThickness: 0.12, dihedralRad: -0.08, side: side as 1 | -1 };
    root.add(mesh(surface(sf), skin));
    for (const f of [0.42, 0.85]) {
      const px = side * (0.5 + w.span * f);
      root.add(mesh(box(px - 0.06, w.y - 0.35, w.z - 0.3, px + 0.06, w.y - 0.05, w.z + 0.3), darker));
    }
  }

  // Fin (swept) and stabilator.
  const tailZ = s.stations[s.stations.length - 1]!.z;
  root.add(mesh(surface({ rootX: 0, rootY: 0.45, rootLeZ: tailZ - 1.7, rootChordM: 1.5, spanM: s.finTopY - 0.45, tipLeZ: tailZ - 0.6, tipChordM: 0.85, rootThickness: 0.12, tipThickness: 0.1, dihedralRad: Math.PI / 2 }), skin));
  for (const side of [-1, 1] as const) {
    root.add(mesh(surface({ rootX: 0.1, rootY: 0.25, rootLeZ: tailZ - 1.4, rootChordM: 0.9, spanM: 1.6, tipLeZ: tailZ - 1.2, tipChordM: 0.7, rootThickness: 0.11, tipThickness: 0.1, dihedralRad: 0, side }), skin));
  }

  // Landing gear: legs and wheels at the config's contact points.
  const tyre = plain('tyre', 0x1b1b1b, 0.9);
  for (const [wx, wy, wz] of cfg.wheels) {
    const r = wz > 0 ? 0.2 : 0.32;
    const wheel = mesh(new CylinderGeometry(r, r, 0.18, 18), tyre);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, wy + r, wz);
    root.add(wheel);
    const legTop = wz > 0 ? 0.3 : -0.5;
    root.add(mesh(box(wx - 0.05, wy + r, wz - 0.05, wx + 0.05, legTop, wz + 0.05), darker));
  }

  // ---- main rotor: mast, hub, blades and the smear disc
  const rc = cfg.rotor;
  const rotor = new Group();
  rotor.position.set(0, rc.hubHeightM, 0);
  root.add(rotor);
  const mast = mesh(new CylinderGeometry(0.16, 0.2, rc.hubHeightM - 0.9, 12), metal);
  mast.position.set(0, (0.9 - rc.hubHeightM) / 2 + 0.0, 0);
  rotor.add(mast);
  const rotorAngle = uniform(0);
  const tailAngle = uniform(0);
  const rotorSmear = uniform(0.3);
  const tailSmear = uniform(0.6);
  const discBlend = uniform(0);
  const bladeHub = new Group();
  rotor.add(bladeHub);
  bladeHub.add(mesh(new CylinderGeometry(0.42, 0.42, 0.3, 16), metal));
  const bladeMat = plain('blades', 0x2a2b2a, 0.6);
  bladeMat.transparent = true;
  const bladeMaterials = [bladeMat];
  for (let b = 0; b < rc.blades; b++) {
    const g = new BoxGeometry(rc.radiusM - 0.5, 0.06, rc.chordM);
    g.translate((rc.radiusM - 0.5) / 2 + 0.5, 0, 0);
    const blade = mesh(g, bladeMat);
    blade.rotation.y = (b / rc.blades) * Math.PI * 2;
    bladeHub.add(blade);
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
  tailRotor.position.set(s.tailSide * 0.32, t.heightM + 0.15, t.armM);
  tailRotor.rotation.z = (s.tailSide * Math.PI) / 2;
  root.add(tailRotor);
  tailRotor.add(tailHub);
  tailHub.add(mesh(new CylinderGeometry(0.12, 0.12, 0.2, 10), metal));
  for (let b = 0; b < 4; b++) {
    const g = new BoxGeometry(t.radiusM - 0.15, 0.03, 0.25);
    g.translate((t.radiusM - 0.15) / 2 + 0.15, 0, 0);
    const blade = mesh(g, bladeMat);
    blade.rotation.y = (b / 4) * Math.PI * 2;
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
  return { root, rotor, bladeHub, tailHub, rotorAngle, tailAngle, rotorSmear, tailSmear, discBlend, bladeMaterials };
}
