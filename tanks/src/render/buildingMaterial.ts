import { abs, attribute, cross, dFdx, dFdy, dot, float, floor, fract, Fn, fwidth, length, max, min, mix, mod, normalize, normalViewGeometry, positionView, property, select, sign, sin, smoothstep, step, varying, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { addThermalConst, fbm3, G, vnoise3 } from './nodes';

/**
 * Procedural facade shading in the building's own frame (attribute aLocal; aInfo = base height,
 * seed). Every surface type draws its pattern and a matching height field; the height becomes a
 * bump via screen-space derivatives (Mikkelsen's perturbNormalArb), so no UVs or textures are needed.
 * One material per surface kind, so each kind compiles only its own pattern.
 */
export type SurfaceKind = 'brick' | 'plaster' | 'tiles' | 'wood' | 'frame' | 'metal' | 'concrete';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

const bh = (p: V2): F => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

/** Colour, roughness and height (0..1) of one surface kind at a point of the building frame. */
/** `flaking` raises the threshold at which the render has fallen off (0 = the village's tired walls, 1 = kept up). */
export function facade(kind: SurfaceKind, lp: V3, nL: V3, seed: F, above: F, flaking = 0): { col: V3; rough: F; h: F } {
  const wall = select(abs(nL.x).greaterThan(abs(nL.z)), lp.zy, lp.xy);
  const wuv = select(abs(nL.y).greaterThan(0.9), lp.xz, wall);
  // screen footprint of one pixel in metres: patterns fade to their average before they alias
  const fw = max(length(fwidth(wuv)), 1e-4);
  const n1 = fbm3(vec3(wuv.mul(0.9), seed));
  const n2 = vnoise3(vec3(wuv.mul(7), seed.add(3)));
  let col: V3;
  let rough: F;
  let h: F;
  if (kind === 'brick' || kind === 'plaster') {
    // brick bond: 250 x 65 mm, 10 mm mortar
    const b0 = wuv.div(vec2(0.26, 0.075));
    const row = floor(b0.y);
    const b = vec2(b0.x.add(mod(row, 2).mul(0.5)), b0.y);
    const f = fract(b);
    const id = floor(b);
    const edge = min(min(f.x, float(1).sub(f.x)).mul(0.26 / 0.075), min(f.y, float(1).sub(f.y)));
    const mortar = float(1).sub(smoothstep(0.05, fw.mul(8).add(0.14), edge));
    const brick0 = vec3(0.26, 0.085, 0.05).mul(bh(id.add(seed)).mul(0.6).add(0.7)).mul(n2.mul(0.3).add(0.85));
    const brick = mix(brick0, vec3(0.12, 0.06, 0.045), step(0.93, bh(id.mul(1.7).add(seed)))); // over-fired bricks
    // Courses repeat every 75 mm: past ~a third of that per pixel they alias into stripes (Nyquist).
    const aa = smoothstep(0.008, 0.028, fw);
    col = mix(mix(brick, vec3(0.34, 0.32, 0.29), mortar), vec3(0.25, 0.1, 0.065).mul(n1.mul(0.3).add(0.85)), aa);
    rough = mix(0.8, 0.92, mortar);
    h = mix(float(1).sub(mortar.mul(0.8)).add(n2.mul(0.1)), float(0.5), aa);
    if (kind === 'plaster') {
      // lime render over brick, flaking off in patches
      const tint = mix(vec3(0.62, 0.58, 0.5), vec3(0.66, 0.6, 0.46), bh(vec2(seed, seed)));
      const render = tint.mul(n1.mul(0.25).add(0.82)).mul(n2.mul(0.1).add(0.93));
      const flake = smoothstep(0.66 + flaking * 0.12, 0.7 + flaking * 0.12, fbm3(vec3(wuv.mul(0.55), seed.add(9))).add(select(above.lessThan(1.2), float(0.08), float(0))));
      col = mix(render, col, flake);
      rough = mix(float(0.9), rough, flake);
      h = mix(n2.mul(0.05).add(1), h.mul(0.7), flake);
    }
  } else if (kind === 'tiles') {
    // clay pantiles: rows down the slope, S-curve across, overlap shadow
    const t0 = vec2(lp.x.div(0.3), lp.y.mul(1.35).div(0.34));
    const row = floor(t0.y);
    const t = vec2(t0.x.add(mod(row, 2).mul(0.15)), t0.y);
    const f = fract(t);
    // Faded out well before Nyquist (rows 25 cm, waves 30 cm): later, the bump turned the rows into a
    // field of bright dots across every roof in the middle distance.
    const aa = smoothstep(0.02, 0.07, fw);
    const wave = mix(sin(f.x.mul(6.2832)).mul(0.5).add(0.5), float(0.5), aa);
    const lap = mix(smoothstep(0, 0.25, f.y), float(0.6), aa);
    const c0 = vec3(0.3, 0.1, 0.06).mul(bh(floor(t).add(seed)).mul(0.5).add(0.75)).mul(lap.mul(0.3).add(0.7));
    const c1 = mix(c0, vec3(0.24, 0.085, 0.05).mul(n1.mul(0.3).add(0.85)), aa);
    col = mix(c1, vec3(0.16, 0.18, 0.1), smoothstep(0.62, 0.75, n1).mul(0.7)); // moss
    rough = float(0.8);
    h = wave.mul(0.6).add(lap.mul(0.4));
  } else if (kind === 'wood') {
    // vertical planks, weathered to grey
    const u = wuv.x.div(0.19);
    const f = fract(u);
    const gap = float(1).sub(smoothstep(0, 0.05, min(f, float(1).sub(f))));
    const grain = vnoise3(vec3(u.mul(2), wuv.y.mul(0.35), seed)).mul(0.6).add(vnoise3(vec3(u.mul(9), wuv.y.mul(3), seed)).mul(0.4));
    const c0 = mix(vec3(0.2, 0.15, 0.1), vec3(0.34, 0.33, 0.31), n1.mul(0.9)).mul(grain.mul(0.45).add(0.75)).mul(bh(vec2(floor(u), seed)).mul(0.4).add(0.8));
    const aa = smoothstep(0.02, 0.07, fw);
    col = c0.mul(float(1).sub(gap.mul(0.7).mul(float(1).sub(aa))));
    rough = float(0.88);
    h = mix(float(1).sub(gap).add(grain.mul(0.15)), float(0.5), aa);
  } else if (kind === 'frame') {
    col = vec3(0.72, 0.7, 0.66).mul(n2.mul(0.12).add(0.9));
    rough = float(0.55);
    h = float(0.5);
  } else if (kind === 'metal') {
    // corrugated steel, painted and rusting (rust is non-metal)
    const c = sin(lp.x.mul(6.2832 / 0.076));
    const rust = smoothstep(0.5, 0.72, n1.add(n2.mul(0.2)));
    col = mix(vec3(0.25, 0.27, 0.26), vec3(0.2, 0.07, 0.03), rust);
    rough = mix(0.5, 0.9, rust);
    h = mix(c.mul(0.5).add(0.5), float(0.5), smoothstep(0.008, 0.03, fw));
  } else {
    col = vec3(0.28, 0.27, 0.25).mul(n1.mul(0.3).add(0.8)).mul(n2.mul(0.15).add(0.9));
    rough = float(0.9);
    h = n2;
  }
  // grime: splashback and damp at the base, rain streaks down the walls
  if (kind !== 'tiles' && kind !== 'metal') {
    const damp = float(1).sub(smoothstep(0, 0.9, above)).mul(n1.mul(0.45).add(0.55));
    const streak = smoothstep(0.55, 0.85, vnoise3(vec3(wuv.x.mul(3), wuv.y.mul(0.18), seed.add(5)))).mul(0.35);
    const k = float(1).sub(damp.mul(0.45)).sub(streak.mul(0.5));
    col = col.mul(select(abs(nL.y).lessThan(0.5), k, float(1)));
  }
  return { col, rough, h };
}

export function buildingMaterial(kind: SurfaceKind): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.name = `facade-${kind}`;
  const bumpScale = kind === 'tiles' ? 0.035 : kind === 'metal' ? 0.012 : kind === 'brick' || kind === 'plaster' ? 0.012 : 0.01;
  const local = varying(attribute('aLocal', 'vec3'), 'vLocal');
  const info = varying(attribute('aInfo', 'vec2'), 'vInfo');
  const tkRough = property('float', 'tkRough');
  const tkH = property('float', 'tkH');
  mat.colorNode = Fn(() => {
    const nL = normalize(cross(dFdx(local), dFdy(local)));
    const f = facade(kind, local, nL, info.y, local.y.sub(info.x));
    // Rain: walls and roofs soak darker and turn glossy.
    tkRough.assign(mix(f.rough, f.rough.mul(0.55), G.uRain));
    tkH.assign(f.h);
    return f.col.mul(mix(float(1), float(0.72), G.uRain));
  })();
  mat.roughnessNode = tkRough;
  mat.normalNode = heightBump(tkH, bumpScale);
  addThermalConst(mat, kind === 'metal' ? 0.14 : kind === 'tiles' ? 0.12 : 0.1);
  return mat;
}

/** Mikkelsen's surface-gradient bump from a height's screen derivatives (no UVs or tangents needed). */
export function heightBump(h: F, bumpScale: number): V3 {
  return Fn(() => {
    const n = normalViewGeometry;
    const sx = dFdx(positionView);
    const sy = dFdy(positionView);
    const dh = vec2(dFdx(h), dFdy(h)).mul(bumpScale * 60);
    const r1 = cross(sy, n);
    const r2 = cross(n, sx);
    const det = dot(sx, r1);
    const grad = sign(det).mul(r1.mul(dh.x).add(r2.mul(dh.y)));
    return normalize(abs(det).mul(n).sub(grad));
  })();
}
