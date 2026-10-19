import { texture, vec3 } from 'three/tsl';
import { CanvasTexture, Group, LinearFilter, MeshBasicNodeMaterial, type Quaternion, SRGBColorSpace, Vector3 } from 'three/webgpu';
import type { AircraftId } from '../config.ts';
import type { Radar, WarningReceiver } from '../sim/radar.ts';
import { drawRadarScope, drawRwrScope } from '../ui/sensors.ts';
import { buildOffice } from './cockpitModel.ts';

// The pilot's office, seen from the eye point: the modelled cockpit
// (cockpitModel.ts — tub, sills, glare shield, HUD, panels, consoles, the
// pilot's legs) and what lives in it. It is what turns the cockpit camera from
// a floating eye into a seat, and it fixes the over-the-nose view (~15° below
// the horizon line).
//
// The displays are live: one 2-D canvas, redrawn ~15 times a second and
// uploaded as a texture, carries the radar B-scope, the threat ring and a
// flight page. The stealth type has one panoramic screen and no HUD (its
// symbology is helmet-mounted, so the HUD layer stays unclipped); the other
// type has two square displays and a combiner glass that clips the HUD.

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

    // The displays show the shared canvas: the radar on the left, the threat ring on the right, or the whole
    // strip on the stealth type's one wide screen.
    const screen = new MeshBasicNodeMaterial({ name: 'cockpit display' });
    screen.colorNode = texture(this.tex).rgb.mul(DISPLAY_LEVEL).add(vec3(0.002));
    const square = 0.135;
    const office = buildOffice(kind, screen, {
      left: { w: square, h: square, x: 0, y: 0, u0: 0, u1: CANVAS_H / CANVAS_W },
      right: { w: square, h: square, x: 0, y: 0, u0: 1 - CANVAS_H / CANVAS_W, u1: 1 },
      wide: { w: 0.5, h: 0.195, x: 0, y: 0, u0: 0, u1: 1 },
    });
    office.group.position.copy(this.eye);
    this.root.add(office.group);
    this.root.visible = false;
    this.combiner = office.combiner;
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
