import { float, mix, mx_noise_float, normalLocal, positionLocal, smoothstep, vec2, vec3 } from 'three/tsl';
import { BoxGeometry, type BufferGeometry, Color, CylinderGeometry, Group, type Material, Mesh, MeshStandardNodeMaterial, type Node, type Scene } from 'three/webgpu';
import type { TargetKind } from '../config.ts';
import type { GroundForce, GroundTarget } from '../sim/targets.ts';
import { box } from './airframe.ts';
import { bakeAmbientOcclusion } from './aoBake.ts';
import { opticsMaterial, rbox, wheel } from './heliDetail.ts';
import { plain } from './jetMaterials.ts';

// The ground force's vehicles: an invented main battle tank, a wheeled armoured
// personnel carrier and a covered truck, in two field paints and without
// markings. Each sits on the slope it stands on (pitched and rolled from the
// ground either side), and a destroyed one swaps to charred paint with its
// turret thrown askew. The forward axis is −z, as everywhere else.
//
// Seen through the gunner's sight they are close and large, so they carry the
// parts that make a vehicle read as one (playbook §6j): the tank's tracks with
// their links, sprocket, idler and return rollers, fenders and stowage bins,
// smoke dischargers, the cupola's machine gun and an antenna; the carrier's
// tyred wheels, hatches and periscopes; the truck's glazed cab, grille, lamps,
// mirrors and fuel tank. Field paint is dusty low down and streaked on the
// sides, and the baked AO puts grime in every corner. One template per kind
// and paint is built and baked once; each vehicle is a clone of it (shared
// geometry, so no bake and no hitch when a column appears).

interface VehicleView {
  root: Group;
  turret: Group | null;
  parts: Mesh[];
  dead: boolean;
}

/** Field paint, worn: dust low on the hull, wash-down streaks on the sides, faded patches on top. */
function fieldPaint(name: string, hex: number, roughness: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, roughness, metalness: 0 });
  const c = new Color(hex);
  const P = positionLocal;
  const n = normalLocal;
  let colour: Node<'vec3'> = vec3(c.r, c.g, c.b);
  // Faded and patched: the sun bleaches the tops, repairs leave fresher squares.
  const fade = smoothstep(0.3, 0.9, n.y).mul(mx_noise_float(P.mul(0.9)).mul(0.5).add(0.5)).mul(0.18);
  colour = colour.mul(float(1).add(fade));
  // Wash-down streaks on the sides.
  const side = float(1).sub(smoothstep(0.4, 0.8, n.y.abs()));
  const across = P.z.mul(n.x.abs()).add(P.x.mul(n.z.abs()));
  const streak = smoothstep(0.45, 0.85, mx_noise_float(vec2(across.mul(8), P.y.mul(0.8))));
  colour = colour.mul(float(1).sub(streak.mul(side).mul(0.16)));
  // Dust thrown up by the wheels: the lower metre goes the colour of the ground.
  const dust = smoothstep(1.3, 0.35, P.y).mul(mx_noise_float(P.mul(2.3)).mul(0.3).add(0.7));
  colour = mix(colour, vec3(0.29, 0.25, 0.18), dust.mul(0.55));
  m.colorNode = colour;
  return m;
}

/** Track links: dark steel with a cross-groove every 15 cm along the run, polished where they bear. */
function trackMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'track', metalness: 0.6 });
  const link = positionLocal.z.mul(1 / 0.15).fract();
  const groove = smoothstep(0.08, 0.0, link).add(smoothstep(0.92, 1.0, link));
  const base = vec3(0.07, 0.065, 0.06).mul(mx_noise_float(positionLocal.mul(6)).mul(0.25).add(0.85));
  m.colorNode = mix(base, vec3(0.02, 0.02, 0.02), groove);
  m.roughnessNode = mix(float(0.55), float(0.9), groove);
  return m;
}

export class TargetView {
  private readonly views = new Map<number, VehicleView>();
  private readonly olive = fieldPaint('vehicle olive', 0x4a5030, 0.8);
  private readonly sand = fieldPaint('vehicle sand', 0x8a7a55, 0.85);
  private readonly dark = plain('running gear', 0x1d1e1b, 0.9);
  private readonly rubber = plain('tyre', 0x161616, 0.92);
  private readonly steel = plain('fittings', 0x2c2d2a, 0.6, 0.4);
  private readonly track = trackMaterial();
  private readonly canvas = fieldPaint('truck cover', 0x5d5a3c, 0.95);
  private readonly glass = opticsMaterial();
  private readonly lamp = plain('lamp glass', 0x9a978a, 0.15);
  private readonly charred = plain('charred', 0x1a1816, 0.95);
  private readonly root = new Group();
  private readonly templates = new Map<string, Group>();

  constructor(scene: Scene) {
    scene.add(this.root);
  }

  update(force: GroundForce, groundAt: (x: number, z: number) => number): void {
    const seen = new Set<number>();
    for (const t of force.targets) {
      seen.add(t.id);
      let v = this.views.get(t.id);
      if (!v) {
        v = this.instance(t.kind, t.id % 3 === 0 ? 'sand' : 'olive');
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

  /** A clone of the kind's baked template (geometry and materials shared; meshes its own, for the charred swap). */
  private instance(kind: TargetKind, paintName: 'olive' | 'sand'): VehicleView {
    const key = `${kind}-${paintName}`;
    let template = this.templates.get(key);
    if (!template) {
      template = this.build(kind, paintName === 'sand' ? this.sand : this.olive);
      bakeAmbientOcclusion(template);
      this.templates.set(key, template);
    }
    const root = template.clone(true);
    const parts: Mesh[] = [];
    root.traverse((o) => {
      if (o instanceof Mesh) parts.push(o);
    });
    const turret = (root.getObjectByName('turret') as Group | undefined) ?? null;
    return { root, turret, parts, dead: false };
  }

  private build(kind: TargetKind, paint: MeshStandardNodeMaterial): Group {
    const root = new Group();
    const add = (g: BufferGeometry, m: Material, parent: Group = root, cast = true): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const at = (g: BufferGeometry, x: number, y: number, z: number): BufferGeometry => g.translate(x, y, z);
    let turret: Group | null = null;
    if (kind === 'tank') {
      // Hull with a sloped glacis, an engine deck with its grille, fenders over the tracks.
      add(box(-1.55, 0.55, -3.4, 1.55, 1.55, 3.4), paint);
      add(box(-1.5, 0.55, -3.9, 1.5, 1.25, -3.4), paint);
      add(new BoxGeometry(3.0, 0.5, 0.9).rotateX(-0.6).translate(0, 1.4, -3.55), paint);
      for (let k = 0; k < 7; k++) add(at(new BoxGeometry(2.2, 0.04, 0.08), 0, 1.57, 1.6 + k * 0.22), this.dark, root, false);
      for (const side of [-1, 1]) {
        // Track run: the belt over the wheels (links in the material), sprocket at the back, idler in front.
        add(box(-0.32, 0.02, -3.6, 0.32, 0.12, 3.5).translate(side * 1.6, 0, 0), this.track);
        add(box(-0.32, 0.86, -3.3, 0.32, 0.95, 3.2).translate(side * 1.6, 0, 0), this.track);
        for (let k = 0; k < 6; k++) add(new CylinderGeometry(0.38, 0.38, 0.5, 16).rotateZ(Math.PI / 2).translate(side * 1.6, 0.42, -2.6 + k * 1.05), this.dark);
        add(new CylinderGeometry(0.4, 0.4, 0.55, 12).rotateZ(Math.PI / 2).translate(side * 1.6, 0.6, 3.3), this.steel);
        add(new CylinderGeometry(0.34, 0.34, 0.5, 16).rotateZ(Math.PI / 2).translate(side * 1.6, 0.6, -3.35), this.dark);
        for (let k = 0; k < 3; k++) add(new CylinderGeometry(0.12, 0.12, 0.3, 10).rotateZ(Math.PI / 2).translate(side * 1.6, 0.86, -1.6 + k * 1.6), this.dark);
        // Side skirt with a rubber lower edge, the fender above it, two stowage bins on it.
        add(box(-0.05, 0.75, -3.4, 0.05, 1.45, 3.2).translate(side * 1.96, 0, 0), paint);
        add(box(-0.06, 0.62, -3.4, 0.06, 0.76, 3.2).translate(side * 1.96, 0, 0), this.rubber);
        add(box(-0.4, 1.5, -3.5, 0.4, 1.56, 3.4).translate(side * 1.6, 0, 0), paint);
        for (const z of [-1.0, 0.6]) add(at(rbox(0.6, 0.32, 0.9, 0.04), side * 1.62, 1.72, z), paint);
        // Headlamp guards at the front corners.
        add(at(new CylinderGeometry(0.08, 0.08, 0.06, 10).rotateX(Math.PI / 2), side * 1.2, 1.32, -3.93), this.lamp, root, false);
      }
      // Turret: a low faceted box, the gun with its mantlet and fume extractor, a commander's cupola with
      // a machine gun, smoke dischargers either side, a stowage rack at the back and an antenna.
      turret = new Group();
      turret.name = 'turret';
      turret.position.set(0, 1.55, 0.3);
      root.add(turret);
      add(box(-1.25, 0, -1.6, 1.25, 0.75, 1.5), paint, turret);
      add(new BoxGeometry(2.3, 0.6, 0.8).rotateX(-0.5).translate(0, 0.38, -1.8), paint, turret);
      add(at(rbox(0.7, 0.5, 0.4, 0.06), 0, 0.42, -2.25), paint, turret);
      add(new CylinderGeometry(0.1, 0.12, 5.2, 12).rotateX(Math.PI / 2).translate(0, 0.42, -4.6), paint, turret);
      add(new CylinderGeometry(0.16, 0.16, 0.9, 12).rotateX(Math.PI / 2).translate(0, 0.42, -3.4), paint, turret);
      add(new CylinderGeometry(0.13, 0.11, 0.25, 12).rotateX(Math.PI / 2).translate(0, 0.42, -7.1), this.dark, turret);
      add(new CylinderGeometry(0.32, 0.36, 0.3, 14).translate(0.55, 0.9, 0.4), paint, turret);
      add(new CylinderGeometry(0.025, 0.025, 1.0, 6).rotateX(Math.PI / 2).translate(0.55, 1.15, -0.1), this.dark, turret);
      add(at(rbox(0.12, 0.14, 0.4, 0.02), 0.55, 1.12, 0.25), this.dark, turret);
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) add(new CylinderGeometry(0.045, 0.045, 0.28, 8).rotateX(Math.PI / 2 - 0.5).translate(side * (1.0 + k * 0.07), 0.62, -1.45 + k * 0.02), this.dark, turret);
        // Sight boxes on the turret roof.
        add(at(rbox(0.3, 0.22, 0.36, 0.03), side * -0.55, 0.86, -0.6), paint, turret);
      }
      add(at(new BoxGeometry(0.26, 0.12, 0.02), 0.55, 0.88, -0.79), this.glass, turret, false);
      add(box(-1.1, 0.1, 1.5, 1.1, 0.6, 2.1), paint, turret);
      for (let k = 0; k < 4; k++) add(at(new BoxGeometry(2.2, 0.03, 0.03), 0, 0.62 + k * 0.001, 1.55 + k * 0.17), this.dark, turret, false);
      add(new CylinderGeometry(0.008, 0.012, 2.4, 5).translate(-0.9, 1.95, 1.3), this.dark, turret, false);
    } else if (kind === 'apc') {
      // Boat-shaped hull on eight wheels, a trim vane on the bow, hatches and periscopes, a small turret.
      add(box(-1.4, 0.9, -2.9, 1.4, 2.1, 3.3), paint);
      add(new BoxGeometry(2.8, 1.0, 1.2).rotateX(0.7).translate(0, 1.55, -3.15), paint);
      add(new BoxGeometry(2.8, 0.6, 0.9).rotateX(-0.7).translate(0, 0.95, -3.0), paint);
      add(new BoxGeometry(2.4, 0.05, 0.7).rotateX(0.9).translate(0, 1.45, -3.75), paint);
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) root.add(wheel(side * 1.35, 0.55, -2.2 + k * 1.45, 0.55, 0.42, this.rubber, this.steel, side as 1 | -1));
        for (let k = 0; k < 3; k++) add(at(new BoxGeometry(0.04, 0.12, 0.18), side * 1.41, 1.85, -1.5 + k * 1.3), this.glass, root, false);
        add(at(new CylinderGeometry(0.07, 0.07, 0.06, 10).rotateX(Math.PI / 2), side * 1.0, 1.7, -3.66), this.lamp, root, false);
      }
      for (const [x, z] of [
        [-0.6, 1.4],
        [0.6, 1.4],
        [-0.6, -1.9],
      ] as const) {
        add(at(new CylinderGeometry(0.32, 0.34, 0.08, 16), x, 2.14, z), paint);
        add(at(rbox(0.16, 0.1, 0.1, 0.02), x, 2.22, z - 0.38), this.glass, root, false);
      }
      add(at(rbox(1.0, 0.9, 0.06, 0.04), 0, 1.5, 3.33), paint);
      turret = new Group();
      turret.name = 'turret';
      turret.position.set(0, 2.1, -0.4);
      root.add(turret);
      add(new CylinderGeometry(0.75, 0.85, 0.55, 16).translate(0, 0.28, 0), paint, turret);
      add(new CylinderGeometry(0.05, 0.06, 2.3, 8).rotateX(Math.PI / 2).translate(0, 0.32, -1.7), this.dark, turret);
      add(new CylinderGeometry(0.08, 0.07, 0.25, 10).rotateX(Math.PI / 2).translate(0, 0.32, -2.85), this.dark, turret);
      for (const side of [-1, 1]) for (let k = 0; k < 3; k++) add(new CylinderGeometry(0.04, 0.04, 0.22, 8).rotateX(Math.PI / 2 - 0.5).translate(side * (0.62 + k * 0.06), 0.35, -0.55), this.dark, turret);
    } else {
      // Truck: cab with its glass, grille, bumper, lamps and mirrors; chassis, fuel tank, a canvas-covered bed.
      add(box(-1.2, 0.95, -3.6, 1.2, 2.6, -1.8), paint);
      add(at(new BoxGeometry(2.1, 0.62, 0.03), 0, 2.15, -3.615), this.glass, root, false);
      for (const side of [-1, 1]) add(at(new BoxGeometry(0.03, 0.55, 1.0), side * 1.215, 2.15, -2.6), this.glass, root, false);
      for (let k = 0; k < 6; k++) add(at(new BoxGeometry(1.4, 0.04, 0.04), 0, 1.15 + k * 0.1, -3.63), this.dark, root, false);
      add(box(-1.25, 0.72, -3.85, 1.25, 0.92, -3.6), this.dark);
      for (const side of [-1, 1]) {
        add(at(new CylinderGeometry(0.11, 0.11, 0.06, 12).rotateX(Math.PI / 2), side * 0.9, 1.35, -3.64), this.lamp, root, false);
        add(at(rbox(0.06, 0.28, 0.18, 0.02), side * 1.42, 2.25, -3.3), this.dark, root, false);
        add(at(new CylinderGeometry(0.012, 0.012, 0.35, 5).rotateZ(Math.PI / 2), side * 1.3, 2.25, -3.3), this.dark, root, false);
      }
      add(box(-0.5, 0.6, -3.7, 0.5, 1.0, 3.2), this.dark);
      add(at(new CylinderGeometry(0.28, 0.28, 0.9, 14).rotateZ(Math.PI / 2), -0.85, 0.8, -0.9), this.steel);
      add(box(-1.25, 1.05, -1.6, 1.25, 1.45, 3.4), paint);
      // The hoops' arch: the upper half of a cylinder lying along the bed, flattened; hoop ribs show through.
      add(
        new CylinderGeometry(1.25, 1.25, 4.95, 16, 1, false, Math.PI / 2, Math.PI)
          .rotateX(Math.PI / 2)
          .scale(1, 0.55, 1)
          .translate(0, 1.95, 0.92),
        this.canvas,
      );
      for (let k = 0; k < 5; k++) {
        add(
          new CylinderGeometry(1.27, 1.27, 0.06, 16, 1, false, Math.PI / 2, Math.PI)
            .rotateX(Math.PI / 2)
            .scale(1, 0.55, 1)
            .translate(0, 1.95, -1.3 + k * 1.1),
          this.canvas,
          root,
          false,
        );
      }
      add(box(-1.25, 1.45, -1.55, 1.25, 1.95, 3.4), this.canvas);
      for (const side of [-1, 1]) for (const z of [-2.8, 1.4, 2.6]) root.add(wheel(side * 1.05, 0.5, z, 0.5, 0.35, this.rubber, this.steel, side as 1 | -1));
    }
    return root;
  }
}
