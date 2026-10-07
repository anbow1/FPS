import { texture, vec3 } from 'three/tsl';
import { BoxGeometry, type BufferGeometry, CanvasTexture, Group, LinearFilter, LinearMipmapLinearFilter, type Material, Mesh, MeshBasicNodeMaterial, PlaneGeometry, SRGBColorSpace } from 'three/webgpu';
import type { HeliConfig } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import type { Helicopter } from '../sim/helicopter.ts';
import { box, tube } from './airframe.ts';
import { plain } from './jetMaterials.ts';

// The pilot's station of the tandem cockpit, seen from the rear seat: an
// instrument panel low enough to see over the gunner, with two live displays
// and a narrow up-front display between them; the glare shield; side consoles;
// the cyclic between the knees and the collective under the left hand; and,
// ahead and below, the gunner's station with its big sight unit — the view
// past the gunner's helmet is what makes the rear seat feel like one.
//
// The displays are a 2-D canvas uploaded as a texture ~10 times a second:
//   left   engine and flight page: torque and rotor-speed tapes, turbine
//          temperature and fuel, an attitude ball;
//   right  tactical situation display: a shaded-relief map of the battle area
//          (baked once from the height grid), heading-up, with the river, the
//          base, the ground targets the sensor has seen (amber diamonds) and the
//          helicopter at the centre.
// Shown at a fixed output brightness, as an eye adapted to the cockpit sees
// them (the scene's single exposure would make them unreadable at noon).

const W = 512;
const H = 256;
const REDRAW_S = 0.1;
const DISPLAY_LEVEL = 1.25;
const MAP_PX = 512;

export interface MapSource {
  sizeM: number;
  heightAt(x: number, z: number): number;
  riverX(z: number): number;
  base: { x: number; z: number };
}

export class HeliCockpit {
  readonly root = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tex: CanvasTexture;
  private readonly relief = document.createElement('canvas');
  private sinceS = REDRAW_S;
  /** Ground contacts for the map page (world x, z), set by the game. */
  contacts: { x: number; z: number }[] = [];
  private readonly v = new Vec3();

  constructor(
    cfg: HeliConfig,
    private readonly map: MapSource,
  ) {
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the cockpit displays');
    this.ctx = ctx;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    // Mipmapped: seen from the seat the 512-pixel page shrinks to ~300 screen pixels, and without mips its
    // thin strokes alias differently under each frame's TRAA jitter — the text shimmered.
    this.tex.minFilter = LinearMipmapLinearFilter;
    this.tex.magFilter = LinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.anisotropy = 4;
    this.bakeRelief();

    const [ex, ey, ez] = cfg.pilotEye;
    const [, gy, gz] = cfg.gunnerEye;
    const shell = plain('cockpit grey', 0x2b2f31, 0.85);
    const black = plain('panel black', 0x121415, 0.7);
    const bezel = plain('bezel', 0x34383b, 0.6);
    const add = (g: BufferGeometry, m: Material, parent: Group = this.root): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Instrument panel, leaning back towards the pilot, two displays and the up-front display.
    const panel = new Group();
    panel.position.set(ex, ey - 0.46, ez - 0.58);
    panel.rotation.x = -0.42;
    this.root.add(panel);
    add(new BoxGeometry(0.8, 0.34, 0.05), black, panel);
    const screen = new MeshBasicNodeMaterial({ name: 'cockpit display' });
    screen.colorNode = texture(this.tex).rgb.mul(DISPLAY_LEVEL).add(vec3(0.002));
    const display = (x: number, u0: number, u1: number): void => {
      const g = new PlaneGeometry(0.2, 0.2);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
      const m = new Mesh(g, screen);
      // 4 mm proud of the bezel's face (z 0.034): flush, the two fought over the depth test and flickered.
      m.position.set(x, -0.01, 0.038);
      panel.add(m);
      // Bezel with the push-buttons round it.
      add(new BoxGeometry(0.25, 0.25, 0.012).translate(x, -0.01, 0.028), bezel, panel);
      for (let k = 0; k < 6; k++) {
        const t = -0.09 + k * 0.036;
        for (const [bx, by] of [
          [x + t, 0.115],
          [x + t, -0.135],
          [x - 0.118, t - 0.01],
          [x + 0.118, t - 0.01],
        ] as const)
          add(new BoxGeometry(0.018, 0.012, 0.01).translate(bx, by, 0.038), shell, panel);
      }
    };
    display(-0.205, 0, 0.5);
    display(0.205, 0.5, 1);
    add(new BoxGeometry(0.13, 0.06, 0.012).translate(0, 0.12, 0.03), bezel, panel);
    for (let k = 0; k < 6; k++) add(new BoxGeometry(0.02, 0.02, 0.012).translate(-0.05 + k * 0.02, -0.06, 0.035), shell, panel);
    // Glare shield over it.
    // A shallow hood: the pilot sees over it and the gunner's head to the ground ahead.
    add(box(-0.42, -0.03, -0.12, 0.42, 0.0, 0.06).translate(ex, ey - 0.27, ez - 0.7), black);
    // Side consoles and the cockpit walls under the sills.
    for (const side of [-1, 1]) {
      add(box(0.27, -0.72, -0.55, 0.47, -0.62, 0.45).scale(side, 1, 1).translate(ex, ey, ez), shell);
      for (let k = 0; k < 5; k++) add(new BoxGeometry(0.03, 0.012, 0.03).translate(ex + side * (0.31 + (k % 3) * 0.05), ey - 0.615, ez - 0.4 + k * 0.15), black);
      add(box(0.47, -0.95, -0.9, 0.5, -0.4, 0.6).scale(side, 1, 1).translate(ex, ey, ez), shell);
    }
    // Cyclic between the knees, collective under the left hand.
    add(
      tube(
        [
          [ex, ey - 1.05, ez - 0.32],
          [ex, ey - 0.62, ez - 0.4],
        ],
        0.018,
        8,
      ),
      black,
    );
    add(box(-0.025, 0, -0.03, 0.025, 0.11, 0.03).translate(ex, ey - 0.62, ez - 0.4), black);
    add(
      tube(
        [
          [ex - 0.36, ey - 0.78, ez + 0.15],
          [ex - 0.33, ey - 0.6, ez - 0.28],
        ],
        0.02,
        8,
      ),
      black,
    );
    add(box(-0.035, -0.03, -0.06, 0.035, 0.04, 0.06).translate(ex - 0.33, ey - 0.6, ez - 0.3), black);
    // Floor of the rear tub.
    add(box(-0.47, -1.15, -1.0, 0.47, -1.1, 0.5).translate(ex, ey, ez), black);

    // The gunner's station ahead: the sight unit in front of the seat, the panel, the coaming. The sight's
    // hood stays a hand's width under the gunner's eye line, so the gunner's view ahead is clear.
    add(box(-0.18, -0.3, -0.3, 0.18, 0.02, 0.05).translate(0, gy - 0.34, gz - 0.55), black);
    add(box(-0.12, -0.22, -0.22, 0.12, -0.0, -0.1).translate(0, gy - 0.14, gz - 0.55), bezel);
    add(box(-0.45, -0.3, -0.1, 0.45, 0.0, 0.0).translate(0, gy - 0.25, gz - 0.85), black);
    add(box(-0.47, -0.02, -0.6, 0.47, 0.03, 0.4).translate(0, gy - 0.45, gz - 0.5), shell);
  }

  /** Shaded relief of the battle area for the map display, baked once from the heights. */
  private bakeRelief(): void {
    const c = this.relief;
    c.width = MAP_PX;
    c.height = MAP_PX;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(MAP_PX, MAP_PX);
    const size = this.map.sizeM;
    const cell = size / MAP_PX;
    const h = (i: number, j: number): number => this.map.heightAt(-size / 2 + (i + 0.5) * cell, -size / 2 + (j + 0.5) * cell);
    for (let j = 0; j < MAP_PX; j++)
      for (let i = 0; i < MAP_PX; i++) {
        const hc = h(i, j);
        const dx = (h(Math.min(MAP_PX - 1, i + 1), j) - h(Math.max(0, i - 1), j)) / (2 * cell);
        const dz = (h(i, Math.min(MAP_PX - 1, j + 1)) - h(i, Math.max(0, j - 1))) / (2 * cell);
        const l = Math.hypot(dx, 1, dz);
        const shade = Math.max(0, (dx * 0.6 + 0.6 + dz * 0.52) / l);
        // Hypsometric tint: green valleys to brown ridges, then the relief shading.
        const t = Math.min(1, Math.max(0, (hc - 180) / 550));
        const k = (j * MAP_PX + i) * 4;
        img.data[k] = (40 + 70 * t) * (0.45 + 0.75 * shade);
        img.data[k + 1] = (70 + 30 * t) * (0.45 + 0.75 * shade);
        img.data[k + 2] = (40 + 20 * t) * (0.45 + 0.75 * shade);
        img.data[k + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    // The river.
    ctx.strokeStyle = 'rgb(70, 130, 200)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let j = 0; j <= MAP_PX; j += 2) {
      const z = -size / 2 + j * cell;
      const x = (this.map.riverX(z) + size / 2) / cell;
      if (j === 0) ctx.moveTo(x, j);
      else ctx.lineTo(x, j);
    }
    ctx.stroke();
  }

  update(h: Helicopter, frameS: number, visible: boolean): void {
    this.root.visible = visible;
    if (!visible) return;
    this.sinceS += frameS;
    if (this.sinceS < REDRAW_S) return;
    this.sinceS = 0;
    this.draw(h);
    this.tex.needsUpdate = true;
  }

  private draw(h: Helicopter): void {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#020403';
    c.fillRect(0, 0, W, H);
    this.enginePage(c, h);
    this.mapPage(c, h);
  }

  private enginePage(c: CanvasRenderingContext2D, h: Helicopter): void {
    const green = 'rgba(110, 255, 150, 0.95)';
    c.font = '600 15px ui-monospace, Menlo, Consolas, monospace';
    c.textBaseline = 'middle';
    // Torque and rotor speed tapes.
    const tape = (x: number, label: string, value: number, max: number, warn: (v: number) => boolean): void => {
      const y0 = 40;
      const hgt = 150;
      c.strokeStyle = green;
      c.strokeRect(x, y0, 26, hgt);
      c.fillStyle = warn(value) ? 'rgba(255, 190, 60, 0.95)' : green;
      const f = Math.min(1, Math.max(0, value / max));
      c.fillRect(x + 3, y0 + hgt * (1 - f), 20, hgt * f);
      c.fillStyle = green;
      c.textAlign = 'center';
      c.fillText(label, x + 13, y0 - 14);
      c.fillText(String(Math.round(value)), x + 13, y0 + hgt + 16);
    };
    tape(18, 'TQ', h.torquePct, 125, (v) => v > 100);
    tape(62, 'NR', h.rpmPct, 120, (v) => v < 94 || v > 108);
    // Turbine temperature from the power fraction (a game abstraction), fuel, regime.
    const power = h.engine.powerW / (h.cfg.engines * h.cfg.enginePowerW);
    c.textAlign = 'left';
    c.fillText(`TGT ${Math.round(h.engine.running ? 520 + power * 330 : 80)}°`, 104, 50);
    c.fillText(`FUEL ${Math.round(h.fuelKg)}`, 104, 74);
    c.fillText(h.engine.running ? 'ENG  RUN' : 'ENG  OUT', 104, 98);
    c.fillText(h.applied.sas ? 'SAS  ON' : 'SAS  OFF', 104, 122);
    // Attitude ball.
    const fwd = h.orientation.rotate(this.v.set(0, 0, -1));
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    const rightY = h.orientation.rotate(this.v.set(1, 0, 0)).y;
    const roll = Math.asin(Math.max(-1, Math.min(1, -rightY)));
    const cx = 196;
    const cy = 180;
    const r = 52;
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.clip();
    c.translate(cx, cy);
    c.rotate(-roll);
    const p = (pitch / (Math.PI / 4)) * r;
    c.fillStyle = '#245a8c';
    c.fillRect(-2 * r, -3 * r + p, 4 * r, 3 * r);
    c.fillStyle = '#5c4122';
    c.fillRect(-2 * r, p, 4 * r, 3 * r);
    c.restore();
    c.strokeStyle = '#ffd34a';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(cx - 30, cy);
    c.lineTo(cx - 10, cy);
    c.moveTo(cx + 10, cy);
    c.lineTo(cx + 30, cy);
    c.stroke();
    c.lineWidth = 1;
  }

  private mapPage(c: CanvasRenderingContext2D, h: Helicopter): void {
    const x0 = 256;
    const size = this.map.sizeM;
    const cell = size / MAP_PX;
    // Heading-up: rotate the map about the helicopter; 6 km across the display.
    const fwd = h.orientation.rotate(this.v.set(0, 0, -1));
    const heading = Math.atan2(fwd.x, -fwd.z);
    const scale = 256 / (6000 / cell);
    c.save();
    c.beginPath();
    c.rect(x0, 0, 256, 256);
    c.clip();
    c.translate(x0 + 128, 150);
    c.rotate(-heading);
    c.scale(scale, scale);
    c.translate(-(h.position.x + size / 2) / cell, -(h.position.z + size / 2) / cell);
    c.drawImage(this.relief, 0, 0);
    // The base.
    const bx = (this.map.base.x + size / 2) / cell;
    const bz = (this.map.base.z + size / 2) / cell;
    c.strokeStyle = 'rgb(110, 255, 150)';
    c.lineWidth = 2 / scale;
    c.strokeRect(bx - 5, bz - 5, 10, 10);
    // Contacts: amber diamonds, a constant size on the display whatever the map scale.
    c.strokeStyle = 'rgb(255, 196, 70)';
    const d = 5 / scale;
    for (const t of this.contacts) {
      const tx = (t.x + size / 2) / cell;
      const tz = (t.z + size / 2) / cell;
      c.beginPath();
      c.moveTo(tx, tz - d);
      c.lineTo(tx + d, tz);
      c.lineTo(tx, tz + d);
      c.lineTo(tx - d, tz);
      c.closePath();
      c.stroke();
    }
    c.restore();
    // Own ship at the centre, the heading scale above.
    c.strokeStyle = 'rgb(255, 255, 255)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x0 + 128, 140);
    c.lineTo(x0 + 120, 160);
    c.moveTo(x0 + 128, 140);
    c.lineTo(x0 + 136, 160);
    c.stroke();
    c.fillStyle = 'rgba(110, 255, 150, 0.95)';
    c.font = '600 14px ui-monospace, Menlo, Consolas, monospace';
    c.textAlign = 'center';
    c.fillText(`${String(Math.round(((heading * 180) / Math.PI + 360) % 360)).padStart(3, '0')}`, x0 + 128, 14);
    c.textAlign = 'left';
    c.fillText('TSD  6 KM', x0 + 6, 244);
  }
}
