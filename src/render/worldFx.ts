import { float, length, smoothstep, uv, vec3 } from 'three/tsl';
import { BoxGeometry, CapsuleGeometry, Color, InstancedMesh, Matrix4, MeshBasicNodeMaterial, MeshStandardNodeMaterial, type PerspectiveCamera, PointLight, Quaternion, type Scene, SphereGeometry, Vector3 } from 'three/webgpu';
import { LOCAL_LIGHTS } from '../config.ts';
import type { Game } from '../game/game.ts';
import type { MapData } from '../maps/types.ts';
import { lightColour } from './colour.ts';
import { softSprites } from './particles.ts';

// Persistent world effects read from game state every frame: smoke clouds,
// grenades in flight, pickups, the cook-arc preview, the nearest interior bulbs
// as real lights, and broken window panes.

const PUFFS_PER_CLOUD = 26;
const BULB_LIGHTS = 6;
const BULB_REASSIGN_SECONDS = 0.5;

export class WorldFx {
  private readonly smoke = softSprites(8 * PUFFS_PER_CLOUD, false);
  private readonly smokeSeeds: Vector3[] = [];
  private readonly grenades: InstancedMesh;
  private readonly pickups: InstancedMesh;
  private readonly preview: InstancedMesh;
  private readonly bulbs: PointLight[] = [];
  private bulbTimer = 0;
  private readonly bulbColour = new Color();
  private readonly brokenGlass = new Set<number>();
  preExposure = 1;

  constructor(
    scene: Scene,
    private readonly map: MapData,
  ) {
    for (let i = 0; i < PUFFS_PER_CLOUD; i++) {
      // Puff layout inside a unit cloud: a squashed ball resting on the ground.
      const a = i * 2.39996;
      const r = Math.sqrt((i + 0.5) / PUFFS_PER_CLOUD);
      this.smokeSeeds.push(new Vector3(Math.cos(a) * r * 0.9, 0.15 + ((i * 7) % 5) * 0.14, Math.sin(a) * r * 0.9));
    }
    this.smoke.mesh.renderOrder = 11;
    const grenadeMat = new MeshStandardNodeMaterial({ color: 0x4b5340, roughness: 0.7, metalness: 0 });
    this.grenades = new InstancedMesh(new CapsuleGeometry(0.032, 0.05, 4, 10), grenadeMat, 16);
    this.grenades.frustumCulled = false;
    this.grenades.castShadow = true;
    const pickupMat = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    this.pickups = new InstancedMesh(new BoxGeometry(0.34, 0.2, 0.22), pickupMat, 128);
    this.pickups.frustumCulled = false;
    this.pickups.castShadow = true;
    this.pickups.receiveShadow = true;
    for (let i = 0; i < 128; i++) this.pickups.setColorAt(i, new Color(1, 1, 1));
    const previewMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    previewMat.colorNode = vec3(0.9, 0.9, 0.85).mul(0.25);
    previewMat.opacityNode = float(1).sub(smoothstep(0.2, 0.5, length(uv().sub(0.5)))).mul(0.5);
    this.preview = new InstancedMesh(new SphereGeometry(0.03, 6, 4), previewMat, 90);
    this.preview.frustumCulled = false;
    this.preview.count = 0;
    const k = lightColour(LOCAL_LIGHTS.interiorBulbK);
    this.bulbColour.setRGB(k.r, k.g, k.b);
    for (let i = 0; i < BULB_LIGHTS && i < map.bulbs.length; i++) {
      const l = new PointLight(this.bulbColour, 0, 14, 2);
      l.castShadow = false;
      this.bulbs.push(l);
      scene.add(l);
    }
    scene.add(this.smoke.mesh, this.grenades, this.pickups, this.preview);
  }

  update(game: Game, camera: PerspectiveCamera, dt: number, glass: InstancedMesh | null, glassColliderIds: readonly number[]): void {
    this.updateSmoke(game, camera);
    // Grenades in flight.
    let n = 0;
    for (const g of game.grenades.grenades) {
      if (!g.active) continue;
      _q.setFromAxisAngle(_axis.set(1, 0, 0.3).normalize(), g.spinRad);
      _m.compose(_p.set(g.pos.x, g.pos.y, g.pos.z), _q, _one);
      this.grenades.setMatrixAt(n++, _m);
    }
    this.grenades.count = n;
    this.grenades.instanceMatrix.needsUpdate = true;
    // Pickups bob gently so they read as items; hidden once taken.
    n = 0;
    for (const p of game.items.pickups) {
      if (p.taken || n >= 128) continue;
      _q.setFromAxisAngle(_up, game.timeSeconds * 0.8 + n);
      _m.compose(_p.set(p.pos.x, p.pos.y + 0.12 + Math.sin(game.timeSeconds * 2 + n) * 0.03, p.pos.z), _q, _one);
      this.pickups.setMatrixAt(n, _m);
      // Med kit: sheet car-paint red; ammo: khaki; grenade: NATO green.
      this.pickups.setColorAt(n, _c.setHex(p.kind === 'medKit' ? 0x6e2a24 : p.kind === 'ammoPack' ? 0x5c5b3e : 0x4b5340));
      n++;
    }
    this.pickups.count = n;
    this.pickups.instanceMatrix.needsUpdate = true;
    if (this.pickups.instanceColor) this.pickups.instanceColor.needsUpdate = true;
    // Faint cook arc.
    const g = game.grenades;
    this.preview.count = g.cooking ? Math.min(90, g.previewCount) : 0;
    for (let i = 0; i < this.preview.count; i += 1) {
      const pt = g.previewPoints[i];
      if (!pt) break;
      _m.makeTranslation(pt.x, pt.y, pt.z);
      this.preview.setMatrixAt(i, _m);
    }
    this.preview.instanceMatrix.needsUpdate = true;
    this.updateBulbs(camera, dt);
    // Broken panes: the collider is disabled by the logic; hide its instance.
    if (glass) {
      for (let i = 0; i < glassColliderIds.length; i++) {
        const id = glassColliderIds[i] as number;
        if (this.brokenGlass.has(id)) continue;
        const box = game.world.boxes[id];
        if (box && box.halfExtents.x === 0) {
          this.brokenGlass.add(id);
          glass.setMatrixAt(i, _zero);
          glass.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  /**
   * Puffs are placed every frame from the logic's cloud radius, so what the
   * player sees is the same volume that blocks AI sight. Sheet: white smoke,
   * kept under the non-metal ceiling (#c9c6c0).
   */
  private updateSmoke(game: Game, camera: PerspectiveCamera): void {
    camera.getWorldQuaternion(_q);
    const fade = this.smoke.fade.array as Float32Array;
    let k = 0;
    for (const cloud of game.grenades.smokes) {
      if (!cloud.active) continue;
      const opacity = Math.min(1, cloud.radiusM / 2);
      for (let i = 0; i < PUFFS_PER_CLOUD; i++) {
        const seed = this.smokeSeeds[i] as Vector3;
        const wobble = Math.sin(game.timeSeconds * 0.3 + i) * 0.08;
        _p.set(
          cloud.pos.x + (seed.x + wobble) * cloud.radiusM,
          cloud.pos.y + seed.y * cloud.radiusM * 1.1,
          cloud.pos.z + (seed.z - wobble) * cloud.radiusM,
        );
        _m.compose(_p, _q, _s.setScalar(cloud.radiusM * 1.15));
        this.smoke.mesh.setMatrixAt(k, _m);
        this.smoke.mesh.setColorAt(k, _c.setHex(0xc9c6c0));
        fade[k] = opacity * 0.9;
        k++;
      }
    }
    for (let i = k; i < fade.length; i++) {
      fade[i] = 0;
      this.smoke.mesh.setMatrixAt(i, _zero);
    }
    this.smoke.fade.needsUpdate = true;
    this.smoke.mesh.instanceMatrix.needsUpdate = true;
    if (this.smoke.mesh.instanceColor) this.smoke.mesh.instanceColor.needsUpdate = true;
  }

  /** The nearest bulbs to the camera become real point lights (candela × pre-exposure). */
  private updateBulbs(camera: PerspectiveCamera, dt: number): void {
    this.bulbTimer -= dt;
    if (this.bulbs.length === 0) return;
    if (this.bulbTimer <= 0) {
      this.bulbTimer = BULB_REASSIGN_SECONDS;
      const cam = camera.position;
      const d = (b: { pos: { x: number; y: number; z: number } }): number => Math.hypot(b.pos.x - cam.x, b.pos.y - cam.y, b.pos.z - cam.z);
      const nearest = [...this.map.bulbs].sort((a, b) => d(a) - d(b));
      this.bulbs.forEach((light, i) => {
        const b = nearest[i];
        if (!b) {
          light.intensity = 0;
          return;
        }
        light.position.set(b.pos.x, b.pos.y, b.pos.z);
        light.intensity = b.intensityCd * this.preExposure;
      });
    }
  }
}

const _zero = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _one = new Vector3(1, 1, 1);
const _s = new Vector3();
const _c = new Color();
