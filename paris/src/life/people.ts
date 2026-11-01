import { attribute, float, mix, mx_noise_float, positionGeometry, step, texture, uv, vec3 } from 'three/tsl';
import { BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshPhysicalNodeMaterial, type Node, Quaternion, Vector3 } from 'three/webgpu';
import { boneIndex, clipDuration, clipSpeed, MocapPose, mocapReady } from '../render/mocap.ts';
import { linearRgb } from '../render/nodes.ts';
import { BoneTexture, skinnedPosition } from '../render/skinning.ts';
import { solveTwoBone, boneOf, BONES, type Build, BUILDS, buildBody, frame, PART, type Segment, smooth } from './body.ts';
import type { Person } from './crowd.ts';
import type { Character, CharacterLod } from './humanMesh.ts';
import { FULL_BONES, type FullPoser } from './fullPose.ts';
import { BODY_RIG, type Rig } from './rig.ts';

// The crowd drawn: one skinned, instanced mesh per build (body.ts), the bones
// of every person written each frame into a float texture. Walking is the
// motion capture (the CMU walk, blended toward the run with speed), applied
// as rotations on this body's own limb lengths with the planted foot on the
// ground, the gait advanced by ground speed over the stride so feet do not
// slide, arms swinging as captured. Standing is the capture's moment with
// both feet planted; sitting is built by hand (thighs on the seat, shins down,
// forearms on the table). Colours come from each person's palette by the
// vertex's `part`. When characters built in Blender are present
// (humanMesh.ts) they replace the procedural builds: each person is one of
// them (by gender), posed on that character's own joints (rig.ts) and drawn
// with its clothes', hair's and skin's textures.

type Rgb = [number, number, number];
const TOPS: Rgb[] = [0xa07a4c, 0x1d2433, 0x161616, 0x3a3a3c, 0xb39b72, 0x4d5038, 0x5a1f25, 0x6e6e70, 0x24382c, 0xcfc5ae, 0x4a2e1e, 0x55688a].map(linearRgb);
const BOTTOMS: Rgb[] = [0x1f2a40, 0x3d5070, 0x151515, 0x4a4a4c, 0xa08f70, 0x1c2232, 0x4a3626, 0x2c2c2e, 0x2a3328, 0x4a1a20].map(linearRgb);
// Dark and brown hair most often; fair, red and grey less.
const HAIR: Rgb[] = [0x141110, 0x2a1c14, 0x4a3020, 0x7a5a38, 0xb8955a, 0x1e1612, 0x6a2e1a, 0x8a8580].map(linearRgb);
const ACCENTS: Rgb[] = [0x8a1f1f, 0xb08a2a, 0x8a8a8a, 0x1a1a1a, 0xd8cfb8, 0x1d2a4a, 0x2a4a32, 0x8a5a32, 0xb06a7a, 0x2a6a6a].map(linearRgb);

export class PeopleView {
  readonly group = new Group();
  private readonly meshes: { mesh: InstancedMesh; bones: BoneTexture; prev: BoneTexture; members: Person[]; rig: Rig; poser: FullPoser | null }[] = [];
  private readonly fullMatrices = FULL_BONES.map(() => new Matrix4());
  /** Time for the stationary loops (talking, waiting, sitting). */
  private clockS = 0;
  /** The rig of the mesh being posed. */
  private rig: Rig = BODY_RIG;
  private readonly poseA = new MocapPose();
  private readonly poseB = new MocapPose();
  /** Instance being posed: its bone texture and row. */
  private target!: { bones: BoneTexture; row: number };

  /**
   * `near`: who comes close enough to the camera for the full body; the rest get the coarse one. Decided
   * once, so nobody changes instance slot mid-shot (the velocity buffer would see a jump).
   */
  constructor(people: readonly Person[], near: (p: Person) => boolean, characters: readonly Character[] = []) {
    this.group.name = 'people';
    if (characters.length > 0) {
      // Each person one of the characters of their build's sex, picked by a hash of their place in the crowd.
      const women = characters.filter((c) => c.gender < 0.5);
      const men = characters.filter((c) => c.gender >= 0.5);
      const cast = new Map<Character, Person[]>();
      people.forEach((p, i) => {
        const woman = p.build === 'coatWoman' || p.build === 'skirtWoman';
        const pool = (woman ? women : men).length > 0 ? (woman ? women : men) : characters;
        const c = pool[Math.floor(hash01(i) * pool.length)] as Character;
        cast.set(c, [...(cast.get(c) ?? []), p]);
      });
      for (const [c, members] of cast) for (const fine of [true, false]) this.addCharacter(c, fine, members.filter((p) => near(p) === fine));
      return;
    }
    for (const build of BUILDS) for (const fine of [true, false]) this.addBuild(build, fine, people.filter((p) => p.build === build && near(p) === fine));
  }

  private addCharacter(c: Character, fine: boolean, members: Person[]): void {
    if (members.length === 0) return;
    const lod: CharacterLod = fine ? c.full : c.far;
    const boneCount = c.poser ? FULL_BONES.length : BONES.length;
    const bones = new BoneTexture(boneCount, members.length);
    const prev = new BoneTexture(boneCount, members.length);
    // One instanced mesh per piece (skin, clothes, hair…), all on the same vertex buffers and bone textures,
    // each drawing its own index range. A single mesh with a material array (geometry groups) lost uniform
    // buffers under WebGPU when instanced and shadow-casting (three r186: "used in submit while destroyed").
    let first: InstancedMesh | null = null;
    lod.pieces.forEach((piece) => {
      const g = new BufferGeometry();
      for (const [name, attr] of Object.entries(lod.geometry.attributes)) g.setAttribute(name, attr);
      g.setIndex(lod.geometry.index);
      g.setDrawRange(piece.start, piece.count);
      g.boundingSphere = lod.geometry.boundingSphere;
      const m = pieceMaterial(piece);
      m.positionNode = skinnedPosition(bones, prev);
      const mesh = new InstancedMesh(g, m, members.length);
      mesh.name = `people-${c.name}-${piece.kind}${fine ? '' : '-far'}`;
      // Brows and lashes are cards a few millimetres off the skin: their shadow is noise, not a shadow.
      mesh.castShadow = piece.kind !== 'eyebrows' && piece.kind !== 'eyelashes' && piece.kind !== 'eyes';
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      first ??= mesh;
    });
    const mesh = first as InstancedMesh | null;
    if (!mesh) return;
    this.meshes.push({ mesh, bones, prev, members, rig: c.rig, poser: c.poser });
  }

  private addBuild(build: Build, fine: boolean, members: Person[]): void {
    if (members.length === 0) return;
    const geo = buildBody(build, !fine);
    const bones = new BoneTexture(BONES.length, members.length);
    const prev = new BoneTexture(BONES.length, members.length);
    const look = new InstancedBufferAttribute(new Float32Array(members.length * 4), 4);
    const skin = new InstancedBufferAttribute(new Float32Array(members.length), 1);
    members.forEach((p, i) => {
      look.setXYZW(i, p.look[0], p.look[1], p.look[2], p.look[3]);
      skin.setX(i, p.skin);
    });
    geo.setAttribute('look', look);
    geo.setAttribute('skinTone', skin);
    const mat = clothesMaterial();
    mat.positionNode = skinnedPosition(bones, prev);
    const mesh = new InstancedMesh(geo, mat, members.length);
    mesh.name = `people-${build}${fine ? '' : '-far'}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // they move every frame; bounds would go stale
    this.group.add(mesh);
    this.meshes.push({ mesh, bones, prev, members, rig: BODY_RIG, poser: null });
  }

  /** Poses everyone for this frame; `dt` advances their gait. */
  update(dt: number): void {
    this.clockS += dt;
    for (const { bones, prev, members, rig, poser } of this.meshes) {
      this.rig = rig;
      prev.copyFrom(bones);
      members.forEach((p, row) => {
        this.target = { bones, row };
        if (poser) {
          this.poseFull(poser, p, dt);
          return;
        }
        if (p.mode === 'sit') this.poseSeated(p);
        else if (p.mode === 'ride') this.poseRiding(p);
        else {
          p.gait = advanceGait(p.gait, p.speedMs, dt);
          this.poseUpright(p);
        }
      });
      bones.commit();
    }
  }

  /** A person on the 21-bone skeleton (fullPose.ts): the capture, the chair or the bicycle. */
  private poseFull(poser: FullPoser, p: Person, dt: number): void {
    const out = this.fullMatrices;
    // Each person's own moment of the stationary loops, so a café's tables and a group at the lights do
    // not move in step.
    const t = this.clockS + ((p.skin * 13.7 + p.look[3] * 0.37) % 1) * 20;
    // Sitting is posed by hand: the capture's sitters (CMU) perch on stools, elbows on their knees, which at
    // a café table read as hunched.
    if (p.mode === 'ride') poser.riding(p.crankRad, out);
    else if (p.mode === 'sit') poser.seated(p.headYawRad, out);
    else if (!mocapReady()) return;
    else if (p.mode === 'stand') {
      // Standing in a group, talking: the capture's gestures.
      poser.walk(this.poseA.sample('talk', t).solve(), p.headYawRad, out);
    } else {
      p.gait = advanceGait(p.gait, p.speedMs, dt);
      const run = smooth(2.2, 3.0, p.speedMs);
      this.poseA.sample('walk', p.gait * clipDuration('walk'));
      if (run > 0) this.poseA.blend(this.poseB.sample('run', p.gait * clipDuration('run')), run);
      // Slowing to a stop (at the lights, behind someone): into the standing loop, weight shifting.
      const still = 1 - smooth(0.15, 0.6, p.speedMs);
      if (still > 0) this.poseA.blend(this.poseB.sample('idle', t), still);
      poser.walk(this.poseA.solve(), p.headYawRad, out);
    }
    this.actorMatrix(p);
    out.forEach((m, b) => this.target.bones.set(this.target.row, b, _m.multiplyMatrices(_actor, m)));
  }

  /** Copies the current bones into the previous ones: call after a jump in time (no motion between them). */
  settle(): void {
    for (const { bones, prev } of this.meshes) prev.copyFrom(bones);
  }

  // ---------------------------------------------------------------- posing (person frame: −Z forward, +X right)

  private actorMatrix(p: Person): void {
    _q.setFromAxisAngle(_yAxis, p.yawRad);
    _actor.compose(_pos.set(p.x, p.y, p.z), _q, _scale.setScalar(this.rig.ownSize ? 1 : p.scale));
  }

  private poseUpright(p: Person): void {
    if (!mocapReady()) return;
    const r = this.rig;
    this.actorMatrix(p);
    const run = smooth(2.2, 3.0, p.speedMs);
    this.poseA.sample('walk', p.gait * clipDuration('walk'));
    if (run > 0) this.poseA.blend(this.poseB.sample('run', p.gait * clipDuration('run')), run);
    const cap = this.poseA.solve();
    const D = (name: string): Quaternion => cap.delta[boneIndex(name)] as Quaternion;
    // The legs at the captured hip height, then the hips dropped so the planted foot meets the ground.
    const legs = (hip: Vector3): number => {
      let low = Infinity;
      for (const side of [0, 1] as const) {
        const L = side === 0 ? 'Left' : 'Right';
        hipJoint(r, hip, D('Hips'), side, _hipJoint);
        _dir.set(0, -1, 0).applyQuaternion(D(`${L}UpLeg`));
        _mid.copy(_hipJoint).addScaledVector(_dir, r.thigh);
        _dir.set(0, -1, 0).applyQuaternion(D(`${L}Leg`));
        _end.copy(_mid).addScaledVector(_dir, r.shin);
        low = Math.min(low, _end.y);
      }
      return low;
    };
    _hip.copy(cap.hips);
    _hip.y += r.ankleY - legs(_hip);
    for (const side of [0, 1] as const) {
      const L = side === 0 ? 'Left' : 'Right';
      hipJoint(r, _hip, D('Hips'), side, _hipJoint);
      _dir.set(0, -1, 0).applyQuaternion(D(`${L}UpLeg`));
      _mid.copy(_hipJoint).addScaledVector(_dir, r.thigh);
      this.place('thigh', side, _hipJoint, _up.copy(_dir).negate(), _front.set(0, 0, -1).applyQuaternion(D(`${L}UpLeg`)));
      _dir.set(0, -1, 0).applyQuaternion(D(`${L}Leg`));
      _end.copy(_mid).addScaledVector(_dir, r.shin);
      this.place('shin', side, _mid, _up.copy(_dir).negate(), _front.set(0, 0, -1).applyQuaternion(D(`${L}Leg`)));
      this.place('shoe', side, _end, _up.set(0, 1, 0).applyQuaternion(D(`${L}Foot`)), _front.set(0, 0, -1).applyQuaternion(D(`${L}Foot`)));
    }
    this.place('pelvis', 0, _hip, _up.set(0, 1, 0).applyQuaternion(D('Hips')), _front.set(0, 0, -1).applyQuaternion(D('Hips')));
    _up.set(0, 1, 0).applyQuaternion(D('Spine1'));
    _right.set(1, 0, 0).applyQuaternion(D('Spine1'));
    _front.crossVectors(_up, _right).normalize();
    this.place('torso', 0, _hip, _up, _front);
    _neck.copy(_hip).addScaledVector(_up, r.neck);
    _headUp.set(0, 1, 0).applyQuaternion(D('Head'));
    _look.set(0, 0, -1).applyQuaternion(D('Head')).applyAxisAngle(_yAxis, p.headYawRad);
    this.place('head', 0, _head.copy(_neck).addScaledVector(_headUp, r.headUp), _headUp, _look);
    // Arms as captured: the T-pose arm points out to its side, so its segment's +Y points back in.
    for (const side of [0, 1] as const) {
      const L = side === 0 ? 'Left' : 'Right';
      const sx = side === 1 ? 1 : -1;
      _shoulder.copy(_hip).addScaledVector(_up, r.spine).addScaledVector(_right, sx * r.shoulderHalf);
      _at.copy(_shoulder);
      for (const [seg, bone, len] of [['upperArm', 'Arm', r.upperArm], ['forearm', 'ForeArm', r.forearm], ['hand', 'Hand', 0]] as const) {
        _tmp.set(-sx, 0, 0).applyQuaternion(D(`${L}${bone}`));
        this.place(seg, side, _at, _tmp, _front2.set(0, 0, -1).applyQuaternion(D(`${L}${bone}`)));
        _at.addScaledVector(_tmp, -len);
      }
    }
  }

  /** Sitting on a bistro chair (seat 0.46 m), feet on the ground, forearms toward the table. */
  private poseSeated(p: Person): void {
    const r = this.rig;
    this.actorMatrix(p);
    const lean = 0.08;
    // The seat 0.46 m up; the hip joints ~8 cm above it.
    _hip.set(0, 0.54, 0.04);
    _up.set(0, 1, lean).normalize();
    this.place('pelvis', 0, _hip, _up, _front.set(0, 0, -1));
    this.place('torso', 0, _hip, _up, _front);
    _neck.copy(_hip).addScaledVector(_up, r.neck);
    _look.set(Math.sin(-p.headYawRad), -0.1, -Math.cos(p.headYawRad));
    this.place('head', 0, _head.copy(_neck).add(_v.set(0, r.headUp, 0)), _yAxis, _look);
    for (const side of [0, 1] as const) {
      const sx = side === 1 ? 1 : -1;
      hipJoint(r, _hip, _q.identity(), side, _hipJoint);
      _knee.set(sx * 0.11, _hip.y - 0.03, _hipJoint.z - r.thigh);
      _foot.set(sx * 0.12, r.ankleY, _knee.z + 0.06);
      _dir.subVectors(_knee, _hipJoint).normalize();
      this.place('thigh', side, _hipJoint, _up2.copy(_dir).negate(), _front.set(0, 1, 0));
      _dir.subVectors(_foot, _knee).normalize();
      this.place('shin', side, _knee, _up2.copy(_dir).negate(), _front.set(0, 0, -1));
      this.place('shoe', side, _foot, _yAxis, _front.set(sx * 0.15, 0, -1));
      // Arms: the elbow by the side, the forearm forward and in, hands toward the table's edge.
      _shoulder.set(sx * r.shoulderHalf, 0, 0).add(_hip).addScaledVector(_up, r.spine);
      _elbow.copy(_shoulder).add(_v.set(sx * 0.04, -r.upperArm * 0.9, -0.1));
      _dir.subVectors(_elbow, _shoulder).normalize();
      this.place('upperArm', side, _shoulder, _up2.copy(_dir).negate(), _front.set(0, 0, -1));
      _hand.copy(_elbow).add(_v.set(-sx * 0.08, 0.05, -r.forearm * 0.95));
      _dir.subVectors(_hand, _elbow).normalize();
      this.place('forearm', side, _elbow, _up2.copy(_dir).negate(), _front.set(0, 1, 0));
      this.place('hand', side, _hand, _up2.copy(_dir).negate(), _front.set(0, 1, 0));
    }
  }

  /**
   * On a bicycle (bike frame: saddle 0.95 m, bars at 1.0 m 0.47 m ahead, cranks 17 cm round a bottom
   * bracket at 0.3 m): the hips on the saddle, the back leaning forward, the hands on the grips and the feet
   * on the pedals, both by two-bone IK.
   */
  private poseRiding(p: Person): void {
    const r = this.rig;
    this.actorMatrix(p);
    _hip.set(0, 1.02, 0.2);
    _up.set(0, 1, -0.5).normalize();
    this.place('pelvis', 0, _hip, _up.clone().lerp(_yAxis, 0.5).normalize(), _front.set(0, 0, -1));
    this.place('torso', 0, _hip, _up, _front);
    _neck.copy(_hip).addScaledVector(_up, r.neck);
    this.place('head', 0, _head.copy(_neck).add(_v.set(0, r.headUp, 0)), _yAxis, _look.set(0, -0.15, -1));
    for (const side of [0, 1] as const) {
      const sx = side === 1 ? 1 : -1;
      const crank = p.crankRad + (side === 1 ? 0 : Math.PI);
      _foot.set(sx * 0.11, 0.3 + 0.17 * Math.cos(crank) + r.ankleY * 0.6, -0.17 * Math.sin(crank));
      hipJoint(r, _hip, _q.identity(), side, _hipJoint);
      solveTwoBone(_hipJoint, _foot, r.thigh, r.shin, _pole.set(sx * 0.1, 0.2, -1), _mid, _end);
      _dir.subVectors(_mid, _hipJoint).normalize();
      this.place('thigh', side, _hipJoint, _up2.copy(_dir).negate(), _pole);
      _dir.subVectors(_end, _mid).normalize();
      this.place('shin', side, _mid, _up2.copy(_dir).negate(), _pole);
      this.place('shoe', side, _end, _yAxis, _front.set(0, 0, -1));
      _shoulder.copy(_hip).addScaledVector(_up, r.spine).add(_v.set(sx * r.shoulderHalf, 0, 0));
      _hand.set(sx * 0.25, 1.0, -0.47);
      solveTwoBone(_shoulder, _hand, r.upperArm, r.forearm, _pole.set(sx * 0.6, -1, 0.2), _elbow, _end);
      _dir.subVectors(_elbow, _shoulder).normalize();
      this.place('upperArm', side, _shoulder, _up2.copy(_dir).negate(), _front.set(0, 0, -1));
      _dir.subVectors(_end, _elbow).normalize();
      this.place('forearm', side, _elbow, _up2.copy(_dir).negate(), _front.set(0, 0, -1));
      this.place('hand', side, _end, _up2.copy(_dir).negate(), _front.set(0, 1, 0));
    }
  }

  /** One segment: origin, its local +Y along `up`, its −Z toward `front`; written as bone × inverse bind. */
  private place(seg: Segment, side: 0 | 1, origin: Vector3, up: Vector3, front: Vector3): void {
    frame(_m, origin, up, front);
    _m.premultiply(_actor);
    const b = boneOf(seg, side);
    this.target.bones.set(this.target.row, b, _m.multiply(this.rig.unbind[b] as Matrix4));
  }
}

/** The hip joint of `side` on the pelvis at `hip` turned by `pelvis`. */
function hipJoint(r: Rig, hip: Vector3, pelvis: Quaternion, side: 0 | 1, out: Vector3): Vector3 {
  return out.set(side === 1 ? r.hipHalf : -r.hipHalf, -r.hipDrop, 0).applyQuaternion(pelvis).add(hip);
}

/** 0…1 from an integer, the same every run. */
function hash01(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * One piece of a Blender-made character: its own photographed texture (skin, cloth, hair), the AO baked into
 * its vertices on the indirect light, alpha-tested cards for hair and brows, a sheen on cloth.
 */
function pieceMaterial(piece: CharacterLod['pieces'][number]): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: `person-${piece.kind}`, metalness: 0, roughness: piece.roughness });
  const albedo = piece.albedo ? texture(piece.albedo, uv()) : null;
  m.colorNode = albedo ? albedo.rgb : vec3(...piece.colour);
  if (piece.normal) {
    m.normalMap = piece.normal;
  }
  m.aoNode = attribute('ao', 'float');
  if (piece.clip && albedo) {
    m.opacityNode = albedo.a;
    m.alphaTest = 0.5;
    m.side = DoubleSide;
  }
  if (piece.kind === 'clothes' || piece.kind === 'hat') {
    m.sheenRoughness = 0.7;
    m.sheenNode = (m.colorNode as Node<'vec3'>).mul(0.4);
  }
  if (piece.kind === 'eyes') m.clearcoatNode = float(1);
  return m;
}

/**
 * The next moment of the gait cycle (0…1): on at ground speed over the stride (walk and run strides blended
 * as their poses are), so feet do not slide; stopping, on to the next moment both feet are planted, held.
 */
export function advanceGait(g: number, v: number, dt: number): number {
  if (!mocapReady()) return g;
  if (v > 0.25) {
    const run = smooth(2.2, 3.0, v);
    const stride = (1 - run) * clipSpeed('walk') * clipDuration('walk') + run * clipSpeed('run') * clipDuration('run');
    return (g + (dt * v) / stride) % 1;
  }
  const into = g % 0.5;
  if (into < 1e-3) return g;
  const target = g - into + 0.5;
  const next = g + dt * 0.8;
  return next >= target ? target % 1 : next;
}

function pick(i: Node<'float'>, list: readonly Rgb[]): Node<'vec3'> {
  let out: Node<'vec3'> = vec3(...(list[0] as Rgb));
  for (let k = 1; k < list.length; k++) out = mix(out, vec3(...(list[k] as Rgb)), step(k - 0.5, i));
  return out;
}

function clothesMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'people', metalness: 0, sheenRoughness: 0.7 });
  const part = attribute('part', 'float');
  const look = attribute('look', 'vec4');
  const tone = attribute('skinTone', 'float');
  const is = (k: number): Node<'float'> => step(k - 0.5, part).mul(step(part, k + 0.5));
  const skin = mix(vec3(...linearRgb(0xe2b99a)), vec3(...linearRgb(0x5a3a28)), tone.mul(tone));
  const shoes = mix(vec3(...linearRgb(0x151413)), vec3(...linearRgb(0x3a2418)), step(0.5, look.w.mul(0.37).fract()));
  // Weave: a faint fabric texture in the part's own space (it moves with the body).
  const weave = mx_noise_float(positionGeometry.mul(90)).mul(0.08).add(0.96);
  // The face, in the bind pose's space (head centre at 0, 1.56, 0): eyes, brows, lips.
  const g = positionGeometry;
  const eye = (sx: number): Node<'float'> => step(vec3(g.x.sub(sx), g.y.sub(1.577), g.z.add(0.083)).length(), 0.011);
  const eyes = eye(0.031).add(eye(-0.031));
  const brow = step(g.x.abs().sub(0.031).abs(), 0.018).mul(step(g.y.sub(1.597).abs(), 0.004)).mul(step(g.z, -0.07));
  const lips = step(g.x.abs(), 0.02).mul(step(g.y.sub(1.508).abs(), 0.006)).mul(step(g.z, -0.075));
  let face: Node<'vec3'> = mix(skin, vec3(0.03, 0.025, 0.022), eyes);
  face = mix(face, pick(look.z, HAIR).mul(0.8), brow);
  face = mix(face, skin.mul(vec3(0.85, 0.55, 0.55)), lips);
  let c: Node<'vec3'> = mix(skin, face, is(PART.skin));
  c = mix(c, pick(look.z, HAIR), is(PART.hair));
  c = mix(c, pick(look.x, TOPS).mul(weave), is(PART.top));
  c = mix(c, pick(look.y, BOTTOMS).mul(weave), is(PART.bottom));
  c = mix(c, shoes, is(PART.shoes));
  c = mix(c, pick(look.w, ACCENTS).mul(weave), is(PART.accent));
  c = mix(c, vec3(...linearRgb(0x1c1818)), is(PART.legs));
  m.colorNode = c;
  const fabric = is(PART.top).add(is(PART.bottom)).add(is(PART.accent)).add(is(PART.legs));
  m.roughnessNode = mix(mix(float(0.5), float(0.42), is(PART.hair)), float(0.86), fabric).sub(is(PART.shoes).mul(0.15));
  m.sheenNode = c.mul(fabric.mul(0.5));
  return m;
}

const _actor = new Matrix4();
const _m = new Matrix4();
const _q = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const _yAxis = new Vector3(0, 1, 0);
const _hip = new Vector3();
const _hipJoint = new Vector3();
const _dir = new Vector3();
const _mid = new Vector3();
const _end = new Vector3();
const _up = new Vector3();
const _up2 = new Vector3();
const _right = new Vector3();
const _front = new Vector3();
const _front2 = new Vector3();
const _neck = new Vector3();
const _head = new Vector3();
const _headUp = new Vector3();
const _look = new Vector3();
const _shoulder = new Vector3();
const _at = new Vector3();
const _tmp = new Vector3();
const _knee = new Vector3();
const _foot = new Vector3();
const _elbow = new Vector3();
const _hand = new Vector3();
const _v = new Vector3();
const _pole = new Vector3();
