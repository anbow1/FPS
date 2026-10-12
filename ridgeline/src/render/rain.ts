import { attribute, Discard, float, Fn, If, max, mod, mrt, normalize, positionWorld, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';

// Falling rain around the camera (the lagoon's, Field Line's and Tanks'), with
// one thing a helicopter needs that a walker does not: the streak is the drop's
// path relative to the camera during the exposure. Hovering, the rain falls in
// short vertical streaks; at 60 m/s it comes at the windscreen almost level, in
// long streaks converging on the point the helicopter flies towards.

const BOX_M = 34;
const HEIGHT_M = 28;
const FALL_MS = 9; // terminal velocity of a ~2 mm raindrop (Gunn & Kinzer 1949)
const WIDTH_M = 0.008;
/** The camera's exposure for the streak (s): long enough to read as motion, short enough not to smear. */
const EXPOSURE_S = 0.022;

export class Rain {
  readonly mesh: Mesh;
  /** 0 … 1: share of the drops drawn. */
  readonly rate = uniform(0);
  /** Pre-exposed sky radiance lighting the drops. */
  readonly light = uniform(new Vector3());
  readonly time = uniform(0);
  private readonly camPos = uniform(new Vector3());
  /** The drop's path relative to the camera during one exposure (m, world). */
  private readonly streak = uniform(new Vector3(0, -FALL_MS * EXPOSURE_S, 0));

  constructor(quality: 'high' | 'low') {
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

    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const s = attribute('seed', 'vec4');
    const c = attribute('corner', 'vec2');
    const cam = this.camPos;
    const fall = this.time.mul(FALL_MS).mul(float(0.85).add(s.w.mul(0.3)));
    // World-anchored wrap: a drop's column is fixed in the world, re-used as the camera moves.
    const y = mod(s.y.mul(HEIGHT_M).sub(fall), HEIGHT_M).add(cam.y).sub(HEIGHT_M * 0.45);
    const x = mod(s.x.mul(BOX_M).sub(cam.x), BOX_M).add(cam.x).sub(BOX_M / 2);
    const z = mod(s.z.mul(BOX_M).sub(cam.z), BOX_M).add(cam.z).sub(BOX_M / 2);
    const base = vec3(x, y, z);
    const toCam = cam.sub(base);
    // Width across both the streak and the line of sight.
    const acrossDir = normalize(toCam.cross(this.streak).add(vec3(1e-4, 0, 0)));
    m.positionNode = base.add(acrossDir.mul(c.x.mul(WIDTH_M))).sub(this.streak.mul(c.y));
    m.colorNode = Fn(() => {
      If(s.w.greaterThan(this.rate), () => {
        Discard();
      });
      const fade = smoothstep(0.0, 0.2, c.y).mul(float(1).sub(smoothstep(0.6, 1.0, c.y)));
      // Drops within a metre or two (inside the cabin, the rotor's wash) would fill the screen.
      const near = smoothstep(2.5, 6, positionWorld.sub(cam).length());
      return vec4(this.light.mul(2.4), fade.mul(near).mul(0.07).mul(max(this.rate, 0.35)));
    })();
    // Leave any normal and velocity targets alone (alpha 0): written there, drops become dark lines.
    m.mrtNode = mrt({ normal: vec4(0), velocity: vec4(0) });
    this.mesh = new Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.name = 'rain';
    this.mesh.visible = false;
  }

  /** `camVel` is the camera's velocity (m/s, world); `wind` the air's. */
  update(timeS: number, camera: Vector3, camVel: Vector3, wind: Vector3): void {
    this.mesh.visible = this.rate.value > 0.01;
    this.time.value = timeS;
    this.camPos.value.copy(camera);
    this.streak.value.set(wind.x - camVel.x, -FALL_MS + wind.y - camVel.y, wind.z - camVel.z).multiplyScalar(EXPOSURE_S);
  }
}
