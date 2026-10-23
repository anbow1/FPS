import { abs, atan, clamp, cos, float, floor, fract, fwidth, length, max, mix, positionWorld, sin, smoothstep, step, uv, vec2, vec3, vec4 } from 'three/tsl';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu';
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
 * Fallen plane leaves (Platanus × hispanica: palmate, 12–22 cm, five pointed lobes on a stalk): one in some
 * cells of a 30 cm grid, turned at random, most of them dried tan to brown by late October, a few still
 * yellow, each curled (one side shaded) with its veins darker. Returns (colour, coverage).
 */
function leaves(p: V2, density: F): Node<'vec4'> {
  const cellM = 0.3;
  const cell = floor(p.div(cellM));
  const h = hash12(cell);
  const h2 = hash12(cell.add(17.3));
  const h3 = hash12(cell.add(41.9));
  const a = h2.mul(6.283);
  const centre = vec2(hash12(cell.add(2.2)), hash12(cell.add(8.8))).sub(0.5).mul(cellM * 0.35);
  const local = fract(p.div(cellM)).sub(0.5).mul(cellM).sub(centre);
  const q = vec2(local.x.mul(cos(a)).sub(local.y.mul(sin(a))), local.x.mul(sin(a)).add(local.y.mul(cos(a))));
  const size = h.mul(0.035).add(0.06);
  // Five lobes, pointed (|cos| sharpened), the leaf's base notched where the stalk joins; uneven per leaf.
  const ang = atan(q.y, q.x).add(h3.mul(0.4));
  const r = length(q);
  const lobe = abs(cos(ang.mul(2.5))).pow(0.6);
  const notch = smoothstep(0.35, 0.0, abs(ang.add(1.5708).sub(h3.mul(0.4))));
  const outline = size.mul(lobe.mul(0.45).add(0.55)).mul(float(1).sub(notch.mul(0.35)));
  const blade = float(1).sub(smoothstep(outline.mul(0.92), outline, r));
  const stalk = step(abs(q.x), 0.003).mul(step(q.y, size.mul(-0.4))).mul(step(size.mul(-0.85), q.y));
  const leaf = max(blade, stalk).mul(step(h, density));
  // Veins: five lines from the stalk to the lobe tips.
  const veins = smoothstep(0.08, 0.0, abs(fract(atan(q.y, q.x).div(6.283).mul(5).add(0.25)).sub(0.5))).mul(smoothstep(0.004, 0.02, r));
  const tan = vec3(...linearRgb(0xa3804e));
  const brown = vec3(...linearRgb(0x6e4a2a));
  const dark = vec3(...linearRgb(0x4a3220));
  const yellow = vec3(...linearRgb(0xc29a3e));
  let colour: V3 = mix(mix(tan, brown, smoothstep(0.2, 0.7, h2)), dark, step(0.8, h2));
  colour = mix(colour, yellow, step(0.88, hash12(cell.add(5.1))));
  // Blotches of decay, the veins darker, and the curl: the side away from the light is shaded.
  colour = colour.mul(float(0.8).add(vnoise2(p.mul(60)).mul(0.35))).mul(float(1).sub(veins.mul(0.25)));
  const curl = q.x.div(size).mul(mix(float(-1), float(1), step(0.5, h3))).mul(0.25).add(0.9);
  return vec4(colour.mul(curl), leaf);
}

/** Leaf density on the ground at p (xz): under the crowns, along the kerbs, a scatter elsewhere. */
function leafDensity(p: V2): F {
  const x = abs(p.x);
  const tz = fract(p.y.sub(STREET.nearZM - 4).div(STREET.treeSpacingM)).sub(0.5).abs().mul(STREET.treeSpacingM);
  const underTrees = smoothstep(5, 1, length(vec2(x.sub(STREET.treeXM), tz.sub(STREET.treeSpacingM / 2)).mul(vec2(1, 0.7))));
  const kerbline = smoothstep(0.9, 0.0, abs(x.sub(STREET.carriageHalfM - 0.25)));
  const patches = fbm2(p.div(3));
  // Drifts: wind and feet gather them, so coverage comes in patches rather than an even sprinkle.
  const drifts = smoothstep(0.35, 0.75, fbm2(p.div(1.6).add(13)));
  return clamp(underTrees.mul(0.55).add(kerbline.mul(0.7)).add(0.04).mul(patches.mul(1.3)).mul(drifts.mul(1.6).add(0.25)), 0, 0.9);
}

export function roadMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'carriageway', metalness: 0 });
  const w = positionWorld;
  const p = vec2(w.x, w.z);
  const onBoulevard = step(abs(w.x), STREET.carriageHalfM);
  // Asphalt as it reads from a pavement: the aggregate (the scan, below) under broad tone (older,
  // sun-greyed stretches and fresher dark ones), each lane's two wheel paths polished lighter and smoother,
  // the oil-darkened strip between them, rectangular trench repairs in their own tone with a black seal
  // round the edge, meandering cracks filled with glossy tar, and the odd cast-iron manhole.
  const grain = vnoise2(p.mul(90)).mul(0.25).add(vnoise2(p.mul(23)).mul(0.15));
  const tone = smoothstep(0.3, 0.7, fbm2(p.div(26)).mul(0.6).add(fbm2(p.div(7)).mul(0.4)));
  const lanePos = fract(abs(w.x).div(3.25)).sub(0.5).abs();
  const lanes = onBoulevard.mul(step(abs(w.x), STREET.carriageHalfM - 2.4));
  // Wheel paths: broad (a tyre's track wanders ±0.3 m), soft-edged, broken up along their length.
  const wheels = smoothstep(0.14, 0.03, abs(lanePos.sub(0.27))).mul(lanes).mul(fbm2(vec2(w.x.mul(1.5), w.z.div(4))).mul(0.8).add(0.4)).clamp(0, 1);
  const oil = smoothstep(0.16, 0.03, lanePos).mul(lanes).mul(fbm2(vec2(w.x.mul(2), w.z.div(3))).mul(0.6).add(0.6));
  // Trench repairs: in a 3.25 × 17 m lattice, two cells in five, a rectangle of its own size and tone.
  const cellR = floor(vec2(w.x.div(3.25), w.z.div(17)));
  const local = fract(vec2(w.x.div(3.25), w.z.div(17)));
  const hr = hash12(cellR.add(31.7));
  const x0 = hash12(cellR.add(2.1)).mul(0.3);
  const z0 = hash12(cellR.add(5.3)).mul(0.5);
  const x1 = x0.add(mix(float(0.35), float(0.7), hash12(cellR.add(7.9))));
  const z1 = z0.add(mix(float(0.08), float(0.45), hash12(cellR.add(9.4))));
  const inRect = (a: F, b: F, c: F, d: F): F => step(a, local.x).mul(step(local.x, c)).mul(step(b, local.y)).mul(step(local.y, d));
  const repair = inRect(x0, z0, x1, z1).mul(step(hr, 0.4)).mul(onBoulevard);
  const seal = repair.mul(float(1).sub(inRect(x0.add(0.012), z0.add(0.0025), x1.sub(0.012), z1.sub(0.0025))));
  const repairTone = mix(vec3(...linearRgb(0x1c1c1e)), vec3(...linearRgb(0x6e6c68)), step(0.5, hash12(cellR.add(13.3))));
  // Tar-filled cracks: thin bands along noise contours, only where the road is old.
  const crackField = fbm2(p.div(2.2).add(vec2(5.2, 1.3)));
  const cracks = band(crackField.sub(0.5), 0.006).mul(smoothstep(0.45, 0.7, fbm2(p.div(14).add(21)))).mul(onBoulevard).mul(repair.oneMinus());
  // Manholes: one in some 20 m cells, 0.6 m across, in a lane's middle.
  const cellM = floor(vec2(w.x.div(6.5), w.z.div(20)));
  const mc = vec2(cellM.x.add(0.5).mul(6.5), cellM.y.add(hash12(cellM.add(3.3)).mul(0.6).add(0.2)).mul(20));
  const mr = length(p.sub(mc));
  const manhole = step(mr, 0.32).mul(step(hash12(cellM.add(8.8)), 0.35)).mul(lanes);
  const ring = band(mr.sub(0.31), 0.012).mul(manhole);
  const scanA = photo('asphalt_02', p);
  const scanB = photoRotated('asphalt_02', p);
  const scanMix = smoothstep(0.35, 0.65, fbm2(p.div(11).add(3)));
  const scanDetail = mix(scanA.detail, scanB.detail, scanMix);
  const scanRough = mix(scanA.roughness, scanB.roughness, scanMix);
  const scanHeight = mix(scanA.height, scanB.height, scanMix);
  let colour: V3 = vec3(...linearRgb(0x4a4a4c)).mul(float(0.55).add(tone.mul(0.95))).mul(scanDetail);
  colour = colour.mul(float(1).add(wheels.mul(0.1))).mul(float(1).sub(oil.mul(0.45)));
  colour = mix(colour, repairTone.mul(scanDetail).mul(float(0.9).add(grain.mul(0.4))), repair);
  colour = mix(colour, vec3(0.012, 0.012, 0.013), max(seal, cracks).mul(0.85));
  const iron = vec3(...linearRgb(0x2c2a28)).mul(step(0.5, fract(p.x.sub(mc.x).mul(14))).mul(0.25).add(0.8));
  colour = mix(colour, iron, manhole);
  colour = colour.mul(float(1).sub(ring.mul(0.6)));
  // Polished paths and the oily strip catch the sky at a grazing look: that sheen is most of what tells
  // asphalt in shade apart.
  let rough: F = mix(float(0.9), scanRough, 0.5).sub(wheels.mul(0.12)).sub(oil.mul(0.2));
  rough = mix(rough, float(0.35), max(seal, cracks));
  rough = mix(rough, float(0.5), manhole);
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
  // Coarse aggregate hides most of its own sheen: seen at a grazing angle the stones shadow and mask the
  // gaps between them, which the environment BRDF (a smooth-surface statistic) does not know, and the
  // whole road turned into one blue-grey reflection of the sky. Only the polished wheel paths, the oily
  // strip, the tar seals and the paint keep their full specular.
  const smooth = clamp(wheels.mul(0.35).add(oil.mul(0.6)).add(max(seal, cracks)).add(painted).add(stream).add(manhole), 0, 1);
  m.specularIntensityNode = mix(float(0.3).add(scanHeight.mul(0.25)), float(1), smooth).mul(float(1).sub(inGutter.mul(0.3)));
  m.normalNode = heightBump(scanHeight.mul(0.006).mul(inGutter.oneMinus()).add(setts.height.mul(inGutter).mul(0.02)).add(lv.w.mul(0.002)), 1);
  return m;
}

export function pavementMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'pavement', metalness: 0 });
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
  let colour: V3 = vec3(...linearRgb(0x77736d)).mul(float(0.82).add(tone.mul(0.4))).mul(scan);
  const trench = step(0.78, fbm2(vec2(w.x.div(1.5), w.z.div(20)).add(9)));
  colour = mix(colour, vec3(...linearRgb(0x56534f)), trench.mul(0.6));
  // A city pavement's use: dark blotches where something was spilt or a puddle dried, a scatter of
  // trodden-in chewing gum (pale-grey to black dots, 1–2 cm, thickest by the café terraces and the kerb).
  const blotch = smoothstep(0.62, 0.78, fbm2(p.div(1.3).add(27))).mul(smoothstep(0.4, 0.7, fbm2(p.div(7).add(3))));
  colour = colour.mul(float(1).sub(blotch.mul(0.28)));
  const gumCell = floor(p.div(0.11));
  const gumAt = vec2(hash12(gumCell.add(1.3)), hash12(gumCell.add(6.1))).sub(0.5).mul(0.07);
  const gumR = length(fract(p.div(0.11)).sub(0.5).mul(0.11).sub(gumAt));
  const gum = step(gumR, hash12(gumCell.add(9.7)).mul(0.006).add(0.004)).mul(step(hash12(gumCell), 0.045));
  colour = mix(colour, mix(vec3(...linearRgb(0x3a3936)), vec3(...linearRgb(0x8a8984)), hash12(gumCell.add(2.9))), gum.mul(0.85));
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
  // As on the road: the poured asphalt's grit masks most of its grazing sheen (or every stain drowns in the
  // sky's reflection); the granite and the iron keep theirs.
  m.specularIntensityNode = mix(float(0.4), float(1), max(kerbTop, grate));
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
