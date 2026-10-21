import { attribute } from 'three/tsl';
import { BoxGeometry, BufferAttribute, type BufferGeometry, Color, CylinderGeometry, Group, Mesh, MeshStandardNodeMaterial, PlaneGeometry, Vector3 } from 'three/webgpu';
import { STREET } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { merge, tube } from '../render/meshkit.ts';

// What lies beyond the modelled street, seen only through the evening haze:
// the boulevard running on between plain blocks (stone fronts under zinc
// roofs, a few hundred triangles each), the ground out to the horizon, and the
// iron tower on the Champ-de-Mars 2.4 km away — its four legs, the arches
// between them, the platforms and the shaft — a silhouette in the haze, as it
// is from the boulevards at this hour.

export function buildSkyline(): Group {
  const g = new Group();
  g.name = 'skyline';
  const r = new Rng(77);
  const stone: BufferGeometry[] = [];
  const zinc: BufferGeometry[] = [];
  // The boulevard beyond the modelled part, and blocks on either side out to the haze.
  for (const side of [-1, 1]) {
    for (let z = STREET.farZM; z > -2600; ) {
      const len = r.range(14, 30);
      const h = r.range(17, 22);
      const depth = 14;
      stone.push(new BoxGeometry(depth, h, len - 0.2).translate(side * (STREET.facadeHalfM + depth / 2), h / 2, z - len / 2));
      zinc.push(mansard(len, depth, h).translate(side * (STREET.facadeHalfM + depth / 2), 0, z - len / 2));
      z -= len + (r.next() < 0.08 ? 14 : 0);
    }
  }
  // Behind the street fronts, more roofs to make a roofscape, as seen down cross streets.
  for (let i = 0; i < 260; i++) {
    const x = (r.next() < 0.5 ? -1 : 1) * r.range(32, 420);
    const z = r.range(-2600, 60);
    if (STREET.crossings.some((c) => Math.abs(z - c.zM) < c.widthM / 2 + 22)) continue;
    const len = r.range(14, 40);
    const h = r.range(16, 24);
    stone.push(new BoxGeometry(14, h, len).translate(x, h / 2, z));
    zinc.push(mansard(len, 14, h).translate(x, 0, z));
  }
  const stoneMesh = new Mesh(painted(merge(stone, 'far stone'), 0xb9ab90), flat());
  const zincMesh = new Mesh(painted(merge(zinc, 'far zinc'), 0x6e767d), flat());
  for (const m of [stoneMesh, zincMesh]) {
    m.receiveShadow = true;
    g.add(m);
  }
  const ground = new Mesh(painted(new PlaneGeometry(6000, 6000, 1, 1).rotateX(-Math.PI / 2).translate(0, -0.02, -1500), 0x5a5856), flat());
  ground.receiveShadow = true;
  g.add(ground);
  const tower = new Mesh(painted(towerGeometry(), 0x4a3c30), flat());
  tower.position.set(-150, 0, -2400);
  g.add(tower);
  return g;
}

/** A mansard roof over a block `len` long (along z) and `depth` deep, standing on height h. */
function mansard(len: number, depth: number, h: number): BufferGeometry {
  return new CylinderGeometry(depth * 0.3, depth * 0.5, 4.2, 4, 1).rotateY(Math.PI / 4).scale(1, 1, len / depth).translate(0, h + 2.1, 0);
}

/** The tower: 330 m to the tip; legs splayed 125 m apart at the ground, joining over the first platform. */
function towerGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    // Each leg curves in (the iconic profile is close to exponential), a square section ~25 m at the foot.
    const pts: Vector3[] = [];
    const radii: number[] = [];
    for (let k = 0; k <= 6; k++) {
      const y = (k / 6) * 115;
      const half = 62.5 * Math.exp(-y / 62);
      pts.push(new Vector3(sx * half * 0.85, y, sz * half * 0.85));
      radii.push(13 - k * 1.3);
    }
    parts.push(tube(pts, radii, 4, 10));
  }
  // The arches between the legs under the first platform, the platforms, the shaft and the tip.
  parts.push(new BoxGeometry(84, 7, 84).translate(0, 57, 0));
  parts.push(new BoxGeometry(44, 5, 44).translate(0, 115, 0));
  parts.push(new CylinderGeometry(4, 21, 165, 4, 6).rotateY(Math.PI / 4).translate(0, 117 + 82, 0));
  parts.push(new BoxGeometry(18, 6, 18).translate(0, 276, 0));
  parts.push(new CylinderGeometry(0.8, 3, 50, 6).translate(0, 304, 0));
  return merge(parts, 'tower');
}

function painted(g: BufferGeometry, hex: number): BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Color(hex);
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('tint', new BufferAttribute(a, 3));
  return g;
}

function flat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'far city', roughness: 0.85 });
  m.colorNode = attribute('tint', 'vec3');
  return m;
}
