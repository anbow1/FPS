import { cross, dot, faceDirection, float, materialOpacity, floor, fract, length, max, mix, normalize, normalLocal, positionLocal, sin, smoothstep, transformNormalToView, uniform, vec2, vec3 } from 'three/tsl';
import { type MeshPhysicalNodeMaterial, type Node, Vector3 } from 'three/webgpu';

// Rain on the canopy, drawn in the glass's own shader. In the helicopter's
// frame the air flows aft at the airspeed, and gravity pulls down: on each pane
// the drops run along that flow projected onto the glass — down the panes in a
// hover, raked back and stretched into streaks in forward flight. Each drop is
// a small lens: it bends the normal (so it catches the sky and the sun as a
// highlight and refracts what is behind) and thickens the glass a little where
// it sits, which is what makes a wet canopy readable from the seat.

/** 0 … 1: rain on the glass. */
export const canopyRain = uniform(0);
/** Unit direction the water runs over the glass, in the model's frame (−Z forward, +Y up). */
export const canopyFlow = uniform(new Vector3(0, -1, 0));
/** How fast the drops run (m/s on the glass). */
export const canopyFlowSpeed = uniform(0.1);
/** Seconds, for the drops' motion. */
export const canopyTime = uniform(0);

const CELL_M = 0.014;

function hash(c: Node<'vec2'>, k: number): Node<'float'> {
  return fract(sin(dot(c, vec2(12.9898 + k * 1.37, 78.233 + k * 2.71)).add(k * 0.618)).mul(43758.5453));
}

/** Adds the drops to a canopy glass material: normal, clearcoat normal and opacity. */
export function addCanopyRain(m: MeshPhysicalNodeMaterial): void {
  const n = normalize(normalLocal);
  // A frame on the pane: t1 along the flow as it lies on this pane, t2 across it.
  const along = canopyFlow.sub(n.mul(dot(canopyFlow, n)));
  const t1 = normalize(along.add(vec3(1e-4, 0, 0)));
  const t2 = normalize(cross(n, t1));
  const u = dot(positionLocal, t1);
  const v = dot(positionLocal, t2);
  // Columns across the flow; each column's drops run at their own pace (some cling and barely move).
  const column = floor(v.div(CELL_M));
  const pace = canopyFlowSpeed.mul(mix(float(0.05), float(1), hash(vec2(column, 3), 1)));
  const uu = u.sub(canopyTime.mul(pace));
  const cell = vec2(floor(uu.div(CELL_M)), column);
  // None on the panes facing down into the cockpit tub (below the sill, never rained on).
  const present = smoothstep(0.55, 0.6, hash(cell, 2)).mul(canopyRain).mul(smoothstep(-0.25, 0.05, n.y));
  const local = vec2(fract(uu.div(CELL_M)), fract(v.div(CELL_M))).sub(vec2(hash(cell, 3), hash(cell, 4)).mul(0.4).add(0.3));
  // Fast flow draws a drop out into a streak along the flow.
  const stretch = float(1).add(canopyFlowSpeed.mul(2.2));
  const radius = mix(float(0.12), float(0.32), hash(cell, 5));
  const q = vec2(local.x.div(stretch), local.y);
  const d = length(q).div(radius);
  const inDrop = smoothstep(1, 0.75, d).mul(present);
  // Lens normal: tilted out from the drop's centre, steepest at its rim.
  const slope = q.div(max(radius, 1e-3)).mul(inDrop).mul(0.9);
  const nDrop = normalize(n.add(t1.mul(slope.x)).add(t2.mul(slope.y)));
  // Seen from inside the double-sided glass, the back face's normal points into the cabin.
  const viewN = transformNormalToView(nDrop).mul(faceDirection);
  m.normalNode = viewN;
  m.clearcoatNormalNode = viewN;
  // On top of the material's own opacity, which the seat view lowers (heliView.ts).
  m.opacityNode = materialOpacity.add(inDrop.mul(0.35));
}
