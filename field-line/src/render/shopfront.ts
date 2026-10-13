import { abs, dot, float, floor, fract, max, mix, sin, step, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { roomHash } from './roomInteriors.ts';

// The ground storey of a façade block is shops, as on any city street: each
// bay is a shopfront drawn in the façade shader over the window pattern — a
// wide glazed front on a low stall riser in a dark frame, a transom light, and
// above it a painted fascia carrying the shop's name. The names are no
// language: glyph-like strokes on a 3 × 5 grid per character, so from across
// the street they read as lettering without saying anything. A share of the
// shops is shut behind a roller shutter. Behind the glass, the room shader
// (roomInteriors.ts) already draws deeper, brighter shop interiors on this
// storey. Works in the façade tile's UVs: one tile = one bay × one storey.

export interface Shopfront {
  /** 1 on the ground storey. */
  shop: Node<'float'>;
  /** 1 where the shopfront replaces the wall pattern (glazing, frame, fascia, shutter). */
  cover: Node<'float'>;
  /** 1 on clear shop glass (the room shows through). */
  glass: Node<'float'>;
  /** Albedo where `cover` is set (glass is dark; the room adds its light). */
  albedo: Node<'vec3'>;
  roughness: Node<'float'>;
}

function box(f: Node<'vec2'>, u0: number, v0: number, u1: number, v1: number): Node<'float'> {
  return step(u0, f.x).mul(step(f.x, u1)).mul(step(v0, f.y)).mul(step(f.y, v1));
}

function hash(a: Node<'vec2'>, k: number): Node<'float'> {
  return fract(sin(dot(a, vec2(12.9898 + k, 78.233 + k * 0.37))).mul(43758.5453));
}

export function shopfront(): Shopfront {
  const t = uv();
  const cell = floor(t);
  const f = fract(t);
  const shop = step(-0.5, cell.y).mul(step(cell.y, 0.5));
  const h = roomHash();
  const shutter = step(h, 0.14);

  // The glazing starts above the plinth (facadeTrim.ts, 0.32 m).
  const glaze = box(f, 0.05, 0.12, 0.95, 0.74);
  // Inside the frame: the main light, a transom light above a bar, and on half the shops a door mullion.
  const inner = box(f, 0.065, 0.138, 0.935, 0.726);
  const transomBar = box(f, 0.05, 0.585, 0.95, 0.6);
  const mullion = box(f, 0.62, 0.12, 0.635, 0.74).mul(step(0.5, fract(h.mul(5.1))));
  const glassArea = inner.mul(float(1).sub(transomBar)).mul(float(1).sub(mullion));
  const fascia = box(f, 0.035, 0.76, 0.965, 0.97);
  const cover = shop.mul(max(glaze, fascia));

  // Fascia paint: the colours shopfronts are painted in (linear albedo).
  const pick = fract(h.mul(13.7));
  const paintA = mix(vec3(0.03, 0.08, 0.05), vec3(0.16, 0.03, 0.04), step(0.33, pick));
  const paintB = mix(paintA, vec3(0.03, 0.04, 0.11), step(0.55, pick));
  const paintC = mix(paintB, vec3(0.02, 0.02, 0.02), step(0.72, pick));
  const paint = mix(paintC, vec3(0.55, 0.5, 0.38), step(0.88, pick));
  // Lettering: 8–14 characters centred on the fascia, each drawn as thin strokes between the nodes of a
  // 3 × 5 grid (vertical strokes on three columns, horizontal on five rows), every stroke on or off by hash.
  // Lines, not filled cells: it reads as a sans-serif name from across the street, not as a pixel font.
  const chars = floor(mix(float(8), float(15), fract(h.mul(7.9))));
  const bandU = f.x.sub(0.5).div(0.62).mul(chars).add(chars.mul(0.5));
  const charIdx = floor(bandU);
  const inBand = step(0, bandU).mul(step(bandU, chars)).mul(box(f, 0, 0.795, 1, 0.935));
  // Glyph space: x 0…2 across the character (its last quarter is the gap), y 0…4 up the band.
  const gx = fract(bandU).div(0.75).mul(2);
  const gy = f.y.sub(0.8).div(0.13).mul(4);
  const key = charIdx.add(h.mul(97));
  const vx = floor(gx.add(0.5));
  const vy = floor(gy).clamp(0, 3);
  const vOn = step(0.5, hash(vec2(key.mul(7).add(vx), vy), 3)).mul(step(abs(gx.sub(vx)), 0.14));
  const hy = floor(gy.add(0.5));
  const hx = floor(gx).clamp(0, 1);
  const hOn = step(0.56, hash(vec2(key.mul(5).add(hx), hy.add(20)), 4)).mul(step(abs(gy.sub(hy)), 0.1));
  const inGlyph = step(-0.15, gx).mul(step(gx, 2.15)).mul(step(-0.1, gy)).mul(step(gy, 4.1));
  const space = step(fract(h.mul(3.3).add(charIdx.mul(0.37))), 0.12);
  const letters = inBand.mul(inGlyph).mul(max(vOn, hOn)).mul(float(1).sub(space));
  const ink = mix(vec3(0.75, 0.62, 0.32), vec3(0.85, 0.84, 0.8), step(0.5, fract(h.mul(17.3))));
  const inkOnPaint = mix(ink, vec3(0.04, 0.04, 0.04), step(0.88, pick));
  const fasciaColour = mix(paint, inkOnPaint, letters);

  // Roller shutter: galvanised slats, 8 cm, a little grime toward the foot.
  const slat = step(0.15, fract(f.y.mul(36)));
  const shutterColour = vec3(0.32, 0.33, 0.33).mul(mix(float(0.78), float(1), slat)).mul(mix(float(0.8), float(1), f.y));

  const frameColour = vec3(0.03, 0.03, 0.032);
  const glazeColour = mix(mix(frameColour, vec3(0.02), glassArea), shutterColour, shutter);
  const albedo = mix(glazeColour, fasciaColour, fascia);
  const roughness = mix(mix(mix(float(0.35), float(0.05), glassArea), float(0.5), shutter), mix(float(0.45), float(0.3), letters), fascia);
  return { shop, cover, glass: shop.mul(glassArea).mul(float(1).sub(shutter)), albedo, roughness };
}
