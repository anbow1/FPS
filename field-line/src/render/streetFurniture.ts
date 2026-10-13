import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vec3 } from 'three/tsl';
import { BoxGeometry, type BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import type { MapBox, MapData } from '../maps/types.ts';
import { lightPreExposure } from './cityLights.ts';
import type { MaterialLibrary } from './materials.ts';
import { rand, tube } from './meshkit.ts';

// The street furniture a city has overhead and at its corners, which the
// references all show and an empty sky between the façades lacks: span wires
// strung across the street from wall to wall, sagging, some carrying a
// pendant luminaire over the middle of the road; and traffic signals on every
// corner of every junction, facing the traffic coming in, one lamp lit.
// Render-only (bullets and players pass), built once from the map's roads and
// façade boxes.

const WIRE_R = 0.011;
const SPAN_STEP_M = 26;
/** Signal LED luminance (cd/m²): bright enough to read at noon, as a real one is. */
const SIGNAL_NITS = 9000;

function nonIndexed(g: BufferGeometry): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(n.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'uv') n.deleteAttribute(key);
  return n;
}

/** The façade face nearest the road on one side at `along`: its offset across, and the building's height. */
function faceAt(boxes: readonly MapBox[], alongZ: boolean, c: number, along: number, dir: number): { at: number; heightM: number } | null {
  let best: { at: number; heightM: number } | null = null;
  for (const b of boxes) {
    if (!b.facade || (b.yawRad ?? 0) !== 0) continue;
    const minA = (alongZ ? b.center.z - b.size.z / 2 : b.center.x - b.size.x / 2) + 1.5;
    const maxA = (alongZ ? b.center.z + b.size.z / 2 : b.center.x + b.size.x / 2) - 1.5;
    if (along < minA || along > maxA) continue;
    const face = alongZ ? b.center.x - (dir * b.size.x) / 2 : b.center.z - (dir * b.size.z) / 2;
    const off = (face - c) * dir;
    if (off < 7 || off > 14) continue;
    if (!best || off < best.at) best = { at: off, heightM: b.size.y };
  }
  return best;
}

export function buildStreetFurniture(map: MapData, lib: MaterialLibrary): Group | null {
  if (map.roads.length === 0) return null;
  const group = new Group();
  group.name = 'streetFurniture';
  const wires: BufferGeometry[] = [];
  const fittings: BufferGeometry[] = [];
  const lenses: BufferGeometry[] = [];
  const kerb = 0.15;
  let k = 0;
  for (const road of map.roads) {
    const alongZ = road.a.x === road.b.x;
    const c = alongZ ? road.a.x : road.a.z;
    const from = alongZ ? road.a.z : road.a.x;
    const to = alongZ ? road.b.z : road.b.x;
    for (let a = from + 8; a < to - 8; a += SPAN_STEP_M) {
      k++;
      const along = a + rand(k, 1) * 10;
      const l = faceAt(map.boxes, alongZ, c, along, -1);
      const r = faceAt(map.boxes, alongZ, c, along, 1);
      if (!l || !r) continue;
      const y0 = Math.min(l.heightM - 1.5, 7.2 + rand(k, 2) * 1.6);
      const y1 = Math.min(r.heightM - 1.5, 7.2 + rand(k, 3) * 1.6);
      const P = (across: number, y: number): Vector3 => (alongZ ? new Vector3(c + across, y, along) : new Vector3(along, y, c + across));
      const pA = P(-l.at + 0.05, y0);
      const pB = P(r.at - 0.05, y1);
      const pendant = rand(k, 4) < 0.5;
      // Catenary (a parabola is within a millimetre at this sag); a pendant pulls the middle down further.
      const sag = pendant ? 0.65 : 0.35;
      const pts: Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const dip = pendant ? 4 * sag * Math.min(t, 1 - t) * (0.6 + 0.4 * (1 - Math.abs(t - 0.5) * 2)) : 4 * sag * t * (1 - t);
        pts.push(new Vector3().lerpVectors(pA, pB, t).setY(pA.y + (pB.y - pA.y) * t - dip));
      }
      wires.push(nonIndexed(tube(pts, pts.map(() => WIRE_R), 4, 1)));
      // Wall plates where the wire is anchored.
      for (const [p, s] of [
        [pA, 1],
        [pB, -1],
      ] as const) {
        const plate = new BoxGeometry(alongZ ? 0.04 : 0.16, 0.16, alongZ ? 0.16 : 0.04).translate(p.x - (alongZ ? s * 0.02 : 0), p.y, p.z - (alongZ ? 0 : s * 0.02));
        fittings.push(nonIndexed(plate));
      }
      if (pendant) {
        const mid = pts[6] as Vector3;
        // A short drop rod, a shallow dished shade and a diffuser under it.
        fittings.push(nonIndexed(new CylinderGeometry(0.012, 0.012, 0.45, 6).translate(mid.x, mid.y - 0.225, mid.z)));
        fittings.push(nonIndexed(new CylinderGeometry(0.06, 0.34, 0.16, 16, 1, true).translate(mid.x, mid.y - 0.5, mid.z)));
        fittings.push(nonIndexed(new CylinderGeometry(0.06, 0.06, 0.04, 10).translate(mid.x, mid.y - 0.43, mid.z)));
        lenses.push(nonIndexed(new SphereGeometry(1, 14, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(0.3, 0.09, 0.3).translate(mid.x, mid.y - 0.58, mid.z)));
      }
    }
  }

  // Traffic signals: at every junction of the grid, one on the right-hand kerb of each approach.
  const housings: BufferGeometry[] = [];
  const red: BufferGeometry[] = [];
  const green: BufferGeometry[] = [];
  const zRoads = map.roads.filter((r) => r.a.x === r.b.x);
  const xRoads = map.roads.filter((r) => r.a.z === r.b.z);
  for (const zr of zRoads) {
    for (const xr of xRoads) {
      const cx = zr.a.x;
      const cz = xr.a.z;
      const half = zr.widthM / 2;
      // Approaches: (direction the traffic comes from, unit vector), right-hand kerb corner for each.
      const approaches: [number, number, boolean][] = [
        [0, 1, true],
        [0, -1, true],
        [1, 0, false],
        [-1, 0, false],
      ];
      for (const [dx, dz, nsGreen] of approaches) {
        // Traffic from +Z heads −Z; its right-hand kerb is at +X, the signal before the junction (dx, dz side).
        const rightX = dz !== 0 ? dz * 1 : 0;
        const rightZ = dx !== 0 ? -dx * 1 : 0;
        const px = cx + dx * (half + 0.8) + rightX * (half + 0.6);
        const pz = cz + dz * (half + 0.8) + rightZ * (half + 0.6);
        // The head faces the oncoming traffic: toward (dx, dz).
        const yaw = Math.atan2(dx, dz);
        const pole = new CylinderGeometry(0.06, 0.07, 3.3, 10).translate(0, kerb + 1.65, 0);
        const head = new BoxGeometry(0.3, 0.92, 0.22).translate(0, kerb + 2.85, 0.1);
        const back = new BoxGeometry(0.5, 1.1, 0.02).translate(0, kerb + 2.85, -0.02);
        const parts: BufferGeometry[] = [pole, head, back];
        const lamps: BufferGeometry[] = [];
        for (let i = 0; i < 3; i++) {
          const y = kerb + 3.13 - i * 0.28;
          // Visor over each lamp: a half tube.
          parts.push(new CylinderGeometry(0.115, 0.115, 0.16, 12, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, y + 0.0, 0.29));
          lamps.push(new CylinderGeometry(0.1, 0.1, 0.02, 16).rotateX(Math.PI / 2).translate(0, y, 0.215));
        }
        const place = (g: BufferGeometry): BufferGeometry => nonIndexed(g.rotateY(yaw).translate(px, 0, pz));
        for (const p of parts) housings.push(place(p));
        // Top red, bottom green: the Z-road traffic has green, the X-road red (a fixed phase).
        lamps.forEach((g, i) => {
          if ((nsGreen && i === 2) || (!nsGreen && i === 0)) (nsGreen ? green : red).push(place(g));
          else housings.push(place(g));
        });
      }
    }
  }

  const join = (list: BufferGeometry[]): BufferGeometry | null => (list.length > 0 ? mergeGeometries(list, false) : null);
  const add = (g: BufferGeometry | null, material: MeshStandardNodeMaterial | ReturnType<MaterialLibrary['get']>, name: string, shadow: boolean): void => {
    if (!g) return;
    const m = new Mesh(g, material);
    m.name = name;
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  };
  const metal = lib.look('metalDark').material;
  add(join(wires), metal, 'spanWires', true);
  add(join(fittings), metal, 'wireFittings', true);
  add(join(lenses), lib.get('lampLens'), 'pendantLenses', false);
  add(join(housings), metal, 'signals', true);
  add(join(red), signalLamp(1, 0.08, 0.04), 'signalRed', false);
  add(join(green), signalLamp(0.1, 1, 0.55), 'signalGreen', false);
  return group;
}

/** A lit signal lens: its LED luminance, pre-exposed, over a dark glass. */
function signalLamp(r: number, g: number, b: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.2, metalness: 0 });
  m.emissiveNode = vec3(r, g, b).mul(SIGNAL_NITS).mul(lightPreExposure);
  return m;
}
