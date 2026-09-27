import { CanvasTexture, CapsuleGeometry, CylinderGeometry, Group, type Material, Mesh, MeshPhysicalNodeMaterial, MeshSSSNodeMaterial, MeshStandardNodeMaterial, Object3D, Quaternion, RepeatWrapping, SphereGeometry, SRGBColorSpace, Vector3 } from 'three/webgpu';
import { float, texture, vec3 } from 'three/tsl';
import { merge, tube } from './meshkit.ts';

// First-person arms: articulated hands (three-segment fingers and a thumb,
// fingerless leather gloves) on tattooed forearms and rolled sleeves. Each
// arm hangs from a fixed shoulder and reaches its hand target through a
// two-bone IK with an outward-and-down elbow pole, so the hands are always
// attached to something — they never float. Metres, camera space (x right,
// y up, −z forward). Hand frame: wrist at the origin, fingers along −Z,
// palm facing −Y, thumb toward −X (right hand; the left is mirrored).

const UPPER_ARM_M = 0.3;
const FOREARM_M = 0.27;

export interface HandPose {
  /** Finger curl 0 (flat) … 1 (fist), index → pinky. */
  curl: [number, number, number, number];
  /** Thumb: 0 alongside the palm, 1 wrapped across it. */
  thumb: number;
  /** Finger spread 0..1. */
  spread: number;
}

export const POSES = {
  relaxed: { curl: [0.35, 0.42, 0.5, 0.58], thumb: 0.25, spread: 0.2 },
  open: { curl: [0.08, 0.08, 0.1, 0.12], thumb: 0.05, spread: 0.7 },
  grip: { curl: [0.72, 0.85, 0.88, 0.9], thumb: 0.85, spread: 0.05 },
  trigger: { curl: [0.45, 0.85, 0.88, 0.9], thumb: 0.8, spread: 0.05 },
  cradle: { curl: [0.55, 0.62, 0.66, 0.7], thumb: 0.55, spread: 0.1 },
  pinch: { curl: [0.62, 0.7, 0.8, 0.85], thumb: 0.9, spread: 0.1 },
} as const satisfies Record<string, HandPose>;

const FINGERS = [
  { x: -0.028, len: [0.044, 0.026, 0.021], r: 0.0092, splay: -0.08 },
  { x: -0.009, len: [0.049, 0.03, 0.023], r: 0.0095, splay: 0 },
  { x: 0.011, len: [0.046, 0.028, 0.022], r: 0.009, splay: 0.06 },
  { x: 0.029, len: [0.035, 0.021, 0.019], r: 0.0078, splay: 0.14 },
];

let materials: { skin: MeshSSSNodeMaterial; glove: MeshPhysicalNodeMaterial; tattooSkin: MeshSSSNodeMaterial; sleeve: MeshPhysicalNodeMaterial; watch: MeshStandardNodeMaterial } | null = null;

function armMaterials() {
  if (materials) return materials;
  const skinColour = 0xb4825f; // sheet: tanned skin, rough 0.5, scattering warm-red
  const makeSkin = (map: CanvasTexture | null): MeshSSSNodeMaterial => {
    const m = new MeshSSSNodeMaterial({ name: map ? 'forearm skin' : 'hand skin', color: skinColour, roughness: 0.52, metalness: 0 });
    if (map) {
      m.map = map;
      m.colorNode = texture(map).rgb;
    }
    // Thin skin glows red at the edges against the light (fingers, ears): SSS through the shadowed light.
    m.thicknessColorNode = vec3(0.8, 0.25, 0.12);
    m.thicknessDistortionNode = float(0.2);
    m.thicknessPowerNode = float(3);
    m.thicknessScaleNode = float(2.5);
    m.thicknessAttenuationNode = float(0.8);
    return m;
  };
  materials = {
    skin: makeSkin(null),
    tattooSkin: makeSkin(tattooTexture()),
    glove: new MeshPhysicalNodeMaterial({ name: 'glove', color: 0x3a2a20, roughness: 0.62, metalness: 0, sheen: 0.4, sheenRoughness: 0.6, sheenColor: 0x5a4030 }),
    sleeve: new MeshPhysicalNodeMaterial({ name: 'sleeve', color: 0x5f6048, roughness: 0.92, metalness: 0, sheen: 0.5, sheenRoughness: 0.8, sheenColor: 0x5f6048 }),
    watch: new MeshStandardNodeMaterial({ name: 'watch', color: 0x1f1f1f, roughness: 0.4, metalness: 0 }),
  };
  return materials;
}

/** Tribal band tattoo on skin, u around the forearm, v along it. */
function tattooTexture(): CanvasTexture {
  const el = document.createElement('canvas');
  el.width = 256;
  el.height = 256;
  const c = el.getContext('2d');
  if (!c) throw new Error('2d canvas unavailable for the tattoo texture');
  c.fillStyle = '#b4825f';
  c.fillRect(0, 0, 256, 256);
  // Freckles and tone variation.
  for (let i = 0; i < 400; i++) {
    c.fillStyle = `rgba(120,70,45,${Math.random() * 0.12})`;
    c.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
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

/** One articulated hand. */
export class Hand {
  readonly root = new Group();
  private readonly joints: Object3D[][] = [];
  private readonly thumbJoints: Object3D[] = [];

  constructor() {
    const M = armMaterials();
    // Palm: a flattened rounded block, gloved, with knuckle ridge and thenar pad.
    const palm = merge(
      [
        new CapsuleGeometry(0.04, 0.03, 4, 10).rotateZ(Math.PI / 2).scale(1, 0.36, 1.2).translate(0, 0, -0.058),
        new SphereGeometry(0.03, 10, 8).scale(1.1, 0.7, 1.3).translate(-0.022, -0.006, -0.03),
        new SphereGeometry(0.028, 10, 8).scale(1.2, 0.6, 1).translate(0.01, 0, -0.012),
      ],
      'palm',
    );
    this.root.add(this.mesh(palm, M.glove));
    FINGERS.forEach((f, i) => {
      let parent: Object3D = this.root;
      const chain: Object3D[] = [];
      f.len.forEach((len, s) => {
        const joint = new Object3D();
        joint.position.set(s === 0 ? f.x : 0, s === 0 ? 0.002 : 0, s === 0 ? -0.094 + Math.abs(f.x) * 0.25 : -(f.len[s - 1] as number));
        const r = f.r * (1 - s * 0.1);
        const seg = new CapsuleGeometry(r, Math.max(0.001, len - r), 3, 8).rotateX(Math.PI / 2).translate(0, 0, -len / 2);
        joint.add(this.mesh(seg, s === 0 ? M.glove : M.skin));
        parent.add(joint);
        chain.push(joint);
        parent = joint;
      });
      this.joints[i] = chain;
    });
    // Thumb from the heel of the palm, angled forward and toward −X.
    let parent: Object3D = this.root;
    const thumbLen = [0.04, 0.032, 0.027];
    thumbLen.forEach((len, s) => {
      const joint = new Object3D();
      if (s === 0) {
        joint.position.set(-0.032, -0.008, -0.03);
        joint.rotation.set(0, 0.75, 0.5);
      } else joint.position.set(0, 0, -(thumbLen[s - 1] as number));
      const r = 0.0115 - s * 0.0012;
      joint.add(this.mesh(new CapsuleGeometry(r, len - r, 3, 8).rotateX(Math.PI / 2).translate(0, 0, -len / 2), s === 0 ? M.glove : M.skin));
      parent.add(joint);
      this.thumbJoints.push(joint);
      parent = joint;
    });
  }

  private mesh(g: CapsuleGeometry | ReturnType<typeof merge>, m: Material): Mesh {
    const out = new Mesh(g, m);
    out.castShadow = false; // the player's own hands cast no shadow into the world view
    out.receiveShadow = true;
    return out;
  }

  setPose(p: HandPose): void {
    this.joints.forEach((chain, i) => {
      const c = p.curl[i] as number;
      const f = FINGERS[i] as (typeof FINGERS)[number];
      chain.forEach((j, s) => {
        j.rotation.x = -c * (s === 0 ? 1.45 : s === 1 ? 1.65 : 1.1);
        if (s === 0) j.rotation.y = -(f.splay * (0.4 + p.spread));
      });
    });
    const t = p.thumb;
    const [t0, t1, t2] = this.thumbJoints as [Object3D, Object3D, Object3D];
    t0.rotation.set(-0.25 - t * 0.55, 0.75 - t * 0.55, 0.5 + t * 0.4);
    t1.rotation.x = -t * 0.6;
    t2.rotation.x = -t * 0.75;
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

/** Shoulder → elbow → wrist → hand, solved each frame. */
export class Arm {
  readonly root = new Group();
  readonly hand = new Hand();
  private readonly forearm = new Group();
  private readonly upper = new Group();
  private readonly elbow = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly pole = new Vector3();
  readonly shoulder: Vector3;

  constructor(readonly side: 1 | -1) {
    const M = armMaterials();
    this.shoulder = new Vector3(0.19 * side, -0.33, 0.1);
    this.pole.set(0.55 * side, -0.75, 0.15);
    if (side === -1) this.hand.root.scale.x = -1;
    // Forearm: tapered, slightly flattened, wrist at z = 0 running to the elbow at +z.
    const pts: Vector3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push(new Vector3(0, 0.002 * Math.sin(t * Math.PI), t * FOREARM_M));
      radii.push(0.025 + 0.02 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.5) - (t > 0.9 ? (t - 0.9) * 0.08 : 0));
    }
    const fore = tube(pts, radii, 14, FOREARM_M);
    fore.scale(1.12, 0.88, 1);
    const foreMesh = new Mesh(fore, M.tattooSkin);
    foreMesh.receiveShadow = true;
    this.forearm.add(foreMesh);
    if (side === -1) {
      // A cheap field watch on the left wrist.
      const strap = new Mesh(new CylinderGeometry(0.03, 0.03, 0.02, 16, 1, true).rotateX(Math.PI / 2).scale(1.12, 0.9, 1).translate(0, 0, 0.035), M.watch);
      const face = new Mesh(new CylinderGeometry(0.017, 0.017, 0.008, 16).translate(0, 0.028, 0.035), M.watch);
      this.forearm.add(strap, face);
    }
    // Rolled sleeve at the elbow and the upper arm in the shirt.
    const cuff = new Mesh(new CylinderGeometry(0.056, 0.052, 0.07, 14).rotateX(Math.PI / 2).translate(0, 0, FOREARM_M - 0.01), M.sleeve);
    this.forearm.add(cuff);
    const up = new Mesh(new CylinderGeometry(0.06, 0.052, UPPER_ARM_M, 14).rotateX(Math.PI / 2).translate(0, 0, UPPER_ARM_M / 2), M.sleeve);
    this.upper.add(up);
    this.root.add(this.forearm, this.upper, this.hand.root);
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
    this.forearm.position.copy(wrist);
    this.forearm.lookAt(this.localToParent(this.elbow));
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
