import { BufferAttribute, BufferGeometry, Vector3 } from 'three/webgpu';

// A growable triangle soup with named per-vertex attributes, for the street's
// architecture: every quad is written with the attribute values currently set
// (`set`), so a facade can switch tone, kind or occlusion as it goes without
// a vertex format per part. Winding is fixed per quad from a normal hint, so
// the mirrored left side of the street never comes out inside out.

export class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly extra = new Map<string, { size: number; data: number[]; current: number[] }>();

  constructor(attributes: Record<string, number> = {}) {
    for (const [name, size] of Object.entries(attributes)) this.extra.set(name, { size, data: [], current: new Array<number>(size).fill(0) });
  }

  /** Sets the value later vertices take for `name`. */
  set(name: string, ...value: number[]): this {
    const a = this.extra.get(name);
    if (!a) throw new Error(`MeshBuilder has no attribute '${name}'; it has ${[...this.extra.keys()].join(', ')}`);
    if (value.length !== a.size) throw new Error(`attribute '${name}' takes ${a.size} values, got ${value.length}`);
    a.current = value;
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /**
   * A quad a-b-c-d (in order round its edge) with uvs, facing `hint` (flipped if the corners wind the other
   * way). Flat-shaded unless `normals` are given per corner.
   */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, uvs: readonly [number, number][], hint: Vector3, normals?: readonly Vector3[]): void {
    _e1.subVectors(b, a);
    _e2.subVectors(d, a);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-14) {
      _e1.subVectors(c, b);
      _e2.subVectors(a, b);
      _n.crossVectors(_e2, _e1);
    }
    const flip = _n.dot(hint) < 0;
    _n.normalize();
    if (flip) _n.negate();
    const corners = flip ? [a, d, c, b] : [a, b, c, d];
    const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = corners[k] as Vector3;
      const src = order[k] as number;
      this.pos.push(p.x, p.y, p.z);
      const n = normals ? (normals[src] as Vector3) : _n;
      this.nor.push(n.x, n.y, n.z);
      const t = uvs[src] as [number, number];
      this.uv.push(t[0], t[1]);
      for (const a of this.extra.values()) a.data.push(...a.current);
    }
  }

  /** A triangle facing `hint`. */
  tri(a: Vector3, b: Vector3, c: Vector3, uvs: readonly [number, number][], hint: Vector3): void {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2);
    const flip = _n.dot(hint) < 0;
    _n.normalize();
    if (flip) _n.negate();
    const order = flip ? [0, 2, 1] : [0, 1, 2];
    const pts = [a, b, c];
    for (const k of order) {
      const p = pts[k] as Vector3;
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      const t = uvs[k] as [number, number];
      this.uv.push(t[0], t[1]);
      for (const at of this.extra.values()) at.data.push(...at.current);
    }
  }

  /** An axis-free box from its centre and three half-axes; uvs in metres on each face. */
  box(c: Vector3, ax: Vector3, ay: Vector3, az: Vector3, skipBottom = false): void {
    const faces: [Vector3, Vector3, Vector3][] = [
      [ax, ay, az],
      [ax.clone().negate(), ay, az.clone().negate()],
      [az.clone().negate(), ay, ax],
      [az, ay, ax.clone().negate()],
      [ax, az.clone().negate(), ay],
      [ax, az, ay.clone().negate()],
    ];
    faces.forEach(([u, v, n], i) => {
      if (skipBottom && i === 5) return;
      const o = _o.copy(c).add(n);
      const lu = u.length() * 2;
      const lv = v.length() * 2;
      this.quad(
        o.clone().sub(u).sub(v),
        o.clone().add(u).sub(v),
        o.clone().add(u).add(v),
        o.clone().sub(u).add(v),
        [
          [0, 0],
          [lu, 0],
          [lu, lv],
          [0, lv],
        ],
        n,
      );
    });
  }

  build(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    for (const [key, a] of this.extra) g.setAttribute(key, new BufferAttribute(new Float32Array(a.data), a.size));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _e1 = new Vector3();
const _e2 = new Vector3();
const _n = new Vector3();
const _o = new Vector3();
