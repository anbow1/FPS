import * as THREE from 'three';
import { addPatch, GLSL_NOISE, inject, thermalPatch } from './shaderPatch';
import { linear, PBR, type PbrKey } from './palette';

/** Per-vehicle state shared by all of that vehicle's materials. */
export interface VehicleUniforms {
  uBurnt: THREE.IUniform<number>;
  uDust: THREE.IUniform<number>;
  uSeed: THREE.IUniform<number>;
  uHeatBase: THREE.IUniform<number>;
  uHeatEngine: THREE.IUniform<number>;
  uHeatTracks: THREE.IUniform<number>;
  uHeatBarrel: THREE.IUniform<number>;
  uColA: THREE.IUniform<THREE.Color>;
  uColB: THREE.IUniform<THREE.Color>;
  uColC: THREE.IUniform<THREE.Color>;
}

export function makeVehicleUniforms(seed: number, camo: [number, number, number]): VehicleUniforms {
  return {
    uBurnt: { value: 0 },
    uDust: { value: 0.35 },
    uSeed: { value: seed },
    uHeatBase: { value: 0.16 },
    uHeatEngine: { value: 0.5 },
    uHeatTracks: { value: 0.1 },
    uHeatBarrel: { value: 0 },
    uColA: { value: linear(camo[0]) },
    uColB: { value: linear(camo[1]) },
    uColC: { value: linear(camo[2]) },
  };
}

const SOOT = linear(PBR.soot.color);
const RUST = linear(PBR.rust.color);
const DUST = linear(0x8a7a62);

/**
 * Vehicle paint shader: object-space NATO camo, dust caked on lower hull and on up-facing
 * surfaces, grime variation, burnt/rust look for wrecks, and a heat map for the thermal sight.
 * Needs a `tankPos` vertex attribute (rest-pose position in the vehicle frame).
 */
export function vehicleMaterial(
  key: PbrKey,
  u: VehicleUniforms,
  opts: { camo?: boolean; params?: THREE.MeshStandardMaterialParameters } = {},
): THREE.MeshStandardMaterial {
  const p = PBR[key];
  const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: p.rough, metalness: p.metal, ...opts.params });
  const camoOn = { value: opts.camo ? 1 : 0 };
  addPatch(mat, {
    key: 'vehicle',
    apply(shader) {
      Object.assign(shader.uniforms, u, { uCamoOn: camoOn, uSoot: { value: SOOT }, uRust: { value: RUST }, uDustCol: { value: DUST } });
      inject(shader, 'vertex', '#include <common>', 'attribute vec3 tankPos;\nvarying vec3 vTankPos;\nvarying vec3 vWorldUpN;', 'after');
      inject(
        shader,
        'vertex',
        '#include <beginnormal_vertex>',
        `vTankPos = tankPos;
         #ifdef USE_INSTANCING
           vWorldUpN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
         #else
           vWorldUpN = normalize(mat3(modelMatrix) * objectNormal);
         #endif`,
        'after',
      );
      inject(
        shader,
        'fragment',
        '#include <common>',
        `varying vec3 vTankPos; varying vec3 vWorldUpN;
         uniform float uBurnt, uDust, uSeed, uCamoOn;
         uniform vec3 uColA, uColB, uColC, uSoot, uRust, uDustCol;
         ${GLSL_NOISE}`,
        'after',
      );
      inject(
        shader,
        'fragment',
        '#include <map_fragment>',
        `vec3 tp = vTankPos + vec3(uSeed * 13.1, 0.0, uSeed * 7.7);
         float tkGrime = tk_fbm(tp * 3.3);
         vec3 tkBase = diffuseColor.rgb;
         if (uCamoOn > 0.5) {
           float n1 = tk_fbm(tp * vec3(0.42, 0.7, 0.42));
           float n2 = tk_fbm(tp * vec3(0.5, 0.8, 0.5) + 19.0);
           tkBase = mix(uColA, uColB, smoothstep(0.515, 0.535, n1));
           tkBase = mix(tkBase, uColC, smoothstep(0.575, 0.595, n2));
         }
         float tkDust = uDust * (smoothstep(1.35, 0.35, vTankPos.y) * 0.9 + smoothstep(0.55, 0.95, vWorldUpN.y) * 0.45);
         tkDust = clamp(tkDust * (0.35 + 1.1 * tk_fbm(tp * 1.9 + 5.0)), 0.0, 0.85);
         vec3 tkCol = tkBase * (0.86 + 0.28 * tkGrime);
         tkCol = mix(tkCol, uDustCol, tkDust);
         float tkBurntN = tk_fbm(tp * 1.6 + 3.0);
         vec3 tkBurnt = mix(uSoot, uRust, smoothstep(0.5, 0.72, tkBurntN)) * (0.8 + 0.4 * tkGrime);
         tkCol = mix(tkCol, tkBurnt, uBurnt);
         diffuseColor.rgb = tkCol;`,
        'after',
      );
      inject(
        shader,
        'fragment',
        '#include <roughnessmap_fragment>',
        'roughnessFactor = mix(roughnessFactor * (0.9 + 0.2 * tkGrime), 0.95, max(tkDust, uBurnt));',
        'after',
      );
      inject(shader, 'fragment', '#include <metalnessmap_fragment>', 'metalnessFactor *= (1.0 - uBurnt) * (1.0 - tkDust);', 'after');
    },
  });
  addPatch(
    mat,
    thermalPatch(
      'vehicle',
      `uHeatBase
        + uHeatEngine * smoothstep(-1.7, -2.9, vTankPos.z) * smoothstep(0.6, 1.3, vTankPos.y)
        + uHeatTracks * smoothstep(1.05, 0.45, vTankPos.y)
        + uHeatBarrel * smoothstep(2.6, 3.4, vTankPos.z) * step(1.9, vTankPos.y)
        + 0.05 * uDay * max(dot(normal, normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz)), 0.0)
        + 0.04 * tkGrime`,
      { uHeatBase: u.uHeatBase, uHeatEngine: u.uHeatEngine, uHeatTracks: u.uHeatTracks, uHeatBarrel: u.uHeatBarrel },
    ),
  );
  return mat;
}
