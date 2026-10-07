import { texture, vec3 } from 'three/tsl';
import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LinearFilter,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  PlaneGeometry,
  type Quaternion,
  Shape,
  SRGBColorSpace,
  TubeGeometry,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AircraftId } from '../config.ts';
import type { Radar, WarningReceiver } from '../sim/radar.ts';
import { drawRadarScope, drawRwrScope } from '../ui/sensors.ts';
import { plain } from './jetMaterials.ts';

// The pilot's office, seen from the eye point: glare shield, instrument panel,
// canopy sills, and for the twin-engine type the windscreen frame and the HUD
// combiner. It is what turns the cockpit camera from a floating eye into a
// seat, and it fixes the over-the-nose view (~15° below the horizon line).
//
// The displays are live: one 2-D canvas, redrawn ~15 times a second and
// uploaded as a texture, carries the radar B-scope, the threat ring and a
// flight page. The stealth type has one panoramic screen and no HUD (its
// symbology is helmet-mounted, so the HUD layer stays unclipped); the other
// type has two square displays and a combiner glass that clips the HUD.
//
// Geometry is in metres relative to the eye (x right, y up, −z forward), so
// one layout serves both jets; only the eye point differs.

/**
 * Display brightness in output units, independent of the scene's exposure. Real sunlit panels (~1500
 * cd/m²) read because the eye adapts to the cockpit; the camera has one exposure for the whole view, so
 * the screens are shown as that adapted eye would see them.
 */
const DISPLAY_LEVEL = 1.3;
const CANVAS_W = 1024;
const CANVAS_H = 400;
const REDRAW_S = 1 / 15;

export interface MfdData {
  radar: Radar;
  rwr: WarningReceiver;
  altitudeM: number;
  pitchRad: number;
  rollRad: number;
  headingDeg: number;
  speedMs: number;
  mach: number;
  loadFactor: number;
  fuelKg: number;
  weapon: string;
  gunRounds: number;
  srm: number;
  mrm: number;
  flares: number;
  chaff: number;
}

export class Cockpit {
  readonly root = new Group();
  /** Combiner glass corners in eye space (the HUD clips to their projection); null with a helmet display. */
  readonly combiner: Vector3[] | null;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tex: CanvasTexture;
  private sinceDrawS = REDRAW_S;
  private readonly eye: Vector3;

  constructor(
    readonly kind: AircraftId,
    eye: [number, number, number],
  ) {
    this.eye = new Vector3(...eye);
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the cockpit displays');
    this.ctx = ctx;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.minFilter = LinearFilter;
    this.tex.generateMipmaps = false;

    const office = new Group();
    office.position.copy(this.eye);
    this.root.add(office);
    this.root.visible = false;

    const shell = plain('cockpit shell', 0x2a2e32, 0.85);
    const black = plain('panel black', 0x121416, 0.7);
    const matte = plain('glare shield', 0x0c0d0e, 0.95);
    const bezelMaterial = plain('display bezel', 0x3a3f44, 0.6);
    const add = (g: BufferGeometry, m: Material): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.receiveShadow = true;
      office.add(mesh);
      return mesh;
    };

    // Glare shield: an arched hood over the panel, its near edge the line the pilot sees over (~15°).
    const hood = new Shape();
    hood.moveTo(-0.5, -0.32);
    hood.lineTo(-0.5, -0.26);
    hood.bezierCurveTo(-0.3, -0.17, 0.3, -0.17, 0.5, -0.26);
    hood.lineTo(0.5, -0.32);
    hood.closePath();
    const hoodGeo = new ExtrudeGeometry(hood, { depth: 0.34, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 4, curveSegments: 24 });
    hoodGeo.translate(0, 0, -0.98);
    add(hoodGeo, matte);

    // Instrument panel under the hood, leaning back towards the pilot.
    const panel = add(new BoxGeometry(0.96, 0.4, 0.04), black);
    panel.position.set(0, -0.48, -0.74);
    panel.rotation.x = -0.3;

    // Displays: planes just proud of the panel face, mapped to parts of the shared canvas.
    const screen = new MeshBasicNodeMaterial({ name: 'cockpit display' });
    screen.colorNode = texture(this.tex).rgb.mul(DISPLAY_LEVEL).add(vec3(0.002));
    const display = (w: number, h: number, x: number, y: number, u0: number, u1: number): void => {
      const g = new PlaneGeometry(w, h);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
      const m = new Mesh(g, screen);
      m.position.set(x, y, 0.031);
      panel.add(m);
      // Bezel with a row of push-buttons along the top and bottom edges (the display's soft keys).
      const parts: BufferGeometry[] = [new BoxGeometry(w + 0.05, h + 0.05, 0.012).translate(x, y, 0.02)];
      const keys = Math.max(5, Math.round(w / 0.035));
      for (let i = 0; i < keys; i++) {
        const kx = x - w / 2 + ((i + 0.5) / keys) * w;
        for (const ky of [y + h / 2 + 0.014, y - h / 2 - 0.014]) parts.push(new BoxGeometry(0.016, 0.01, 0.01).translate(kx, ky, 0.034));
      }
      const bezel = new Mesh(mergeGeometries(parts), bezelMaterial);
      bezel.receiveShadow = true;
      panel.add(bezel);
    };
    if (kind === 'wraith') {
      // One 50 × 20 cm panoramic screen across the panel.
      display(0.5, 0.195, 0, 0.02, 0, 1);
    } else {
      // Two square displays either side of a stack of round dials (painted dark, they are backup only).
      display(0.17, 0.17, -0.25, 0.01, 0, CANVAS_H / CANVAS_W);
      display(0.17, 0.17, 0.25, 0.01, 1 - CANVAS_H / CANVAS_W, 1);
      for (const [x, y] of [
        [-0.06, 0.07],
        [0.06, 0.07],
        [-0.06, -0.06],
        [0.06, -0.06],
      ] as const) {
        const dial = new Mesh(new BoxGeometry(0.075, 0.075, 0.02), shell);
        dial.position.set(x, y, 0.025);
        panel.add(dial);
      }
    }

    // Canopy sills along both sides, the cockpit walls below them, the consoles and the footwell.
    for (const side of [-1, 1]) {
      const sill = add(new BoxGeometry(0.09, 0.05, 1.5), shell);
      sill.position.set(side * 0.49, -0.29, -0.3);
      const wall = add(new BoxGeometry(0.04, 0.6, 1.5), shell);
      wall.position.set(side * 0.52, -0.6, -0.3);
      const console = add(new BoxGeometry(0.22, 0.08, 0.9), black);
      console.position.set(side * 0.39, -0.56, -0.15);
    }
    const footwell = add(new BoxGeometry(1.0, 0.5, 0.05), shell);
    footwell.position.set(0, -0.92, -0.72);

    if (kind === 'talon') {
      // Windscreen frame: two posts rising from the hood's corners into an arch above the head.
      const frame = new TubeGeometry(
        new CatmullRomCurve3([
          new Vector3(-0.5, -0.26, -0.64),
          new Vector3(-0.45, 0.02, -0.46),
          new Vector3(-0.33, 0.26, -0.24),
          new Vector3(0, 0.36, -0.12),
          new Vector3(0.33, 0.26, -0.24),
          new Vector3(0.45, 0.02, -0.46),
          new Vector3(0.5, -0.26, -0.64),
        ]),
        64,
        0.014,
        6,
        false,
      );
      add(frame, shell);
      // HUD: the projector housing on the hood and a slanted combiner glass above it, in a thin frame.
      const housing = add(new BoxGeometry(0.22, 0.08, 0.18), black);
      housing.position.set(0, -0.17, -0.72);
      const glass = new MeshPhysicalNodeMaterial({ name: 'combiner', color: 0x9fb8a8, roughness: 0.05, transparent: true, opacity: 0.035, side: DoubleSide, depthWrite: false });
      const pane = add(new PlaneGeometry(0.44, 0.3), glass);
      pane.position.set(0, -0.0, -0.66);
      pane.rotation.x = -0.12;
      pane.updateMatrix();
      for (const side of [-1, 1]) {
        const rail = new Mesh(new BoxGeometry(0.012, 0.3, 0.012), black);
        rail.position.set(side * 0.226, 0, 0);
        pane.add(rail);
      }
      this.combiner = [
        [-0.22, 0.15],
        [0.22, 0.15],
        [0.22, -0.15],
        [-0.22, -0.15],
      ].map(([x, y]) => new Vector3(x, y, 0).applyMatrix4(pane.matrix));
    } else this.combiner = null;
  }

  /** Follows the jet's render transform; shown only in the cockpit views. */
  update(pos: Vector3, rot: Quaternion, visible: boolean, frameS: number, data: MfdData): void {
    this.root.visible = visible;
    if (!visible) return;
    this.root.position.copy(pos);
    this.root.quaternion.copy(rot);
    this.sinceDrawS += frameS;
    if (this.sinceDrawS >= REDRAW_S) {
      this.sinceDrawS = 0;
      this.draw(data);
      this.tex.needsUpdate = true;
    }
  }

  /** The combiner's corners in world space this frame (for the HUD clip), or null. */
  combinerWorld(out: Vector3[]): boolean {
    if (!this.combiner) return false;
    this.root.updateMatrixWorld();
    this.combiner.forEach((c, i) => {
      out[i] = (out[i] ?? new Vector3()).copy(c).add(this.eye).applyMatrix4(this.root.matrixWorld);
    });
    return true;
  }

  private draw(d: MfdData): void {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#020403';
    c.fillRect(0, 0, CANVAS_W, CANVAS_H);
    const s = CANVAS_H;
    drawRadarScope(c, d.radar, 0, 0, s, d.altitudeM);
    drawRwrScope(c, d.rwr, CANVAS_W - s, 0, s);
    if (this.kind === 'wraith') this.flightPage(c, s, CANVAS_W - 2 * s, d);
  }

  /** The centre page of the panoramic screen: attitude, air data, fuel and stores. */
  private flightPage(c: CanvasRenderingContext2D, x0: number, w: number, d: MfdData): void {
    const h = CANVAS_H;
    const cx = x0 + w / 2;
    const cy = h * 0.42;
    const r = w * 0.42;
    // Attitude ball: sky and ground split by the horizon, pitched and rolled.
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.clip();
    c.translate(cx, cy);
    c.rotate(-d.rollRad);
    const pitchPx = (d.pitchRad / (Math.PI / 4)) * r;
    c.fillStyle = '#1d4f86';
    c.fillRect(-2 * r, -3 * r + pitchPx, 4 * r, 3 * r);
    c.fillStyle = '#5a3a1e';
    c.fillRect(-2 * r, pitchPx, 4 * r, 3 * r);
    c.strokeStyle = '#e8eef0';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-2 * r, pitchPx);
    c.lineTo(2 * r, pitchPx);
    for (const deg of [-20, -10, 10, 20]) {
      const y = pitchPx - ((deg * Math.PI) / 180 / (Math.PI / 4)) * r;
      c.moveTo(-r * 0.22, y);
      c.lineTo(r * 0.22, y);
    }
    c.stroke();
    c.restore();
    // Fixed aircraft symbol.
    c.strokeStyle = '#ffd34a';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(cx - r * 0.5, cy);
    c.lineTo(cx - r * 0.15, cy);
    c.lineTo(cx, cy + r * 0.1);
    c.lineTo(cx + r * 0.15, cy);
    c.lineTo(cx + r * 0.5, cy);
    c.stroke();
    // Air data and stores, in the green of the other pages.
    c.fillStyle = 'rgba(96, 255, 140, 0.95)';
    c.font = '600 22px ui-monospace, Menlo, Consolas, monospace';
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.fillText(`${Math.round(d.speedMs * 1.943_84)} KT`, x0 + 8, h * 0.06);
    c.fillText(`M ${d.mach.toFixed(2)}`, x0 + 8, h * 0.13);
    c.textAlign = 'right';
    c.fillText(`${Math.round(d.altitudeM * 3.280_84)} FT`, x0 + w - 8, h * 0.06);
    c.fillText(`${d.loadFactor.toFixed(1)} G`, x0 + w - 8, h * 0.13);
    c.textAlign = 'center';
    c.fillText(`HDG ${String(Math.round(d.headingDeg) % 360).padStart(3, '0')}`, cx, h * 0.85);
    c.font = '600 18px ui-monospace, Menlo, Consolas, monospace';
    c.fillText(`FUEL ${Math.round(d.fuelKg)} KG`, cx, h * 0.92);
    c.fillText(`${d.weapon.toUpperCase()}  GUN ${d.gunRounds}  SRM ${d.srm}  MRM ${d.mrm}  F ${d.flares} C ${d.chaff}`, cx, h * 0.975);
  }
}
