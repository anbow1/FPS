import { uniform, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedMesh, LineBasicNodeMaterial, LineSegments, Matrix4, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Scene, SphereGeometry, Vector3 } from 'three/webgpu';
import { blackbody } from '../core/blackbody.ts';
import type { Combat } from '../sim/combat.ts';
import type { Missile } from '../sim/weapons.ts';
import type { Atmosphere } from './atmosphere.ts';
import { canopyMaterial, plain } from './jetMaterials.ts';
import { EMISSIVE_EXPOSURE, missile as missileModel } from './jetModels.ts';
import { OVERLAY_LAYER, overlayBlending, overlayVisibility } from './stage.ts';
import { Trails, type TrailStyle } from './trails.ts';

// Everything in the air between the aircraft: missiles (body, motor plume,
// smoke trail), gun tracers, flares, explosions and the smoke of a falling
// wreck. Emission (plumes, tracers, flares, fireballs) is in physical
// luminance and drawn in the overlay pass, so it shows over clouds and is as
// bright as it should be against the sky at noon or dusk.

const SMOKE: TrailStyle = { lifeS: 7, fadeS: 3.5, halfWidthM: 0.3, spreadMs: 1.2, delayS: 0, sampleS: 0.05, opacity: 0.8 };
const WRECK: TrailStyle = { lifeS: 14, fadeS: 6, halfWidthM: 1.5, spreadMs: 2.5, delayS: 0, sampleS: 0.1, opacity: 0.85 };
const MAX_TRACERS = 400;
const MAX_FLARES = 96;
const MAX_FIRES = 12;

function emissive(kelvin: number, luminance: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ name: 'emission', transparent: true, depthWrite: false });
  overlayBlending(m, true);
  m.colorNode = vec3(...blackbody(kelvin)).mul(luminance).mul(EMISSIVE_EXPOSURE).mul(overlayVisibility());
  return m;
}

interface MissileView {
  body: Group;
  plume: Mesh;
  smoke: Trails;
  goneS: number;
}

export class CombatView {
  private readonly root = new Group();
  private readonly missiles = new Map<Missile, MissileView>();
  private readonly wrecks = new Map<number, { smoke: Trails; goneS: number }>();
  private readonly bodyMat = plain('missile body', 0xd6d8d4, 0.5);
  private readonly bandMat = plain('missile band', 0xc9a227, 0.6);
  private readonly seekerMat = canopyMaterial(0x2a2f33, 0x8899aa);
  private readonly plumeMat = emissive(2100, 250_000);
  private readonly tracerGeo = new BufferGeometry();
  private readonly tracerPos: BufferAttribute;
  private readonly tracers: LineSegments;
  private readonly flares: InstancedMesh;
  private readonly fires: { ball: Mesh; smoke: Mesh; heat: { value: number }; fade: { value: number } }[] = [];
  private readonly m4 = new Matrix4();
  private readonly v = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly atmosphere: Atmosphere,
  ) {
    scene.add(this.root);
    // Tracers: one short streak per tracer round, along its velocity.
    this.tracerPos = new BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3);
    this.tracerPos.setUsage(DynamicDrawUsage);
    this.tracerGeo.setAttribute('position', this.tracerPos);
    const tracerMat = new LineBasicNodeMaterial({ transparent: true, depthWrite: false });
    overlayBlending(tracerMat, true);
    tracerMat.colorNode = vec3(...blackbody(1900)).mul(60_000).mul(EMISSIVE_EXPOSURE).mul(overlayVisibility());
    this.tracers = new LineSegments(this.tracerGeo, tracerMat);
    this.tracers.frustumCulled = false;
    this.tracers.layers.set(OVERLAY_LAYER);
    this.root.add(this.tracers);
    // Flares: magnesium burns near 2000 °C, far brighter than the sky.
    this.flares = new InstancedMesh(new SphereGeometry(0.45, 8, 6), emissive(2300, 400_000), MAX_FLARES);
    this.flares.frustumCulled = false;
    this.flares.layers.set(OVERLAY_LAYER);
    this.flares.count = 0;
    this.root.add(this.flares);
    // Explosions: a fireball (emission, overlay) and the smoke ball it leaves (lit, in the scene).
    const sphere = new SphereGeometry(1, 20, 14);
    for (let i = 0; i < MAX_FIRES; i++) {
      const heat = uniform(0);
      const fade = uniform(0);
      const ballMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
      overlayBlending(ballMat, true);
      ballMat.colorNode = vec3(...blackbody(1600)).mul(heat).mul(180_000).mul(EMISSIVE_EXPOSURE).mul(overlayVisibility());
      const ball = new Mesh(sphere, ballMat);
      ball.layers.set(OVERLAY_LAYER);
      ball.visible = false;
      const smokeMat = new MeshStandardNodeMaterial({ color: 0x3a3a3a, roughness: 1, transparent: true, depthWrite: false });
      smokeMat.opacityNode = fade.mul(0.85);
      const smoke = new Mesh(sphere, smokeMat);
      smoke.visible = false;
      this.root.add(ball, smoke);
      this.fires.push({ ball, smoke, heat, fade });
    }
  }

  update(combat: Combat, clockS: number, eye: Vector3): void {
    // ---- missiles
    for (const m of combat.missiles) {
      let mv = this.missiles.get(m);
      if (!mv) {
        const isMrm = m.spec.kind === 'mrm';
        const body = missileModel(isMrm ? 3.7 : 2.9, isMrm ? 0.1 : 0.064, isMrm ? 0.22 : 0.2, this.bandMat, this.bodyMat, this.seekerMat);
        const plume = new Mesh(new SphereGeometry(1, 10, 8), this.plumeMat);
        plume.scale.set(0.12, 0.12, 0.9);
        plume.position.z = (isMrm ? 1.85 : 1.45) + 0.8;
        plume.layers.set(OVERLAY_LAYER);
        body.add(plume);
        const smoke = new Trails(this.atmosphere, [{ style: SMOKE }]);
        this.root.add(body);
        this.scene.add(smoke.mesh);
        mv = { body, plume, smoke, goneS: -1 };
        this.missiles.set(m, mv);
      }
      mv.body.position.set(m.position.x, m.position.y, m.position.z);
      this.v.set(m.velocity.x, m.velocity.y, m.velocity.z).normalize();
      // Nose along the velocity (models point down −z).
      mv.body.lookAt(this.v.clone().multiplyScalar(-1).add(mv.body.position));
      mv.plume.visible = m.burning;
      mv.smoke.update(clockS, [this.v.set(m.position.x, m.position.y, m.position.z)], [m.burning ? 1 : 0.25], eye);
    }
    for (const [m, mv] of this.missiles) {
      if (combat.missiles.includes(m)) continue;
      // Gone: hide the body, let the smoke drift and fade, then free it.
      if (mv.goneS < 0) {
        mv.goneS = clockS;
        this.root.remove(mv.body);
      }
      mv.smoke.update(clockS, [this.v.set(m.position.x, m.position.y, m.position.z)], [0], eye);
      if (clockS - mv.goneS > SMOKE.lifeS) {
        this.scene.remove(mv.smoke.mesh);
        mv.smoke.mesh.geometry.dispose();
        this.missiles.delete(m);
      }
    }
    // ---- tracers
    const tp = this.tracerPos.array as Float32Array;
    let n = 0;
    for (const r of combat.rounds) {
      if (!r.tracer || n >= MAX_TRACERS) continue;
      tp[n * 6] = r.position.x;
      tp[n * 6 + 1] = r.position.y;
      tp[n * 6 + 2] = r.position.z;
      tp[n * 6 + 3] = r.position.x - r.velocity.x * 0.03;
      tp[n * 6 + 4] = r.position.y - r.velocity.y * 0.03;
      tp[n * 6 + 5] = r.position.z - r.velocity.z * 0.03;
      n++;
    }
    this.tracerGeo.setDrawRange(0, n * 2);
    this.tracerPos.needsUpdate = true;
    this.tracers.visible = n > 0;
    // ---- flares (chaff is invisible at these ranges)
    let f = 0;
    for (const d of combat.decoys) {
      if (d.kind !== 'flare' || f >= MAX_FLARES) continue;
      const s = Math.max(0.05, 1 - d.ageS / d.lifeS);
      this.m4.makeScale(s, s, s).setPosition(d.position.x, d.position.y, d.position.z);
      this.flares.setMatrixAt(f++, this.m4);
    }
    this.flares.count = f;
    this.flares.visible = f > 0;
    this.flares.instanceMatrix.needsUpdate = true;
    // ---- explosions: the newest MAX_FIRES
    const list = combat.explosions.slice(-MAX_FIRES);
    this.fires.forEach((fire, i) => {
      const e = list[i];
      if (!e) {
        fire.ball.visible = false;
        fire.smoke.visible = false;
        return;
      }
      const t = e.ageS;
      fire.ball.visible = t < 1.2;
      fire.ball.position.set(e.position.x, e.position.y, e.position.z);
      fire.ball.scale.setScalar(e.size * (0.35 + Math.min(t, 0.6) * 1.1));
      fire.heat.value = Math.max(0, 1 - t / 1.2) ** 2;
      fire.smoke.visible = t > 0.2;
      fire.smoke.position.set(e.position.x, e.position.y + t * 2, e.position.z);
      fire.smoke.scale.setScalar(e.size * (0.6 + t * 0.5));
      fire.fade.value = Math.max(0, 1 - t / 6);
    });
    // ---- wrecks trail smoke as they fall
    for (const c of combat.fighters) {
      let w = this.wrecks.get(c.id);
      if (!c.alive) {
        if (!w) {
          w = { smoke: new Trails(this.atmosphere, [{ style: WRECK }]), goneS: -1 };
          this.scene.add(w.smoke.mesh);
          this.wrecks.set(c.id, w);
        }
        w.smoke.update(clockS, [this.v.set(c.aircraft.position.x, c.aircraft.position.y, c.aircraft.position.z)], [c.aircraft.crashed ? 0.3 : 1], eye);
      } else if (w) {
        this.scene.remove(w.smoke.mesh);
        this.wrecks.delete(c.id);
      }
    }
  }
}
