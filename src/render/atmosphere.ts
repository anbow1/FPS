import * as THREE from 'three';

/**
 * Global atmosphere: height fog with sun in-scattering and a drifting cloud layer that shades the
 * ground. Both are patched into three's shared shader chunks, so every built-in material gets them
 * without extra passes or draw calls: a handful of ALU ops per pixel.
 *
 * The uniforms are plain Float32Arrays. three clones a built-in material's uniforms per program,
 * but typed arrays are copied by reference, so one write here reaches every material.
 */
export const ATMO = {
  /** x fog density (1/m), y height falloff (1/m), z reference height (m), w sun in-scatter on/off */
  fog: new Float32Array([0, 1 / 260, 0, 1]),
  /** rgb: pre-exposed sun glow (same colour the sky uses for its Mie halo), a: Mie g */
  fogSun: new Float32Array([0, 0, 0, 0.76]),
  /** xyz sun direction, w unused */
  sunDir: new Float32Array([0, 1, 0, 0]),
  /** xy wind offset of the cloud field (m), z coverage 0..1, w ground shadow strength */
  cloud: new Float32Array([0, 0, 0, 0]),
  /** xy = sun.xz / sun.y (projects a ground point up to the cloud deck), z deck height (m), w 1/feature size */
  cloudP: new Float32Array([0, 0, 1400, 1 / 650]),
};

const UNIFORMS = {
  tkFog: { value: ATMO.fog },
  tkFogSun: { value: ATMO.fogSun },
  tkSunDir: { value: ATMO.sunDir },
  tkCloud: { value: ATMO.cloud },
  tkCloudP: { value: ATMO.cloudP },
};

/** Uniform entries to merge into custom ShaderMaterials that include the fog or light chunks. */
export function atmosphereUniforms(): Record<string, THREE.IUniform> {
  return { ...UNIFORMS };
}

/** Cloud density field shared by the sky, the ground shadows and the water. */
export const GLSL_CLOUDS = /* glsl */ `
uniform vec4 tkCloud;
uniform vec4 tkCloudP;
float tk_h2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tk_n2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tk_h2(i), tk_h2(i + vec2(1.0, 0.0)), f.x), mix(tk_h2(i + vec2(0.0, 1.0)), tk_h2(i + vec2(1.0, 1.0)), f.x), f.y);
}
// p: metres on the cloud deck. Three octaves are enough for soft ground shadows.
float tk_cloudCov(vec2 p) {
  p = (p + tkCloud.xy) * tkCloudP.w;
  float n = 0.5714 * tk_n2(p) + 0.2857 * tk_n2(p * 2.03 + 5.1) + 0.1429 * tk_n2(p * 4.07 + 1.7);
  return smoothstep(1.0 - tkCloud.z, 1.18 - tkCloud.z, n);
}
float tk_cloudShadow(vec3 wp) {
  if (tkCloud.w <= 0.0) return 1.0;
  return 1.0 - tkCloud.w * tk_cloudCov(wp.xz + tkCloudP.xy * (tkCloudP.z - wp.y));
}
`;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRel;
#endif`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // view space -> world space offset from the camera (rotation only: the view matrix is orthonormal)
  vFogRel = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogRel;
  uniform vec4 tkFog;
  uniform vec4 tkFogSun;
  uniform vec4 tkSunDir;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor;
    vec3 fogTint = fogColor;
    if (tkFog.x > 0.0) {
      // Height fog: exp² distance falloff like before, scaled by the mean density along the ray,
      // so valleys and the far plain sit in haze while ridges and the sky above stay clear.
      float L = length(vFogRel);
      vec3 rd = vFogRel / max(L, 1e-3);
      float b = tkFog.y;
      float h0 = exp(-b * max(cameraPosition.y - tkFog.z, -60.0));
      float k = b * rd.y * L;
      float mean = h0 * (abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k);
      float dd = tkFog.x * L;
      fogFactor = 1.0 - exp(-dd * dd * mean);
      // sun in-scattering: the same Mie lobe as the sky's halo at the horizon
      float mu = dot(rd, tkSunDir.xyz);
      float g = tkFogSun.w;
      float mie = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.08;
      fogTint += tkFogSun.rgb * mie * 1.35 * tkFog.w;
    } else {
      fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
    }
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    vec3 fogTint = fogColor;
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogTint, fogFactor);
#endif`;

let installed = false;

/** Patch three's shader chunks. Must run before the first material compiles. */
export function installAtmosphere(): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as Record<string, string>;
  C.fog_pars_vertex = FOG_PARS_VERTEX;
  C.fog_vertex = FOG_VERTEX;
  C.fog_pars_fragment = FOG_PARS_FRAGMENT;
  C.fog_fragment = FOG_FRAGMENT;

  // cloud shadow on the sun (the only directional light): computed once per fragment
  C.lights_pars_begin = `${C.lights_pars_begin}\n${GLSL_CLOUDS}`;
  const anchor = 'getDirectionalLightInfo( directionalLight, directLight );';
  if (!C.lights_fragment_begin!.includes(anchor)) throw new Error('lights_fragment_begin anchor missing');
  C.lights_fragment_begin = C.lights_fragment_begin!
    .replace(
      '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )',
      `float tkCloudSh = tk_cloudShadow(cameraPosition + transpose(mat3(viewMatrix)) * (-vViewPosition));
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )`,
    )
    .replace(anchor, `${anchor}\n\t\tdirectLight.color *= tkCloudSh;`);

  for (const lib of Object.values(THREE.ShaderLib)) {
    if ('fogColor' in lib.uniforms || 'directionalLights' in lib.uniforms) Object.assign(lib.uniforms, UNIFORMS);
  }
}
