import { attribute, Discard, float, Fn, If, max, mod, mrt, normalize, positionWorld, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, Vector2, Vector3 } from 'three/webgpu';
import { G } from './nodes';

// Rain (the lagoon's and Field Line's): thousands of streaks in a world-anchored
// box that follows the camera, so turning never swims them, falling at terminal
// velocity with the wind's slant. A streak is a motion-blurred highlight lit by
// the sky: brighter than dark air behind it, nearly invisible against a bright
// sky — as rain is. The box is larger than the city's: a tank's sight sees far,
// and its crew sits high.

const BOX_M = 44;
const HEIGHT_M = 26;
const FALL_MS = 9; // terminal velocity of a ~2 mm raindrop (Gunn & Kinzer 1949)
// A few times a real 2 mm drop, so streaks survive TAA; narrower than the first-person games' because
// the chase camera has drops close in front of it.
const STREAK_M = 0.6;
const WIDTH_M = 0.006;

export class Rain {
  readonly mesh: Mesh;
  /** 0 … 1: share of the drops drawn. */
  readonly rate = uniform(0);
  /** Pre-exposed sky radiance lighting the drops. */
  readonly light = uniform(new Vector3());
  readonly time = uniform(0);
  readonly wind = uniform(new Vector2());
  private readonly camPos = uniform(new Vector3());

  constructor(quality: 'high' | 'low') {
    const n = quality === 'high' ? 18000 : 7000;
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

    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
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
    m.colorNode = Fn(() => {
      If(s.w.greaterThan(this.rate), () => {
        Discard();
      });
      const fade = smoothstep(0.0, 0.2, c.y).mul(float(1).sub(smoothstep(0.6, 1.0, c.y)));
      // Drops within a metre or two would fill the screen: fade them out.
      const near = smoothstep(3, 8, positionWorld.sub(cam).length());
      // Invisible in the thermal sight: falling water is at air temperature.
      return vec4(this.light.mul(2.6), fade.mul(near).mul(0.06).mul(max(this.rate, 0.35)).mul(float(1).sub(G.uThermal)));
    })();
    // Leave the scene pass's normal and velocity targets alone (alpha 0 keeps what is there): a streak's
    // normal written there made the ambient occlusion draw dark lines along every drop.
    m.mrtNode = mrt({ normal: vec4(0), velocity: vec4(0) });
    this.mesh = new Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.name = 'rain';
    this.mesh.visible = false;
  }

  update(timeS: number, camera: Vector3): void {
    this.mesh.visible = this.rate.value > 0.01;
    this.time.value = timeS;
    this.camPos.value.copy(camera);
  }
}
