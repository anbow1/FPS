import { BufferAttribute, BufferGeometry, LineBasicNodeMaterial, LineSegments } from 'three/webgpu';
import type { Vec3 } from '../core/vec.ts';
import type { ForceDebug } from '../sim/aircraft.ts';

// Debug overlay of every force on the aircraft (brief, milestone 1): lift green,
// drag red, side force yellow, thrust orange, weight blue, and the velocity
// vector white, drawn from the centre of mass in the world, 1 m per 15 kN.
// One line mesh with a fixed buffer, updated in place.

const METRES_PER_N = 1 / 15_000;
const COLOURS: [number, number, number][] = [
  [0.2, 1, 0.3],
  [1, 0.25, 0.2],
  [1, 0.9, 0.2],
  [1, 0.55, 0.1],
  [0.3, 0.5, 1],
  [1, 1, 1],
];

export class ForceArrows {
  readonly mesh: LineSegments;
  private readonly positions = new Float32Array(COLOURS.length * 6);

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.positions, 3));
    const colours = new Float32Array(COLOURS.length * 6);
    COLOURS.forEach((c, i) => colours.set([...c, ...c], i * 6));
    g.setAttribute('color', new BufferAttribute(colours, 3));
    const m = new LineBasicNodeMaterial({ name: 'force arrows', vertexColors: true, depthTest: false, transparent: true });
    this.mesh = new LineSegments(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'force arrows';
  }

  /** Arrows from `origin` (world, relative to the floating origin of the render) for the forces and the velocity. */
  update(origin: { x: number; y: number; z: number }, forces: ForceDebug, velocity: Vec3, visible: boolean): void {
    this.mesh.visible = visible;
    if (!visible) return;
    const list = [forces.lift, forces.drag, forces.side, forces.thrust, forces.weight];
    list.forEach((f, i) => this.set(i, origin, f.x * METRES_PER_N, f.y * METRES_PER_N, f.z * METRES_PER_N));
    // Velocity: 1 m per 10 m/s.
    this.set(5, origin, velocity.x / 10, velocity.y / 10, velocity.z / 10);
    const attr = this.mesh.geometry.getAttribute('position');
    attr.needsUpdate = true;
  }

  private set(i: number, o: { x: number; y: number; z: number }, dx: number, dy: number, dz: number): void {
    const p = this.positions;
    p.set([o.x, o.y, o.z, o.x + dx, o.y + dy, o.z + dz], i * 6);
  }
}
