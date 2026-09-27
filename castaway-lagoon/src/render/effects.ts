import { float, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import { AdditiveBlending, CircleGeometry, type Camera, DoubleSide, Group, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry, PointLight, Quaternion, type Scene, Vector3 } from 'three/webgpu';
import { lightColour } from './colour.ts';
import { WATER_LEVEL_M } from '../config.ts';
import type { LagoonEvent } from '../game/events.ts';
import type { LagoonGame } from '../game/game.ts';
import type { SurfaceKind } from '../game/terrain.ts';
import { ParticlePool, type ParticleSpec, SPECS } from './particles.ts';
import { U } from './uniforms.ts';
import { VM_SCALE, type ViewModel } from './viewmodel.ts';
import { addRipple } from './waterFx.ts';

// Event-driven effects: splashes and ripples when a stone or bullet meets the
// lagoon, material-specific bullet and knife impacts with decals, the muzzle
// flash (a 1–2 frame point light of the sheet's candela plus a flash card on
// the rifle), and the camp fire's flames, embers and smoke.

const MUZZLE_FLASH_CD = 60000; // lighting sheet: rifle muzzle flash peak
const MUZZLE_FLASH_K = 2400;
const DECALS = 96;

export class Effects {
  readonly lit = new ParticlePool(900, false);
  readonly glow = new ParticlePool(500, true, 3500);
  private readonly flashLight = new PointLight(0xffa050, 0, 12, 2);
  private readonly flashCard: Mesh;
  private flashTimer = 0;
  private readonly decals: InstancedMesh;
  private nextDecal = 0;
  private readonly v = new Vector3();
  private readonly w = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly up = new Vector3(0, 0, 1);
  private fireAcc = 0;
  private readonly group = new Group();

  constructor(
    scene: Scene,
    private readonly viewModel: ViewModel,
    private readonly firePos: Vector3,
  ) {
    this.group.name = 'effects';
    this.group.add(this.lit.mesh, this.glow.mesh, this.flashLight);
    const fc = lightColour(MUZZLE_FLASH_K);
    this.flashLight.color.setRGB(fc.r, fc.g, fc.b);
    // Flash card: a star-shaped glow drawn in the rifle's own frame.
    const flashMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false });
    const r = uv().sub(0.5).mul(2);
    const star = float(1).sub(smoothstep(0.0, 0.9, r.length())).mul(float(1).sub(smoothstep(0.02, 0.45, r.x.abs().min(r.y.abs()))).add(0.35));
    // A few 10⁴ cd/m² of hot gas, pre-exposed like every other light.
    flashMat.colorNode = vec4(vec3(1, 0.62, 0.3).mul(U.preExposure.mul(3e4).mul(star)), 1);
    this.flashCard = new Mesh(new PlaneGeometry(0.16, 0.16), flashMat);
    this.flashCard.visible = false;
    viewModel.muzzleAnchor.add(this.flashCard);
    const decalMat = new MeshStandardNodeMaterial({ color: 0x1b1714, roughness: 0.9, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const d = uv().sub(0.5).length().mul(2);
    decalMat.opacityNode = float(1).sub(smoothstep(0.35, 1.0, d)).mul(0.9);
    this.decals = new InstancedMesh(new CircleGeometry(0.5, 10), decalMat, DECALS);
    this.decals.frustumCulled = false;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < DECALS; i++) this.decals.setMatrixAt(i, this.m);
    this.group.add(this.decals);
    scene.add(this.group);
  }

  handle(e: LagoonEvent, game: LagoonGame, camera: Camera): void {
    switch (e.type) {
      case 'splash': {
        const k = Math.min(1, (e.speedMs * e.massKg) / 2);
        addRipple(e.pos.x, e.pos.z, game.timeSeconds, e.skip ? 0.35 : 0.55 + k * 1.2);
        const n = e.skip ? 8 : 24 + Math.round(k * 30);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const out = e.skip ? 1.2 : 0.6 + Math.random() * 1.4;
          const upV = e.skip ? 1 + Math.random() * 1.5 : 1.8 + Math.random() * (2.5 + k * 3);
          this.lit.spawn(SPECS.spray, this.v.set(e.pos.x, WATER_LEVEL_M + 0.02, e.pos.z), this.w.set(Math.cos(a) * out, upV, Math.sin(a) * out));
        }
        if (!e.skip) {
          // The crown's central jet.
          for (let i = 0; i < 6; i++) this.lit.spawn(SPECS.spray, this.v.set(e.pos.x, WATER_LEVEL_M, e.pos.z), this.w.set((Math.random() - 0.5) * 0.3, 3 + Math.random() * 2 * (1 + k), (Math.random() - 0.5) * 0.3));
          this.lit.spawn(SPECS.mist, this.v.set(e.pos.x, WATER_LEVEL_M + 0.1, e.pos.z), this.w.set(0, 0.5, 0));
        }
        break;
      }
      case 'bulletImpact':
        this.impact(e.surface, e.pos, e.normal, game, 1);
        break;
      case 'knifeHit':
        this.impact(e.surface, e.pos, e.normal, game, 0.35);
        break;
      case 'bulletLeaves':
        for (let i = 0; i < 6; i++) this.lit.spawn(SPECS.leaf, this.v.set(e.pos.x, e.pos.y, e.pos.z), this.w.set((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2));
        break;
      case 'bodyHit':
        if (e.body === 'stone' && e.speedMs > 3) this.burst(e.surface === 'rock' ? SPECS.chips : SPECS.grit, e.pos, 4, 1.2);
        break;
      case 'canHit':
        this.burst(SPECS.spark, this.v.copy(canPos(game, e.id)), 6, 3, this.glow);
        break;
      case 'shot': {
        this.flashTimer = 0.034;
        this.flashCard.rotation.z = Math.random() * Math.PI;
        this.flashCard.scale.setScalar(0.8 + Math.random() * 0.5);
        this.muzzleWorld(camera, this.v);
        this.flashLight.position.copy(this.v);
        this.lit.spawn(SPECS.gunSmoke, this.v, this.w.set(e.dir.x * 1.5, 0.3, e.dir.z * 1.5));
        break;
      }
      default:
        break;
    }
  }

  /** The muzzle in the world: the viewmodel is drawn at VM_SCALE about the eye, so scale its offset back up. */
  private muzzleWorld(camera: Camera, out: Vector3): Vector3 {
    this.viewModel.muzzleAnchor.getWorldPosition(out);
    return out.sub(camera.position).divideScalar(VM_SCALE).add(camera.position);
  }

  private burst(spec: ParticleSpec, pos: { x: number; y: number; z: number }, n: number, speed: number, pool: ParticlePool = this.lit, normal?: { x: number; y: number; z: number }): void {
    for (let i = 0; i < n; i++) {
      this.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      if (normal) this.w.addScaledVector(this.v.set(normal.x, normal.y, normal.z), speed * 0.8);
      pool.spawn(spec, this.v.set(pos.x, pos.y, pos.z), this.w);
    }
  }

  private impact(surface: SurfaceKind, pos: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }, game: LagoonGame, k: number): void {
    const n = Math.max(1, Math.round(10 * k));
    switch (surface) {
      case 'water':
        addRipple(pos.x, pos.z, game.timeSeconds, 0.35 * k + 0.1);
        for (let i = 0; i < n + 4; i++) this.lit.spawn(SPECS.spray, this.v.set(pos.x, WATER_LEVEL_M, pos.z), this.w.set((Math.random() - 0.5) * 0.5, 2.5 + Math.random() * 3, (Math.random() - 0.5) * 0.5));
        return;
      case 'sand':
      case 'wetSand':
      case 'grass':
      case 'dirt':
        this.burst(SPECS.sand, pos, 2, 0.8, this.lit, normal);
        this.burst(SPECS.grit, pos, n, 2.5, this.lit, normal);
        break;
      case 'rock':
        this.burst(SPECS.dust, pos, 2, 0.8, this.lit, normal);
        this.burst(SPECS.chips, pos, n, 3, this.lit, normal);
        if (k > 0.5 && Math.random() < 0.6) this.burst(SPECS.spark, pos, 4, 5, this.glow, normal);
        break;
      case 'wood':
        this.burst(SPECS.splinter, pos, n, 2.5, this.lit, normal);
        this.burst(SPECS.dust, pos, 1, 0.5, this.lit, normal);
        break;
      case 'metal':
        this.burst(SPECS.spark, pos, 8, 4, this.glow, normal);
        break;
      case 'leaves':
        this.burst(SPECS.leaf, pos, 5, 1, this.lit, normal);
        return;
      case 'fabric':
        this.burst(SPECS.dust, pos, 1, 0.4, this.lit, normal);
        break;
    }
    if (k > 0.5) this.decal(pos, normal, surface === 'sand' || surface === 'wetSand' || surface === 'grass' ? 0.06 : 0.018);
  }

  private decal(pos: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }, sizeM: number): void {
    this.v.set(normal.x, normal.y, normal.z).normalize();
    this.q.setFromUnitVectors(this.up, this.v);
    this.m.compose(this.w.set(pos.x, pos.y, pos.z).addScaledVector(this.v, 0.003), this.q, this.v.setScalar(sizeM));
    this.decals.setMatrixAt(this.nextDecal, this.m);
    this.nextDecal = (this.nextDecal + 1) % DECALS;
    this.decals.instanceMatrix.needsUpdate = true;
  }

  update(game: LagoonGame, dt: number, camera: Camera, preExposure: number): void {
    // Muzzle flash: on for about two frames.
    this.flashTimer -= dt;
    const on = this.flashTimer > 0;
    this.flashCard.visible = on;
    this.flashLight.intensity = on ? MUZZLE_FLASH_CD * preExposure * (0.6 + Math.random() * 0.4) : 0;
    // Camp fire: flame licks, embers, smoke — fewer in the rain.
    const rain = game.env.weather.rainRate;
    this.fireAcc += dt;
    while (this.fireAcc > 0.045) {
      this.fireAcc -= 0.045;
      const f = this.firePos;
      if (Math.random() > rain * 0.6) this.glow.spawn(SPECS.flame, this.v.set(f.x + (Math.random() - 0.5) * 0.35, f.y + 0.12, f.z + (Math.random() - 0.5) * 0.35), this.w.set((Math.random() - 0.5) * 0.2, 0.6 + Math.random() * 0.5, (Math.random() - 0.5) * 0.2));
      if (Math.random() < 0.25) this.glow.spawn(SPECS.ember, this.v.set(f.x, f.y + 0.2, f.z), this.w.set((Math.random() - 0.5) * 0.6, 0.8 + Math.random(), (Math.random() - 0.5) * 0.6).add(this.v.set(U.wind.value.x * 0.15, 0, U.wind.value.y * 0.15)));
      if (Math.random() < 0.18 + rain * 0.3) this.lit.spawn(SPECS.smoke, this.v.set(f.x, f.y + 0.6, f.z), this.w.set(U.wind.value.x * 0.2, 0.6, U.wind.value.y * 0.2));
    }
    this.lit.update(dt, camera, preExposure);
    this.glow.update(dt, camera, preExposure);
  }
}

function canPos(game: LagoonGame, id: number): { x: number; y: number; z: number } {
  return game.world.cans.find((c) => c.id === id)?.pos ?? { x: 0, y: -100, z: 0 };
}
