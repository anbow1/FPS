import { abs, cross, dFdx, dFdy, dot, float, floor, Fn, fract, mix, normalize, normalViewGeometry, positionView, sign, uniform, vec2, vec3 } from 'three/tsl';
import { type Node, Vector3 } from 'three/webgpu';

// Shared TSL building blocks: hashes and value noise without sine (Dave
// Hoskins' "hash without sine"), and a bump from a height's screen
// derivatives so procedural relief needs neither UVs nor tangents.

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** Uniforms every material reads: pre-exposed light levels the lighting sets once. */
export const SCENE = {
  /** Illuminance inside a room by day, pre-exposed (a few % of the outdoor light). */
  interiorLux: uniform(0),
  /** Luminance of a lit room's ceiling light / a shop's interior, pre-exposed (cd/m²). */
  roomLampNits: uniform(0),
  shopNits: uniform(0),
  /** A street lamp's lantern, pre-exposed (cd/m²). */
  lanternNits: uniform(0),
  /** Sun through a thin leaf toward the viewer: pre-exposed sun illuminance × transmittance / π (cd/m²). */
  leafSunNits: uniform(0),
  /** Direction toward the sun. */
  sunDir: uniform(new Vector3(0, 1, 0)),
  /** Seconds of the clip. */
  time: uniform(0),
};

export const hash12 = Fn(([p0]: [V2]) => {
  const p3 = fract(vec3(p0.x, p0.y, p0.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash13 = Fn(([p0]: [V3]) => {
  const p = fract(p0.mul(0.1031)).toVar();
  p.addAssign(dot(p, p.zyx.add(31.32)));
  return fract(p.x.add(p.y).mul(p.z));
});

/** Bilinear value noise in [0, 1]. */
export const vnoise2 = Fn(([p]: [V2]) => {
  const i = floor(p);
  const f0 = fract(p);
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)));
  const a = hash12(i);
  const b = hash12(i.add(vec2(1, 0)));
  const c = hash12(i.add(vec2(0, 1)));
  const d = hash12(i.add(vec2(1, 1)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
});

/** Four octaves of value noise in [0, 1]. */
export const fbm2 = Fn(([p]: [V2]) =>
  vnoise2(p).mul(0.5).add(vnoise2(p.mul(2.03).add(17.1)).mul(0.25)).add(vnoise2(p.mul(4.01).add(3.7)).mul(0.125)).add(vnoise2(p.mul(8.07).add(9.2)).mul(0.125)),
);

/** Mikkelsen's surface-gradient bump from a height's screen derivatives (no UVs or tangents needed). */
export function heightBump(h: F, bumpScale: number): V3 {
  return Fn(() => {
    const n = normalViewGeometry;
    const sx = dFdx(positionView);
    const sy = dFdy(positionView);
    const dh = vec2(dFdx(h), dFdy(h)).mul(bumpScale);
    const r1 = cross(sy, n);
    const r2 = cross(n, sx);
    const det = dot(sx, r1);
    const grad = sign(det).mul(r1.mul(dh.x).add(r2.mul(dh.y)));
    return normalize(abs(det).mul(n).sub(grad));
  })() as unknown as V3;
}

/** sRGB hex → linear rgb triple (PBR sheet values are sRGB). */
export function linearRgb(hex: number): [number, number, number] {
  const c = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}
