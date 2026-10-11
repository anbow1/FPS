import { bumpMap, dot, float, floor, Fn, fract, If, mix, normalMap, normalWorld, normalWorldGeometry, positionWorld, sin, smoothstep, step, texture, triplanarTexture, uniform, uv, vec2, vec3 } from 'three/tsl';
import { DoubleSide, type Material, MeshPhysicalNodeMaterial, MeshSSSNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { CITY_LIGHTS } from '../config.ts';
import { cityNight, lampLightNode, lensGlowNode, lightPreExposure } from './cityLights.ts';
import { lightColour } from './colour.ts';
import type { BoxLook } from '../maps/types.ts';
import { skyVisibilityNode } from './interior.ts';
import * as P from './patterns.ts';
import * as PL from './plantPatterns.ts';
import { makeTextureSet, type TexelSampler, type TextureSet } from './textures.ts';

// One material per surface, values from pbr-material-reference.png. Standard
// material by default; physical only where clearcoat is needed (wet asphalt,
// car paint) or for glass (rules §3.1). Texture world size is how many metres
// one texture tile covers, used by the world builder's box UVs.

export interface LookMaterial {
  material: Material;
  tileM: number;
}

/** Wetness 0..1 for streets after rain: darker base, lower roughness, clearcoat (PBR sheet). */
export const wetness = uniform(0);
/** Scales ambient on interior-aware materials (viewmodel, soldiers): 1 outdoors, low indoors. */
export const interiorAmbient = uniform(1);

const cache = new Map<string, TextureSet>();

function set(key: string, size: number, sampler: () => TexelSampler, normalStrength: number, alphaCoverage = false): TextureSet {
  let s = cache.get(key);
  if (!s) {
    s = makeTextureSet(size, sampler(), normalStrength, alphaCoverage);
    cache.set(key, s);
  }
  return s;
}

function standard(ts: TextureSet, name: string, normalScale = 1): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, map: ts.map, normalMap: ts.normalMap, roughnessMap: ts.ormMap, metalnessMap: ts.ormMap, roughness: 1, metalness: 1 });
  m.normalScale.set(normalScale, normalScale);
  // AO (R channel) × sky visibility: indirect light only, dimmed inside buildings.
  m.aoNode = texture(ts.ormMap).r.mul(skyVisibilityNode());
  const lamps = lampLit(texture(ts.map).rgb);
  if (lamps) m.emissiveNode = lamps;
  return m;
}

/**
 * Foliage with a thin-translucency term (rules §3.1): MeshSSSNodeMaterial adds
 * it inside the direct-light loop, multiplied by the shadowed light colour, so
 * only leaves the sun actually reaches glow from behind — the golden-hour win
 * in the forest. Same texture set and AO as `standard`.
 */
/** Leaf translucency is off on the Low preset (phones): see `translucentLeaf`. Set by the view before building. */
export const FOLIAGE = { translucent: true };
/** The map has street lamps (the city): surfaces take their light at night. Set by the view before building. */
export const CITY = { lamps: false };

/**
 * The street lamps' light on a surface of albedo `colour`: Lambert, E·ρ/π, evaluated only at night (a branch
 * on a uniform: free by day, no recompile when night falls). Nothing on maps without lamps.
 */
function lampLit(colour: Node<'vec3'>): Node<'vec3'> | null {
  if (!CITY.lamps) return null;
  return Fn(() => {
    const out = vec3(0).toVar('lampLit');
    If(cityNight.greaterThan(0.5), () => {
      out.assign(colour.mul(lampLightNode()).mul(1 / Math.PI));
    });
    return out;
  })();
}

/**
 * Lit windows at night on a façade tile (one bay × one storey per uv unit, the window in the middle as
 * patterns.ts `facade` draws it): a share of the rooms lit warm, the ground floor's shops brighter and cooler.
 */
function windowGlow(): Node<'vec3'> {
  const t = uv();
  const cell = floor(t);
  const f = fract(t);
  // Soft-edged so far windows do not crawl under TRAA.
  const inWindow = smoothstep(0.3, 0.33, f.x).mul(smoothstep(0.7, 0.67, f.x)).mul(smoothstep(0.32, 0.35, f.y)).mul(smoothstep(0.78, 0.75, f.y));
  // Per window and per face (the normal tells the four faces of a block apart). The geometric normal: the
  // shading one carries the normal map, and a hash of it changed per pixel — every window a speckle.
  const key = cell.add(vec2(dot(normalWorldGeometry, vec3(17.1, 0, 31.7)), dot(normalWorldGeometry, vec3(5.3, 0, 11.9))));
  const h = fract(sin(dot(key, vec2(12.9898, 78.233))).mul(43758.5453));
  const lit = step(h, CITY_LIGHTS.litShare);
  const shop = step(cell.y, 0.5).mul(step(-0.5, cell.y));
  const room = lightColour(CITY_LIGHTS.windowK);
  const store = lightColour(CITY_LIGHTS.shopK);
  // Rooms vary: a dim lamp to a full ceiling light.
  const level = mix(float(0.35), float(1.4), fract(h.mul(7.31)));
  const upper = vec3(room.r, room.g, room.b).mul(CITY_LIGHTS.windowLuminance).mul(level).mul(lit);
  const ground = vec3(store.r, store.g, store.b).mul(CITY_LIGHTS.shopLuminance).mul(step(h, 0.8));
  return mix(upper, ground, shop).mul(inWindow).mul(lightPreExposure).mul(cityNight);
}

function translucentLeaf(ts: TextureSet, name: string): MeshStandardNodeMaterial {
  if (!FOLIAGE.translucent) return standard(ts, name);
  const m = new MeshSSSNodeMaterial({ name, map: ts.map, normalMap: ts.normalMap, roughnessMap: ts.ormMap, metalnessMap: ts.ormMap, roughness: 1, metalness: 1 });
  m.aoNode = texture(ts.ormMap).r.mul(skyVisibilityNode());
  // Light through a leaf is yellower and more saturated than the leaf in reflection. Tuned by eye at golden hour.
  m.thicknessColorNode = texture(ts.map).rgb.mul(vec3(1.1, 1.2, 0.6));
  m.thicknessDistortionNode = float(0.25);
  m.thicknessAmbientNode = float(0);
  m.thicknessAttenuationNode = float(0.6);
  m.thicknessPowerNode = float(2.5);
  m.thicknessScaleNode = float(2.2);
  return m;
}

/**
 * Alpha-clipped, double-sided plant card. No alphaToCoverage: it needs MSAA,
 * and the renderer anti-aliases with TRAA instead; with it on and no samples,
 * three skips the alpha-test discard and cards draw solid.
 */
function leafCard(ts: TextureSet, name: string, translucent: boolean): MeshStandardNodeMaterial {
  const m = translucent ? translucentLeaf(ts, name) : standard(ts, name);
  m.alphaTest = 0.5;
  m.side = DoubleSide;
  return m;
}

/**
 * Pine bark tiled in world metres up the trunk: the trunk mesh is one unit
 * cylinder scaled to each tree's height, so its own UVs would stretch one
 * texture tile over 15–27 m of bark.
 */
function pineBark(ts: TextureSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'pineBark', metalness: 0 });
  const buv = vec2(uv().x.mul(4), positionWorld.y.div(1.1));
  const orm = texture(ts.ormMap, buv);
  m.colorNode = texture(ts.map, buv).rgb;
  m.normalNode = normalMap(texture(ts.normalMap, buv).xyz, vec2(1.2, 1.2));
  m.roughnessNode = orm.g;
  m.aoNode = orm.r.mul(skyVisibilityNode());
  return m;
}

/**
 * Granite boulder: triplanar so no face stretches, with moss on the upward
 * faces broken up by a blotch pattern (as on the lagoon's jungle rocks), and
 * bump detail from the texture's height.
 */
function boulder(rock: TextureSet, moss: TextureSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'boulder', metalness: 0 });
  const p = positionWorld;
  const n = normalWorld;
  const colour = triplanarTexture(texture(rock.map), null, null, float(1 / 2.2), p, n).rgb;
  const orm = triplanarTexture(texture(rock.ormMap), null, null, float(1 / 2.2), p, n);
  const mossColour = triplanarTexture(texture(moss.map), null, null, float(1 / 0.9), p, n).rgb;
  const blotch = texture(moss.ormMap, p.xz.div(3.1).add(p.y.mul(0.2))).r;
  const mossMask = smoothstep(0.45, 0.8, n.y.add(blotch.sub(0.5).mul(1.1)));
  m.colorNode = mix(colour, mossColour, mossMask).mul(mix(float(1), float(0.6), wetness));
  m.roughnessNode = mix(mix(orm.g, float(0.95), mossMask), float(0.3), wetness);
  m.normalNode = bumpMap(orm.r.add(mossMask.mul(0.3)), float(0.9));
  m.aoNode = orm.r.mul(skyVisibilityNode());
  return m;
}

/**
 * NodeMaterial.copy() (three r186) never calls Material.copy(), so a clone
 * loses `alphaTest` (held in a private field behind a base-class accessor):
 * cloned foliage then draws every card as a solid quad. Restore it.
 */
export function cloneMaterial<T extends Material>(source: T): T {
  const m = source.clone() as T;
  m.alphaTest = source.alphaTest;
  return m;
}

/** Wet-capable material: the same texture set driven by the wetness uniform (rules §3.1). */
function wettable(ts: TextureSet, name: string): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name, metalness: 0 });
  // Water fills the pores: a wet surface is smoother, and its full-strength grain under the clearcoat
  // sparkled in motion. The relief keeps a third of its strength when soaked.
  const relief = mix(float(1), float(0.35), wetness);
  m.normalNode = normalMap(texture(ts.normalMap).xyz, vec2(relief, relief));
  m.aoNode = texture(ts.ormMap).r.mul(skyVisibilityNode());
  // Sheet: dry asphalt #3A3A3C L 0.043 → wet #2A2B2E L 0.024, so ×0.56 in linear.
  m.colorNode = texture(ts.map).rgb.mul(mix(float(1), float(0.56), wetness));
  m.roughnessNode = mix(texture(ts.ormMap).g, float(0.35), wetness);
  m.clearcoatNode = wetness;
  m.clearcoatRoughnessNode = float(0.05);
  const lamps = lampLit(texture(ts.map).rgb.mul(mix(float(1), float(0.56), wetness)));
  if (lamps) m.emissiveNode = lamps;
  return m;
}

export class MaterialLibrary {
  private readonly looks = new Map<BoxLook, LookMaterial>();
  private readonly facades = new Map<BoxLook, LookMaterial>();
  private readonly named = new Map<string, Material>();

  look(look: BoxLook): LookMaterial {
    let m = this.looks.get(look);
    if (!m) {
      m = this.buildLook(look);
      this.looks.set(look, m);
    }
    return m;
  }

  /** Façade material for a solid filler building: one tile = one bay × one storey. */
  facade(look: BoxLook): LookMaterial {
    let m = this.facades.get(look);
    if (!m) {
      const wall = this.wallSampler(look);
      const ts = set(`facade-${look}`, 512, () => P.facade(wall, 0x3c3c3e), 3);
      const mat = wettable(ts, `facade-${look}`);
      if (CITY.lamps) {
        const lamps = lampLit(texture(ts.map).rgb.mul(mix(float(1), float(0.56), wetness)));
        mat.emissiveNode = lamps ? lamps.add(windowGlow()) : windowGlow();
      }
      m = { material: mat, tileM: 1 };
      this.facades.set(look, m);
    }
    return m;
  }

  get(name: string): Material {
    let m = this.named.get(name);
    if (!m) {
      m = this.buildNamed(name);
      this.named.set(name, m);
    }
    return m;
  }

  private wallSampler(look: BoxLook): TexelSampler {
    switch (look) {
      case 'brick':
        return P.brick(0x8a4b3a, 0x8f8b85);
      case 'brickDark':
        return P.brick(0x6a3f33, 0x7a7672);
      case 'plaster':
        return P.plaster(0xb3aa9a);
      default:
        return P.concrete(0x8f8b85, 0.88);
    }
  }

  private buildLook(look: BoxLook): LookMaterial {
    switch (look) {
      case 'brick':
      case 'brickDark':
      case 'plaster':
        return { material: standard(set(`wall-${look}`, 512, () => this.wallSampler(look), look === 'plaster' ? 1 : 4), look), tileM: look === 'plaster' ? 3 : 1 };
      case 'concrete':
      case 'kerb':
        return { material: standard(set('concrete', 512, () => P.concrete(0x8f8b85, 0.88), 2), look), tileM: 3 };
      case 'pavement':
        return { material: wettable(set('pavement', 512, () => P.pavement(0x8f8b85), 3), look), tileM: 2.4 };
      case 'roofTar':
        return { material: wettable(set('roof', 256, () => P.asphalt(0x3a3a3c, 0.9), 2), look), tileM: 2 };
      case 'woodFloor':
        return { material: standard(set('floor', 512, () => P.planks(0x7a5a3e, 0.55), 2), look), tileM: 1.2 };
      case 'tiles':
        return { material: standard(set('tiles', 256, () => P.tiles(0xa9a49a), 3), look), tileM: 0.9 };
      case 'metalDark':
        // Painted steel is a non-metal (sheet: paint and phosphate are metal 0).
        return { material: standard(set('metalDark', 128, () => P.finish(0x3c3c3e, 0.62), 0.5), look), tileM: 1 };
      case 'wood':
        return { material: standard(set('wood', 256, () => P.planks(0x6b4e36, 0.8), 2), look), tileM: 1 };
      case 'stone':
        return { material: standard(set('stone', 512, () => P.stoneBlocks(0x7a7672), 5), look), tileM: 2 };
      case 'sandbag':
        return { material: standard(set('sandbag', 256, () => P.fabric(0x6e6650), 2), look), tileM: 0.8 };
      case 'targetSteel':
        // Range steel painted white so hits read at 800 m; sheet road paint #D6D6D0 rough 0.60.
        return { material: standard(set('targetSteel', 64, () => P.finish(0xd6d6d0, 0.6), 0.2), look), tileM: 1 };
      case 'glass':
      case 'facadeGlass':
        return { material: this.get('windowGlass'), tileM: 1 };
      case 'invisible':
        throw new Error("the 'invisible' look has no material: it is collision only");
    }
  }

  private buildNamed(name: string): Material {
    switch (name) {
      case 'windowGlass': {
        // Sheet: transmission 1, IOR 1.52. A transmission pass per pane is far
        // over budget with hundreds of panes, so glass is alpha-blended with the
        // same IOR for its Fresnel and reflects the environment probe.
        const m = new MeshPhysicalNodeMaterial({ name, color: 0xe6ebeb, roughness: 0.02, metalness: 0, ior: 1.52, transparent: true, opacity: 0.18, side: DoubleSide });
        m.depthWrite = false;
        return m;
      }
      case 'asphalt':
        return wettable(set('asphalt', 512, () => P.asphalt(0x3a3a3c, 0.92), 2), name);
      case 'roadPaint': {
        const m = wettable(set('roadPaint', 64, () => P.finish(0xd6d6d0, 0.6, 0, 8), 0.3), name);
        m.polygonOffset = true;
        m.polygonOffsetFactor = -2;
        m.polygonOffsetUnits = -2;
        return m;
      }
      case 'grass':
        return standard(set('grass', 512, P.grass, 2), name);
      case 'soil':
        return standard(set('soil', 512, () => P.soil(), 3), name);
      case 'bark':
        return standard(set('bark', 256, P.bark, 5), name);
      case 'needles':
        return leafCard(set('needles', 512, PL.pineSpray, 2, true), name, true);
      case 'leaves':
        return leafCard(set('leaves', 512, () => PL.broadleafCluster(41, 0x3f6420, 0x5c7f2a), 2, true), name, true);
      case 'hazel':
        return leafCard(set('hazel', 512, () => PL.broadleafCluster(3, 0x3f5f22, 0x62812f), 2, true), name, true);
      case 'buckthorn':
        return leafCard(set('buckthorn', 512, () => PL.broadleafCluster(9, 0x2c4a1c, 0x4a6a2a), 2, true), name, true);
      case 'fern':
        return leafCard(set('fern', 256, PL.fernFrond, 2, true), name, true);
      case 'grassTuft':
        // No translucency: a blade is too thin to matter, and grass is the heaviest overdraw in the scene.
        return leafCard(set('grassTuft', 256, PL.grassTuft, 1.5, true), name, false);
      case 'pineBark':
        return pineBark(set('bark', 256, P.bark, 5));
      case 'boulder':
        return boulder(set('rock', 512, () => P.rock(), 4), set('moss', 256, PL.moss, 2));
      case 'carPaint': {
        // Sheet: car paint #6E2A24 rough 0.40 + clearcoat 1, ccRough 0.03. Per-instance colour tints it.
        return new MeshPhysicalNodeMaterial({ name, color: 0xffffff, roughness: 0.4, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
      }
      case 'carWreck':
        return standard(set('rust', 256, () => P.concrete(0x7a4326, 0.88, 151), 3), name); // sheet: fresh rust #7A4326 rough 0.88
      case 'tyre':
        return standard(set('tyre', 64, () => P.finish(0x2c2c2e, 0.86), 0.3), name);
      case 'lampLens': {
        // A frosted diffuser: pale by day, the luminaire's own luminance by night.
        const m = new MeshStandardNodeMaterial({ name, color: 0xd6d6d0, roughness: 0.3, metalness: 0 });
        m.emissiveNode = lensGlowNode();
        return m;
      }
      case 'darkGlass':
        return new MeshPhysicalNodeMaterial({ name, color: 0x2a2b2e, roughness: 0.05, metalness: 0, ior: 1.52 }); // car glass: plain dielectric Fresnel
      case 'steel':
        return new MeshStandardNodeMaterial({ name, color: 0xc6c6c8, roughness: 0.35, metalness: 1 }); // sheet: steel, worn edge
      case 'containerPaint':
        return standard(set('container', 256, () => P.finish(0x4b5340, 0.7), 0.6), name); // sheet: NATO green
      case 'hay':
        return standard(set('hay', 256, () => P.planks(0xc2b280, 0.95), 1.5), name); // sheet: sand hue for dry straw
      default:
        throw new Error(`unknown material '${name}'`);
    }
  }
}
