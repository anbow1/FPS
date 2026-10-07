import * as THREE from 'three/webgpu';
import { Rng } from '../core/rng';

/**
 * Card-based trees: branches are alpha-tested quads carrying procedurally painted needle sprays
 * or leaf clusters (sheet: pine foliage #3C4A2E, alpha-clip; bark #4A3B30). Normals are bent
 * towards the crown's outside so a crown shades as one volume while each card keeps its detail.
 */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function finishTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const hex = (r: number, g: number, b: number) => `rgb(${r | 0},${g | 0},${b | 0})`;

/** A conifer branch spray seen from above: twig along +u, side twigs, dense needles. */
export function makeNeedleTexture(seed: number): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const [c, ctx] = canvas(W, H);
  const rng = new Rng(seed);
  ctx.lineCap = 'round';
  const needle = (x: number, y: number, ang: number, len: number) => {
    const k = rng.range(0.75, 1.25);
    ctx.strokeStyle = hex(0x2e * k, 0x3d * k, 0x22 * k);
    if (rng.next() < 0.25) ctx.strokeStyle = hex(0x4a * k, 0x5c * k, 0x34 * k);
    ctx.lineWidth = rng.range(1.2, 2.0);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  };
  const twig = (x0: number, y0: number, ang: number, len: number, depth: number) => {
    const steps = Math.max(4, Math.floor(len / 4));
    let x = x0;
    let y = y0;
    let a = ang;
    ctx.strokeStyle = '#4a3b2a';
    ctx.lineWidth = depth === 0 ? 3 : 1.6;
    for (let i = 0; i < steps; i++) {
      const nx = x + Math.cos(a) * (len / steps);
      const ny = y + Math.sin(a) * (len / steps);
      ctx.strokeStyle = '#4a3b2a';
      ctx.lineWidth = depth === 0 ? 3 * (1 - i / steps) + 1 : 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      const f = 1 - i / steps;
      const nl = (depth === 0 ? 11 : 8) * (0.55 + 0.45 * f);
      for (const s of [-1, 1]) for (let k = 0; k < 2; k++) needle(nx, ny, a + s * rng.range(0.7, 1.2), nl * rng.range(0.8, 1.1));
      if (depth === 0 && i % 3 === 1 && i < steps - 2) {
        for (const s of [-1, 1]) twig(nx, ny, a + s * rng.range(0.55, 0.9), len * 0.42 * f + 8, 1);
      }
      x = nx;
      y = ny;
      a += rng.range(-0.06, 0.06);
    }
  };
  twig(4, H / 2, 0, W - 18, 0);
  return finishTexture(c);
}

/** A cluster of broad leaves for deciduous crowns (fresh grass green from the sheet as base). */
export function makeLeafTexture(seed: number): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const rng = new Rng(seed);
  for (let i = 0; i < 170; i++) {
    const r = Math.sqrt(rng.next()) * S * 0.44;
    const a = rng.next() * Math.PI * 2;
    const x = S / 2 + Math.cos(a) * r;
    const y = S / 2 + Math.sin(a) * r;
    const k = rng.range(0.7, 1.35) * (1 - (r / S) * 0.3);
    const yellow = rng.next() < 0.15 ? 1.25 : 1;
    ctx.fillStyle = hex(0x4a * k * yellow, 0x60 * k, 0x30 * k);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng.next() * Math.PI * 2);
    const l = rng.range(9, 15);
    ctx.beginPath();
    ctx.ellipse(0, 0, l, l * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hex(0x3a * k, 0x4a * k, 0x22 * k);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-l, 0);
    ctx.lineTo(l, 0);
    ctx.stroke();
    ctx.restore();
  }
  return finishTexture(c);
}

/** Bark: vertical furrows and plates, U around the trunk, V along it. */
export function makeBarkTexture(seed: number, light = false): THREE.CanvasTexture {
  const W = 128;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  const img = ctx.createImageData(W, H);
  const rng = new Rng(seed);
  const cols = 14;
  const phase = Array.from({ length: cols }, () => rng.next() * 10);
  const base = light ? [0xc9, 0xc4, 0xb8] : [0x4a, 0x3b, 0x30];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W) * cols;
      const ci = Math.floor(u);
      const f = u - ci;
      const wob = Math.sin(y * 0.05 + phase[ci % cols]!) * 0.12;
      const furrow = Math.min(1, Math.abs(f - 0.5 + wob) * 2.4);
      const plate = Math.sin((y + phase[ci % cols]! * 40) * 0.09) > 0.85 ? 0.75 : 1;
      let k = (0.45 + 0.65 * furrow) * plate * rng.range(0.9, 1.1);
      if (light && rng.next() < 0.004) k = 0.15; // birch lenticels
      const o = (y * W + x) * 4;
      img.data[o] = base[0]! * k;
      img.data[o + 1] = base[1]! * k;
      img.data[o + 2] = base[2]! * k;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (light) {
    // dark horizontal birch marks
    ctx.fillStyle = 'rgba(30,28,26,0.85)';
    for (let i = 0; i < 26; i++) ctx.fillRect(rng.next() * W, rng.next() * H, rng.range(6, 26), rng.range(1.5, 4));
  }
  const t = finishTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

interface Builder {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Quad with corners p0..p3, uvs (0,0)(1,0)(1,1)(0,1); normals bent towards `outward`. */
function quad(b: Builder, p: THREE.Vector3[], outward: (v: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3, ao: number[], bend: number): void {
  _a.subVectors(p[1]!, p[0]!);
  _b.subVectors(p[3]!, p[0]!);
  _n.crossVectors(_a, _b).normalize();
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const v = p[i]!;
    b.pos.push(v.x, v.y, v.z);
    outward(v, _c);
    // face normal facing the outside, then blended to the crown's radial direction
    _d.copy(_n);
    if (_d.dot(_c) < 0) _d.negate();
    _d.lerp(_c, bend).normalize();
    b.nrm.push(_d.x, _d.y, _d.z);
    b.uv.push(uvs[i]![0]!, uvs[i]![1]!);
    b.col.push(ao[i]!, ao[i]!, ao[i]!);
  }
}

function toGeometry(b: Builder): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.computeBoundingSphere();
  return g;
}

function trunkGeometry(height: number, r0: number, r1: number, barkRepeat: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, height, 9, 6, true);
  // gentle lean and taper noise so trunks are not perfect cylinders
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / height + 0.5;
    p.setX(i, p.getX(i) + Math.sin(y * 3.1) * r0 * 0.25);
    p.setZ(i, p.getZ(i) + Math.cos(y * 2.3) * r0 * 0.2);
  }
  g.translate(0, height / 2, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * barkRepeat);
  g.computeVertexNormals();
  const col = new Float32Array(p.count * 3).fill(1);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Spruce/pine: branch whorls of crossed needle cards around a straight trunk, conical crown. */
export function coniferGeometry(rng: Rng, height: number, lite = false): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry } {
  const b: Builder = { pos: [], nrm: [], uv: [], col: [] };
  const y0 = height * rng.range(0.16, 0.3);
  const whorls = lite ? 8 : 10;
  const axis = new THREE.Vector3();
  const outward = (v: THREE.Vector3, out: THREE.Vector3) => out.set(v.x, (v.y - height * 0.55) * 0.35, v.z).normalize().add(axis.set(0, 0.45, 0)).normalize();
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y = y0 + (height - y0) * Math.pow(t, 0.92);
    const R = Math.pow(1 - t, 1.05) * height * 0.27 + 0.35;
    const n = Math.max(3, 6 - Math.floor(t * 3));
    const off = rng.next() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = off + (k / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const len = R * rng.range(0.85, 1.15);
      const droop = -0.28 + t * 0.45 + rng.range(-0.1, 0.1);
      const dir = new THREE.Vector3(Math.cos(a) * Math.cos(droop), Math.sin(droop), Math.sin(a) * Math.cos(droop));
      const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      const width = Math.max(0.5, len * 0.5) * (lite ? 1.45 : 1);
      const base = new THREE.Vector3(Math.cos(a) * 0.08, y, Math.sin(a) * 0.08);
      const tip = base.clone().addScaledVector(dir, len);
      // two cards per branch: one flat, one rolled up — reads full from any angle
      const rolls = lite ? [0.55 + rng.range(-0.2, 0.2)] : [rng.range(-0.2, 0.2), 1.1 + rng.range(-0.2, 0.2)];
      for (const roll of rolls) {
        const across = side.clone().applyAxisAngle(dir, roll).multiplyScalar(width / 2);
        const sag = new THREE.Vector3(0, -len * 0.08, 0);
        const p = [base.clone().sub(across), tip.clone().add(sag).sub(across), tip.clone().add(sag).add(across), base.clone().add(across)];
        const inner = 0.5 + 0.2 * t;
        quad(b, p, outward, [inner, 1, 1, inner], 0.55);
      }
    }
  }
  // leader at the very top
  for (const a of [0, Math.PI / 2]) {
    const s = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.45);
    const top = height * 1.02;
    const bot = height * 0.9;
    const p = [new THREE.Vector3(0, bot, 0).sub(s), new THREE.Vector3(0, top, 0).sub(s), new THREE.Vector3(0, top, 0).add(s), new THREE.Vector3(0, bot, 0).add(s)];
    // UV rotated so the twig runs up the card
    quad(b, [p[0]!, p[3]!, p[2]!, p[1]!], outward, [0.8, 0.8, 1, 1], 0.5);
  }
  return { trunk: trunkGeometry(height * 0.96, height * 0.022, height * 0.006, height / 2.2), crown: toGeometry(b) };
}

/** Broadleaf (birch/aspen type): forked trunk, crown of leaf-cluster cards on an ellipsoid. */
export function broadleafGeometry(rng: Rng, height: number, lite = false): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry } {
  const b: Builder = { pos: [], nrm: [], uv: [], col: [] };
  const cy = height * 0.66;
  const rx = height * 0.26;
  const ry = height * 0.3;
  const centre = new THREE.Vector3(0, cy, 0);
  const outward = (v: THREE.Vector3, out: THREE.Vector3) => out.copy(v).sub(centre).multiply(new THREE.Vector3(1 / rx, 1 / ry, 1 / rx)).normalize();
  const clusters = lite ? 16 : 26;
  for (let i = 0; i < clusters; i++) {
    // points spread over the crown volume, biased to the surface
    const u = rng.next() * 2 - 1;
    const a = rng.next() * Math.PI * 2;
    const r = Math.pow(rng.next(), 0.35);
    const s = Math.sqrt(1 - u * u);
    const c = new THREE.Vector3(Math.cos(a) * s * rx * r, u * ry * r * 0.85 + cy, Math.sin(a) * s * rx * r);
    const size = height * rng.range(0.16, 0.22) * (lite ? 1.2 : 1);
    const rot = rng.next() * Math.PI;
    const depth = r; // inner clusters darker
    for (let k = 0; k < 3; k++) {
      const ax = k === 0 ? new THREE.Vector3(1, 0, 0) : k === 1 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const e1 = new THREE.Vector3().crossVectors(ax, k === 1 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
      const e2 = new THREE.Vector3().crossVectors(ax, e1).normalize();
      e1.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).multiplyScalar(size / 2);
      e2.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).multiplyScalar(size / 2);
      const p = [c.clone().sub(e1).sub(e2), c.clone().add(e1).sub(e2), c.clone().add(e1).add(e2), c.clone().sub(e1).add(e2)];
      const ao = 0.45 + 0.55 * depth * (0.7 + 0.3 * (c.y - cy + ry) / (2 * ry));
      quad(b, p, outward, [ao, ao, ao, ao], 0.8);
    }
  }
  const trunk = trunkGeometry(height * 0.72, height * 0.03, height * 0.012, height / 2.5);
  // two main limbs into the crown
  const limbs: THREE.BufferGeometry[] = [trunk];
  for (let i = 0; i < 3; i++) {
    const l = new THREE.CylinderGeometry(height * 0.006, height * 0.012, height * 0.32, 6, 1, true);
    l.translate(0, height * 0.16, 0);
    l.rotateZ(rng.range(0.35, 0.6));
    l.rotateY((i / 3) * Math.PI * 2 + rng.next());
    l.translate(0, height * 0.45, 0);
    l.setAttribute('color', new THREE.BufferAttribute(new Float32Array(l.getAttribute('position').count * 3).fill(0.85), 3));
    limbs.push(l);
  }
  const merged = mergeKeepAll(limbs);
  return { trunk: merged, crown: toGeometry(b) };
}

function mergeKeepAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  for (const p0 of parts) {
    const p = p0.index ? p0.toNonIndexed() : p0;
    pos.push(...(p.getAttribute('position').array as Float32Array));
    nrm.push(...(p.getAttribute('normal').array as Float32Array));
    uv.push(...(p.getAttribute('uv').array as Float32Array));
    col.push(...(p.getAttribute('color').array as Float32Array));
  }
  return toGeometry({ pos, nrm, uv, col });
}
