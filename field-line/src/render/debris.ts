import { Color, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardNodeMaterial, Quaternion, type Scene, Vector3 } from 'three/webgpu';

// Solid debris: chips and chunks that fly on real ballistic arcs, tumble, hit
// the ground, bounce a little, skid and settle, lie there for a few seconds,
// then sink away. A flat sprite reads as a dot; a lit, spinning chunk that
// lands and stays is what sells a hit on concrete or a blast in the dirt.
// One instanced draw for every chunk; nothing allocates per frame.

const CAPACITY = 320;
const GRAVITY = 9.81;
const SINK_SECONDS = 0.6;

interface Chunk {
  alive: boolean;
  pos: Vector3;
  vel: Vector3;
  spinAxis: Vector3;
  spinRadS: number;
  rot: Quaternion;
  scale: Vector3;
  age: number;
  life: number;
  groundY: number; // NaN until the first step resolves it
  resting: boolean;
}

export class Debris {
  readonly mesh: InstancedMesh;
  private readonly chunks: Chunk[] = [];
  private next = 0;
  /** Height of the highest surface under a point, below `maxY` (terrain, pavement, roofs); set by the effects. */
  groundAt: (x: number, z: number, maxY: number) => number = () => 0;
  private tick = 0;

  constructor(scene: Scene) {
    // An icosahedron with its corners pushed in and out: a broken, faceted lump rather than a ball.
    const g = new IcosahedronGeometry(0.5, 0);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      // Same corner, same push: the faces stay closed.
      const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
      const k = 0.7 + (h - Math.floor(h)) * 0.55;
      p.setXYZ(i, x * k, y * k * 0.7, z * k);
    }
    g.computeVertexNormals();
    const m = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, flatShading: true });
    this.mesh = new InstancedMesh(g, m, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    const white = new Color(1, 1, 1);
    for (let i = 0; i < CAPACITY; i++) {
      this.mesh.setMatrixAt(i, _zero);
      this.mesh.setColorAt(i, white);
      this.chunks.push({ alive: false, pos: new Vector3(), vel: new Vector3(), spinAxis: new Vector3(0, 1, 0), spinRadS: 0, rot: new Quaternion(), scale: new Vector3(), age: 0, life: 1, groundY: Number.NaN, resting: false });
    }
    scene.add(this.mesh);
  }

  /** One chunk of `sizeM` (its longest side) thrown from (x, y, z) at (vx, vy, vz) m/s; it lies for `lifeSeconds`. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, sizeM: number, colour: number, lifeSeconds: number): void {
    const c = this.chunks[this.next] as Chunk;
    const i = this.next;
    this.next = (this.next + 1) % CAPACITY;
    c.alive = true;
    c.pos.set(x, y, z);
    c.vel.set(vx, vy, vz);
    c.spinAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    c.spinRadS = 8 + Math.random() * 22;
    c.rot.setFromAxisAngle(c.spinAxis, Math.random() * 6.28);
    // Chips are flakes: one axis thinner, and no two the same proportions.
    c.scale.set(sizeM * (0.6 + Math.random() * 0.4), sizeM * (0.35 + Math.random() * 0.35), sizeM * (0.6 + Math.random() * 0.4));
    c.age = 0;
    c.life = lifeSeconds;
    c.groundY = Number.NaN;
    c.resting = false;
    // A little variation per chunk: fresh breaks are lighter or darker than the face they came from.
    this.mesh.setColorAt(i, _c.setHex(colour).multiplyScalar(0.8 + Math.random() * 0.35));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    const step = Math.min(dt, 1 / 30);
    let any = false;
    this.tick++;
    for (let i = 0; i < CAPACITY; i++) {
      const c = this.chunks[i] as Chunk;
      if (!c.alive) continue;
      any = true;
      c.age += step;
      if (c.age >= c.life + SINK_SECONDS) {
        c.alive = false;
        this.mesh.setMatrixAt(i, _zero);
        continue;
      }
      // What is under a flying chunk changes as it crosses a kerb or leaves a roof: look again every few frames.
      if (Number.isNaN(c.groundY) || (!c.resting && ((i + this.tick) & 3) === 0)) c.groundY = this.groundAt(c.pos.x, c.pos.z, c.pos.y + 0.05);
      const half = c.scale.y * 0.5;
      if (!c.resting) {
        c.vel.y -= GRAVITY * step;
        // Air drag matters for a chip, hardly for a stone: scaled by size.
        c.vel.multiplyScalar(Math.exp(-step * (0.02 / Math.max(c.scale.x, 0.01))));
        c.pos.addScaledVector(c.vel, step);
        c.rot.premultiply(_dq.setFromAxisAngle(c.spinAxis, c.spinRadS * step));
        if (c.pos.y < c.groundY + half) {
          c.pos.y = c.groundY + half;
          if (c.vel.y < -1.2) {
            // Bounce: most of the energy goes into the ground; the spin gets a new axis from the knock.
            c.vel.set(c.vel.x * 0.55, -c.vel.y * 0.28, c.vel.z * 0.55);
            c.spinAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            c.spinRadS *= 0.5;
          } else {
            // Settle flat: the thin axis turns to stand vertical, then it stops.
            c.resting = true;
            _e.set(0, 1, 0).applyQuaternion(c.rot);
            c.rot.premultiply(_dq.setFromUnitVectors(_e, _up));
          }
        }
      }
      // The last moments: sink into the ground rather than pop out.
      const sink = Math.max(0, c.age - c.life) / SINK_SECONDS;
      _p.copy(c.pos);
      _p.y -= sink * c.scale.y;
      _m.compose(_p, c.rot, _s.copy(c.scale).multiplyScalar(1 - sink * 0.5));
      this.mesh.setMatrixAt(i, _m);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _zero = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _p = new Vector3();
const _s = new Vector3();
const _e = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dq = new Quaternion();
const _c = new Color();
