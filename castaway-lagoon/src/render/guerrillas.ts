import { attribute, float, mix, mx_noise_float, positionGeometry, step, vec3 } from 'three/tsl';
import { BoxGeometry, BufferAttribute, type BufferGeometry, CapsuleGeometry, Color, CylinderGeometry, Group, InstancedMesh, LatheGeometry, Matrix4, Mesh, MeshPhysicalNodeMaterial, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three/webgpu';
import type { Guerrilla } from '../game/guerrillas.ts';
import { merge } from './meshkit.ts';
import { buildRifle } from './weaponModels.ts';

// The guerrillas: an articulated figure of rigid segments (pelvis, torso,
// head, upper arms, forearms, hands, thighs, shins, boots and the AK), each
// one InstancedMesh shared by every man, posed per frame — after Field Line's
// soldiers (docs/graphics-playbook.md §6c), in irregulars' kit:
//
//   - stance from the logic: standing, or down on one knee to shoot; the AK in
//     the right shoulder along the aim (low ready on patrol), both hands on its
//     grips by two-bone IK, elbows out;
//   - legs by two-bone IK to planted feet: a stride with ground speed;
//   - the dead fall away from the shot over ~0.7 s and lie. No gore.
//
// Kit: faded tiger-stripe shirt, olive trousers, a khaki chest rig with three
// magazine pouches, a bandana or a boonie hat, a canvas bag, boots. One
// material: per-vertex colour and a kind (0 hard, 1 plain cloth, 2 patterned
// cloth) that sets roughness, sheen and the stripe pattern.

const MAX_MEN = 24;

const L_UPPER_ARM = 0.29;
const L_FOREARM = 0.26;
const L_THIGH = 0.43;
const L_SHIN = 0.43;
const ANKLE_Y = 0.09;
const SPINE_M = 0.52;
const SHOULDER_HALF = 0.19;

type Kind = 0 | 1 | 2;
const HARD: Kind = 0;
const PLAIN: Kind = 1;
const STRIPE: Kind = 2;

type Segment = 'pelvis' | 'torso' | 'head' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'boot' | 'rifle';
const PAIRED: Record<Segment, boolean> = { pelvis: false, torso: false, head: false, upperArm: true, forearm: true, hand: true, thigh: true, shin: true, boot: true, rifle: false };

export class GuerrillaView {
  readonly group = new Group();
  private readonly meshes = new Map<Segment, InstancedMesh>();
  private readonly walkPhase = new Map<number, number>();

  constructor() {
    this.group.name = 'guerrillas';
    const material = kitMaterial();
    const geos = segmentGeometries();
    for (const seg of Object.keys(PAIRED) as Segment[]) {
      const mesh = new InstancedMesh(geos[seg], material, MAX_MEN * (PAIRED[seg] ? 2 : 1));
      mesh.name = `guerrilla-${seg}`;
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // instances move every frame; bounds would go stale
      this.meshes.set(seg, mesh);
      this.group.add(mesh);
    }
  }

  update(men: readonly Guerrilla[], alpha: number, frameSeconds: number): void {
    const n = Math.min(men.length, MAX_MEN);
    for (const [seg, mesh] of this.meshes) mesh.count = n * (PAIRED[seg] ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const g = men[i] as Guerrilla;
      _feet.set(g.prev.x + (g.pos.x - g.prev.x) * alpha, g.prev.y + (g.pos.y - g.prev.y) * alpha, g.prev.z + (g.pos.z - g.prev.z) * alpha);
      let phase = this.walkPhase.get(g.id) ?? (g.id % 7) * 0.9;
      if (g.alive) phase = (phase + g.speedMs * frameSeconds * (g.crouch > 0.5 ? 4.2 : 3.2)) % (Math.PI * 2);
      this.walkPhase.set(g.id, phase);
      const yaw = g.prevYawRad + wrap(g.yawRad - g.prevYawRad) * alpha;
      _actor.makeRotationY(yaw).setPosition(_feet);
      // The fall's frame: away from where the round came from, in the man's own frame.
      _deathLocal.set(g.deathDir.x, 0, g.deathDir.z).applyAxisAngle(_yAxis, -yaw);
      this.pose(g, i, phase);
    }
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
    if (this.walkPhase.size > MAX_MEN * 4) this.walkPhase.clear();
  }

  // ---------------------------------------------------------------- posing (actor frame: −Z forward, +X right)

  private pose(g: Guerrilla, i: number, phase: number): void {
    const kneel = g.alive && g.crouch > 0.5;
    const stride = g.alive && !kneel ? Math.min(1, g.speedMs / 3) * 0.34 : 0;
    if (!kneel) {
      _hip.set(0, 0.93 - stride * 0.06 * Math.abs(Math.sin(phase)), 0);
      _up.set(0, 1, -0.07 - stride * 0.25).normalize();
    } else {
      _hip.set(0, 0.5, 0.03);
      _up.set(0, 1, -0.3).normalize();
    }
    _right.set(1, 0, 0);
    _front.crossVectors(_up, _right).normalize();
    const pitch = g.alive ? g.pitchRad : 0;
    _aim.set(0, Math.sin(pitch), -Math.cos(pitch));
    const lowReady = g.alive && !g.rifleUp;
    if (lowReady) _rifleDir.set(0.3, -0.55, -0.78).normalize();
    else _rifleDir.copy(_aim);

    // Fall: the pose tips away from the shot about the feet over ~0.7 s, and lies there.
    _fall.identity();
    if (!g.alive) {
      const t = Math.min(1, g.deathS / 0.7);
      const a = t * t * (Math.PI / 2 - 0.08);
      // Axis: horizontal, across the direction of the round.
      _axis.set(_deathLocal.z, 0, -_deathLocal.x);
      if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
      _axis.normalize();
      _fall.makeTranslation(0, 0.1 * t, 0).multiply(_rot.makeRotationAxis(_axis, a));
    }

    this.place('pelvis', i, 0, _hip, _up, _front);
    const blade = lowReady ? 0.25 : 0.6;
    _tRight.copy(_right).applyAxisAngle(_up, blade);
    _tFront.crossVectors(_up, _tRight).normalize();
    this.place('torso', i, 0, _hip, _up, _tFront);
    _neck.copy(_hip).addScaledVector(_up, SPINE_M);
    _headUp.set(0, 1, 0).addScaledVector(_aim, -_aim.y).normalize();
    _head.copy(_neck).addScaledVector(_up, 0.1).addScaledVector(_headUp, 0.04);
    this.place('head', i, 0, _head, _headUp, _aim);

    // AK: butt in the right shoulder pocket, along the aim. Model frame: −Z forward, sight line y = 0,
    // butt plate near (0, −0.09, +0.47).
    _shoulderR.copy(_hip).addScaledVector(_up, SPINE_M - 0.06).addScaledVector(_tRight, SHOULDER_HALF);
    _shoulderL.copy(_hip).addScaledVector(_up, SPINE_M - 0.06).addScaledVector(_tRight, -SHOULDER_HALF);
    _rifleUp.set(0, 1, 0).addScaledVector(_rifleDir, -_rifleDir.y).normalize();
    _butt.copy(_shoulderR).addScaledVector(_tFront, 0.04).addScaledVector(_tRight, -0.06);
    if (lowReady) _butt.addScaledVector(_up, -0.12).addScaledVector(_front, -0.06);
    _rifleO.copy(_butt).addScaledVector(_rifleUp, 0.09).addScaledVector(_rifleDir, 0.47);
    this.place('rifle', i, 0, _rifleO, _rifleUp, _rifleDir);
    // Grips: the pistol grip, and the support hand under the handguard.
    _gripR.copy(_rifleO).addScaledVector(_rifleUp, -0.15).addScaledVector(_rifleDir, -0.12);
    _gripL.copy(_rifleO).addScaledVector(_rifleUp, -0.08).addScaledVector(_rifleDir, 0.26);
    _pole.copy(_tRight).multiplyScalar(0.8).addScaledVector(_up, -1).addScaledVector(_tFront, -0.3);
    this.limb('upperArm', 'forearm', i, 1, _shoulderR, _gripR, L_UPPER_ARM, L_FOREARM, _pole);
    this.placeHand(i, 1, _gripR, _rifleDir);
    _pole.copy(_tRight).multiplyScalar(-0.9).addScaledVector(_up, -1);
    this.limb('upperArm', 'forearm', i, 0, _shoulderL, _gripL, L_UPPER_ARM, L_FOREARM, _pole);
    this.placeHand(i, 0, _gripL, _rifleDir);

    for (const side of [0, 1] as const) {
      const sx = side === 1 ? 1 : -1;
      _hipJoint.copy(_hip).addScaledVector(_right, sx * 0.1).addScaledVector(_up, -0.02);
      _bootFront.set(0, 0, -1);
      _bootUp.set(0, 1, 0);
      if (kneel) {
        if (side === 0) {
          _foot.set(-0.14, ANKLE_Y, -0.34);
          _pole.set(0, 0.2, -1);
        } else {
          _foot.set(0.14, 0.13, 0.4);
          _pole.set(0, -1, -0.5);
          _bootFront.set(0, -0.6, -1).normalize();
          _bootUp.set(0, 1, -0.6).normalize();
        }
      } else {
        const swing = Math.sin(phase + (side === 0 ? 0 : Math.PI));
        const lift = Math.max(0, Math.cos(phase + (side === 0 ? 0 : Math.PI))) * stride * 0.4;
        _foot.set(sx * 0.11, ANKLE_Y + lift, -swing * stride);
        _pole.set(0, 0.1, -1);
        _bootFront.set(0, lift * 0.8, -1).normalize();
      }
      this.limb('thigh', 'shin', i, side, _hipJoint, _foot, L_THIGH, L_SHIN, _pole);
      this.place('boot', i, side, _end, _bootUp, _bootFront);
    }
  }

  private limb(upper: Segment, lower: Segment, i: number, side: 0 | 1, root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3): void {
    solveTwoBone(root, target, l1, l2, pole, _mid, _end);
    _dir.subVectors(_mid, root).normalize();
    _tmpUp.copy(_dir).negate();
    this.place(upper, i, side, root, _tmpUp, pole);
    _dir.subVectors(_end, _mid).normalize();
    _tmpUp.copy(_dir).negate();
    this.place(lower, i, side, _mid, _tmpUp, pole);
  }

  private placeHand(i: number, side: 0 | 1, at: Vector3, along: Vector3): void {
    _dir.subVectors(at, _mid).normalize();
    _tmpUp.copy(_dir).negate();
    this.place('hand', i, side, _end, _tmpUp, along);
  }

  private place(seg: Segment, i: number, side: 0 | 1, origin: Vector3, up: Vector3, front: Vector3): void {
    const mesh = this.meshes.get(seg);
    if (!mesh) return;
    _y.copy(up).normalize();
    _z.copy(front).addScaledVector(_y, -front.dot(_y));
    if (_z.lengthSq() < 1e-8) _z.set(0, 0, -1).addScaledVector(_y, _y.z);
    _z.normalize().negate();
    _x.crossVectors(_y, _z);
    // No mirroring for the left side: a mirrored matrix flips the winding, and instanced draws cull
    // per mesh. Paired segments are built symmetric instead.
    _m.makeBasis(_x, _y, _z).setPosition(origin);
    _m.premultiply(_fall).premultiply(_actor);
    mesh.setMatrixAt(PAIRED[seg] ? i * 2 + side : i, _m);
  }
}

function wrap(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Two-bone IK: the joint between `root` and `target` for bones `l1`, `l2`, bent toward `pole`. */
export function solveTwoBone(root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, mid: Vector3, end: Vector3): void {
  const u = _ikU.subVectors(target, root);
  const raw = u.length();
  if (raw < 1e-6) u.set(0, -1, 0);
  else u.multiplyScalar(1 / raw);
  const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, raw));
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const v = _ikV.copy(pole).addScaledVector(u, -pole.dot(u));
  if (v.lengthSq() < 1e-8) v.set(u.y, -u.x, 0);
  v.normalize();
  mid.copy(root).addScaledVector(u, l1 * cosA).addScaledVector(v, l1 * sinA);
  end.copy(root).addScaledVector(u, dist);
}

// ------------------------------------------------------------------ material

function kitMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'guerrilla', metalness: 0, sheenRoughness: 0.8 });
  const tint = attribute('tint', 'vec3');
  const kind = attribute('kind', 'float');
  const striped = step(1.5, kind);
  const cloth = step(0.5, kind);
  // Faded tiger stripe: dark brush strokes running round the body over a sun-bleached green.
  // Pre-instance space, so the pattern stays on the cloth as the man moves (positionLocal is instanced).
  const p = positionGeometry;
  const warp = mx_noise_float(p.mul(4.3)).mul(0.6);
  const strokes = mx_noise_float(vec3(p.x.mul(3), p.y.mul(18).add(warp.mul(3)), p.z.mul(3)));
  const patches = mx_noise_float(p.mul(7.1).add(vec3(2.1, 5.3, 0.7)));
  const base = vec3(0.13, 0.13, 0.07);
  const stripe = vec3(0.025, 0.028, 0.02);
  const brown = vec3(0.09, 0.07, 0.04);
  const pattern = mix(mix(base, brown, step(0.25, patches)), stripe, step(0.3, strokes));
  const colour = mix(tint, pattern, striped);
  m.colorNode = colour;
  m.roughnessNode = mix(float(0.55), float(0.9), cloth);
  m.sheenNode = colour.mul(cloth.mul(0.35));
  return m;
}

// ------------------------------------------------------------------ geometry (each segment in its own frame)

function linear(hex: number): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

function tag(g: BufferGeometry, hex: number, kind: Kind): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  const count = n.getAttribute('position').count;
  const [r, gr, b] = linear(hex);
  const tint = new Float32Array(count * 3);
  const k = new Float32Array(count).fill(kind);
  for (let i = 0; i < count; i++) tint.set([r, gr, b], i * 3);
  n.setAttribute('tint', new BufferAttribute(tint, 3));
  n.setAttribute('kind', new BufferAttribute(k, 1));
  return n;
}

function joined(parts: BufferGeometry[], name: string): BufferGeometry {
  const tints: number[] = [];
  const kinds: number[] = [];
  for (const p of parts) {
    tints.push(...(p.getAttribute('tint').array as Float32Array));
    kinds.push(...(p.getAttribute('kind').array as Float32Array));
  }
  const g = merge(parts, name);
  g.setAttribute('tint', new BufferAttribute(new Float32Array(tints), 3));
  g.setAttribute('kind', new BufferAttribute(new Float32Array(kinds), 1));
  return g;
}

const C = {
  trousers: 0x4a4a32,
  rig: 0x6e6448,
  webbing: 0x4f4a36,
  skin: 0x8a5a3c,
  hair: 0x1c1712,
  bandana: 0x6a2420,
  hat: 0x5c5a3c,
  boot: 0x2f2a24,
  sole: 0x1e1d1c,
  bag: 0x5a5236,
  steel: 0x2b2c2e,
  wood: 0x6a3a20,
} as const;

const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry => new BoxGeometry(sx, sy, sz).translate(x, y, z);

function limbGeo(length: number, r0: number, r1: number): BufferGeometry {
  return merge([new CylinderGeometry(r0, r1, length, 12, 1, true).translate(0, -length / 2, 0), new SphereGeometry(r0, 12, 8), new SphereGeometry(r1, 12, 8).translate(0, -length, 0)], 'limb');
}

function segmentGeometries(): Record<Segment, BufferGeometry> {
  const pelvis = joined(
    [
      tag(new SphereGeometry(1, 16, 10).scale(0.17, 0.13, 0.12).translate(0, -0.02, 0), C.trousers, PLAIN),
      tag(box(0.35, 0.045, 0.25, 0, 0.06, 0), C.webbing, PLAIN), // belt
      tag(box(0.1, 0.12, 0.06, 0.15, 0.0, 0.1), C.bag, PLAIN), // a canvas bag on the hip
    ],
    'pelvis',
  );
  const torso = joined(
    [
      tag(new LatheGeometry([new Vector2(0.001, 0), new Vector2(0.15, 0.02), new Vector2(0.152, 0.2), new Vector2(0.18, 0.38), new Vector2(0.165, 0.48), new Vector2(0.06, 0.52)], 14).scale(1, 1, 0.6), 0x000000, STRIPE),
      tag(new SphereGeometry(0.062, 10, 8).translate(-SHOULDER_HALF, SPINE_M - 0.06, 0), 0x000000, STRIPE),
      tag(new SphereGeometry(0.062, 10, 8).translate(SHOULDER_HALF, SPINE_M - 0.06, 0), 0x000000, STRIPE),
      // Chest rig: a panel across the belly with three AK magazine pouches, straps over the shoulders.
      tag(box(0.3, 0.17, 0.05, 0, 0.2, -0.11), C.rig, PLAIN),
      tag(box(0.075, 0.13, 0.05, -0.085, 0.21, -0.145), C.rig, PLAIN),
      tag(box(0.075, 0.13, 0.05, 0, 0.21, -0.145), C.rig, PLAIN),
      tag(box(0.075, 0.13, 0.05, 0.085, 0.21, -0.145), C.rig, PLAIN),
      tag(box(0.05, 0.025, 0.24, -0.1, 0.45, 0), C.webbing, PLAIN),
      tag(box(0.05, 0.025, 0.24, 0.1, 0.45, 0), C.webbing, PLAIN),
      tag(box(0.05, 0.3, 0.025, -0.1, 0.32, 0.1), C.webbing, PLAIN),
      tag(box(0.05, 0.3, 0.025, 0.1, 0.32, 0.1), C.webbing, PLAIN),
      // A rolled blanket across the back, and the neck.
      tag(new CylinderGeometry(0.06, 0.06, 0.3, 10).rotateZ(Math.PI / 2).translate(0, 0.42, 0.14), C.bag, PLAIN),
      tag(new CylinderGeometry(0.055, 0.065, 0.1, 10).translate(0, 0.53, 0), C.skin, HARD),
    ],
    'torso',
  );
  const head = joined(
    [
      tag(new SphereGeometry(0.1, 14, 10).scale(0.82, 1.05, 0.95), C.skin, HARD),
      tag(new SphereGeometry(0.102, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45).scale(0.84, 1.0, 0.98).translate(0, 0.01, 0.01), C.hair, PLAIN),
      // Bandana knotted at the back, and a boonie hat's brim and crown over it.
      tag(new CylinderGeometry(0.087, 0.09, 0.05, 14, 1, true).scale(1, 1, 1.12).translate(0, 0.045, 0.005), C.bandana, PLAIN),
      tag(box(0.05, 0.04, 0.05, 0, 0.04, 0.1), C.bandana, PLAIN),
      tag(new CylinderGeometry(0.095, 0.1, 0.07, 16).translate(0, 0.09, 0.005), C.hat, PLAIN),
      tag(new TorusGeometry(0.115, 0.022, 4, 20).rotateX(Math.PI / 2).scale(1, 1, 1.1).translate(0, 0.062, 0.005), C.hat, PLAIN),
      // Nose and ears so the head is a head at ten metres.
      tag(new SphereGeometry(1, 8, 6).scale(0.016, 0.025, 0.02).translate(0, -0.01, -0.095), C.skin, HARD),
      tag(new SphereGeometry(1, 8, 6).scale(0.012, 0.025, 0.018).translate(-0.083, -0.005, 0.005), C.skin, HARD),
      tag(new SphereGeometry(1, 8, 6).scale(0.012, 0.025, 0.018).translate(0.083, -0.005, 0.005), C.skin, HARD),
    ],
    'head',
  );
  const upperArm = joined([tag(limbGeo(L_UPPER_ARM, 0.052, 0.044), 0x000000, STRIPE)], 'upperArm');
  // Sleeves rolled to the elbow: bare forearms.
  const forearm = joined([tag(new CylinderGeometry(0.05, 0.048, 0.06, 12).translate(0, -0.02, 0), 0x000000, STRIPE), tag(limbGeo(L_FOREARM, 0.04, 0.03), C.skin, HARD)], 'forearm');
  const hand = joined([tag(new SphereGeometry(1, 10, 8).scale(0.04, 0.053, 0.026).translate(0, -0.05, 0), C.skin, HARD), tag(new CapsuleGeometry(0.011, 0.03, 2, 6).translate(0, -0.05, -0.028), C.skin, HARD)], 'hand');
  const thigh = joined([tag(limbGeo(L_THIGH, 0.078, 0.06), C.trousers, PLAIN), tag(box(0.17, 0.12, 0.09, 0, -0.22, 0), C.trousers, PLAIN)], 'thigh');
  const shin = joined([tag(limbGeo(L_SHIN, 0.058, 0.045), C.trousers, PLAIN), tag(new CylinderGeometry(0.056, 0.06, 0.13, 12).translate(0, -L_SHIN + 0.05, 0), C.boot, HARD)], 'shin');
  const boot = joined([tag(new CapsuleGeometry(0.05, 0.16, 4, 10).rotateX(Math.PI / 2).scale(1, 0.9, 1).translate(0, -0.035, -0.055), C.boot, HARD), tag(box(0.105, 0.025, 0.28, 0, -0.08, -0.055), C.sole, HARD)], 'boot');
  return { pelvis, torso, head, upperArm, forearm, hand, thigh, shin, boot, rifle: rifleGeometry() };
}

/** The player's AK (weaponModels.ts) merged into one geometry: wood furniture, dark steel. */
function rifleGeometry(): BufferGeometry {
  const model = buildRifle();
  model.root.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  model.root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    parts.push(tag(o.geometry.clone().applyMatrix4(o.matrixWorld), o.name === 'furniture' ? C.wood : C.steel, HARD));
  });
  return joined(parts, 'guerrilla ak');
}

const _actor = new Matrix4();
const _fall = new Matrix4();
const _rot = new Matrix4();
const _m = new Matrix4();
const _feet = new Vector3();
const _deathLocal = new Vector3();
const _axis = new Vector3();
const _yAxis = new Vector3(0, 1, 0);
const _hip = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _front = new Vector3();
const _tRight = new Vector3();
const _tFront = new Vector3();
const _aim = new Vector3();
const _rifleDir = new Vector3();
const _rifleUp = new Vector3();
const _rifleO = new Vector3();
const _butt = new Vector3();
const _neck = new Vector3();
const _head = new Vector3();
const _headUp = new Vector3();
const _shoulderL = new Vector3();
const _shoulderR = new Vector3();
const _gripL = new Vector3();
const _gripR = new Vector3();
const _pole = new Vector3();
const _hipJoint = new Vector3();
const _foot = new Vector3();
const _bootFront = new Vector3();
const _bootUp = new Vector3();
const _mid = new Vector3();
const _end = new Vector3();
const _dir = new Vector3();
const _tmpUp = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _ikU = new Vector3();
const _ikV = new Vector3();
