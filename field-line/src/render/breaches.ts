import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { abs, dot, float, Fn, length, mx_noise_float, positionWorld, select, smoothstep, step, uniformArray, vec3 } from 'three/tsl';
import { BackSide, BoxGeometry, BufferAttribute, type BufferGeometry, Color, CylinderGeometry, Group, IcosahedronGeometry, Matrix4, Mesh, MeshStandardNodeMaterial, type Node, Vector3, Vector4 } from 'three/webgpu';
import type { BoxLook, MapBox } from '../maps/types.ts';

// Grenades breach the façades, as in the reference footage of a three.js city
// whose rockets tear storey-high holes out of a tower block: a frag going off
// against a wall leaves a ragged hole with the floor slab broken across it,
// the room behind it dark, rubble on its floor and a heap of masonry on the
// pavement under it; the wall round the hole is broken back to its core and
// scorched.
//
// The façade box stays solid (collision, the AI's eyes): the hole is in its
// shader. Every façade material reads the breaches from one uniform array and
// discards the wall inside each one (maskNode) — the ragged outline is noise on
// the distance from the centre in the wall's plane. Behind the hole a cavity is
// real geometry, built per breach: the box room seen from inside (its faces
// drawn from behind), the slab across it with its rebar, the rubble. Without it
// the hole would show the building's far wall from behind, which is culled:
// the sky through the house.

/** Holes alive at once; the oldest closes when a new one opens. */
const MAX = 10;
/** How far from the wall a blast still breaches it (m), and the hole's radius at contact and at that reach. */
const REACH_M = 2.6;
const R_CONTACT_M = 1.7;
const R_REACH_M = 0.9;

/** Each hole: centre on the wall (xyz) and radius (w, 0 = none); and the wall's outward normal. */
const holes = uniformArray(Array.from({ length: MAX }, () => new Vector4(0, -1e4, 0, 0)), 'vec4');
const normals = uniformArray(Array.from({ length: MAX }, () => new Vector4(0, 0, 1, 0)), 'vec4');

type F = Node<'float'>;

/**
 * For a façade fragment: x = 1 inside a hole, y = the broken rim round it (0…1), z = scorch (0…1). Built once
 * per material and read by its mask and its colour. Only the nearest hole's outline is noise (two lookups,
 * not two per hole): the others cost a few multiplies each.
 */
export function breachState(): Node<'vec3'> {
  return Fn(() => {
    const best = float(1e6).toVar();
    const bestR = float(0).toVar();
    const bp = vec3(0).toVar();
    for (let i = 0; i < MAX; i++) {
      const h = holes.element(i) as unknown as Node<'vec4'>;
      const n = (normals.element(i) as unknown as Node<'vec4'>).xyz;
      const d = positionWorld.sub(h.xyz);
      const dn = dot(d, n);
      const planar = d.sub(n.mul(dn));
      // Off the wall's plane (another face of the block), or no hole: out of the running.
      const dist = length(planar).add(step(0.6, abs(dn)).mul(1e5)).add(step(h.w, 0.001).mul(1e5));
      const better = dist.lessThan(best);
      best.assign(select(better, dist, best));
      bestR.assign(select(better, h.w, bestR));
      bp.assign(select(better, planar, bp));
    }
    const jag = mx_noise_float(bp.mul(1.4)).mul(0.3).add(mx_noise_float(bp.mul(4.3)).mul(0.1));
    const rEff = bestR.mul(jag.add(1)) as F;
    const hole = step(best, rEff);
    const rim = float(1).sub(hole).mul(float(1).sub(smoothstep(rEff, rEff.add(0.14), best)));
    const soot = float(1).sub(hole).mul(smoothstep(bestR.mul(2.6), bestR.mul(0.9), best)).mul(mx_noise_float(bp.mul(2.2)).mul(0.35).add(0.75));
    return vec3(hole, rim, soot.clamp(0, 1));
  })() as unknown as Node<'vec3'>;
}

/** Keep the fragment unless it is inside a hole (a façade material's maskNode). */
export function breachMask(state: Node<'vec3'>): Node<'bool'> {
  return state.x.lessThan(0.5);
}

/** The wall's colour round a hole: its broken core at the rim, soot spreading past it. */
export function breachColour(albedo: Node<'vec3'>, state: Node<'vec3'>): Node<'vec3'> {
  // The broken core is darker than the face (rough, in its own shadow), soot darker still.
  const core = vec3(0.2, 0.19, 0.175);
  return albedo.mul(float(1).sub(state.z.mul(0.7))).mul(float(1).sub(state.y)).add(core.mul(state.y));
}

// ------------------------------------------------------------------ the cavity and the rubble

/** Rubble colours by the wall's look: brick shows its red, the rest concrete greys. */
function rubbleColours(look: BoxLook): number[] {
  // Darker than the faces they came from: broken surfaces in sun read paper-white otherwise.
  return look === 'brick' || look === 'brickDark' ? [0x5e3326, 0x6c3a2c, 0x46291f, 0x5a5753, 0x4a4845] : [0x5f5c57, 0x6c6862, 0x4d4b47, 0x57534d, 0x3f3d3a];
}

function coloured(g: BufferGeometry, hex: number): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(n.attributes)) if (key !== 'position' && key !== 'normal') n.deleteAttribute(key);
  const c = new Color(hex);
  const count = n.getAttribute('position').count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) col.set([c.r, c.g, c.b], i * 3);
  n.setAttribute('color', new BufferAttribute(col, 3));
  return n;
}

/** A broken lump of masonry: a squashed, turned icosahedron. */
function chunk(size: number, x: number, y: number, z: number, hex: number, rnd: () => number): BufferGeometry {
  const g = new IcosahedronGeometry(size, 0).scale(1 + rnd() * 0.6, 0.45 + rnd() * 0.4, 0.8 + rnd() * 0.5);
  g.rotateY(rnd() * 6.28).rotateX((rnd() - 0.5) * 0.6);
  return coloured(g.translate(x, y + size * 0.3, z), hex);
}

interface Breach {
  group: Group;
}

/** The breaches in the façades: finds the wall a blast is against, opens the hole, builds what is behind it. */
export class Breaches {
  readonly group = new Group();
  private readonly live: (Breach | null)[] = Array.from({ length: MAX }, () => null);
  private next = 0;
  private readonly cavityMaterial: MeshStandardNodeMaterial;
  private readonly rubbleMaterial: MeshStandardNodeMaterial;
  private seed = 1;

  constructor(private readonly boxes: readonly MapBox[]) {
    this.group.name = 'breaches';
    // The room seen through the hole: its faces drawn from inside (BackSide), darker toward the back.
    this.cavityMaterial = new MeshStandardNodeMaterial({ name: 'breach cavity', vertexColors: true, roughness: 0.95, side: BackSide });
    this.rubbleMaterial = new MeshStandardNodeMaterial({ name: 'rubble', vertexColors: true, roughness: 0.92 });
  }

  private rnd = (): number => {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  };

  /** A blast at (x, y, z): breaks the nearest façade side within reach. The face and its outward normal, or null. */
  blast(x: number, y: number, z: number): { x: number; y: number; z: number; nx: number; nz: number; look: BoxLook } | null {
    let best: { box: MapBox; d: number; n: [number, number]; at: Vector3 } | null = null;
    for (const b of this.boxes) {
      if (!b.facade || (b.yawRad ?? 0) !== 0) continue;
      const hx = b.size.x / 2;
      const hz = b.size.z / 2;
      const bottom = b.center.y - b.size.y / 2;
      const top = b.center.y + b.size.y / 2;
      if (y < bottom - 0.5 || y > top - 1) continue;
      const lx = x - b.center.x;
      const lz = z - b.center.z;
      // Outside the box, off one side face and within reach of it, not past its ends.
      for (const [n, dist, along, half] of [
        [[1, 0], lx - hx, lz, hz],
        [[-1, 0], -lx - hx, lz, hz],
        [[0, 1], lz - hz, lx, hx],
        [[0, -1], -lz - hz, lx, hx],
      ] as [[number, number], number, number, number][]) {
        if (dist < -0.2 || dist > REACH_M || Math.abs(along) > half - 1.2) continue;
        if (!best || dist < best.d) {
          const at = new Vector3(n[0] !== 0 ? b.center.x + n[0] * hx : x, Math.max(bottom + 1.2, Math.min(top - 1.5, y + 0.6)), n[1] !== 0 ? b.center.z + n[1] * hz : z);
          best = { box: b, d: Math.max(0, dist), n, at };
        }
      }
    }
    if (!best) return null;
    const r = R_CONTACT_M + (R_REACH_M - R_CONTACT_M) * Math.min(1, best.d / REACH_M);
    this.open(best.box, best.at, best.n, r);
    return { x: best.at.x, y: best.at.y, z: best.at.z, nx: best.n[0], nz: best.n[1], look: best.box.look };
  }

  private open(box: MapBox, at: Vector3, n: [number, number], r: number): void {
    const slot = this.next;
    this.next = (this.next + 1) % MAX;
    const old = this.live[slot];
    if (old) {
      this.group.remove(old.group);
      old.group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
    }
    (holes.array[slot] as Vector4).set(at.x, at.y, at.z, r);
    (normals.array[slot] as Vector4).set(n[0], 0, n[1], 0);
    const g = new Group();
    g.add(this.cavity(box, at, n, r), this.rubble(box, at, n, r));
    this.group.add(g);
    this.live[slot] = { group: g };
  }

  /** The room behind the hole: floor and ceiling at the storey lines round it, the slabs between, rubble. */
  private cavity(box: MapBox, at: Vector3, n: [number, number], r: number): Mesh {
    const storey = box.facade?.storeyM ?? 3.2;
    const base = box.center.y - box.size.y / 2;
    const top = box.center.y + box.size.y / 2;
    const reach = r * 1.45;
    const y0 = Math.max(base, base + Math.floor((at.y - reach - base) / storey) * storey);
    const y1 = Math.min(top - 0.3, base + Math.ceil((at.y + reach - base) / storey) * storey);
    const depthAvail = (n[0] !== 0 ? box.size.x : box.size.z) - 0.6;
    const D = Math.min(4, depthAvail);
    const W = 2 * reach + 1;
    const H = y1 - y0;
    // Frame: x along the wall, y up, z out of it (the wall's normal); origin on the wall at the hole's foot.
    const nx = n[0];
    const nz = n[1];
    const frame = new Matrix4().makeBasis(new Vector3(nz, 0, -nx), new Vector3(0, 1, 0), new Vector3(nx, 0, nz)).setPosition(at.x, y0, at.z);
    // The room's shell, front 2 cm inside the wall so its edge never shows in the wall's plane.
    const shell = new BoxGeometry(W, H, D, Math.ceil(W / 0.5), Math.ceil(H / 0.5), Math.ceil(D / 0.5)).translate(0, H / 2, -D / 2 - 0.02).toNonIndexed();
    // Darker toward the back and the ceiling: the light comes in through the hole.
    const pos = shell.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    // Plaster walls and ceiling, the floor grey with dust; all dimmer toward the back, the ceiling darkest.
    const wallTone = new Color(0x7a756d);
    const floorTone = new Color(0x8a857c);
    const nrm = shell.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      const back = Math.min(1, -pos.getZ(i) / D);
      // Outward normals (the box as built): the floor's points down, the ceiling's up.
      const floor = nrm.getY(i) < -0.5;
      const ceiling = nrm.getY(i) > 0.5;
      const t = floor ? floorTone : wallTone;
      // The sky lights the room through the hole only: it falls off fast with depth, the ceiling sees least.
      const k = Math.pow(1 - back * 0.8, 1.6) * (ceiling ? 0.4 : 1);
      col.set([t.r * k, t.g * k, t.b * k], i * 3);
    }
    for (const key of Object.keys(shell.attributes)) if (key !== 'position' && key !== 'normal') shell.deleteAttribute(key);
    shell.setAttribute('color', new BufferAttribute(col, 3));
    shell.applyMatrix4(frame);
    // The slabs crossing the hole (their broken front ends are what the eye reads as storeys), rebar out of them.
    const solid: BufferGeometry[] = [];
    for (let s = y0 + storey; s < y1 - 0.1; s += storey) {
      const ly = s - y0;
      solid.push(coloured(new BoxGeometry(W, 0.24, D).translate(0, ly - 0.12, -D / 2 - 0.05), 0x77736c));
      for (let k = 0; k < 7; k++) {
        const bx = (this.rnd() - 0.5) * reach * 1.6;
        const len = 0.25 + this.rnd() * 0.35;
        const bar = new CylinderGeometry(0.008, 0.008, len, 4).rotateX(Math.PI / 2 + (this.rnd() - 0.5) * 0.9).rotateZ((this.rnd() - 0.5) * 0.6);
        solid.push(coloured(bar.translate(bx, ly - 0.08 - this.rnd() * 0.1, -0.1 + len * 0.3), 0x4a3528));
      }
    }
    // Rubble on each floor near the front.
    const tones = rubbleColours(box.look);
    for (let fy = 0; fy < H - 0.5; fy += storey) {
      for (let k = 0; k < 22; k++) solid.push(chunk(0.08 + Math.pow(this.rnd(), 1.5) * 0.36, (this.rnd() - 0.5) * W * 0.8, fy, -0.2 - this.rnd() * 2.2, tones[k % tones.length] as number, this.rnd));
    }
    const solidGeo = mergeGeometries(solid, false);
    const mesh = new Mesh(shell, this.cavityMaterial);
    mesh.receiveShadow = true;
    if (solidGeo) {
      const inside = new Mesh(solidGeo.applyMatrix4(frame), this.rubbleMaterial);
      inside.receiveShadow = true;
      inside.castShadow = true;
      mesh.add(inside);
    }
    mesh.name = 'breach cavity';
    return mesh;
  }

  /** The heap the wall left on the pavement under the hole: a low mound and lumps thrown out round it. */
  private rubble(box: MapBox, at: Vector3, n: [number, number], r: number): Mesh {
    const base = box.center.y - box.size.y / 2;
    const height = at.y - base;
    // Higher holes drop less where they are and scatter it further.
    const amount = Math.max(0.35, 1 - height / 14);
    const spread = 1.2 + Math.min(2.5, height * 0.15);
    const tones = rubbleColours(box.look);
    const parts: BufferGeometry[] = [];
    const along = new Vector3(n[1], 0, -n[0]);
    const out = new Vector3(n[0], 0, n[1]);
    const mound = new IcosahedronGeometry(1, 2).scale(r * 1.1 * amount + 0.4, 0.45 * amount, (0.9 + spread * 0.3) * amount);
    const m = new Matrix4().makeBasis(along, new Vector3(0, 1, 0), out).setPosition(at.x + out.x * 0.6, base, at.z + out.z * 0.6);
    parts.push(coloured(mound.applyMatrix4(m), tones[2] as number));
    const count = Math.round(70 * amount);
    for (let k = 0; k < count; k++) {
      const a = (this.rnd() - 0.5) * (r * 2.6 + 1);
      const o = Math.pow(this.rnd(), 1.6) * spread * 2;
      const p = new Vector3().addScaledVector(along, a).addScaledVector(out, 0.3 + o);
      const size = 0.05 + Math.pow(this.rnd(), 2) * 0.32;
      const lift = Math.max(0, 0.4 * amount * (1 - o / (spread * 1.2)));
      parts.push(chunk(size, at.x + p.x, base + lift * this.rnd(), at.z + p.z, tones[k % tones.length] as number, this.rnd));
    }
    const g = mergeGeometries(parts, false);
    if (!g) throw new Error('rubble merge failed');
    const mesh = new Mesh(g, this.rubbleMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'rubble';
    return mesh;
  }
}

