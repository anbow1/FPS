import { abs, attribute, cameraViewMatrix, dot, float, floor, fract, fwidth, max, mix, normalize, normalWorldGeometry, positionWorld, sin, smoothstep, step, vec2, vec3, vec4 } from 'three/tsl';
import { BoxGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial, type Node, Quaternion, Vector3 } from 'three/webgpu';
import { Rng } from '../core/rng.ts';
import { cityNight, lightPreExposure } from './cityLights.ts';

// The city beyond the map, after the browser city in a web-swinging game made
// with AI (its sense of a real city is the skyline: towers of every height
// crowding to the horizon, glass curtain walls taking the sky, a downtown
// that rises where the streets point): a ring of ~200 towers from 260 m out
// to 1.5 km, taller toward one quarter, one instanced draw of boxes. Each is
// a glass curtain wall (a dark tinted pane per bay and storey, its own tilt so
// the panes reflect different pieces of sky, mullions and spandrel bands) or a
// stone tower with punched windows; at night a share of the windows are lit.
// The scene's height haze puts them behind the city in the air. Built at the
// map edge's scale, so it reads above the façades that close the streets.

type F = Node<'float'>;

const STOREY_M = 3.8;
const RING_IN_M = 260;
const RING_OUT_M = 1500;
const CELL_M = 70;
/** Downtown: the direction the tallest towers crowd toward (rad, from +x toward +z), and its spread. */
const DOWNTOWN_RAD = -0.9;
const DOWNTOWN_SPREAD = 0.7;

function hash2(p: Node<'vec2'>, k: number): F {
  return fract(sin(dot(p, vec2(12.9898 + k * 1.31, 78.233 + k * 2.17))).mul(43758.5453));
}

export function buildSkyline(): InstancedMesh {
  const rng = new Rng(9187);
  const towers: { x: number; z: number; w: number; d: number; h: number; style: number; tint: number }[] = [];
  const n = Math.ceil(RING_OUT_M / CELL_M);
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const x = (i + rng.range(0.15, 0.85)) * CELL_M;
      const z = (j + rng.range(0.15, 0.85)) * CELL_M;
      const r = Math.hypot(x, z);
      if (r < RING_IN_M || r > RING_OUT_M) continue;
      const a = Math.atan2(z, x);
      let da = Math.abs(a - DOWNTOWN_RAD);
      da = Math.min(da, Math.PI * 2 - da);
      const downtown = Math.exp(-((da / DOWNTOWN_SPREAD) ** 2)) * (1 - Math.min(1, Math.abs(r - 750) / 700));
      if (rng.next() > 0.35 + downtown * 0.6) continue;
      const tall = downtown * rng.range(0.6, 1);
      const h = Math.round((rng.range(22, 60) + tall * rng.range(80, 210)) / STOREY_M) * STOREY_M;
      const w = rng.range(22, 42);
      const d = rng.range(22, 42);
      // Glass for most of the tall downtown, stone for most of the rest.
      const style = rng.next() < 0.25 + downtown * 0.6 ? 0 : 1;
      towers.push({ x, z, w, d, h, style, tint: rng.next() });
    }
  }
  const geo = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const style = new InstancedBufferAttribute(new Float32Array(towers.length * 2), 2);
  geo.setAttribute('towerStyle', style);
  const mat = new MeshStandardNodeMaterial({ name: 'skyline', metalness: 0 });
  const st = attribute('towerStyle', 'vec2');
  const isGlass = float(1).sub(step(0.5, st.x));
  const tint = st.y;
  // Façade coordinates in world metres: along the face (x on ±z faces, z on ±x faces) and up.
  const n0 = normalWorldGeometry;
  const side = float(1).sub(step(0.5, abs(n0.y)));
  const along = mix(positionWorld.z, positionWorld.x, step(abs(n0.x), abs(n0.z)));
  const bayM = mix(float(3.2), float(1.6), isGlass);
  const cellUV = vec2(along.div(bayM), positionWorld.y.div(STOREY_M));
  const cell = floor(cellUV);
  const f = fract(cellUV);
  const faceKey = vec2(dot(n0, vec3(17.1, 0, 31.7)), tint.mul(97));
  const paneHash = hash2(cell.add(faceKey), 1);
  // Glass: a pane over most of the bay, mullions at its edges, a spandrel band at the floor line.
  const mullion = smoothstep(0.04, 0.0, f.x).add(smoothstep(0.96, 1.0, f.x));
  const spandrel = smoothstep(0.24, 0.2, f.y);
  const glassPane = float(1).sub(max(mullion, spandrel)).clamp(0, 1);
  // Stone: a punched window, 55 % of the bay, 55 % of the storey.
  const stoneWin = smoothstep(0.24, 0.22, abs(f.x.sub(0.5))).mul(smoothstep(0.3, 0.28, abs(f.y.sub(0.55))));
  // Past a few pixels per window the grid is averaged (its pane share), or it shimmers and, lit, turns to
  // static: `blur` is 0 while a cell spans ≥ 3 px and 1 once it is under one.
  const blur = smoothstep(0.33, 1.0, max(fwidth(cellUV.x), fwidth(cellUV.y)));
  const paneShare = mix(float(0.3), float(0.62), isGlass);
  const pane = mix(mix(stoneWin, glassPane, isGlass), paneShare, blur).mul(side);
  const glassTint = mix(vec3(0.03, 0.05, 0.06), vec3(0.05, 0.06, 0.05), tint);
  const frame = mix(vec3(0.35, 0.37, 0.38), vec3(0.18, 0.19, 0.2), tint);
  const stone = mix(vec3(0.42, 0.38, 0.32), vec3(0.3, 0.27, 0.25), tint).mul(paneHash.mul(0.04).add(0.98));
  const wall = mix(stone, frame, isGlass);
  const roof = vec3(0.16, 0.16, 0.15);
  mat.colorNode = mix(roof, mix(wall, glassTint.mul(paneHash.mul(0.3).add(0.85)), pane), side);
  // Glass is a mirror with a little variance per pane; the wall is matte.
  mat.roughnessNode = mix(float(0.85), mix(float(0.06), float(0.16), paneHash), pane);
  // Each pane set a fraction of a degree off, so a curtain wall reflects many skies, not one grey sheet.
  const tilt = vec3(hash2(cell.add(faceKey), 2).sub(0.5), hash2(cell.add(faceKey), 3).sub(0.5).mul(0.5), hash2(cell.add(faceKey), 4).sub(0.5)).mul(0.08).mul(pane);
  mat.normalNode = normalize(cameraViewMatrix.mul(vec4(n0.add(tilt), 0)).xyz);
  // Night: a share of the windows lit, warm or cool office light seen through the glass (~30 cd/m²
  // pre-exposed, a room's light seen from a kilometre, a little under the near windows' 35), averaged
  // with the grid once a window is under a pixel.
  const share = mix(float(0.32), float(0.45), isGlass);
  const lit = mix(step(paneHash, share), share, blur).mul(pane);
  const warm = mix(vec3(1, 0.78, 0.52), vec3(0.85, 0.92, 1), mix(step(0.6, hash2(cell.add(faceKey), 5)), float(0.4), blur));
  mat.emissiveNode = warm.mul(lit).mul(cityNight).mul(lightPreExposure).mul(30);

  const mesh = new InstancedMesh(geo, mat, towers.length);
  mesh.name = 'skyline';
  // Far beyond the shadow cascades: they would cost a draw per cascade for nothing.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  towers.forEach((t, k) => {
    m.compose(p.set(t.x, -1, t.z), q, s.set(t.w, t.h + 1, t.d));
    mesh.setMatrixAt(k, m);
    (style.array as Float32Array)[k * 2] = t.style;
    (style.array as Float32Array)[k * 2 + 1] = t.tint;
  });
  mesh.instanceMatrix.needsUpdate = true;
  style.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}
