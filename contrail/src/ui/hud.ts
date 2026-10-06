import { type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import type { Aircraft } from '../sim/aircraft.ts';
import type { PilotInput } from '../sim/controlLaws.ts';
import { ISA } from '../config.ts';

// Head-up display (brief §HUD, hud-layout-reference.png, jet panel). Green
// stroke, vector drawn on a 2D canvas over the frame (never bloomed), crisp at
// the device pixel ratio. Collimated: every symbol that means a direction is
// drawn where that world direction projects through the camera, so the
// flight-path marker sits on the true velocity vector, the pitch ladder on the
// real horizon, the waterline on the nose — in a slip, a climb or a bank. In
// the cockpit it is clipped to the combiner glass; outside it is drawn over
// the whole view. The centre zone (30 % of the width) holds symbols only.

const GREEN = 'rgba(96, 255, 140, 0.92)';
const KNOTS_PER_MS = 1.943_84;
const FEET_PER_M = 3.280_84;
const DEG = 180 / Math.PI;

export interface HudExtras {
  /** Radar altitude above the ground below (m). */
  radarAltitudeM: number;
  weaponMode: string;
  stores: string;
  warnings: string[];
}

export class Hud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tmp = new Vector3();
  private readonly fwd = new Vector3();
  private readonly up = new Vector3();
  private readonly right = new Vector3();
  private readonly camFwd = new Vector3();
  private readonly attitude = new Quaternion();
  private dpr = 1;
  visible = true;
  /** In the cockpit the HUD is clipped to the combiner glass. */
  clipToCombiner = false;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the HUD');
    this.ctx = ctx;
  }

  draw(camera: PerspectiveCamera, ac: Aircraft, input: PilotInput, extras: HudExtras): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr) || this.dpr !== dpr) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.dpr = dpr;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.visible) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Anchor to the centred 16:9 area on ultra-wide screens (rules §8).
    const areaW = Math.min(w, (h * 16) / 9);
    const size = areaW / 1280;
    // Layout: over the whole view outside, compressed into the combiner glass in the cockpit.
    const inGlass = this.clipToCombiner;
    const tapeOff = inGlass ? 0.15 : 0.3;
    const cornerOff = inGlass ? 0.17 : 0.4;
    const cornerY = inGlass ? h * 0.6 : h * 0.8;
    const headingY = inGlass ? h * 0.2 : h * 0.11;
    c.strokeStyle = GREEN;
    c.fillStyle = GREEN;
    c.lineWidth = Math.max(1.2, 1.6 * size);
    c.font = `${Math.round(15 * size + 4)}px ui-monospace, Menlo, Consolas, monospace`;
    c.textBaseline = 'middle';
    c.save();
    if (this.clipToCombiner) {
      c.beginPath();
      c.roundRect(w / 2 - areaW * 0.2, h * 0.16, areaW * 0.4, h * 0.56, 12);
      c.clip();
    }

    // Attitude from the aircraft's orientation (body −z = nose).
    const o = ac.orientation;
    this.attitude.set(o.x, o.y, o.z, o.w);
    this.fwd.set(0, 0, -1).applyQuaternion(this.attitude);
    this.up.set(0, 1, 0).applyQuaternion(this.attitude);
    this.right.set(1, 0, 0).applyQuaternion(this.attitude);
    camera.getWorldDirection(this.camFwd);
    const headingDeg = (Math.atan2(this.fwd.x, -this.fwd.z) * DEG + 360) % 360;
    const v = ac.velocity;
    const speed = Math.max(v.length(), 1e-3);
    const pathAzimuth = Math.atan2(v.x, -v.z);

    // Pitch ladder: lines every 5° at the velocity's azimuth, so the ladder slides with the FPM.
    for (let deg = -85; deg <= 85; deg += 5) {
      const el = deg / DEG;
      const centre = this.projectDir(camera, Math.sin(pathAzimuth) * Math.cos(el), Math.sin(el), -Math.cos(pathAzimuth) * Math.cos(el));
      if (!centre) continue;
      const side = this.projectDir(camera, Math.sin(pathAzimuth + 0.02) * Math.cos(el), Math.sin(el), -Math.cos(pathAzimuth + 0.02) * Math.cos(el));
      if (!side) continue;
      let dx = side.x - centre.x;
      let dy = side.y - centre.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const halfLen = (deg === 0 ? 260 : 70) * size;
      const gap = 32 * size;
      c.setLineDash(deg < 0 ? [8 * size, 6 * size] : []);
      c.beginPath();
      for (const s of [-1, 1]) {
        c.moveTo(centre.x + dx * gap * s, centre.y + dy * gap * s);
        c.lineTo(centre.x + dx * halfLen * s, centre.y + dy * halfLen * s);
        if (deg !== 0) {
          // End ticks point towards the horizon.
          const tick = (deg > 0 ? 10 : -10) * size;
          c.lineTo(centre.x + dx * halfLen * s - dy * -tick, centre.y + dy * halfLen * s + dx * -tick);
        }
      }
      c.stroke();
      c.setLineDash([]);
      if (deg !== 0 && Math.hypot(centre.x - w / 2, centre.y - h / 2) > areaW * 0.15) {
        c.textAlign = 'left';
        c.fillText(String(Math.abs(deg)), centre.x + dx * (halfLen + 8 * size), centre.y + dy * (halfLen + 8 * size));
      }
    }

    // Waterline (the nose) and the flight-path marker (the true velocity).
    const nose = this.projectDir(camera, this.fwd.x, this.fwd.y, this.fwd.z);
    if (nose) {
      const s = 12 * size;
      c.beginPath();
      c.moveTo(nose.x - 3 * s, nose.y);
      c.lineTo(nose.x - 1.5 * s, nose.y);
      c.lineTo(nose.x - 0.75 * s, nose.y + s);
      c.lineTo(nose.x, nose.y);
      c.lineTo(nose.x + 0.75 * s, nose.y + s);
      c.lineTo(nose.x + 1.5 * s, nose.y);
      c.lineTo(nose.x + 3 * s, nose.y);
      c.stroke();
    }
    if (speed > 15) {
      const fpm = this.projectDir(camera, v.x / speed, v.y / speed, v.z / speed);
      if (fpm) {
        const r = 8 * size;
        c.beginPath();
        c.arc(fpm.x, fpm.y, r, 0, Math.PI * 2);
        c.moveTo(fpm.x - r, fpm.y);
        c.lineTo(fpm.x - r * 2.6, fpm.y);
        c.moveTo(fpm.x + r, fpm.y);
        c.lineTo(fpm.x + r * 2.6, fpm.y);
        c.moveTo(fpm.x, fpm.y - r);
        c.lineTo(fpm.x, fpm.y - r * 2);
        c.stroke();
      }
    }

    // Tapes: calibrated (equivalent) airspeed left, altitude right, heading top.
    const easKt = speed * Math.sqrt(ac.air.densityKgM3 / ISA.seaLevelDensityKgM3) * KNOTS_PER_MS;
    this.tape(w / 2 - areaW * tapeOff, h * 0.5, easKt, 10, 50, 3.2 * size, 'left', size);
    c.textAlign = 'center';
    c.fillText(`M ${ac.mach.toFixed(2)}`, w / 2 - areaW * tapeOff, h * 0.5 + 150 * size);
    const altFt = ac.position.y * FEET_PER_M;
    this.tape(w / 2 + areaW * tapeOff, h * 0.5, altFt, 100, 500, 0.34 * size, 'right', size);
    if (extras.radarAltitudeM < 500) c.fillText(`R ${Math.round(extras.radarAltitudeM * FEET_PER_M)}`, w / 2 + areaW * tapeOff, h * 0.5 + 150 * size);
    // Vertical speed bar beside the altitude tape (±6000 ft/min full scale).
    const vsiFpm = v.y * FEET_PER_M * 60;
    const vsiH = Math.max(-1, Math.min(1, vsiFpm / 6000)) * 120 * size;
    c.beginPath();
    c.moveTo(w / 2 + areaW * tapeOff + 70 * size, h * 0.5);
    c.lineTo(w / 2 + areaW * tapeOff + 70 * size, h * 0.5 - vsiH);
    c.stroke();
    this.headingTape(w / 2, headingY, headingDeg, size);

    // Corners: G and AoA bottom left, fuel, stores and weapon bottom right.
    c.textAlign = 'left';
    const bl = w / 2 - areaW * cornerOff;
    c.fillText(`G ${ac.loadFactor.toFixed(1)}`, bl, cornerY);
    c.fillText(`α ${(ac.alphaRad * DEG).toFixed(1)}`, bl, cornerY + 22 * size);
    c.fillText(`THR ${Math.round(Math.min(input.throttle, 1) * 100)}${ac.engine.burner > 0.02 ? ' AB' : ''}`, bl, cornerY + 44 * size);
    c.textAlign = 'right';
    const br = w / 2 + areaW * cornerOff;
    c.fillText(`FUEL ${Math.round(ac.fuelKg)}`, br, cornerY);
    c.fillText(extras.stores, br, cornerY + 22 * size);
    c.strokeRect(br - 70 * size, cornerY + 33 * size, 70 * size, 22 * size);
    c.fillText(extras.weaponMode, br - 8 * size, cornerY + 44 * size);
    // Warnings: a boxed word per warning, a shape change and not only a colour (rules §8).
    c.textAlign = 'center';
    extras.warnings.forEach((text, i) => {
      const y = h * 0.27 + i * 26 * size;
      const tw = c.measureText(text).width + 16 * size;
      c.strokeRect(w / 2 - tw / 2 + areaW * 0.2, y - 11 * size, tw, 22 * size);
      c.fillText(text, w / 2 + areaW * 0.2, y);
    });
    c.restore();
  }

  /** Screen position (CSS px) of a world direction from the camera, or null behind it. */
  private projectDir(camera: PerspectiveCamera, dx: number, dy: number, dz: number): { x: number; y: number } | null {
    // Behind or beside the camera: not drawn (project() would mirror it).
    if (dx * this.camFwd.x + dy * this.camFwd.y + dz * this.camFwd.z < 0.05) return null;
    const t = this.tmp.set(dx, dy, dz).multiplyScalar(10_000).add(camera.position).project(camera);
    return { x: ((t.x + 1) / 2) * window.innerWidth, y: ((1 - t.y) / 2) * window.innerHeight };
  }

  private tape(cx: number, cy: number, value: number, minorStep: number, labelStep: number, pxPerUnit: number, side: 'left' | 'right', size: number): void {
    const c = this.ctx;
    const halfH = 130 * size;
    const dir = side === 'left' ? -1 : 1;
    c.beginPath();
    const first = Math.floor((value - halfH / pxPerUnit) / minorStep) * minorStep;
    for (let u = first; u <= value + halfH / pxPerUnit; u += minorStep) {
      const y = cy - (u - value) * pxPerUnit;
      if (Math.abs(y - cy) > halfH) continue;
      const major = Math.abs(u % labelStep) < 1e-6;
      c.moveTo(cx + dir * 30 * size, y);
      c.lineTo(cx + dir * (major ? 44 : 38) * size, y);
      if (major && Math.abs(y - cy) > 14 * size) {
        c.textAlign = side === 'left' ? 'right' : 'left';
        c.fillText(String(Math.round(u)), cx + dir * 50 * size, y);
      }
    }
    c.stroke();
    // Current value box.
    c.textAlign = 'center';
    c.strokeRect(cx - 34 * size, cy - 12 * size, 68 * size, 24 * size);
    c.fillText(String(Math.round(value)), cx, cy);
  }

  private headingTape(cx: number, cy: number, headingDeg: number, size: number): void {
    const c = this.ctx;
    const pxPerDeg = 6 * size;
    c.beginPath();
    c.textAlign = 'center';
    for (let d = Math.floor(headingDeg - 30); d <= headingDeg + 30; d++) {
      if (d % 5 !== 0) continue;
      const x = cx + (d - headingDeg) * pxPerDeg;
      const major = d % 10 === 0;
      c.moveTo(x, cy);
      c.lineTo(x, cy + (major ? 10 : 6) * size);
      if (major) c.fillText(String(((d % 360) + 360) % 360 / 10).padStart(2, '0'), x, cy - 10 * size);
    }
    c.moveTo(cx, cy + 14 * size);
    c.lineTo(cx - 6 * size, cy + 22 * size);
    c.moveTo(cx, cy + 14 * size);
    c.lineTo(cx + 6 * size, cy + 22 * size);
    c.stroke();
  }
}
