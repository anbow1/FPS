import { type PerspectiveCamera, Vector3 } from 'three/webgpu';
import { Vec3 } from '../core/vec.ts';
import type { Helicopter, HeliInput } from '../sim/helicopter.ts';

// The helicopter symbology (hud-layout-reference.png, helicopter panel), drawn
// on a 2-D canvas over the view. It is the monocle a pilot wears: it stays on
// the screen, while the horizon and pitch ladder are projected through the
// camera so they lie on the real horizon.
//
//   left    torque %, rotor RPM %, a collective position bar;
//   right   radar altitude (big below 60 m, with an analogue bar), vertical
//           speed, airspeed;
//   top     heading tape; sensor and designation state;
//   centre  the hover cue: a velocity vector from the aircraft symbol in plan
//           view (up = forward drift, right = right drift; the ring is 5 m/s),
//           with an acceleration ball at its end — put the ball on the
//           centre and the drift stops. Precise hovering is the core skill;
//   bottom  SAS, engines, selected weapon;
//   warnings distinct shapes: a flashing box for rotor RPM and torque, a
//           triangle for the vortex ring, a diamond for engine out and fuel.

const GREEN = 'rgba(110, 255, 150, 0.92)';
const AMBER = 'rgba(255, 196, 70, 0.95)';
const RED = 'rgba(255, 90, 70, 0.95)';
const DEG = 180 / Math.PI;
const KT = 1.943_84;
const FT = 3.280_84;

export interface HudExtras {
  /** Sensor state and designation line, top centre. */
  sensor: string;
  weapon: string;
  message: string;
  aim?: HudAim;
}

/** The weapon symbology, in world positions (projected through the camera). */
export interface HudAim {
  weapon: 'gun' | 'rockets' | 'missile';
  /** Where the gun's rounds go: the sight line's point on the ground. */
  gunPoint: Vector3 | null;
  /** Where rockets fired now would land. */
  rocketCue: Vector3 | null;
  /** The target the missile seeker holds. */
  lock: Vector3 | null;
  /** Targets in view of the sensor (in range and not behind terrain). */
  targets: Vector3[];
  /** A weapon caution (gun hot, no lock, empty), shown under the reticles. */
  warning: string;
}

export class Hud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  visible = true;
  /** Narrower layout that keeps clear of the on-screen buttons. */
  touchLayout = false;
  private readonly fwd = new Vector3();
  private readonly nose = new Vec3();
  private readonly tmp = new Vector3();
  private readonly prevVel = { x: 0, z: 0, t: 0 };
  private readonly accel = { x: 0, z: 0 };

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the HUD');
    this.ctx = ctx;
  }

  draw(camera: PerspectiveCamera, h: Helicopter, input: HeliInput, extras: HudExtras, frameS: number): void {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr) || this.dpr !== dpr) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hgt * dpr);
      this.dpr = dpr;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.visible) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const areaW = Math.min(w, (hgt * 16) / 9);
    const size = Math.max(0.55, areaW / 1280);
    const cx = w / 2;
    const cy = hgt / 2;
    const side = this.touchLayout ? 0.24 : 0.3;
    c.strokeStyle = GREEN;
    c.fillStyle = GREEN;
    c.lineWidth = Math.max(1.2, 1.6 * size);
    c.font = `${Math.round(15 * size + 4)}px ui-monospace, Menlo, Consolas, monospace`;
    c.textBaseline = 'middle';

    // ---- heading
    const o = h.orientation;
    const nose = o.rotate(this.nose.set(0, 0, -1));
    const heading = (((Math.atan2(nose.x, -nose.z) * DEG + 360) % 360) + 360) % 360;
    this.headingTape(cx, hgt * (this.touchLayout ? 0.15 : 0.1), heading, size);
    c.textAlign = 'center';
    c.fillText(extras.sensor, cx, hgt * (this.touchLayout ? 0.15 : 0.1) + 40 * size);

    // ---- horizon line and pitch ladder, through the camera
    this.horizon(camera, w, hgt, size);

    // ---- left: torque, rotor, collective
    const lx = cx - areaW * side;
    c.textAlign = 'right';
    const torqueWarn = h.torquePct > 100;
    c.fillStyle = torqueWarn ? AMBER : GREEN;
    c.fillText(`${Math.round(h.torquePct)}%`, lx, cy - 40 * size);
    c.fillStyle = GREEN;
    c.font = `${Math.round(11 * size + 3)}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillText('TQ', lx - 62 * size, cy - 40 * size);
    c.fillText('NR', lx - 62 * size, cy - 10 * size);
    c.font = `${Math.round(15 * size + 4)}px ui-monospace, Menlo, Consolas, monospace`;
    const rpmWarn = h.rpmPct < 94 || h.rpmPct > 108;
    c.fillStyle = rpmWarn ? AMBER : GREEN;
    c.fillText(`${Math.round(h.rpmPct)}%`, lx, cy - 10 * size);
    c.fillStyle = GREEN;
    // Collective bar.
    const barH = 120 * size;
    const barX = lx + 14 * size;
    c.strokeRect(barX, cy - barH / 2, 8 * size, barH);
    c.fillRect(barX, cy + barH / 2 - barH * input.collective, 8 * size, barH * input.collective);

    // ---- right: radar altitude, vertical speed, airspeed
    const rx = cx + areaW * side;
    c.textAlign = 'left';
    const ra = h.radarAltitudeM;
    c.font = `${Math.round((ra < 60 ? 22 : 16) * size + 4)}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillText(`${Math.round(ra * FT)}`, rx, cy - 40 * size);
    c.font = `${Math.round(11 * size + 3)}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillText('R', rx - 16 * size, cy - 40 * size);
    c.font = `${Math.round(15 * size + 4)}px ui-monospace, Menlo, Consolas, monospace`;
    // Radar altitude bar (0–200 ft), the zone where it matters.
    const raBar = Math.min(1, (ra * FT) / 200);
    c.strokeRect(rx - 30 * size, cy - barH / 2, 8 * size, barH);
    c.fillRect(rx - 30 * size, cy + barH / 2 - barH * raBar, 8 * size, barH * raBar);
    // Vertical speed (ft/min) with a small caret tape.
    const vsFpm = h.verticalSpeedMs * FT * 60;
    c.fillText(`${vsFpm >= 0 ? '+' : ''}${Math.round(vsFpm / 10) * 10}`, rx, cy - 10 * size);
    c.beginPath();
    const vsY = cy + 30 * size - Math.max(-1, Math.min(1, vsFpm / 1000)) * 25 * size;
    c.moveTo(rx, vsY);
    c.lineTo(rx + 8 * size, vsY - 5 * size);
    c.lineTo(rx + 8 * size, vsY + 5 * size);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(rx + 12 * size, cy + 5 * size);
    c.lineTo(rx + 12 * size, cy + 55 * size);
    c.moveTo(rx + 9 * size, cy + 30 * size);
    c.lineTo(rx + 15 * size, cy + 30 * size);
    c.stroke();
    c.fillText(`${Math.round(h.airspeedMs * KT)}`, rx, cy + 75 * size);
    c.font = `${Math.round(11 * size + 3)}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillText('KT', rx + 46 * size, cy + 75 * size);
    c.font = `${Math.round(15 * size + 4)}px ui-monospace, Menlo, Consolas, monospace`;

    // ---- centre: the hover cue
    this.hoverCue(h, cx, cy, size, nose, frameS);

    // ---- bottom: systems and weapon
    c.textAlign = 'center';
    const by = hgt * (this.touchLayout ? 0.84 : 0.88);
    c.fillText(`${input.sas ? 'SAS' : 'SAS OFF'}   ${extras.weapon}`, cx, by);

    // ---- warnings
    const flash = Math.floor(performance.now() / 300) % 2 === 0;
    const warns: { text: string; shape: 'box' | 'tri' | 'diamond'; colour: string }[] = [];
    if (h.rpmPct < 92 && !h.onGround) warns.push({ text: 'ROTOR LOW', shape: 'box', colour: RED });
    if (h.rpmPct > 110) warns.push({ text: 'ROTOR HIGH', shape: 'box', colour: AMBER });
    if (h.torquePct > 105) warns.push({ text: 'TORQUE', shape: 'box', colour: AMBER });
    if (h.rotor.vortexRing > 0.3) warns.push({ text: 'VORTEX RING', shape: 'tri', colour: RED });
    if (h.rotor.bladeStall > 0.3) warns.push({ text: 'BLADE STALL', shape: 'tri', colour: RED });
    if (!h.engine.running) warns.push({ text: 'ENGINE OUT', shape: 'diamond', colour: RED });
    if (h.fuelKg < 150) warns.push({ text: 'FUEL LOW', shape: 'diamond', colour: AMBER });
    warns.forEach((wn, i) => {
      if (!flash && wn.colour === RED) return;
      const y = hgt * 0.27 + i * 30 * size;
      c.strokeStyle = wn.colour;
      c.fillStyle = wn.colour;
      c.textAlign = 'center';
      c.fillText(wn.text, cx, y);
      const tw = c.measureText(wn.text).width / 2 + 10 * size;
      c.beginPath();
      if (wn.shape === 'box') c.rect(cx - tw, y - 12 * size, tw * 2, 24 * size);
      else if (wn.shape === 'tri') {
        c.moveTo(cx - tw - 14 * size, y + 12 * size);
        c.lineTo(cx, y - 18 * size);
        c.lineTo(cx + tw + 14 * size, y + 12 * size);
        c.closePath();
      } else {
        c.moveTo(cx - tw - 12 * size, y);
        c.lineTo(cx, y - 16 * size);
        c.lineTo(cx + tw + 12 * size, y);
        c.lineTo(cx, y + 16 * size);
        c.closePath();
      }
      c.stroke();
    });
    c.strokeStyle = GREEN;
    c.fillStyle = GREEN;
    if (extras.aim) this.weaponSymbols(camera, extras.aim, w, hgt, size);
    if (extras.message) {
      c.textAlign = 'center';
      c.font = `${Math.round(24 * size + 4)}px ui-monospace, Menlo, Consolas, monospace`;
      c.fillText(extras.message, cx, hgt * 0.36);
    }
  }

  private hoverCue(h: Helicopter, cx: number, cy: number, size: number, nose: { x: number; z: number }, frameS: number): void {
    const c = this.ctx;
    // Ground velocity in heading axes: forward along the nose's plan direction, right across it.
    const fl = Math.hypot(nose.x, nose.z) || 1;
    const fx = nose.x / fl;
    const fz = nose.z / fl;
    const vx = h.velocity.x;
    const vz = h.velocity.z;
    const fwd = vx * fx + vz * fz;
    const right = vx * -fz + vz * fx;
    // Acceleration, smoothed (the derivative of a 60 Hz state is noisy).
    const now = performance.now() / 1000;
    const dt = Math.max(1e-3, now - this.prevVel.t);
    if (this.prevVel.t > 0 && dt < 0.5) {
      const k = Math.min(1, frameS * 4);
      this.accel.x += ((right - this.prevVel.x) / dt - this.accel.x) * k;
      this.accel.z += ((fwd - this.prevVel.z) / dt - this.accel.z) * k;
    }
    this.prevVel.x = right;
    this.prevVel.z = fwd;
    this.prevVel.t = now;
    // Scale: the ring is 5 m/s; the vector saturates at 10.
    const R = 60 * size;
    const s = R / 5;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.setLineDash([4 * size, 6 * size]);
    c.stroke();
    c.setLineDash([]);
    // Aircraft symbol.
    c.beginPath();
    c.moveTo(cx - 22 * size, cy);
    c.lineTo(cx - 8 * size, cy);
    c.moveTo(cx + 8 * size, cy);
    c.lineTo(cx + 22 * size, cy);
    c.moveTo(cx, cy - 8 * size);
    c.lineTo(cx, cy - 16 * size);
    c.stroke();
    const sat = (v: number): number => Math.max(-10, Math.min(10, v));
    const ex = cx + sat(right) * s;
    const ey = cy - sat(fwd) * s;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(ex, ey);
    c.stroke();
    // Acceleration ball: where the vector is heading over the next ~1.5 s.
    const ax = ex + Math.max(-6, Math.min(6, this.accel.x * 1.5)) * s;
    const ay = ey - Math.max(-6, Math.min(6, this.accel.z * 1.5)) * s;
    c.beginPath();
    c.arc(ax, ay, 6 * size, 0, Math.PI * 2);
    c.stroke();
  }

  /** Screen position of a world point, or null if it is behind the camera. */
  private toScreen(camera: PerspectiveCamera, p: Vector3, w: number, hgt: number): { x: number; y: number } | null {
    this.tmp.copy(p).applyMatrix4(camera.matrixWorldInverse);
    if (this.tmp.z > -0.5) return null;
    this.tmp.copy(p).project(camera);
    return { x: ((this.tmp.x + 1) / 2) * w, y: ((1 - this.tmp.y) / 2) * hgt };
  }

  /**
   * Weapon reticles: target markers (diamonds) for what the sensor sees; the gun cross where the turret's
   * rounds will land; the rocket cue (a ring with a dot) where a ripple fired now would come down — fly it
   * onto the target; the missile seeker box on the locked target.
   */
  private weaponSymbols(camera: PerspectiveCamera, a: HudAim, w: number, hgt: number, size: number): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = AMBER;
    c.lineWidth = Math.max(1.2, 1.4 * size);
    for (const t of a.targets) {
      const s = this.toScreen(camera, t, w, hgt);
      if (!s) continue;
      const r = 7 * size;
      c.beginPath();
      c.moveTo(s.x, s.y - r);
      c.lineTo(s.x + r, s.y);
      c.lineTo(s.x, s.y + r);
      c.lineTo(s.x - r, s.y);
      c.closePath();
      c.stroke();
    }
    c.strokeStyle = GREEN;
    c.fillStyle = GREEN;
    c.lineWidth = Math.max(1.4, 1.8 * size);
    if (a.weapon === 'gun' && a.gunPoint) {
      const s = this.toScreen(camera, a.gunPoint, w, hgt);
      if (s) {
        const r = 16 * size;
        const g = 5 * size;
        c.beginPath();
        c.moveTo(s.x - r, s.y);
        c.lineTo(s.x - g, s.y);
        c.moveTo(s.x + g, s.y);
        c.lineTo(s.x + r, s.y);
        c.moveTo(s.x, s.y - r);
        c.lineTo(s.x, s.y - g);
        c.moveTo(s.x, s.y + g);
        c.lineTo(s.x, s.y + r);
        c.stroke();
      }
    }
    if (a.weapon === 'rockets' && a.rocketCue) {
      const s = this.toScreen(camera, a.rocketCue, w, hgt);
      if (s) {
        c.beginPath();
        c.arc(s.x, s.y, 14 * size, 0, Math.PI * 2);
        c.stroke();
        c.beginPath();
        c.arc(s.x, s.y, 2.2 * size, 0, Math.PI * 2);
        c.fill();
      }
    }
    if (a.weapon === 'missile') {
      const s = a.lock ? this.toScreen(camera, a.lock, w, hgt) : null;
      if (s) {
        const r = 14 * size;
        c.strokeRect(s.x - r, s.y - r, 2 * r, 2 * r);
        c.textAlign = 'center';
        c.fillText('LOCK', s.x, s.y - r - 8 * size);
      } else {
        // The seeker's field: a dashed box in the middle of the view — put a target in it.
        const r = 34 * size;
        c.setLineDash([6 * size, 6 * size]);
        c.strokeRect(w / 2 - r, hgt / 2 - r, 2 * r, 2 * r);
        c.setLineDash([]);
      }
    }
    if (a.warning) {
      c.fillStyle = AMBER;
      c.textAlign = 'center';
      c.fillText(a.warning, w / 2, hgt * (this.touchLayout ? 0.79 : 0.83));
    }
    c.restore();
  }

  private horizon(camera: PerspectiveCamera, w: number, hgt: number, size: number): void {
    const c = this.ctx;
    camera.getWorldDirection(this.fwd);
    const yaw = Math.atan2(this.fwd.x, this.fwd.z);
    const proj = (pitchDeg: number, offsetRad: number): { x: number; y: number } | null => {
      const p = (pitchDeg * Math.PI) / 180;
      const a = yaw + offsetRad;
      this.tmp
        .set(Math.sin(a) * Math.cos(p), Math.sin(p), Math.cos(a) * Math.cos(p))
        .multiplyScalar(1000)
        .add(camera.position);
      this.tmp.project(camera);
      if (this.tmp.z > 1 || this.tmp.z < -1) return null;
      return { x: ((this.tmp.x + 1) / 2) * w, y: ((1 - this.tmp.y) / 2) * hgt };
    };
    c.save();
    c.globalAlpha = 0.75;
    for (const deg of [-20, -10, 0, 10, 20]) {
      const span = deg === 0 ? 0.35 : 0.08;
      const gap = deg === 0 ? 0.09 : 0.03;
      const l0 = proj(deg, -span);
      const l1 = proj(deg, -gap);
      const r0 = proj(deg, gap);
      const r1 = proj(deg, span);
      if (!l0 || !l1 || !r0 || !r1) continue;
      c.beginPath();
      if (deg < 0) c.setLineDash([6 * size, 5 * size]);
      c.moveTo(l0.x, l0.y);
      c.lineTo(l1.x, l1.y);
      c.moveTo(r0.x, r0.y);
      c.lineTo(r1.x, r1.y);
      c.stroke();
      c.setLineDash([]);
      if (deg !== 0) {
        c.textAlign = 'left';
        c.fillText(String(Math.abs(deg)), r1.x + 6 * size, r1.y);
      }
    }
    c.restore();
  }

  private headingTape(cx: number, y: number, heading: number, size: number): void {
    const c = this.ctx;
    const pxPerDeg = 5 * size;
    const half = 40;
    c.textAlign = 'center';
    c.beginPath();
    for (let d = Math.ceil((heading - half) / 5) * 5; d <= heading + half; d += 5) {
      const x = cx + (d - heading) * pxPerDeg;
      const major = ((d % 10) + 10) % 10 === 0;
      c.moveTo(x, y + 8 * size);
      c.lineTo(x, y + (major ? 2 : 5) * size);
      if (major) {
        const hd = ((d % 360) + 360) % 360;
        const label = hd === 0 ? 'N' : hd === 90 ? 'E' : hd === 180 ? 'S' : hd === 270 ? 'W' : String(hd / 10).padStart(2, '0');
        c.fillText(label, x, y - 8 * size);
      }
    }
    c.moveTo(cx, y + 12 * size);
    c.lineTo(cx - 5 * size, y + 20 * size);
    c.moveTo(cx, y + 12 * size);
    c.lineTo(cx + 5 * size, y + 20 * size);
    c.stroke();
  }
}
