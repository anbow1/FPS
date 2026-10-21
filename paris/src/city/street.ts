import { Group, Mesh, Vector3 } from 'three/webgpu';
import { STREET } from '../config.ts';
import { granite, pavementMaterial, roadMaterial } from '../render/ground.ts';
import { MeshBuilder } from './meshBuilder.ts';

// The ground: carriageways at road level (the boulevard and the cross
// streets), pavements a kerb higher, and the kerb faces between them. The
// surfaces' detail (asphalt, markings, gutters, tree grates, fallen leaves)
// is drawn by their materials from the world position, so nothing repeats.

/** Half the carriageway of a cross street: its width between facades less two 3.2 m pavements. */
export function crossRoadHalf(widthM: number): number {
  return widthM / 2 - 3.2;
}

const CROSS_REACH_M = 125;

export function buildStreet(): Group {
  const road = new MeshBuilder();
  const pave = new MeshBuilder();
  const kerb = new MeshBuilder();
  const up = new Vector3(0, 1, 0);
  const H = STREET.kerbM;
  const C = STREET.carriageHalfM;
  const F = STREET.facadeHalfM;
  const rect = (b: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number): void => {
    b.quad(new Vector3(x0, y, z0), new Vector3(x1, y, z0), new Vector3(x1, y, z1), new Vector3(x0, y, z1), [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], up);
  };
  /** A kerb face from a to b (on the ground), facing `n`. */
  const face = (a: Vector3, b: Vector3, n: Vector3): void => {
    const len = a.distanceTo(b);
    kerb.quad(a, b, b.clone().setY(H), a.clone().setY(H), [[0, 0], [len, 0], [len, H], [0, H]], n);
  };
  // The boulevard's carriageway, beyond the facades at both ends of the cross streets.
  rect(road, -C, C, STREET.farZM, STREET.nearZM, 0);
  // Gaps in the pavements where the cross streets' carriageways run through.
  const gaps = STREET.crossings.map((c) => ({ z0: c.zM - crossRoadHalf(c.widthM), z1: c.zM + crossRoadHalf(c.widthM), c })).sort((a, b) => b.z1 - a.z1);
  for (const side of [-1, 1] as const) {
    let zTop: number = STREET.nearZM;
    const segs: [number, number][] = [];
    for (const g of gaps) {
      segs.push([g.z1, zTop]);
      zTop = g.z0;
    }
    segs.push([STREET.farZM, zTop]);
    const xa = side * C;
    const xb = side * F;
    for (const [z0, z1] of segs) {
      rect(pave, Math.min(xa, xb), Math.max(xa, xb), z0, z1, H);
      face(new Vector3(xa, 0, z0), new Vector3(xa, 0, z1), new Vector3(-side, 0, 0));
    }
    for (const g of gaps) {
      const xo = side * (F + CROSS_REACH_M);
      // The cross street's road, and its pavements from the boulevard's kerb line outward.
      rect(road, Math.min(xa, xo), Math.max(xa, xo), g.z0, g.z1, 0);
      for (const [z0, z1, e] of [[g.z1, g.c.zM + g.c.widthM / 2, 1], [g.c.zM - g.c.widthM / 2, g.z0, -1]] as const) {
        rect(pave, Math.min(side * F, xo), Math.max(side * F, xo), z0, z1, H);
        const zk = e > 0 ? z0 : z1;
        face(new Vector3(xa, 0, zk), new Vector3(xo, 0, zk), new Vector3(0, 0, -e));
      }
    }
  }
  const group = new Group();
  group.name = 'street';
  for (const [b, mat, name] of [
    [road, roadMaterial(), 'carriageway'],
    [pave, pavementMaterial(), 'pavements'],
    [kerb, granite(), 'kerbs'],
  ] as const) {
    const m = new Mesh(b.build(name), mat);
    m.name = name;
    m.receiveShadow = true;
    group.add(m);
  }
  return group;
}
