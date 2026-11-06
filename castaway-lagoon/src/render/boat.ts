import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxGeometry, BufferAttribute, BufferGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, type Material, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Shape, ShapeGeometry, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three/webgpu';
import { positionLocal, vec3 } from 'three/tsl';
import { BOAT } from '../config.ts';
import type { Boat } from '../game/boat.ts';
import { bakeAmbientOcclusion } from './aoBake.ts';
import { merge, tube } from './meshkit.ts';
import { markDry } from './outpost.ts';
import { propMaterials, vehicleMaterial } from './propMaterials.ts';
import { paintWear } from './wear.ts';
import { SKIFF_TRANSOM_Y, skiffLoaded, skiffMaskGeometry, skiffMeshes } from './skiffModel.ts';

// The skiff as drawn: the downloaded runabout (skiffModel.ts) when it loaded, with the outboard below on its
// transom and a water mask cut to its own gunwale. Otherwise, the dinghy: a lofted aluminium hull with a rolled gunwale rail and
// a spray rail along each chine, ribs and floorboards inside, three thwarts, a
// fuel tank piped to an outboard on the transom that turns with the tiller and
// spins its propeller with the engine, oars and a coil of line in the bottom.
// Built in the boat's own frame the logic uses (game/boat.ts): forward is −Z,
// starboard +X, y = 0 the still waterline.
//
// The water mesh would show through the floor where a wave crest rises
// above it, so a depth-only cap at gunwale height is drawn just before the
// water (render order 9 against the water's 10): the water fails the depth
// test inside the hull, and the floor and seats drawn earlier stay visible.

const SECTIONS = 18;
const GUNWALE_Y = 0.42;
const BOTTOM_Y = -BOAT.keelBelowRefM;

export class BoatView {
  readonly group = new Group();
  private readonly motor = new Group();
  private readonly prop = new Group();
  private propAngle = 0;

  constructor() {
    this.group.name = 'boat';
    this.group.rotation.order = 'YXZ';
    const paint = new MeshStandardNodeMaterial({ name: 'boat paint', color: 0x2e5a66, roughness: 0.55, metalness: 0.1, side: DoubleSide });
    // Weathered boards for the thwarts and floorboards, and a hull that has been in the water for years:
    // paint chipped to bare aluminium, grey-green scum along and below the waterline (wear.ts).
    const boards = vehicleMaterial('boards', 'boat boards');
    const oarWood = new MeshStandardNodeMaterial({ name: 'oar', color: 0x7a5c3c, roughness: 0.62 });
    const rail = new MeshStandardNodeMaterial({ name: 'boat rail', color: 0x8c8f90, roughness: 0.5, metalness: 1 });
    const tankMat = new MeshStandardNodeMaterial({ name: 'fuel tank', color: 0x8a2618, roughness: 0.55 });
    const hullWear = paintWear(positionLocal, vec3(0.027, 0.1, 0.13), 0.55, {
      lowY: -0.05,
      amount: 0.85,
      bloom: [
        [0.05, 0.06, 0.035],
        [0.16, 0.17, 0.12],
      ],
    });
    paint.colorNode = hullWear.colour;
    paint.roughnessNode = hullWear.roughness;
    paint.metalnessNode = hullWear.metalness.add(0.1);
    const cowl = new MeshStandardNodeMaterial({ name: 'outboard cowl', color: 0xcfccc2, roughness: 0.42 });
    const metal = new MeshStandardNodeMaterial({ name: 'outboard leg', color: 0x3a3c3d, roughness: 0.45, metalness: 0.35 });
    const dark = new MeshStandardNodeMaterial({ name: 'outboard trim', color: 0x1d1f20, roughness: 0.7 });
    const bronze = new MeshStandardNodeMaterial({ name: 'outboard propeller', color: 0x8a8d8f, roughness: 0.3, metalness: 1 });

    const model = skiffLoaded() ? skiffMeshes() : null;
    // The downloaded runabout when it loaded (skiffModel.ts); the lofted dinghy below otherwise.
    const part = (g: BufferGeometry, m: Material, cast = true): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    // The boards' material reads `dry` (rain darkens what is out in the open): all of the boat is.
    const wet = (g: BufferGeometry): BufferGeometry => {
      markDry(g, 0);
      return g;
    };
    if (!model) {
      const hull = new Mesh(hullGeometry(), paint);
      hull.castShadow = true;
      hull.receiveShadow = true;
      this.group.add(hull);

      const thwarts: BufferGeometry[] = [];
      for (const [along, t] of [
        [BOAT.seat.along, 0.05],
        [0.35, 0.05],
        [1.25, 0.04],
      ] as const) {
        const w = halfBeam(along) * 2 - 0.06;
        thwarts.push(new RoundedBoxGeometry(w, t, 0.26, 1, 0.008).translate(0, BOAT.seat.up - t / 2, -along));
      }
      // Floorboards: three slats along the flat of the bottom, resting on the ribs.
      for (const x of [-0.22, 0, 0.22]) thwarts.push(new RoundedBoxGeometry(0.11, 0.018, 2.3, 1, 0.005).translate(x, floorY(x) + 0.033, 0.15));
      part(wet(merge(thwarts, 'boat boards')), boards);

      // Rolled gunwale rail along the sheer and over the transom; a spray rail along each chine.
      const railParts: BufferGeometry[] = [];
      for (const s of [-1, 1]) {
        const gunwale: Vector3[] = [];
        const chine: Vector3[] = [];
        for (let k = 0; k <= SECTIONS; k++) {
          const along = -BOAT.lengthM / 2 + (k / SECTIONS) * BOAT.lengthM;
          const hb = Math.max(0.005, halfBeam(along));
          gunwale.push(new Vector3(s * hb * 1.02, sheer(along) + 0.005, -along));
          if (along < BOAT.lengthM * 0.38) chine.push(new Vector3(s * hb * 1.004, keelAt(along) + 0.45 * (sheer(along) - keelAt(along)), -along));
        }
        railParts.push(tube(gunwale, gunwale.map(() => 0.02), 8, 0.5));
        railParts.push(tube(chine, chine.map(() => 0.011), 6, 0.5));
      }
      const sternHb = halfBeam(-BOAT.lengthM / 2) * 1.02;
      railParts.push(tube([new Vector3(-sternHb, GUNWALE_Y + 0.005, BOAT.lengthM / 2), new Vector3(sternHb, GUNWALE_Y + 0.005, BOAT.lengthM / 2)], [0.02, 0.02], 8, 0.5));
      part(merge(railParts, 'boat rails'), rail);

      // Ribs: a frame round the inside of the hull at five stations, under the floorboards.
      const ribs: BufferGeometry[] = [];
      for (const along of [-1.25, -0.65, -0.05, 0.55, 1.1]) {
        const hb = halfBeam(along);
        const keel = keelAt(along);
        const top = sheer(along);
        const pts = PROFILE.map(([fx, fy]) => new Vector3(fx * (hb - 0.016), keel + fy * (top - keel - 0.02) + 0.014 * (1 - fy), -along));
        ribs.push(tube(pts, pts.map(() => 0.013), 6, 0.5));
      }
      part(merge(ribs, 'boat ribs'), paint);

      // Six-gallon tank aft on the floorboards, its fuel line looping up to the outboard.
      const tankY = floorY(0.32) + 0.05;
      const tank: BufferGeometry[] = [new RoundedBoxGeometry(0.3, 0.22, 0.42, 2, 0.035).translate(0.32, tankY + 0.11, 1.42)];
      tank.push(new CylinderGeometry(0.025, 0.025, 0.03, 10).translate(0.37, tankY + 0.235, 1.3).toNonIndexed());
      tank.push(new BoxGeometry(0.03, 0.03, 0.18).translate(0.27, tankY + 0.235, 1.45).toNonIndexed());
      part(merge(tank, 'fuel tank'), tankMat);
      const line = tube([new Vector3(0.37, tankY + 0.25, 1.3), new Vector3(0.33, tankY + 0.34, 1.45), new Vector3(0.18, GUNWALE_Y + 0.02, 1.68), new Vector3(0.05, GUNWALE_Y + 0.05, 1.8)], [0.008, 0.008, 0.008, 0.008], 6, 0.5);
      part(line, dark);

      // Oars shipped along the port side, on the thwarts, blades forward.
      const oars: BufferGeometry[] = [];
      for (const [x, y, roll] of [
        [-0.5, BOAT.seat.up + 0.02, 0.1],
        [-0.4, BOAT.seat.up + 0.045, -0.15],
      ] as const) {
        const from = new Vector3(x + 0.04, y, 1.35);
        const to = new Vector3(x, y + 0.01, -0.9);
        oars.push(tube([from, to], [0.019, 0.021], 8, 0.5, true));
        oars.push(new CylinderGeometry(0.016, 0.016, 0.12, 8).rotateX(Math.PI / 2).translate(from.x, from.y, from.z + 0.06).toNonIndexed());
        oars.push(new RoundedBoxGeometry(0.15, 0.014, 0.52, 1, 0.006).rotateZ(roll).translate(x - 0.005, y + 0.01, -1.15));
      }
      part(merge(oars, 'oars'), oarWood);
    }

    // Outboard: a small two-stroke clamped on the transom, pivoting for the tiller (motor frame: +z aft,
    // y up from the transom top). Rounded cowling over a darker lower cowl, a streamlined leg, the
    // anti-cavitation plate, the gearcase torpedo with its skeg, and a three-blade propeller.
    // On the runabout's higher transom the leg is let down to the same depth, the bracket over the transom.
    this.motor.position.set(0, model ? SKIFF_TRANSOM_Y - 0.2 : GUNWALE_Y - 0.02, BOAT.lengthM / 2 + (model ? 0.08 : 0.05));
    // Every part non-indexed so they merge (the rounded box already is: toNonIndexed would warn).
    const rbox = (w: number, h: number, d: number, r: number, x: number, y: number, z: number): BufferGeometry => {
      const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.999).translate(x, y, z);
      return g.index ? g.toNonIndexed() : g;
    };
    const upper = new Mesh(rbox(0.25, 0.22, 0.4, 0.08, 0, 0.27, 0.17), cowl);
    const lowerCowl = mergeGeometries([
      rbox(0.27, 0.1, 0.43, 0.03, 0, 0.12, 0.17),
      // Transom bracket and its two clamp screws with T handles, inside the transom.
      rbox(0.17, 0.2, 0.07, 0.02, 0, -0.02, 0.0),
      ...[-0.05, 0.05].flatMap((x) => [new CylinderGeometry(0.012, 0.012, 0.1, 8).rotateX(Math.PI / 2).translate(x, -0.08, -0.06).toNonIndexed(), new CylinderGeometry(0.008, 0.008, 0.07, 6).rotateZ(Math.PI / 2).translate(x, -0.08, -0.11).toNonIndexed()]),
      // Tiller grip, rubber.
      new CylinderGeometry(0.026, 0.024, 0.15, 10).rotateX(Math.PI / 2 - 0.12).translate(0, 0.17, -0.55).toNonIndexed(),
    ]);
    const leg = new Mesh(
      mergeGeometries([
        // The leg's streamlined section: an ellipse 1.7 times as long as it is wide.
        new CylinderGeometry(0.055, 0.045, 0.64, 16).scale(0.72, 1, 1.7).translate(0, -0.33, 0.14).toNonIndexed(),
        // Anti-cavitation plate over the propeller.
        rbox(0.2, 0.01, 0.26, 0.004, 0, -0.66, 0.19),
        // Gearcase: a torpedo along the thrust line, rounded nose forward, tapering aft to the hub.
        new CylinderGeometry(0.044, 0.04, 0.24, 14).rotateX(Math.PI / 2).translate(0, -0.78, 0.13).toNonIndexed(),
        new SphereGeometry(0.044, 14, 8).scale(1, 1, 1.4).translate(0, -0.78, 0.01).toNonIndexed(),
        // Skeg under the gearcase, protecting the propeller.
        new BoxGeometry(0.012, 0.12, 0.14).translate(0, -0.86, 0.17).toNonIndexed(),
        // Tiller arm from the cowl's front, rising a little toward the hand.
        new CylinderGeometry(0.016, 0.022, 0.45, 8).rotateX(Math.PI / 2 - 0.12).translate(0, 0.14, -0.26).toNonIndexed(),
      ]) as BufferGeometry,
      metal,
    );
    const trim = new Mesh(lowerCowl as BufferGeometry, dark);
    this.prop.position.set(0, -0.78, 0.27);
    const hub = new Mesh(new ConeGeometry(0.03, 0.08, 12).rotateX(Math.PI / 2).translate(0, 0, 0.03), bronze);
    this.prop.add(hub);
    for (let k = 0; k < 3; k++) {
      // A twisted blade: a flat ellipse set at its pitch angle on the hub.
      const blade = new Mesh(new SphereGeometry(1, 12, 6).scale(0.045, 0.08, 0.006).rotateY(0.55).translate(0, 0.075, 0), bronze);
      const arm = new Group();
      arm.rotation.z = (k / 3) * Math.PI * 2;
      arm.add(blade);
      this.prop.add(arm);
    }
    this.motor.add(upper, trim, leg, this.prop);
    for (const m of [upper, trim, leg]) m.castShadow = true;
    this.group.add(this.motor);

    // Grime under the thwarts and round the outboard's bracket (aoBake.ts); the mask is skipped (transparent).
    bakeAmbientOcclusion(this.group);
    if (!model) {
      // A coil of line in the bottom forward. Added after the bake: the rope material is the camp's,
      // whose meshes carry no `ao` attribute, so it must not be wired to one (aoBake.ts).
      const coil = merge(
        [0, 1, 2, 3].map((k) => new TorusGeometry(0.16 - k * 0.012, 0.011, 5, 24).rotateX(Math.PI / 2).translate(0.18 + k * 0.006, floorY(0.18) + 0.06 + k * 0.016, -0.95)),
        'boat line',
      );
      part(wet(coil), propMaterials().rope);
    }
    // The model after the bake: its occlusion was cast when it was prepared (its second colour set).
    if (model) for (const m of model.meshes) this.group.add(m);

    // Depth-only cap that keeps the water surface out of the hull.
    const mask = new Mesh(model ? skiffMaskGeometry(model.geometries, SKIFF_TRANSOM_Y - 0.06) : maskGeometry(), new MeshBasicNodeMaterial({ name: 'boat water mask', colorWrite: false, depthWrite: true, transparent: true, side: DoubleSide }));
    mask.renderOrder = 9;
    this.group.add(mask);
  }

  update(boat: Boat, alpha: number, dt: number): void {
    const g = this.group;
    g.position.set(boat.prev.x + (boat.pos.x - boat.prev.x) * alpha, boat.prev.y + (boat.pos.y - boat.prev.y) * alpha, boat.prev.z + (boat.pos.z - boat.prev.z) * alpha);
    const yaw = boat.prevYawRad + (boat.yawRad - boat.prevYawRad) * alpha;
    g.rotation.set(boat.pitchRad, yaw, -boat.rollRad);
    this.motor.rotation.y = boat.steer * BOAT.maxTillerRad;
    this.propAngle += dt * boat.rpm * 90 * Math.sign(boat.throttle || 1);
    this.prop.rotation.z = this.propAngle;
  }
}

/** Half the beam at a station `along` the hull (bow +): full amidships, a pointed bow, a square transom. */
function halfBeam(along: number): number {
  const t = along / (BOAT.lengthM / 2); // −1 stern … 1 bow
  const b = BOAT.beamM / 2;
  if (t > 0.25) return b * Math.sqrt(Math.max(0, 1 - ((t - 0.25) / 0.75) ** 2));
  return b * (0.86 + 0.14 * Math.min(1, (t + 1) / 0.9));
}

/** The hull's sheer: the gunwale rises toward the bow. */
function sheer(along: number): number {
  const t = along / (BOAT.lengthM / 2);
  return GUNWALE_Y + Math.max(0, t) ** 2 * 0.14;
}

/** Profile across a section, as (fraction of half-beam, height 0 keel … 1 gunwale). */
const PROFILE = [
  [-1.02, 1],
  [-1, 0.45],
  [-0.8, 0.08],
  [0, 0],
  [0.8, 0.08],
  [1, 0.45],
  [1.02, 1],
] as const;

/** The keel's height at a station: the bow's forefoot rises, sweeping up over the last fifth. */
function keelAt(along: number): number {
  const t = along / (BOAT.lengthM / 2);
  return BOTTOM_Y + Math.max(0, (t - 0.6) / 0.4) ** 2 * (sheer(along) - BOTTOM_Y) * 0.7;
}

/** The inside of the bottom amidships at `x` across (the flat between the chines). */
function floorY(x: number): number {
  return BOTTOM_Y + (Math.min(Math.abs(x), 0.8 * halfBeam(0)) / (0.8 * halfBeam(0))) * 0.08 * (GUNWALE_Y - BOTTOM_Y);
}

/** Lofted hull: port gunwale → chine → keel → chine → starboard gunwale at each station, plus the transom. */
function hullGeometry(): BufferGeometry {
  const cols = PROFILE.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s <= SECTIONS; s++) {
    const along = -BOAT.lengthM / 2 + (s / SECTIONS) * BOAT.lengthM;
    const hb = Math.max(0.005, halfBeam(along));
    const top = sheer(along);
    const keel = keelAt(along);
    for (const [fx, fy] of PROFILE) pos.push(fx * hb, keel + fy * (top - keel), -along);
  }
  for (let s = 0; s < SECTIONS; s++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = s * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  // Transom: a fan over the stern section.
  const centre = pos.length / 3;
  pos.push(0, (BOTTOM_Y + GUNWALE_Y) / 2, BOAT.lengthM / 2);
  for (let c = 0; c < cols - 1; c++) idx.push(centre, c, c + 1);
  idx.push(centre, cols - 1, 0);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The hull's outline at the gunwale, as a flat cap a little below it. */
function maskGeometry(): BufferGeometry {
  const pts: Vector2[] = [];
  const n = 24;
  for (let k = 0; k <= n; k++) {
    const along = -BOAT.lengthM / 2 + (k / n) * BOAT.lengthM;
    pts.push(new Vector2(halfBeam(along), along));
  }
  for (let k = n; k >= 0; k--) {
    const along = -BOAT.lengthM / 2 + (k / n) * BOAT.lengthM;
    pts.push(new Vector2(-halfBeam(along), along));
  }
  // Shape (x, y) → the boat's x (starboard) and −z (forward), laid flat at gunwale height, facing up.
  const g = new ShapeGeometry(new Shape(pts));
  g.rotateX(-Math.PI / 2);
  g.translate(0, GUNWALE_Y - 0.04, 0);
  return g;
}
