import { uniform, vec3 } from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type Scene,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';
import { blackbody } from '../core/blackbody.ts';
import type { GroundForce } from '../sim/targets.ts';
import type { Armament, Shot } from '../sim/weapons.ts';
import type { Atmosphere } from './atmosphere.ts';
import { plain } from './jetMaterials.ts';
import { OVERLAY_LAYER, overlayBlending, overlayVisibility } from './stage.ts';
import { Trails, type TrailStyle } from './trails.ts';

// Everything the weapons put in the air and on the ground: tracers, rockets
// and missiles (body, motor flame, smoke trail), impact dust, explosions, and
// the fires and smoke columns of destroyed vehicles. Emission (flames,
// tracers, fireballs) is in physical luminance and drawn in the overlay pass,
// so it reads at noon as at dusk; smoke and dust are lit scene geometry.

/** Pre-exposure for emission, set each frame from the lighting's exposure. */
export const EMISSIVE_EXPOSURE = uniform(1);

const ROCKET_SMOKE: TrailStyle = { lifeS: 5, fadeS: 2.2, halfWidthM: 0.25, spreadMs: 1.1, delayS: 0, sampleS: 0.04, opacity: 0.75 };
const MISSILE_SMOKE: TrailStyle = { lifeS: 8, fadeS: 3.5, halfWidthM: 0.3, spreadMs: 1.2, delayS: 0, sampleS: 0.05, opacity: 0.8 };
const MAX_TRACERS = 200;
const MAX_BLASTS = 28;
const WRECK_PUFFS = 7;
const MAX_WRECKS = 24;

function emissive(kelvin: number, luminance: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ name: 'emission', transparent: true, depthWrite: false });
  overlayBlending(m, true);
  m.colorNode = vec3(...blackbody(kelvin))
    .mul(luminance)
    .mul(EMISSIVE_EXPOSURE)
    .mul(overlayVisibility());
  return m;
}

interface ShotView {
  body: Group;
  flame: Mesh;
  smoke: Trails;
  goneS: number;
  last: Vector3;
}

interface BlastView {
  ball: Mesh;
  smoke: Mesh;
  heat: { value: number };
  fade: { value: number };
}

export class CombatView {
  private readonly root = new Group();
  private readonly shots = new Map<Shot, ShotView>();
  private readonly tracerPos: BufferAttribute;
  private readonly tracerGeo = new BufferGeometry();
  private readonly tracers: LineSegments;
  private readonly blasts: BlastView[] = [];
  private readonly dustBlasts: BlastView[] = [];
  private readonly wreckSmoke: InstancedMesh;
  private readonly wreckFire: InstancedMesh;
  private readonly flameMat = emissive(2200, 220_000);
  private readonly rocketMat = plain('rocket', 0x5a5f52, 0.6);
  private readonly missileMat = plain('missile', 0x3f4639, 0.55);
  private readonly m4 = new Matrix4();
  private readonly v = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly atmosphere: Atmosphere,
  ) {
    scene.add(this.root);
    // Tracers: a short streak along each tracer round's velocity.
    this.tracerPos = new BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3);
    this.tracerPos.setUsage(DynamicDrawUsage);
    this.tracerGeo.setAttribute('position', this.tracerPos);
    const tracerMat = new LineBasicNodeMaterial({ transparent: true, depthWrite: false });
    overlayBlending(tracerMat, true);
    tracerMat.colorNode = vec3(...blackbody(1900))
      .mul(60_000)
      .mul(EMISSIVE_EXPOSURE)
      .mul(overlayVisibility());
    this.tracers = new LineSegments(this.tracerGeo, tracerMat);
    this.tracers.frustumCulled = false;
    this.tracers.layers.set(OVERLAY_LAYER);
    this.root.add(this.tracers);

    // Explosions: a fireball (overlay emission) and the smoke it leaves; dust: a brown puff, no flame.
    const sphere = new SphereGeometry(1, 18, 12);
    const make = (smokeHex: number, flame: boolean): BlastView => {
      const heat = uniform(0);
      const fade = uniform(0);
      const ballMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
      overlayBlending(ballMat, true);
      ballMat.colorNode = vec3(...blackbody(1500))
        .mul(heat)
        .mul(150_000)
        .mul(EMISSIVE_EXPOSURE)
        .mul(overlayVisibility());
      const ball = new Mesh(sphere, ballMat);
      ball.layers.set(OVERLAY_LAYER);
      ball.visible = false;
      const smokeMat = new MeshStandardNodeMaterial({ color: smokeHex, roughness: 1, transparent: true, depthWrite: false });
      smokeMat.opacityNode = fade;
      const smoke = new Mesh(sphere, smokeMat);
      smoke.visible = false;
      this.root.add(smoke);
      if (flame) this.root.add(ball);
      return { ball, smoke, heat, fade };
    };
    for (let i = 0; i < MAX_BLASTS; i++) this.blasts.push(make(0x353331, true));
    for (let i = 0; i < MAX_BLASTS * 2; i++) this.dustBlasts.push(make(0x8a7458, false));

    // Wrecks: a column of dark puffs rising and swelling on a loop, and a flickering fire at the base.
    const smokeMat = new MeshStandardNodeMaterial({ color: 0x232120, roughness: 1, transparent: true, depthWrite: false, opacity: 0.55 });
    this.wreckSmoke = new InstancedMesh(new SphereGeometry(1, 12, 8), smokeMat, MAX_WRECKS * WRECK_PUFFS);
    this.wreckSmoke.frustumCulled = false;
    this.wreckSmoke.count = 0;
    this.root.add(this.wreckSmoke);
    this.wreckFire = new InstancedMesh(new SphereGeometry(1, 10, 8), emissive(1300, 60_000), MAX_WRECKS);
    this.wreckFire.layers.set(OVERLAY_LAYER);
    this.wreckFire.frustumCulled = false;
    this.wreckFire.count = 0;
    this.root.add(this.wreckFire);
  }

  update(arm: Armament, force: GroundForce, clockS: number, eye: Vector3): void {
    // ---- rockets and missiles
    for (const s of arm.shots) {
      if (s.kind === 'round') continue;
      let sv = this.shots.get(s);
      if (!sv) {
        const missile = s.kind === 'missile';
        const body = new Group();
        const len = missile ? 1.6 : 1.4;
        const r = missile ? 0.09 : 0.035;
        const tube = new Mesh(new CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2), missile ? this.missileMat : this.rocketMat);
        body.add(tube);
        const flame = new Mesh(new SphereGeometry(1, 10, 8), this.flameMat);
        flame.scale.set(r * 1.4, r * 1.4, missile ? 0.7 : 0.5);
        flame.position.z = len / 2 + flame.scale.z;
        flame.layers.set(OVERLAY_LAYER);
        body.add(flame);
        const smoke = new Trails(this.atmosphere, [{ style: missile ? MISSILE_SMOKE : ROCKET_SMOKE }]);
        this.root.add(body);
        this.scene.add(smoke.mesh);
        sv = { body, flame, smoke, goneS: -1, last: new Vector3() };
        this.shots.set(s, sv);
      }
      sv.body.position.set(s.position.x, s.position.y, s.position.z);
      sv.last.copy(sv.body.position);
      this.v.set(s.velocity.x, s.velocity.y, s.velocity.z).normalize();
      // Nose along the velocity (the body points down −z).
      sv.body.lookAt(this.v.clone().multiplyScalar(-1).add(sv.body.position));
      sv.flame.visible = s.burning;
      sv.smoke.update(clockS, [sv.last], [s.burning ? 1 : 0.15], eye);
    }
    for (const [s, sv] of this.shots) {
      if (s.alive && arm.shots.includes(s)) continue;
      // Gone: drop the body, let the smoke drift and fade, then free it.
      if (sv.goneS < 0) {
        sv.goneS = clockS;
        this.root.remove(sv.body);
        for (const c of sv.body.children) if (c instanceof Mesh) c.geometry.dispose();
      }
      sv.smoke.update(clockS, [sv.last], [0], eye);
      if (clockS - sv.goneS > MISSILE_SMOKE.lifeS) {
        this.scene.remove(sv.smoke.mesh);
        sv.smoke.mesh.geometry.dispose();
        this.shots.delete(s);
      }
    }

    // ---- tracers
    const tp = this.tracerPos.array as Float32Array;
    let n = 0;
    for (const s of arm.shots) {
      if (s.kind !== 'round' || !s.tracer || n >= MAX_TRACERS) continue;
      tp[n * 6] = s.position.x;
      tp[n * 6 + 1] = s.position.y;
      tp[n * 6 + 2] = s.position.z;
      tp[n * 6 + 3] = s.position.x - s.velocity.x * 0.025;
      tp[n * 6 + 4] = s.position.y - s.velocity.y * 0.025;
      tp[n * 6 + 5] = s.position.z - s.velocity.z * 0.025;
      n++;
    }
    this.tracerGeo.setDrawRange(0, n * 2);
    this.tracerPos.needsUpdate = true;
    this.tracers.visible = n > 0;

    // ---- impacts and explosions: the newest of each kind
    const fiery = arm.blasts.filter((b) => b.kind !== 'dust').slice(-MAX_BLASTS);
    const dusty = arm.blasts.filter((b) => b.kind === 'dust').slice(-MAX_BLASTS * 2);
    this.blasts.forEach((bv, i) => {
      const b = fiery[i];
      if (!b) {
        bv.ball.visible = bv.smoke.visible = false;
        return;
      }
      const t = b.ageS;
      const big = b.kind === 'kill' ? 1.6 : 1;
      bv.ball.visible = t < 0.9 * big;
      bv.ball.position.set(b.position.x, b.position.y + b.size * 0.3, b.position.z);
      bv.ball.scale.setScalar(b.size * (0.4 + Math.min(t, 0.5) * 1.3));
      bv.heat.value = Math.max(0, 1 - t / (0.9 * big)) ** 2;
      bv.smoke.visible = t > 0.12;
      bv.smoke.position.set(b.position.x, b.position.y + b.size * 0.4 + t * 2.2, b.position.z);
      bv.smoke.scale.setScalar(b.size * (0.7 + t * 0.55));
      bv.fade.value = 0.85 * Math.max(0, 1 - t / (5 * big));
    });
    this.dustBlasts.forEach((bv, i) => {
      const b = dusty[i];
      if (!b) {
        bv.smoke.visible = false;
        return;
      }
      const t = b.ageS;
      bv.smoke.visible = t < 2.5;
      bv.smoke.position.set(b.position.x, b.position.y + 0.6 + t * 0.8, b.position.z);
      bv.smoke.scale.set(b.size * (0.8 + t * 1.1), b.size * (1 + t * 1.4), b.size * (0.8 + t * 1.1));
      bv.fade.value = 0.7 * Math.max(0, 1 - t / 2.5);
    });

    // ---- wrecks: smoke columns for a minute and a half, fire for the first forty seconds
    let puffs = 0;
    let fires = 0;
    for (const tg of force.targets) {
      if (tg.alive || tg.deadS > 90 || fires >= MAX_WRECKS) continue;
      const k = Math.max(0.25, 1 - tg.deadS / 90);
      for (let i = 0; i < WRECK_PUFFS; i++) {
        const phase = (clockS * 0.22 + i / WRECK_PUFFS + tg.id * 0.37) % 1;
        const s = (1.2 + phase * 5.5) * k;
        // Drift downwind as it rises.
        this.m4.makeScale(s, s * 0.9, s).setPosition(tg.position.x + phase * 9, tg.position.y + 2 + phase * 26 * k, tg.position.z + phase * 4);
        this.wreckSmoke.setMatrixAt(puffs++, this.m4);
      }
      if (tg.deadS < 40) {
        const f = (0.9 + 0.25 * Math.sin(clockS * 17 + tg.id) + 0.15 * Math.sin(clockS * 29)) * (1 - tg.deadS / 40);
        this.m4.makeScale(1.4 * f, 1.0 * f, 1.4 * f).setPosition(tg.position.x, tg.position.y + 1.2, tg.position.z);
        this.wreckFire.setMatrixAt(fires++, this.m4);
      }
    }
    this.wreckSmoke.count = puffs;
    this.wreckSmoke.visible = puffs > 0;
    this.wreckSmoke.instanceMatrix.needsUpdate = true;
    this.wreckFire.count = fires;
    this.wreckFire.visible = fires > 0;
    this.wreckFire.instanceMatrix.needsUpdate = true;
  }
}
