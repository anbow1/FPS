import * as THREE from 'three';
import { addPatch, addThermalConst, GLSL_NOISE, inject } from './shaderPatch';

/**
 * Procedural facade shading in the building's own frame (attribute aLocal; aInfo = base height,
 * seed). Every surface type draws its pattern and a matching height field; the height becomes a
 * bump via screen-space derivatives (Mikkelsen's perturbNormalArb), so no UVs or textures are needed.
 */
export type SurfaceKind = 'brick' | 'plaster' | 'tiles' | 'wood' | 'frame' | 'metal' | 'concrete';

const KIND_ID: Record<SurfaceKind, number> = { brick: 0, plaster: 1, tiles: 2, wood: 3, frame: 4, metal: 5, concrete: 6 };

const PATTERN = /* glsl */ `
float bh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// returns height (0..1) and writes colour / roughness for the surface kind
float facade(int kind, vec3 lp, vec3 nL, float seed, float above, out vec3 col, out float rough) {
  vec2 wuv = abs(nL.x) > abs(nL.z) ? lp.zy : lp.xy;
  if (abs(nL.y) > 0.9) wuv = lp.xz;
  // screen footprint of one pixel in metres: patterns fade to their average before they alias
  float fw = max(length(fwidth(wuv)), 1e-4);
  float n1 = tk_fbm(vec3(wuv * 0.9, seed));
  float n2 = tk_vnoise(vec3(wuv * 7.0, seed + 3.0));
  float h = 0.5;
  if (kind == 0 || kind == 1) {
    // brick bond: 250 x 65 mm, 10 mm mortar
    vec2 b = wuv / vec2(0.26, 0.075);
    float row = floor(b.y);
    b.x += mod(row, 2.0) * 0.5;
    vec2 f = fract(b), id = floor(b);
    float edge = min(min(f.x, 1.0 - f.x) * 0.26 / 0.075, min(f.y, 1.0 - f.y));
    float mortar = 1.0 - smoothstep(0.05, 0.14 + fw * 8.0, edge);
    vec3 brick = vec3(0.26, 0.085, 0.05) * (0.7 + 0.6 * bh(id + seed)) * (0.85 + 0.3 * n2);
    brick = mix(brick, vec3(0.12, 0.06, 0.045), step(0.93, bh(id * 1.7 + seed))); // over-fired bricks
    col = mix(brick, vec3(0.34, 0.32, 0.29), mortar);
    float aa = smoothstep(0.012, 0.04, fw);
    col = mix(col, vec3(0.25, 0.1, 0.065) * (0.85 + 0.3 * n1), aa);
    rough = mix(0.8, 0.92, mortar);
    h = mix(1.0 - mortar * 0.8 + n2 * 0.1, 0.5, aa);
    if (kind == 1) {
      // lime render over brick, flaking off in patches
      vec3 tint = mix(vec3(0.62, 0.58, 0.5), vec3(0.66, 0.6, 0.46), bh(vec2(seed)));
      vec3 render = tint * (0.82 + 0.25 * n1) * (0.93 + 0.1 * n2);
      float flake = smoothstep(0.66, 0.7, tk_fbm(vec3(wuv * 0.55, seed + 9.0)) + (above < 1.2 ? 0.08 : 0.0));
      col = mix(render, col, flake);
      rough = mix(0.9, rough, flake);
      h = mix(1.0 + n2 * 0.05, h * 0.7, flake);
    }
  } else if (kind == 2) {
    // clay pantiles: rows down the slope, S-curve across, overlap shadow
    vec2 t = vec2(lp.x / 0.3, (lp.y * 1.35) / 0.34);
    float row = floor(t.y);
    t.x += mod(row, 2.0) * 0.15;
    vec2 f = fract(t);
    float wave = 0.5 + 0.5 * sin(f.x * 6.2832);
    float lap = smoothstep(0.0, 0.25, f.y);
    col = vec3(0.3, 0.1, 0.06) * (0.75 + 0.5 * bh(floor(t) + seed)) * (0.7 + 0.3 * lap);
    float aa = smoothstep(0.04, 0.12, fw);
    col = mix(col, vec3(0.24, 0.085, 0.05) * (0.85 + 0.3 * n1), aa);
    wave = mix(wave, 0.5, aa); lap = mix(lap, 0.6, aa);
    col = mix(col, vec3(0.16, 0.18, 0.1), smoothstep(0.62, 0.75, n1) * 0.7); // moss
    rough = 0.8;
    h = wave * 0.6 + lap * 0.4;
  } else if (kind == 3) {
    // vertical planks, weathered to grey
    float u = wuv.x / 0.19;
    float f = fract(u);
    float gap = 1.0 - smoothstep(0.0, 0.05, min(f, 1.0 - f));
    float grain = tk_vnoise(vec3(u * 2.0, wuv.y * 0.35, seed)) * 0.6 + tk_vnoise(vec3(u * 9.0, wuv.y * 3.0, seed)) * 0.4;
    col = mix(vec3(0.2, 0.15, 0.1), vec3(0.34, 0.33, 0.31), n1 * 0.9) * (0.75 + 0.45 * grain) * (0.8 + 0.4 * bh(vec2(floor(u), seed)));
    float aa = smoothstep(0.02, 0.07, fw);
    col *= 1.0 - gap * 0.7 * (1.0 - aa);
    rough = 0.88;
    h = mix(1.0 - gap + grain * 0.15, 0.5, aa);
  } else if (kind == 4) {
    col = vec3(0.72, 0.7, 0.66) * (0.9 + 0.12 * n2);
    rough = 0.55;
    h = 0.5;
  } else if (kind == 5) {
    // corrugated steel, painted and rusting (rust is non-metal)
    float c = sin(lp.x * 6.2832 / 0.076);
    float rust = smoothstep(0.5, 0.72, n1 + n2 * 0.2);
    col = mix(vec3(0.25, 0.27, 0.26), vec3(0.2, 0.07, 0.03), rust);
    rough = mix(0.5, 0.9, rust);
    h = mix(c * 0.5 + 0.5, 0.5, smoothstep(0.008, 0.03, fw));
  } else {
    col = vec3(0.28, 0.27, 0.25) * (0.8 + 0.3 * n1) * (0.9 + 0.15 * n2);
    rough = 0.9;
    h = n2;
  }
  // grime: splashback and damp at the base, rain streaks down the walls
  float damp = (1.0 - smoothstep(0.0, 0.9, above)) * (0.55 + 0.45 * n1);
  float streak = smoothstep(0.55, 0.85, tk_vnoise(vec3(wuv.x * 3.0, wuv.y * 0.18, seed + 5.0))) * 0.35;
  if (kind != 2 && kind != 5 && abs(nL.y) < 0.5) col *= 1.0 - 0.45 * damp - streak * 0.5;
  return h;
}
`;

export function buildingMaterial(kind: SurfaceKind): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  const id = KIND_ID[kind];
  const bumpScale = kind === 'tiles' ? 0.035 : kind === 'metal' ? 0.012 : kind === 'brick' || kind === 'plaster' ? 0.012 : 0.01;
  addPatch(mat, {
    key: `facade${id}`,
    apply(shader) {
      shader.uniforms.uKind = { value: id };
      shader.uniforms.uBump = { value: bumpScale };
      inject(shader, 'vertex', '#include <common>', 'attribute vec3 aLocal; attribute vec2 aInfo; varying vec3 vLocal; varying vec2 vInfo;', 'after');
      inject(shader, 'vertex', '#include <begin_vertex>', 'vLocal = aLocal; vInfo = aInfo;', 'after');
      inject(shader, 'fragment', '#include <common>', `varying vec3 vLocal; varying vec2 vInfo; uniform int uKind; uniform float uBump;\n${GLSL_NOISE}\n${PATTERN}`, 'after');
      inject(
        shader,
        'fragment',
        '#include <map_fragment>',
        `vec3 tkNL = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
         vec3 tkCol; float tkRough;
         float tkH = facade(uKind, vLocal, tkNL, vInfo.y, vLocal.y - vInfo.x, tkCol, tkRough);
         diffuseColor.rgb = tkCol;`,
        'after',
      );
      inject(shader, 'fragment', '#include <roughnessmap_fragment>', 'roughnessFactor = tkRough;', 'after');
      inject(
        shader,
        'fragment',
        '#include <normal_fragment_maps>',
        `{
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec2 dh = vec2(dFdx(tkH), dFdy(tkH)) * uBump * 60.0;
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
          normal = normalize(abs(det) * normal - grad);
        }`,
        'after',
      );
    },
  });
  addThermalConst(mat, kind === 'metal' ? 0.14 : kind === 'tiles' ? 0.12 : 0.1);
  return mat;
}
