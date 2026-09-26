import { float, mix, texture, uniform } from 'three/tsl';
import { DoubleSide, type Material, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import type { BoxLook } from '../maps/types.ts';
import * as P from './patterns.ts';
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
  const m = new MeshStandardNodeMaterial({ name, map: ts.map, normalMap: ts.normalMap, roughnessMap: ts.ormMap, metalnessMap: ts.ormMap, aoMap: ts.ormMap, roughness: 1, metalness: 1 });
  m.normalScale.set(normalScale, normalScale);
  return m;
}

/** Wet-capable material: the same texture set driven by the wetness uniform (rules §3.1). */
function wettable(ts: TextureSet, name: string): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name, normalMap: ts.normalMap, aoMap: ts.ormMap, metalness: 0 });
  // Sheet: dry asphalt #3A3A3C L 0.043 → wet #2A2B2E L 0.024, so ×0.56 in linear.
  m.colorNode = texture(ts.map).rgb.mul(mix(float(1), float(0.56), wetness));
  m.roughnessNode = mix(texture(ts.ormMap).g, float(0.35), wetness);
  m.clearcoatNode = wetness;
  m.clearcoatRoughnessNode = float(0.05);
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
      m = { material: wettable(ts, `facade-${look}`), tileM: 1 };
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
      case 'rock':
        return standard(set('rock', 512, () => P.rock(), 4), name);
      case 'bark':
        return standard(set('bark', 256, P.bark, 5), name);
      case 'needles': {
        const ts = set('needles', 256, P.pineNeedles, 2, true);
        const m = standard(ts, name);
        m.alphaTest = 0.5;
        m.alphaToCoverage = true;
        m.side = DoubleSide;
        return m;
      }
      case 'leaves': {
        const ts = set('leaves', 256, P.leaves, 2, true);
        const m = standard(ts, name);
        m.alphaTest = 0.5;
        m.alphaToCoverage = true;
        m.side = DoubleSide;
        return m;
      }
      case 'carPaint': {
        // Sheet: car paint #6E2A24 rough 0.40 + clearcoat 1, ccRough 0.03. Per-instance colour tints it.
        return new MeshPhysicalNodeMaterial({ name, color: 0xffffff, roughness: 0.4, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
      }
      case 'carWreck':
        return standard(set('rust', 256, () => P.concrete(0x7a4326, 0.88, 151), 3), name); // sheet: fresh rust #7A4326 rough 0.88
      case 'tyre':
        return standard(set('tyre', 64, () => P.finish(0x2c2c2e, 0.86), 0.3), name);
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
