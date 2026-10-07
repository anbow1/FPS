import type { Radar, WarningReceiver } from '../sim/radar.ts';

// The two sensor displays, drawn on one 2D canvas in the top corners (clear of
// the HUD's centre and of the touch controls at the bottom):
//
//   radar (top left)  a B-scope: azimuth across (±60°), range up (0 at the
//                     bottom); the beam as a line, contacts as boxes with their
//                     altitude in thousands of feet, the designated one filled,
//                     the locked one ringed; mode and range scale on top.
//   RWR (top right)   a ring with the nose up; each emitter at its bearing as a
//                     letter in a shape: S in a square for search, T in a
//                     diamond for track, M in a flashing circle for a launch —
//                     a shape change, not only a colour (rules §8).
// These are the DOM stand-ins for the cockpit's multi-function displays.

const GREEN = 'rgba(96, 255, 140, 0.92)';
const DIM = 'rgba(96, 255, 140, 0.35)';
const BG = 'rgba(4, 12, 6, 0.55)';

export class SensorDisplays {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  visible = true;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the sensor displays');
    this.ctx = ctx;
  }

  draw(radar: Radar, rwr: WarningReceiver, ownAltM: number): void {
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
    const size = Math.max(130, Math.min(w, h) * 0.26);
    const pad = 12;
    this.drawRadar(radar, pad, pad, size, ownAltM);
    this.drawRwr(rwr, w - pad - size, pad, size);
  }

  private drawRadar(r: Radar, x: number, y: number, s: number, ownAltM: number): void {
    const c = this.ctx;
    const gimbal = r.spec.gimbalRad;
    c.fillStyle = BG;
    c.fillRect(x, y, s, s);
    c.strokeStyle = DIM;
    c.lineWidth = 1;
    c.strokeRect(x, y, s, s);
    // Grid: range quarters, azimuth every 30°.
    c.beginPath();
    for (let k = 1; k < 4; k++) {
      c.moveTo(x, y + (s * k) / 4);
      c.lineTo(x + s, y + (s * k) / 4);
    }
    for (const az of [-30, 0, 30]) {
      const gx = x + s / 2 + ((az * Math.PI) / 180 / gimbal) * (s / 2);
      c.moveTo(gx, y);
      c.lineTo(gx, y + s);
    }
    c.stroke();
    const toX = (az: number): number => x + s / 2 + (az / gimbal) * (s / 2);
    const toY = (range: number): number => y + s - Math.min(1, range / r.rangeScaleM) * s;
    // Beam.
    c.strokeStyle = GREEN;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(toX(r.beamAzRad), y + s);
    c.lineTo(toX(r.beamAzRad), y + s * 0.85);
    c.stroke();
    // Contacts.
    c.font = `${Math.round(s / 16)}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillStyle = GREEN;
    c.textBaseline = 'middle';
    for (const ct of r.contacts.values()) {
      if (ct.rangeM > r.rangeScaleM) continue;
      const cx = toX(ct.azRad);
      const cy = toY(ct.rangeM);
      const b = s / 40;
      const designated = ct.id === r.targetId;
      if (designated) c.fillRect(cx - b, cy - b, 2 * b, 2 * b);
      else c.strokeRect(cx - b, cy - b, 2 * b, 2 * b);
      if (designated && r.locked) {
        c.beginPath();
        c.arc(cx, cy, b * 2.4, 0, Math.PI * 2);
        c.stroke();
      }
      c.textAlign = 'left';
      c.fillText(String(Math.round((ct.position.y * 3.28084) / 1000)), cx + b * 1.8, cy);
    }
    // Header: mode, range scale; antenna elevation caret on the left edge.
    c.textAlign = 'left';
    c.fillText(r.mode === 'search' ? 'RWS' : r.mode === 'tws' ? 'TWS' : 'STT', x + 6, y + s / 14);
    c.textAlign = 'right';
    c.fillText(`${Math.round(r.rangeScaleM / 1852)}`, x + s - 6, y + s / 14);
    const elY = y + s / 2 - (r.antennaElRad / (Math.PI / 6)) * (s / 2);
    c.beginPath();
    c.moveTo(x, elY);
    c.lineTo(x + s / 25, elY);
    c.stroke();
    c.textAlign = 'left';
    c.fillText(`${Math.round((ownAltM * 3.28084) / 1000)}`, x + 6, y + s - s / 14);
  }

  private drawRwr(rwr: WarningReceiver, x: number, y: number, s: number): void {
    const c = this.ctx;
    const cx = x + s / 2;
    const cy = y + s / 2;
    const R = s * 0.42;
    c.fillStyle = BG;
    c.beginPath();
    c.arc(cx, cy, s / 2, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = DIM;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.moveTo(cx + R * 0.5, cy);
    c.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    c.stroke();
    // Own aircraft in the centre.
    c.strokeStyle = GREEN;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(cx, cy - 6);
    c.lineTo(cx, cy + 6);
    c.moveTo(cx - 6, cy);
    c.lineTo(cx + 6, cy);
    c.stroke();
    c.font = `${Math.round(s / 11)}px ui-monospace, Menlo, Consolas, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = GREEN;
    const flash = Math.floor(performance.now() / 180) % 2 === 0;
    for (const t of rwr.threats.values()) {
      // Search paints sit on the outer ring, tracks and launches closer in (more urgent).
      const rr = t.level === 'search' ? R * 0.85 : R * 0.6;
      const px = cx + Math.sin(t.bearingRad) * rr;
      const py = cy - Math.cos(t.bearingRad) * rr;
      const b = s / 14;
      c.beginPath();
      if (t.level === 'search') c.rect(px - b, py - b, 2 * b, 2 * b);
      else if (t.level === 'track') {
        c.moveTo(px, py - b * 1.3);
        c.lineTo(px + b * 1.3, py);
        c.lineTo(px, py + b * 1.3);
        c.lineTo(px - b * 1.3, py);
        c.closePath();
      } else if (flash) c.arc(px, py, b * 1.3, 0, Math.PI * 2);
      c.stroke();
      c.fillText(t.level === 'search' ? 'S' : t.level === 'track' ? 'T' : 'M', px, py);
    }
  }
}
