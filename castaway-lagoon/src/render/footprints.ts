import { abs, attribute, cameraViewMatrix, float, Fn, int, length, max, min, mix, normalize, positionGeometry, positionWorld, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial, type Node, PlaneGeometry, Quaternion, Vector3 } from 'three/webgpu';
import { WATER_LEVEL_M } from '../config.ts';
import { heightAt, normalAt, surfaceAt } from '../game/terrain.ts';
import { PHOTO_SIZE_M } from './photoTextures.ts';
import { swash } from './shoreWaves.ts';
import { noiseMap, terrainArray } from './textures.ts';
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
//
// The decal is the beach's own sand (the same photograph, macro variation and
// wetness as ground.ts) with the print pressed into it, and fades to nothing
// well inside its quad: a flat sand colour, and a rim cut off by the quad's
// edges, showed every print as a rectangle.

export type PrintKind = 'footL' | 'footR' | 'paw' | 'hoof';
const KIND_ID: Record<PrintKind, number> = { footL: 0, footR: 1, paw: 2, hoof: 3 };
/**
 * Quad size per kind (m): across, along — the print's outline plus its pushed-up rim (up to 5 cm on dry
 * sand) and a margin for the fade at the quad's edge.
 */
const SIZE: Record<PrintKind, [number, number]> = { footL: [0.22, 0.38], footR: [0.22, 0.38], paw: [0.26, 0.27], hoof: [0.18, 0.21] };

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
  private dirty = true;

  constructor() {
    const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.kind = new InstancedBufferAttribute(new Float32Array(MAX_PRINTS), 1);
    this.fade = new InstancedBufferAttribute(new Float32Array(MAX_PRINTS * 4), 4);
    geo.setAttribute('printKind', this.kind);
    geo.setAttribute('printFade', this.fade);
    // A lit decal: disturbed sand with its own normal (floor, sloping walls, a pushed-up rim), so the sun
    // and the palms' shadows shade it like the beach around it; inside it the wind ripples are gone.
    const mat = new MeshStandardNodeMaterial({ name: 'footprints', transparent: true, depthWrite: false, metalness: 0 });
    mat.polygonOffset = true;
    // Reversed depth buffer: positive offsets pull toward the camera.
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 2;
    const kind = attribute('printKind', 'float');
    const inst = attribute('printFade', 'vec4');
    const strength = inst.x;
    const wet = inst.y;
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
    const soft = mix(float(0.014), float(0.005), wet);
    const inside = smoothstep(soft, soft.negate(), d);
    const wall = smoothstep(soft.mul(-2.2), float(0), d).mul(float(1).sub(smoothstep(float(0), soft, d)));
    const rim = smoothstep(float(0), soft, d).mul(float(1).sub(smoothstep(soft, soft.mul(3).add(0.008), d)));
    // Normal: up, tilted toward the middle on the walls and away from it on the rim; in world space via
    // the print's heading (instance attribute), then to view space for the lighting.
    const tilt = rim.mul(0.35).sub(wall.mul(mix(float(1.4), float(1.8), wet)));
    const c = inst.z;
    const sn = inst.w;
    const right = vec3(c, 0, sn.negate());
    const fwd = vec3(sn.negate(), 0, c.negate());
    // The sand's own grain under the print's shape: the photograph's normal (tangent +X, bitangent −Z, as the
    // ground lays it) is (a, b, c) → world (a, c, −b).
    const sand = terrainArray();
    const p = positionWorld;
    const uvS = vec2(p.x, p.z.negate()).div(PHOTO_SIZE_M.dense_sand);
    const grain = texture(sand.normalMap, uvS).depth(int(0)).xyz.mul(2).sub(1);
    const nSand = vec3(grain.x, grain.z, grain.y.negate());
    const nWorld = normalize(nSand.add(right.mul(g.x.mul(tilt))).add(fwd.mul(g.y.mul(tilt))));
    mat.normalNode = normalize(cameraViewMatrix.mul(vec4(nWorld, 0)).xyz);
    // The beach's colour where the print lies (ground.ts: the photograph, its macro variation, and the sand
    // darkening as the swash and the rain wet it), so only the dent shows, not the decal.
    const macro = texture(noiseMap(), p.xz.div(90)).r;
    let sandColour: Node<'vec3'> = texture(sand.map, uvS).depth(int(0)).rgb.mul(float(0.82).add(macro.mul(0.36)));
    const wetNow = max(swash(p.xz, p.y.sub(WATER_LEVEL_M)).wet, U.wetness.mul(0.95)).mul(0.5);
    const lum = sandColour.dot(vec3(0.2126, 0.7152, 0.0722));
    sandColour = mix(vec3(lum), sandColour, wetNow.mul(0.6).add(1)).mul(float(1).sub(wetNow));
    // Disturbed sand is a little darker than the wind-dried crust, its crumbs on the rim a little lighter;
    // water seeps into a wet print's floor, darker still and glossier.
    mat.colorNode = sandColour.mul(mix(float(0.86), float(1.04), rim)).mul(mix(float(1), float(0.82), inside.mul(wet)));
    mat.roughnessNode = mix(float(0.95), float(0.5), max(wetNow.mul(2), inside.mul(wet).mul(0.6)));
    // Nothing near the quad's edges, whatever the outline does there.
    const q = positionGeometry.xz.abs();
    const edge = float(1).sub(smoothstep(0.4, 0.49, max(q.x, q.y)));
    mat.opacityNode = max(inside.mul(0.92), max(wall, rim.mul(0.55))).mul(strength).mul(edge);
    this.mesh = new InstancedMesh(geo, mat, MAX_PRINTS);
    this.mesh.name = 'footprints';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
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

  update(dtS: number): void {
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
      fade[i * 4] = Math.min(1, pr.age * 8) * (1 - t * t);
      fade[i * 4 + 1] = pr.wet ? 1 : 0;
      fade[i * 4 + 2] = Math.cos(pr.yaw);
      fade[i * 4 + 3] = Math.sin(pr.yaw);
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
