import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxGeometry, type BufferGeometry, CapsuleGeometry, Euler, Group, IcosahedronGeometry, InstancedMesh, type Material, Matrix4, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Quaternion, SphereGeometry, Vector3 } from 'three/webgpu';
import type { BodyPart } from '../game/actor.ts';
import type { Soldier } from '../game/soldier.ts';

// Enemy infantry, drawn from the same per-part hitboxes the bullets test
// against, so what you see is exactly what you can hit. Parts are instanced
// across all soldiers. Legs swing with ground speed; the rifle follows the
// soldier's aim. Positions are interpolated between 60 Hz logic steps.
//
// These are procedural stand-ins, not scanned characters (rules §3.1 asks for
// scanned or licensed ones); materials follow the sheet: uniform fabric with
// sheen, NATO-green armour, khaki helmet. No gore: the dead lie prone.

const MAX_SOLDIERS = 96;

interface PartVisual {
  part: BodyPart | 'helmet' | 'rifle' | 'bootL' | 'bootR';
  mesh: InstancedMesh;
}

export class ActorView {
  readonly group = new Group();
  private readonly visuals: PartVisual[] = [];
  private readonly prevFeet: Vector3[] = [];
  private readonly currFeet: Vector3[] = [];
  private readonly walkPhase: number[] = [];

  constructor() {
    this.group.name = 'actors';
    // Sheet: uniform fabric #5A5E48 rough 0.90, sheen 0.4 / sheenRough 0.8.
    const uniformMat = new MeshPhysicalNodeMaterial({ color: 0x5a5e48, roughness: 0.9, metalness: 0, sheen: 0.4, sheenRoughness: 0.8, sheenColor: 0x5a5e48 });
    const armour = new MeshStandardNodeMaterial({ color: 0x4b5340, roughness: 0.76, metalness: 0 }); // sheet: NATO green
    const helmet = new MeshStandardNodeMaterial({ color: 0x5c5b3e, roughness: 0.8, metalness: 0 }); // sheet: khaki green
    const balaclava = new MeshPhysicalNodeMaterial({ color: 0x3c3c3e, roughness: 0.92, sheen: 0.3, sheenRoughness: 0.9, sheenColor: 0x3c3c3e });
    const rubber = new MeshStandardNodeMaterial({ color: 0x2b2b2d, roughness: 0.9, metalness: 0 }); // sheet: rubber
    const parkerised = new MeshStandardNodeMaterial({ color: 0x3c3c3e, roughness: 0.62, metalness: 0 }); // sheet: parkerised finish

    const unitBox = new BoxGeometry(1, 1, 1);
    const capsule = new CapsuleGeometry(0.5, 1, 4, 10); // scaled per part to the hitbox
    const head = new IcosahedronGeometry(0.5, 2);
    const helmetGeo = new SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const rifleGeo = rifleGeometry();
    const add = (part: PartVisual['part'], geometry: BufferGeometry, material: Material): void => {
      const mesh = new InstancedMesh(geometry, material, MAX_SOLDIERS);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // instances move every frame; bounds would go stale
      this.visuals.push({ part, mesh });
      this.group.add(mesh);
    };
    add('head', head, balaclava);
    add('helmet', helmetGeo, helmet);
    add('chest', unitBox, armour);
    add('abdomen', capsule, uniformMat);
    add('armL', capsule, uniformMat);
    add('armR', capsule, uniformMat);
    add('legL', capsule, uniformMat);
    add('legR', capsule, uniformMat);
    add('bootL', unitBox, rubber);
    add('bootR', unitBox, rubber);
    add('rifle', rifleGeo, parkerised);
    for (let i = 0; i < MAX_SOLDIERS; i++) {
      this.prevFeet.push(new Vector3());
      this.currFeet.push(new Vector3());
      this.walkPhase.push(0);
    }
  }

  /** Call once before each logic step, to keep the previous positions for interpolation. */
  beforeStep(soldiers: readonly Soldier[]): void {
    const n = Math.min(soldiers.length, MAX_SOLDIERS);
    for (let i = 0; i < n; i++) {
      const s = soldiers[i] as Soldier;
      (this.prevFeet[i] as Vector3).set(s.body.position.x, s.body.position.y, s.body.position.z);
    }
  }

  update(soldiers: readonly Soldier[], alpha: number, frameSeconds: number): void {
    const n = Math.min(soldiers.length, MAX_SOLDIERS);
    for (const v of this.visuals) v.mesh.count = n;
    for (let i = 0; i < n; i++) {
      const s = soldiers[i] as Soldier;
      const prev = this.prevFeet[i] as Vector3;
      const curr = (this.currFeet[i] as Vector3).set(s.body.position.x, s.body.position.y, s.body.position.z);
      // Offset every part by (interpolated feet − current feet).
      _shift.copy(prev).lerp(curr, alpha).sub(curr);
      if (s.alive && s.stance === 'stand') this.walkPhase[i] = ((this.walkPhase[i] as number) + s.speedMs * frameSeconds * 3.2) % (Math.PI * 2);
      const swing = s.alive && s.stance === 'stand' ? Math.sin(this.walkPhase[i] as number) * Math.min(1, s.speedMs / 3) * 0.5 : 0;
      for (const v of this.visuals) this.place(v, s, i, swing);
    }
    for (const v of this.visuals) v.mesh.instanceMatrix.needsUpdate = true;
  }

  private place(v: PartVisual, s: Soldier, i: number, swing: number): void {
    const yaw = s.yawRad;
    _q.setFromEuler(_euler.set(0, yaw, 0, 'YXZ'));
    if (v.part === 'helmet') {
      const hb = s.hitboxes.partCenter('head');
      _pos.set(hb.x, hb.y + 0.03, hb.z).add(_shift);
      _scale.set(0.27, 0.27, 0.3);
    } else if (v.part === 'rifle') {
      // Held at the chest, pointing along the aim (yaw and pitch); lowered on patrol.
      const chest = s.hitboxes.partCenter('chest');
      const pitch = s.alive ? (s.state === 'patrol' ? -0.6 : s.pitchRad) : 0;
      _q.setFromEuler(_euler.set(pitch, yaw, s.alive ? 0 : Math.PI / 2, 'YXZ'));
      _pos.set(0.14, 0.06, -0.28).applyQuaternion(_q).add(chest).add(_shift);
      if (!s.alive) _pos.y = s.body.position.y + 0.08;
      _scale.set(1, 1, 1);
    } else if (v.part === 'bootL' || v.part === 'bootR') {
      const leg = s.hitboxes.parts.find((p) => p.part === (v.part === 'bootL' ? 'legL' : 'legR'));
      if (!leg) return;
      const b = leg.box;
      const side = v.part === 'bootL' ? 1 : -1;
      const standing = s.alive && s.stance === 'stand';
      _pos.set(b.center.x, standing ? s.body.position.y + 0.06 : b.center.y - b.halfExtents.y + 0.06, b.center.z).add(_shift);
      if (standing) {
        // Foot follows the leg swing: forward along the facing.
        const reach = Math.sin(swing * side) * 0.44;
        _pos.x += -Math.sin(yaw) * reach;
        _pos.z += -Math.cos(yaw) * reach;
      }
      _scale.set(0.12, 0.12, 0.28);
    } else {
      const hb = s.hitboxes.parts.find((p) => p.part === v.part);
      if (!hb) return;
      const b = hb.box;
      _pos.set(b.center.x, b.center.y, b.center.z).add(_shift);
      const isLimb = v.part === 'legL' || v.part === 'legR' || v.part === 'armL' || v.part === 'armR' || v.part === 'abdomen';
      if (isLimb) {
        // Capsule is 2 units tall (1 + two 0.5 caps): orient its long axis along the box's longest side.
        const hx = b.halfExtents.x;
        const hy = b.halfExtents.y;
        const hz = b.halfExtents.z;
        if (hz > hy && hz > hx) {
          _q.multiply(_tilt.setFromAxisAngle(_xAxis, Math.PI / 2));
          _scale.set(hx * 2, hz, hy * 2);
        } else {
          _scale.set(hx * 2, hy, hz * 2);
        }
        if ((v.part === 'legL' || v.part === 'legR') && swing !== 0) {
          // Swing about the hip: rotate around the top of the leg.
          const side = v.part === 'legL' ? 1 : -1;
          const a = swing * side;
          _q.multiply(_tilt.setFromAxisAngle(_xAxis, -a));
          _pos.y -= hy * (1 - Math.cos(a));
          _pos.x += -Math.sin(yaw) * Math.sin(a) * hy;
          _pos.z += -Math.cos(yaw) * Math.sin(a) * hy;
        }
      } else {
        _scale.set(b.halfExtents.x * 2, b.halfExtents.y * 2, b.halfExtents.z * 2);
        if (v.part === 'head') _scale.multiplyScalar(0.95);
      }
    }
    _m.compose(_pos, _q, _scale);
    v.mesh.setMatrixAt(i, _m);
  }
}

/** Carbine silhouette, ~0.9 m: receiver, barrel, magazine, stock, optic. Faces −Z. */
function rifleGeometry(): BufferGeometry {
  const parts = [
    new BoxGeometry(0.05, 0.08, 0.36).translate(0, 0, 0),
    new BoxGeometry(0.02, 0.02, 0.36).translate(0, 0.01, -0.36),
    new BoxGeometry(0.035, 0.14, 0.07).rotateX(0.2).translate(0, -0.1, -0.06),
    new BoxGeometry(0.04, 0.08, 0.26).translate(0, -0.01, 0.3),
    new BoxGeometry(0.04, 0.05, 0.1).translate(0, 0.07, -0.02),
  ];
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('rifle merge failed');
  return g;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _tilt = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const _shift = new Vector3();
const _euler = new Euler();
const _xAxis = new Vector3(1, 0, 0);
