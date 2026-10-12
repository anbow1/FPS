import { attribute, clamp, dot, float, Fn, max, mix, normalWorld, normalWorldGeometry, property, smoothstep, step, uniform, varying, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { fbm3, G, smoothstepDown, thermalOutput } from './nodes';
import { linear, PBR, type PbrKey } from './palette';

type UF = THREE.UniformNode<'float', number>;
type UC = THREE.UniformNode<'color', THREE.Color>;

/** Per-vehicle state shared by all of that vehicle's materials (uniform nodes: write `.value`). */
export interface VehicleUniforms {
  uBurnt: UF;
  uDust: UF;
  uSeed: UF;
  uHeatBase: UF;
  uHeatEngine: UF;
  uHeatTracks: UF;
  uHeatBarrel: UF;
  uColA: UC;
  uColB: UC;
  uColC: UC;
}

export function makeVehicleUniforms(seed: number, camo: [number, number, number]): VehicleUniforms {
  return {
    uBurnt: uniform(0),
    uDust: uniform(0.35),
    uSeed: uniform(seed),
    uHeatBase: uniform(0.24),
    uHeatEngine: uniform(0.5),
    uHeatTracks: uniform(0.1),
    uHeatBarrel: uniform(0),
    uColA: uniform(linear(camo[0])),
    uColB: uniform(linear(camo[1])),
    uColC: uniform(linear(camo[2])),
  };
}

const SOOT = linear(PBR.soot.color);
const RUST = linear(PBR.rust.color);
const DUST = linear(0x8a7a62);
const c3 = (c: THREE.Color) => vec3(c.r, c.g, c.b);

/**
 * Vehicle paint: object-space NATO camo, dust caked on the lower hull and on up-facing surfaces,
 * grime variation, a burnt/rust look for wrecks, and a heat map for the thermal sight.
 * Needs a `tankPos` vertex attribute (rest-pose position in the vehicle frame).
 */
export function vehicleMaterial(key: PbrKey, u: VehicleUniforms, opts: { camo?: boolean; params?: THREE.MeshStandardMaterialParameters } = {}): THREE.MeshStandardNodeMaterial {
  const p = PBR[key];
  const mat = new THREE.MeshStandardNodeMaterial({ color: p.color, roughness: p.rough, metalness: p.metal, ...opts.params });
  mat.name = `vehicle-${key}${opts.camo ? '-camo' : ''}`;
  const tankPos = varying(attribute('tankPos', 'vec3'), 'vTankPos');
  const tp = tankPos.add(vec3(u.uSeed.mul(13.1), 0, u.uSeed.mul(7.7)));
  // computed once in the colour node, read by roughness, metalness and heat
  const grime = property('float', 'tkGrime');
  const dust = property('float', 'tkDust');
  const base = mat.color.clone();
  mat.colorNode = Fn(() => {
    grime.assign(fbm3(tp.mul(3.3)));
    let paint: THREE.Node<'vec3'> = c3(base);
    if (opts.camo) {
      const n1 = fbm3(tp.mul(vec3(0.42, 0.7, 0.42)));
      const n2 = fbm3(tp.mul(vec3(0.5, 0.8, 0.5)).add(19));
      paint = mix(mix(u.uColA, u.uColB, smoothstep(0.515, 0.535, n1)), u.uColC, smoothstep(0.575, 0.595, n2));
    }
    const d0 = u.uDust.mul(smoothstepDown(1.35, 0.35, tankPos.y).mul(0.9).add(smoothstep(0.55, 0.95, normalWorldGeometry.y).mul(0.45)));
    dust.assign(clamp(d0.mul(fbm3(tp.mul(1.9).add(5)).mul(1.1).add(0.35)), 0, 0.85));
    const col = mix(paint.mul(grime.mul(0.28).add(0.86)), c3(DUST), dust);
    const burnt = mix(c3(SOOT), c3(RUST), smoothstep(0.5, 0.72, fbm3(tp.mul(1.6).add(3)))).mul(grime.mul(0.4).add(0.8));
    return mix(col, burnt, u.uBurnt).mul(mix(float(1), float(0.85).sub(dust.mul(0.25)), G.uRain));
  })();
  // Rain: wet paint and wet dust are darker and glossier (a film of water over both).
  mat.roughnessNode = mix(float(p.rough).mul(grime.mul(0.2).add(0.9)), float(0.95), max(dust, u.uBurnt)).mul(mix(float(1), float(0.5), G.uRain));
  mat.metalnessNode = float(p.metal).mul(float(1).sub(u.uBurnt)).mul(float(1).sub(dust));
  thermalOutput(
    mat,
    u.uHeatBase
      .add(u.uHeatEngine.mul(smoothstepDown(-1.7, -2.9, tankPos.z)).mul(smoothstep(0.6, 1.3, tankPos.y)))
      .add(u.uHeatTracks.mul(smoothstepDown(1.05, 0.45, tankPos.y)))
      .add(u.uHeatBarrel.mul(smoothstep(2.6, 3.4, tankPos.z)).mul(step(1.9, tankPos.y)))
      .add(G.uDay.mul(0.05).mul(max(dot(normalWorld, G.uSunDir), 0)))
      .add(grime.mul(0.04)),
  );
  return mat;
}
