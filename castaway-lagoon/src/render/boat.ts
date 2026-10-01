import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Shape, ShapeGeometry, Vector2 } from 'three/webgpu';
import { BOAT } from '../config.ts';
import type { Boat } from '../game/boat.ts';

// The dinghy as drawn: a lofted aluminium hull (painted outside, bare inside),
// two thwarts, and an outboard on the transom that turns with the tiller and
// spins its propeller with the engine. Built in the boat's own frame the logic
// uses (game/boat.ts): forward is −Z, starboard +X, y = 0 the still waterline.
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
    const wood = new MeshStandardNodeMaterial({ name: 'boat seat', color: 0x8a6a45, roughness: 0.8 });
    const cowl = new MeshStandardNodeMaterial({ name: 'outboard cowl', color: 0x8f8b80, roughness: 0.45 });
    const metal = new MeshStandardNodeMaterial({ name: 'outboard leg', color: 0x3a3c3d, roughness: 0.4, metalness: 0.7 });

    const hull = new Mesh(hullGeometry(), paint);
    hull.castShadow = true;
    hull.receiveShadow = true;
    this.group.add(hull);

    for (const [along, t] of [
      [BOAT.seat.along, 0.05],
      [0.35, 0.05],
      [1.25, 0.04],
    ] as const) {
      const w = halfBeam(along) * 2 - 0.06;
      const seat = new Mesh(new BoxGeometry(w, t, 0.26), wood);
      seat.position.set(0, BOAT.seat.up - t / 2, -along);
      seat.castShadow = true;
      this.group.add(seat);
    }

    // Outboard: clamped on the transom, pivoting for the tiller.
    this.motor.position.set(0, GUNWALE_Y - 0.02, BOAT.lengthM / 2 + 0.05);
    const body = new Mesh(new BoxGeometry(0.22, 0.26, 0.34), cowl);
    body.position.set(0, 0.18, 0.14);
    const leg = new Mesh(new CylinderGeometry(0.035, 0.04, 0.85, 8), metal);
    leg.position.set(0, -0.37, 0.12);
    const foot = new Mesh(new BoxGeometry(0.08, 0.1, 0.3), metal);
    foot.position.set(0, -0.78, 0.1);
    const tiller = new Mesh(new CylinderGeometry(0.018, 0.018, 0.55, 6).rotateX(Math.PI / 2), metal);
    tiller.position.set(0, 0.12, -0.3);
    this.prop.position.set(0, -0.78, 0.27);
    for (let k = 0; k < 3; k++) {
      const blade = new Mesh(new BoxGeometry(0.02, 0.09, 0.012), metal);
      blade.position.y = 0.045;
      const arm = new Group();
      arm.rotation.z = (k / 3) * Math.PI * 2;
      arm.add(blade);
      this.prop.add(arm);
    }
    this.motor.add(body, leg, foot, tiller, this.prop);
    for (const m of [body, leg, foot, tiller]) m.castShadow = true;
    this.group.add(this.motor);

    // Depth-only cap that keeps the water surface out of the hull.
    const mask = new Mesh(maskGeometry(), new MeshBasicNodeMaterial({ name: 'boat water mask', colorWrite: false, depthWrite: true, transparent: true, side: DoubleSide }));
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

/** Lofted hull: port gunwale → chine → keel → chine → starboard gunwale at each station, plus the transom. */
function hullGeometry(): BufferGeometry {
  // Profile across a section, as (fraction of half-beam, height 0 keel … 1 gunwale).
  const profile = [
    [-1.02, 1],
    [-1, 0.45],
    [-0.8, 0.08],
    [0, 0],
    [0.8, 0.08],
    [1, 0.45],
    [1.02, 1],
  ] as const;
  const cols = profile.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s <= SECTIONS; s++) {
    const along = -BOAT.lengthM / 2 + (s / SECTIONS) * BOAT.lengthM;
    const hb = Math.max(0.005, halfBeam(along));
    const top = sheer(along);
    // the bow's forefoot rises: the keel sweeps up over the last fifth
    const t = along / (BOAT.lengthM / 2);
    const keel = BOTTOM_Y + Math.max(0, (t - 0.6) / 0.4) ** 2 * (top - BOTTOM_Y) * 0.7;
    for (const [fx, fy] of profile) pos.push(fx * hb, keel + fy * (top - keel), -along);
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
