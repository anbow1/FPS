import { dot, exp, float, uniform } from 'three/tsl';
import { type Node, type Quaternion, Vector2, Vector3 } from 'three/webgpu';

// Contact occlusion under the helicopter: the ground under a parked or low
// machine sees much less of the sky (fuselage, stub wings and the disc are
// over it), so it darkens in the ambient light even where the sun reaches it,
// and the sun's own shadow there goes deep instead of flat. That dark core
// under the craft is half of what grounds the machines in the STRIX scene.
// One soft ellipse along the fuselage, fed to the terrain's and the grass's
// `aoNode` (sky and probe light only; the sun keeps its shadow map), fading
// out as the helicopter climbs.

/** Footprint half-lengths (m): along the fuselage and across it (the stub wings). */
const HALF_ALONG_M = 4.8;
const HALF_ACROSS_M = 2.1;
/** Height of the centre of gravity over the ground when parked (m), and the climb over which it fades. */
const PARKED_M = 1.7;
const FADE_M = 7;
const MAX_STRENGTH = 0.7;

const centre = uniform(new Vector2());
const forward = uniform(new Vector2(0, -1));
const strength = uniform(0);

/** 1 in the open, down to 1 − 0.7 under a parked helicopter. */
export function contactOcclusion(xz: Node<'vec2'>): Node<'float'> {
  const d = xz.sub(centre);
  const along = dot(d, forward).div(HALF_ALONG_M);
  const across = d.x.mul(forward.y).sub(d.y.mul(forward.x)).div(HALF_ACROSS_M);
  return float(1).sub(exp(along.mul(along).add(across.mul(across)).negate()).mul(strength));
}

const fwd = new Vector3();

/** Follow the rendered helicopter: its position, attitude and the ground height under it. */
export function updateContact(pos: Vector3, rot: Quaternion, groundY: number): void {
  centre.value.set(pos.x, pos.z);
  fwd.set(0, 0, -1).applyQuaternion(rot);
  const len = Math.hypot(fwd.x, fwd.z);
  if (len > 1e-3) forward.value.set(fwd.x / len, fwd.z / len);
  const k = Math.min(1, Math.max(0, 1 - (pos.y - groundY - PARKED_M) / FADE_M));
  strength.value = MAX_STRENGTH * k * k;
}
