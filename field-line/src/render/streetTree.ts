import { BufferAttribute, type BufferGeometry, Vector3 } from 'three/webgpu';
import { indexed, merge, rand, tube } from './meshkit.ts';

// A city street tree (a lime or plane of ~8 m) built like one: a trunk that
// forks into four or five limbs at about head-and-a-half height, each limb
// splitting into branches, and the foliage as clusters of crossed leaf cards
// at the branch ends and along their outer halves — so the crown has gaps,
// lobes and an irregular outline, and light comes through it. Card normals are
// bent away from the crown's centre (the usual foliage trick) so the crown
// shades as one volume. The old version was a pair of icosahedra.
//
// Unit: metres, base at y = 0. Every vertex carries `sway` (0 on the trunk, up
// to 1 at the crown's edge) for the wind shader (foliage.ts swayingMaterial).

export interface StreetTreeGeometry {
  wood: BufferGeometry;
  leaves: BufferGeometry;
}

const CROWN_CENTRE = new Vector3(0, 5.6, 0);

export function streetTreeGeometry(seed: number): StreetTreeGeometry {
  let k = 0;
  const r = (): number => rand(seed, k++);
  const wood: BufferGeometry[] = [];
  const cards: number[][] = [[], [], [], []]; // pos, nor, uv, idx
  const forkY = 2.4 + r() * 0.5;
  const lean = new Vector3((r() - 0.5) * 0.25, 1, (r() - 0.5) * 0.25).normalize();
  const trunkTop = lean.clone().multiplyScalar(forkY);
  wood.push(tube([new Vector3(0, -0.2, 0), new Vector3(0, 0.8, 0).lerp(trunkTop, 0.35), trunkTop], [0.2, 0.15, 0.13], 10, 1.2));

  const limbs = 4 + Math.floor(r() * 2);
  for (let i = 0; i < limbs; i++) {
    const az = (i / limbs) * Math.PI * 2 + r() * 0.6;
    const elev = 0.75 + r() * 0.45; // rad above horizontal
    const dir = new Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const len = 2.4 + r() * 0.9;
    const mid = trunkTop.clone().addScaledVector(dir, len * 0.5).add(new Vector3(0, 0.15, 0));
    const tip = trunkTop.clone().addScaledVector(dir, len).add(new Vector3(0, -0.1, 0));
    wood.push(tube([trunkTop, mid, tip], [0.1, 0.07, 0.035], 7, 1.2, true));
    leafCluster(cards, tip, 2.0 + r() * 0.5, r);
    // Branches off the limb's outer half, spreading out and up.
    const branches = 3;
    for (let j = 0; j < branches; j++) {
      const t = 0.45 + (j / branches) * 0.45 + r() * 0.08;
      const from = trunkTop.clone().lerp(tip, t).add(new Vector3(0, Math.sin(t * Math.PI) * 0.12, 0));
      const baz = az + (r() - 0.5) * 2.2;
      const bel = 0.2 + r() * 0.8;
      const bdir = new Vector3(Math.cos(baz) * Math.cos(bel), Math.sin(bel), Math.sin(baz) * Math.cos(bel));
      const blen = 1.1 + r() * 0.8;
      const bend = from.clone().addScaledVector(bdir, blen);
      wood.push(tube([from, from.clone().addScaledVector(bdir, blen * 0.5).add(new Vector3(0, 0.08, 0)), bend], [0.04, 0.025, 0.012], 5, 1.2, true));
      leafCluster(cards, bend, 1.8 + r() * 0.5, r);
      leafCluster(cards, from.clone().lerp(bend, 0.5), 1.5 + r() * 0.4, r);
      leafCluster(cards, bend.clone().add(new Vector3((r() - 0.5) * 0.8, 0.5 + r() * 0.4, (r() - 0.5) * 0.8)), 1.6, r);
    }
  }
  // Fill the crown's volume (an ellipsoid round the limbs), biased to its surface, so it reads as a dense
  // rounded lime crown rather than tufts on sticks.
  for (let i = 0; i < 30; i++) {
    const a = r() * Math.PI * 2;
    const u = r() * 2 - 1;
    const rad = Math.pow(r(), 0.4);
    const s = Math.sqrt(1 - u * u);
    const p = new Vector3(Math.cos(a) * s * 3.0 * rad, CROWN_CENTRE.y + u * 2.3 * rad, Math.sin(a) * s * 3.0 * rad);
    leafCluster(cards, p, 1.6 + r() * 0.6, r);
  }
  const leaves = indexed(cards[0] as number[], cards[1] as number[], cards[2] as number[], cards[3] as number[]);
  const woodGeo = merge(wood, 'street tree wood');
  return { wood: withSway(woodGeo), leaves: withSway(leaves) };
}

/**
 * One leaf cluster: three crossed cards around `c`, each turned at random so neighbours never align,
 * normals bent outward from the crown's centre.
 */
function leafCluster(out: number[][], c: Vector3, sizeM: number, r: () => number): void {
  const [pos, nor, uv, idx] = out as [number[], number[], number[], number[]];
  const outward = c.clone().sub(CROWN_CENTRE).multiply(new Vector3(1, 0.8, 1)).normalize();
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const spin = r() * Math.PI;
  const tilt = (r() - 0.5) * 0.8;
  for (let k = 0; k < 3; k++) {
    const ax = (axes[k] as Vector3).clone().applyAxisAngle(new Vector3(0, 1, 0), spin).applyAxisAngle(new Vector3(1, 0, 0), tilt);
    const e1 = new Vector3().crossVectors(ax, k === 1 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize().multiplyScalar(sizeM / 2);
    const e2 = new Vector3().crossVectors(ax, e1).normalize().multiplyScalar(sizeM / 2);
    const base = pos.length / 3;
    const corners = [c.clone().sub(e1).sub(e2), c.clone().add(e1).sub(e2), c.clone().add(e1).add(e2), c.clone().sub(e1).add(e2)];
    const uvs = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    corners.forEach((p, i) => {
      pos.push(p.x, p.y, p.z);
      // Bent normal: mostly the crown's outward direction, a little of the card's own.
      const n = ax.clone().multiplyScalar(ax.dot(outward) < 0 ? -0.35 : 0.35).add(outward).normalize();
      nor.push(n.x, n.y, n.z);
      const u = uvs[i] as number[];
      uv.push(u[0] as number, u[1] as number);
    });
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** `sway` per vertex: none on the trunk, growing with height and distance from the axis. */
function withSway(g: BufferGeometry): BufferGeometry {
  const p = g.getAttribute('position');
  const s = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const radial = Math.hypot(p.getX(i), p.getZ(i));
    s[i] = Math.min(1, Math.max(0, (y - 2.6) / 4) * 0.6 + Math.min(1, radial / 3.5) * 0.4) * (y > 2.4 ? 1 : 0);
  }
  g.setAttribute('sway', new BufferAttribute(s, 1));
  return g;
}
