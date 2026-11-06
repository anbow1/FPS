import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { float, fract, mix, positionLocal, sin, smoothstep, dot, uniform, vec3 } from 'three/tsl';
import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Path,
  Shape,
  SphereGeometry,
  SpotLight,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { JEEP } from '../config.ts';
import type { Jeep } from '../game/jeep.ts';
import { jeepLoaded, JEEP_LAMP, jeepParts } from './jeepModel.ts';
import { HeadlightBeams } from './lightBeams.ts';
import { tube } from './meshkit.ts';
import { bakeAmbientOcclusion } from './aoBake.ts';
import { markDry } from './outpost.ts';
import { vehicleMaterial } from './propMaterials.ts';
import { paintWear } from './wear.ts';

// The old jeep as drawn, in the logic's frame (game/jeep.ts): forward −Z,
// right +X, y = 0 the body's reference point (the floor over the axles). A
// flat-sided tub with its rolled top edge and rear wheel-arch cut-outs, flat
// front wings with a curled nose, a stamped slot grille with the lamps set in
// it, a bonnet hinged at the windscreen, half doors hinged at their front
// edge, a split fold-down screen, a roll bar, seats, a spare wheel and a jerry
// can on the tail, a shovel clamped to the side; underneath, the ladder frame,
// beam axles on leaf springs and the exhaust. Wheels are off-road tyres with
// staggered lugs on dished steel rims. Panels are rounded boxes and bevelled
// extrusions: hard edges catch no light, and a real pressed panel has none.
// Invented, unmarked.
//
// The headlights are two glowing lenses and one spot light between them: every
// lit material in the scene pays for every light, even at zero intensity, so
// one light stands in for the pair. It exists from the start (a fixed light
// count, so switching it on compiles nothing) and casts no shadows.

const OLIVE = 0x4f5a3a;
const WHEEL_Y = JEEP.wheelRadiusM - JEEP.rideHeightM;
const FRONT_Z = -JEEP.wheelbaseM / 2;
const REAR_Z = JEEP.wheelbaseM / 2;

/** Rounded box centred at (x, y, z), optionally turned about X then Y. */
function rbox(w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0): BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.999);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  return g.translate(x, y, z);
}

function cyl(r0: number, r1: number, len: number, seg: number, axis: 'x' | 'y' | 'z', x: number, y: number, z: number, open = false): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, len, seg, 1, open);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return g.translate(x, y, z);
}

function join(parts: BufferGeometry[]): BufferGeometry {
  const clean = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
    if (!n.getAttribute('uv')) throw new Error('jeep part without uv');
    return n;
  });
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error('jeep geometry merge failed');
  return out;
}

/** A side profile in (z, y) extruded across X from x0 by `thick`, with a small bevel on its edges. */
function sidePanel(shape: Shape, x0: number, thick: number): BufferGeometry {
  const g = new ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 18 });
  // Shape space (u, v, w) → jeep (x = w, y = v, z = u).
  g.applyMatrix4(new Matrix4().set(0, 0, 1, x0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g;
}

/** The tub's rear side: floor to rolled top edge, door opening in front, the rear wheel arch cut out. */
function rearSideShape(): Shape {
  const r = 0.46;
  const top = 0.52;
  const bottom = -0.05;
  const dz = Math.sqrt(r * r - (bottom - WHEEL_Y) ** 2);
  const s = new Shape();
  s.moveTo(0.24, bottom);
  s.lineTo(REAR_Z - dz, bottom);
  const a0 = Math.atan2(bottom - WHEEL_Y, -dz);
  const a1 = Math.atan2(bottom - WHEEL_Y, dz);
  s.absarc(REAR_Z, WHEEL_Y, r, a0, a1, true);
  s.lineTo(1.55, bottom);
  s.lineTo(1.55, top);
  s.lineTo(0.24, top);
  s.lineTo(0.24, bottom);
  return s;
}

/** The cowl side between the front wing and the door: its front edge follows the wheel arch. */
function cowlSideShape(): Shape {
  const s = new Shape();
  s.moveTo(-0.38, -0.05);
  s.lineTo(-0.38, 0.52);
  s.lineTo(-0.66, 0.44);
  s.lineTo(-0.66, 0.2);
  s.quadraticCurveTo(-0.6, 0.02, -0.52, -0.05);
  s.lineTo(-0.38, -0.05);
  return s;
}

/** The stamped grille: a panel with seven vertical slots and the two lamp openings (x, y in the jeep frame). */
function grilleShape(): Shape {
  const s = new Shape();
  const w = 0.37;
  s.moveTo(-w, -0.06);
  s.lineTo(w, -0.06);
  s.lineTo(w, 0.38);
  s.quadraticCurveTo(w, 0.44, w - 0.06, 0.44);
  s.lineTo(-w + 0.06, 0.44);
  s.quadraticCurveTo(-w, 0.44, -w, 0.38);
  s.lineTo(-w, -0.06);
  for (let i = -3; i <= 3; i++) {
    const x = i * 0.062;
    const slot = new Path();
    slot.moveTo(x - 0.016, 0.06);
    slot.lineTo(x + 0.016, 0.06);
    slot.lineTo(x + 0.016, 0.36);
    slot.lineTo(x - 0.016, 0.36);
    slot.lineTo(x - 0.016, 0.06);
    s.holes.push(slot);
  }
  for (const x of [-0.285, 0.285]) {
    const lamp = new Path();
    lamp.absarc(x, 0.26, 0.082, 0, Math.PI * 2, false);
    s.holes.push(lamp);
  }
  return s;
}

/**
 * One road wheel, axis along X: an off-road tyre (bulged sidewalls, a crowned tread with staggered lugs) and
 * a dished steel rim with five nuts and a hub cap.
 */
function wheelGeometry(): { tyre: BufferGeometry; rim: BufferGeometry } {
  const R = JEEP.wheelRadiusM;
  const half = 0.12;
  // Lathe profile (radius, along the axle), inner bead round the sidewall to the tread and back.
  const prof: [number, number][] = [
    [R * 0.6, -half * 0.86],
    [R * 0.78, -half * 1.02],
    [R * 0.92, -half * 0.98],
    [R * 0.985, -half * 0.8],
    [R * 0.995, -half * 0.3],
    [R, 0],
    [R * 0.995, half * 0.3],
    [R * 0.985, half * 0.8],
    [R * 0.92, half * 0.98],
    [R * 0.78, half * 1.02],
    [R * 0.6, half * 0.86],
  ];
  const tyreParts: BufferGeometry[] = [new LatheGeometry(prof.map(([r, y]) => new Vector2(r, y)), 40).rotateZ(-Math.PI / 2)];
  const lugs = 22;
  for (let i = 0; i < lugs; i++) {
    for (const side of [-1, 1]) {
      const a = ((i + (side > 0 ? 0.5 : 0)) / lugs) * Math.PI * 2;
      const lug = new BoxGeometry(0.085, 0.022, 0.05).translate(side * 0.045, R + 0.006, 0).rotateX(a);
      tyreParts.push(lug);
    }
  }
  const rimProf: [number, number][] = [
    [0.001, 0.07],
    [0.05, 0.07],
    [0.06, 0.06],
    [0.13, 0.045],
    [0.17, 0.02],
    [R * 0.6, 0.075],
    [R * 0.62, 0.095],
    [R * 0.6, 0.1],
    [R * 0.58, -0.09],
    [R * 0.6, -0.1],
  ];
  const rimParts: BufferGeometry[] = [new LatheGeometry(rimProf.map(([r, y]) => new Vector2(r, y)), 32).rotateZ(-Math.PI / 2)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    rimParts.push(cyl(0.012, 0.012, 0.03, 6, 'x', 0.075, Math.cos(a) * 0.085, Math.sin(a) * 0.085));
  }
  rimParts.push(new SphereGeometry(0.05, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2).translate(0.07, 0, 0));
  return { tyre: join(tyreParts), rim: join(rimParts) };
}

export class JeepView {
  readonly group = new Group();
  readonly headlights: SpotLight[] = [];
  /** The beams in the air (lightBeams.ts), seen at night, in haze and rain. */
  private readonly beams: HeadlightBeams;
  /** Radiance of the lamp glasses when lit, pre-exposed. */
  readonly glassGlow = uniform(0);
  private readonly wheels: { pivot: Group; spin: Group; front: boolean }[] = [];
  private readonly bonnet = new Group();
  private readonly doors: Record<'driver' | 'passenger', Group> = { driver: new Group(), passenger: new Group() };

  constructor() {
    this.group.name = 'jeep';
    this.group.rotation.order = 'YXZ';
    // The downloaded model when it loaded (render/jeepModel.ts), else the procedural jeep drawn below.
    const model = jeepLoaded();
    const lamp = model ? { x: JEEP_LAMP.x, y: JEEP_LAMP.y, z: JEEP_LAMP.z - 0.02 } : { x: 0.285, y: 0.26, z: -1.68 };
    this.beams = new HeadlightBeams(new Vector3(-lamp.x, lamp.y, lamp.z), new Vector3(lamp.x, lamp.y, lamp.z), new Vector3(0, -0.68, -10.32));
    if (model) {
      this.buildFromModel(lamp.y, lamp.z);
      return;
    }
    const paint = new MeshStandardNodeMaterial({ name: 'jeep paint', color: OLIVE, roughness: 0.72 });
    // Island use: sand caked low on the body and in the wheel arches, sun-faded paint on top.
    const p = positionLocal;
    const n = fract(sin(dot(p.mul(9.1), vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const dust = smoothstep(0.22, -0.32, p.y).mul(float(0.55).add(n.mul(0.25)));
    const faded = smoothstep(0.3, 0.6, p.y).mul(0.12);
    // Under the dust, a machine left on a beach (wear.ts): rust low and round the arches, chipped paint,
    // rain-run dirt down the sides.
    const worn = paintWear(p, vec3(0.074, 0.098, 0.043).mul(float(1).add(faded)), 0.72, { lowY: 0.05, amount: 0.75 });
    paint.colorNode = mix(worn.colour, vec3(0.42, 0.36, 0.26), dust);
    paint.roughnessNode = mix(worn.roughness, float(0.95), dust);
    paint.metalnessNode = worn.metalness.mul(float(1).sub(dust));
    const dark = new MeshStandardNodeMaterial({ name: 'jeep chassis', color: 0x1f2120, roughness: 0.8, metalness: 0 });
    const tyre = new MeshStandardNodeMaterial({ name: 'jeep tyre', color: 0x1c1c1c, roughness: 0.93 });
    // Olive canvas over the seat springs, and the load's boards and canvas, each the jeep's own (baked below).
    const seatMat = vehicleMaterial('canvas', 'jeep seat');
    const crateMat = vehicleMaterial('boards', 'jeep crate');
    const chrome = new MeshStandardNodeMaterial({ name: 'jeep metal', color: 0xb0b0a8, roughness: 0.3, metalness: 1 });
    const glass = new MeshStandardNodeMaterial({ name: 'jeep screen', color: 0x0e1214, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22 });
    const red = new MeshStandardNodeMaterial({ name: 'jeep tail lamp', color: 0x7a1410, roughness: 0.3 });
    const glow = new MeshBasicNodeMaterial({ name: 'jeep headlight' });
    glow.colorNode = vec3(1, 0.92, 0.78).mul(this.glassGlow);

    const W = JEEP.widthM;
    const xs = W / 2 - 0.08; // tub sides
    const add = (parent: Group, g: BufferGeometry, m: Material, cast = true): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // ---- the body (paint)
    const body: BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      body.push(sidePanel(rearSideShape(), s > 0 ? xs - 0.04 : -xs, 0.04));
      body.push(sidePanel(cowlSideShape(), s > 0 ? xs - 0.04 : -xs, 0.04));
      // Rolled top edge of the tub.
      body.push(cyl(0.024, 0.024, 1.33, 10, 'z', s * (xs - 0.02), 0.53, 0.89));
      // Front wing: flat over the wheel, curled down at the nose; the inner apron closes it to the bay.
      body.push(rbox(0.46, 0.03, 1.0, 0.012, s * 0.6, 0.2, FRONT_Z - 0.08));
      body.push(rbox(0.46, 0.03, 0.26, 0.012, s * 0.6, 0.09, FRONT_Z - 0.62, 1.05));
      body.push(rbox(0.03, 0.32, 1.0, 0.01, s * 0.37, 0.05, FRONT_Z - 0.08));
      // Bay sides under the bonnet.
      body.push(rbox(0.035, 0.42, 1.14, 0.01, s * 0.37, 0.21, -1.0));
    }
    body.push(rbox(W - 0.2, 0.04, 1.95, 0.01, 0, 0, 0.6)); // floor
    body.push(rbox(W - 0.14, 0.57, 0.045, 0.015, 0, 0.235, 1.56)); // tail panel
    body.push(rbox(W - 0.18, 0.52, 0.04, 0.012, 0, 0.25, -0.4)); // dash
    body.push(cyl(0.035, 0.035, W - 0.18, 12, 'x', 0, 0.5, -0.41)); // cowl roll under the screen
    body.push(sidePanel(grilleShape(), 0, 0.022).applyMatrix4(new Matrix4().set(0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1)).translate(0, 0, -1.6));
    // Seat boxes behind the front seats, the wheel boxes in the rear tub.
    for (const s of [-1, 1]) body.push(rbox(0.32, 0.36, 0.7, 0.03, s * 0.55, 0.18, REAR_Z - 0.05));
    add(this.group, join(body), paint);

    // ---- frame, axles, springs, bumpers, exhaust, dash details (dark)
    const chassis: BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      chassis.push(rbox(0.07, 0.13, 3.15, 0.01, s * 0.42, -0.13, 0));
      for (const z of [FRONT_Z, REAR_Z]) {
        // Leaf spring: a stack of leaves, shortest at the bottom, under the rail.
        for (let k = 0; k < 4; k++) chassis.push(rbox(0.06, 0.012, 0.95 - k * 0.18, 0.004, s * 0.42, -0.21 - k * 0.014, z));
      }
    }
    for (const z of [FRONT_Z, REAR_Z]) {
      chassis.push(cyl(0.045, 0.045, JEEP.trackM - 0.1, 12, 'x', 0, WHEEL_Y, z));
      chassis.push(new SphereGeometry(0.13, 16, 10).scale(1, 1, 0.9).translate(0.12, WHEEL_Y, z));
    }
    chassis.push(rbox(W - 0.06, 0.12, 0.1, 0.02, 0, -0.08, -1.73)); // front bumper
    for (const s of [-1, 1]) {
      chassis.push(rbox(0.26, 0.1, 0.1, 0.02, s * 0.56, -0.06, 1.66)); // rear bumperettes
      chassis.push(new TorusGeometry(0.045, 0.012, 6, 12).rotateY(Math.PI / 2).translate(s * 0.32, -0.1, -1.8)); // tow hooks
    }
    chassis.push(rbox(0.6, 0.4, 0.06, 0.01, 0, 0.2, -1.55)); // radiator core behind the slots
    chassis.push(new BoxGeometry(0.5, 0.32, 0.55).translate(0, 0.1, -1.0)); // engine block
    chassis.push(tube([new Vector3(0.3, -0.08, -0.8), new Vector3(0.3, -0.16, -0.4), new Vector3(0.32, -0.18, 1.2), new Vector3(0.36, -0.15, 1.62)], [0.028, 0.028, 0.028, 0.03], 8, 1));
    for (const s of [-1, 1]) {
      chassis.push(cyl(0.095, 0.1, 0.11, 16, 'z', s * 0.285, 0.26, -1.6)); // lamp buckets
      // Windscreen frame: posts, top rail, sill, and the split's centre bar.
      chassis.push(rbox(0.045, 0.46, 0.05, 0.012, s * (xs - 0.04), 0.74, -0.42));
    }
    chassis.push(rbox(W - 0.16, 0.045, 0.05, 0.012, 0, 0.965, -0.42));
    chassis.push(rbox(W - 0.16, 0.04, 0.05, 0.012, 0, 0.52, -0.42));
    chassis.push(rbox(0.03, 0.42, 0.045, 0.01, 0, 0.74, -0.42));
    // Steering column and wheel (left-hand drive), dash dials, gear levers.
    const sx = JEEP.seat.across;
    chassis.push(tube([new Vector3(sx, 0.32, -0.41), new Vector3(sx, 0.6, -0.2)], [0.022, 0.022], 8, 1));
    const ring = new TorusGeometry(0.19, 0.014, 8, 32);
    const spokes: BufferGeometry[] = [ring];
    for (let i = 0; i < 3; i++) spokes.push(new BoxGeometry(0.17, 0.016, 0.01).translate(0.085, 0, 0).rotateZ((i / 3) * Math.PI * 2 + Math.PI / 2));
    chassis.push(join(spokes).rotateX(-1.1).translate(sx, 0.62, -0.19));
    for (const dx of [-0.12, 0.12]) chassis.push(cyl(0.035, 0.035, 0.02, 14, 'z', sx + 0.32 + dx, 0.36, -0.43));
    for (const dx of [0, 0.07]) {
      chassis.push(tube([new Vector3(-0.05 + dx, 0.02, -0.2), new Vector3(-0.08 + dx, 0.35, -0.12)], [0.008, 0.008], 6, 1));
      chassis.push(new SphereGeometry(0.022, 8, 6).translate(-0.08 + dx, 0.36, -0.12));
    }
    add(this.group, join(chassis), dark);

    // ---- roll bar and grab handles (metal)
    const metal: BufferGeometry[] = [];
    const rx = xs - 0.06;
    metal.push(tube([new Vector3(-rx, 0.5, 0.55), new Vector3(-rx, 1.08, 0.55), new Vector3(-rx + 0.1, 1.18, 0.55), new Vector3(rx - 0.1, 1.18, 0.55), new Vector3(rx, 1.08, 0.55), new Vector3(rx, 0.5, 0.55)], [0.028, 0.028, 0.028, 0.028, 0.028, 0.028], 10, 1));
    for (const s of [-1, 1]) metal.push(tube([new Vector3(s * (xs + 0.01), 0.4, 1.2), new Vector3(s * (xs + 0.05), 0.4, 1.25), new Vector3(s * (xs + 0.05), 0.4, 1.4), new Vector3(s * (xs + 0.01), 0.4, 1.45)], [0.012, 0.012, 0.012, 0.012], 6, 1));
    for (const s of [-1, 1]) metal.push(new TorusGeometry(0.088, 0.012, 8, 24).translate(s * 0.285, 0.26, -1.655)); // lamp rims
    add(this.group, join(metal), chrome);

    // ---- seats (canvas over springs): cushions and backs, rear bench
    const seats: BufferGeometry[] = [];
    const seatZ = -JEEP.seat.along + 0.05;
    for (const s of [-1, 1]) {
      seats.push(rbox(0.44, 0.1, 0.44, 0.04, s * 0.38, 0.12, seatZ));
      seats.push(rbox(0.44, 0.46, 0.09, 0.04, s * 0.38, 0.42, seatZ + 0.25, -0.15));
    }
    seats.push(rbox(W - 0.34, 0.1, 0.42, 0.04, 0, 0.42, 1.2));
    seats.push(rbox(W - 0.34, 0.36, 0.08, 0.04, 0, 0.66, 1.48, -0.12));
    // The load on the rear bench: a kit bag lying beside the crate.
    seats.push(new CapsuleGeometry(0.14, 0.42, 4, 12).rotateZ(Math.PI / 2).scale(1, 0.82, 1).rotateY(0.12).translate(0.3, 0.585, 1.2));
    // An open jeep's seats are out in the rain.
    const seatGeo = join(seats);
    markDry(seatGeo, 0);
    add(this.group, seatGeo, seatMat);
    // A crate strapped down on the bench's other side.
    const crate = join([rbox(0.5, 0.3, 0.36, 0.012, 0, 0.15, 0), rbox(0.04, 0.3, 0.38, 0.008, -0.245, 0.15, 0), rbox(0.04, 0.3, 0.38, 0.008, 0.245, 0.15, 0)]);
    crate.rotateY(-0.08).translate(-0.3, 0.47, 1.18);
    markDry(crate, 0);
    add(this.group, crate, crateMat);

    // ---- the windscreen panes, lamp glasses, tail lamps
    for (const s of [-1, 1]) add(this.group, new BoxGeometry((W - 0.26) / 2 - 0.03, 0.4, 0.006).translate(s * ((W - 0.26) / 4 + 0.008), 0.74, -0.42), glass, false);
    for (const s of [-1, 1]) add(this.group, cyl(0.08, 0.08, 0.02, 20, 'z', s * 0.285, 0.26, -1.655), glow, false);
    for (const s of [-1, 1]) add(this.group, rbox(0.08, 0.06, 0.03, 0.01, s * 0.6, 0.38, 1.59), red, false);
    const light = new SpotLight(0xfff0d8, 0, 60, 0.5, 0.55, 2);
    light.position.set(0, 0.28, -1.68);
    light.target.position.set(0, -0.4, -12);
    light.castShadow = false;
    this.group.add(light, light.target, this.beams.mesh);
    this.headlights.push(light);

    // ---- kit on the tail and side: spare wheel, jerry can, shovel
    const { tyre: tyreGeo, rim: rimGeo } = wheelGeometry();
    const spareT = tyreGeo.clone().rotateY(Math.PI / 2).translate(0.32, 0.3, 1.72);
    const spareR = rimGeo.clone().rotateY(Math.PI / 2).translate(0.32, 0.3, 1.72);
    add(this.group, spareT, tyre);
    const can: BufferGeometry[] = [rbox(0.34, 0.46, 0.16, 0.03, -0.42, 0.27, 1.67)];
    // The jerry can's pressed X on its face, and its triple handle on top.
    for (const a of [0.9, -0.9]) can.push(rbox(0.4, 0.022, 0.012, 0.005, 0, 0, 0).rotateZ(a).translate(-0.42, 0.27, 1.755));
    can.push(rbox(0.16, 0.05, 0.03, 0.01, -0.42, 0.53, 1.67));
    add(this.group, join([spareR, ...can]), paint);
    // A second can upright in the well behind the front seats.
    const can2: BufferGeometry[] = [rbox(0.34, 0.46, 0.16, 0.03, 0, 0.25, 0), rbox(0.16, 0.05, 0.03, 0.01, 0, 0.51, 0)];
    for (const a of [0.9, -0.9]) can2.push(rbox(0.4, 0.022, 0.012, 0.005, 0, 0, 0).rotateZ(a).translate(0, 0.25, -0.085));
    add(this.group, join(can2).rotateY(0.2).translate(0.05, 0.02, 0.72), paint);
    const shovel: BufferGeometry[] = [cyl(0.017, 0.017, 0.85, 8, 'z', -(xs + 0.03), 0.3, 0.75)];
    // The ratchet strap over the crate on the bench, its buckle on the near side.
    for (const part of [rbox(0.04, 0.006, 0.38, 0.002, 0, 0.303, 0), rbox(0.04, 0.3, 0.006, 0.002, 0, 0.15, 0.19), rbox(0.04, 0.3, 0.006, 0.002, 0, 0.15, -0.19), rbox(0.05, 0.04, 0.02, 0.005, 0, 0.18, 0.198)]) {
      shovel.push(part.rotateY(-0.08).translate(-0.3, 0.47, 1.18));
    }
    shovel.push(rbox(0.012, 0.2, 0.24, 0.02, -(xs + 0.03), 0.3, 1.27));
    add(this.group, join(shovel), dark);

    // ---- bonnet, hinged at the screen (its own group: it opens)
    this.bonnet.position.set(0, 0.42, -0.45);
    const bonnetParts: BufferGeometry[] = [rbox(0.76, 0.035, 1.16, 0.015, 0, 0, -0.58)];
    for (const s of [-1, 1]) bonnetParts.push(rbox(0.04, 0.03, 0.06, 0.01, s * 0.385, -0.03, -0.75));
    add(this.bonnet, join(bonnetParts), paint);
    this.group.add(this.bonnet);

    // ---- half doors, hinged at their front edge
    for (const [side, s] of [
      ['driver', -1],
      ['passenger', 1],
    ] as const) {
      const d = this.doors[side];
      d.position.set(s * (xs - 0.02), 0.0, -0.38);
      add(d, join([rbox(0.04, 0.5, 0.6, 0.015, 0, 0.25, 0.31), cyl(0.022, 0.022, 0.6, 10, 'z', 0, 0.51, 0.31)]), paint);
      this.group.add(d);
    }

    // ---- wheels: a pivot that steers, a hub that rolls
    for (const s of [-1, 1]) {
      for (const [z, front] of [
        [FRONT_Z, true],
        [REAR_Z, false],
      ] as const) {
        const pivot = new Group();
        pivot.position.set((s * JEEP.trackM) / 2, WHEEL_Y, z);
        const spin = new Group();
        // The rim's dish faces outward on both sides.
        const flip = s < 0 ? new Matrix4().makeRotationY(Math.PI) : new Matrix4();
        add(spin, tyreGeo.clone().applyMatrix4(flip), tyre);
        add(spin, rimGeo.clone().applyMatrix4(flip), paint);
        pivot.add(spin);
        this.group.add(pivot);
        this.wheels.push({ pivot, spin, front });
      }
    }
    // Grime in every corner and the sky light shut out under the body (aoBake.ts), baked once with the
    // doors and bonnet shut; their occlusion rides along when they open.
    bakeAmbientOcclusion(this.group);
  }

  /** The model's body, its bonnet on its hinge, its wheels on pivots that steer and hubs that roll. */
  private buildFromModel(lampY: number, lampZ: number): void {
    const parts = jeepParts(this.glassGlow);
    for (const m of parts.body) this.group.add(m);
    this.bonnet.position.copy(parts.hinge);
    for (const m of parts.bonnet) this.bonnet.add(m);
    this.group.add(this.bonnet);
    for (const w of parts.wheels) {
      const pivot = new Group();
      pivot.position.copy(w.at);
      const spin = new Group();
      for (const m of w.meshes) spin.add(m);
      pivot.add(spin);
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, front: w.front });
    }
    // The model has no doors (an open tub): the door groups stay empty, the doors' openings only timed.
    const light = new SpotLight(0xfff0d8, 0, 60, 0.5, 0.55, 2);
    light.position.set(0, lampY, lampZ);
    light.target.position.set(0, lampY - 0.68, lampZ - 10.3);
    light.castShadow = false;
    this.group.add(light, light.target, this.beams.mesh);
    this.headlights.push(light);
  }

  update(jeep: Jeep, alpha: number, preExposure: number): void {
    const g = this.group;
    g.position.set(jeep.prev.x + (jeep.pos.x - jeep.prev.x) * alpha, jeep.prev.y + (jeep.pos.y - jeep.prev.y) * alpha, jeep.prev.z + (jeep.pos.z - jeep.prev.z) * alpha);
    g.rotation.set(jeep.pitchRad, jeep.prevYawRad + (jeep.yawRad - jeep.prevYawRad) * alpha, -jeep.rollRad);
    for (const w of this.wheels) {
      w.pivot.rotation.y = w.front ? -jeep.steerRad : 0;
      w.spin.rotation.x = -jeep.wheelAngle;
    }
    this.bonnet.rotation.x = jeep.bonnet * 1.2;
    this.doors.driver.rotation.y = jeep.doors.driver * 1.3;
    this.doors.passenger.rotation.y = -jeep.doors.passenger * 1.3;
    const on = jeep.headlights ? 1 : 0;
    // One light for two lamps: twice one lamp's intensity.
    for (const l of this.headlights) l.intensity = 2 * JEEP.headlightCd * preExposure * on;
    this.glassGlow.value = 3e4 * preExposure * on;
    this.beams.update(g, JEEP.headlightCd * preExposure * on);
  }
}
