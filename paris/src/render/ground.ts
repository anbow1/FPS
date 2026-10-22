import { abs, atan, clamp, cos, float, floor, fract, fwidth, length, max, mix, positionWorld, sin, smoothstep, step, uv, vec2, vec3, vec4 } from 'three/tsl';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { STREET } from '../config.ts';
import { fbm2, hash12, heightBump, linearRgb, vnoise2 } from './nodes.ts';
import { photo, photoRotated } from './photo.ts';

// The street's surfaces, all drawn from the world position (so nothing
// repeats with a texture):
//   - the carriageway: dark asphalt with the polished wheel paths of each
//     lane, patches and sealed cracks, the lane dashes, zebra crossings and
//     stop lines at every crossing, and the granite-sett gutter (caniveau)
//     along each kerb, wet where the street cleaners' water still runs;
//   - the pavements: Paris's poured asphalt, lighter and smoother, the cast
//     iron grate round every plane tree, and autumn's fallen plane leaves,
//     thickest under the trees and swept into the gutters;
//   - the kerbs: grey granite blocks.

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** 1 inside |d| < half, softened over a pixel. */
function band(d: F, half: number): F {
  const w = max(fwidth(d), 1e-4);
  return float(1).sub(smoothstep(w.negate().add(half), w.add(half), abs(d)));
}

/** Distance (along z) to the nearest crossing's centre line, and that crossing's road half width. */
function nearestCrossing(z: F): { dz: F; half: F } {
  let dz: F = float(1e5);
  let half: F = float(0);
  for (const c of STREET.crossings) {
    const d = z.sub(c.zM);
    const closer = step(abs(d), abs(dz));
    dz = mix(dz, d, closer);
    half = mix(half, float(c.widthM / 2 - 3.2), closer);
  }
  return { dz, half };
}

/**
 * Fallen plane leaves: one in some cells of a 22 cm grid, each a lobed blade turned at random, coloured
 * from yellow-green to rust brown. Returns (colour, coverage).
 */
function leaves(p: V2, density: F): Node<'vec4'> {
  const cell = floor(p.div(0.22));
  const h = hash12(cell);
  const h2 = hash12(cell.add(17.3));
  const a = h2.mul(6.283);
  const local = fract(p.div(0.22)).sub(0.5).mul(0.22);
  const q = vec2(local.x.mul(cos(a)).sub(local.y.mul(sin(a))), local.x.mul(sin(a)).add(local.y.mul(cos(a))));
  // A palmate leaf: radius with five lobes.
  const ang = atan(q.y, q.x);
  const r = length(q);
  const size = h.mul(0.03).add(0.055);
  const lobes = size.mul(sin(ang.mul(5)).mul(0.22).add(0.82));
  const blade = float(1).sub(smoothstep(lobes.mul(0.85), lobes, r)).mul(step(h, density));
  const c1 = vec3(...linearRgb(0xb88a2a));
  const c2 = vec3(...linearRgb(0x8a5a26));
  const c3 = vec3(...linearRgb(0x9c9a3c));
  const colour = mix(mix(c1, c2, smoothstep(0.3, 0.8, h2)), c3, step(0.85, hash12(cell.add(5.1)))).mul(float(0.85).add(vnoise2(p.mul(40)).mul(0.3)));
  return vec4(colour, blade);
}

/** Leaf density on the ground at p (xz): under the crowns, along the kerbs, a scatter elsewhere. */
function leafDensity(p: V2): F {
  const x = abs(p.x);
  const tz = fract(p.y.sub(STREET.nearZM - 4).div(STREET.treeSpacingM)).sub(0.5).abs().mul(STREET.treeSpacingM);
  const underTrees = smoothstep(5, 1, length(vec2(x.sub(STREET.treeXM), tz.sub(STREET.treeSpacingM / 2)).mul(vec2(1, 0.7))));
  const kerbline = smoothstep(0.9, 0.0, abs(x.sub(STREET.carriageHalfM - 0.25)));
  const patches = fbm2(p.div(3));
  return clamp(underTrees.mul(0.32).add(kerbline.mul(0.5)).add(0.03).mul(patches.mul(1.4)), 0, 0.85);
}

export function roadMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'carriageway', metalness: 0 });
  const w = positionWorld;
  const p = vec2(w.x, w.z);
  const onBoulevard = step(abs(w.x), STREET.carriageHalfM);
  // Asphalt: aggregate speckle, large tone patches, polished wheel paths in each lane, patched trenches.
  const grain = vnoise2(p.mul(90)).mul(0.25).add(vnoise2(p.mul(23)).mul(0.15));
  const patches = fbm2(p.div(9));
  const lanePos = fract(abs(w.x).div(3.25)).sub(0.5).abs();
  const wheels = band(lanePos.sub(0.27), 0.08).mul(onBoulevard);
  const repair = step(0.72, fbm2(vec2(w.x.div(2.5), w.z.div(14)).add(40)));
  // The scanned road (Poly Haven asphalt_02, 3 m): its aggregate and hairline cracks as detail on the
  // procedural tone, a second rotated tap blended by large noise so the 3 m repeat never lines up.
  const scanA = photo('asphalt_02', p);
  const scanB = photoRotated('asphalt_02', p);
  const scanMix = smoothstep(0.35, 0.65, fbm2(p.div(11).add(3)));
  const scanDetail = mix(scanA.detail, scanB.detail, scanMix);
  const scanRough = mix(scanA.roughness, scanB.roughness, scanMix);
  const scanHeight = mix(scanA.height, scanB.height, scanMix);
  let colour: V3 = vec3(...linearRgb(0x4a4a4c)).mul(float(0.85).add(patches.mul(0.25))).mul(scanDetail);
  colour = mix(colour, vec3(...linearRgb(0x2e2e30)), repair.mul(0.55));
  colour = colour.mul(float(1).sub(wheels.mul(0.12)));
  let rough: F = mix(float(0.88), scanRough, 0.6).sub(wheels.mul(0.16));
  // Markings (white paint, worn): lane dashes 3 m in 13, the centre line dashed, the parking lane's edge.
  const { dz, half } = nearestCrossing(w.z);
  const outsideCrossing = step(half.add(0.2), abs(dz));
  const dash = step(fract(w.z.div(13)), 3 / 13);
  const laneLines = max(band(abs(w.x).sub(3.25), 0.07), band(w.x, 0.07)).mul(dash).add(band(abs(w.x).sub(6.55), 0.06).mul(step(fract(w.z.div(4)), 0.5)));
  // Zebras across the boulevard just beyond each crossing's road, stop lines behind them.
  const beyond = abs(dz).sub(half);
  const zebra = step(0.5, beyond).mul(step(beyond, 4.5)).mul(step(fract(w.x.div(1.0)), 0.5)).mul(onBoulevard).mul(step(abs(w.x), 8.4));
  const stop = band(beyond.sub(5.4), 0.25).mul(onBoulevard).mul(step(0, w.x.mul(dz)));
  // Zebras across the cross streets in line with the boulevard's pavements.
  const crossZebra = step(STREET.carriageHalfM + 0.4, abs(w.x)).mul(step(abs(w.x), STREET.facadeHalfM - 1.2)).mul(step(abs(dz), half.sub(0.6))).mul(step(fract(w.z.div(1.0)), 0.5)).mul(onBoulevard.oneMinus());
  const paint = max(max(laneLines.mul(outsideCrossing).mul(onBoulevard), zebra), max(stop, crossZebra));
  const wear = smoothstep(0.25, 0.7, vnoise2(p.mul(3.1)).add(grain.mul(0.6)));
  const painted = paint.mul(wear);
  colour = mix(colour, vec3(...linearRgb(0xd8d8d2)), painted);
  rough = mix(rough, float(0.62), painted);
  // The gutter (caniveau): scanned setts (Poly Haven cobblestone_05) greyed toward Paris granite, a thin
  // stream of water running in it.
  const gutterX = abs(w.x).sub(STREET.carriageHalfM - 0.42);
  const inGutter = step(0, gutterX).mul(onBoulevard);
  const setts = photo('cobblestone_05', vec2(gutterX, w.z));
  const settLum = setts.colour.dot(vec3(0.2126, 0.7152, 0.0722));
  const granite = mix(vec3(settLum), setts.colour, 0.35).mul(vec3(...linearRgb(0x6d6b68)).div(0.16));
  colour = mix(colour, granite, inGutter);
  const stream = smoothstep(0.12, 0.02, abs(gutterX.sub(0.24).add(vnoise2(vec2(w.z.mul(0.7), 3)).mul(0.08)))).mul(inGutter).mul(step(0.35, fbm2(vec2(w.z.div(12), 1))));
  colour = colour.mul(float(1).sub(stream.mul(0.5)));
  rough = mix(mix(rough, float(0.7), inGutter), float(0.06), stream);
  // Leaves, swept toward the kerbs; on the road only along the gutter (traffic clears the rest).
  const lv = leaves(p, leafDensity(p).mul(smoothstep(STREET.carriageHalfM - 1.6, STREET.carriageHalfM - 0.4, abs(w.x)).add(onBoulevard.oneMinus().mul(0.3))));
  colour = mix(colour, lv.xyz, lv.w.mul(float(1).sub(stream)));
  rough = mix(rough, float(0.75), lv.w);
  m.colorNode = colour;
  m.roughnessNode = rough;
  m.normalNode = heightBump(scanHeight.mul(0.006).mul(inGutter.oneMinus()).add(setts.height.mul(inGutter).mul(0.02)).add(lv.w.mul(0.002)), 1);
  return m;
}

export function pavementMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'pavement', metalness: 0 });
  const w = positionWorld;
  const p = vec2(w.x, w.z);
  // Poured asphalt (asphalte coulé): lighter, finer, with darker repairs where the trenches were.
  const grain = vnoise2(p.mul(120)).mul(0.18).add(vnoise2(p.mul(30)).mul(0.12));
  const tone = fbm2(p.div(5));
  // Poured asphalt scanned (Poly Haven clean_asphalt, 2.1 m) as the fine detail, two taps against its repeat.
  const scanA = photo('clean_asphalt', p);
  const scanB = photoRotated('clean_asphalt', p);
  const scanMix = smoothstep(0.35, 0.65, fbm2(p.div(9).add(7)));
  const scan = mix(scanA.detail, scanB.detail, scanMix);
  let colour: V3 = vec3(...linearRgb(0x77736d)).mul(float(0.9).add(tone.mul(0.3))).mul(mix(vec3(1), scan, 0.8));
  const trench = step(0.78, fbm2(vec2(w.x.div(1.5), w.z.div(20)).add(9)));
  colour = mix(colour, vec3(...linearRgb(0x56534f)), trench.mul(0.6));
  // Granite kerb stones on top of the boulevard's kerb: 1 m blocks, 30 cm wide.
  const kerbTop = step(abs(w.x), STREET.carriageHalfM + STREET.kerbStoneM);
  const blockJoint = band(fract(w.z.div(1.0)).sub(0.5).abs().sub(0.5), 0.004);
  const kerbColour = vec3(...linearRgb(0x8f8d88)).mul(hash12(vec2(floor(w.z), w.x.sign())).mul(0.2).add(0.85)).mul(float(1).sub(blockJoint.mul(0.5)));
  colour = mix(colour, kerbColour, kerbTop);
  // Tree grates: cast iron discs 1.9 m across round each trunk, radial slots, the soil dark under them.
  const side = w.x.sign();
  const tz = w.z.sub(STREET.nearZM - 4).sub(side.mul(1.5));
  const cz = tz.sub(floor(tz.div(STREET.treeSpacingM).add(0.5)).mul(STREET.treeSpacingM));
  const d = vec2(abs(w.x).sub(STREET.treeXM), cz);
  const r = length(d);
  const { dz, half } = nearestCrossing(w.z);
  const treeHere = step(half.add(6.4), abs(dz));
  const grate = step(r, 0.95).mul(step(0.22, r)).mul(treeHere);
  const slots = step(0.5, fract(atan(d.y, d.x).mul(48 / 6.283))).mul(step(fract(r.div(0.18)), 0.75));
  const iron = mix(vec3(...linearRgb(0x2a2826)), vec3(0.012, 0.01, 0.008), slots.mul(step(0.3, r)));
  colour = mix(colour, iron, grate);
  const lv = leaves(p, leafDensity(p).mul(float(1).sub(kerbTop.mul(0.6))));
  colour = mix(colour, lv.xyz, lv.w);
  m.colorNode = colour;
  m.roughnessNode = mix(mix(float(0.82), float(0.55), grate.mul(slots.oneMinus())), float(0.75), lv.w);
  m.metalnessNode = grate.mul(slots.oneMinus()).mul(0.3);
  m.normalNode = heightBump(mix(scanA.height, scanB.height, scanMix).mul(0.003).add(grain.mul(0.001)).sub(grate.mul(slots).mul(0.01)).add(lv.w.mul(0.0025)), 1);
  return m;
}

/** Grey granite (the kerbs' faces): uv in metres, 1 m blocks. */
export function granite(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'granite', metalness: 0, roughness: 0.7 });
  const p = uv();
  const speck = vnoise2(p.mul(200)).mul(0.25).add(0.75);
  const joint = band(fract(p.x).sub(0.5).abs().sub(0.5), 0.004);
  m.colorNode = vec3(...linearRgb(0x8a8883)).mul(speck).mul(hash12(vec2(floor(p.x), 3)).mul(0.2).add(0.85)).mul(float(1).sub(joint.mul(0.5))).mul(0.85);
  return m;
}
