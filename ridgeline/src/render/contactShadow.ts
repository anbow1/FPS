import { dot, exp, float, smoothstep, uniform } from 'three/tsl';
import { type Node, type Quaternion, Vector2, Vector3, Vector4 } from 'three/webgpu';

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

// The ground vehicles get the same, and a sun shadow of their own: through the gunner's sight they are
// kilometres away, far outside the sun's shadow map, and a vehicle with sunlit ground right under its hull
// floats. A soft footprint, moved off along the sun's direction by about half the vehicle's height, stands
// in for the cast shadow (inside the shadow map's range it only deepens the real one under the hull).

/** Vehicles with a contact patch: the nearest to the camera. */
const VEHICLE_SLOTS = 10;
/** Height whose shadow the footprint is moved by (m), and the most it moves (low sun). */
const SHADOW_LIFT_M = 1.2;
const SHADOW_MAX_OFFSET_M = 6;
/** Per slot: centre x, z and the forward direction x, z; half length, half width (m) and strength. */
const vPose = Array.from({ length: VEHICLE_SLOTS }, () => uniform(new Vector4(1e6, 1e6, 0, -1)));
const vSize = Array.from({ length: VEHICLE_SLOTS }, () => uniform(new Vector3(1, 1, 0)));
const sunOffset = uniform(new Vector2());

/** r² of `xz` in a slot's footprint ellipse (1 on its edge), with the centre moved by `shift`. */
function footprint(xz: Node<'vec2'>, i: number, shift: Node<'vec2'> | null): Node<'float'> {
  const pose = vPose[i] as (typeof vPose)[number];
  const size = vSize[i] as (typeof vSize)[number];
  const c = shift ? pose.xy.add(shift) : pose.xy;
  const d = xz.sub(c);
  const along = dot(d, pose.zw).div(size.x);
  const across = d.x.mul(pose.w).sub(d.y.mul(pose.z)).div(size.y);
  return along.mul(along).add(across.mul(across));
}

/** 1 in the open, down to 1 − 0.7 under a parked helicopter, and lower under the ground vehicles. */
export function contactOcclusion(xz: Node<'vec2'>): Node<'float'> {
  const d = xz.sub(centre);
  const along = dot(d, forward).div(HALF_ALONG_M);
  const across = d.x.mul(forward.y).sub(d.y.mul(forward.x)).div(HALF_ACROSS_M);
  let occ: Node<'float'> = float(1).sub(exp(along.mul(along).add(across.mul(across)).negate()).mul(strength));
  for (let i = 0; i < VEHICLE_SLOTS; i++) occ = occ.mul(float(1).sub(exp(footprint(xz, i, null).negate()).mul((vSize[i] as (typeof vSize)[number]).z)));
  return occ;
}

/** Direct-sun factor under the ground vehicles: 0 in the stand-in for their cast shadow, 1 elsewhere. */
export function vehicleSunShadow(xz: Node<'vec2'>): Node<'float'> {
  let lit: Node<'float'> = float(1);
  for (let i = 0; i < VEHICLE_SLOTS; i++) {
    const umbra = smoothstep(1.3, 0.55, footprint(xz, i, sunOffset)).mul(float((vSize[i] as (typeof vSize)[number]).z).greaterThan(0).select(float(0.85), float(0)));
    lit = lit.mul(float(1).sub(umbra));
  }
  return lit;
}

export interface VehicleContact {
  x: number;
  z: number;
  headingRad: number;
  halfAlongM: number;
  halfAcrossM: number;
}

/** The vehicles nearest the camera get the slots; `sunDir` points at the sun. */
export function setVehicleContacts(list: readonly VehicleContact[], camera: Vector3, sunDir: Vector3): void {
  const near = [...list].sort((a, b) => Math.hypot(a.x - camera.x, a.z - camera.z) - Math.hypot(b.x - camera.x, b.z - camera.z));
  for (let i = 0; i < VEHICLE_SLOTS; i++) {
    const v = near[i];
    const pose = (vPose[i] as (typeof vPose)[number]).value;
    const size = (vSize[i] as (typeof vSize)[number]).value;
    if (!v) {
      pose.set(1e6, 1e6, 0, -1);
      size.set(1, 1, 0);
      continue;
    }
    pose.set(v.x, v.z, -Math.sin(v.headingRad), -Math.cos(v.headingRad));
    size.set(v.halfAlongM, v.halfAcrossM, 0.75);
  }
  const k = SHADOW_LIFT_M / Math.max(sunDir.y, 0.05);
  const ox = -sunDir.x * k;
  const oz = -sunDir.z * k;
  const len = Math.hypot(ox, oz);
  const clamp = len > SHADOW_MAX_OFFSET_M ? SHADOW_MAX_OFFSET_M / len : 1;
  sunOffset.value.set(ox * clamp, oz * clamp);
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
