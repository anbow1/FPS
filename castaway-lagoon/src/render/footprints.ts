import { abs, attribute, float, Fn, length, max, min, mix, normalize, positionGeometry, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { CustomBlending, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, type Node, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Quaternion, Vector2, Vector3 } from 'three/webgpu';
import { WATER_LEVEL_M } from '../config.ts';
import { heightAt, normalAt, surfaceAt } from '../game/terrain.ts';
import { U } from './uniforms.ts';

// Tracks in the sand, after the beach in "Tidewater" (an AI-made three.js
// fishing game): a trail of footprints behind the walker is what makes a beach
// feel trodden and real. Each print is a small quad laid on the ground with
// its shape drawn as a signed distance in the shader — a bare foot (heel,
// ball, five toes), a tiger's pug (pad and four toes) or a boar's cloven hoof
// — and shaded as a dent: darker inside, the wall facing away from the sun in
// shadow, the far wall catching it. Wet sand keeps crisp prints until the
// swash washes them out (half a minute); dry sand keeps soft ones for minutes.
// The animals leave theirs too, which tells the player who walked the beach.

export type PrintKind = 'footL' | 'footR' | 'paw' | 'hoof';
const KIND_ID: Record<PrintKind, number> = { footL: 0, footR: 1, paw: 2, hoof: 3 };
/** Quad size per kind (m): across, along. */
const SIZE: Record<PrintKind, [number, number]> = { footL: [0.13, 0.3], footR: [0.13, 0.3], paw: [0.16, 0.17], hoof: [0.09, 0.1] };

const MAX_PRINTS = 320;
const WET_LIFE_S = 30;
const DRY_LIFE_S = 240;

type F = Node<'float'>;
type V2 = Node<'vec2'>;

/** Polynomial smooth minimum (k in metres). */
function smin(a: F, b: F, k: number): F {
  const h = max(float(k).sub(abs(a.sub(b))), 0).div(k);
  return min(a, b).sub(h.mul(h).mul(k * 0.25));
}

function ellipse(p: V2, c: [number, number], r: [number, number]): F {
  // A cheap ellipse distance: scale to a circle, scale back by the smaller radius.
  const q = p.sub(vec2(c[0], c[1])).div(vec2(r[0], r[1]));
  return length(q).sub(1).mul(Math.min(r[0], r[1]));
}

/** Signed distance (m) of the print's outline at p (x across, y along, metres from the quad centre). */
const printDistance = Fn(([pIn, kind]: [V2, F]) => {
  // Feet: the right foot is the left foot mirrored.
  const mirror = float(1).sub(kind.equal(1).select(float(2), float(0)));
  const p = vec2(pIn.x.mul(mirror), pIn.y);
  const heel = ellipse(p, [0.004, -0.085], [0.03, 0.042]);
  const arch = ellipse(p, [-0.012, -0.015], [0.022, 0.05]);
  const ball = ellipse(p, [0.002, 0.045], [0.041, 0.04]);
  let foot = smin(smin(heel, arch, 0.03), ball, 0.025);
  for (const [x, y, r] of [
    [0.03, 0.098, 0.016],
    [0.008, 0.11, 0.012],
    [-0.011, 0.108, 0.011],
    [-0.027, 0.1, 0.01],
    [-0.04, 0.088, 0.009],
  ] as const) {
    foot = min(foot, length(p.sub(vec2(x, y))).sub(r));
  }
  // Tiger pug: a broad three-lobed pad and four oval toes in an arc ahead of it.
  let paw = smin(ellipse(pIn, [0, -0.03], [0.045, 0.036]), ellipse(pIn, [0, -0.045], [0.052, 0.022]), 0.02);
  for (const [x, y] of [
    [-0.05, 0.022],
    [-0.018, 0.05],
    [0.018, 0.05],
    [0.05, 0.022],
  ] as const) {
    paw = min(paw, ellipse(pIn, [x, y], [0.016, 0.021]));
  }
  // Boar: two cloven halves, pointed forward, and the two dewclaws behind.
  let hoof = min(ellipse(pIn, [-0.017, 0.006], [0.014, 0.034]), ellipse(pIn, [0.017, 0.006], [0.014, 0.034]));
  hoof = min(hoof, min(length(pIn.sub(vec2(-0.022, -0.04))).sub(0.006), length(pIn.sub(vec2(0.022, -0.04))).sub(0.006)));
  return kind.lessThan(1.5).select(foot, kind.lessThan(2.5).select(paw, hoof));
});

export class Footprints {
  readonly mesh: InstancedMesh;
  private readonly kind: InstancedBufferAttribute;
  private readonly fade: InstancedBufferAttribute;
  private readonly prints: { x: number; y: number; z: number; yaw: number; kind: PrintKind; age: number; life: number; wet: boolean; nx: number; ny: number; nz: number }[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly qYaw = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly n = new Vector3();
  private readonly s = new Vector3();
  private readonly p = new Vector3();
  private readonly nrm = { x: 0, y: 1, z: 0 };
  /** The sun's direction in the ground plane, for the walls' light and shade. */
  private readonly sunXZ = uniform(new Vector2(0.6, 0.8));
  private dirty = true;

  constructor() {
    const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.kind = new InstancedBufferAttribute(new Float32Array(MAX_PRINTS), 1);
    this.fade = new InstancedBufferAttribute(new Float32Array(MAX_PRINTS * 2), 2);
    geo.setAttribute('printKind', this.kind);
    geo.setAttribute('printFade', this.fade);
    const mat = new MeshBasicNodeMaterial({ name: 'footprints', transparent: true, depthWrite: false });
    // Premultiplied: darken by alpha, add the sunlit wall's light on top.
    mat.blending = CustomBlending;
    mat.blendSrc = OneFactor;
    mat.blendDst = OneMinusSrcAlphaFactor;
    mat.polygonOffset = true;
    // Reversed depth buffer: positive offsets pull toward the camera.
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 2;
    const kind = attribute('printKind', 'float');
    const fadeWet = attribute('printFade', 'vec2');
    const strength = fadeWet.x;
    const wet = fadeWet.y;
    const size = vec2(
      kind.lessThan(1.5).select(float(SIZE.footL[0]), kind.lessThan(2.5).select(float(SIZE.paw[0]), float(SIZE.hoof[0]))),
      kind.lessThan(1.5).select(float(SIZE.footL[1]), kind.lessThan(2.5).select(float(SIZE.paw[1]), float(SIZE.hoof[1]))),
    );
    // Geometry space is the unit quad (x across, −z forward); metres from its centre.
    const pm = vec2(positionGeometry.x, positionGeometry.z.negate()).mul(size);
    const d = printDistance(pm, kind);
    // Outward gradient of the outline by central differences (2 mm).
    const e = 0.002;
    const gx = printDistance(pm.add(vec2(e, 0)), kind).sub(printDistance(pm.sub(vec2(e, 0)), kind));
    const gy = printDistance(pm.add(vec2(0, e)), kind).sub(printDistance(pm.sub(vec2(0, e)), kind));
    const g = normalize(vec2(gx, gy).add(vec2(1e-6, 0)));
    // Wet sand holds a sharp edge; dry sand slumps into a soft dish.
    const soft = mix(float(0.012), float(0.004), wet);
    const inside = smoothstep(soft, soft.negate(), d);
    const wall = smoothstep(soft.mul(-2.5), float(0), d).mul(float(1).sub(smoothstep(float(0), soft, d)));
    // The inner wall faces −g: toward the sun it is lit, away from it in shadow.
    const facing = mix(float(0), float(1), smoothstep(-1, 1, g.x.mul(this.sunXZ.x).add(g.y.mul(this.sunXZ.y)).negate()));
    const sunUp = max(U.sunDir.y, 0);
    const darken = inside.mul(mix(float(0.16), float(0.3), wet)).add(wall.mul(float(1).sub(facing)).mul(0.38).mul(smoothstep(0.02, 0.25, sunUp)));
    const lit = wall.mul(facing).mul(0.1).mul(smoothstep(0.02, 0.25, sunUp));
    const sand = vec3(0.62, 0.55, 0.42);
    const light = U.sunIrradiance.mul(sunUp).add(U.skyIrradiance).div(Math.PI).mul(sand);
    // Straight to the target (premultiplied): light added, the sand below darkened by alpha.
    mat.fragmentNode = vec4(light.mul(lit).mul(strength), darken.mul(strength));
    this.mesh = new InstancedMesh(geo, mat, MAX_PRINTS);
    this.mesh.name = 'footprints';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** A print at (x, z) facing `yawRad` (logic convention: forward −sin, −cos); only on sand. */
  add(x: number, z: number, yawRad: number, kind: PrintKind): void {
    const surf = surfaceAt(x, z);
    if (surf !== 'sand' && surf !== 'wetSand') return;
    const y = heightAt(x, z);
    if (y < WATER_LEVEL_M + 0.01) return;
    normalAt(x, z, this.nrm);
    const wet = surf === 'wetSand';
    if (this.prints.length >= MAX_PRINTS) this.prints.shift();
    this.prints.push({ x, y, z, yaw: yawRad, kind, age: 0, life: wet ? WET_LIFE_S : DRY_LIFE_S, wet, nx: this.nrm.x, ny: this.nrm.y, nz: this.nrm.z });
    this.dirty = true;
  }

  update(dtS: number, sunDir: { x: number; z: number }): void {
    const sl = Math.hypot(sunDir.x, sunDir.z);
    if (sl > 1e-3) this.sunXZ.value.set(sunDir.x / sl, sunDir.z / sl);
    let removed = 0;
    for (const pr of this.prints) {
      pr.age += dtS;
      if (pr.age > pr.life) removed++;
    }
    if (removed > 0) {
      for (let i = this.prints.length - 1; i >= 0; i--) if ((this.prints[i] as { age: number; life: number }).age > (this.prints[i] as { life: number }).life) this.prints.splice(i, 1);
      this.dirty = true;
    }
    // Strengths fade every frame; matrices only change when prints come or go.
    const fade = this.fade.array as Float32Array;
    for (let i = 0; i < this.prints.length; i++) {
      const pr = this.prints[i]!;
      const t = pr.age / pr.life;
      fade[i * 2] = Math.min(1, pr.age * 8) * (1 - t * t);
      fade[i * 2 + 1] = pr.wet ? 1 : 0;
    }
    this.fade.needsUpdate = true;
    if (!this.dirty) return;
    this.dirty = false;
    const kinds = this.kind.array as Float32Array;
    for (let i = 0; i < this.prints.length; i++) {
      const pr = this.prints[i]!;
      this.n.set(pr.nx, pr.ny, pr.nz);
      this.q.setFromUnitVectors(this.up, this.n);
      this.qYaw.setFromAxisAngle(this.up, pr.yaw);
      this.q.multiply(this.qYaw);
      const [w, l] = SIZE[pr.kind];
      this.s.set(w, 1, l);
      this.p.set(pr.x, pr.y + 0.012, pr.z);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      kinds[i] = KIND_ID[pr.kind];
    }
    this.kind.needsUpdate = true;
    this.mesh.count = this.prints.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
