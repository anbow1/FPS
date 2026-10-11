import { attribute, cameraPosition, clamp, dot, float, floor, Fn, fract, length, max, mix, mx_noise_float, normalize, positionWorld, pow, reflect, sin, smoothstep, transformNormalToView, uniform, vec2, vec3, viewportSharedTexture } from 'three/tsl';
import { BufferAttribute, BufferGeometry, Mesh, MeshPhysicalNodeMaterial, type Node } from 'three/webgpu';
import { CITY_SCALE } from '../maps/builder.ts';
import type { MapData } from '../maps/types.ts';
import { screenReflectionHit } from './screenReflection.ts';

// The wet street after (and in) the rain, as a thin layer of water over the
// roads and pavements, drawn after the opaque scene so it can see it:
//
//   puddles   where the road's camber and the noise put standing water —
//             along the gutters, in dips, rarely on the crown; on the slabs, in
//             small hollows. A puddle is a mirror: near-zero roughness, the
//             asphalt seen through it a little darker, and Fresnel deciding
//             between the two (water F0 0.02, so it mirrors mostly at the
//             grazing angles you look along a street at);
//   film      between the puddles the asphalt is only wet: the base material
//             already darkens it and adds a clearcoat for the sky; here the
//             scene's own reflection is added, smeared along the screen's
//             vertical — on a rough wet road the reflection of a lamp or a
//             shop window is a long streak, not an image;
//   rings     raindrops hitting the water: per-cell rings that start where a
//             drop lands, spread and fade, on two staggered grids; strong in
//             puddles, faint on the film.
//
// Reflections: on High the scene where the screen holds it (screenReflection.ts,
// the lake's own march), the environment probe and the sun's highlight
// elsewhere; on Low the probe and the sun only. Everything is driven by two
// uniforms, so switching weather never recompiles.

/** 0 dry … 1 soaked: how much standing water there is. */
export const puddleAmount = uniform(0);
/** 0 … 1: how hard it is raining now (the rings). */
export const rainRate = uniform(0);
/** Game time (s) for the rings. */
export const wetTime = uniform(0);

const LIFT_M = 0.006; // over the asphalt, under nothing: road paint sits at 0.004

interface Strip {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
  /** Across-road coordinate at the strip's two long edges (m from the crown), for the gutters. */
  across: [number, number];
  alongZ: boolean;
}

/** Road strips (junction squares only once) and pavement tops of the city. */
function strips(map: MapData): Strip[] {
  const out: Strip[] = [];
  const zRoads = map.roads.filter((r) => r.a.x === r.b.x);
  const xRoads = map.roads.filter((r) => r.a.z === r.b.z);
  for (const r of zRoads) {
    const h = r.widthM / 2;
    out.push({ x0: r.a.x - h, x1: r.a.x + h, z0: r.a.z, z1: r.b.z, y: LIFT_M, across: [-h, h], alongZ: true });
  }
  for (const r of xRoads) {
    const h = r.widthM / 2;
    // Split at the crossings with the roads along z: those squares are already covered.
    const cuts = zRoads.map((z) => [z.a.x - z.widthM / 2, z.a.x + z.widthM / 2] as const).sort((a, b) => a[0] - b[0]);
    let from = r.a.x;
    for (const [c0, c1] of cuts) {
      if (c1 <= from || c0 >= r.b.x) continue;
      if (c0 > from) out.push({ x0: from, x1: c0, z0: r.a.z - h, z1: r.a.z + h, y: LIFT_M, across: [-h, h], alongZ: false });
      from = Math.max(from, c1);
    }
    if (from < r.b.x) out.push({ x0: from, x1: r.b.x, z0: r.a.z - h, z1: r.a.z + h, y: LIFT_M, across: [-h, h], alongZ: false });
  }
  for (const b of map.boxes) {
    if (b.look !== 'pavement') continue;
    const top = b.center.y + b.size.y / 2 + LIFT_M;
    // No gutters on the slabs: puddles there come from the noise alone.
    out.push({ x0: b.center.x - b.size.x / 2, x1: b.center.x + b.size.x / 2, z0: b.center.z - b.size.z / 2, z1: b.center.z + b.size.z / 2, y: top, across: [0, 0], alongZ: true });
  }
  return out;
}

function geometry(list: Strip[]): BufferGeometry {
  const pos: number[] = [];
  const across: number[] = [];
  const idx: number[] = [];
  for (const s of list) {
    const base = pos.length / 3;
    pos.push(s.x0, s.y, s.z0, s.x1, s.y, s.z0, s.x1, s.y, s.z1, s.x0, s.y, s.z1);
    // Corners 0..3: across runs over x for strips along z, over z for strips along x.
    if (s.alongZ) across.push(s.across[0], s.across[1], s.across[1], s.across[0]);
    else across.push(s.across[0], s.across[0], s.across[1], s.across[1]);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('across', new BufferAttribute(new Float32Array(across), 1));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A cheap per-cell hash in [0, 1) that is fine for negative coordinates (TSL's hash() is not). */
const cellHash = (c: Node<'vec2'>, k: number): Node<'float'> => fract(sin(dot(c, vec2(12.9898 + k * 1.37, 78.233 + k * 2.71)).add(k * 0.618)).mul(43758.5453));

/**
 * Slope (xz) of the rain rings at world position `p`: on a grid of `cellM` cells, each cell has one drop
 * landing at a random point and phase per cycle; its ring runs outwards over the cycle and fades.
 */
const ringLayer = (p: Node<'vec2'>, cellM: number, periodS: number, seed: number, time: Node<'float'>): Node<'vec2'> => {
  const q = p.div(cellM);
  const cell = floor(q);
  const phase = cellHash(cell, seed);
  const t = fract(time.div(periodS).add(phase));
  // A new landing point each cycle.
  const cycle = floor(time.div(periodS).add(phase));
  const centre = vec2(cellHash(cell.add(cycle), seed + 1), cellHash(cell.add(cycle), seed + 2)).mul(0.7).add(0.15);
  const d = q.sub(cell).sub(centre);
  const r = length(d).mul(cellM);
  const radius = t.mul(cellM * 0.45);
  const x = r.sub(radius);
  // One crest and one trough round the expanding radius; gone by the end of the cycle.
  const wave = sin(x.mul(70)).mul(smoothstep(0.03, 0.0, x.abs()));
  const fade = pow(float(1).sub(t), 2);
  return normalize(d.add(1e-5)).mul(wave.mul(fade));
};

export function buildWetStreet(map: MapData, quality: 'high' | 'low'): Mesh {
  const m = new MeshPhysicalNodeMaterial({ name: 'wetStreet', transparent: true, depthWrite: false, metalness: 0 });
  const p = positionWorld;
  const V = normalize(cameraPosition.sub(p));
  const dist = length(cameraPosition.sub(p));

  // ---- where water stands: gutters by the kerbs, dips from two octaves of noise
  const across = attribute('across', 'float').abs();
  const gutter = smoothstep(CITY_SCALE.laneM * 1.25, CITY_SCALE.laneM * 1.9, across);
  const dips = mx_noise_float(p.xz.mul(1 / 7.5)).mul(0.65).add(mx_noise_float(p.xz.mul(1 / 2.2).add(17)).mul(0.35));
  const level = dips.add(gutter.mul(0.5)).add(puddleAmount.mul(0.5)).sub(0.84);
  const puddle = smoothstep(0.0, 0.1, level).mul(puddleAmount);
  // A dark, thin rim of soaked asphalt round each puddle.
  const rim = smoothstep(-0.08, 0.0, level).mul(float(1).sub(puddle)).mul(puddleAmount);

  // ---- rain rings: strong on standing water, faint on the film; faded with distance (sub-pixel there)
  const rings = ringLayer(p.xz, 0.45, 0.9, 3, wetTime).add(ringLayer(p.xz.add(vec2(0.21, 0.13)), 0.33, 0.75, 11, wetTime));
  const ringK = rainRate.mul(mix(float(0.25), float(1), puddle)).mul(smoothstep(25, 6, dist)).mul(0.35);
  const N = normalize(vec3(rings.x.mul(ringK).negate(), 1, rings.y.mul(ringK).negate()));
  m.normalNode = transformNormalToView(N);

  const NdotV = clamp(dot(N, V), 0.001, 1);
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), float(5))));
  const R = reflect(V.negate(), N);

  // ---- the scene: the asphalt behind (seen through the water) and, on High, its reflection
  const sceneTex = viewportSharedTexture();
  const behind = sceneTex.rgb;
  let mirror: Node<'vec3'> = vec3(0);
  let streak: Node<'vec3'> = vec3(0);
  let mirrored: Node<'float'> = float(0);
  if (quality === 'high') {
    const hit = screenReflectionHit(p, normalize(vec3(R.x, max(R.y, 0.004), R.z)));
    mirrored = hit.weight;
    mirror = sceneTex.sample(hit.uv).rgb;
    // Rough wet asphalt: the reflection smeared along the screen's vertical (towards the viewer), so
    // a bright window or a lamp stretches into a streak. Seven taps, wider further away.
    streak = Fn(() => {
      const acc = vec3(0).toVar('wetStreak');
      const span = float(0.012).add(smoothstep(4, 40, dist).mul(0.02));
      for (let i = -3; i <= 3; i++) acc.addAssign(sceneTex.sample(hit.uv.add(vec2(0, span.mul(i)))).rgb.mul(1 / 7));
      return acc;
    })();
  }
  const film = float(1).sub(puddle).mul(puddleAmount);
  // Puddle: the asphalt under ~1 cm of water is a little darker; the mirror takes over by Fresnel.
  const under = behind.mul(mix(float(1), float(0.82), puddle)).mul(float(1).sub(rim.mul(0.12)));
  m.colorNode = vec3(0);
  m.roughnessNode = mix(float(0.12), float(0.02), puddle);
  // The probe's sky and the sun's highlight where the screen has nothing to mirror, on the water only.
  m.specularIntensityNode = puddle.mul(float(1).sub(mirrored));
  m.emissiveNode = under
    .mul(float(1).sub(fresnel.mul(puddle)))
    .add(mirror.mul(fresnel).mul(mirrored).mul(puddle))
    .add(streak.mul(mirrored).mul(fresnel.mul(0.5).add(0.04)).mul(film));
  // Drawn wherever the street is wet; nothing at all when it is dry.
  m.opacityNode = smoothstep(0.0, 0.05, puddleAmount);
  const mesh = new Mesh(geometry(strips(map)), m);
  mesh.name = 'wetStreet';
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}
