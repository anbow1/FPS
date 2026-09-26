import { float, length, smoothstep, uv, vec3 } from 'three/tsl';
import { AdditiveBlending, BoxGeometry, Color, InstancedMesh, Matrix4, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry, PointLight, Quaternion, type Scene, Vector3, type PerspectiveCamera } from 'three/webgpu';
import { LOCAL_LIGHTS, type SurfaceKind } from '../config.ts';
import type { GameEvent } from '../game/events.ts';
import type { Game } from '../game/game.ts';
import { lightColour } from './colour.ts';
import { ParticlePool, spawnDefaults } from './particles.ts';

// Short-lived combat effects: muzzle flashes (a point light for 1–2 frames and
// an emissive core, lighting sheet values), tracers, impact decals and debris
// per material (concrete chips, metal sparks, wood splinters, soil puffs,
// glass), and grenade explosions. No gore: body hits show only an armour spark
// or a fabric puff.

const MAX_DECALS = 400;
const MAX_TRACERS = 64;
const FLASH_LIGHTS = 4;

// Decal tint per surface (sRGB): the chipped or dented look of each material.
const DECAL_COLOUR: Partial<Record<SurfaceKind, number>> = {
  concrete: 0x3a3a3c,
  brick: 0x4a3b30,
  asphalt: 0x2b2b2c,
  soil: 0x3e3328,
  rock: 0x4a4744,
  wood: 0xc2b280, // fresh splinters are lighter than the weathered face
  sheetMetal: 0xc6c6c8, // dented bare steel
  glass: 0xd6d6d0,
  armourPlate: 0x8f8b85,
};

const DEBRIS_COLOUR: Partial<Record<SurfaceKind, number>> = {
  concrete: 0x8f8b85,
  brick: 0x8a4b3a,
  asphalt: 0x5a5a5c,
  soil: 0x6b5a47,
  rock: 0x7a7672,
  wood: 0x8a6a4a,
  glass: 0xd6d6d0,
  foliage: 0x4a6030,
  fabric: 0x5a5e48,
};

interface Flash {
  light: PointLight;
  ttl: number;
}

export class Effects {
  readonly dust = new ParticlePool(900, false);
  readonly sparks = new ParticlePool(300, true);
  private readonly decals: InstancedMesh;
  private nextDecal = 0;
  private readonly tracers: InstancedMesh;
  private readonly flashes: Flash[] = [];
  private nextFlash = 0;
  private readonly flashColour = new Color();
  private readonly explosionColour = new Color();
  preExposure = 1;

  constructor(scene: Scene) {
    // Decals: a round crater with a soft edge, tinted per material, a hair off the surface.
    const decalMat = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const r = length(uv().sub(0.5));
    decalMat.opacityNode = float(1).sub(smoothstep(0.32, 0.5, r)).mul(0.92);
    decalMat.colorNode = vec3(1, 1, 1).mul(smoothstep(0.0, 0.35, r).mul(0.5).add(0.5));
    this.decals = new InstancedMesh(new PlaneGeometry(1, 1), decalMat, MAX_DECALS);
    this.decals.frustumCulled = false;
    this.decals.receiveShadow = true;
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decals.setMatrixAt(i, _zero);
      this.decals.setColorAt(i, new Color(1, 1, 1));
    }
    // Tracers: a thin streak along each tracer round's last step, emissive, additive.
    const tracerMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    tracerMat.colorNode = vec3(1.0, 0.45, 0.12).mul(6);
    this.tracers = new InstancedMesh(new BoxGeometry(1, 1, 1), tracerMat, MAX_TRACERS);
    this.tracers.frustumCulled = false;
    for (let i = 0; i < FLASH_LIGHTS; i++) {
      const light = new PointLight(0xffffff, 0, 25, 2);
      light.castShadow = false; // sheet: muzzle flash has no shadow
      scene.add(light);
      this.flashes.push({ light, ttl: 0 });
    }
    const k = lightColour(LOCAL_LIGHTS.muzzleFlashK);
    this.flashColour.setRGB(k.r, k.g, k.b);
    const e = lightColour(2200);
    this.explosionColour.setRGB(e.r, e.g, e.b);
    scene.add(this.dust.mesh, this.sparks.mesh, this.decals, this.tracers);
  }

  /** `muzzle` is where the flash should appear (for the player, the viewmodel's muzzle projected to true range). */
  handle(e: GameEvent, playerId: number, muzzle: Vector3 | null): void {
    switch (e.type) {
      case 'shot': {
        const at = e.shooterId === playerId && muzzle ? muzzle : _p.set(e.origin.x + e.dir.x * 0.3, e.origin.y + e.dir.y * 0.3, e.origin.z + e.dir.z * 0.3);
        this.muzzleFlash(at, e.dir.x, e.dir.y, e.dir.z, e.suppressed);
        break;
      }
      case 'impact':
        this.impact(e.pos.x, e.pos.y, e.pos.z, e.normal.x, e.normal.y, e.normal.z, e.surface, e.exit);
        break;
      case 'explosion':
        this.explosion(e.pos.x, e.pos.y, e.pos.z, e.kind);
        break;
      case 'glassBreak':
        for (let i = 0; i < 14; i++) this.debris(e.pos.x, e.pos.y, e.pos.z, 0xd6d6d0, 2.5, 0.03, 1.2);
        break;
      default:
        break;
    }
  }

  private flashLight(x: number, y: number, z: number, intensityCd: number, colour: Color, seconds: number): void {
    const f = this.flashes[this.nextFlash] as Flash;
    this.nextFlash = (this.nextFlash + 1) % this.flashes.length;
    f.light.position.set(x, y, z);
    f.light.color.copy(colour);
    // Point light intensity in candela, pre-exposed like every other light.
    f.light.intensity = intensityCd * this.preExposure;
    f.ttl = seconds;
  }

  private muzzleFlash(p: Vector3, dx: number, dy: number, dz: number, suppressed: boolean): void {
    this.flashLight(p.x, p.y, p.z, LOCAL_LIGHTS.muzzleFlashCd * (suppressed ? 0.08 : 1), this.flashColour, LOCAL_LIGHTS.muzzleFlashSeconds);
    if (suppressed) return;
    const s = spawnDefaults();
    s.colour = 0xffb060;
    s.intensity = 2.5e4 * this.preExposure; // hot core, pre-exposed HDR
    s.lifeSeconds = 0.045;
    for (let i = 0; i < 3; i++) {
      s.x = p.x + dx * (0.05 + i * 0.07);
      s.y = p.y + dy * (0.05 + i * 0.07);
      s.z = p.z + dz * (0.05 + i * 0.07);
      s.sizeM = 0.16 - i * 0.04;
      this.sparks.spawn(s);
    }
    // A breath of propellant smoke.
    const d = spawnDefaults();
    d.x = p.x + dx * 0.2;
    d.y = p.y + dy * 0.2;
    d.z = p.z + dz * 0.2;
    d.vx = dx * 1.5;
    d.vy = dy * 1.5 + 0.2;
    d.vz = dz * 1.5;
    d.sizeM = 0.12;
    d.growMs = 0.5;
    d.lifeSeconds = 0.9;
    d.colour = 0xb4b0a8;
    d.opacity = 0.25;
    d.drag = 2;
    this.dust.spawn(d);
  }

  private impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: SurfaceKind, exit: boolean): void {
    if (surface === 'flesh') {
      // Cloth puff only: no blood (rules §11).
      for (let i = 0; i < 4; i++) this.debris(x, y, z, 0x5a5e48, 0.8, 0.06, 0.4, nx, ny, nz);
      return;
    }
    if (surface === 'armourPlate' || surface === 'sheetMetal') {
      const s = spawnDefaults();
      s.colour = 0xffc080;
      s.intensity = 3e3 * this.preExposure;
      s.lifeSeconds = 0.18;
      s.sizeM = 0.035;
      s.gravity = 9.81;
      for (let i = 0; i < 8; i++) {
        s.x = x;
        s.y = y;
        s.z = z;
        s.vx = nx * 3 + (Math.random() - 0.5) * 6;
        s.vy = ny * 3 + Math.random() * 3;
        s.vz = nz * 3 + (Math.random() - 0.5) * 6;
        this.sparks.spawn(s);
      }
    }
    if (surface !== 'foliage' && surface !== 'fabric' && surface !== 'armourPlate') this.decal(x, y, z, nx, ny, nz, surface, exit ? 0.07 : 0.05);
    const colour = DEBRIS_COLOUR[surface];
    if (colour !== undefined) {
      const count = surface === 'soil' ? 7 : 5;
      for (let i = 0; i < count; i++) this.debris(x, y, z, colour, surface === 'soil' ? 1.5 : 3, surface === 'soil' ? 0.12 : 0.05, 0.7, nx, ny, nz);
      // Dust cloud hanging off the hit.
      const d = spawnDefaults();
      d.x = x + nx * 0.05;
      d.y = y + ny * 0.05;
      d.z = z + nz * 0.05;
      d.vx = nx * 0.8;
      d.vy = ny * 0.8 + 0.2;
      d.vz = nz * 0.8;
      d.sizeM = 0.15;
      d.growMs = surface === 'soil' ? 1.2 : 0.6;
      d.lifeSeconds = 1.2;
      d.colour = colour;
      d.opacity = 0.55;
      d.drag = 3;
      this.dust.spawn(d);
    }
  }

  private debris(x: number, y: number, z: number, colour: number, speed: number, size: number, life: number, nx = 0, ny = 1, nz = 0): void {
    const d = spawnDefaults();
    d.x = x;
    d.y = y;
    d.z = z;
    d.vx = (nx + (Math.random() - 0.5) * 1.2) * speed;
    d.vy = (ny + Math.random() * 0.8) * speed;
    d.vz = (nz + (Math.random() - 0.5) * 1.2) * speed;
    d.sizeM = size * (0.5 + Math.random());
    d.lifeSeconds = life * (0.6 + Math.random() * 0.6);
    d.colour = colour;
    d.gravity = 9.81;
    d.drag = 0.5;
    this.dust.spawn(d);
  }

  private decal(x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: SurfaceKind, sizeM: number): void {
    const i = this.nextDecal;
    this.nextDecal = (this.nextDecal + 1) % MAX_DECALS;
    _n.set(nx, ny, nz).normalize();
    _q.setFromUnitVectors(_zAxis, _n);
    _m.compose(_p.set(x + nx * 0.004, y + ny * 0.004, z + nz * 0.004), _q, _s.setScalar(sizeM * (0.8 + Math.random() * 0.4)));
    this.decals.setMatrixAt(i, _m);
    this.decals.setColorAt(i, _c.setHex(DECAL_COLOUR[surface] ?? 0x3a3a3c));
    this.decals.instanceMatrix.needsUpdate = true;
    if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;
  }

  private explosion(x: number, y: number, z: number, kind: 'frag' | 'smoke' | 'flash'): void {
    if (kind === 'smoke') {
      for (let i = 0; i < 8; i++) this.debris(x, y + 0.1, z, 0xb4b0a8, 1.5, 0.3, 1.5);
      return;
    }
    const cd = kind === 'flash' ? LOCAL_LIGHTS.flashbangCd : LOCAL_LIGHTS.explosionCd;
    this.flashLight(x, y + 0.5, z, cd, kind === 'flash' ? _white : this.explosionColour, kind === 'flash' ? 0.12 : 0.06);
    const core = spawnDefaults();
    core.x = x;
    core.y = y + 0.4;
    core.z = z;
    core.colour = kind === 'flash' ? 0xffffff : 0xffa050;
    core.intensity = (kind === 'flash' ? 2e5 : 4e4) * this.preExposure;
    core.sizeM = kind === 'flash' ? 1.5 : 2.2;
    core.growMs = 6;
    core.lifeSeconds = 0.12;
    this.sparks.spawn(core);
    if (kind === 'frag') {
      for (let i = 0; i < 30; i++) this.debris(x, y + 0.2, z, 0x6b5a47, 6, 0.08, 1.4);
      for (let i = 0; i < 12; i++) {
        const d = spawnDefaults();
        const a = (i / 12) * Math.PI * 2;
        d.x = x;
        d.y = y + 0.3;
        d.z = z;
        d.vx = Math.cos(a) * 4;
        d.vy = 1.5 + Math.random();
        d.vz = Math.sin(a) * 4;
        d.sizeM = 0.8;
        d.growMs = 1.8;
        d.lifeSeconds = 3.5;
        d.colour = 0x5a4a3a;
        d.opacity = 0.8;
        d.drag = 1.6;
        d.gravity = -0.15;
        this.dust.spawn(d);
      }
    }
  }

  update(game: Game, camera: PerspectiveCamera, dt: number): void {
    for (const f of this.flashes) {
      if (f.ttl > 0) {
        f.ttl -= dt;
        if (f.ttl <= 0) f.light.intensity = 0;
      }
    }
    // Tracers from live rounds flagged as tracers.
    let n = 0;
    for (const b of game.projectiles.pool) {
      if (!b.active || !b.tracer || n >= MAX_TRACERS) continue;
      _a.set(b.prevPos.x, b.prevPos.y, b.prevPos.z);
      _b.set(b.pos.x, b.pos.y, b.pos.z);
      const len = _a.distanceTo(_b);
      if (len < 0.1) continue;
      _n.subVectors(_b, _a).normalize();
      _q.setFromUnitVectors(_zAxis, _n);
      _m.compose(_p.addVectors(_a, _b).multiplyScalar(0.5), _q, _s.set(0.02, 0.02, Math.min(len, 12)));
      this.tracers.setMatrixAt(n++, _m);
    }
    this.tracers.count = n;
    this.tracers.instanceMatrix.needsUpdate = true;
    this.dust.update(camera, dt);
    this.sparks.update(camera, dt);
  }
}

const _zero = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _n = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _white = new Color(1, 1, 1);
const _zAxis = new Vector3(0, 0, 1);
