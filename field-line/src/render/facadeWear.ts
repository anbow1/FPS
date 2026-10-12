import { abs, attribute, dot, float, floor, fract, max, mix, mx_noise_float, normalWorldGeometry, positionWorld, sin, smoothstep, step, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { wetness } from './materials.ts';

// What years of weather and people do to a city block, painted in the façade
// shader (one tile = one bay × one storey, the window in the middle):
//
//   splash zone  the bottom ~0.8 m darker and greener: rain splashes soil and
//                exhaust onto it, and it stays damp;
//   sill streaks every sill sheds rain down the wall below it, a dark tongue
//                with vertical runs, darker still when the wall is wet;
//   stains       broad blotches over whole façades, so no two blocks match;
//   posters      paper on some ground-floor piers (abstract print, no text),
//                faded and torn at the edges;
//   graffiti     spray strokes along some stretches of the ground floor.
//
// All in metres from the tile UVs and the façade's tile size, so it scales with
// any bay and storey; stable per face (hashed on the geometric normal).

/** 0 … 1 hash of a 2-D cell (the sin-dot form: TSL `hash` breaks on negative cells). */
function hash(cell: Node<'vec2'>, k: number): Node<'float'> {
  return fract(sin(dot(cell, vec2(12.9898 + k * 1.37, 78.233 + k * 2.71))).mul(43758.5453));
}

export interface FacadeWear {
  /** The wall colour with dirt, streaks, posters and graffiti over it. */
  colour: Node<'vec3'>;
  /** 1 on poster paper: rougher, no clearcoat sheen. */
  paper: Node<'float'>;
}

/** `albedo` is the façade texture's colour; `pane` is 1 on clear glass (left untouched). */
export function facadeWear(albedo: Node<'vec3'>, pane: Node<'float'>): FacadeWear {
  const t = uv();
  const f = fract(t);
  const cell = floor(t);
  const size = attribute('tileSize', 'vec2');
  const alongM = t.x.mul(size.x);
  const heightM = t.y.mul(size.y);
  // One value per face of a block: the four faces of one block differ.
  const face = vec2(dot(normalWorldGeometry, vec3(17.1, 0, 31.7)), dot(normalWorldGeometry, vec3(5.3, 0, 11.9)));
  const wall = float(1).sub(pane);

  // Splash zone.
  const splash = float(1).sub(smoothstep(0.05, 0.85, heightM)).mul(0.9);
  // Sill streaks: under the sill (f.y 0.26–0.3) across the window's width, fading downwards, broken into runs.
  const span = smoothstep(0.24, 0.32, f.x).mul(smoothstep(0.76, 0.68, f.x));
  const below = smoothstep(0, 0.26, f.y).mul(step(f.y, 0.27));
  const runs = smoothstep(-0.3, 0.6, mx_noise_float(vec2(alongM.mul(14), heightM.mul(0.7))));
  const streak = span.mul(below).mul(runs).mul(0.7);
  // Broad stains.
  const stain = smoothstep(0.05, 0.75, mx_noise_float(positionWorld.mul(0.11).add(vec3(face.x, 0, face.y)))).mul(0.6);
  const dirt = splash.mul(0.32).add(streak.mul(0.28)).add(stain.mul(0.14)).mul(float(1).add(wetness.mul(0.35)));
  const grimy = albedo.mul(float(1).sub(dirt)).mul(mix(vec3(1), vec3(0.9, 0.95, 0.8), splash.mul(0.6)));

  // Posters on the piers beside ground-floor windows, on a third of them.
  const ground = step(cell.y, 0.5).mul(step(-0.5, cell.y));
  const posterHere = step(hash(cell.add(face), 3), 0.33).mul(ground);
  const pu = f.x.sub(0.05).div(0.18);
  const pv = f.y.sub(0.33).div(0.47);
  // Torn, curling edges: the rectangle's border eaten by noise.
  const tear = mx_noise_float(vec2(alongM.mul(9), heightM.mul(9))).mul(0.06);
  const inside = smoothstep(0, 0.02, pu.add(tear)).mul(smoothstep(1, 0.98, pu.sub(tear))).mul(smoothstep(0, 0.02, pv.add(tear))).mul(smoothstep(1, 0.98, pv.sub(tear)));
  const poster = inside.mul(posterHere).mul(wall);
  const hp = hash(cell.add(face), 7);
  const paperCol = mix(vec3(0.75, 0.72, 0.62), vec3(0.62, 0.68, 0.72), step(0.5, hp));
  const inkA = mix(vec3(0.6, 0.12, 0.08), vec3(0.08, 0.2, 0.45), step(0.4, fract(hp.mul(5.3))));
  const inkB = mix(vec3(0.12, 0.12, 0.12), vec3(0.75, 0.55, 0.1), step(0.6, fract(hp.mul(9.1))));
  // Abstract print: a disc, a band, and lines of "type" too small to read.
  const disc = float(1).sub(smoothstep(0.22, 0.24, vec2(pu.sub(0.5), pv.sub(0.62).mul(1.6)).length()));
  const band = step(pv, 0.28).mul(step(0.08, pv));
  const lines = step(0.5, fract(pv.mul(38))).mul(step(pv, 0.24)).mul(step(0.12, pu)).mul(step(pu, 0.88)).mul(step(0.12, pv));
  let print = mix(paperCol, inkA, disc);
  print = mix(print, inkB, band.mul(float(1).sub(lines.mul(0.8))));
  // Sun-faded and grimy like the wall under it.
  print = mix(print, vec3(0.7, 0.68, 0.6), 0.3).mul(float(1).sub(dirt.mul(0.6)));

  // Graffiti: spray strokes on some 6 m stretches of the ground floor, below 1.7 m, never on glass.
  const stretch = floor(alongM.div(6));
  const tagged = step(hash(vec2(stretch, face.x.add(face.y)), 11), 0.3).mul(float(1).sub(smoothstep(1.4, 1.75, heightM)));
  const n = mx_noise_float(vec2(alongM.mul(1.2), heightM.mul(1.9)).add(vec2(stretch.mul(3.7), 0)));
  const stroke = float(1).sub(smoothstep(0.015, 0.045, abs(n.sub(0.12))));
  const n2 = mx_noise_float(vec2(alongM.mul(2.1), heightM.mul(2.6)).add(vec2(9.1, stretch)));
  const fill = smoothstep(0.32, 0.36, n2).mul(0.85);
  const hg = hash(vec2(stretch, 5), 13);
  const sprayA = mix(vec3(0.05, 0.05, 0.06), vec3(0.65, 0.08, 0.35), step(0.5, hg));
  const sprayB = mix(vec3(0.85, 0.85, 0.82), vec3(0.1, 0.45, 0.6), step(0.35, fract(hg.mul(4.7))));
  const graffiti = tagged.mul(wall).mul(float(1).sub(poster));
  let colour = mix(grimy, sprayB, fill.mul(graffiti));
  colour = mix(colour, sprayA, stroke.mul(graffiti));
  colour = mix(colour, print, poster);
  return { colour: mix(albedo, colour, wall), paper: max(poster, float(0)) };
}
