import { BoxGeometry, CanvasTexture, ConeGeometry, CylinderGeometry, DoubleSide, Euler, Group, InstancedMesh, type Material, Matrix4, Mesh, MeshStandardNodeMaterial, type Object3D, PlaneGeometry, Quaternion, SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3 } from 'three/webgpu';
import type { LagoonGame } from '../game/game.ts';
import type { Interactable } from '../game/world.ts';
import { card, merge, rand } from './meshkit.ts';
import { markDry } from './outpost.ts';
import { propMaterials } from './propMaterials.ts';
import { buildKnife, buildRifle, shellGeometry, stoneGeometry, WEAPON_MATERIALS } from './weaponModels.ts';
import { addSway, leafMaterial } from './foliageMaterials.ts';

// One object per interactable, kept in step with the game's list: pick-ups
// vanish when taken, the crate lid swings open, thrown stones reappear where
// they came to rest. Tin cans and in-flight bodies (stones, shell casings)
// are drawn from the logic's positions every frame.

export class Props {
  readonly group = new Group();
  private readonly byId = new Map<number, Object3D>();
  private readonly lids = new Map<number, Object3D>();
  private version = -1;
  private readonly flying: InstancedMesh;
  private readonly shells: InstancedMesh;
  private readonly cans: Mesh[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3(1, 1, 1);
  private readonly p = new Vector3();
  private readonly euler = new Euler();

  constructor(game: LagoonGame) {
    this.group.name = 'props';
    this.flying = new InstancedMesh(stoneGeometry(3), WEAPON_MATERIALS.stone, 24);
    this.shells = new InstancedMesh(shellGeometry(), WEAPON_MATERIALS.brass, 120);
    for (const im of [this.flying, this.shells]) {
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = true;
      this.group.add(im);
    }
    const canMat = new MeshStandardNodeMaterial({ name: 'can label', map: labelTexture('#b8402e', 'BEANS'), roughness: 0.45, metalness: 0.2 });
    // Models that only appear mid-game (the crate's contents, a thrown stone coming to rest):
    // one hidden copy of each, so the loading-screen warm-up compiles their shaders.
    const gallery = new Group();
    gallery.name = 'prop gallery';
    gallery.visible = false;
    for (const model of ['ammoBox', 'beans', 'flare', 'stone', 'coconut'] as const) {
      const it = { id: -1, kind: 'pickup', model, item: null, count: 0, pos: { x: 0, y: -50, z: 0 }, yawRad: 0, radiusM: 0.2, name: model, alive: true, seed: 1, open: 0, text: '' } satisfies Interactable;
      gallery.add(prepare(this.build(it)));
    }
    gallery.position.set(0, -50, 0);
    this.group.add(gallery);
    for (const c of game.world.cans) {
      const mesh = new Mesh(new CylinderGeometry(0.033, 0.033, 0.11, 16), canMat);
      mesh.castShadow = true;
      mesh.userData.id = c.id;
      this.cans.push(mesh);
      this.group.add(mesh);
    }
  }

  update(game: LagoonGame): void {
    if (game.interactablesVersion !== this.version) this.sync(game);
    for (const it of game.interactables) {
      if (it.kind !== 'crate') continue;
      const lid = this.lids.get(it.id);
      if (lid) lid.rotation.x = it.open * 1.95; // hinge at the back: positive lifts the front edge
    }
    game.world.cans.forEach((c, i) => {
      const mesh = this.cans[i] as Mesh;
      mesh.position.set(c.pos.x, c.pos.y, c.pos.z);
      mesh.rotation.set(c.rot.x, c.rot.y, c.rot.z);
    });
    let stones = 0;
    let shells = 0;
    for (const b of game.bodies.list) {
      this.q.setFromEuler(this.euler.set(b.rot.x, b.rot.y, b.rot.z));
      this.m.compose(this.p.set(b.pos.x, b.pos.y, b.pos.z), this.q, this.s);
      if (b.kind === 'stone' && stones < 24) this.flying.setMatrixAt(stones++, this.m);
      else if (b.kind === 'shell' && shells < 120) this.shells.setMatrixAt(shells++, this.m);
    }
    this.flying.count = stones;
    this.shells.count = shells;
    this.flying.instanceMatrix.needsUpdate = true;
    this.shells.instanceMatrix.needsUpdate = true;
  }

  private sync(game: LagoonGame): void {
    this.version = game.interactablesVersion;
    for (const it of game.interactables) {
      const existing = this.byId.get(it.id);
      if (!it.alive) {
        if (existing) {
          existing.removeFromParent();
          this.byId.delete(it.id);
        }
        continue;
      }
      if (existing) continue;
      const obj = this.build(it);
      obj.position.set(it.pos.x, it.pos.y, it.pos.z);
      obj.rotation.y = it.yawRad;
      prepare(obj);
      this.byId.set(it.id, obj);
      this.group.add(obj);
    }
  }

  private build(it: Interactable): Object3D {
    const M = propMaterials();
    const g = new Group();
    g.name = `prop-${it.model}`;
    switch (it.model) {
      case 'stone': {
        const m = new Mesh(stoneGeometry(it.seed), WEAPON_MATERIALS.stone);
        m.position.y = 0.012;
        m.rotation.set(rand(it.seed, 1) * 0.3, rand(it.seed, 2) * 6, 0);
        g.add(m);
        break;
      }
      case 'coconut': {
        const m = new Mesh(new SphereGeometry(0.11, 14, 10).scale(1, 1.2, 1), shared('coconut', () => new MeshStandardNodeMaterial({ color: 0x6a5a30, roughness: 0.8 })));
        m.position.y = 0.08;
        m.rotation.z = 1.3;
        g.add(m);
        break;
      }
      case 'rifle': {
        const r = buildRifle();
        r.root.rotation.z = Math.PI / 2; // lying on its side on the cot
        r.root.position.y = 0.025;
        g.add(r.root);
        break;
      }
      case 'knife': {
        const k = buildKnife();
        k.root.rotation.z = Math.PI / 2;
        k.root.position.y = 0.008;
        g.add(k.root);
        break;
      }
      case 'crate':
        buildCrate(g, this.lids, it.id);
        break;
      case 'canteen': {
        g.add(new Mesh(new CylinderGeometry(0.075, 0.075, 0.2, 18).scale(1, 1, 0.5), M.steel));
        g.children[0]?.position.set(0, 0.1, 0);
        const cap = new Mesh(new CylinderGeometry(0.018, 0.018, 0.03, 10), M.plastic);
        cap.position.y = 0.215;
        g.add(cap);
        break;
      }
      case 'rope': {
        const parts = [0, 1, 2].map((k) => new TorusGeometry(0.13 - k * 0.005, 0.012, 6, 24).translate(0, -k * 0.02, k * 0.012));
        const coil = new Mesh(merge(parts, 'rope coil'), M.rope);
        coil.rotation.y = Math.PI / 2;
        g.add(coil);
        break;
      }
      case 'journal': {
        const cover = new Mesh(new BoxGeometry(0.15, 0.022, 0.21), shared('journal', () => new MeshStandardNodeMaterial({ color: 0x4a3222, roughness: 0.7 })));
        cover.position.y = 0.011;
        const pages = new Mesh(new BoxGeometry(0.142, 0.016, 0.2), M.paper);
        pages.position.set(0.004, 0.011, 0);
        g.add(cover, pages);
        break;
      }
      case 'map': {
        const m = new Mesh(new PlaneGeometry(0.38, 0.27).rotateX(-Math.PI / 2), new MeshStandardNodeMaterial({ map: mapTexture(), roughness: 0.85, side: DoubleSide }));
        m.position.y = 0.002;
        g.add(m);
        break;
      }
      case 'radio': {
        const body = new Mesh(new BoxGeometry(0.2, 0.12, 0.1), M.olivePaint);
        body.position.y = 0.06;
        const knobs = new Mesh(merge([0, 1, 2].map((k) => new CylinderGeometry(0.009, 0.009, 0.012, 10).rotateX(Math.PI / 2).translate(-0.06 + k * 0.05, 0.085, -0.055)), 'knobs'), M.plastic);
        const antenna = new Mesh(new CylinderGeometry(0.002, 0.003, 0.35, 5).rotateZ(-0.35).translate(0.12, 0.28, 0), M.steel);
        g.add(body, knobs, antenna);
        break;
      }
      case 'photo': {
        const m = new Mesh(new PlaneGeometry(0.09, 0.12), new MeshStandardNodeMaterial({ map: photoTexture(), roughness: 0.6, side: DoubleSide }));
        m.rotation.y = Math.PI; // faces into the shelter
        g.add(m);
        break;
      }
      case 'backpack': {
        const body = new Mesh(new SphereGeometry(0.2, 14, 10).scale(1.05, 1.35, 0.62), M.cotCanvas);
        body.position.set(0, 0.27, -0.02);
        body.rotation.x = -0.15;
        const flap = new Mesh(new SphereGeometry(0.16, 12, 8).scale(1.1, 0.5, 0.7), M.cotCanvas);
        flap.position.set(0, 0.5, -0.04);
        const pocket = new Mesh(new BoxGeometry(0.2, 0.14, 0.07), M.cotCanvas);
        pocket.position.set(0, 0.17, -0.14);
        g.add(body, flap, pocket);
        break;
      }
      case 'ammoBox': {
        const b = new Mesh(new BoxGeometry(0.26, 0.15, 0.13), M.olivePaint);
        b.position.y = 0.075;
        const handle = new Mesh(new TorusGeometry(0.035, 0.005, 5, 10, Math.PI), M.steel);
        handle.position.y = 0.15;
        g.add(b, handle);
        break;
      }
      case 'beans': {
        const tin = shared('beans', () => new MeshStandardNodeMaterial({ map: labelTexture('#2e6a8a', 'BEANS'), roughness: 0.45, metalness: 0.2 }));
        for (let k = 0; k < 2; k++) {
          const c = new Mesh(new CylinderGeometry(0.037, 0.037, 0.11, 16), tin);
          c.position.set(k * 0.08 - 0.04, 0.055, 0);
          g.add(c);
        }
        break;
      }
      case 'flare': {
        const f = new Mesh(new CylinderGeometry(0.018, 0.018, 0.26, 12).rotateZ(Math.PI / 2), shared('flare', () => new MeshStandardNodeMaterial({ color: 0xa3261e, roughness: 0.5 })));
        f.position.y = 0.018;
        g.add(f);
        break;
      }
      case 'herb':
        g.add(plantCards('herb', 7, 0.42, it.seed));
        break;
      case 'hibiscus': {
        g.add(plantCards('hibiscus', 9, 0.8, it.seed));
        const petal = shared('petal', () => new MeshStandardNodeMaterial({ color: 0xc41e2a, roughness: 0.5, side: DoubleSide }));
        for (let k = 0; k < 6; k++) {
          const flower = new Mesh(new ConeGeometry(0.055, 0.06, 5, 1, true), petal);
          const a = rand(it.seed, k) * Math.PI * 2;
          flower.position.set(Math.cos(a) * 0.3, 0.45 + rand(it.seed, k + 7) * 0.35, Math.sin(a) * 0.3);
          flower.rotation.set(Math.PI + rand(it.seed, k + 3) * 0.8, 0, rand(it.seed, k + 5) - 0.5);
          g.add(flower);
        }
        break;
      }
      case 'aloe': {
        const mat = shared('aloe', () => new MeshStandardNodeMaterial({ color: 0x6f8a5a, roughness: 0.45 }));
        const parts = [];
        for (let k = 0; k < 14; k++) {
          const leaf = new ConeGeometry(0.035, 0.45 - (k % 3) * 0.08, 5);
          leaf.scale(1, 1, 0.45);
          leaf.translate(0, 0.2, 0);
          leaf.rotateX(0.35 + (k % 3) * 0.25);
          leaf.rotateY((k / 14) * Math.PI * 2 + rand(it.seed, k) * 0.3);
          parts.push(leaf);
        }
        g.add(new Mesh(merge(parts, 'aloe'), mat));
        break;
      }
      default:
        throw new Error(`no prop model for '${it.model}'`);
    }
    return g;
  }
}

/** Shadows on, and the `dry` attribute every prop material reads (props sit under the tarp or lie outside dry enough). */
function prepare(obj: Object3D): Object3D {
  obj.traverse((o) => {
    if (o instanceof Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (!o.geometry.getAttribute('dry')) markDry(o.geometry, 1);
    }
  });
  return obj;
}

const sharedMaterials = new Map<string, Material>();

/** One material per prop type, not per prop: a new material object can mean a new shader build mid-game. */
function shared<T extends Material>(key: string, make: () => T): T {
  let m = sharedMaterials.get(key);
  if (!m) {
    m = make();
    sharedMaterials.set(key, m);
  }
  return m as T;
}

function plantCards(kind: 'herb' | 'hibiscus', count: number, size: number, seed: number): Mesh {
  const parts = [];
  for (let k = 0; k < count; k++) {
    const c = card(size, size);
    c.rotateX(-0.25 - rand(seed, k) * 0.5);
    c.rotateY((k / count) * Math.PI * 2 + rand(seed, k + 9));
    parts.push(c);
  }
  const g = merge(parts, kind);
  addSway(g, 0.1, (_x, y) => y * 1.5, size);
  return new Mesh(g, shared(`leaf-${kind}`, () => leafMaterial(kind)));
}

function buildCrate(g: Group, lids: Map<number, Object3D>, id: number): void {
  const M = propMaterials();
  // The interactable sits on the crate's top face; build downward from there.
  const sx = 0.86;
  const sy = 0.5;
  const sz = 0.52;
  const wall = 0.022;
  const parts = [
    new BoxGeometry(sx, wall, sz).translate(0, -sy + wall / 2, 0),
    new BoxGeometry(sx, sy, wall).translate(0, -sy / 2, sz / 2 - wall / 2),
    new BoxGeometry(sx, sy, wall).translate(0, -sy / 2, -sz / 2 + wall / 2),
    new BoxGeometry(wall, sy, sz).translate(sx / 2 - wall / 2, -sy / 2, 0),
    new BoxGeometry(wall, sy, sz).translate(-sx / 2 + wall / 2, -sy / 2, 0),
  ];
  for (const x of [-sx / 2 + 0.03, sx / 2 - 0.03]) for (const z of [-sz / 2 - 0.006, sz / 2 + 0.006]) parts.push(new BoxGeometry(0.05, sy, 0.012).translate(x, -sy / 2, z));
  const body = new Mesh(merge(parts, 'crate'), M.darkWood);
  const lid = new Group();
  lid.position.set(0, 0, sz / 2); // hinge along the back top edge
  const lidMesh = new Mesh(merge([new BoxGeometry(sx + 0.02, 0.028, sz + 0.02).translate(0, 0.014, -sz / 2), new BoxGeometry(sx + 0.02, 0.02, 0.06).translate(0, 0.035, -sz / 2 - 0.15), new BoxGeometry(sx + 0.02, 0.02, 0.06).translate(0, 0.035, -sz / 2 + 0.15)], 'crate lid'), M.planks);
  lid.add(lidMesh);
  const stencil = new Mesh(new PlaneGeometry(0.4, 0.14), new MeshStandardNodeMaterial({ map: labelTexture('rgba(0,0,0,0)', 'SUPPLY', '#d8d0b8'), transparent: true, roughness: 0.8 }));
  stencil.position.set(0, -0.2, -sz / 2 - 0.013);
  stencil.rotation.y = Math.PI;
  g.add(body, lid, stencil);
  lids.set(id, lid);
}

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): CanvasTexture {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable for prop textures');
  draw(ctx);
  const t = new CanvasTexture(el);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function labelTexture(bg: string, text: string, ink = '#efe6cf'): CanvasTexture {
  return canvasTexture(256, 128, (c) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, 256, 128);
    c.fillStyle = ink;
    c.font = 'bold 44px Georgia, serif';
    c.textAlign = 'center';
    c.fillText(text, 128, 80);
  });
}

function mapTexture(): CanvasTexture {
  return canvasTexture(512, 360, (c) => {
    c.fillStyle = '#d9cba6';
    c.fillRect(0, 0, 512, 360);
    c.strokeStyle = '#4a3a28';
    c.lineWidth = 3;
    c.beginPath();
    c.ellipse(250, 170, 150, 110, 0, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#6f9aa0';
    c.beginPath();
    c.ellipse(250, 150, 90, 70, 0, 0, Math.PI * 2);
    c.fill();
    c.fillRect(230, 20, 40, 90);
    c.fillStyle = '#4a3a28';
    c.font = 'italic 20px Georgia, serif';
    c.fillText('lagoon', 215, 158);
    c.fillText('fresh water?', 340, 300);
    c.strokeStyle = '#9a2a1a';
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(360, 250);
    c.lineTo(390, 280);
    c.moveTo(390, 250);
    c.lineTo(360, 280);
    c.stroke();
    c.setLineDash([6, 6]);
    c.strokeStyle = '#4a3a28';
    c.beginPath();
    c.moveTo(210, 250);
    c.quadraticCurveTo(290, 320, 370, 265);
    c.stroke();
  });
}

function photoTexture(): CanvasTexture {
  return canvasTexture(128, 170, (c) => {
    c.fillStyle = '#e8dcc0';
    c.fillRect(0, 0, 128, 170);
    const g = c.createLinearGradient(0, 10, 0, 150);
    g.addColorStop(0, '#9fb3b0');
    g.addColorStop(1, '#7a6e58');
    c.fillStyle = g;
    c.fillRect(8, 8, 112, 140);
    c.fillStyle = '#3d3226';
    for (const x of [45, 80]) {
      c.beginPath();
      c.arc(x, 70, 10, 0, Math.PI * 2);
      c.fill();
      c.fillRect(x - 11, 80, 22, 50);
    }
  });
}

