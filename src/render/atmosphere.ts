import { abs, cameraPosition, exp, float, fog, Fn, length, max, positionWorld, pow, select, smoothstep, uniform } from 'three/tsl';
import { Color, type Node, type Scene, Vector4 } from 'three/webgpu';
import { vnoise2 } from './nodes';

/**
 * Global atmosphere: height fog with sun in-scattering and a drifting cloud layer that shades the
 * ground. The fog is the scene's fog node, so every material gets it; the cloud shadow rides on the
 * sun's shadow node (lighting.ts). A handful of ALU ops per pixel, no extra passes or draw calls.
 */
export const ATMO = {
  /** x fog density (1/m), y height falloff (1/m), z reference height (m), w sun in-scatter on/off */
  fog: uniform(new Vector4(0, 1 / 260, 0, 1)),
  /** rgb: pre-exposed sun glow (same colour the sky uses for its Mie halo), a: Mie g */
  fogSun: uniform(new Vector4(0, 0, 0, 0.76)),
  /** xyz sun direction, w unused */
  sunDir: uniform(new Vector4(0, 1, 0, 0)),
  /** xy wind offset of the cloud field (m), z coverage 0..1, w ground shadow strength */
  cloud: uniform(new Vector4(0, 0, 0, 0)),
  /** xy = sun.xz / sun.y (projects a ground point up to the cloud deck), z deck height (m), w 1/feature size */
  cloudP: uniform(new Vector4(0, 0, 1400, 1 / 650)),
  /** pre-exposed horizon haze colour */
  fogColor: uniform(new Color(1, 1, 1)),
};

type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** Cloud coverage 0..1 at a point on the cloud deck (metres). Three octaves: enough for soft ground shadows. */
export const cloudCover = Fn(([p0]: [V2]) => {
  const p = p0.add(ATMO.cloud.xy).mul(ATMO.cloudP.w);
  const n = vnoise2(p).mul(0.5714).add(vnoise2(p.mul(2.03).add(5.1)).mul(0.2857)).add(vnoise2(p.mul(4.07).add(1.7)).mul(0.1429));
  return smoothstep(float(1).sub(ATMO.cloud.z), float(1.18).sub(ATMO.cloud.z), n);
});

/** Sunlight let through the cloud deck at a world point (1 = clear). */
export const cloudShadow = Fn(([wp]: [V3]) => {
  const onDeck = wp.xz.add(ATMO.cloudP.xy.mul(ATMO.cloudP.z.sub(wp.y)));
  const sh = float(1).sub(ATMO.cloud.w.mul(cloudCover(onDeck)));
  return select(ATMO.cloud.w.greaterThan(0), sh, float(1));
});

/**
 * Height fog: exp² distance falloff scaled by the mean density along the ray, so valleys and the
 * far plain sit in haze while ridges and the sky above stay clear; plus the sky's Mie lobe toward
 * the sun, so distant terrain fades into the same halo as the horizon.
 */
const heightFog = Fn(() => {
  const rel = positionWorld.sub(cameraPosition);
  const L = length(rel);
  const rd = rel.div(max(L, 1e-3));
  const b = ATMO.fog.y;
  const h0 = exp(b.negate().mul(max(cameraPosition.y.sub(ATMO.fog.z), -60)));
  const k = b.mul(rd.y).mul(L);
  const mean = h0.mul(select(abs(k).greaterThan(1e-3), float(1).sub(exp(k.negate())).div(k), float(1).sub(k.mul(0.5))));
  const dd = ATMO.fog.x.mul(L);
  const factor = float(1).sub(exp(dd.mul(dd).mul(mean).negate()));
  const mu = rd.dot(ATMO.sunDir.xyz);
  const g = ATMO.fogSun.w;
  const mie = float(1).sub(g.mul(g)).div(pow(float(1).add(g.mul(g)).sub(g.mul(2).mul(mu)), 1.5)).mul(0.08);
  const tint = (ATMO.fogColor as unknown as Node<'vec3'>).add(ATMO.fogSun.xyz.mul(mie).mul(1.35).mul(ATMO.fog.w));
  return fog(tint as unknown as Node<'float'>, factor);
});

/** Install the fog on the scene: every node material with `fog` on picks it up at its first compile. */
export function installAtmosphere(scene: Scene): void {
  scene.fogNode = heightFog();
}
