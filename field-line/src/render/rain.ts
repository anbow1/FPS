import { attribute, Discard, float, Fn, If, max, mod, normalize, positionWorld, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DataTexture, FloatType, Mesh, MeshBasicNodeMaterial, NearestFilter, RedFormat, Vector2, Vector3 } from 'three/webgpu';
import type { MapData } from '../maps/types.ts';
import { lampAirLightNode } from './cityLights.ts';

// Rain: thousands of streaks in a world-anchored box that follows the camera
// (so turning never swims them), falling at terminal velocity with the wind's
// slant — the lagoon's rain (castaway-lagoon render/weatherFx.ts), plus what a
// city needs: **no rain under a roof**. A top-down "rain occlusion" map holds
// the highest roof, slab or awning over every metre of the map (from the map's
// boxes, once at load); a streak below it is discarded, so from a doorway or a
// window you watch it fall outside while the room stays dry.
//
// A streak is a motion-blurred highlight lit by the sky (and by a nearby lit
// window or lamp, through the same light the street sees): brighter than dark
// air behind it, nearly invisible against a bright façade — as rain is.

const BOX_M = 30;
const HEIGHT_M = 22;
const FALL_MS = 9; // terminal velocity of a ~2 mm raindrop (Gunn & Kinzer 1949)
// Wider than a real 2 mm drop so streaks survive TAA at 1080p (tuned by eye in the lagoon).
const STREAK_M = 0.55;
const WIDTH_M = 0.012;
const CELL_M = 1;

export class Rain {
  readonly mesh: Mesh;
  /** 0 … 1: share of the drops drawn. */
  readonly rate = uniform(0);
  /** Pre-exposed sky radiance lighting the drops. */
  readonly light = uniform(new Vector3());
  readonly time = uniform(0);
  readonly wind = uniform(new Vector2());
  private readonly camPos = uniform(new Vector3());

  constructor(map: MapData, quality: 'high' | 'low') {
    const n = quality === 'high' ? 16000 : 6000;
    const corner = new Float32Array(n * 4 * 2);
    const seed = new Float32Array(n * 4 * 4);
    const pos = new Float32Array(n * 4 * 3);
    const idx = new Uint32Array(n * 6);
    let r = 0x9e3779b9;
    const rnd = (): number => {
      r ^= r << 13;
      r ^= r >>> 17;
      r ^= r << 5;
      return (r >>> 0) / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const s = [rnd(), rnd(), rnd(), rnd()];
      for (let c = 0; c < 4; c++) {
        const k = i * 4 + c;
        corner[k * 2] = c === 0 || c === 3 ? -1 : 1;
        corner[k * 2 + 1] = c < 2 ? 0 : 1;
        seed.set(s, k * 4);
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('corner', new BufferAttribute(corner, 2));
    g.setAttribute('seed', new BufferAttribute(seed, 4));
    g.setIndex(new BufferAttribute(idx, 1));

    const occ = occlusionMap(map);
    const half = occ.halfM;
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: true });
    const s = attribute('seed', 'vec4');
    const c = attribute('corner', 'vec2');
    const cam = this.camPos;
    const fall = this.time.mul(FALL_MS).mul(float(0.85).add(s.w.mul(0.3)));
    const y = mod(s.y.mul(HEIGHT_M).sub(fall), HEIGHT_M).add(cam.y).sub(HEIGHT_M * 0.45);
    // World-anchored wrap: a drop's column is fixed in the world, re-used as the camera moves.
    const drift = y.mul(-1).div(FALL_MS).mul(0.3);
    const x = mod(s.x.mul(BOX_M).sub(cam.x), BOX_M).add(cam.x).sub(BOX_M / 2).add(this.wind.x.mul(drift));
    const z = mod(s.z.mul(BOX_M).sub(cam.z), BOX_M).add(cam.z).sub(BOX_M / 2).add(this.wind.y.mul(drift));
    const base = vec3(x, y, z);
    const slant = vec3(this.wind.x.mul(0.3 / FALL_MS), -1, this.wind.y.mul(0.3 / FALL_MS));
    const toCam = cam.sub(base);
    const acrossDir = normalize(vec3(toCam.z, 0, toCam.x.negate()).add(vec3(1e-4, 0, 0)));
    m.positionNode = base.add(acrossDir.mul(c.x.mul(WIDTH_M))).sub(slant.mul(c.y.mul(STREAK_M)));
    const occTex = texture(occ.texture);
    m.colorNode = Fn(() => {
      const p = positionWorld;
      // The roof over this point (nearest-texel lookup of the occlusion map).
      const roof = occTex.sample(vec2(p.x.add(half), p.z.add(half)).div(half * 2)).r;
      // Only as many drops as the rain rate asks for; none under a roof.
      If(s.w.greaterThan(this.rate).or(p.y.lessThan(roof)), () => {
        Discard();
      });
      const fade = smoothstep(0.0, 0.2, c.y).mul(float(1).sub(smoothstep(0.6, 1.0, c.y)));
      // Drops within a metre or two would fill the screen: fade them out.
      const near = smoothstep(1.5, 4.0, p.sub(cam).length());
      // Lit by the sky, and at night by the street lamps it falls through (their cones read in the rain).
      const lit = this.light.add(lampAirLightNode().mul(0.5 / Math.PI));
      return vec4(lit.mul(1.8), fade.mul(near).mul(0.07).mul(max(this.rate, 0.35)));
    })();
    this.mesh = new Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.name = 'rain';
  }

  update(timeS: number, camera: { position: Vector3 }): void {
    this.mesh.visible = this.rate.value > 0.01;
    this.time.value = timeS;
    this.camPos.value.copy(camera.position);
  }
}

/**
 * Highest roof, slab or overhang over every 1 m cell of the map (m; −1000 where open sky), from the map's
 * boxes: their rotated footprints, conservatively by their bounding squares. Glass and collision-only
 * boxes do not count (rain does not stop at an invisible wall, and a pane is not a roof).
 */
function occlusionMap(map: MapData): { texture: DataTexture; halfM: number } {
  const halfM = map.halfSizeM + 16;
  const res = Math.ceil((halfM * 2) / CELL_M);
  const data = new Float32Array(res * res).fill(-1000);
  for (const b of map.boxes) {
    if (b.look === 'invisible' || b.look === 'glass' || b.look === 'facadeGlass') continue;
    // Pavement slabs and kerbs are the ground, not a roof.
    if (b.size.y < 0.5 && b.center.y - b.size.y / 2 < 0.3) continue;
    const top = b.center.y + b.size.y / 2;
    const yaw = b.yawRad ?? 0;
    const ex = (Math.abs(Math.cos(yaw)) * b.size.x + Math.abs(Math.sin(yaw)) * b.size.z) / 2;
    const ez = (Math.abs(Math.sin(yaw)) * b.size.x + Math.abs(Math.cos(yaw)) * b.size.z) / 2;
    const i0 = Math.max(0, Math.floor((b.center.x - ex + halfM) / CELL_M));
    const i1 = Math.min(res - 1, Math.floor((b.center.x + ex + halfM) / CELL_M));
    const j0 = Math.max(0, Math.floor((b.center.z - ez + halfM) / CELL_M));
    const j1 = Math.min(res - 1, Math.floor((b.center.z + ez + halfM) / CELL_M));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) data[j * res + i] = Math.max(data[j * res + i] as number, top);
  }
  const t = new DataTexture(data, res, res, RedFormat, FloatType);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.needsUpdate = true;
  return { texture: t, halfM };
}
