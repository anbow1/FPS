import { BoxGeometry, type BufferGeometry, CylinderGeometry, Group, type Material, Mesh, type MeshStandardNodeMaterial, type Scene } from 'three/webgpu';
import type { TargetKind } from '../config.ts';
import type { GroundForce, GroundTarget } from '../sim/targets.ts';
import { box } from './airframe.ts';
import { plain } from './jetMaterials.ts';

// The ground force's vehicles: an invented main battle tank, a wheeled armoured
// personnel carrier and a covered truck, in two field paints and without
// markings. Each sits on the slope it stands on (pitched and rolled from the
// ground either side), and a destroyed one swaps to charred paint with its
// turret thrown askew. The forward axis is −z, as everywhere else.

interface VehicleView {
  root: Group;
  turret: Group | null;
  parts: Mesh[];
  dead: boolean;
}

export class TargetView {
  private readonly views = new Map<number, VehicleView>();
  private readonly olive = plain('vehicle olive', 0x4a5030, 0.8);
  private readonly sand = plain('vehicle sand', 0x8a7a55, 0.85);
  private readonly dark = plain('running gear', 0x1d1e1b, 0.9);
  private readonly canvas = plain('truck cover', 0x5d5a3c, 0.95);
  private readonly charred = plain('charred', 0x1a1816, 0.95);
  private readonly root = new Group();

  constructor(scene: Scene) {
    scene.add(this.root);
  }

  update(force: GroundForce, groundAt: (x: number, z: number) => number): void {
    const seen = new Set<number>();
    for (const t of force.targets) {
      seen.add(t.id);
      let v = this.views.get(t.id);
      if (!v) {
        v = this.build(t.kind, t.id % 3 === 0 ? this.sand : this.olive);
        this.root.add(v.root);
        this.views.set(t.id, v);
      }
      this.place(v, t, groundAt);
      if (!t.alive && !v.dead) {
        v.dead = true;
        for (const p of v.parts) p.material = this.charred;
        if (v.turret) {
          v.turret.rotation.y += 0.7;
          v.turret.rotation.z = 0.25;
          v.turret.position.y += 0.35;
        }
      }
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.root.remove(v.root);
      for (const p of v.parts) p.geometry.dispose();
      this.views.delete(id);
    }
  }

  private place(v: VehicleView, t: GroundTarget, groundAt: (x: number, z: number) => number): void {
    const { x, z } = t.position;
    const fx = -Math.sin(t.headingRad);
    const fz = -Math.cos(t.headingRad);
    // Pitch and roll from the ground 3 m ahead/behind and to either side.
    const ahead = groundAt(x + fx * 3, z + fz * 3) - groundAt(x - fx * 3, z - fz * 3);
    const right = groundAt(x - fz * 1.6, z + fx * 1.6) - groundAt(x + fz * 1.6, z - fx * 1.6);
    v.root.position.set(x, t.position.y, z);
    v.root.rotation.set(Math.atan2(ahead, 6), t.headingRad, -Math.atan2(right, 3.2), 'YXZ');
  }

  private build(kind: TargetKind, paint: MeshStandardNodeMaterial): VehicleView {
    const root = new Group();
    const parts: Mesh[] = [];
    const add = (g: BufferGeometry, m: Material, parent: Group = root): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      parts.push(mesh);
      return mesh;
    };
    const wheel = (r: number, w: number, x: number, y: number, z: number): void => {
      add(new CylinderGeometry(r, r, w, 14).rotateZ(Math.PI / 2).translate(x, y, z), this.dark);
    };
    let turret: Group | null = null;
    if (kind === 'tank') {
      // Hull with a sloped glacis, track runs with road wheels, side skirts.
      add(box(-1.55, 0.55, -3.4, 1.55, 1.55, 3.4), paint);
      add(box(-1.5, 0.55, -3.9, 1.5, 1.25, -3.4), paint);
      add(new BoxGeometry(3.0, 0.5, 0.9).rotateX(-0.6).translate(0, 1.4, -3.55), paint);
      for (const side of [-1, 1]) {
        add(box(-0.32, 0.0, -3.6, 0.32, 0.85, 3.5).translate(side * 1.6, 0, 0), this.dark);
        for (let k = 0; k < 6; k++) wheel(0.38, 0.5, side * 1.6, 0.42, -2.6 + k * 1.05);
        add(box(-0.05, 0.75, -3.4, 0.05, 1.45, 3.2).translate(side * 1.96, 0, 0), paint);
      }
      // Turret: a low faceted box, the gun, a commander's cupola.
      turret = new Group();
      turret.position.set(0, 1.55, 0.3);
      root.add(turret);
      add(box(-1.25, 0, -1.6, 1.25, 0.75, 1.5), paint, turret);
      add(new BoxGeometry(2.3, 0.6, 0.8).rotateX(-0.5).translate(0, 0.38, -1.8), paint, turret);
      add(new CylinderGeometry(0.1, 0.12, 5.2, 10).rotateX(Math.PI / 2).translate(0, 0.42, -4.6), paint, turret);
      add(new CylinderGeometry(0.16, 0.16, 0.9, 10).rotateX(Math.PI / 2).translate(0, 0.42, -2.3), paint, turret);
      add(new CylinderGeometry(0.32, 0.36, 0.3, 12).translate(0.55, 0.9, 0.4), paint, turret);
      add(box(-1.1, 0.1, 1.5, 1.1, 0.6, 2.1), paint, turret);
    } else if (kind === 'apc') {
      // Boat-shaped hull on eight wheels, a small turret with an autocannon.
      add(box(-1.4, 0.9, -2.9, 1.4, 2.1, 3.3), paint);
      add(new BoxGeometry(2.8, 1.0, 1.2).rotateX(0.7).translate(0, 1.55, -3.15), paint);
      add(new BoxGeometry(2.8, 0.6, 0.9).rotateX(-0.7).translate(0, 0.95, -3.0), paint);
      for (const side of [-1, 1]) for (let k = 0; k < 4; k++) wheel(0.55, 0.42, side * 1.35, 0.55, -2.2 + k * 1.45);
      turret = new Group();
      turret.position.set(0, 2.1, -0.4);
      root.add(turret);
      add(new CylinderGeometry(0.75, 0.85, 0.55, 12).translate(0, 0.28, 0), paint, turret);
      add(new CylinderGeometry(0.05, 0.06, 2.3, 8).rotateX(Math.PI / 2).translate(0, 0.32, -1.7), this.dark, turret);
    } else {
      // Truck: cab, chassis, a canvas-covered cargo bed, six wheels.
      add(box(-1.2, 0.95, -3.6, 1.2, 2.6, -1.8), paint);
      add(box(-1.15, 1.9, -3.62, 1.15, 2.45, -3.58), this.dark);
      add(box(-0.5, 0.6, -3.7, 0.5, 1.0, 3.2), this.dark);
      add(box(-1.25, 1.05, -1.6, 1.25, 1.45, 3.4), paint);
      // The hoops' arch: the upper half of a cylinder lying along the bed, flattened.
      add(
        new CylinderGeometry(1.25, 1.25, 4.95, 16, 1, false, Math.PI / 2, Math.PI)
          .rotateX(Math.PI / 2)
          .scale(1, 0.55, 1)
          .translate(0, 1.95, 0.92),
        this.canvas,
      );
      add(box(-1.25, 1.45, -1.55, 1.25, 1.95, 3.4), this.canvas);
      for (const side of [-1, 1]) for (const z of [-2.8, 1.4, 2.6]) wheel(0.5, 0.35, side * 1.05, 0.5, z);
    }
    return { root, turret, parts, dead: false };
  }
}
