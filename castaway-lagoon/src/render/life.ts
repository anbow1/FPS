import { float, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three/webgpu';
import { Rng } from '../core/rng.ts';
import type { LagoonGame } from '../game/game.ts';
import { OUTPOST } from '../game/outpost.ts';
import { heightAt, LAGOON_CENTRE } from '../game/terrain.ts';
import { U } from './uniforms.ts';

// Things that make the lagoon feel inhabited when the player does nothing:
// frigatebirds wheeling over the water by day, and fireflies drifting at the
// jungle's edge after dark. Both fade with the time of day and the rain.

interface Bird {
  mesh: Mesh;
  leftWing: Mesh;
  rightWing: Mesh;
  radius: number;
  height: number;
  speed: number;
  phase: number;
  centre: Vector3;
}

interface Fly {
  home: Vector3;
  phase: number;
  speed: number;
}

export class AmbientLife {
  readonly group = new Group();
  private readonly birds: Bird[] = [];
  private readonly flies: Fly[] = [];
  private readonly flyMesh: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly s = new Vector3();
  private readonly p = new Vector3();
  private t = 0;

  constructor() {
    this.group.name = 'life';
    const rng = new Rng(99);
    const birdMat = new MeshStandardNodeMaterial({ color: 0x2a2a2c, roughness: 0.8, side: DoubleSide });
    for (let i = 0; i < 9; i++) {
      const body = new Mesh(new PlaneGeometry(0.12, 0.7).rotateX(-Math.PI / 2), birdMat);
      const wing = (side: number): Mesh => {
        const g = new BufferGeometry();
        // A long, angled frigatebird wing: root at the body, crooked elbow, swept tip.
        const v = [0, 0, -0.1, side * 0.55, 0.05, 0.05, side * 1.1, 0, 0.35, 0, 0, 0.12];
        g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
        g.setIndex([0, 1, 3, 1, 2, 3]);
        g.computeVertexNormals();
        return new Mesh(g, birdMat);
      };
      const leftWing = wing(-1);
      const rightWing = wing(1);
      body.add(leftWing, rightWing);
      this.group.add(body);
      this.birds.push({
        mesh: body,
        leftWing,
        rightWing,
        radius: rng.range(25, 70),
        height: rng.range(22, 55),
        speed: rng.range(0.1, 0.22),
        phase: rng.range(0, Math.PI * 2),
        centre: new Vector3(LAGOON_CENTRE.x + rng.range(-30, 30), 0, LAGOON_CENTRE.z + rng.range(-40, 20)),
      });
    }
    const flyMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false });
    const r = uv().sub(0.5).length().mul(2);
    // ~40 cd/m² bioluminescence, pre-exposed, only after dusk.
    flyMat.colorNode = vec4(vec3(0.75, 1.0, 0.3).mul(float(1).sub(smoothstep(0.0, 1.0, r))).mul(U.preExposure.mul(40)).mul(U.night), 1);
    this.flyMesh = new InstancedMesh(new PlaneGeometry(0.05, 0.05), flyMat, 70);
    this.flyMesh.frustumCulled = false;
    for (let i = 0; i < 70; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(6, 30);
      const x = OUTPOST.x + Math.cos(a) * d;
      const z = OUTPOST.z + 6 + Math.abs(Math.sin(a)) * d;
      this.flies.push({ home: new Vector3(x, heightAt(x, z) + rng.range(0.4, 2.2), z), phase: rng.range(0, 100), speed: rng.range(0.2, 0.6) });
    }
    this.group.add(this.flyMesh);
  }

  update(game: LagoonGame, dt: number, cameraQuat: Quaternion): void {
    this.t += dt;
    const t = this.t;
    const day = 1 - game.env.daylight.night;
    const birdsOut = day > 0.5 && game.env.weather.rainRate < 0.6;
    for (const b of this.birds) {
      b.mesh.visible = birdsOut;
      if (!birdsOut) continue;
      const a = b.phase + t * b.speed;
      b.mesh.position.set(b.centre.x + Math.cos(a) * b.radius, b.height + Math.sin(t * 0.3 + b.phase) * 4, b.centre.z + Math.sin(a) * b.radius);
      b.mesh.rotation.set(0, -a, 0.35); // banked into the turn
      // Mostly soaring; an occasional burst of wingbeats.
      const flap = Math.sin(t * 7 + b.phase) * Math.max(0, Math.sin(t * 0.4 + b.phase * 3)) * 0.6;
      b.leftWing.rotation.z = flap;
      b.rightWing.rotation.z = -flap;
    }
    const n = game.env.daylight.night;
    this.flyMesh.visible = n > 0.3;
    if (!this.flyMesh.visible) return;
    this.flies.forEach((f, i) => {
      const k = f.phase + t * f.speed;
      this.p.set(f.home.x + Math.sin(k * 1.3) * 1.2, f.home.y + Math.sin(k * 2.1) * 0.4, f.home.z + Math.cos(k * 0.9) * 1.2);
      const blink = Math.max(0, Math.sin(k * 4 + i)) ** 6;
      this.m.compose(this.p, cameraQuat, this.s.setScalar(0.2 + blink));
      this.flyMesh.setMatrixAt(i, this.m);
    });
    this.flyMesh.instanceMatrix.needsUpdate = true;
  }
}
