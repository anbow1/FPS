import { attribute, cos, float, length, mix, normalMap, positionLocal, sin, texture, uv, vec2, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, DoubleSide, MeshSSSNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { photoSet } from './photoTextures.ts';
import { makeTextureSet, type TexelSampler, type TextureSet } from './textureSet.ts';
import * as F from './foliagePatterns.ts';
import { U } from './uniforms.ts';

// Foliage and bark materials. Every plant sways with the one wind uniform:
// `sway.x` is how far a vertex bends with the gusts (metres per m/s at full
// gust, 0 at the root), `sway.y` how much it flutters. Leaves are alpha-clipped
// cards with a thin-translucency term — MeshSSSNodeMaterial adds it inside the
// direct-light loop, so it is multiplied by the shadowed light colour and only
// sun-lit leaves glow from behind (rules §3.1). Rain makes them darker and
// glossier.

const sets = new Map<string, TextureSet>();

function textureSet(key: string, size: number, sampler: () => TexelSampler, normal: number, alpha: boolean): TextureSet {
  let s = sets.get(key);
  if (!s) {
    s = makeTextureSet(size, sampler(), normal, alpha);
    sets.set(key, s);
  }
  return s;
}

/**
 * Shadowed leaf translucency costs a second light evaluation per leaf pixel;
 * with the heavy overdraw of alpha-cut foliage that is too much for a phone,
 * so the Low preset turns it off (set by the view before building plants).
 */
export const FOLIAGE = { translucent: true };

export type LeafKind = 'palm' | 'broadleaf' | 'broadleafDark' | 'fern' | 'grass' | 'banana' | 'hibiscus' | 'herb';

function leafSet(kind: LeafKind): TextureSet {
  switch (kind) {
    case 'palm':
      return textureSet(kind, 512, F.palmFrond, 2, true);
    case 'broadleaf':
      return textureSet(kind, 512, () => F.broadleafCluster(3, 0x3f6420, 0x5c7f2a), 2, true);
    case 'broadleafDark':
      return textureSet(kind, 512, () => F.broadleafCluster(9, 0x2c4a18, 0x46652a), 2, true);
    case 'fern':
      return textureSet(kind, 256, F.fernFrond, 2, true);
    case 'grass':
      return textureSet(kind, 256, F.grassTuft, 1.5, true);
    case 'banana':
      return textureSet(kind, 512, F.bananaLeaf, 2, true);
    case 'hibiscus':
      return textureSet(kind, 256, () => F.broadleafCluster(21, 0x2f5a1c, 0x4c7426), 2, true);
    case 'herb':
      return textureSet(kind, 256, () => F.broadleafCluster(33, 0x5c8a2c, 0x86ad3e), 2, true);
  }
}

/**
 * Adds the wind-weight attribute: bend grows with the square of height above
 * the root (relative to `refHeightM`, so a crown and its trunk bend as one),
 * flutter as given.
 */
export function addSway(g: BufferGeometry, bendPerM: number, flutter: (x: number, y: number, z: number) => number, refHeightM?: number): void {
  const pos = g.getAttribute('position');
  const sway = new Float32Array(pos.count * 2);
  let ref = refHeightM ?? 0;
  if (!refHeightM) for (let i = 0; i < pos.count; i++) ref = Math.max(ref, pos.getY(i));
  ref = Math.max(ref, 1e-3);
  for (let i = 0; i < pos.count; i++) {
    const h = Math.max(0, pos.getY(i)) / ref;
    sway[i * 2] = h * h * ref * bendPerM;
    sway[i * 2 + 1] = flutter(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  g.setAttribute('sway', new BufferAttribute(sway, 2));
}

/** Wind displacement after instancing (positionLocal is the instanced position here). */
function windPosition() {
  const s = attribute('sway', 'vec2');
  const p = positionLocal;
  const phase = p.x.mul(0.13).add(p.z.mul(0.11));
  const windLen = length(U.wind).max(0.01);
  const dir = U.wind.div(windLen);
  const gust = U.gust.mul(0.8).add(0.35);
  const push = windLen.mul(gust).add(sin(U.time.mul(1.3).add(phase)).mul(windLen.mul(0.25)));
  const bend = dir.mul(push.mul(s.x).mul(0.05));
  const t = U.time.mul(float(5).add(windLen.mul(0.35)));
  const flutter = vec3(sin(t.add(phase.mul(5)).add(p.y.mul(2.1))), sin(t.mul(1.3).add(phase.mul(3))).mul(0.6), cos(t.mul(0.9).add(p.x.mul(3.3)))).mul(s.y.mul(float(0.015).add(windLen.mul(0.006))));
  return p.add(vec3(bend.x, s.x.mul(push).mul(-0.004), bend.y)).add(flutter);
}

export function leafMaterial(kind: LeafKind, translucent = true, dead = false): MeshStandardNodeMaterial {
  const ts = leafSet(kind);
  const m = translucent && FOLIAGE.translucent ? new MeshSSSNodeMaterial({ name: `leaf-${kind}${dead ? '-dead' : ''}`, side: DoubleSide }) : new MeshStandardNodeMaterial({ name: `leaf-${kind}`, side: DoubleSide });
  m.map = ts.map;
  m.normalMap = ts.normalMap;
  m.alphaTest = 0.5;
  // No alphaToCoverage: it needs MSAA, and the renderer anti-aliases with TRAA instead.
  // With it on and no samples, three skips the alpha-test discard and cards draw solid.
  const tex = texture(ts.map);
  // Dead fronds: the same card, dried to straw brown.
  const base = dead ? vec3(tex.r.add(tex.g).add(tex.b).mul(0.36)).mul(vec3(1.25, 0.95, 0.55)) : tex.rgb;
  const albedo = base.mul(mix(float(1), float(0.78), U.wetness));
  m.colorNode = albedo;
  m.opacityNode = tex.a; // colorNode is rgb only: the cut-out comes from here
  m.roughnessNode = mix(texture(ts.ormMap).g, float(0.22), U.wetness.mul(0.8));
  m.metalnessNode = float(0);
  m.aoNode = texture(ts.ormMap).r;
  m.positionNode = windPosition();
  if (m instanceof MeshSSSNodeMaterial && FOLIAGE.translucent) {
    // Light through a leaf is yellower and more saturated than the leaf seen in reflection.
    m.thicknessColorNode = albedo.mul(vec3(1.1, 1.2, 0.6));
    m.thicknessDistortionNode = float(0.25);
    m.thicknessAmbientNode = float(0);
    m.thicknessAttenuationNode = float(0.6);
    m.thicknessPowerNode = float(2.5);
    m.thicknessScaleNode = float(2.2);
  }
  return m;
}

export type BarkKind = 'palm' | 'jungle';

export function barkMaterial(kind: BarkKind): MeshStandardNodeMaterial {
  if (kind === 'jungle') return jungleBarkMaterial();
  const ts = textureSet('palmBark', 256, F.palmBark, 4, false);
  const m = new MeshStandardNodeMaterial({ name: `bark-${kind}`, map: ts.map, normalMap: ts.normalMap });
  m.colorNode = texture(ts.map).rgb.mul(mix(float(1), float(0.6), U.wetness));
  m.roughnessNode = mix(texture(ts.ormMap).g, float(0.35), U.wetness);
  m.metalnessNode = float(0);
  m.aoNode = texture(ts.ormMap).r;
  m.positionNode = windPosition();
  return m;
}

/**
 * The jungle's broadleaf trunks in a scanned bark (photoTextures.ts): smooth pale bark mottled with lichen,
 * as rainforest trees have. Twice round the trunk (u runs once round it; trunks are ~1.5–2.5 m round), once
 * per 1.2 m up it (meshkit `tube`).
 */
function jungleBarkMaterial(): MeshStandardNodeMaterial {
  const P = photoSet('bark007');
  const st = uv().mul(vec2(2, 1));
  const m = new MeshStandardNodeMaterial({ name: 'bark-jungle' });
  // The scan is pale (mean sRGB 0.64, a birch's); a rainforest trunk is ~0.45, and in the noon sun the
  // whole stand read as white posts. Its roughness map (mean 0.53) is a polished bark's; lift it to dry bark's.
  m.colorNode = texture(P.map, st).rgb.mul(mix(float(0.45), float(0.27), U.wetness));
  m.normalNode = normalMap(texture(P.normalMap, st));
  m.roughnessNode = mix(texture(P.roughnessMap, st).r.mul(0.45).add(0.55), float(0.35), U.wetness);
  m.metalnessNode = float(0);
  m.positionNode = windPosition();
  return m;
}

/** Solid plant parts (coconuts, aloe, stems) that sway with the rest of the plant. */
export function swayingSolid(colour: number, roughness: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ color: colour, roughness, metalness: 0 });
  m.positionNode = windPosition();
  return m;
}
