import { attribute, cameraPosition, cameraViewMatrix, dot, float, floor, fract, max, min, mix, normalWorldGeometry, positionWorld, select, step, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { type Node, Vector4 } from 'three/webgpu';

// Window reveals: in a real wall the frame and glass sit some 12 cm back from
// the face, so every window is a shallow box. Seen at an angle, one side of
// that box (the reveal) shows beside the frame and the frame slides behind the
// wall's edge; in sun, the head and one jamb throw a crisp shadow across the
// frame and the glass. Without it a façade of windows reads as windows printed
// on a flat wall, however good the glass (see the city survey shots).
//
// Done per pixel on the façade tile (one bay × one storey, patterns.ts
// `facade`): the view ray through a point of the opening is followed to the
// glass plane; where it lands outside the opening it has struck the reveal,
// which is drawn as the wall's material turned to face across the opening.
// Upper storeys only: the ground storey is shopfronts with their own glazing.

/** The window opening on the tile (patterns.ts `facade`: the frame's outer edge). */
const U0 = 0.28;
const U1 = 0.72;
const V0 = 0.3;
const V1 = 0.8;
/** Frame and glass depth behind the wall face (m). */
const DEPTH_M = 0.13;

/** Direction toward the sun (xyz) and the share of the light it brings (w: 0 at night or under cloud). */
export const revealSun = uniform(new Vector4(0, 1, 0, 0));

function inBox(p: Node<'vec2'>): Node<'float'> {
  return step(U0, p.x).mul(step(p.x, U1)).mul(step(V0, p.y)).mul(step(p.y, V1));
}

export interface WindowReveal {
  /** Tile UV to sample the façade textures at: shifted onto the recessed frame and glass inside openings. */
  uv: Node<'vec2'>;
  /** Tile UV of wall texture to paint the reveal with. */
  wallUv: Node<'vec2'>;
  /** 1 where the view ray strikes the reveal instead of the frame or glass. */
  reveal: Node<'float'>;
  /** The reveal's normal, in view space. */
  revealNormal: Node<'vec3'>;
  /** Albedo factor on the recessed frame and glass: the head's and jamb's sun shadow, and the slot's own shade. */
  shade: Node<'float'>;
}

/** Needs the façade's `tileSize` attribute (bay, storey in m), like roomInteriors.ts. */
export function windowReveal(): WindowReveal {
  const t = uv();
  const cell = floor(t);
  const f = fract(t);
  const size = attribute('tileSize', 'vec2');
  const n = normalWorldGeometry;
  // The face's frame: right = up × normal (worldMesh.ts).
  const right = vec3(n.z, 0, n.x.negate());
  const upper = step(0.5, cell.y);
  const opening = inBox(f).mul(upper);

  // The view ray, per metre of depth into the wall, in tile units across and up.
  const view = positionWorld.sub(cameraPosition).normalize();
  const cosIn = max(dot(view, n).negate(), 0.08);
  const perDepth = vec2(dot(view, right), view.y).div(cosIn).div(size);
  const atGlass = f.add(perDepth.mul(DEPTH_M));
  const reveal = opening.mul(float(1).sub(inBox(atGlass)));

  // Which side the ray struck first: the depth at which it crosses the opening's x and y bounds.
  const px = select(perDepth.x.greaterThan(0), float(U1).sub(f.x), float(U0).sub(f.x)).div(select(perDepth.x.abs().lessThan(1e-5), float(1e-5), perDepth.x));
  const py = select(perDepth.y.greaterThan(0), float(V1).sub(f.y), float(V0).sub(f.y)).div(select(perDepth.y.abs().lessThan(1e-5), float(1e-5), perDepth.y));
  const sideHit = step(px.abs(), py.abs());
  const depthHit = min(px.abs(), py.abs()).div(DEPTH_M).clamp(0, 1);
  // Jambs face across the opening, the head faces down, the sill up.
  const jambN = right.mul(select(perDepth.x.greaterThan(0), float(-1), float(1)));
  const headN = vec3(0, select(perDepth.y.greaterThan(0), float(-1), float(1)), 0);
  const nWorld = mix(headN, jambN, sideHit);
  const revealNormal = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
  // The reveal is the wall's own material: a strip of the pier beside the window or the wall above it,
  // walked along by how deep the ray went, so its bricks or render run into the opening.
  const wallUv = cell.add(mix(vec2(f.x, float(0.86).add(depthHit.mul(0.08))), vec2(float(0.2).sub(depthHit.mul(0.08)), f.y), sideHit));

  // Sun shadow on the frame and glass: follow the sun ray back from the glass plane to the wall face; if it
  // leaves through solid wall, the head or a jamb shades this point.
  const s = revealSun.xyz;
  const sIn = dot(s, n);
  const toFace = vec2(dot(s, right), s.y).div(max(sIn, 0.05)).div(size).mul(DEPTH_M);
  const lit = inBox(atGlass.add(toFace));
  const shadow = float(1).sub(lit).mul(step(0.02, sIn)).mul(revealSun.w);
  // The slot itself sees less sky; deeper on the head side.
  const shade = mix(float(1), float(1).sub(shadow.mul(0.72)).mul(0.9), opening.mul(float(1).sub(reveal)));

  return { uv: mix(t, cell.add(atGlass), opening.mul(float(1).sub(reveal))), wallUv, reveal, revealNormal, shade };
}
