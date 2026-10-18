import { attribute, float, mix, mx_noise_float, positionLocal, positionWorld, sin, smoothstep, texture, vec3 } from 'three/tsl';
import { DoubleSide, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { tileFbm, tileFbmXY, tileNoise, tileNoiseXY } from '../core/noise.ts';
import { makeTextureSet, type Texel, type TexelSampler, type TextureSet } from './textureSet.ts';
import * as F from './foliagePatterns.ts';
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

/**
 * Sawn boards, grain along U. `weathered` 0…1: how far the sun and salt have bleached them silver-grey, the
 * soft earlywood worn back between the hard latewood lines (a dock's boards in the island shooter we
 * compared against are all but grey). Growth rings run along the board, wandering, a long check or two
 * splits it along the grain, and now and then a knot. Every noise tiles with its own period per axis: one
 * period for both repeated the pattern across the board six times over (rows of identical ovals).
 */
function boardWood(colour: number, weathered = 0.6): TexelSampler {
  const c = hex(colour);
  const grey = hex(0x8a8073);
  const knots = [0, 1, 2].map((k) => ({ u: hash2(k, 1, 317), v: hash2(k, 2, 317), r: 0.012 + hash2(k, 3, 317) * 0.012, on: hash2(k, 4, 317) < 0.5 }));
  return (u, v, t) => {
    // Rings: bands across the board, their phase pushed about along it (the figure of a flat-sawn board).
    // ~6 rings across a board (a board samples a quarter of the tile across).
    const wander = tileFbmXY(u * 2, v * 3, 2, 3, 3, 301) * 4;
    let ringPhase = v * 26 + wander;
    // A knot bends the rings round itself.
    let knot = 0;
    for (const K of knots) {
      if (!K.on) continue;
      const du = Math.min(Math.abs(u - K.u), 1 - Math.abs(u - K.u)) / 6;
      const dv = Math.min(Math.abs(v - K.v), 1 - Math.abs(v - K.v));
      const d = Math.hypot(du, dv);
      knot = Math.max(knot, Math.max(0, 1 - d / K.r));
      ringPhase += Math.exp(-((d / (K.r * 3)) ** 2)) * 2.5;
    }
    const ring = ringPhase - Math.floor(ringPhase);
    const late = Math.max(0, 1 - Math.abs(ring - 0.15) / 0.09); // the hard latewood line
    const fibre = tileNoiseXY(u * 6, v * 160, 6, 160, 303);
    const tone = tileFbmXY(u * 1, v * 2, 1, 2, 3, 305);
    // Checks: a few long splits along the grain.
    const split = Math.abs(tileFbmXY(u * 1, v * 14, 1, 14, 2, 307) - 0.5) < 0.0045 + weathered * 0.0025;
    // Greying comes on late: a part-weathered board is still brown, a dock's is silver.
    const weather = Math.min(1, weathered * weathered * (0.6 + tone * 0.6));
    const col: Rgb = [c[0] + (grey[0] - c[0]) * weather, c[1] + (grey[1] - c[1]) * weather, c[2] + (grey[2] - c[2]) * weather];
    // Weathered wood shows its latewood as dark lines in a pale, eroded earlywood.
    let k = 0.86 + tone * 0.2 + fibre * 0.08 - late * (0.12 + weathered * 0.12);
    k *= 1 - knot * 0.55;
    if (split) k *= 0.45;
    put(t, col, k);
    t.height = split ? 0.05 : 0.5 + late * 0.25 * (0.5 + weathered) + fibre * 0.1 - knot * 0.1;
    t.rough = 0.78 + fibre * 0.1 + weathered * 0.06;
    t.ao = split ? 0.55 : 1;
  };
}

/** Army canvas: faded olive, water stains, a darker seam line. */
function canvas(colour: number): TexelSampler {
  const c = hex(colour);
  return (u, v, t) => {
    const wu = Math.sin(u * Math.PI * 2 * 96);
    const wv = Math.sin(v * Math.PI * 2 * 96);
    const weave = (wu + wv) * 0.25 + 0.5;
    const stain = tileFbm(u * 3, v * 3, 3, 4, 311);
    const fade = tileFbmXY(u * 2, v * 2, 2, 2, 3, 313);
    const seam = Math.abs(((v * 3) % 1) - 0.5) > 0.485;
    put(t, c, (0.88 + fade * 0.25 - Math.max(0, stain - 0.6) * 0.5 + weave * 0.05) * (seam ? 0.7 : 1));
    t.height = seam ? 0.2 : weave * 0.6;
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

function standard(ts: TextureSet, name: string, wetDarken = 0.6): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, normalMap: ts.normalMap, metalness: 0 });
  m.colorNode = texture(ts.map).rgb.mul(mix(float(1), float(wetDarken), U.wetness.mul(outdoor())));
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
function pileMaterial(ts: TextureSet): MeshStandardNodeMaterial {
  const m = standard(ts, 'dock pile');
  const y = positionWorld.y;
  // A ragged line: the swash reaches higher in places.
  const line = float(0.32).add(mx_noise_float(positionWorld.mul(vec3(3, 0, 3))).mul(0.08));
  const wet = smoothstep(line, line.sub(0.12), y);
  const algae = smoothstep(0.05, -0.2, y);
  const spots = smoothstep(0.35, 0.55, mx_noise_float(positionWorld.mul(vec3(55, 70, 55))));
  const crust = smoothstep(line.add(0.02), line.sub(0.08), y).mul(smoothstep(-0.35, -0.05, y)).mul(spots);
  const bark = texture(ts.map).rgb;
  let c = mix(bark, bark.mul(vec3(0.32, 0.36, 0.3)), wet);
  c = mix(c, vec3(0.04, 0.06, 0.035), algae.mul(0.7));
  c = mix(c, vec3(0.55, 0.53, 0.48), crust);
  m.colorNode = c.mul(mix(float(1), float(0.6), U.wetness));
  m.roughnessNode = mix(mix(texture(ts.ormMap).g, float(0.35), wet.mul(float(1).sub(crust))), float(0.3), U.wetness);
  return m;
}

/** Rain wets what the tarp does not cover: geometry marks sheltered parts with `dry` = 1. */
function outdoor() {
  return float(1).sub(attribute('dry', 'float'));
}

function fabricMaterial(ts: TextureSet, name: string, sheenColour: number, flutter: boolean): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name, normalMap: ts.normalMap, side: DoubleSide, sheen: 0.6, sheenRoughness: 0.7, sheenColor: sheenColour, metalness: 0 });
  m.colorNode = texture(ts.map).rgb.mul(mix(float(1), float(0.55), U.wetness.mul(outdoor())));
  m.roughnessNode = mix(texture(ts.ormMap).g, float(0.55), U.wetness.mul(outdoor()));
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
  if (kind === 'boards') return standard(tset('weatheredBoard', 256, () => boardWood(0x6a5a48, 1), 3.5), name);
  return fabricMaterial(tset('cotCanvas', 256, () => canvas(0x6a6a50), 1.5), name, 0x6a6a50, false);
}

export function propMaterials(): PropMaterials {
  if (cached) return cached;
  const glass = new MeshPhysicalNodeMaterial({ name: 'lantern glass', color: 0xf2eee0, roughness: 0.08, metalness: 0, transmission: 0, transparent: true, opacity: 0.35, ior: 1.5 });
  cached = {
    planks: standard(tset('board', 256, () => boardWood(0x6f5d48), 3), 'planks'),
    weatheredPlanks: standard(tset('weatheredBoard', 256, () => boardWood(0x6a5a48, 1), 3.5), 'weathered planks'),
    darkWood: standard(tset('darkBoard', 256, () => boardWood(0x4e3c2c), 3), 'dark wood'),
    logBark: standard(tset('logBark', 256, F.jungleBark, 4), 'log bark'),
    piles: pileMaterial(tset('logBark', 256, F.jungleBark, 4)),
    rustyIron: new MeshStandardNodeMaterial({ name: 'rusty iron', color: 0x3d281c, roughness: 0.85, metalness: 0 }),
    bamboo: standard(tset('bamboo', 256, bamboo, 2), 'bamboo', 0.7),
    tarp: fabricMaterial(tset('canvas', 512, () => canvas(0x5d5e44), 1.5), 'tarp', 0x5d5e44, true),
    cotCanvas: fabricMaterial(tset('cotCanvas', 256, () => canvas(0x6a6a50), 1.5), 'cot canvas', 0x6a6a50, false),
    hides: [0x7a5a3a, 0x6a4a30, 0x8a6a48].map((c, i) => {
      const ts = tset(`hide${i}`, 256, () => hide(c, i * 3 + 1), 3, true);
      const m = standard(ts, `hide ${i}`, 0.7);
      m.side = DoubleSide;
      m.alphaTest = 0.5;
      m.opacityNode = texture(ts.map).a;
      return m;
    }),
    rope: standard(tset('rope', 128, rope, 3), 'rope'),
    blanket: fabricMaterial(tset('blanket', 256, blanket, 1.5), 'blanket', 0x6e3a2e, false),
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
