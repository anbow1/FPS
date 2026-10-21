import { attribute, float, floor, fract, mix, step, uv, vec2, vec3 } from 'three/tsl';
import { BoxGeometry, BufferAttribute, type BufferGeometry, Color, CylinderGeometry, Group, InstancedMesh, LatheGeometry, Matrix4, MeshStandardNodeMaterial, Quaternion, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three/webgpu';
import { STREET } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { merge } from '../render/meshkit.ts';
import { hash12, SCENE } from '../render/nodes.ts';
import type { CafeTerrace, Placed, StreetPlan } from './plan.ts';

// Street furniture after the Paris originals, invented in detail and
// unbranded: the boulevard candelabra (a fluted cast-iron post with a
// four-sided lantern, lit — the lamps come on at this hour), the green
// advertising column with its dome and posters, the newspaper kiosk, benches,
// and a café terrace: small round marble tables and woven bistro chairs set in
// rows facing the street, as Paris terraces are.
//
// One material for all of it: per-vertex colour, roughness, metalness and a
// kind (0 plain, 1 posters, 2 lit lantern glass, 3 magazines).

const KIND = { plain: 0, posters: 1, lantern: 2, magazines: 3 } as const;

export function buildFurniture(plan: StreetPlan): Group {
  const g = new Group();
  g.name = 'street furniture';
  const mat = furnitureMaterial();
  const place = (geo: BufferGeometry, list: readonly { x: number; z: number; yaw: number }[], shadow = true): void => {
    if (list.length === 0) return;
    const mesh = new InstancedMesh(geo, mat, list.length);
    const m = new Matrix4();
    const q = new Quaternion();
    list.forEach((p, i) => mesh.setMatrixAt(i, m.compose(new Vector3(p.x, STREET.kerbM, p.z), q.setFromAxisAngle(new Vector3(0, 1, 0), p.yaw), new Vector3(1, 1, 1))));
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    g.add(mesh);
  };
  // The kiosk's counter faces +z in its own frame, the bench's seat −x: both turned to face the street.
  const counterToStreet = (p: Placed): { x: number; z: number; yaw: number } => ({ x: p.x, z: p.z, yaw: p.x > 0 ? -Math.PI / 2 : Math.PI / 2 });
  const seatToStreet = (p: Placed): { x: number; z: number; yaw: number } => ({ x: p.x, z: p.z, yaw: p.x > 0 ? 0 : Math.PI });
  place(lampGeometry(), plan.lamps.map((p) => ({ x: p.x, z: p.z, yaw: 0 })));
  place(columnGeometry(), plan.columns.map((p) => ({ x: p.x, z: p.z, yaw: p.seed })));
  place(kioskGeometry(), plan.kiosks.map(counterToStreet));
  place(benchGeometry(), plan.benches.map(seatToStreet));
  const { tables, chairs } = terraceLayout(plan.cafes);
  place(tableGeometry(), tables);
  place(chairGeometry(), chairs);
  return g;
}

/** Where the café tables and chairs stand: rows along the front, two chairs to a table, facing the street. */
export function terraceLayout(cafes: readonly CafeTerrace[]): { tables: { x: number; z: number; yaw: number }[]; chairs: { x: number; z: number; yaw: number }[] } {
  const tables: { x: number; z: number; yaw: number }[] = [];
  const chairs: { x: number; z: number; yaw: number }[] = [];
  for (const c of cafes) {
    // Terraces beyond ~300 m are under a pixel a chair; leave them to the haze.
    if (c.zMax < -300) continue;
    const r = new Rng(Math.round(c.zMin * 10));
    const face = c.side > 0 ? Math.PI / 2 : -Math.PI / 2; // chairs look toward the street (−x on the right side)
    for (const row of [0, 1]) {
      const x = c.side * (STREET.facadeHalfM - 0.9 - row * 1.35);
      for (let z = c.zMin + 0.7; z < c.zMax - 0.5; z += 1.5) {
        const jitter = (r.next() - 0.5) * 0.12;
        tables.push({ x: x - c.side * 0.55, z: z + jitter, yaw: r.next() * 6 });
        for (const dz of [-0.36, 0.36]) chairs.push({ x: x + c.side * 0.05, z: z + dz + jitter, yaw: face + (r.next() - 0.5) * 0.5 });
      }
    }
  }
  return { tables, chairs };
}

// ------------------------------------------------------------------ geometry

interface Look {
  hex: number;
  rough: number;
  metal?: number;
  kind?: number;
}

function paint(geo: BufferGeometry, look: Look): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.getAttribute('position').count;
  const c = new Color(look.hex);
  const col = new Float32Array(n * 3);
  const mat = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3);
    mat.set([look.rough, look.metal ?? 0, look.kind ?? 0], i * 3);
  }
  g.setAttribute('tint', new BufferAttribute(col, 3));
  g.setAttribute('pbr', new BufferAttribute(mat, 3));
  return g;
}

/** meshkit.merge keeps only position/normal/uv; carry the paint across. */
function joined(parts: BufferGeometry[], name: string): BufferGeometry {
  const tint: number[] = [];
  const pbr: number[] = [];
  for (const p of parts) {
    tint.push(...(p.getAttribute('tint').array as Float32Array));
    pbr.push(...(p.getAttribute('pbr').array as Float32Array));
  }
  const out = merge(parts, name);
  out.setAttribute('tint', new BufferAttribute(new Float32Array(tint), 3));
  out.setAttribute('pbr', new BufferAttribute(new Float32Array(pbr), 3));
  return out;
}

const IRON: Look = { hex: 0x1c2620, rough: 0.5, metal: 0.4 };
const KIOSK_GREEN: Look = { hex: 0x1f3d2b, rough: 0.45, metal: 0.3 };
const lathe = (pts: [number, number][], seg = 16): BufferGeometry => new LatheGeometry(pts.map(([r, y]) => new Vector2(r, y)), seg);

/** The candelabra: base, fluted post, collar, a four-sided lantern of lit glass under a crown, ~4.6 m. */
function lampGeometry(): BufferGeometry {
  return joined(
    [
      paint(lathe([[0.001, 0], [0.24, 0], [0.24, 0.12], [0.2, 0.2], [0.17, 0.55], [0.13, 0.62], [0.1, 0.75], [0.085, 1.0], [0.07, 3.6], [0.085, 3.65], [0.085, 3.72], [0.06, 3.8], [0.11, 3.86], [0.001, 3.88]]), IRON),
      // Lantern: an upturned frustum of glass on a square plan, its frame, roof and finial.
      paint(new CylinderGeometry(0.27, 0.15, 0.52, 4, 1, true).rotateY(Math.PI / 4).translate(0, 4.16, 0), { hex: 0xffe2b0, rough: 0.2, kind: KIND.lantern }),
      paint(new CylinderGeometry(0.29, 0.29, 0.05, 4).rotateY(Math.PI / 4).translate(0, 4.43, 0), IRON),
      paint(new CylinderGeometry(0.05, 0.31, 0.24, 4).rotateY(Math.PI / 4).translate(0, 4.57, 0), IRON),
      paint(new SphereGeometry(0.05, 8, 6).translate(0, 4.73, 0), IRON),
      ...[0, 1, 2, 3].map((k) => paint(new BoxGeometry(0.02, 0.54, 0.02).translate(0.21, 4.16, 0).rotateY((k * Math.PI) / 2 + Math.PI / 4), IRON)),
    ],
    'lamp',
  );
}

/** The advertising column: a plinth, the drum of posters, a frieze, the scalloped dome and its finial. */
function columnGeometry(): BufferGeometry {
  return joined(
    [
      paint(lathe([[0.001, 0], [0.72, 0], [0.72, 0.3], [0.64, 0.38], [0.001, 0.38]], 24), KIOSK_GREEN),
      paint(new CylinderGeometry(0.6, 0.6, 2.35, 32, 1, true).translate(0, 1.56, 0), { hex: 0xffffff, rough: 0.7, kind: KIND.posters }),
      paint(lathe([[0.62, 2.72], [0.7, 2.78], [0.7, 3.0], [0.76, 3.05], [0.001, 3.06]], 24), KIOSK_GREEN),
      paint(lathe([[0.74, 3.05], [0.62, 3.35], [0.4, 3.62], [0.12, 3.78], [0.06, 3.95], [0.11, 4.05], [0.001, 4.15]], 12), KIOSK_GREEN),
    ],
    'column',
  );
}

/** A newspaper kiosk: an octagon of green panels, the counter open toward the pavement, magazines, a dome. */
function kioskGeometry(): BufferGeometry {
  return joined(
    [
      paint(new CylinderGeometry(1.25, 1.25, 2.4, 8, 1).translate(0, 1.2, 0), KIOSK_GREEN),
      paint(new CylinderGeometry(1.27, 1.27, 1.1, 8, 1, true, -0.9, 1.8).translate(0, 1.55, 0), { hex: 0xffffff, rough: 0.6, kind: KIND.magazines }),
      paint(new CylinderGeometry(1.45, 1.45, 0.12, 8).translate(0, 2.46, 0), KIOSK_GREEN),
      paint(lathe([[1.45, 2.52], [1.2, 2.8], [0.7, 3.05], [0.15, 3.2], [0.08, 3.4], [0.001, 3.45]], 8), KIOSK_GREEN),
    ],
    'kiosk',
  );
}

/** A bench: oak slats on two cast-iron frames. */
function benchGeometry(): BufferGeometry {
  const wood: Look = { hex: 0x6b4a2b, rough: 0.7 };
  const parts: BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) parts.push(paint(new BoxGeometry(0.09, 0.035, 1.8).translate(-0.18 + k * 0.11, 0.45, 0), wood));
  for (let k = 0; k < 3; k++) parts.push(paint(new BoxGeometry(0.035, 0.09, 1.8).rotateZ(-0.25).translate(0.26 + k * 0.025, 0.6 + k * 0.11, 0), wood));
  for (const z of [-0.75, 0.75]) parts.push(paint(new BoxGeometry(0.55, 0.45, 0.05).translate(0.02, 0.22, z), IRON), paint(new BoxGeometry(0.06, 0.5, 0.05).rotateZ(-0.25).translate(0.27, 0.7, z), IRON));
  return joined(parts, 'bench');
}

/** A bistro table: a round white marble top on a cast pedestal. */
function tableGeometry(): BufferGeometry {
  return joined(
    [
      paint(new CylinderGeometry(0.3, 0.3, 0.025, 24).translate(0, 0.73, 0), { hex: 0xe8e4dc, rough: 0.25 }),
      paint(lathe([[0.001, 0], [0.22, 0], [0.2, 0.03], [0.04, 0.08], [0.025, 0.7], [0.08, 0.72], [0.001, 0.72]], 12), { hex: 0x2a2a2a, rough: 0.4, metal: 0.6 }),
    ],
    'table',
  );
}

/** A woven bistro chair (front −Z): seat, curved back, rattan-wrapped frame. */
function chairGeometry(): BufferGeometry {
  const rattan: Look = { hex: 0xa07a48, rough: 0.7 };
  const weave: Look = { hex: 0x7c2a2a, rough: 0.8 };
  const parts: BufferGeometry[] = [paint(new CylinderGeometry(0.21, 0.2, 0.04, 16).scale(1, 1, 0.95).translate(0, 0.46, 0), weave)];
  for (const [x, z] of [[-0.17, -0.15], [0.17, -0.15], [-0.15, 0.17], [0.15, 0.17]] as const) parts.push(paint(new CylinderGeometry(0.014, 0.012, 0.46, 4).translate(x, 0.23, z), rattan));
  parts.push(paint(new TorusGeometry(0.2, 0.014, 4, 10, Math.PI).rotateX(-Math.PI / 2).rotateY(Math.PI).translate(0, 0.62, 0.05), rattan));
  parts.push(paint(new CylinderGeometry(0.2, 0.2, 0.16, 16, 1, true, -Math.PI / 2, Math.PI).translate(0, 0.72, 0.05), weave));
  parts.push(paint(new TorusGeometry(0.2, 0.014, 4, 10, Math.PI).rotateX(-Math.PI / 2).rotateY(Math.PI).translate(0, 0.82, 0.05), rattan));
  for (const x of [-0.19, 0.19]) parts.push(paint(new CylinderGeometry(0.013, 0.013, 0.38, 4).translate(x, 0.65, 0.07), rattan));
  return joined(parts, 'chair');
}

// ------------------------------------------------------------------ material

function furnitureMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'street furniture' });
  const tint = attribute('tint', 'vec3');
  const pbr = attribute('pbr', 'vec3');
  const kind = pbr.z;
  const is = (k: number) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const p = uv();
  // Posters: a grid of sheets round the drum, each a block of colour with a picture and a title band.
  const sheet = vec2(floor(p.x.mul(9)), floor(p.y.mul(2)));
  const h = hash12(sheet);
  const inSheet = vec2(fract(p.x.mul(9)), fract(p.y.mul(2)));
  const posterBase = vec3(hash12(sheet.add(1)), hash12(sheet.add(2)), hash12(sheet.add(3))).mul(0.7).add(0.1);
  const picture = step(0.15, inSheet.x).mul(step(inSheet.x, 0.85)).mul(step(0.3, inSheet.y)).mul(step(inSheet.y, 0.85));
  const title = step(0.08, inSheet.y).mul(step(inSheet.y, 0.2)).mul(step(0.5, fract(inSheet.x.mul(14).add(h))));
  const posters = mix(mix(posterBase, posterBase.mul(vec3(0.5, 0.6, 0.8)).add(vec3(h.mul(0.3))), picture), vec3(0.9), title).mul(step(0.02, inSheet.x).mul(0.15).add(0.85));
  // Magazines: rows of small covers.
  const cover = vec2(floor(p.x.mul(30)), floor(p.y.mul(5)));
  const mags = vec3(hash12(cover), hash12(cover.add(7)), hash12(cover.add(9))).mul(0.75).add(0.15);
  let colour = mix(tint, posters, is(KIND.posters));
  colour = mix(colour, mags, is(KIND.magazines));
  m.colorNode = colour;
  m.roughnessNode = pbr.x;
  m.metalnessNode = pbr.y;
  // The lantern's glass glows at its luminance; the warm LED of a converted gas lantern.
  m.emissiveNode = vec3(1, 0.78, 0.52).mul(SCENE.lanternNits).mul(is(KIND.lantern)).mul(float(1));
  return m;
}
