import { convertToTexture, dot, float, fract, length, max, min, saturation, screenCoordinate, screenSize, sin, smoothstep, step, time, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';

// A body-worn camera's picture, after the bodycam shooter "Block 17" (an
// AI-made browser game) and the real cameras it imitates: a very wide lens
// with strong barrel distortion (straight walls bow, the middle is magnified
// and the edges crowded), the lens's colour fringes growing toward the rim,
// an oval shroud where the housing cuts the image circle, and sensor noise
// that rises in the dark as the camera's gain does. The scene renders wider
// than the standard view (stage.ts) so the magnified middle still shows as
// much as before.
//
// It works on the graded HDR image before the output transform: the grain is
// multiplicative (photon noise scales with the signal) plus a floor that the
// exposure scales back (read noise is fixed in the sensor's own units).

/** Magnification at the centre (< 1 samples a smaller area: a zoom), and the barrel term. */
const SCALE = 0.8;
const BARREL = 0.34;
/** Lateral colour at the rim (fraction of the radius, red out, blue in). */
const FRINGE = 0.007;
/** The housing's opening, as an ellipse in height units (x is widened by the aspect). */
const SHROUD = vec2(0.98, 0.6);

type F = Node<'float'>;
type V2 = Node<'vec2'>;

/** `exposureInv`: one over the output exposure, so the grain floor is constant on the sensor. */
export function bodycamLens(input: Node<'vec4'>, exposureInv: UniformNode<'float', number>): Node<'vec4'> {
  const tex = convertToTexture(input);
  const aspect = screenSize.x.div(screenSize.y);
  const toQ = vec2(aspect, 1);
  const q = uv().sub(0.5).mul(toQ);
  const r2 = dot(q, q);
  const warp = float(SCALE).mul(float(1).add(r2.mul(BARREL)));
  const at = (k: F): V2 => q.mul(warp.mul(k)).div(toQ).add(0.5);
  const fringe = r2.mul(FRINGE);
  const centre = at(float(1));
  const col = vec3(tex.sample(at(float(1).add(fringe))).r, tex.sample(centre).g, tex.sample(at(float(1).sub(fringe))).b).toVar();
  // Past the edge of the rendered frame (the distorted corners) the image circle has nothing: black.
  const inFrame = step(0, min(centre.x, centre.y)).mul(step(max(centre.x, centre.y), 1));
  const shroud = smoothstep(1.06, 0.8, length(q.div(SHROUD)));
  // Sensor noise, a new pattern every frame. A 2-D hash: TSL's `hash` takes a float, and fed a pixel
  // coordinate it varied along x alone, which drew the grain as vertical stripes.
  const px = screenCoordinate.xy.add(fract(time.mul(7.13)).mul(vec2(431, 197)));
  const n = fract(sin(dot(px, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
  const grainy = col.mul(n.mul(0.16).add(1)).add(n.mul(0.004).mul(exposureInv));
  // A small sensor's colour: a little flatter than the eye's.
  const graded = saturation(max(grainy, vec3(0)), 0.86);
  return vec4(graded.mul(shroud).mul(inFrame), 1);
}
