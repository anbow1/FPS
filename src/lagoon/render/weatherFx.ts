import { attribute, cameraPosition, cross, Discard, float, Fn, If, max, mod, normalize, positionWorld, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, type Camera, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { GRAPHICS } from '../config.ts';
import type { LagoonGame } from '../game/game.ts';
import { OUTPOST } from '../game/outpost.ts';
import { heightAt } from '../game/terrain.ts';
import type { Effects } from './effects.ts';
import { SPECS } from './particles.ts';
import { U } from './uniforms.ts';

// Tropical rain: thousands of streaks in a world-anchored box that follows the
// camera (so turning never swims them), falling at terminal velocity with the
// wind's slant. The drop count follows the rain rate; drops under the tarp are
// discarded, so standing in the shelter you watch the rain from the dry. Ground
// splashes are particles; rings on the water are in the water shader.

const BOX_M = 34;
const HEIGHT_M = 20;
const FALL_MS = 9; // terminal velocity of a ~2 mm raindrop (Gunn & Kinzer 1949)
// Streaks are drawn wider than a real 2 mm drop so they survive TAA at 1080p (tuned by eye).
const STREAK_M = 0.8;
const WIDTH_M = 0.022;

export class Rain {
  readonly mesh: Mesh;
  private readonly camPos = uniform(new Vector3());
  private splashAcc = 0;
  private readonly v = new Vector3();
  private readonly w = new Vector3();

  constructor(quality: 'high' | 'low') {
    const n = GRAPHICS.rainDrops[quality];
    const corner = new Float32Array(n * 4 * 2);
    const seed = new Float32Array(n * 4 * 4);
    const pos = new Float32Array(n * 4 * 3);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let c = 0; c < 4; c++) {
        const k = i * 4 + c;
        corner[k * 2] = c === 0 || c === 3 ? -1 : 1;
        corner[k * 2 + 1] = c < 2 ? 0 : 1;
        seed.set(s, k * 4);
      }
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('corner', new BufferAttribute(corner, 2));
    g.setAttribute('seed', new BufferAttribute(seed, 4));
    g.setIndex(idx);
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: true });
    const s = attribute('seed', 'vec4');
    const c = attribute('corner', 'vec2');
    const cam = this.camPos;
    const wind = U.wind;
    const fall = U.time.mul(FALL_MS).mul(float(0.85).add(s.w.mul(0.3)));
    const y = mod(s.y.mul(HEIGHT_M).sub(fall), HEIGHT_M).add(cam.y).sub(HEIGHT_M * 0.45);
    // World-anchored wrap: a drop's column is fixed in the world, re-used as the camera moves.
    const drift = y.mul(-1).div(FALL_MS).mul(0.6);
    const x = mod(s.x.mul(BOX_M).sub(cam.x), BOX_M).add(cam.x).sub(BOX_M / 2).add(wind.x.mul(drift));
    const z = mod(s.z.mul(BOX_M).sub(cam.z), BOX_M).add(cam.z).sub(BOX_M / 2).add(wind.y.mul(drift));
    const base = vec3(x, y, z);
    const slant = normalize(vec3(wind.x.mul(0.6), -FALL_MS, wind.y.mul(0.6)));
    const toCam = normalize(cameraPosition.sub(base));
    const across = normalize(cross(slant, toCam));
    m.positionNode = base.add(across.mul(c.x.mul(WIDTH_M))).sub(slant.mul(c.y.mul(STREAK_M)));
    const outpostC = vec3(OUTPOST.x, OUTPOST.groundY, OUTPOST.z);
    m.colorNode = Fn(() => {
      const p = positionWorld;
      // Only as many drops as the rain rate asks for.
      If(s.w.greaterThan(U.rain), () => {
        Discard();
      });
      // Dry under the tarp.
      const d = p.sub(outpostC);
      const ca = Math.cos(OUTPOST.yawRad);
      const sa = Math.sin(OUTPOST.yawRad);
      const lx = d.x.mul(ca).sub(d.z.mul(sa));
      const lz = d.x.mul(sa).add(d.z.mul(ca));
      If(lx.abs().lessThan(2.7).and(lz.greaterThan(-2.5)).and(lz.lessThan(2.2)).and(d.y.lessThan(2.6)), () => {
        Discard();
      });
      const light = U.skyIrradiance.add(U.sunIrradiance.mul(0.2)).add(U.cloudLit.mul(U.lightning.mul(8))).div(Math.PI);
      const fade = smoothstep(0.0, 0.2, c.y).mul(smoothstep(1.0, 0.6, c.y));
      return vec4(light.mul(1.8), fade.mul(0.45).mul(max(U.rain, 0.35)));
    })();
    this.mesh = new Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.name = 'rain';
  }

  update(game: LagoonGame, dt: number, camera: Camera, effects: Effects): void {
    const rain = game.env.weather.rainRate;
    this.mesh.visible = rain > 0.01;
    this.camPos.value.copy(camera.position);
    if (rain <= 0.01) return;
    // Splashes on the ground near the player (the lagoon draws its own rings).
    this.splashAcc += dt * rain * 260;
    while (this.splashAcc > 1) {
      this.splashAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * 11;
      const x = camera.position.x + Math.cos(a) * r;
      const z = camera.position.z + Math.sin(a) * r;
      const y = game.world.collision.groundAt(x, z, camera.position.y, 0.1);
      if (heightAt(x, z) < 0 && y <= heightAt(x, z) + 0.01) continue;
      if (Math.hypot(x - OUTPOST.x, z - OUTPOST.z) < 2.6) continue;
      effects.lit.spawn(SPECS.rainSplash, this.v.set(x, y + 0.02, z), this.w.set((Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6));
    }
  }
}
