import { attribute, float, fract, max, mix, normalWorld, positionLocal, positionWorld, sin, smoothstep, step, texture, uv, vec2, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, CanvasTexture, DoubleSide, Group, InstancedMesh, Matrix4, MeshStandardNodeMaterial, Quaternion, SRGBColorSpace, Vector3 } from 'three/webgpu';
import { Rng } from '../core/rng.ts';
import { indexed, merge, tube } from '../render/meshkit.ts';
import { fbm2, linearRgb, SCENE, vnoise2 } from '../render/nodes.ts';
import type { Placed } from './plan.ts';

// The boulevard's London planes (Platanus × acerifolia, the Paris street tree):
// a straight trunk of mottled bark — cream, olive and grey where the old bark
// flakes off in plates — forking at 3–4 m into a few long ascending limbs,
// pruned high off the street. Late October: the crown thinning, its leaves
// gone from green to yellow and rust, the evening sun showing through it.
//
// The crown is clusters of crossed leaf cards (a canvas of palmate leaves with
// alpha) at the branch ends and through the crown's volume; the card normals
// bend outward from its centre so it shades as one volume. Six variants,
// instanced. Every vertex carries `sway` for the breeze.

const VARIANTS = 6;
const CROWN_Y = 10.5;

export function buildTrees(trees: readonly Placed[]): Group {
  const group = new Group();
  group.name = 'plane trees';
  const leafTex = leafTexture(7);
  const bark = barkMaterial();
  const leaves = leafMaterial(leafTex);
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  for (let v = 0; v < VARIANTS; v++) {
    const geo = planeTree(1000 + v * 77);
    const mine = trees.filter((t) => t.seed % VARIANTS === v);
    if (mine.length === 0) continue;
    const wood = new InstancedMesh(geo.wood, bark, mine.length);
    const crown = new InstancedMesh(geo.leaves, leaves, mine.length);
    mine.forEach((t, i) => {
      const r = new Rng(t.seed);
      q.setFromAxisAngle(new Vector3(0, 1, 0), r.next() * Math.PI * 2);
      const k = r.range(0.9, 1.1);
      s.set(k, k * r.range(0.95, 1.08), k);
      m.compose(new Vector3(t.x, 0.14, t.z), q, s);
      wood.setMatrixAt(i, m);
      crown.setMatrixAt(i, m);
    });
    for (const mesh of [wood, crown]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
  return group;
}

interface TreeGeometry {
  wood: BufferGeometry;
  leaves: BufferGeometry;
}

/** One plane tree, base at y = 0, ~14 m tall. */
function planeTree(seed: number): TreeGeometry {
  const r = new Rng(seed);
  const wood: BufferGeometry[] = [];
  const cards: number[][] = [[], [], [], []];
  const forkY = 3.4 + r.next() * 0.8;
  const lean = new Vector3((r.next() - 0.5) * 0.08, 1, (r.next() - 0.5) * 0.08).normalize();
  const top = lean.clone().multiplyScalar(forkY);
  wood.push(tube([new Vector3(0, -0.1, 0), new Vector3(0, 0.25, 0), new Vector3(0, 1.6, 0).lerp(top, 0.4), top], [0.36, 0.3, 0.25, 0.22], 14, 1.5));
  const centre = new Vector3(0, CROWN_Y, 0);
  const limbs = 4 + r.int(2);
  for (let i = 0; i < limbs; i++) {
    const az = (i / limbs) * Math.PI * 2 + r.next() * 0.7;
    const elev = 0.95 + r.next() * 0.35;
    const dir = new Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const len = 5.5 + r.next() * 2;
    const mid = top.clone().addScaledVector(dir, len * 0.5).add(new Vector3(0, 0.3, 0));
    const tip = top.clone().addScaledVector(dir, len);
    wood.push(tube([top, mid, tip], [0.16, 0.11, 0.05], 9, 1.5, true));
    for (let j = 0; j < 4; j++) {
      const t = 0.35 + j * 0.17 + r.next() * 0.08;
      const from = top.clone().lerp(tip, t);
      const baz = az + (r.next() - 0.5) * 2.4;
      const bel = 0.15 + r.next() * 0.9;
      const bdir = new Vector3(Math.cos(baz) * Math.cos(bel), Math.sin(bel), Math.sin(baz) * Math.cos(bel));
      const blen = 2 + r.next() * 1.6;
      const end = from.clone().addScaledVector(bdir, blen);
      wood.push(tube([from, from.clone().addScaledVector(bdir, blen * 0.5).add(new Vector3(0, 0.15, 0)), end], [0.055, 0.035, 0.015], 5, 1.5, true));
      cluster(cards, end, 2.6 + r.next() * 0.8, r, centre);
      cluster(cards, from.clone().lerp(end, 0.55).add(new Vector3(0, 0.4, 0)), 2.2, r, centre);
    }
    cluster(cards, tip, 3, r, centre);
  }
  // The crown's volume, an ellipsoid round the limbs, its surface denser: thinned for the season.
  for (let i = 0; i < 46; i++) {
    const a = r.next() * Math.PI * 2;
    const u = r.next() * 2 - 1;
    const rad = Math.pow(r.next(), 0.35);
    const sq = Math.sqrt(1 - u * u);
    cluster(cards, new Vector3(Math.cos(a) * sq * 4.6 * rad, CROWN_Y + u * 3.4 * rad, Math.sin(a) * sq * 4.6 * rad), 2.3 + r.next() * 0.7, r, centre);
  }
  const leaves = indexed(cards[0] as number[], cards[1] as number[], cards[2] as number[], cards[3] as number[]);
  return { wood: withSway(merge(wood, 'plane wood')), leaves: withSway(leaves) };
}

/** Three crossed cards round `c`, turned at random, normals bent outward from the crown's centre. */
function cluster(out: number[][], c: Vector3, sizeM: number, r: Rng, centre: Vector3): void {
  const [pos, nor, uvs, idx] = out as [number[], number[], number[], number[]];
  const outward = c.clone().sub(centre).multiply(new Vector3(1, 0.7, 1)).normalize();
  const spin = r.next() * Math.PI;
  const tilt = (r.next() - 0.5) * 0.9;
  const tile = r.int(4);
  for (let k = 0; k < 3; k++) {
    const ax = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)][k] as Vector3;
    ax.applyAxisAngle(new Vector3(0, 1, 0), spin).applyAxisAngle(new Vector3(1, 0, 0), tilt);
    const e1 = new Vector3().crossVectors(ax, k === 1 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize().multiplyScalar(sizeM / 2);
    const e2 = new Vector3().crossVectors(ax, e1).normalize().multiplyScalar(sizeM / 2);
    const base = pos.length / 3;
    const corners = [c.clone().sub(e1).sub(e2), c.clone().add(e1).sub(e2), c.clone().add(e1).add(e2), c.clone().sub(e1).add(e2)];
    // Four leaf clusters on the canvas (2 × 2): each card takes one.
    const u0 = (tile % 2) * 0.5;
    const v0 = Math.floor(tile / 2) * 0.5;
    const tuv = [
      [u0, v0],
      [u0 + 0.5, v0],
      [u0 + 0.5, v0 + 0.5],
      [u0, v0 + 0.5],
    ];
    corners.forEach((p, i) => {
      pos.push(p.x, p.y, p.z);
      const n = ax.clone().multiplyScalar(ax.dot(outward) < 0 ? -0.3 : 0.3).add(outward).normalize();
      nor.push(n.x, n.y, n.z);
      const t = tuv[i] as number[];
      uvs.push(t[0] as number, t[1] as number);
    });
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function withSway(g: BufferGeometry): BufferGeometry {
  const p = g.getAttribute('position');
  const s = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    s[i] = Math.max(0, (y - 3.5) / 9) * Math.min(1, Math.hypot(p.getX(i), p.getZ(i)) / 4 + 0.3);
  }
  g.setAttribute('sway', new BufferAttribute(s, 1));
  return g;
}

/** A breeze: the crown's edge moving a few centimetres, gusting. */
function swayed() {
  const s = attribute('sway', 'float');
  const t = SCENE.time;
  const ph = positionLocal.x.mul(0.4).add(positionLocal.z.mul(0.3));
  const gust = sin(t.mul(0.7)).mul(0.5).add(1);
  return positionLocal.add(vec3(sin(t.mul(1.9).add(ph)), sin(t.mul(2.7).add(ph.mul(1.3))).mul(0.4), sin(t.mul(1.6).add(ph.mul(0.7)))).mul(s.mul(0.06).mul(gust)));
}

/** Plane bark: smooth, flaking in plates — cream where fresh, olive and grey where old. */
function barkMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'plane bark', roughness: 0.75 });
  const w = positionWorld;
  const p = vec2(w.x.add(w.z).mul(2.2), w.y.mul(1.1));
  const n1 = fbm2(p);
  const n2 = fbm2(p.mul(1.7).add(13));
  const olive = vec3(...linearRgb(0x7b7656));
  const cream = vec3(...linearRgb(0xc9c09a));
  const grey = vec3(...linearRgb(0x8d8a7e));
  const brown = vec3(...linearRgb(0x5e5547));
  let c = mix(olive, cream, smoothstep(0.5, 0.56, n1).mul(0.75));
  c = mix(c, grey, smoothstep(0.55, 0.6, n2).mul(0.8));
  c = mix(c, brown, smoothstep(0.62, 0.66, n2.mul(0.5).add(n1.mul(0.5))).mul(0.4));
  m.colorNode = c.mul(vnoise2(p.mul(9)).mul(0.2).add(0.85));
  m.positionNode = swayed();
  return m;
}

/** Leaves: the canvas's leaves tinted per tree and per card, a little light coming through toward the sun. */
function leafMaterial(map: CanvasTexture): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'plane leaves', side: DoubleSide, roughness: 0.7 });
  const tex = texture(map, uv());
  m.maskNode = tex.a.greaterThan(0.5);
  // Per card: how far into autumn (hashing the card's own position, stable under the sway).
  const turn = fract(sin(positionLocal.x.mul(12.9).add(positionLocal.z.mul(78.2)).add(positionLocal.y.mul(3.1))).mul(43758.5));
  const green = vec3(0.32, 0.36, 0.12);
  const gold = vec3(1.0, 0.72, 0.22);
  const rust = vec3(0.75, 0.38, 0.14);
  const tint = mix(mix(green, gold, smoothstep(0.1, 0.55, turn)), rust, smoothstep(0.7, 1, turn));
  const colour = tex.rgb.mul(tint);
  m.colorNode = colour;
  // Light through the leaf toward the sun (thin leaves transmit ~20 %): face the sun from behind and glow.
  const toward = max(normalWorld.dot(SCENE.sunDir).negate(), 0).add(0.25);
  m.emissiveNode = colour.mul(SCENE.leafSunNits).mul(toward).mul(step(0.5, tex.a)).mul(float(0.5));
  m.positionNode = swayed();
  return m;
}

/** Four clusters of palmate plane leaves on one canvas (2 × 2), colour variation baked in, alpha cut out. */
function leafTexture(seed: number): CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas for the leaf texture');
  const r = new Rng(seed);
  for (let tile = 0; tile < 4; tile++) {
    const ox = (tile % 2) * (S / 2);
    const oy = Math.floor(tile / 2) * (S / 2);
    // Twigs, then ~26 leaves on them.
    ctx.strokeStyle = '#4a3a2a';
    ctx.lineWidth = 2;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(ox + S / 4, oy + S / 4);
      ctx.lineTo(ox + S / 4 + (r.next() - 0.5) * S * 0.4, oy + S / 4 + (r.next() - 0.5) * S * 0.4);
      ctx.stroke();
    }
    for (let i = 0; i < 58; i++) {
      const rad = Math.sqrt(r.next()) * S * 0.21;
      const a = r.next() * Math.PI * 2;
      const x = ox + S / 4 + Math.cos(a) * rad;
      const y = oy + S / 4 + Math.sin(a) * rad;
      const l = r.range(8, 13);
      const k = r.range(0.72, 1.0);
      const g = Math.round(200 * k);
      ctx.fillStyle = `rgb(${g},${Math.round(g * r.range(0.86, 0.98))},${Math.round(g * r.range(0.7, 0.85))})`;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(r.next() * Math.PI * 2);
      ctx.scale(1, r.range(0.55, 1));
      // A five-lobed blade.
      ctx.beginPath();
      for (let j = 0; j <= 40; j++) {
        const t = (j / 40) * Math.PI * 2;
        const rr = l * (0.62 + 0.38 * Math.pow(Math.abs(Math.cos(t * 2.5)), 0.6));
        const px = Math.cos(t) * rr;
        const py = Math.sin(t) * rr * 0.95;
        if (j === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `rgba(80,60,30,0.5)`;
      ctx.lineWidth = 1;
      for (let j = 0; j < 5; j++) {
        const t = (j / 5) * Math.PI * 2 + Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(t) * l * 0.85, Math.sin(t) * l * 0.85);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
