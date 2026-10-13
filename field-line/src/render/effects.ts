import { atan, float, length, mx_noise_float, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import { AdditiveBlending, BoxGeometry, Color, InstancedMesh, Matrix4, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry, PointLight, Quaternion, type Scene, Vector3, type PerspectiveCamera } from 'three/webgpu';
import { LOCAL_LIGHTS, type SurfaceKind } from '../config.ts';
import type { GameEvent } from '../game/events.ts';
import type { Game } from '../game/game.ts';
import { lightColour } from './colour.ts';
import { supportHeight } from '../game/movement.ts';
import { Debris } from './debris.ts';
import { fireRadiance, ParticlePool, smokeGlowRadiance, spawnDefaults } from './particles.ts';

// Short-lived combat effects: muzzle flashes (a point light for 1–2 frames and
// an emissive core, lighting sheet values), tracers, impact decals and debris
// per material (concrete chips, metal sparks, wood splinters, soil puffs,
// glass), and grenade explosions. No gore: body hits show only an armour spark
// or a fabric puff.
//
// A frag explosion is built in layers, each doing one job (as film effects
// are): a flash core and a light that dies away over a third of a second
// with a flicker; a short fireball of billows cooling from white-yellow to
// dull red; a smoke-and-dust cloud that follows it, lit orange from inside
// while young, rising and lingering; a dust ring rolling out along the ground;
// earth and stone chunks on real arcs that land and stay; embers; and a
// scorch mark left on the ground.

const MAX_DECALS = 400;
const MAX_TRACERS = 64;
const FLASH_LIGHTS = 4;
const MAX_SCORCHES = 12;
/** Pre-exposure is applied on top of these (cd/m²): a fireball's billows and smoke lit from inside. */
const FIRE_NITS = 4.5e4;
const SMOKE_GLOW_NITS = 5e3;

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
  seconds: number;
  peakCd: number;
  flicker: boolean;
}

export class Effects {
  readonly dust = new ParticlePool(900, 'lit');
  readonly sparks = new ParticlePool(300, 'emissive');
  readonly fire = new ParticlePool(160, 'fire');
  readonly debris3d: Debris;
  private readonly scorches: InstancedMesh;
  private nextScorch = 0;
  private readonly pendingScorch: Vector3[] = [];
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
    const decalMat = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }); // reversed depth: positive pulls toward the camera
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
      this.flashes.push({ light, ttl: 0, seconds: 1, peakCd: 0, flicker: false });
    }
    const k = lightColour(LOCAL_LIGHTS.muzzleFlashK);
    this.flashColour.setRGB(k.r, k.g, k.b);
    const e = lightColour(2200);
    this.explosionColour.setRGB(e.r, e.g, e.b);
    // Scorch marks: soot thrown out in streaks from a dark centre, a ragged edge (no stamped disc).
    const scorchMat = new MeshStandardNodeMaterial({ roughness: 0.97, metalness: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 });
    const q = uv().sub(0.5).mul(2);
    const rr = length(q);
    const rays = mx_noise_float(vec2(atan(q.y, q.x).mul(2.5), 3.1)).mul(0.5).add(0.5);
    const ragged = mx_noise_float(q.mul(4.5)).mul(0.18);
    const reach = float(0.55).add(rays.mul(0.4)).add(ragged);
    scorchMat.opacityNode = float(1).sub(smoothstep(reach.mul(0.35), reach, rr)).mul(0.9);
    scorchMat.colorNode = vec3(0.045, 0.04, 0.035).add(smoothstep(0.1, 0.9, rr).mul(0.04));
    this.scorches = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), scorchMat, MAX_SCORCHES);
    this.scorches.frustumCulled = false;
    this.scorches.receiveShadow = true;
    for (let i = 0; i < MAX_SCORCHES; i++) this.scorches.setMatrixAt(i, _zero);
    this.debris3d = new Debris(scene);
    this.fire.mesh.renderOrder = 12;
    scene.add(this.dust.mesh, this.sparks.mesh, this.fire.mesh, this.decals, this.tracers, this.scorches);
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

  /** `flicker`: the light dies away over `seconds` (a fire), instead of holding then cutting (a muzzle flash). */
  private flashLight(x: number, y: number, z: number, intensityCd: number, colour: Color, seconds: number, flicker = false): void {
    const f = this.flashes[this.nextFlash] as Flash;
    this.nextFlash = (this.nextFlash + 1) % this.flashes.length;
    f.light.position.set(x, y, z);
    f.light.color.copy(colour);
    // Point light intensity in candela, pre-exposed like every other light.
    f.light.intensity = intensityCd * this.preExposure;
    f.ttl = seconds;
    f.seconds = seconds;
    f.peakCd = intensityCd;
    f.flicker = flicker;
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
      const solid = surface === 'concrete' || surface === 'brick' || surface === 'rock' || surface === 'asphalt' || surface === 'wood';
      if (solid) {
        // Chips of the face itself, thrown out of the hole and down onto the ground, where they stay a while.
        const chips = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < chips; i++) {
          const sp = 1.5 + Math.random() * 3.5;
          this.debris3d.spawn(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, (nx + (Math.random() - 0.5) * 1.3) * sp, (ny + Math.random() * 0.9) * sp, (nz + (Math.random() - 0.5) * 1.3) * sp, 0.012 + Math.random() * 0.028, colour, 4 + Math.random() * 4);
        }
      }
      const count = surface === 'soil' ? 7 : solid ? 2 : 5;
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
    this.flashLight(x, y + 0.5, z, cd, kind === 'flash' ? _white : this.explosionColour, kind === 'flash' ? 0.12 : 0.38, kind === 'frag');
    // 1 The flash: one bright core for a few frames.
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
    if (kind !== 'frag') return;
    const R = (): number => Math.random() - 0.5;
    // 2 The fireball: a grenade's is small and brief — billows boiling out and up, burning out as they go.
    const f = spawnDefaults();
    for (let i = 0; i < 10; i++) {
      f.x = x + R() * 0.4;
      f.y = y + 0.2 + Math.random() * 0.3;
      f.z = z + R() * 0.4;
      f.vx = R() * 7;
      f.vy = 1 + Math.random() * 4;
      f.vz = R() * 7;
      f.sizeM = 1.1 + Math.random() * 0.6;
      f.growMs = 3;
      f.lifeSeconds = 0.3 + Math.random() * 0.3;
      f.drag = 5;
      f.heat = 0.85 + Math.random() * 0.15;
      this.fire.spawn(f);
    }
    // 3 The cloud: dust and explosive smoke following the fire, lit by it from inside for a moment, then
    // rising, spreading and thinning for seconds.
    const d = spawnDefaults();
    for (let i = 0; i < 16; i++) {
      d.x = x + R() * 0.8;
      d.y = y + 0.3 + Math.random() * 0.6;
      d.z = z + R() * 0.8;
      d.vx = R() * 5;
      d.vy = 1.2 + Math.random() * 3;
      d.vz = R() * 5;
      d.sizeM = 0.9 + Math.random() * 0.6;
      d.growMs = 0.9 + Math.random() * 0.5;
      d.lifeSeconds = 4 + Math.random() * 3;
      // Pulverised paving and soil is pale; the explosive's own soot darkens a share of it.
      d.colour = i % 3 === 0 ? 0x5c5650 : i % 3 === 1 ? 0x9a9184 : 0x8a7f70;
      d.opacity = 0.85;
      d.drag = 1.6;
      d.gravity = -0.12;
      d.delaySeconds = 0.03 + Math.random() * 0.12;
      d.heat = 0.6 + Math.random() * 0.4;
      this.dust.spawn(d);
    }
    // 4 The dust ring: thrown out flat along the ground by the shock and rolling to a stop.
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 6 + Math.random() * 4;
      d.x = x;
      d.y = y + 0.2;
      d.z = z;
      d.vx = Math.cos(a) * sp;
      d.vy = 0.3 + Math.random() * 0.6;
      d.vz = Math.sin(a) * sp;
      d.sizeM = 0.6;
      d.growMs = 1.4;
      d.lifeSeconds = 2.5 + Math.random() * 1.5;
      d.colour = 0x9a8f7e;
      d.opacity = 0.7;
      d.drag = 2.8;
      d.gravity = -0.05;
      d.delaySeconds = 0;
      d.heat = 0;
      this.dust.spawn(d);
    }
    // 5 Earth and stone: chunks on real arcs that land and stay, plus finer dirt as sprites.
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 2 + Math.random() * 7;
      this.debris3d.spawn(x + R() * 0.3, y + 0.15, z + R() * 0.3, Math.cos(a) * out, 3 + Math.random() * 8, Math.sin(a) * out, 0.04 + Math.random() * 0.1, i % 3 === 0 ? 0x5e4f3e : 0x8a857c, 6 + Math.random() * 5);
    }
    for (let i = 0; i < 16; i++) this.debris(x, y + 0.2, z, 0x6b5a47, 6, 0.08, 1.4);
    // 6 Embers: hot sparks thrown out under gravity.
    const e = spawnDefaults();
    e.colour = 0xff9a40;
    e.intensity = 6e3 * this.preExposure;
    e.gravity = 9.81;
    e.drag = 0.6;
    for (let i = 0; i < 22; i++) {
      e.x = x;
      e.y = y + 0.3;
      e.z = z;
      e.vx = R() * 16;
      e.vy = 2 + Math.random() * 9;
      e.vz = R() * 16;
      e.sizeM = 0.025 + Math.random() * 0.02;
      e.lifeSeconds = 0.4 + Math.random() * 0.7;
      this.sparks.spawn(e);
    }
    // 7 The scorch: placed on the ground once the terrain height is known (in update).
    this.pendingScorch.push(new Vector3(x, y, z));
  }

    update(game: Game, camera: PerspectiveCamera, dt: number): void {
    for (const f of this.flashes) {
      if (f.ttl > 0) {
        f.ttl -= dt;
        if (f.ttl <= 0) f.light.intensity = 0;
        else if (f.flicker) f.light.intensity = f.peakCd * this.preExposure * (f.ttl / f.seconds) ** 1.6 * (0.8 + Math.random() * 0.4);
      }
    }
    fireRadiance.value = FIRE_NITS * this.preExposure;
    smokeGlowRadiance.value = SMOKE_GLOW_NITS * this.preExposure;
    const world = game.world;
    this.debris3d.groundAt = (x, z, maxY) => supportHeight(world, x, z, 0, maxY, null);
    for (const p of this.pendingScorch) {
      const h = supportHeight(world, p.x, p.z, 0, p.y + 0.3, null);
      // Only a blast at the ground leaves a mark on it.
      if (p.y - h > 0.8) continue;
      const sz = 2.4 + Math.random() * 0.8;
      _q.setFromAxisAngle(_yAxis, Math.random() * 6.28);
      _m.compose(_p.set(p.x, h + 0.015, p.z), _q, _s.set(sz, 1, sz));
      this.scorches.setMatrixAt(this.nextScorch, _m);
      this.nextScorch = (this.nextScorch + 1) % MAX_SCORCHES;
      this.scorches.instanceMatrix.needsUpdate = true;
    }
    this.pendingScorch.length = 0;
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
    this.fire.update(camera, dt);
    this.debris3d.update(dt);
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
const _yAxis = new Vector3(0, 1, 0);
