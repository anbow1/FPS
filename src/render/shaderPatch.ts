import * as THREE from 'three';

/**
 * Tiny composable onBeforeCompile system. Every patch has a stable key; values that differ per
 * material must be uniforms so identical code shares one GPU program.
 */
export type ShaderLike = THREE.WebGLProgramParametersWithUniforms;
export interface Patch {
  key: string;
  apply(shader: ShaderLike): void;
}

export function addPatch(mat: THREE.Material, patch: Patch): void {
  const list = ((mat.userData.patches as Patch[] | undefined) ??= []);
  list.push(patch);
  mat.onBeforeCompile = (shader) => {
    for (const p of list) p.apply(shader);
  };
  const key = list.map((p) => p.key).join('|');
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
}

export function inject(
  shader: ShaderLike,
  stage: 'vertex' | 'fragment',
  anchor: string,
  code: string,
  mode: 'before' | 'after' | 'replace' = 'after',
): void {
  const src = stage === 'vertex' ? shader.vertexShader : shader.fragmentShader;
  if (!src.includes(anchor)) throw new Error(`shader anchor not found: ${anchor}`);
  const out =
    mode === 'replace' ? src.replace(anchor, code) : mode === 'before' ? src.replace(anchor, `${code}\n${anchor}`) : src.replace(anchor, `${anchor}\n${code}`);
  if (stage === 'vertex') shader.vertexShader = out;
  else shader.fragmentShader = out;
}

/** Uniforms shared by every patched material (one object, referenced everywhere). */
export const G = {
  uThermal: { value: 0 },
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** 0 = night, 1 = full day; drives solar heating in thermal view */
  uDay: { value: 1 },
  uWind: { value: new THREE.Vector2(1, 0.35) },
  /** pre-exposed sun irradiance (colour × lux × exposure), for translucency */
  uSunIrr: { value: new THREE.Color(0, 0, 0) },
};

export const GLSL_NOISE = /* glsl */ `
float tk_hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float tk_vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = tk_hash13(i), b = tk_hash13(i + vec3(1,0,0));
  float c = tk_hash13(i + vec3(0,1,0)), d = tk_hash13(i + vec3(1,1,0));
  float e = tk_hash13(i + vec3(0,0,1)), g = tk_hash13(i + vec3(1,0,1));
  float h = tk_hash13(i + vec3(0,1,1)), k = tk_hash13(i + vec3(1,1,1));
  return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y), mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
}
float tk_fbm(vec3 p) {
  return 0.5 * tk_vnoise(p) + 0.25 * tk_vnoise(p * 2.03) + 0.125 * tk_vnoise(p * 4.01) + 0.125 * tk_vnoise(p * 8.07);
}
`;

/**
 * Thermal ("white hot") output. `heatExpr` is a GLSL float expression evaluated at the end of the
 * fragment shader; it may reference uniforms added by other patches.
 */
export function thermalPatch(key: string, heatExpr: string, extraUniforms?: Record<string, THREE.IUniform>): Patch {
  return {
    key: `thermal:${key}`,
    apply(shader) {
      shader.uniforms.uThermal = G.uThermal;
      shader.uniforms.uSunDir = G.uSunDir;
      shader.uniforms.uDay = G.uDay;
      if (extraUniforms) Object.assign(shader.uniforms, extraUniforms);
      const decl = ['uniform float uThermal;', 'uniform vec3 uSunDir;', 'uniform float uDay;'];
      if (extraUniforms) for (const k of Object.keys(extraUniforms)) decl.push(`uniform float ${k};`);
      inject(shader, 'fragment', '#include <common>', decl.join('\n'), 'after');
      inject(
        shader,
        'fragment',
        '#include <tonemapping_fragment>',
        `{ float tkHeat = ${heatExpr}; gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(max(tkHeat, 0.0)), uThermal); }`,
        'before',
      );
    },
  };
}

/** Constant-heat thermal patch; value lives in a per-material uniform. */
export function addThermalConst(mat: THREE.Material, heat: number): THREE.IUniform<number> {
  const u = { value: heat };
  addPatch(mat, thermalPatch('const', 'uHeat + 0.06 * uDay * max(dot(normal, normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz)), 0.0)', { uHeat: u }));
  return u;
}

/**
 * Two-sided foliage: keep the authored (outward/up) normal on back faces instead of flipping it,
 * so blades and needles seen from behind are lit like a thin translucent sheet, not black.
 */
export const foliageNormalPatch: Patch = {
  key: 'foliageNormal',
  apply(shader) {
    inject(shader, 'fragment', '#include <normal_fragment_begin>', 'normal = normalize(vNormal);', 'after');
  },
};

/**
 * Thin-sheet translucency (needles, blades): sunlight scattered through the leaf, strongest when
 * looking towards the sun. Energy is a fraction of the direct diffuse the sheet would receive.
 */
export function translucencyPatch(strength: number): Patch {
  return {
    key: 'translucency',
    apply(shader) {
      shader.uniforms.uSunIrr = G.uSunIrr;
      shader.uniforms.uSunDirT = G.uSunDir;
      shader.uniforms.uTransl = { value: strength };
      inject(shader, 'fragment', '#include <common>', 'uniform vec3 uSunIrr; uniform vec3 uSunDirT; uniform float uTransl;', 'after');
      inject(
        shader,
        'fragment',
        '#include <lights_fragment_end>',
        `{
          vec3 Lv = normalize((viewMatrix * vec4(uSunDirT, 0.0)).xyz);
          float back = pow(max(dot(-geometryViewDir, Lv), 0.0), 3.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * uSunIrr * RECIPROCAL_PI * uTransl * (0.25 + 1.5 * back);
        }`,
        'after',
      );
    },
  };
}
