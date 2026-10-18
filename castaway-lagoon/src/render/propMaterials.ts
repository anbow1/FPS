import { attribute, float, mix, mx_noise_float, normalMap, positionLocal, positionWorld, sin, smoothstep, texture, uv, vec2, vec3 } from 'three/tsl';
import { DoubleSide, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { tileFbm, tileFbmXY, tileNoise, tileNoiseXY } from '../core/noise.ts';
import { makeTextureSet, type Texel, type TexelSampler, type TextureSet } from './textureSet.ts';
import { type PhotoSet, photoSet, photoTextureSet, WEAVE_SIZE_M, weaveSet } from './photoTextures.ts';
import { hash2, hex } from './patterns.ts';
import { U } from './uniforms.ts';

// Materials for the outpost and the objects in it. Values follow the PBR
// sheet: weathered wood #6B5A47-ish rough 0.85, canvas and uniform fabric
// #5A5E48 rough 0.9 with sheen, painted steel metal 0 (paint is a dielectric),
// bare steel and brass metal 1 only where the paint has worn through.

type Rgb = [number, number, number];
const sets = new Map<string, TextureSet>();

function tset(key: string, size: number, s: () => TexelSampler, normal: number, alpha = false): TextureSet {
  let v = sets.get(key);
  if (!v) {
    v = makeTextureSet(size, s(), normal, alpha);
    sets.set(key, v);
  }
  return v;
}

function put(t: Texel, c: Rgb, k: number): void {
  t.r = c[0] * k;
  t.g = c[1] * k;
  t.b = c[2] * k;
}

/** Army canvas: faded olive, water stains, a darker seam line. The weave itself is photographed (fabricMaterial). */
function canvas(colour: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const stain = tileFbm(u * 3, v * 3, 3, 4, 311);
    const fade = tileFbmXY(u * 2, v * 2, 2, 2, 3, 313);
    const seam = Math.abs(((v * 3) % 1) - 0.5) > 0.485;
    put(t, c, (0.9 + fade * 0.25 - Math.max(0, stain - 0.6) * 0.5) * (seam ? 0.7 : 1));
    t.height = seam ? 0.2 : 0.6;
    t.rough = 0.92;
  };
}

/** A stretched pelt: short fur, darker along the spine, irregular outline with legs. */
function hide(colour: number, seed: number): TexelSampler {
  const c = hex(colour);
  const spine = hex(0x3a2a1c);
  return (u, v, t) => {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const legs = Math.max(0, Math.cos(Math.atan2(y, x) * 4 + seed)) ** 6 * 0.35;
    const edge = 0.72 + tileFbm(u * 4, v * 4, 4, 3, 321 + seed) * 0.22 + legs;
    const r = Math.hypot(x * 1.05, y * 0.85);
    if (r > edge) {
      t.alpha = 0;
      t.r = c[0];
      t.g = c[1];
      t.b = c[2];
      return;
    }
    const fur = tileNoiseXY(u * 180, v * 60, 180, 60, 323 + seed);
    const patch = tileFbm(u * 5, v * 5, 5, 3, 325 + seed);
    const dark = Math.exp(-(x * x) / 0.05) * 0.6;
    const col: Rgb = [c[0] + (spine[0] - c[0]) * dark, c[1] + (spine[1] - c[1]) * dark, c[2] + (spine[2] - c[2]) * dark];
    const rim = r > edge - 0.05 ? 0.7 : 1; // dried, darker edge where it was scraped
    put(t, col, (0.75 + fur * 0.35 + patch * 0.15) * rim);
    t.alpha = 1;
    t.height = fur * 0.7 + patch * 0.3;
    t.rough = 0.95;
  };
}

/** Bamboo culm: nodes every ~0.3 m, glossy yellow-green-brown skin. u around, v along. */
function bamboo(): TexelSampler {
  const c = hex(0x9a8a52);
  const node = hex(0x5e5232);
  return (u, v, t) => {
    const nd = Math.abs(((v * 3 + hash2(Math.floor(u * 4), 0, 5) * 0.1) % 1) - 0.5) > 0.47;
    const streak = tileNoiseXY(u * 48, v * 4, 48, 4, 331);
    put(t, nd ? node : c, 0.85 + streak * 0.25);
    t.height = nd ? 1 : 0.5;
    t.rough = nd ? 0.8 : 0.5;
  };
}

/** Twisted three-strand rope. */
function rope(): TexelSampler {
  const c = hex(0xb09a6e);
  return (u, v, t) => {
    const twist = Math.sin((u * 3 + v * 12) * Math.PI * 2);
    const fibre = tileNoise(u * 64, v * 64, 64, 341);
    put(t, c, 0.75 + (twist * 0.5 + 0.5) * 0.3 + fibre * 0.1);
    t.height = twist * 0.5 + 0.5;
    t.rough = 0.95;
  };
}

/** Wool blanket: faded red-brown with two cream stripes. */
function blanket(): TexelSampler {
  const c = hex(0x6e3a2e);
  const stripe = hex(0xc8b89a);
  return (u, v, t) => {
    const s = Math.abs(((v * 2) % 1) - 0.18) < 0.035;
    const fuzz = tileNoise(u * 128, v * 128, 128, 351);
    put(t, s ? stripe : c, 0.85 + fuzz * 0.25);
    t.height = fuzz;
    t.rough = 0.98;
  };
}

/** Olive paint on steel, chipped to bright metal at the edges and scratches. */
function paintedSteel(colour: number): TexelSampler {
  const c = hex(colour);
  const bare = hex(0xb8b8b6);
  return (u, v, t) => {
    const chip = tileFbm(u * 8, v * 8, 8, 4, 361);
    const scratch = Math.abs(tileFbmXY(u * 30, v * 2, 30, 2, 2, 363) - 0.5) < 0.01;
    const worn = chip > 0.72 || scratch;
    put(t, worn ? bare : c, worn ? 1 : 0.85 + tileNoise(u * 64, v * 64, 64, 365) * 0.2);
    t.metal = worn ? 1 : 0;
    t.rough = worn ? 0.35 : 0.62;
    t.height = worn ? 0 : 0.5;
  };
}

export interface PropMaterials {
  planks: MeshStandardNodeMaterial;
  /** Sun-and-salt-bleached boards for the dock. */
  weatheredPlanks: MeshStandardNodeMaterial;
  darkWood: MeshStandardNodeMaterial;
  logBark: MeshStandardNodeMaterial;
  /** The dock's piles: bark above the tide, black-green and wet below it, barnacles at the line. */
  piles: MeshStandardNodeMaterial;
  /** Nail heads and other iron left out in salt air. */
  rustyIron: MeshStandardNodeMaterial;
  bamboo: MeshStandardNodeMaterial;
  tarp: MeshPhysicalNodeMaterial;
  cotCanvas: MeshPhysicalNodeMaterial;
  hides: MeshStandardNodeMaterial[];
  rope: MeshStandardNodeMaterial;
  blanket: MeshPhysicalNodeMaterial;
  olivePaint: MeshStandardNodeMaterial;
  steel: MeshStandardNodeMaterial;
  glass: MeshPhysicalNodeMaterial;
  paper: MeshStandardNodeMaterial;
  charcoal: MeshStandardNodeMaterial;
  tin: MeshStandardNodeMaterial;
  plastic: MeshStandardNodeMaterial;
}

let cached: PropMaterials | null = null;

/** `gain` scales the albedo (linear): a scan photographed darker than the sun-bleached surface it stands for. */
function standard(ts: TextureSet, name: string, wetDarken = 0.6, gain = 1): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, normalMap: ts.normalMap, metalness: 0 });
  m.colorNode = texture(ts.map).rgb.mul(mix(float(gain), float(gain * wetDarken), U.wetness.mul(outdoor())));
  m.roughnessNode = mix(texture(ts.ormMap).g, float(0.3), U.wetness.mul(outdoor()));
  m.metalnessNode = texture(ts.ormMap).b;
  m.aoNode = texture(ts.ormMap).r;
  return m;
}

/**
 * Piles standing in the sea, after the jetty in an island shooter we compared against: what reads as a
 * real jetty is the tide's mark on its legs, not the wood — the water darkens and greens them up to the
 * high-tide line (sea level y = 0 plus the swash), and a crust of barnacles and dried salt rings them
 * where the waves break.
 */
function pileMaterial(P: PhotoSet): MeshStandardNodeMaterial {
  const m = photoStandard(P, 'dock pile');
  const y = positionWorld.y;
  // A ragged line: the swash reaches higher in places.
  const line = float(0.32).add(mx_noise_float(positionWorld.mul(vec3(3, 0, 3))).mul(0.08));
  const wet = smoothstep(line, line.sub(0.12), y);
  const algae = smoothstep(0.05, -0.2, y);
  const spots = smoothstep(0.35, 0.55, mx_noise_float(positionWorld.mul(vec3(55, 70, 55))));
  const crust = smoothstep(line.add(0.02), line.sub(0.08), y).mul(smoothstep(-0.35, -0.05, y)).mul(spots);
  const bark = texture(P.map).rgb;
  let c = mix(bark, bark.mul(vec3(0.32, 0.36, 0.3)), wet);
  c = mix(c, vec3(0.04, 0.06, 0.035), algae.mul(0.7));
  c = mix(c, vec3(0.55, 0.53, 0.48), crust);
  m.colorNode = c.mul(mix(float(1), float(0.6), U.wetness));
  m.roughnessNode = mix(mix(texture(P.roughnessMap).r, float(0.35), wet.mul(float(1).sub(crust))), float(0.3), U.wetness);
  return m;
}

/** A scanned surface (photoTextures.ts) with the same wetting as `standard`. */
function photoStandard(P: PhotoSet, name: string, wetDarken = 0.6): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, metalness: 0 });
  m.colorNode = texture(P.map).rgb.mul(mix(float(1), float(wetDarken), U.wetness.mul(outdoor())));
  m.normalNode = normalMap(texture(P.normalMap));
  m.roughnessNode = mix(texture(P.roughnessMap).r, float(0.3), U.wetness.mul(outdoor()));
  return m;
}

/** Rain wets what the tarp does not cover: geometry marks sheltered parts with `dry` = 1. */
function outdoor() {
  return float(1).sub(attribute('dry', 'float'));
}

/**
 * Canvas: the set's colour, stains and seams over the photographed weave (photoTextures.ts `weaveSet`),
 * `weave` repeats of it per UV unit — the threads' light and dark in the colour, their relief blended into
 * the seams' normal. A sine weave read as a printed grid up close. Null for a cloth that is not woven
 * canvas (the blanket's wool): the set alone.
 */
function fabricMaterial(ts: TextureSet, name: string, sheenColour: number, flutter: boolean, weave: readonly [number, number] | null): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name, side: DoubleSide, sheen: 0.6, sheenRoughness: 0.7, sheenColor: sheenColour, metalness: 0 });
  const wet = mix(float(1), float(0.55), U.wetness.mul(outdoor()));
  if (weave) {
    const w = weaveSet();
    const wuv = uv().mul(vec2(...weave));
    const thread = texture(w.detail, wuv);
    // The weave's albedo lies within ±12 % of its mean; a little more contrast keeps it at a few metres.
    const detail = thread.r.mul(2).sub(1).mul(1.6).add(1);
    m.colorNode = texture(ts.map).rgb.mul(detail).mul(wet);
    m.roughnessNode = mix(texture(ts.ormMap).g.mul(mix(float(1), thread.g.div(0.72), 0.5)).min(1), float(0.55), U.wetness.mul(outdoor()));
    // Whiteout blend of the two tangent-space normals: the seams' and the threads'.
    const n1 = texture(ts.normalMap).xyz.mul(2).sub(1);
    const n2 = texture(w.normalMap, wuv).xyz.mul(2).sub(1);
    m.normalNode = normalMap(vec3(n1.xy.add(n2.xy), n1.z.mul(n2.z)).normalize().mul(0.5).add(0.5));
  } else {
    m.normalMap = ts.normalMap;
    m.colorNode = texture(ts.map).rgb.mul(wet);
    m.roughnessNode = mix(texture(ts.ormMap).g, float(0.55), U.wetness.mul(outdoor()));
  }
  if (flutter) {
    // Cloth in the wind: a travelling ripple weighted by distance from the tie points (attribute `flap`).
    const flap = attribute('flap', 'float');
    const p = positionLocal;
    const wind = U.wind.length();
    const wave = sin(U.time.mul(float(3.2).add(wind.mul(0.25))).add(p.x.mul(2.1)).add(p.z.mul(1.7))).add(sin(U.time.mul(5.3).add(p.x.mul(4.3))).mul(0.4));
    m.positionNode = p.add(vec3(0, wave.mul(flap).mul(float(0.006).add(wind.mul(0.0035)).mul(U.gust.add(0.5))), 0));
  }
  return m;
}

/**
 * A prop surface on a material of its own, for a vehicle (the skiff's boards, the jeep's seats and load):
 * a vehicle's AO bake wires its materials to an `ao` attribute (aoBake.ts), which the camp's meshes on the
 * shared materials do not carry. Its meshes need `dry` (outpost.ts markDry) like every prop surface.
 */
export function vehicleMaterial(kind: 'boards' | 'canvas', name: string): MeshStandardNodeMaterial {
  if (kind === 'boards') return standard(photoTextureSet('wood_planks_grey'), name);
  // Seat cushions: box UVs, 0…1 across each ~0.3–0.5 m face.
  return fabricMaterial(tset('cotCanvas', 256, () => canvas(0x6a6a50), 1.5), name, 0x6a6a50, false, [1.6, 1.6]);
}

export function propMaterials(): PropMaterials {
  if (cached) return cached;
  const glass = new MeshPhysicalNodeMaterial({ name: 'lantern glass', color: 0xf2eee0, roughness: 0.08, metalness: 0, transmission: 0, transparent: true, opacity: 0.35, ior: 1.5 });
  cached = {
    // Scanned boards (photoTextures.ts), four planks to a texture, one per board. The deck's scan is a
    // temperate board (mean sRGB 0.38): under the shelter's roof it went near black, so it is bleached
    // toward the grey a tropical sun leaves (~0.47). The jetty's grey scan reads right in full sun as it is.
    planks: standard(photoTextureSet('old_planks_02'), 'planks', 0.6, 1.6),
    weatheredPlanks: standard(photoTextureSet('wood_planks_grey'), 'weathered planks'),
    darkWood: standard(photoTextureSet('weathered_planks'), 'dark wood'),
    logBark: photoStandard(photoSet('bark006'), 'log bark'),
    piles: pileMaterial(photoSet('bark006')),
    rustyIron: new MeshStandardNodeMaterial({ name: 'rusty iron', color: 0x3d281c, roughness: 0.85, metalness: 0 }),
    bamboo: standard(tset('bamboo', 256, bamboo, 2), 'bamboo', 0.7),
    // The weave at its real size: the tarp's one UV square is ~5.1 × 4.5 m (outpost.ts tarpGeometry), the
    // cot's bed ~1.9 × 0.7 m (its bags and pouches wrap less, so their threads come a little finer).
    tarp: fabricMaterial(tset('canvas', 512, () => canvas(0x5d5e44), 1.5), 'tarp', 0x5d5e44, true, [5.1 / WEAVE_SIZE_M, 4.5 / WEAVE_SIZE_M]),
    cotCanvas: fabricMaterial(tset('cotCanvas', 256, () => canvas(0x6a6a50), 1.5), 'cot canvas', 0x6a6a50, false, [1.9 / WEAVE_SIZE_M, 0.7 / WEAVE_SIZE_M]),
    hides: [0x7a5a3a, 0x6a4a30, 0x8a6a48].map((c, i) => {
      const ts = tset(`hide${i}`, 256, () => hide(c, i * 3 + 1), 3, true);
      const m = standard(ts, `hide ${i}`, 0.7);
      m.side = DoubleSide;
      m.alphaTest = 0.5;
      m.opacityNode = texture(ts.map).a;
      return m;
    }),
    rope: standard(tset('rope', 128, rope, 3), 'rope'),
    blanket: fabricMaterial(tset('blanket', 256, blanket, 1.5), 'blanket', 0x6e3a2e, false, null),
    olivePaint: standard(tset('olive', 256, () => paintedSteel(0x4b5033), 1), 'olive paint', 0.8),
    steel: new MeshStandardNodeMaterial({ name: 'steel', color: 0xbdbdbd, roughness: 0.32, metalness: 1 }),
    glass,
    paper: new MeshStandardNodeMaterial({ name: 'paper', color: 0xd8cfb8, roughness: 0.9, metalness: 0, side: DoubleSide }),
    charcoal: new MeshStandardNodeMaterial({ name: 'charcoal', color: 0x2a2826, roughness: 0.95, metalness: 0 }),
    tin: new MeshStandardNodeMaterial({ name: 'tin', color: 0xc8c8c4, roughness: 0.4, metalness: 1 }),
    plastic: new MeshStandardNodeMaterial({ name: 'plastic', color: 0x3a3d33, roughness: 0.6, metalness: 0 }),
  };
  return cached;
}
