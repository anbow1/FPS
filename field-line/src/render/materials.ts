import { abs, bumpMap, cameraPosition, cameraViewMatrix, dot, float, floor, Fn, fract, If, mix, normalize, mx_noise_float, normalMap, normalView, normalViewGeometry, normalWorld, positionViewDirection, positionWorld, pow, screenCoordinate, sin, smoothstep, step, texture, triplanarTexture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { DoubleSide, type Material, MeshPhysicalNodeMaterial, MeshSSSNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { cityNight, lampLightNode, lensGlowNode } from './cityLights.ts';
import type { BoxLook } from '../maps/types.ts';
import { skyVisibilityNode } from './interior.ts';
import { roomHash, roomInteriorNode } from './roomInteriors.ts';
import { shopfront } from './shopfront.ts';
import { cityRoad } from './cityRoad.ts';
import { facadeWear } from './facadeWear.ts';
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
    // Zero, but built from normalWorld so that shared variable is declared and set here, before the
    // branch: TSL sets it where it is first built, and first built inside the night-only branch it stayed
    // unset by day — and the material's own lighting read that garbage normal (façades mirrored the sky).
    const out = normalWorld.mul(0).toVar('lampLit');
    If(cityNight.greaterThan(0.5), () => {
      out.assign(colour.mul(lampLightNode()).mul(1 / Math.PI));
    });
    return out;
  })();
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
  // Leaves within an arm's length of the eye dissolve (a screen-space dither, smoothed by TRAA): standing in
  // a bush, a card a few centimetres from the lens filled a corner of the screen with one blurred leaf.
  // In the shadow pass the camera is the light's, far away, so shadows keep every leaf.
  const near = smoothstep(0.3, 0.85, positionWorld.distance(cameraPosition));
  const dither = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));
  m.opacityNode = texture(ts.map).a.mul(step(dither, near));
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

/**
 * Paving: each slab its own shade, a few stained, and each settled a fraction of a degree off level, so
 * the 2.4 m texture tile stops repeating and wet slabs break reflections into facets as real ones do.
 * The slab grid is the texture's (4 × 4 per tile), in the box's world-metre UVs.
 */
function slabbed(m: MeshPhysicalNodeMaterial, ts: TextureSet): MeshPhysicalNodeMaterial {
  const cell = floor(uv().mul(4));
  const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const stained = step(0.9, fract(h.mul(7.13)));
  const shade = mix(float(0.94), float(1.04), h).mul(mix(float(1), float(0.88), stained));
  m.colorNode = texture(ts.map).rgb.mul(mix(float(1), float(0.56), wetness)).mul(shade).mul(mix(vec3(1), vec3(1.04, 1, 0.92), stained));
  const tilt = vec3(fract(h.mul(3.7)).sub(0.5), 0, fract(h.mul(5.9)).sub(0.5)).mul(0.012);
  const relief = mix(float(1), float(0.35), wetness);
  const mapped = normalMap(texture(ts.normalMap).xyz, vec2(relief, relief)) as unknown as Node<'vec3'>;
  // World → view as a direction, not normalised (transformNormalToView normalises: the tiny tilt became a unit one).
  m.normalNode = normalize(mapped.add(cameraViewMatrix.mul(vec4(tilt, 0)).xyz));
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
      const wall = this.wallSampler(look, true);
      // Real-size bricks need the texels: a course is ~13 px at 1024 over a 3 m storey.
      const brickLike = look === 'brick' || look === 'brickDark';
      const ts = set(`facade-${look}`, brickLike ? 1024 : 512, () => P.facade(wall, 0x3c3c3e), 2);
      const mat = wettable(ts, `facade-${look}`);
      // The ground storey is shopfronts (shopfront.ts), drawn over the window pattern.
      const sf = shopfront();
      // Clear glass (the texture's glossiest texels) shows the room behind it, so it barely scatters itself.
      const pane = mix(float(1).sub(smoothstep(0.08, 0.25, texture(ts.ormMap).g)), sf.glass, sf.cover);
      const base = mix(texture(ts.map).rgb, sf.albedo, sf.cover).mul(mix(float(1), float(0.56), wetness));
      // Weather and people on the wall (facadeWear.ts); the glass stays clean and dark.
      const wear = facadeWear(base, pane);
      const albedo = mix(wear.colour, base.mul(0.2), pane);
      mat.colorNode = albedo;
      // Glass, frame and fascia are flat: the wall's relief must not show through them.
      const relief = mix(float(1), float(0.35), wetness);
      const surface = mix(normalMap(texture(ts.normalMap).xyz, vec2(relief, relief)) as unknown as Node<'vec3'>, normalViewGeometry, sf.cover);
      // No two panes in a real façade lie in one plane: each is set a fraction of a degree off, so each
      // reflects its own piece of sky and street instead of the wall of windows mirroring one grey.
      const ph = roomHash();
      const paneTilt = vec3(fract(ph.mul(3.1)).sub(0.5), fract(ph.mul(7.7)).sub(0.5).mul(0.6), fract(ph.mul(5.3)).sub(0.5)).mul(0.07);
      const tilted = normalize(normalViewGeometry.add(cameraViewMatrix.mul(vec4(paneTilt, 0)).xyz));
      mat.normalNode = mix(surface, tilted, pane);
      const rough = mix(texture(ts.ormMap).g, sf.roughness, sf.cover);
      mat.roughnessNode = mix(mix(rough, float(0.35), wetness), float(0.85), wear.paper);
      mat.clearcoatNode = wetness.mul(float(1).sub(wear.paper.mul(0.6)));
      const rooms = roomInteriorNode(pane);
      const lamps = lampLit(albedo);
      mat.emissiveNode = lamps ? lamps.add(rooms) : rooms;
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

  /** `facade`: for a façade tile (one bay × one storey) rather than a metre, so bricks keep their real size. */
  private wallSampler(look: BoxLook, facade = false): TexelSampler {
    const cols = facade ? 13 : 4;
    const rows = facade ? 38 : 12;
    switch (look) {
      case 'brick':
        return P.brick(0x8a4b3a, 0x8f8b85, cols, rows);
      case 'brickDark':
        return P.brick(0x6a3f33, 0x7a7672, cols, rows);
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
      {
        const ts = set('pavement', 512, () => P.pavement(0x8f8b85), 3);
        return { material: slabbed(wettable(ts, look), ts), tileM: 2.4 };
      }
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
        // Glass scatters almost nothing itself (a near-white albedo lit by the sun read as frosted film); what
        // it shows is the room through it and the sky off it, traded by Fresnel. Blending weights both by
        // alpha, so alpha follows Schlick: ~15 % face-on (the room shows), most of it at a grazing look.
        const m = new MeshPhysicalNodeMaterial({ name, color: 0x0c0e0f, roughness: 0.02, metalness: 0, ior: 1.52, transparent: true, side: DoubleSide });
        const cosV = abs(dot(normalView, positionViewDirection)).clamp(0, 1);
        m.opacityNode = mix(float(0.14), float(0.92), pow(float(1).sub(cosV), 5));
        m.depthWrite = false;
        return m;
      }
      case 'asphalt': {
        // The city's roads: the aggregate texture plus the street's wear and furniture (cityRoad.ts).
        const m = wettable(set('asphalt', 512, () => P.asphalt(0x3a3a3c, 0.92), 1.4), name);
        cityRoad(m);
        return m;
      }
      case 'roadPaint': {
        const m = wettable(set('roadPaint', 64, () => P.finish(0xd6d6d0, 0.6, 0, 8), 0.3), name);
        m.polygonOffset = true;
        // The depth buffer is reversed (near = 1) and three.js passes the bias through unflipped, so a
        // positive bias pulls the paint toward the camera; the negative one hid every marking under the road.
        m.polygonOffsetFactor = 2;
        m.polygonOffsetUnits = 2;
        // Worn by tyres: the paint is gone in patches, down to the asphalt.
        const worn = smoothstep(0.3, 0.75, mx_noise_float(positionWorld.xz.mul(2.3))).mul(0.8);
        m.colorNode = mix(m.colorNode as Node<'vec3'>, vec3(0.04, 0.04, 0.042), worn);
        return m;
      }
      case 'grass':
        return standard(set('grass', 512, P.grass, 2), name);
      case 'soil':
        return standard(set('soil', 512, () => P.soil(), 3), name);
      case 'bark':
        return standard(set('bark', 256, P.bark, 5), name);
      case 'needles':
        // 1024: single needles are a few texels wide, and at 512 they merged into green blobs.
        return leafCard(set('needles', 1024, PL.pineSpray, 2, true), name, true);
      case 'leaves':
        return leafCard(set('leaves', 512, () => PL.broadleafCluster(41, 0x3f6420, 0x5c7f2a), 2, true), name, true);
      case 'hazel':
        return leafCard(set('hazel', 512, () => PL.broadleafCluster(3, 0x3f5f22, 0x62812f), 2, true), name, true);
      case 'buckthorn':
        return leafCard(set('buckthorn', 512, () => PL.broadleafCluster(9, 0x2c4a1c, 0x4a6a2a), 2, true), name, true);
      case 'fern':
        return leafCard(set('fern', 256, PL.fernFrond, 2, true), name, true);
      case 'reedBed':
        return leafCard(set('reedBed', 512, PL.reedBed, 1.2, true), name, false);
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
      case 'tyre': {
        // Double-sided: the lathed tyre and rim profiles are not wound one way round.
        const m = standard(set('tyre', 64, () => P.finish(0x2c2c2e, 0.86), 0.3), name);
        m.side = DoubleSide;
        return m;
      }
      case 'carTrim':
        return new MeshStandardNodeMaterial({ name, color: 0x232325, roughness: 0.55, metalness: 0 }); // textured black plastic
      case 'carRim':
        return new MeshStandardNodeMaterial({ name, color: 0xb4b4b6, roughness: 0.32, metalness: 1, side: DoubleSide }); // painted alloy, sheet: aluminium
      case 'carHeadlamp':
        // Clear polycarbonate over a chrome reflector: a bright, glossy surface.
        return new MeshPhysicalNodeMaterial({ name, color: 0xc8cccc, roughness: 0.08, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.02 });
      case 'carTaillamp':
        return new MeshPhysicalNodeMaterial({ name, color: 0x9a1a14, roughness: 0.15, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02 });
      case 'carPlate':
        return new MeshStandardNodeMaterial({ name, color: 0xd6d6d0, roughness: 0.45, metalness: 0 }); // blank: no markings
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
