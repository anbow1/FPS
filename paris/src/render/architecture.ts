import { abs, attribute, float, floor, fract, fwidth, length, max, min, mix, positionWorld, smoothstep, step, uv, vec2, vec3 } from 'three/tsl';
import { DoubleSide, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { fbm2, hash12, heightBump, linearRgb, vnoise2 } from './nodes.ts';

// Materials of the buildings' solid parts, from the PBR sheet's values for
// the real thing:
//   - Lutetian limestone (pierre de taille, Paris's building stone): warm
//     cream, albedo ~0.5 when cleaned, greyer where the soot of a century has
//     not been washed off; ashlar courses ~0.5 m, thin lime joints; the ground
//     floor and entresol rusticated (deep horizontal grooves); grime streaks
//     run down under every ledge.
//   - Weathered zinc (the mansards): blue-grey patina, half metallic, the
//     standing seams every ~0.45 m, white oxide streaks.
//   - Wrought-iron railings: black paint, drawn as a mask (balusters, rails,
//     rings and scrolls), so the shadow they throw has the pattern too.
//   - Canvas awnings, terracotta chimney pots.

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Painted woodwork and canvas: bordeaux, bottle green, navy, black, ochre, oxide red (linear). */
export const PAINTS: [number, number, number][] = [0x5a1a1f, 0x1d3a2c, 0x1b2638, 0x161616, 0x8a6a2e, 0x8c2c20].map(linearRgb);

/** The entry `i` (a whole number as a float node) of a list of colours. */
export function pick(i: F, list: readonly [number, number, number][]): V3 {
  let out: V3 = vec3(...(list[0] as [number, number, number]));
  for (let k = 1; k < list.length; k++) out = mix(out, vec3(...(list[k] as [number, number, number])), step(k - 0.5, i));
  return out;
}

export function stoneMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'limestone', metalness: 0 });
  const p = uv();
  const tone = attribute('tone', 'float');
  const rustic = attribute('rustic', 'float');
  const ao = attribute('ao', 'float');
  // Ashlar: courses 0.52 m (0.5 m rusticated), blocks ~1.15 m staggered by half.
  const course = mix(float(0.52), float(0.5), rustic);
  const row = floor(p.y.div(course));
  const bx = p.x.div(1.15).add(row.mul(0.5));
  const fx = fract(bx).mul(1.15);
  const fy = fract(p.y.div(course)).mul(course);
  const dy = min(fy, course.sub(fy));
  const dx = min(fx, float(1.15).sub(fx));
  const fw = max(fwidth(p.y), 1e-4);
  // Lime joints 5 mm; on the rusticated storeys a V groove 4 cm wide and no head joints showing.
  const groove = mix(float(0.004), float(0.022), rustic);
  const jointY = float(1).sub(smoothstep(groove, groove.add(fw.mul(1.5)), dy));
  const jointX = float(1).sub(smoothstep(0.003, float(0.003).add(fw.mul(1.5)), dx)).mul(rustic.oneMinus());
  // Joints fade where they get finer than a pixel (TRAA would only shimmer them).
  const visible = float(1).sub(smoothstep(0.01, 0.05, fw));
  const joint = max(jointY, jointX).mul(visible);
  const cell = vec2(floor(bx), row);
  const blockTint = hash12(cell.add(tone.mul(91))).sub(0.5).mul(0.12);
  // Cleaned cream to unwashed grey-buff, per building.
  const fresh = vec3(...linearRgb(0xd2c3a3));
  const old = vec3(...linearRgb(0xb3a68f));
  let base: V3 = mix(old, fresh, smoothstep(0.25, 0.75, tone));
  // Large patches of tone, then soot streaks running down (stretched noise), strongest low on the front.
  const w = positionWorld;
  const patches = fbm2(vec2(w.x.add(w.z), w.y).div(6)).sub(0.5).mul(0.16);
  const streak = smoothstep(0.52, 0.82, fbm2(vec2(w.x.add(w.z).mul(2.2), w.y.mul(0.18))));
  const soot = streak.mul(0.32).mul(mix(float(1), float(0.55), tone));
  base = base.mul(float(1).add(blockTint).add(patches)).mul(float(1).sub(soot));
  // A joint is darker (shadowed lime and dirt), deeper in the rusticated grooves.
  const jointDark = mix(float(0.78), float(0.42), rustic);
  m.colorNode = base.mul(mix(float(1), jointDark, joint)).mul(mix(float(0.55), float(1), ao));
  m.aoNode = ao;
  m.roughnessNode = float(0.86).sub(soot.mul(0.1));
  // Relief: the grooves sunk, the faces with a fine pitted texture.
  const pits = vnoise2(p.mul(38)).mul(0.0012);
  m.normalNode = heightBump(joint.mul(mix(float(-0.004), float(-0.02), rustic)).add(pits), 1);
  return m;
}

export function zincMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'zinc', side: DoubleSide });
  const p = uv();
  const ao = attribute('ao', 'float');
  // Standing seams every 0.45 m: a raised rib 2 cm wide.
  const sx = fract(p.x.div(0.45));
  const d = min(sx, float(1).sub(sx)).mul(0.45);
  const fw = max(fwidth(p.x), 1e-4);
  const seam = float(1).sub(smoothstep(0.008, float(0.008).add(fw.mul(1.5)), d));
  const sheet = hash12(vec2(floor(p.x.div(0.45)), floor(p.y.div(2.1))));
  const w = positionWorld;
  const oxide = smoothstep(0.55, 0.85, fbm2(vec2(w.x.add(w.z).mul(1.5), w.y.mul(0.3))));
  const zinc = vec3(...linearRgb(0x7f878e));
  const pale = vec3(...linearRgb(0xa9aeb0));
  m.colorNode = mix(zinc, pale, oxide.mul(0.6)).mul(sheet.mul(0.12).add(0.94)).mul(mix(float(0.6), float(1), ao));
  m.metalnessNode = float(0.55).sub(oxide.mul(0.3));
  m.roughnessNode = float(0.48).add(sheet.mul(0.12)).add(oxide.mul(0.2));
  m.aoNode = ao;
  m.normalNode = heightBump(seam.mul(0.012), 1);
  return m;
}

/**
 * Wrought iron: the railing's pattern as a mask over a flat panel (uv in metres; `rail` = kind, height).
 * Rails top and bottom, balusters every 11 cm, and a band of rings — circles 0.32 m across every 0.44 m
 * with small ones between — the common Haussmann pattern. Painted black.
 */
export function ironMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'iron railing', side: DoubleSide, metalness: 0.2, roughness: 0.45 });
  const p = uv();
  const rail = attribute('rail', 'vec2');
  const h = rail.y;
  const line = (d: F, halfWidth: number): F => step(d, float(halfWidth));
  const rails = max(max(line(abs(p.y.sub(h).add(0.025)), 0.025), line(abs(p.y.sub(0.03)), 0.022)), max(line(abs(p.y.sub(0.16)), 0.012), line(abs(p.y.sub(h).add(0.24)), 0.012)));
  const bx = fract(p.x.div(0.11)).sub(0.5).mul(0.11);
  const inBand = step(0.16, p.y).mul(step(p.y, h.sub(0.24)));
  const balusters = line(abs(bx), 0.008).mul(step(p.y, h.sub(0.24)).mul(step(0.03, p.y)));
  // Rings in the band between the middle rails, and small rings in the frieze under the top rail.
  const mid = h.sub(0.24).add(0.16).mul(0.5);
  const cx = fract(p.x.div(0.44)).sub(0.5).mul(0.44);
  const big = line(abs(length(vec2(cx, p.y.sub(mid))).sub(0.15)), 0.011).mul(inBand);
  const cx2 = fract(p.x.div(0.44).add(0.5)).sub(0.5).mul(0.44);
  const small = line(abs(length(vec2(cx2, p.y.sub(mid))).sub(0.055)), 0.009).mul(inBand);
  const frieze = line(abs(length(vec2(bx, p.y.sub(h).add(0.13))).sub(0.04)), 0.007).mul(step(h.sub(0.24), p.y));
  const mask = max(max(rails, balusters), max(max(big, small), frieze));
  m.maskNode = mask.greaterThan(0.5);
  m.colorNode = vec3(...linearRgb(0x1d1e1e));
  return m;
}

/** Canvas: the painted colour, the weave, the sag between the arms; a cream band of lettering on the valance. */
export function awningMaterial(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'awning', side: DoubleSide, metalness: 0 });
  const p = uv();
  const paint = pick(attribute('paint', 'float'), PAINTS).mul(1.25);
  const valance = step(p.y, 0.25);
  // "Lettering": blocks of strokes that read as a name and say nothing.
  const gx = p.x.mul(34);
  const glyph = hash12(vec2(floor(gx), 3)).greaterThan(0.18).select(float(1), float(0));
  const stroke = step(0.25, fract(gx)).mul(step(fract(gx), 0.8)).mul(step(0.07, p.y)).mul(step(p.y, 0.17)).mul(step(hash12(vec2(floor(gx.mul(3)), floor(p.y.mul(30)))), 0.62));
  const text = valance.mul(glyph).mul(stroke).mul(step(0.18, p.x)).mul(step(p.x, 0.82));
  const weave = vnoise2(p.mul(vec2(400, 160))).mul(0.06).add(0.97);
  m.colorNode = mix(paint, vec3(...linearRgb(0xe8dcc0)), text).mul(weave);
  m.roughnessNode = float(0.85);
  m.sheenNode = paint.mul(0.4);
  return m;
}

export function potMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'chimney pot', roughness: 0.8 });
  m.colorNode = vec3(...linearRgb(0x9a5a3e)).mul(vnoise2(positionWorld.xy.mul(9)).mul(0.3).add(0.75));
  return m;
}
