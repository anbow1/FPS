import { abs, atan, exp, float, fract, length, max, mix, normalize, pow, rtt, screenSize, sin, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { type Node, Vector2, Vector3 } from 'three/webgpu';

// The sun seen through a camera's glass: a diffraction starburst round it, the
// ghosts the lens's surfaces reflect back along the line through the centre,
// and one wide ring ghost. All of it is light the sun puts into the lens, so it
// is drawn only for the part of the sun's disc actually visible in the frame —
// measured from the frame itself, not guessed: a canopy bow, a cloud or a
// ridge over the sun takes the flare with it, a thin cloud dims it.

/** Sunlight at the lens, colour × illuminance in the scene's pre-exposed units, without clouds. */
export const flareSun = uniform(new Vector3());
/** The sun's centre on screen, uv with y down (as the post passes sample). */
export const flareSunUv = uniform(new Vector2(0.5, 0.5));
/** 1 while the sun is in front of the camera and inside the frame; fades out over the edge. */
export const flareOnScreen = uniform(0);
/** Luminance the scene pass gives the unoccluded disc (the sky's disc after its clamp and transmittance). */
export const flareDiscLum = uniform(1);
/** The disc's radius in screen heights. */
export const flareDiscRadius = uniform(0.004);
/** Width over height of the frame; a uniform because inside the 1 × 1 visibility target the screen size is that target's. */
export const flareAspect = uniform(16 / 9);

/** Aperture blades: an even count makes as many spikes, an odd one twice as many. */
const BLADES = 6;

interface Ghost {
  /** Position along the axis through the centre, as a multiple of the sun's offset (negative: across the centre). */
  t: number;
  /** Radius in screen heights. */
  r: number;
  colour: [number, number, number];
}

// Ghosts of a wide-angle zoom: small and bright near the sun, wide and faint across the centre;
// tinted by each surface pair's coating.
const GHOSTS: readonly Ghost[] = [
  { t: 0.62, r: 0.018, colour: [1, 0.55, 0.2] },
  { t: 0.3, r: 0.035, colour: [0.35, 1, 0.55] },
  { t: -0.25, r: 0.025, colour: [1, 0.7, 0.3] },
  { t: -0.55, r: 0.06, colour: [0.45, 0.6, 1] },
  { t: -0.9, r: 0.1, colour: [0.9, 0.45, 1] },
  { t: -1.35, r: 0.15, colour: [0.4, 1, 0.8] },
];

function hash(x: Node<'float'>): Node<'float'> {
  return fract(sin(x.mul(12.9898)).mul(43758.5453));
}

/** Distance to a regular hexagon's edge, in units of its inradius (the aperture's shape in a ghost). */
function hexagon(q: Node<'vec2'>): Node<'float'> {
  const a = abs(q);
  return max(a.x.mul(0.866).add(a.y.mul(0.5)), a.y);
}

/**
 * The flare's radiance for this pixel, to add to the HDR frame before tone mapping. `scene` is the
 * frame the sun's visibility is read from; `screen` this pixel's uv.
 */
export function lensFlare(scene: { sample(uv: Node<'vec2'>): Node<'vec4'> }, screen: Node<'vec2'>): Node<'vec3'> {
  const toUv = vec2(flareAspect, 1);
  // Visible part of the disc: 13 taps over its inner 70 %, each the ratio of what the frame shows
  // there to the bare disc. Into a 1 × 1 target, so it is done once a frame, not once a pixel.
  const offsets: [number, number][] = [[0, 0]];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    offsets.push([Math.cos(a) * 0.35, Math.sin(a) * 0.35]);
    offsets.push([Math.cos(a + Math.PI / 6) * 0.7, Math.sin(a + Math.PI / 6) * 0.7]);
  }
  let seen: Node<'float'> = float(0);
  for (const [x, y] of offsets) {
    const p = flareSunUv.add(vec2(x, y).mul(flareDiscRadius).div(toUv));
    const lum = scene.sample(p).rgb.dot(vec3(0.2126, 0.7152, 0.0722));
    // A little headroom: the canopy's glass and the filtering of a disc a few pixels across take some off.
    seen = seen.add(lum.div(flareDiscLum.mul(0.75)).clamp(0, 1));
  }
  const visTex = rtt(vec4(seen.div(offsets.length).mul(flareOnScreen)), 1, 1);
  const vis = visTex.sample(vec2(0.5)).r;

  const P = screen.sub(0.5).mul(toUv);
  const S = flareSunUv.sub(0.5).mul(toUv);
  const d = P.sub(S);
  const r = length(d);
  const theta = atan(d.y, d.x);
  const px = float(1).div(screenSize.y);

  // Starburst: the aperture's straight edges diffract light into spikes square to them. A spike's
  // half-width is held to about a pixel, so it stays a line at every distance.
  // The blades' angle in the barrel is arbitrary; off the horizontal, so no spike lies along the horizon.
  const across = r.mul(sin(theta.add(0.26).mul(BLADES / 2))).div(BLADES / 2);
  const spikes = exp(across.mul(across).div(px.mul(px).mul(-2.2))).mul(exp(r.div(-0.13))).mul(float(0.02).div(r.add(0.02)));
  // Fine rays from dust and the edges' nicks: noise round the circle, sharpened into thin streaks.
  const cell = theta.add(Math.PI).mul(160 / (2 * Math.PI));
  const i0 = cell.floor();
  const f = smoothstep(0, 1, cell.sub(i0));
  const n = mix(hash(i0), hash(i0.add(1).mod(160)), f);
  const rays = pow(n, 7).mul(exp(r.div(-0.12))).mul(float(0.01).div(r.add(0.01)));
  // The glow the glass scatters close round the source, beyond the bloom's reach.
  const glow = float(0.0004).div(r.mul(r).add(0.0004));

  // Ghosts: images of the aperture on the line through the centre. Each colour channel lands at a
  // slightly different size (the glass disperses), which fringes the edges.
  let ghosts: Node<'vec3'> = vec3(0);
  for (const g of GHOSTS) {
    const q = P.sub(S.mul(g.t));
    const channel = (k: number): Node<'float'> => {
      const h = hexagon(q.div(g.r * k));
      // A flat fill with a brighter rim, as a defocused aperture image is.
      return smoothstep(1, 0.93, h).mul(float(0.55).add(smoothstep(0.6, 1, h).mul(0.45)));
    };
    // A wider ghost spreads its light thinner, but the wide ones come from the stronger reflections:
    // tuned against photographs, as a square root rather than the area.
    const gain = 0.004 * Math.sqrt(0.03 / g.r);
    ghosts = ghosts.add(vec3(channel(1).mul(g.colour[0]), channel(1.025).mul(g.colour[1]), channel(1.05).mul(g.colour[2])).mul(gain));
  }
  // The ring ghost, centred a little across the middle from the sun: an arc brightest on the sun's side.
  const C = S.mul(-0.2);
  const toP = P.sub(C);
  const ringR = length(toP);
  const side = normalize(toP).dot(normalize(S.sub(C).add(1e-5)));
  const ringAt = (radius: number): Node<'float'> => exp(ringR.sub(radius).div(0.02).pow(2).negate());
  const ring = vec3(ringAt(0.47), ringAt(0.465), ringAt(0.46)).mul(float(0.25).add(max(side, 0).mul(0.75))).mul(vec3(1, 0.7, 0.4)).mul(2.5e-3);

  const near = spikes.mul(0.35).add(rays.mul(1.2)).add(glow.mul(0.02));
  return flareSun.mul(vis).mul(vec3(near).add(ghosts).add(ring));
}
