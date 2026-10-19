import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color, float, mix, mx_noise_float, positionLocal, texture } from 'three/tsl';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  Matrix4,
  Mesh,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { AircraftId } from '../config.ts';
import { bakeAmbientOcclusion } from './aoBake.ts';
import { handData, type HandPose, posedHandGeometry } from './handMesh.ts';

// The pilot's office as a modelled place (cockpit.ts drives its displays and
// the HUD clip). What a few boxes lacked against the reference footage of a
// fighter cockpit:
//
//   - a closed tub — walls, floor, footwell, bulkheads — so no look round finds
//     the desert through it;
//   - canopy sills as rails with rows of bolt heads, catching the sun along
//     their edges: they frame the view out;
//   - a padded glare shield with a stitched lip, the HUD on it (projector, a
//     tall frame, the tinted combiner) and the keypad under it;
//   - the panel as panels: display bezels with push-buttons and rockers, round
//     standby instruments behind glass, warning tiles, the gear handle, seams
//     and Dzus fasteners, legends printed on every face;
//   - switch-panel consoles, the throttle and the side stick, the pilot's legs;
//   - every edge bevelled (a box's knife edge catches no light), the large
//     faces tessellated and the whole baked for ambient occlusion at 2 cm, so
//     the tub is dark where it is deep; the sun's shadow map, drawn tight round
//     the cockpit in the seat views (lighting.ts), casts the rest.
//
// Frame: metres from the eye, x right, y up, −z forward. The panel is laid out
// in its own frame (x across, y up its face, z out toward the pilot) and
// carried into the office's by one matrix; every part ends in a merged mesh
// per material.

/** Where a display goes on the panel (panel frame, m) and which part of the display canvas it shows. */
export interface DisplaySlot {
  w: number;
  h: number;
  x: number;
  y: number;
  u0: number;
  u1: number;
}

export interface OfficeModel {
  group: Group;
  /** The combiner glass corners in the office frame (the HUD clips to them), or null with a helmet display. */
  combiner: Vector3[] | null;
  /** The side stick with the right hand and arm on it, pivoting at its base (tilt it for the stick's input). */
  stick: Group;
  /** The throttle grip with the left hand and arm on it (slide it along z for the throttle). */
  throttle: Group;
}

/**
 * Pixels per metre of the printed faces, finest first: 2 px/mm for dials and key tops (a 4 mm legend is
 * 8 px before the mips), less for the larger faces, least for the bare panel behind them.
 */
const PX_PER_M = 2000;
const PX_FACES = 1500;
const PX_CONSOLE = 1200;
const PX_BACKING = 600;
const ATLAS_PX = 2048;
/** The panel's centre in the office frame and its lean (top away from the pilot). */
const PANEL_AT = new Vector3(0, -0.54, -0.775);
const PANEL_LEAN_RAD = -0.24;

// ------------------------------------------------------------------ materials

/** Sprayed cockpit paint: matte, a little uneven, as a real finish is. */
function paint(name: string, hex: number, roughness: number, metalness = 0): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, roughness, metalness });
  const n = mx_noise_float(positionLocal.mul(23)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionLocal.mul(310)).mul(0.5).add(0.5);
  m.colorNode = color(hex).mul(float(0.9).add(n.mul(0.14)).add(fine.mul(0.05)));
  m.roughnessNode = float(roughness).add(fine.sub(0.5).mul(0.1));
  return m;
}

// ------------------------------------------------------------------ geometry helpers

function roundedRect(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x0 = -w / 2;
  const y0 = -h / 2;
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-5, h / 2 - 1e-5));
  s.moveTo(x0 + rr, y0);
  s.lineTo(x0 + w - rr, y0);
  if (rr > 0) s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + rr);
  s.lineTo(x0 + w, y0 + h - rr);
  if (rr > 0) s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - rr, y0 + h);
  s.lineTo(x0 + rr, y0 + h);
  if (rr > 0) s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - rr);
  s.lineTo(x0, y0 + rr);
  if (rr > 0) s.quadraticCurveTo(x0, y0, x0 + rr, y0);
  return s;
}

/**
 * A box (w across x, h up y, d along z, centred) with its edges rounded by a bevel: smooth normals across
 * the bevel, hard between the faces — a line of light on every edge.
 */
function rbox(w: number, h: number, d: number, bevel = Math.min(w, h, d) * 0.2, corner = 0): BufferGeometry {
  const b = Math.max(0, Math.min(bevel, d / 2.2, w / 4, h / 4));
  const depth = Math.max(1e-4, d - 2 * b);
  const g = new ExtrudeGeometry(roundedRect(w - 2 * b, h - 2 * b, corner), { depth, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 3 });
  g.translate(0, 0, -depth / 2);
  return toCreasedNormals(g, Math.PI / 5);
}

/** A box finely divided, for the large faces: per-vertex occlusion needs vertices across them. */
function slab(w: number, h: number, d: number): BufferGeometry {
  const seg = (v: number): number => Math.max(1, Math.round(v / 0.04));
  return new BoxGeometry(w, h, d, seg(w), seg(h), seg(d));
}

/** Rotates (x, y, z order, rad) then moves a geometry; returns it. */
function at(g: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): BufferGeometry {
  const m = new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz, 'XYZ'));
  m.setPosition(x, y, z);
  return g.applyMatrix4(m);
}

/** A rail of rounded-rectangle section (w across, h up) along a path, its section kept upright. */
function rail(points: Vector3[], w: number, h: number, segments: number): BufferGeometry {
  const curve = new CatmullRomCurve3(points);
  const section = roundedRect(w, h, Math.min(w, h) * 0.35).getPoints(3);
  const ring = section.length;
  const pos: number[] = [];
  const up = new Vector3(0, 1, 0);
  const t = new Vector3();
  const side = new Vector3();
  const nrm = new Vector3();
  for (let i = 0; i <= segments; i++) {
    const p = curve.getPointAt(i / segments);
    curve.getTangentAt(i / segments, t);
    side.crossVectors(t, up).normalize();
    nrm.crossVectors(side, t).normalize();
    for (const s of section) pos.push(p.x + side.x * s.x + nrm.x * s.y, p.y + side.y * s.x + nrm.y * s.y, p.z + side.z * s.x + nrm.z * s.y);
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * ring + j;
      const b = i * ring + ((j + 1) % ring);
      index.push(a, b, a + ring, b, b + ring, a + ring);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Points along a path every `stepM`, for bolt heads and seams. */
function along(points: Vector3[], stepM: number): Vector3[] {
  const curve = new CatmullRomCurve3(points);
  const n = Math.max(2, Math.floor(curve.getLength() / stepM));
  return Array.from({ length: n + 1 }, (_, i) => curve.getPointAt(i / n));
}

/**
 * A clothed limb along a path (hip → knee → ankle): an oval section whose radius eases along `radii`, the
 * cloth in folds that wander round it, the creases shaded in `shade`.
 */
function limb(points: Vector3[], radii: number[], seed: number): BufferGeometry {
  const curve = new CatmullRomCurve3(points);
  const rings = 40;
  const around = 20;
  const pos: number[] = [];
  const shade: number[] = [];
  const t = new Vector3();
  const a1 = new Vector3();
  const a2 = new Vector3();
  const ref = new Vector3(1, 0, 0);
  for (let k = 0; k <= rings; k++) {
    const u = k / rings;
    const p = curve.getPointAt(u);
    curve.getTangentAt(u, t);
    a1.crossVectors(t, ref).normalize();
    a2.crossVectors(t, a1).normalize();
    const f = u * (radii.length - 1);
    const i0 = Math.min(radii.length - 2, Math.floor(f));
    const r0 = (radii[i0] as number) + ((radii[i0 + 1] as number) - (radii[i0] as number)) * (f - i0);
    for (let j = 0; j <= around; j++) {
      const ang = (j / around) * Math.PI * 2;
      const fold = Math.sin(u * 19 + ang * 2 + seed) * 0.6 + Math.sin(u * 37 - ang * 3 + seed * 1.7) * 0.4;
      const r = r0 * (1 + fold * 0.045);
      const cx = Math.cos(ang) * r * 1.05;
      const cy = Math.sin(ang) * r * 0.92;
      pos.push(p.x + a1.x * cx + a2.x * cy, p.y + a1.y * cx + a2.y * cy, p.z + a1.z * cx + a2.z * cy);
      shade.push(0.74 + 0.26 * Math.min(1, Math.max(0, fold * 0.45 + 0.5)));
    }
  }
  const index: number[] = [];
  const row = around + 1;
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < around; j++) {
      const a = k * row + j;
      index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('shade', new BufferAttribute(new Float32Array(shade), 1));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Collects geometry per material and merges each list into one mesh. */
class Parts {
  private readonly lists = new Map<Material, BufferGeometry[]>();

  add(m: Material, g: BufferGeometry): void {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.getAttribute('normal')) n.computeVertexNormals();
    const count = n.getAttribute('position').count;
    if (!n.getAttribute('uv')) n.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
    for (const key of Object.keys(n.attributes)) if (!['position', 'normal', 'uv', 'shade', 'leather'].includes(key)) n.deleteAttribute(key);
    n.clearGroups();
    const list = this.lists.get(m) ?? [];
    list.push(n);
    this.lists.set(m, list);
  }

  build(group: Group): void {
    for (const [m, list] of this.lists) {
      // Shading attributes must match within a merge: the cloth's `shade` defaults to 1 elsewhere, the
      // gloves' `leather` to 0.
      for (const [key, fill] of [['shade', 1], ['leather', 0]] as const) {
        if (!list.some((g) => g.getAttribute(key))) continue;
        for (const g of list) if (!g.getAttribute(key)) g.setAttribute(key, new BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(fill), 1));
      }
      const merged = mergeGeometries(list, false);
      if (!merged) throw new Error(`cockpit merge failed for ${m.name}`);
      const mesh = new Mesh(merged, m);
      mesh.name = m.name;
      mesh.receiveShadow = true;
      mesh.castShadow = !m.transparent;
      group.add(mesh);
    }
  }
}

// ------------------------------------------------------------------ the printed faces

/** Prints a face: pixel units, origin top-left, `k` pixels per metre. */
type Draw = (c: CanvasRenderingContext2D, w: number, h: number, k: number) => void;

/** One canvas of every printed face (legends, seams, dials), packed in shelves. */
class Atlas {
  readonly canvas = document.createElement('canvas');
  private readonly c: CanvasRenderingContext2D;
  private x = 0;
  private y = 0;
  private row = 0;

  constructor() {
    this.canvas.width = this.canvas.height = ATLAS_PX;
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('2D canvas unavailable for the cockpit faces');
    this.c = c;
    c.fillStyle = '#1b1c1e';
    c.fillRect(0, 0, ATLAS_PX, ATLAS_PX);
  }

  /** A plane of w × h metres facing +z, printed by `draw` (pixel units, origin top-left). */
  face(wM: number, hM: number, draw: Draw, k = PX_FACES): BufferGeometry {
    const w = Math.ceil(wM * k);
    const h = Math.ceil(hM * k);
    if (this.x + w + 2 > ATLAS_PX) {
      this.x = 0;
      this.y += this.row + 2;
      this.row = 0;
    }
    if (this.y + h > ATLAS_PX) throw new Error('cockpit atlas full');
    const c = this.c;
    c.save();
    c.translate(this.x, this.y);
    c.beginPath();
    c.rect(0, 0, w, h);
    c.clip();
    draw(c, w, h, k);
    c.restore();
    const g = new PlaneGeometry(wM, hM);
    const uv = g.getAttribute('uv');
    const u0 = this.x / ATLAS_PX;
    const u1 = (this.x + w) / ATLAS_PX;
    const v0 = 1 - (this.y + h) / ATLAS_PX;
    const v1 = 1 - this.y / ATLAS_PX;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    this.x += w + 2;
    this.row = Math.max(this.row, h);
    return g;
  }

  /** A round face of radius r (m): a disc, printed square. */
  disc(rM: number, draw: Draw): BufferGeometry {
    const sq = this.face(rM * 2, rM * 2, draw, PX_PER_M);
    const uv = sq.getAttribute('uv');
    const u0 = uv.getX(0);
    const u1 = uv.getX(1);
    const v1 = uv.getY(0);
    const v0 = uv.getY(2);
    const g = new CircleGeometry(rM, 28);
    const guv = g.getAttribute('uv');
    for (let i = 0; i < guv.count; i++) guv.setXY(i, u0 + guv.getX(i) * (u1 - u0), v0 + guv.getY(i) * (v1 - v0));
    return g;
  }

  texture(): CanvasTexture {
    const t = new CanvasTexture(this.canvas);
    t.colorSpace = SRGBColorSpace;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    return t;
  }
}

const INK = '#c9ccce';
const SEAM = '#0d0e0f';

function legend(c: CanvasRenderingContext2D, s: string, x: number, y: number, sizePx: number, align: CanvasTextAlign = 'center', ink = INK): void {
  c.fillStyle = ink;
  c.font = `600 ${Math.max(5, Math.round(sizePx))}px Arial, Helvetica, sans-serif`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}

/** A Dzus fastener head: a domed disc with its slot. */
function dzus(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const g = c.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, '#8d9296');
  g.addColorStop(1, '#3d4144');
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = '#1a1b1c';
  c.lineWidth = Math.max(1, r * 0.25);
  c.beginPath();
  c.moveTo(x - r * 0.7, y + r * 0.2);
  c.lineTo(x + r * 0.7, y - r * 0.2);
  c.stroke();
}

/** A console or panel face: dark paint, a seam round it, fasteners in the corners, legends where given. */
function panelFace(labels: [string, number, number][] = [], fasteners = true): Draw {
  return (c, w, h, k) => {
    c.fillStyle = '#2b2e31';
    c.fillRect(0, 0, w, h);
    // Paint wear: a few lighter scuffs.
    for (let i = 0; i < 14; i++) {
      c.fillStyle = `rgba(120,124,128,${0.04 + ((i * 37) % 7) * 0.006})`;
      const x = ((i * 977) % 1000) / 1000;
      const y = ((i * 613) % 1000) / 1000;
      c.fillRect(x * w, y * h, w * 0.08, Math.max(1, h * 0.01));
    }
    c.strokeStyle = SEAM;
    c.lineWidth = 3;
    c.strokeRect(1.5, 1.5, w - 3, h - 3);
    c.strokeStyle = 'rgba(110,115,120,0.35)';
    c.lineWidth = 1;
    c.strokeRect(4, 4, w - 8, h - 8);
    const r = 0.0032 * k;
    if (fasteners) for (const [x, y] of [[r * 2.2, r * 2.2], [w - r * 2.2, r * 2.2], [r * 2.2, h - r * 2.2], [w - r * 2.2, h - r * 2.2]] as const) dzus(c, x, y, r);
    for (const [s, fx, fy] of labels) legend(c, s, fx * w, fy * h, 0.0042 * k);
  };
}

/** A round instrument's face: ticks, numerals, a needle, a little glare. */
function dialFace(kind: 'speed' | 'alt' | 'attitude' | 'heading' | 'small', needle: number): Draw {
  return (c, w) => {
    const r = w / 2;
    c.fillStyle = '#0b0c0d';
    c.fillRect(0, 0, w, w);
    c.save();
    c.translate(r, r);
    if (kind === 'attitude') {
      c.beginPath();
      c.arc(0, 0, r * 0.95, 0, Math.PI * 2);
      c.clip();
      c.rotate(0.08);
      c.fillStyle = '#d8d9d6';
      c.fillRect(-r, -r, 2 * r, r * 1.08);
      c.fillStyle = '#26221e';
      c.fillRect(-r, r * 0.08, 2 * r, r);
      c.strokeStyle = '#111';
      c.lineWidth = r * 0.03;
      for (const p of [-0.45, -0.25, 0.3, 0.5]) {
        c.beginPath();
        c.moveTo(-r * 0.2, p * r + r * 0.08);
        c.lineTo(r * 0.2, p * r + r * 0.08);
        c.stroke();
      }
      c.restore();
      c.save();
      c.translate(r, r);
      c.strokeStyle = '#f1b43b';
      c.lineWidth = r * 0.07;
      c.beginPath();
      c.moveTo(-r * 0.55, 0);
      c.lineTo(-r * 0.15, 0);
      c.lineTo(0, r * 0.12);
      c.lineTo(r * 0.15, 0);
      c.lineTo(r * 0.55, 0);
      c.stroke();
    } else {
      c.strokeStyle = '#d9dbdc';
      const marks = kind === 'small' ? 10 : 50;
      for (let i = 0; i < marks; i++) {
        const a = (i / marks) * Math.PI * 2;
        const long = i % 5 === 0;
        c.lineWidth = long ? r * 0.035 : r * 0.018;
        c.beginPath();
        c.moveTo(Math.sin(a) * r * 0.9, -Math.cos(a) * r * 0.9);
        c.lineTo(Math.sin(a) * r * (long ? 0.74 : 0.82), -Math.cos(a) * r * (long ? 0.74 : 0.82));
        c.stroke();
        if (long && kind !== 'small') legend(c, String(i / 5), Math.sin(a) * r * 0.58, -Math.cos(a) * r * 0.58, r * 0.17, 'center', '#d9dbdc');
      }
      if (kind === 'heading') legend(c, 'N', 0, -r * 0.35, r * 0.2, 'center', '#d9dbdc');
      const a = needle * Math.PI * 2;
      c.strokeStyle = '#eceeee';
      c.lineWidth = r * 0.05;
      c.beginPath();
      c.moveTo(-Math.sin(a) * r * 0.15, Math.cos(a) * r * 0.15);
      c.lineTo(Math.sin(a) * r * 0.78, -Math.cos(a) * r * 0.78);
      c.stroke();
      c.fillStyle = '#2a2c2e';
      c.beginPath();
      c.arc(0, 0, r * 0.08, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
    // Glare across the glass: a soft diagonal sheen.
    const g = c.createLinearGradient(0, 0, w, w);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.0)');
    g.addColorStop(1, 'rgba(255,255,255,0.0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, w);
  };
}

/** A grid of caution tiles, unlit: dark lenses with their legends. */
function tiles(cols: number, rows: number, words: string[]): Draw {
  return (c, w, h, k) => {
    c.fillStyle = '#121314';
    c.fillRect(0, 0, w, h);
    const tw = w / cols;
    const th = h / rows;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const lit = (i * 7 + j * 3) % 11 === 0;
        c.fillStyle = lit ? '#5c4a16' : '#232120';
        c.fillRect(i * tw + 2, j * th + 2, tw - 4, th - 4);
        legend(c, words[(j * cols + i) % words.length] as string, i * tw + tw / 2, j * th + th / 2, Math.min(th * 0.34, 0.0036 * k), 'center', lit ? '#f0c24e' : '#8b8478');
      }
    }
  };
}

/** A key cap's top: its legend on dark grey, lighter toward the top edge as a cap catches the light. */
function keyTop(s: string): Draw {
  return (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#6a6e72');
    g.addColorStop(1, '#45484c');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    legend(c, s, w / 2, h / 2, Math.min(h * 0.42, w * 0.3));
  };
}

// ------------------------------------------------------------------ the office

/**
 * Builds the office for `kind`. `screen` is the displays' material (cockpit.ts's live canvas); `slots`
 * where its displays go on the panel.
 */
export function buildOffice(kind: AircraftId, screen: Material, attitude: Material, slots: DisplaySlotSpec): OfficeModel {
  const group = new Group();
  const parts = new Parts();
  const stickParts = new Parts();
  const throttleParts = new Parts();
  const atlas = new Atlas();
  const printed = new MeshStandardNodeMaterial({ name: 'cockpit printed faces', roughness: 0.6, metalness: 0 });
  const M = {
    tub: paint('cockpit tub', 0x4b5055, 0.82),
    console: paint('cockpit console', 0x3a3e42, 0.75),
    rail: paint('canopy sill', 0x7c8287, 0.5, 0.15),
    bolt: paint('sill bolts', 0x2a2c2e, 0.45, 0.6),
    hood: paint('glare shield', 0x222326, 0.92),
    stitch: paint('glare shield stitching', 0x2e3033, 0.9),
    frame: paint('hud frame', 0x222326, 0.55),
    key: paint('key caps', 0x4d5155, 0.5),
    bezel: paint('display bezels', 0x42464a, 0.6),
    metal: paint('switch metal', 0xb9bcbf, 0.32, 1),
    knob: paint('knobs', 0x141516, 0.5),
    grip: paint('grips', 0x1c1d1f, 0.78),
    gear: paint('gear handle', 0xd8d4c8, 0.5),
    rubber: paint('rubber', 0x101011, 0.95),
    boot: paint('boots', 0x141210, 0.7),
    suit: new MeshPhysicalNodeMaterial({ name: 'flight suit', roughness: 0.92, sheen: 0.5, sheenRoughness: 0.7, sheenColor: 0x6a6e5a }),
  };
  M.suit.colorNode = color(0x55594a).mul(attribute('shade', 'float'));
  const glassMat = new MeshPhysicalNodeMaterial({ name: 'instrument glass', color: 0x0d0f10, roughness: 0.04, transparent: true, opacity: 0.18, depthWrite: false });

  // The panel's frame: its faces and parts placed in it, then carried into the office.
  const panelM = new Matrix4().makeRotationX(PANEL_LEAN_RAD).setPosition(PANEL_AT);
  const onPanel = (m: Material, g: BufferGeometry): void => parts.add(m, g.applyMatrix4(panelM));

  // ---- tub: walls leaning in toward the floor, floor, footwell bulkhead, rear bulkhead
  for (const side of [-1, 1]) {
    parts.add(M.tub, at(slab(0.025, 0.76, 1.45), side * 0.452, -0.69, -0.27, 0, 0, side * 0.06));
    // The cockpit lining just under the sill: a lip that shades the console top.
    parts.add(M.tub, rail([new Vector3(side * 0.418, -0.345, 0.42), new Vector3(side * 0.42, -0.345, -0.25), new Vector3(side * 0.395, -0.33, -0.72)], 0.024, 0.032, 30));
  }
  parts.add(M.tub, at(slab(0.92, 0.025, 1.5), 0, -1.07, -0.3));
  parts.add(M.tub, at(slab(0.9, 0.42, 0.025), 0, -0.86, -1.04));
  parts.add(M.tub, at(slab(0.9, 0.78, 0.025), 0, -0.68, 0.45));
  // Under the panel down to the footwell: a sloped closure, so the knee well has a roof.
  parts.add(M.tub, at(slab(0.86, 0.025, 0.36), 0, -0.79, -0.86, -0.35));

  // ---- canopy sills: rails converging toward the windscreen, two rows of bolt heads along their tops
  for (const side of [-1, 1]) {
    const path = [new Vector3(side * 0.45, -0.305, 0.45), new Vector3(side * 0.455, -0.3, -0.1), new Vector3(side * 0.435, -0.288, -0.6), new Vector3(side * 0.39, -0.272, -0.98)];
    parts.add(M.rail, rail(path, 0.072, 0.046, 60));
    const top = path.map((p) => p.clone().setY(p.y + 0.0235));
    const pts = along(top, 0.062);
    for (const p of pts) {
      for (const off of [-0.019, 0.019]) {
        const head = new SphereGeometry(0.0055, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1);
        parts.add(M.bolt, at(head, p.x + off * side, p.y, p.z));
      }
    }
  }

  // ---- glare shield: an arched hood padded and stitched along its lip
  const hood = new Shape();
  hood.moveTo(-0.44, -0.33);
  hood.lineTo(-0.44, -0.27);
  hood.bezierCurveTo(-0.26, -0.18, 0.26, -0.18, 0.44, -0.27);
  hood.lineTo(0.44, -0.33);
  hood.closePath();
  const hoodGeo = toCreasedNormals(new ExtrudeGeometry(hood, { depth: 0.36, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.022, bevelSegments: 5, curveSegments: 30, steps: 6 }), Math.PI / 4);
  parts.add(M.hood, at(hoodGeo, 0, 0, -1.0));
  const lip: Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const x = -0.43 + (0.86 * i) / 24;
    const tx = (x + 0.44) / 0.88;
    // The hood's top curve (the Bézier above), sampled: its height at x.
    const y = bezierY(tx) + 0.004;
    lip.push(new Vector3(x, y - 0.012, -0.607));
  }
  parts.add(M.stitch, rail(lip, 0.006, 0.006, 60));

  // ---- the panel: a backing slab, its trim, then the instruments in the panel frame
  onPanel(M.console, at(slab(0.84, 0.5, 0.03), 0, 0, -0.015));
  onPanel(printed, at(atlas.face(0.82, 0.48, panelFace([], false), PX_BACKING), 0, 0, 0.0005));
  for (const [w, h, x, y] of [[0.86, 0.02, 0, 0.25], [0.86, 0.02, 0, -0.25], [0.02, 0.52, -0.43, 0], [0.02, 0.52, 0.43, 0]] as const) onPanel(M.bezel, at(rbox(w, h, 0.026, 0.006), x, y, 0.004));

  const display = (s: DisplaySlot): void => {
    const g = new PlaneGeometry(s.w, s.h);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, s.u0 + uv.getX(i) * (s.u1 - s.u0));
    onPanel(screen, at(g, s.x, s.y, 0.0245));
    // Bezel: a raised frame, its printed face with the push-buttons' legends, the buttons and corner rockers.
    const bw = s.w + 0.066;
    const bh = s.h + 0.066;
    onPanel(M.bezel, at(rbox(bw, bh, 0.022, 0.005, 0.006), s.x, s.y, 0.011));
    const keys = Math.max(5, Math.round(s.w / 0.027));
    const words = ['FCR', 'SMS', 'HSD', 'TGP', 'DTE', 'WPN', 'TEST', 'FLIR', 'SWAP', 'MENU'];
    onPanel(
      printed,
      at(
        atlas.face(bw - 0.006, bh - 0.006, (c, w, h, k) => {
          c.fillStyle = '#3c4044';
          c.fillRect(0, 0, w, h);
          c.fillStyle = '#060707';
          c.fillRect(((bw - s.w) / 2 - 0.003) * k, ((bh - s.h) / 2 - 0.003) * k, s.w * k, s.h * k);
          for (let i = 0; i < keys; i++) {
            const kx = (0.03 + ((i + 0.5) / keys) * s.w) * k;
            legend(c, words[i % words.length] as string, kx, 0.008 * k, 0.0032 * k);
            legend(c, words[(i + 4) % words.length] as string, kx, h - 0.008 * k, 0.0032 * k);
          }
          dzus(c, 0.008 * k, 0.008 * k, 0.003 * k);
          dzus(c, w - 0.008 * k, h - 0.008 * k, 0.003 * k);
        }),
        s.x,
        s.y,
        0.0223,
      ),
    );
    for (let i = 0; i < keys; i++) {
      const kx = s.x - s.w / 2 + ((i + 0.5) / keys) * s.w;
      for (const ky of [s.y + s.h / 2 + 0.019, s.y - s.h / 2 - 0.019]) onPanel(M.key, at(rbox(0.017, 0.012, 0.008, 0.0022), kx, ky, 0.025));
    }
    const sideKeys = Math.max(4, Math.round(s.h / 0.03));
    for (let i = 0; i < sideKeys; i++) {
      const ky = s.y - s.h / 2 + ((i + 0.5) / sideKeys) * s.h;
      for (const kx of [s.x - s.w / 2 - 0.019, s.x + s.w / 2 + 0.019]) onPanel(M.key, at(rbox(0.012, 0.017, 0.008, 0.0022), kx, ky, 0.025));
    }
    for (const [cx, cy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) onPanel(M.key, at(rbox(0.009, 0.024, 0.009, 0.002), s.x + cx * (bw / 2 - 0.012), s.y + cy * (bh / 2 - 0.012), 0.025, 0, 0, (cx * cy * Math.PI) / 4));
  };

  /**
   * A round instrument: case, face (printed, or the live attitude ball when `face` is null) just proud of the
   * case's front, the glass over it and the bezel ring standing out round it. (Set inside the case, the faces
   * were hidden behind its front: every dial a dark disc.)
   */
  const instrument = (x: number, y: number, r: number, face: Draw | null): void => {
    onPanel(M.bezel, at(new CylinderGeometry(r + 0.007, r + 0.009, 0.01, 28).rotateX(Math.PI / 2), x, y, 0.005));
    if (face) onPanel(printed, at(atlas.disc(r, face), x, y, 0.0104));
    else onPanel(attitude, at(new CircleGeometry(r, 32), x, y, 0.0104));
    onPanel(M.bezel, at(new TorusGeometry(r + 0.003, 0.0035, 6, 28), x, y, 0.0128));
    onPanel(glassMat, at(new CircleGeometry(r, 28), x, y, 0.0122));
    onPanel(M.knob, at(new CylinderGeometry(0.0045, 0.0045, 0.008, 12).rotateX(Math.PI / 2), x + r * 0.85, y - r * 0.85, 0.02));
  };

  /** A toggle switch: hex nut and a bright bat leaning toward `lean` (rad about the panel's x). */
  const toggle = (put: (m: Material, g: BufferGeometry) => void, x: number, y: number, z: number, lean: number): void => {
    put(M.metal, at(new CylinderGeometry(0.0048, 0.0048, 0.004, 6).rotateX(Math.PI / 2), x, y, z + 0.002));
    const bat = new CylinderGeometry(0.0017, 0.0024, 0.019, 8).translate(0, 0.0095, 0).rotateX(Math.PI / 2 - lean);
    put(M.metal, at(bat, x, y, z + 0.003));
  };
  /** A rotary knob: a fluted skirt and a cap with its pointer line. */
  const knob = (put: (m: Material, g: BufferGeometry) => void, x: number, y: number, z: number, r: number): void => {
    put(M.knob, at(new CylinderGeometry(r * 0.85, r, r * 0.9, 14).rotateX(Math.PI / 2), x, y, z + r * 0.45));
    put(M.metal, at(new BoxGeometry(r * 0.18, r * 0.9, 0.0008), x, y + r * 0.35, z + r * 0.91));
  };

  if (kind === 'wraith') {
    display({ ...slots.wide, y: 0.045 });
    // Below the screen: a standby flight display, the gear panel and the caution tiles.
    onPanel(M.bezel, at(rbox(0.11, 0.08, 0.016, 0.004), 0, -0.12, 0.008));
    // A standby attitude display, the gyro's ball live in it.
    onPanel(attitude, at(new PlaneGeometry(0.066, 0.066), 0, -0.12, 0.0165));
    gearPanel(-0.28, -0.15);
    onPanel(printed, at(atlas.face(0.15, 0.08, tiles(4, 4, ['FUEL', 'HYD', 'ENG', 'OIL', 'GEN', 'ICE', 'FIRE', 'ECS', 'BRK', 'NWS', 'O2', 'CANOPY'])), 0.28, -0.15, 0.002));
    onPanel(M.bezel, at(rbox(0.165, 0.095, 0.01, 0.003), 0.28, -0.15, -0.002));
  } else {
    display({ ...slots.left, x: -0.205, y: 0.0 });
    display({ ...slots.right, x: 0.205, y: 0.0 });
    // Standby instruments in the centre column, below the keypad (which hides the column's top from the seat).
    // The standby attitude indicator: the gyro's ball, live (cockpit.ts draws it every frame).
    instrument(0, -0.065, 0.042, null);
    instrument(-0.062, -0.165, 0.026, dialFace('speed', 0.31));
    instrument(0.062, -0.165, 0.026, dialFace('alt', 0.62));
    instrument(0, -0.205, 0.016, dialFace('small', 0.08));
    gearPanel(-0.33, -0.18);
    onPanel(printed, at(atlas.face(0.12, 0.075, tiles(3, 4, ['FUEL', 'HYD', 'ENG', 'OIL', 'GEN', 'ICE', 'FIRE', 'ECS', 'BRK', 'NWS', 'O2', 'CANOPY'])), 0.33, -0.18, 0.002));
    onPanel(M.bezel, at(rbox(0.135, 0.09, 0.01, 0.003), 0.33, -0.18, -0.002));
    // The keypad under the HUD: a box standing out under the glare shield's lip, its face leaning back to the
    // pilot, its keys in a grid between a small text display and two rockers. (Set into the panel's top it sat
    // behind the lip, out of sight.)
    const icpM = new Matrix4().makeRotationX(-0.42).setPosition(0, -0.405, -0.655);
    const onIcp = (m: Material, g: BufferGeometry): void => parts.add(m, g.applyMatrix4(icpM));
    onIcp(M.bezel, at(rbox(0.23, 0.12, 0.13, 0.008, 0.008), 0, 0, -0.065));
    onIcp(printed, at(atlas.face(0.218, 0.108, panelFace([['COM 1', 0.1, 0.12], ['COM 2', 0.9, 0.12], ['DRIFT', 0.9, 0.88]])), 0, 0, 0.0005));
    const labels = ['1', '2', '3', 'COM', '4', '5', '6', 'IFF', '7', '8', '9', 'LIST', 'RCL', '0', 'ENTR', 'A-A'];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const x = -0.042 + i * 0.028;
        const y = 0.033 - j * 0.022;
        onIcp(M.key, at(rbox(0.023, 0.017, 0.01, 0.0026), x, y, 0.005));
        onIcp(printed, at(atlas.face(0.018, 0.012, keyTop(labels[j * 4 + i] as string), PX_PER_M), x, y, 0.0103));
      }
    }
    onIcp(printed, at(atlas.face(0.036, 0.05, (c, w, h) => {
      c.fillStyle = '#04110a';
      c.fillRect(0, 0, w, h);
      for (let k = 0; k < 4; k++) legend(c, ['UHF 251', 'VHF 121', 'STPT  4', 'ALT 12K'][k] as string, w / 2, ((k + 0.7) * h) / 4.4, h * 0.11, 'center', '#57e08a');
    }), -0.085, 0.005, 0.001));
    for (const y of [0.022, -0.022]) onIcp(M.key, at(rbox(0.012, 0.03, 0.012, 0.003), 0.085, y, 0.006));
    // Narrow switch panels on the panel's wings, outboard of the displays.
    for (const side of [-1, 1]) {
      const x = side * 0.362;
      onPanel(printed, at(atlas.face(0.085, 0.2, panelFace(side < 0 ? [['MASTER', 0.5, 0.1], ['ARM', 0.5, 0.17], ['LASER', 0.5, 0.45], ['ALT REL', 0.5, 0.72]] : [['HMCS', 0.5, 0.1], ['DEPR', 0.5, 0.42], ['INSTR', 0.5, 0.7], ['MODE', 0.5, 0.9]])), x, 0.0, 0.002));
      toggle(onPanel, x, 0.055, 0.0025, 0.35);
      toggle(onPanel, x, -0.005, 0.0025, -0.35);
      knob(onPanel, x, -0.065, 0.0025, 0.01);
    }
  }

  function gearPanel(x: number, y: number): void {
    onPanel(printed, at(atlas.face(0.15, 0.11, (c, w, h, k) => {
      panelFace([['GEAR', 0.72, 0.13], ['DN', 0.72, 0.86], ['HOOK', 0.25, 0.86]])(c, w, h, k);
      for (let k = 0; k < 3; k++) {
        c.fillStyle = '#1b5e2c';
        c.beginPath();
        c.arc(w * (0.58 + k * 0.12), h * 0.5, h * 0.06, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = 'rgba(160,255,170,0.55)';
        c.beginPath();
        c.arc(w * (0.58 + k * 0.12) - h * 0.015, h * 0.5 - h * 0.015, h * 0.025, 0, Math.PI * 2);
        c.fill();
      }
    }), x, y, 0.002));
    // The gear handle: a lever out of its slot, the wheel-shaped knob on its end.
    onPanel(M.metal, at(new CylinderGeometry(0.0045, 0.0045, 0.06, 10).rotateX(Math.PI / 2 - 0.5), x - 0.045, y, 0.03));
    onPanel(M.gear, at(new TorusGeometry(0.014, 0.0055, 8, 18).rotateX(Math.PI / 2 - 0.5), x - 0.045, y - 0.012, 0.058));
    onPanel(M.gear, at(new CylinderGeometry(0.01, 0.01, 0.006, 16).rotateX(Math.PI / 2 - 0.5), x - 0.045, y - 0.012, 0.058));
  }

  // ---- HUD (the conventional type): projector housing on the hood, a tall frame, the combiner
  let combiner: Vector3[] | null = null;
  if (kind === 'talon') {
    parts.add(M.frame, at(rbox(0.2, 0.075, 0.17, 0.012, 0.01), 0, -0.16, -0.73));
    parts.add(printed, at(atlas.face(0.17, 0.05, panelFace([['SYM', 0.2, 0.5], ['BRT', 0.5, 0.5], ['DAY', 0.8, 0.5]])), 0, -0.155, -0.6445));
    for (const side of [-1, 1]) knob((m, g) => parts.add(m, g), side * 0.07, -0.155, -0.6435, 0.0085);
    // The combiner frame: posts from the hood either side of the projector, joined over the glass. A real
    // conventional HUD's glass is narrower; this one is 33° across at the eye, so the tapes, the ladder and
    // the corner data fit inside it without running into each other (the HUD layer clips to it).
    const frame = [new Vector3(-0.21, -0.218, -0.712), new Vector3(-0.212, -0.06, -0.69), new Vector3(-0.207, 0.09, -0.655), new Vector3(-0.15, 0.152, -0.643), new Vector3(0, 0.16, -0.64), new Vector3(0.15, 0.152, -0.643), new Vector3(0.207, 0.09, -0.655), new Vector3(0.212, -0.06, -0.69), new Vector3(0.21, -0.218, -0.712)];
    parts.add(M.frame, rail(frame, 0.01, 0.016, 90));
    const pane = new Mesh(new PlaneGeometry(0.4, 0.28), new MeshPhysicalNodeMaterial({ name: 'combiner', color: 0x8fb39e, roughness: 0.03, transparent: true, opacity: 0.11, side: DoubleSide, depthWrite: false }));
    pane.position.set(0, 0.005, -0.668);
    pane.rotation.x = -0.12;
    pane.updateMatrix();
    group.add(pane);
    combiner = [
      [-0.2, 0.14],
      [0.2, 0.14],
      [0.2, -0.14],
      [-0.2, -0.14],
    ].map(([x, y]) => new Vector3(x, y, 0).applyMatrix4(pane.matrix));
    // The windscreen frame: posts from the hood's corners into an arch over the head.
    const arch = [new Vector3(-0.44, -0.26, -0.66), new Vector3(-0.43, 0.02, -0.47), new Vector3(-0.32, 0.25, -0.25), new Vector3(0, 0.35, -0.13), new Vector3(0.32, 0.25, -0.25), new Vector3(0.43, 0.02, -0.47), new Vector3(0.44, -0.26, -0.66)];
    parts.add(M.rail, rail(arch, 0.034, 0.022, 90));
    for (const p of along(arch, 0.07)) parts.add(M.bolt, at(new SphereGeometry(0.004, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.5, 1), p.x * 0.97, p.y - 0.014, p.z + 0.012, Math.PI));
  }
  // Small lamps on the glare shield either side of the HUD: the angle-of-attack indexer and the warnings.
  for (const side of [-1, 1]) {
    parts.add(M.frame, at(rbox(0.045, 0.034, 0.04, 0.005), side * 0.15, -0.188, -0.66));
    parts.add(printed, at(atlas.face(0.037, 0.026, tiles(1, 2, side < 0 ? ['AOA', 'SLOW'] : ['WARN', 'CAUTN'])), side * 0.15, -0.188, -0.6398));
  }

  // ---- side consoles: switch panels on top, the throttle on the left, the stick on the right
  for (const side of [-1, 1]) {
    const cx = side * 0.335;
    parts.add(M.console, at(slab(0.21, 0.36, 0.82), cx, -0.72, -0.06));
    const topY = -0.539;
    const putTop = (m: Material, g: BufferGeometry): void => parts.add(m, g.rotateX(-Math.PI / 2).translate(0, topY, 0));
    const panels: [number, number, [string, number, number][]][] =
      side < 0
        ? [
            [0.2, 0.17, [['ANT', 0.2, 0.15], ['IFF', 0.5, 0.15], ['MODE 4', 0.8, 0.15], ['AUDIO', 0.5, 0.86]]],
            [0.14, 0.17, [['FUEL MASTER', 0.5, 0.12], ['TANK', 0.3, 0.85], ['ENG FEED', 0.72, 0.85]]],
            [0.2, 0.17, [['EXT LT', 0.3, 0.14], ['FORM', 0.72, 0.14], ['ANTI COLL', 0.5, 0.86]]],
          ]
        : [
            [0.2, 0.17, [['OXYGEN', 0.5, 0.12], ['SUPPLY', 0.25, 0.85], ['DILUTER', 0.75, 0.85]]],
            [0.14, 0.17, [['SNSR PWR', 0.5, 0.12], ['LEFT HDPT', 0.3, 0.85], ['RIGHT HDPT', 0.72, 0.85]]],
            [0.2, 0.17, [['AIR COND', 0.3, 0.14], ['TEMP', 0.72, 0.14], ['DEFOG', 0.5, 0.86]]],
          ];
    let z = 0.3;
    panels.forEach(([len, wid, labels], k) => {
      const zc = z - len / 2;
      putTop(printed, at(atlas.face(wid, len, panelFace(labels), PX_CONSOLE), cx, zc, 0.001));
      putTop(M.bezel, at(rbox(wid + 0.012, len + 0.008, 0.008, 0.002), cx, zc, -0.004));
      // Two toggles and a knob per panel, in the panel's own layout (y along it, toward the nose).
      toggle(putTop, cx - 0.04, zc + 0.03, 0.001, 0.4 * (k % 2 === 0 ? 1 : -1));
      toggle(putTop, cx + 0.0, zc + 0.03, 0.001, -0.4);
      knob(putTop, cx + 0.045, zc - 0.025, 0.001, 0.01);
      knob(putTop, cx - 0.04, zc - 0.03, 0.001, 0.008);
      z -= len + 0.012;
    });
  }
  // Throttle: a quadrant on the left console's inboard edge (fixed), the lever and its many-buttoned grip with
  // the left hand on it (the throttle group, which slides along the quadrant).
  parts.add(M.console, at(rbox(0.05, 0.05, 0.3, 0.008), -0.255, -0.515, -0.12));
  const tp = THROTTLE_PIVOT;
  const onThrottle = (m: Material, g: BufferGeometry): void => throttleParts.add(m, g.translate(-tp.x, -tp.y, -tp.z));
  onThrottle(M.metal, at(new BoxGeometry(0.012, 0.06, 0.012), -0.255, -0.48, -0.15, -0.35));
  onThrottle(M.grip, at(rbox(0.05, 0.09, 0.07, 0.016, 0.012), -0.262, -0.43, -0.17, -0.25, 0, 0.12));
  for (const [dx, dy, dz] of [[0.02, 0.03, -0.01], [0.022, 0.0, -0.03], [-0.005, 0.045, -0.02]] as const) onThrottle(M.key, at(new CylinderGeometry(0.005, 0.005, 0.006, 10).rotateZ(Math.PI / 2), -0.262 + dx, -0.43 + dy, -0.17 + dz));
  // Side stick: an armrest and a rubber boot (fixed), the grip leaning forward with its trigger and hats and
  // the right hand on it (the stick group, pivoting at the boot).
  parts.add(M.grip, at(rbox(0.085, 0.035, 0.24, 0.012, 0.01), 0.36, -0.505, 0.05));
  const bootGeo = new LatheGeometry([new Vector2(0.032, 0), new Vector2(0.028, 0.008), new Vector2(0.031, 0.014), new Vector2(0.025, 0.022), new Vector2(0.027, 0.03), new Vector2(0.018, 0.04)], 16);
  parts.add(M.rubber, at(bootGeo, 0.335, -0.535, -0.16));
  const sp = STICK_PIVOT;
  const onStick = (m: Material, g: BufferGeometry): void => stickParts.add(m, g.translate(-sp.x, -sp.y, -sp.z));
  const gripGeo = new LatheGeometry([new Vector2(0.0, 0), new Vector2(0.017, 0.0), new Vector2(0.019, 0.03), new Vector2(0.021, 0.07), new Vector2(0.019, 0.1), new Vector2(0.012, 0.118), new Vector2(0.0, 0.122)], 16).scale(1, 1, 1.25);
  onStick(M.grip, at(gripGeo, 0.335, -0.5, -0.16, -0.18, 0, 0.05));
  onStick(M.metal, at(new BoxGeometry(0.008, 0.026, 0.008), 0.335, -0.43, -0.183, -0.5));
  for (const [dx, dy] of [[0.0, 0.112], [-0.012, 0.1]] as const) onStick(M.key, at(new CylinderGeometry(0.0045, 0.0045, 0.006, 10), 0.335 + dx, -0.5 + dy, -0.172));

  // ---- the pilot's hands on the stick and the throttle, gloved, the arms back to the shoulders in the suit
  const glove = gloveMaterial();
  pilotArm(onStick, 1, glove, M.suit, new Vector3(0.335, -0.44, -0.171), new Vector3(0, -0.984, 0.179), new Vector3(1, 0, 0), new Vector3(0.375, -0.465, 0.14), new Vector3(0.21, -0.28, 0.24));
  pilotArm(onThrottle, -1, glove, M.suit, new Vector3(-0.262, -0.425, -0.17), new Vector3(0, 0.97, -0.247), new Vector3(-0.99, 0, 0.12), new Vector3(-0.36, -0.445, 0.11), new Vector3(-0.21, -0.28, 0.24));

  // ---- the pilot's legs down to the rudder pedals, the boots on them
  for (const side of [-1, 1]) {
    const hip = new Vector3(side * 0.1, -0.82, 0.12);
    const knee = new Vector3(side * 0.13, -0.64, -0.42);
    const ankle = new Vector3(side * 0.14, -0.98, -0.78);
    parts.add(M.suit, limb([hip, hip.clone().lerp(knee, 0.5).add(new Vector3(0, 0.035, 0)), knee, knee.clone().lerp(ankle, 0.5), ankle], [0.085, 0.075, 0.064, 0.056, 0.045], side * 1.3));
    parts.add(M.boot, at(rbox(0.09, 0.07, 0.26, 0.02, 0.02), side * 0.14, -1.0, -0.85, -0.5));
    parts.add(M.console, at(rbox(0.11, 0.17, 0.03, 0.008), side * 0.14, -0.94, -0.97, -0.5));
  }

  parts.build(group);
  const stick = new Group();
  stick.position.copy(STICK_PIVOT);
  stickParts.build(stick);
  const throttle = new Group();
  throttle.position.copy(THROTTLE_PIVOT);
  throttleParts.build(throttle);
  group.add(stick, throttle);
  printed.colorNode = texture(atlas.texture()).rgb;
  // Occlusion at 2 cm reach 45 cm: deep corners dark, the panel under the hood dim, the tops open. The stick
  // and the throttle keep the occlusion of their neutral places.
  bakeAmbientOcclusion(group, { cellM: 0.02, rangeM: 0.45, rays: 16, strength: 0.6 });
  return { group, combiner, stick, throttle };
}

/** Where the side stick pivots (the top of its boot) and the throttle lever's origin, office frame. */
const STICK_PIVOT = new Vector3(0.335, -0.535, -0.16);
const THROTTLE_PIVOT = new Vector3(-0.255, -0.49, -0.12);

/** The hand frame's point that sits on a grip's axis: ahead of the wrist, under the palm (hand frame, m). */
const GRIP_IN_HAND = new Vector3(0, -0.033, -0.05);
const GLOVE_THICKNESS_M = 0.0018;

/** Flight gloves: sage Nomex on the backs, pale leather over the palms and fingertips (`leather`). */
function gloveMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'flight gloves', metalness: 0, sheenRoughness: 0.7 });
  const leather = attribute('leather', 'float');
  const n = mx_noise_float(positionLocal.mul(70)).mul(0.08).add(1);
  const fabric = color(0x4b4d38).mul(n);
  const hide = color(0x6d6352).mul(n);
  m.colorNode = mix(fabric, hide, leather);
  m.roughnessNode = mix(float(0.86), float(0.55), leather);
  m.sheenNode = mix(fabric.mul(1.4), hide.mul(0.5), leather);
  return m;
}

/**
 * A gloved hand closed round a grip and its arm back to the shoulder. `grip`: a point on the grip's axis;
 * `axis`: the grip's direction (the hand frame's x — thumb end opposite for the right hand); `back`: where the
 * back of the hand faces. The hand is MakeHuman's (handMesh.ts), posed round a ~40 mm grip and gloved; the
 * forearm under a glove cuff and the suit's sleeve to the elbow (`elbow`) and on to the shoulder.
 */
function pilotArm(put: (m: Material, g: BufferGeometry) => void, side: 1 | -1, glove: Material, suit: Material, grip: Vector3, axis: Vector3, back: Vector3, elbow: Vector3, shoulder: Vector3): void {
  const x = axis.clone().normalize();
  const y = back.clone().sub(x.clone().multiplyScalar(back.dot(x))).normalize();
  const z = new Vector3().crossVectors(x, y);
  const frame = new Matrix4().makeBasis(x, y, z);
  frame.setPosition(grip.clone().sub(GRIP_IN_HAND.clone().applyMatrix4(new Matrix4().makeBasis(x, y, z))));
  const pose = side === 1 ? { curl: [0.55, 0.85, 0.9, 0.92] as [number, number, number, number], thumb: 0.75, spread: 0.05 } : { curl: [0.7, 0.76, 0.8, 0.84] as [number, number, number, number], thumb: 0.55, spread: 0.08 };
  put(glove, glovedHand(side, pose).applyMatrix4(frame));
  const wrist = (d: number): Vector3 => new Vector3(0, 0, d).applyMatrix4(frame);
  // The glove's gauntlet over the wrist, then the sleeve.
  put(glove, limb([wrist(0.045), wrist(0.08), wrist(0.115)], [0.031, 0.034, 0.036], side * 2.1));
  put(suit, limb([wrist(0.105), wrist(0.17), elbow, elbow.clone().lerp(shoulder, 0.5), shoulder], [0.037, 0.042, 0.047, 0.055, 0.06], side * 0.7));
}

/**
 * The hand posed and gloved, in the hand frame: leather (`leather` 1) over the palm and the fingertips' pads,
 * the glove standing off the skin, the forearm cut at the cuff (the sleeve covers the rest).
 */
function glovedHand(side: 1 | -1, pose: HandPose): BufferGeometry {
  const rest = handData(side).geometry;
  const hand = posedHandGeometry(side, pose);
  const pos = hand.getAttribute('position');
  const nrm = hand.getAttribute('normal');
  const rPos = rest.getAttribute('position');
  const rNrm = rest.getAttribute('normal');
  const idx = hand.getAttribute('skinIndex');
  const wgt = hand.getAttribute('skinWeight');
  const leather = new Float32Array(pos.count);
  for (let v = 0; v < pos.count; v++) {
    let fingers = 0;
    for (let k = 0; k < 4; k++) if (idx.getComponent(v, k) >= 6) fingers += wgt.getComponent(v, k);
    const ny = rNrm.getY(v);
    const palm = Math.min(1, Math.max(0, (-ny - 0.3) / 0.3)) * (rPos.getZ(v) < 0.02 ? 1 : 0);
    leather[v] = palm * (0.6 + 0.4 * fingers);
    pos.setXYZ(v, pos.getX(v) + nrm.getX(v) * GLOVE_THICKNESS_M, pos.getY(v) + nrm.getY(v) * GLOVE_THICKNESS_M, pos.getZ(v) + nrm.getZ(v) * GLOVE_THICKNESS_M);
  }
  hand.setAttribute('leather', new BufferAttribute(leather, 1));
  const index = hand.getIndex();
  if (index) {
    const kept: number[] = [];
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t);
      if (rPos.getZ(a) < 0.1) kept.push(a, index.getX(t + 1), index.getX(t + 2));
    }
    hand.setIndex(kept);
  }
  return hand;
}

/** The glare shield's top curve at t (0…1 across): the Bézier of the hood's shape, its y. */
function bezierY(t: number): number {
  const y0 = -0.27;
  const y1 = -0.18;
  const y2 = -0.18;
  const y3 = -0.27;
  const u = 1 - t;
  return u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
}

/** The display slots cockpit.ts hands over: the conventional type's two squares, the stealth type's wide screen. */
export interface DisplaySlotSpec {
  left: DisplaySlot;
  right: DisplaySlot;
  wide: DisplaySlot;
}
