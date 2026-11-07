import { BufferAttribute, type BufferGeometry, Color, ConeGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, MeshStandardNodeMaterial, Quaternion, SphereGeometry, Vector3 } from 'three/webgpu';
import { Rng } from '../core/rng.ts';
import { heightAt, LAGOON_CENTRE, normalAt, shoreDistance, surfaceAt } from '../game/terrain.ts';
import { markStaticInstances } from './instancing.ts';

// The wrack line: what the sea leaves at the top of the swash, after the
// beach in "Tidewater" (an AI-made three.js fishing game), whose sand reads as
// a real beach partly because it is not clean. Seaweed in dark, flattened
// clumps, shells, bleached twigs and the odd coconut husk lie in uneven heaps
// along the line the highest waves reach — just above the wet band — never in
// a tidy row. Placed once at load by walking round the lagoon and finding
// that line by bisection on the shore distance.

const BAND_M = 2.7;
const CLUSTERS = 90;

interface Kind {
  name: string;
  geometry: BufferGeometry;
  colours: number[];
  roughness: number;
  count: number;
  scale: [number, number];
  cast: boolean;
}

/** A lumpy, flattened blob: a seaweed clump. */
function seaweedGeometry(): BufferGeometry {
  const g = new SphereGeometry(1, 10, 6);
  const p = g.getAttribute('position') as BufferAttribute;
  const rng = new Rng(7);
  const bumps = Array.from({ length: 6 }, () => [rng.range(-1, 1), rng.range(-1, 1), rng.range(0.15, 0.45)] as const);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    let k = 1;
    for (const [bx, bz, a] of bumps) k += a * Math.exp(-((x - bx) ** 2 + (z - bz) ** 2) * 3);
    p.setXYZ(i, x * 0.22 * k, Math.max(p.getY(i), -0.2) * 0.035, z * 0.12 * k);
  }
  g.computeVertexNormals();
  return g;
}

export function buildWrack(): Group {
  const group = new Group();
  group.name = 'wrack line';
  const kinds: Kind[] = [
    { name: 'seaweed', geometry: seaweedGeometry(), colours: [0x3a3420, 0x2f2c1b, 0x4a3d22, 0x3c3a1e], roughness: 0.45, count: 0, scale: [0.6, 1.6], cast: false },
    { name: 'shell', geometry: new ConeGeometry(0.022, 0.055, 7).rotateZ(Math.PI / 2), colours: [0xe8e0d0, 0xd8c8b4, 0xf0e4dc, 0xc9b49a], roughness: 0.35, count: 0, scale: [0.7, 1.4], cast: false },
    { name: 'twig', geometry: new CylinderGeometry(0.012, 0.018, 1, 5).rotateZ(Math.PI / 2), colours: [0xb4aa98, 0x9c9282, 0xc8bfae], roughness: 0.85, count: 0, scale: [0.25, 0.9], cast: true },
    { name: 'husk', geometry: new SphereGeometry(0.1, 10, 7).scale(1, 0.85, 1.15), colours: [0x5a4128, 0x4a3520, 0x6b5233], roughness: 0.9, count: 0, scale: [0.8, 1.2], cast: true },
  ];
  // Where to put things: points on the high-water line, in clusters.
  const rng = new Rng(4141);
  const spots: { x: number; z: number; kind: number }[] = [];
  for (let c = 0; c < CLUSTERS; c++) {
    const a = rng.range(0, Math.PI * 2);
    const dir = { x: Math.sin(a), z: Math.cos(a) };
    // Bisect along the ray from the lagoon's middle for shoreDistance = BAND_M.
    let lo = 0;
    let hi = 160;
    if (shoreDistance(LAGOON_CENTRE.x + dir.x * hi, LAGOON_CENTRE.z + dir.z * hi) < BAND_M) continue;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (shoreDistance(LAGOON_CENTRE.x + dir.x * mid, LAGOON_CENTRE.z + dir.z * mid) < BAND_M) lo = mid;
      else hi = mid;
    }
    const cx = LAGOON_CENTRE.x + dir.x * lo;
    const cz = LAGOON_CENTRE.z + dir.z * lo;
    if (surfaceAt(cx, cz) !== 'sand') continue;
    // A heap strung along the line (across the ray), a little ragged in and out.
    const n = rng.int(4, 11);
    const spread = rng.range(0.8, 2.6);
    for (let k = 0; k < n; k++) {
      const t = rng.range(-1, 1) * spread;
      const x = cx + dir.z * t + dir.x * rng.range(-0.35, 0.45);
      const z = cz - dir.x * t + dir.z * rng.range(-0.35, 0.45);
      if (surfaceAt(x, z) !== 'sand') continue;
      const r = rng.next();
      spots.push({ x, z, kind: r < 0.5 ? 0 : r < 0.75 ? 1 : r < 0.92 ? 2 : 3 });
    }
  }
  for (const s of spots) (kinds[s.kind] as Kind).count++;
  const meshes = kinds.map((k) => {
    const mat = new MeshStandardNodeMaterial({ name: `wrack ${k.name}`, roughness: k.roughness, metalness: 0 });
    const im = markStaticInstances(new InstancedMesh(k.geometry, mat, Math.max(1, k.count)));
    im.name = `wrack ${k.name}`;
    im.count = 0;
    im.castShadow = k.cast;
    im.receiveShadow = true;
    group.add(im);
    return im;
  });
  const m = new Matrix4();
  const q = new Quaternion();
  const qy = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const n = new Vector3();
  const pos = new Vector3();
  const scl = new Vector3();
  const col = new Color();
  const nrm = { x: 0, y: 1, z: 0 };
  for (const s of spots) {
    const k = kinds[s.kind] as Kind;
    const im = meshes[s.kind] as InstancedMesh;
    normalAt(s.x, s.z, nrm);
    n.set(nrm.x, nrm.y, nrm.z);
    q.setFromUnitVectors(up, n);
    qy.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
    q.multiply(qy);
    const sc = rng.range(k.scale[0], k.scale[1]);
    // Twigs are unit-length rods: scale their length alone.
    if (k.name === 'twig') scl.set(sc, 1, 1);
    else scl.set(sc, sc, sc);
    const sink = k.name === 'husk' ? 0.05 : k.name === 'twig' ? 0.005 : 0.0;
    pos.set(s.x, heightAt(s.x, s.z) + 0.004 - sink, s.z);
    m.compose(pos, q, scl);
    im.setMatrixAt(im.count, m);
    im.setColorAt(im.count, col.setHex(k.colours[rng.int(0, k.colours.length - 1)] as number));
    im.count++;
  }
  for (const im of meshes) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
  return group;
}
