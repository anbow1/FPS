import { uniform, vec3 } from 'three/tsl';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Object3D, SpotLight, TorusGeometry } from 'three/webgpu';
import { JEEP } from '../config.ts';
import type { Jeep } from '../game/jeep.ts';

// The old jeep as drawn, in the logic's frame (game/jeep.ts): forward −Z,
// right +X, y = 0 the body's reference point (the floor over the axles). A
// flat-sided tub, a bonnet hinged at the windscreen over a visible engine
// block, half doors hinged at their front edge, a fold-down screen frame, a
// roll bar, a spare wheel on the tail, and four wheels that steer and roll.
//
// The headlights are two glowing lenses and one spot light between them: every
// lit material in the scene pays for every light, even at zero intensity, so
// one light stands in for the pair. It exists from the start (a fixed light
// count, so switching it on compiles nothing) and casts no shadows.

const OLIVE = 0x4f5a3a;

export class JeepView {
  readonly group = new Group();
  readonly headlights: SpotLight[] = [];
  /** Radiance of the lamp glasses when lit, pre-exposed. */
  readonly glassGlow = uniform(0);
  private readonly wheels: { pivot: Group; spin: Group; front: boolean }[] = [];
  private readonly bonnet = new Group();
  private readonly doors: Record<'driver' | 'passenger', Group> = { driver: new Group(), passenger: new Group() };

  constructor() {
    this.group.name = 'jeep';
    this.group.rotation.order = 'YXZ';
    const paint = new MeshStandardNodeMaterial({ name: 'jeep paint', color: OLIVE, roughness: 0.75 });
    const dark = new MeshStandardNodeMaterial({ name: 'jeep chassis', color: 0x1f2120, roughness: 0.8, metalness: 0.3 });
    const tyre = new MeshStandardNodeMaterial({ name: 'jeep tyre', color: 0x191919, roughness: 0.95 });
    const seatMat = new MeshStandardNodeMaterial({ name: 'jeep seat', color: 0x2b261f, roughness: 0.9 });
    const chrome = new MeshStandardNodeMaterial({ name: 'jeep metal', color: 0x9a9a92, roughness: 0.35, metalness: 0.9 });
    const glow = new MeshBasicNodeMaterial({ name: 'jeep headlight' });
    glow.colorNode = vec3(1, 0.92, 0.78).mul(this.glassGlow);

    const L = JEEP.lengthM;
    const W = JEEP.widthM;
    const add = (parent: Object3D, g: BoxGeometry | CylinderGeometry | TorusGeometry, m: MeshStandardNodeMaterial | MeshBasicNodeMaterial, x: number, y: number, z: number, cast = true): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // Chassis rails and the tub.
    add(this.group, new BoxGeometry(W * 0.7, 0.14, L * 0.95), dark, 0, -0.12, 0);
    add(this.group, new BoxGeometry(W - 0.2, 0.05, L * 0.62), paint, 0, 0, 0.35); // floor
    for (const s of [-1, 1]) add(this.group, new BoxGeometry(0.05, 0.5, L * 0.36), paint, s * (W / 2 - 0.12), 0.25, 0.9); // rear sides
    add(this.group, new BoxGeometry(W - 0.2, 0.5, 0.05), paint, 0, 0.25, 1.53); // tailgate
    add(this.group, new BoxGeometry(W - 0.2, 0.55, 0.05), paint, 0, 0.27, -0.42); // firewall / dash
    // Fenders over the wheels.
    for (const s of [-1, 1]) {
      for (const z of [-JEEP.wheelbaseM / 2, JEEP.wheelbaseM / 2]) add(this.group, new BoxGeometry(0.34, 0.04, 0.9), paint, s * (W / 2 - 0.02), 0.2, z);
    }
    // Engine bay: block, radiator, grille, and the bonnet hinged at the screen.
    add(this.group, new BoxGeometry(0.55, 0.35, 0.6), dark, 0, 0.12, -1.0);
    add(this.group, new BoxGeometry(W * 0.62, 0.45, 0.06), dark, 0, 0.2, -1.52); // radiator
    for (let k = -3; k <= 3; k++) add(this.group, new BoxGeometry(0.03, 0.42, 0.03), paint, k * 0.12, 0.22, -1.58, false); // grille slats
    for (const s of [-1, 1]) add(this.group, new BoxGeometry(0.05, 0.35, 1.1), paint, s * (W * 0.33), 0.2, -1.0); // bay sides
    this.bonnet.position.set(0, 0.42, -0.45);
    add(this.bonnet, new BoxGeometry(W * 0.7, 0.04, 1.12), paint, 0, 0, -0.56);
    this.group.add(this.bonnet);
    // Headlights: glasses in the grille, one spot light between them aiming down the road.
    for (const s of [-1, 1]) add(this.group, new CylinderGeometry(0.09, 0.09, 0.05, 14).rotateX(Math.PI / 2), glow, s * 0.42, 0.28, -1.6, false);
    const light = new SpotLight(0xfff0d8, 0, 60, 0.5, 0.55, 2);
    light.position.set(0, 0.28, -1.62);
    light.target.position.set(0, -0.4, -12);
    light.castShadow = false;
    this.group.add(light, light.target);
    this.headlights.push(light);
    // Windscreen frame and roll bar.
    for (const s of [-1, 1]) add(this.group, new BoxGeometry(0.04, 0.45, 0.04), dark, s * (W / 2 - 0.12), 0.72, -0.4);
    add(this.group, new BoxGeometry(W - 0.2, 0.04, 0.04), dark, 0, 0.94, -0.4);
    add(this.group, new BoxGeometry(W - 0.2, 0.03, 0.04), dark, 0, 0.5, -0.4);
    for (const s of [-1, 1]) add(this.group, new CylinderGeometry(0.03, 0.03, 0.95, 8), chrome, s * (W / 2 - 0.15), 0.72, 0.5);
    add(this.group, new CylinderGeometry(0.03, 0.03, W - 0.3, 8).rotateZ(Math.PI / 2), chrome, 0, 1.2, 0.5);
    // Seats and the steering wheel (left-hand drive).
    for (const s of [-1, 1]) {
      add(this.group, new BoxGeometry(0.45, 0.1, 0.45), seatMat, s * 0.38, 0.12, JEEP.seat.along * -1 + 0.05);
      add(this.group, new BoxGeometry(0.45, 0.5, 0.08), seatMat, s * 0.38, 0.4, JEEP.seat.along * -1 + 0.3);
    }
    add(this.group, new BoxGeometry(W - 0.3, 0.1, 0.45), seatMat, 0, 0.12, 1.1); // rear bench
    const wheel = add(this.group, new TorusGeometry(0.17, 0.018, 6, 20), dark, JEEP.seat.across, 0.62, -0.18, false);
    wheel.rotation.x = -1.1;
    // Spare wheel on the tail.
    add(this.group, new CylinderGeometry(JEEP.wheelRadiusM, JEEP.wheelRadiusM, 0.22, 16).rotateX(Math.PI / 2), tyre, 0, 0.35, 1.68);
    // Half doors, hinged at their front edge.
    for (const [side, s] of [
      ['driver', -1],
      ['passenger', 1],
    ] as const) {
      const d = this.doors[side];
      d.position.set(s * (W / 2 - 0.1), 0.05, -0.38);
      add(d, new BoxGeometry(0.04, 0.42, 0.62), paint, 0, 0.22, 0.31);
      this.group.add(d);
    }
    // Wheels: a pivot that steers, a hub that rolls.
    for (const s of [-1, 1]) {
      for (const [z, front] of [
        [-JEEP.wheelbaseM / 2, true],
        [JEEP.wheelbaseM / 2, false],
      ] as const) {
        const pivot = new Group();
        pivot.position.set(s * JEEP.trackM / 2, JEEP.wheelRadiusM - JEEP.rideHeightM, z);
        const spin = new Group();
        add(spin, new CylinderGeometry(JEEP.wheelRadiusM, JEEP.wheelRadiusM, 0.24, 18).rotateZ(Math.PI / 2), tyre, 0, 0, 0);
        add(spin, new CylinderGeometry(0.15, 0.15, 0.25, 8).rotateZ(Math.PI / 2), chrome, 0, 0, 0, false);
        pivot.add(spin);
        this.group.add(pivot);
        this.wheels.push({ pivot, spin, front });
      }
    }
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
  }
}
