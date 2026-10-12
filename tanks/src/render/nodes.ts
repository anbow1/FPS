import { dot, float, floor, Fn, fract, max, mix, normalWorld, output, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { Color, type Node, type NodeMaterial, type UniformNode, Vector2, Vector3 } from 'three/webgpu';

/**
 * Shared TSL building blocks for every material (they replace the old onBeforeCompile patches).
 * Values that differ per material are uniforms, so identical graphs share one GPU pipeline.
 */

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** Uniforms shared by every material (one node, referenced everywhere). */
export const G = {
  uThermal: uniform(0),
  uTime: uniform(0),
  uSunDir: uniform(new Vector3(0, 1, 0)),
  /** 0 = night, 1 = full day; drives solar heating in the thermal view */
  uDay: uniform(1),
  uWind: uniform(new Vector2(1, 0.35)),
  /** 0 = dry, 1 = raining: wet, darker, glossier surfaces and puddles (render/rain.ts) */
  uRain: uniform(0),
  /** pre-exposed sun irradiance (colour × lux × exposure), for translucency */
  uSunIrr: uniform(new Color(0, 0, 0)),
};

// ---------------------------------------------------------------- noise (hash without sine)

export const hash13 = Fn(([p0]: [V3]) => {
  const p = fract(p0.mul(0.1031)).toVar();
  p.addAssign(dot(p, p.zyx.add(31.32)));
  return fract(p.x.add(p.y).mul(p.z));
});

export const hash12 = Fn(([p0]: [V2]) => {
  const p3 = fract(vec3(p0.x, p0.y, p0.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

/** Trilinear value noise in [0, 1]. */
export const vnoise3 = Fn(([p]: [V3]) => {
  const i = floor(p);
  const f0 = fract(p);
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)));
  const a = hash13(i);
  const b = hash13(i.add(vec3(1, 0, 0)));
  const c = hash13(i.add(vec3(0, 1, 0)));
  const d = hash13(i.add(vec3(1, 1, 0)));
  const e = hash13(i.add(vec3(0, 0, 1)));
  const g = hash13(i.add(vec3(1, 0, 1)));
  const h = hash13(i.add(vec3(0, 1, 1)));
  const k = hash13(i.add(vec3(1, 1, 1)));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
});

export const fbm3 = Fn(([p]: [V3]) =>
  vnoise3(p).mul(0.5).add(vnoise3(p.mul(2.03)).mul(0.25)).add(vnoise3(p.mul(4.01)).mul(0.125)).add(vnoise3(p.mul(8.07)).mul(0.125)),
);

/** Bilinear value noise in [0, 1]. */
export const vnoise2 = Fn(([p]: [V2]) => {
  const i = floor(p);
  const f0 = fract(p);
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)));
  return mix(mix(hash12(i), hash12(i.add(vec2(1, 0))), f.x), mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), f.x), f.y);
});

/**
 * smoothstep with falling edges (1 below `to`, 0 above `from`, from > to). GLSL leaves
 * smoothstep(e0, e1, x) undefined for e0 ≥ e1, so the old shaders' reversed calls are spelled out.
 */
export function smoothstepDown(from: number, to: number, x: F): F {
  return float(1).sub(smoothstep(to, from, x));
}

// ---------------------------------------------------------------- thermal sight

/**
 * Thermal ("white hot") output: the material's final colour is replaced by its heat while the
 * thermal channel is on. A uniform switch, so turning the sight on never recompiles anything.
 */
export function thermalOutput(mat: NodeMaterial, heat: F): void {
  const white = vec3(max(heat, 0).mul(0.4));
  mat.outputNode = vec4(mix(output.rgb, white, G.uThermal), output.a);
}

/** Constant heat plus a little solar warming on sunlit faces; the constant is a per-material uniform. */
export function addThermalConst(mat: NodeMaterial, heat: number): UniformNode<'float', number> {
  const u = uniform(heat);
  thermalOutput(mat, u.add(G.uDay.mul(0.06).mul(max(dot(normalWorld, G.uSunDir), 0))));
  return u;
}
