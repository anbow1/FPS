import { cameraPosition, cross, float, length, max, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl';
import { MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';

// A reflex (red dot) sight's window, after Field Line's (its render/optics.ts):
// the dot is collimated — at infinity, on the optic's axis — so it is drawn
// where the eye's ray through the glass runs parallel to that axis, wherever
// the eye is behind the window, not painted at the window's centre. Aimed,
// the dot lies on the target; off axis it slides across the glass as a real
// one does, and leaves it when the eye leaves the window.

/** A 2 MOA dot. */
const DOT_RADIUS_RAD = 0.00058;

export class RedDot {
  /** The optic's axis in world space, each frame. */
  readonly axis = uniform(new Vector3(0, 0, -1));
  // Pre-exposed HDR; kept low enough that the tone curve does not bleach the red toward pink.
  readonly brightness = uniform(0.35);
  /** Angle one screen pixel covers; the dot is never drawn smaller than ~1.3 px across. */
  readonly pixelAngleRad = uniform(0.001);
  readonly material = new MeshBasicNodeMaterial({ name: 'red dot', transparent: true, depthWrite: false });

  constructor() {
    const viewDir = positionWorld.sub(cameraPosition).normalize();
    // sin(angle) via the cross product: acos loses the angle to float rounding near 0.
    const sinAngle = length(cross(viewDir, this.axis));
    const facing = viewDir.dot(this.axis).greaterThan(0);
    const r = max(float(DOT_RADIUS_RAD), this.pixelAngleRad.mul(0.65));
    const dot = float(1).sub(smoothstep(r.mul(0.6), r, sinAngle)).mul(facing.select(float(1), float(0)));
    // The coated glass: a faint blue-green tint, the dot red over it.
    this.material.colorNode = vec3(1.0, 0.06, 0.03).mul(this.brightness).mul(dot).add(vec3(0.02, 0.03, 0.05));
    this.material.opacityNode = dot.mul(0.9).add(0.08);
  }
}
