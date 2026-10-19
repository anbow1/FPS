import { attribute, bumpMap, float, mix, mx_noise_float, positionGeometry, smoothstep, texture, uv, vec3 } from 'three/tsl';
import { Bone, CanvasTexture, CylinderGeometry, Group, Matrix4, Mesh, MeshPhysicalNodeMaterial, MeshSSSNodeMaterial, MeshStandardNodeMaterial, Quaternion, RepeatWrapping, Skeleton, SkinnedMesh, SRGBColorSpace, Vector3 } from 'three/webgpu';
import { type HandData, handData, type HandPose, poseRotations } from './handMesh.ts';

// First-person arms: a real forearm and hand (handMesh.ts — MakeHuman's
// body, its knuckles, tendons and nails) in fingerless leather gloves, a
// tattooed forearm and a rolled sleeve. Each arm hangs from a fixed shoulder
// and reaches its hand target through a two-bone IK with an outward-and-down
// elbow pole, so the hands are always attached to something — they never
// float. The forearm and the hand are one skin on two bones, so the wrist
// bends as a wrist, and the forearm turns with the hand as a radius does.
// Metres, camera space (x right, y up, −z forward). Hand frame: wrist at the
// origin, fingers along −Z, palm facing −Y, thumb toward −X (right hand; the
// left is its mirror image).

export type { HandPose } from './handMesh.ts';

const UPPER_ARM_M = 0.3;
const FOREARM_M = 0.27;

export const POSES = {
  relaxed: { curl: [0.5, 0.58, 0.64, 0.7], thumb: 0.35, spread: 0.1 },
  open: { curl: [0.08, 0.08, 0.1, 0.12], thumb: 0.05, spread: 0.7 },
  grip: { curl: [0.72, 0.85, 0.88, 0.9], thumb: 0.85, spread: 0.05 },
  trigger: { curl: [0.45, 0.85, 0.88, 0.9], thumb: 0.8, spread: 0.05 },
  cradle: { curl: [0.55, 0.62, 0.66, 0.7], thumb: 0.55, spread: 0.1 },
  pinch: { curl: [0.62, 0.7, 0.8, 0.85], thumb: 0.9, spread: 0.1 },
} as const satisfies Record<string, HandPose>;

/** Tanned skin (sRGB): brown, not orange. */
const SKIN_HEX = 0xa2785c;

/** How far the glove's leather stands off the skin (m). */
const GLOVE_THICKNESS_M = 0.0013;

let materials: { arm: MeshSSSNodeMaterial; sleeve: MeshPhysicalNodeMaterial; watch: MeshStandardNodeMaterial } | null = null;

function linear(hex: number): [number, number, number] {
  const s = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => c / 255);
  return s.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
}

/**
 * The arm's one material, by the bake's regions: tanned skin with its blood glowing through thin edges
 * (SSS), the forearm's tattoo, nails a little paler and glossier, and the glove's dark leather over the
 * palm, the back of the hand and the first finger joints, a cut edge darker where the fingers come out.
 */
function armMaterials() {
  if (materials) return materials;
  const region = attribute('region', 'vec4');
  const bare = smoothstep(0.35, 0.65, region.x);
  const forearm = smoothstep(0.3, 0.7, region.z);
  const glove = float(1).sub(bare).mul(float(1).sub(forearm));
  const nail = smoothstep(0.2, 0.6, region.y);
  // Sun-tanned skin, mottled (sun spots, the redder skin over knuckles and tendons), the tattooed forearm
  // from its own texture with its hairs and veins. An even, saturated tan read as a shop dummy's arm.
  const mottle = mx_noise_float(positionGeometry.mul(90)).mul(0.06).add(mx_noise_float(positionGeometry.mul(23).add(3.1)).mul(0.08));
  const skin = vec3(...linear(SKIN_HEX)).mul(mottle.add(1));
  const handSkin = mix(skin, vec3(...linear(0x9f6e5a)), bare.mul(0.5));
  const skinColour = mix(handSkin, texture(tattooTexture(), uv()).rgb.mul(mottle.add(1)), forearm);
  const withNail = mix(skinColour, vec3(...linear(0xd2a693)), nail);
  // The glove's cut edges, round each finger and at the wrist: the leather's raw edge, darker.
  const fingerEdge = float(1).sub(smoothstep(0.0, 0.12, region.x.sub(0.5).abs())).mul(float(1).sub(forearm));
  const wristEdge = float(1).sub(smoothstep(0.0, 0.1, region.z.sub(0.5).abs()));
  const leather = vec3(...linear(0x3a2a20)).mul(float(1).sub(fingerEdge.add(wristEdge).min(1).mul(0.45)));
  const m = new MeshSSSNodeMaterial({ name: 'arm', roughness: 0.52, metalness: 0 });
  m.colorNode = mix(withNail, leather, glove);
  // Pores and fine creases in the skin, the leather's grain in the glove: a bump from noise in the mesh's
  // rest pose (so it moves with the skin), so the light does not slide over a moulded surface.
  const pores = mx_noise_float(positionGeometry.mul(1400)).mul(mix(float(0.00012), float(0.00007), glove));
  m.normalNode = bumpMap(pores);
  m.roughnessNode = mix(mix(float(0.52), float(0.3), nail), float(0.62), glove);
  m.sheenNode = vec3(...linear(0x5a4030)).mul(glove.mul(0.4));
  m.sheenRoughnessNode = float(0.6);
  // Thin skin glows red at the edges against the light (fingers, knuckles); the glove's leather does not.
  m.thicknessColorNode = mix(vec3(0.8, 0.25, 0.12), vec3(0), glove);
  m.thicknessDistortionNode = float(0.2);
  m.thicknessPowerNode = float(3);
  m.thicknessScaleNode = float(2.5);
  m.thicknessAttenuationNode = float(0.8);
  materials = {
    arm: m,
    sleeve: new MeshPhysicalNodeMaterial({ name: 'sleeve', color: 0x5f6048, roughness: 0.92, metalness: 0, sheen: 0.5, sheenRoughness: 0.8, sheenColor: 0x5f6048 }),
    watch: new MeshStandardNodeMaterial({ name: 'watch', color: 0x1f1f1f, roughness: 0.4, metalness: 0 }),
  };
  return materials;
}

/** Tribal band tattoo on skin, u around the forearm (0.5 its back), v along it from the wrist. */
function tattooTexture(): CanvasTexture {
  const el = document.createElement('canvas');
  el.width = 256;
  el.height = 256;
  const c = el.getContext('2d');
  if (!c) throw new Error('2d canvas unavailable for the tattoo texture');
  c.fillStyle = `#${SKIN_HEX.toString(16).padStart(6, '0')}`;
  c.fillRect(0, 0, 256, 256);
  // Freckles and tone variation.
  for (let i = 0; i < 400; i++) {
    c.fillStyle = `rgba(110,70,50,${Math.random() * 0.12})`;
    c.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // Veins on the inside of the wrist and up the forearm (u ≈ 0 is its inside), faint blue-green under the tan.
  c.strokeStyle = 'rgba(70,80,95,0.07)';
  c.lineWidth = 3;
  for (const x0 of [10, 238, 30]) {
    c.beginPath();
    c.moveTo(x0, 0);
    for (let y = 0; y <= 256; y += 32) c.lineTo(x0 + Math.sin(y * 0.05 + x0) * 10, y);
    c.stroke();
  }
  // Hair: fine, faint strokes lying along the arm toward the elbow, thicker over its back (u ≈ 0.5). At arm's
  // length they only darken the skin a touch and break up its sheen; drawn bolder they read as scratches.
  for (let i = 0; i < 5000; i++) {
    const x = Math.random() * 256;
    const onBack = Math.exp(-(((x - 128) / 70) ** 2));
    if (Math.random() > 0.25 + onBack * 0.75) continue;
    const y = 20 + Math.random() * 236;
    c.strokeStyle = `rgba(55,38,28,${0.05 + Math.random() * 0.07})`;
    c.lineWidth = 0.4;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + (Math.random() - 0.5) * 1.5, y + 2 + Math.random() * 2);
    c.stroke();
  }
  c.strokeStyle = 'rgba(28,32,36,0.88)';
  c.fillStyle = 'rgba(28,32,36,0.88)';
  c.lineCap = 'round';
  // Only on the outer half of the forearm (u 0.1 … 0.6), toward the elbow.
  for (let k = 0; k < 5; k++) {
    const x = 40 + k * 32;
    c.lineWidth = 7 - k * 0.6;
    c.beginPath();
    c.moveTo(x, 150);
    c.bezierCurveTo(x + 20, 120, x - 18, 90, x + 10, 60);
    c.stroke();
    c.beginPath();
    c.moveTo(x + 10, 60);
    c.quadraticCurveTo(x + 26, 48, x + 20, 30);
    c.lineTo(x + 12, 42);
    c.fill();
  }
  c.lineWidth = 5;
  c.beginPath();
  c.moveTo(30, 160);
  c.lineTo(200, 160);
  c.stroke();
  const t = new CanvasTexture(el);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  return t;
}

/** The hand's bones under its wrist frame (`root`), posed by finger curl. */
export class Hand {
  readonly root = new Group();
  /** Bones from the wrist on, in the bake's order after the forearm. */
  readonly bones: Bone[];
  private readonly rotations: Quaternion[];

  constructor(
    private readonly side: 1 | -1,
    private readonly data: HandData,
  ) {
    const all: Bone[] = data.bones.map(() => new Bone());
    data.bones.forEach((b, i) => {
      if (i === 0) return; // the forearm's bone lives in the forearm (Arm)
      const bone = all[i] as Bone;
      bone.name = b.name;
      const parent = b.parent > 0 ? (data.bones[b.parent] as (typeof data.bones)[number]) : null;
      bone.position.copy(b.head);
      if (parent) bone.position.sub(parent.head);
      (b.parent > 0 ? (all[b.parent] as Bone) : this.root).add(bone);
    });
    this.bones = all.slice(1);
    this.rotations = data.bones.map(() => new Quaternion());
  }

  setPose(p: HandPose): void {
    poseRotations(this.data, p, this.side, this.rotations);
    this.bones.forEach((b, i) => b.quaternion.copy(this.rotations[i + 1] as Quaternion));
  }
}

/** Pose interpolation, component-wise. */
export function mixPose(a: HandPose, b: HandPose, t: number, out: HandPose): HandPose {
  for (let i = 0; i < 4; i++) out.curl[i] = (a.curl[i] as number) + ((b.curl[i] as number) - (a.curl[i] as number)) * t;
  out.thumb = a.thumb + (b.thumb - a.thumb) * t;
  out.spread = a.spread + (b.spread - a.spread) * t;
  return out;
}

export function copyPose(p: HandPose): HandPose {
  return { curl: [...p.curl], thumb: p.thumb, spread: p.spread };
}

/** The forearm's cross-section `alongM` from the wrist, in its own frame (x, y): centre and half-extents. */
function forearmSection(data: HandData, alongM: number): { cx: number; cy: number; rx: number; ry: number } {
  const pos = data.geometry.getAttribute('position');
  const fy = data.forearmUp;
  const fz = data.forearmAxis;
  const fx = new Vector3().crossVectors(fy, fz);
  const p = new Vector3();
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (Math.abs(p.dot(fz) - alongM) > 0.006) continue;
    const x = p.dot(fx);
    const y = p.dot(fy);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0)) return { cx: 0, cy: 0, rx: 0.028, ry: 0.024 };
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2 };
}

/** Shoulder → elbow → wrist → hand, solved each frame. */
export class Arm {
  readonly root = new Group();
  readonly hand: Hand;
  /** At the wrist: +Z toward the elbow, +Y the back of the hand (the forearm bone's frame). */
  private readonly forearm = new Group();
  private readonly upper = new Group();
  private readonly elbow = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly pole = new Vector3();
  readonly shoulder: Vector3;

  constructor(readonly side: 1 | -1) {
    const M = armMaterials();
    const data = handData(side);
    this.hand = new Hand(side, data);
    this.shoulder = new Vector3(0.19 * side, -0.33, 0.1);
    this.pole.set(0.55 * side, -0.75, 0.15);

    // One skin over the forearm's bone and the hand's: bind inverses from the rest pose in the hand frame
    // (the forearm's own frame there; every hand bone unrotated at its joint).
    const foreBone = new Bone();
    foreBone.name = 'forearm';
    this.forearm.add(foreBone);
    const fy = data.forearmUp;
    const fz = data.forearmAxis;
    const fx = new Vector3().crossVectors(fy, fz);
    const inverses = data.bones.map((b, i) => (i === 0 ? new Matrix4().makeBasis(fx, fy, fz) : new Matrix4().makeTranslation(b.head)).invert());
    const geometry = data.geometry.clone();
    // The glove's leather stands a little off the skin it covers.
    const pos = geometry.getAttribute('position');
    const nrm = geometry.getAttribute('normal');
    const reg = geometry.getAttribute('region');
    for (let i = 0; i < pos.count; i++) {
      const g = (1 - Math.min(1, Math.max(0, (reg.getX(i) - 0.35) / 0.3))) * (1 - Math.min(1, Math.max(0, (reg.getZ(i) - 0.3) / 0.4)));
      pos.setXYZ(i, pos.getX(i) + nrm.getX(i) * GLOVE_THICKNESS_M * g, pos.getY(i) + nrm.getY(i) * GLOVE_THICKNESS_M * g, pos.getZ(i) + nrm.getZ(i) * GLOVE_THICKNESS_M * g);
    }
    const skin = new SkinnedMesh(geometry, M.arm);
    skin.bind(new Skeleton([foreBone, ...this.hand.bones], inverses), new Matrix4());
    skin.frustumCulled = false; // bounds come from the rest pose, not the posed arm
    skin.castShadow = false; // the player's own arms cast no shadow into the world view
    skin.receiveShadow = true;

    if (side === -1) {
      // A cheap field watch on the left wrist, round the forearm's own section there.
      const s = forearmSection(data, 0.045);
      const strap = new Mesh(new CylinderGeometry(1, 1, 0.02, 20, 1, true).rotateX(Math.PI / 2).scale(s.rx + 0.003, s.ry + 0.003, 1).translate(s.cx, s.cy, 0.045), M.watch);
      const face = new Mesh(new CylinderGeometry(0.017, 0.017, 0.008, 16).translate(s.cx, s.cy + s.ry + 0.005, 0.045), M.watch);
      this.forearm.add(strap, face);
    }
    // Rolled sleeve at the elbow, over the end of the forearm's skin, and the upper arm in the shirt.
    const elbowEnd = forearmSection(data, 0.235);
    const cuff = new Mesh(new CylinderGeometry(1, 1, 0.07, 16).rotateX(Math.PI / 2).scale(elbowEnd.rx + 0.012, elbowEnd.ry + 0.012, 1).translate(elbowEnd.cx, elbowEnd.cy, FOREARM_M - 0.01), M.sleeve);
    this.forearm.add(cuff);
    const up = new Mesh(new CylinderGeometry(0.06, 0.052, UPPER_ARM_M, 14).rotateX(Math.PI / 2).translate(0, 0, UPPER_ARM_M / 2), M.sleeve);
    this.upper.add(up);
    this.root.add(skin, this.forearm, this.upper, this.hand.root);
  }

  /** Put the hand's wrist at `wrist` with orientation `q`, and bend the arm to meet it. */
  reach(wrist: Vector3, q: Quaternion): void {
    this.hand.root.position.copy(wrist);
    this.hand.root.quaternion.copy(q);
    const s = this.shoulder;
    const toWrist = this.tmp.subVectors(wrist, s);
    const d = Math.min(toWrist.length(), UPPER_ARM_M + FOREARM_M - 1e-3);
    const dir = toWrist.normalize();
    // Law of cosines: angle at the shoulder between the upper arm and the shoulder→wrist line.
    const cosA = (UPPER_ARM_M * UPPER_ARM_M + d * d - FOREARM_M * FOREARM_M) / (2 * UPPER_ARM_M * d);
    const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const bend = this.tmp2.copy(this.pole).addScaledVector(dir, -this.pole.dot(dir)).normalize();
    this.elbow.copy(s).addScaledVector(dir, Math.cos(a) * UPPER_ARM_M).addScaledVector(bend, Math.sin(a) * UPPER_ARM_M);
    // The forearm toward the elbow, rolled with the hand: the back of the forearm follows the back of the hand.
    _z.subVectors(this.elbow, wrist).normalize();
    _y.set(0, 1, 0).applyQuaternion(q);
    _y.addScaledVector(_z, -_y.dot(_z));
    if (_y.lengthSq() < 1e-6) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
    _y.normalize();
    _x.crossVectors(_y, _z);
    this.forearm.position.copy(wrist);
    this.forearm.quaternion.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
    this.upper.position.copy(this.elbow);
    this.upper.lookAt(this.localToParent(s));
  }

  /** lookAt works in world space; the arm lives inside the camera rig. */
  private localToParent(v: Vector3): Vector3 {
    const out = _w.copy(v);
    return this.root.localToWorld(out);
  }
}

const _w = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _basis = new Matrix4();
