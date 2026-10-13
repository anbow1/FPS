import { abs, dot, float, floor, fract, length, max, min, mix, mx_noise_float, positionWorld, select, sin, smoothstep, step, vec2 } from 'three/tsl';
import type { MeshPhysicalNodeMaterial, Node } from 'three/webgpu';
import { CITY_ROADS } from '../maps/city.ts';

// What a city road shows besides its aggregate: the history of the traffic
// and the repairs. Wheel paths polished darker down each lane; rectangles of
// newer, blacker asphalt where it was dug up, with a sealed seam round them;
// old cracks filled with bitumen, black and shiny; oil drips in the parking
// lane; cast-iron manhole covers in the lanes and gully gratings at the kerb.
// All in the shader, in world metres along and across the street grid, so
// none of it repeats with the 2 m texture.

function hash(a: Node<'vec2'>, k: number): Node<'float'> {
  return fract(sin(dot(a, vec2(12.9898 + k * 1.7, 78.233 + k * 0.91))).mul(43758.5453));
}

function box(p: Node<'vec2'>, x0: Node<'float'> | number, y0: Node<'float'> | number, x1: Node<'float'> | number, y1: Node<'float'> | number): Node<'float'> {
  return step(x0, p.x).mul(step(p.x, x1)).mul(step(y0, p.y)).mul(step(p.y, y1));
}

/** Signed distance across the nearest road of the grid (the city's centres are symmetric about 0). */
function across(coord: Node<'float'>): Node<'float'> {
  const m = abs(coord);
  const [a, b] = CITY_ROADS.centresM;
  return select(abs(m.sub(a)).lessThan(abs(m.sub(b))), m.sub(a), m.sub(b));
}

/** Adds the road's wear and furniture to the city's asphalt material (its colour and roughness nodes). */
export function cityRoad(m: MeshPhysicalNodeMaterial): void {
  const p = positionWorld.xz;
  const half = CITY_ROADS.widthM / 2;
  const ax = across(p.x); // on a road running along Z
  const az = across(p.y); // on a road running along X
  const inGrid = step(max(abs(p.x), abs(p.y)), CITY_ROADS.edgeM);
  const onZ = step(abs(ax), half).mul(inGrid);
  const onX = step(abs(az), half).mul(inGrid);
  const junction = onZ.mul(onX);
  // The road we are on: its across and along coordinates (junctions take the Z road's, and lose the lanes).
  const a = select(onZ.greaterThan(0.5), ax, az);
  const along = select(onZ.greaterThan(0.5), p.y, p.x);
  const road = max(onZ, onX);
  const lanes = road.mul(float(1).sub(junction));
  const aa = abs(a);

  // Wheel paths: two per lane, 0.8 m either side of its centre; the outer lane is parking, barely driven.
  const path = (c: number, w: number): Node<'float'> => smoothstep(0.42, 0.12, abs(aa.sub(c))).mul(w);
  const wheels = max(max(path(0.95, 1), path(2.55, 1)), max(path(4.45, 0.35), path(6.05, 0.2))).mul(lanes);

  // Repairs: rectangles of newer asphalt in a 7 m lattice, with a sealed seam.
  const cell = floor(p.div(7));
  const local = fract(p.div(7));
  const hc = hash(cell, 1);
  const x0 = hash(cell, 2).mul(0.35);
  const y0 = hash(cell, 3).mul(0.35);
  const x1 = x0.add(mix(float(0.25), float(0.6), hash(cell, 4)));
  const y1 = y0.add(mix(float(0.2), float(0.6), hash(cell, 5)));
  const inPatch = box(local, x0, y0, x1, y1).mul(step(hc, 0.2)).mul(road);
  const seamW = 0.035 / 7;
  const seam = inPatch.mul(float(1).sub(box(local, x0.add(seamW), y0.add(seamW), x1.sub(seamW), y1.sub(seamW))));
  // An older, sun-faded patch is greyer, not blacker.
  const faded = step(0.5, hash(cell, 6));

  // Cracks, sealed with bitumen: thin meandering lines where the low-frequency mask allows.
  const warp = mx_noise_float(p.mul(0.13)).mul(2.5);
  const crackField = mx_noise_float(p.mul(0.33).add(warp));
  const crackMask = smoothstep(0.15, 0.55, mx_noise_float(p.mul(0.04).add(17.3)));
  const crack = float(1).sub(smoothstep(0.004, 0.016, abs(crackField))).mul(crackMask).mul(road);

  // Oil drips under parked cars: the parking lane, in blotches.
  const parking = smoothstep(4.9, 5.4, aa).mul(smoothstep(6.95, 6.6, aa)).mul(lanes);
  const oil = smoothstep(0.45, 0.8, mx_noise_float(p.mul(0.9).add(5.1))).mul(parking);

  // Manhole covers: one in a lane centre every 18–30 m, alternating sides at random.
  const k = floor(along.div(24));
  const hk = hash(vec2(k, select(onZ.greaterThan(0.5), float(1), float(2))), 7);
  const centreAlong = k.mul(24).add(5).add(hk.mul(14));
  const side = select(hash(vec2(k, 3), 8).greaterThan(0.5), float(1.75), float(-1.75));
  const dm = length(vec2(along.sub(centreAlong), a.sub(side)));
  const hasCover = step(hk, 0.75).mul(lanes);
  const cover = step(dm, 0.32).mul(hasCover);
  const rim = step(dm, 0.32).mul(step(0.28, dm)).mul(hasCover);
  // The lid's cast pattern: raised studs on a square grid.
  const stud = step(0.55, fract(along.mul(16))).mul(step(0.55, fract(a.mul(16))));

  // Gully gratings at the kerb, every 20 m: slots across a cast frame.
  const g = fract(along.div(20).add(0.37)).mul(20);
  const grate = box(vec2(g, aa), float(0), float(half - 0.42), float(0.6), float(half - 0.02)).mul(lanes);
  const slot = step(0.45, fract(g.mul(12)));

  const tone = float(1)
    .add(mx_noise_float(p.mul(0.035)).mul(0.07))
    .add(mx_noise_float(p.mul(0.21).add(3.3)).mul(0.04));
  const wear = mix(float(1), float(0.84), wheels);
  const patchTone = mix(float(1), mix(float(0.74), float(1.1), faded), inPatch);
  const dark = min(min(float(1).sub(seam.mul(0.55)), float(1).sub(crack.mul(0.6))), float(1).sub(oil.mul(0.45)));
  const iron = mix(float(0.35), float(0.5), stud);
  const grateTone = mix(float(0.4), float(0.08), slot);
  const factor = mix(mix(tone.mul(wear).mul(patchTone).mul(dark), iron.mul(mix(float(1), float(0.6), rim)), cover), grateTone, grate);
  m.colorNode = (m.colorNode as Node<'vec3'>).mul(factor);
  // Polished paths and fresh bitumen are smoother; the oil a little glossy; iron rougher than the polish.
  const roughDelta = wheels.mul(-0.1).sub(crack.mul(0.35)).sub(oil.mul(0.25)).sub(inPatch.mul(float(1).sub(faded)).mul(0.05)).add(cover.mul(-0.15)).add(grate.mul(0.05));
  m.roughnessNode = (m.roughnessNode as Node<'float'>).add(roughDelta).clamp(0.08, 1);
}
