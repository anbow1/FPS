import { cameraPosition, clamp, dot, exp, float, floor, Fn, hash, max, mix, normalize, positionWorld, pow, sin, smoothstep, texture, vec3 } from 'three/tsl';
import { BackSide, DataTexture, type Node, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicNodeMaterial, RepeatWrapping, RGBAFormat, SphereGeometry, UnsignedByteType } from 'three/webgpu';
import { tileFbm } from '../core/noise.ts';
import { U } from './uniforms.ts';

// A single-layer analytic sky: horizon→zenith gradient calibrated to the sky
// illuminance, a Mie glow and a warm horizon band toward the sun, the sun and
// moon discs, stars, and a wind-driven cloud deck whose coverage follows the
// weather. The same function lights the environment probe (without the sun
// disc: the directional light already carries the sun), reflects in the water
// and colours the fog, so horizon, haze and reflections always agree.

type N3 = Node<'vec3'>;

const SUN_DISC_COS_OUTER = Math.cos((0.72 * Math.PI) / 180);
const SUN_DISC_COS_INNER = Math.cos((0.6 * Math.PI) / 180);
const MOON_DISC_COS = Math.cos((0.95 * Math.PI) / 180);
const CLOUD_HEIGHT_M = 1600;
const CLOUD_TILE_M = 5200;

let cloudTexture: DataTexture | null = null;

/** Tileable cloud noise: R = broad billows, G = mid detail, B = fine wisps. */
export function getCloudTexture(): DataTexture {
  if (cloudTexture) return cloudTexture;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 4;
      const v = (y / size) * 4;
      const i = (y * size + x) * 4;
      data[i] = Math.round(Math.min(1, tileFbm(u, v, 4, 5, 3) * 1.05) * 255);
      data[i + 1] = Math.round(Math.min(1, tileFbm(u * 2, v * 2, 8, 5, 11)) * 255);
      data[i + 2] = Math.round(Math.min(1, tileFbm(u * 4, v * 4, 16, 4, 29)) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  cloudTexture = t;
  return t;
}

/** Cloud density 0..1 along a view direction (0 below the horizon). */
export const cloudDensity = Fn(([dir]: [N3]) => {
  const tex = getCloudTexture();
  const up = max(dir.y, 0.015);
  const p = dir.xz.mul(float(CLOUD_HEIGHT_M).div(up));
  const uv = p.div(CLOUD_TILE_M).add(U.cloudOffset);
  const n = texture(tex, uv).r.mul(0.62).add(texture(tex, uv.mul(2.3).add(0.37)).g.mul(0.27)).add(texture(tex, uv.mul(6.1)).b.mul(0.11));
  const threshold = mix(float(0.66), float(0.2), U.cloudCover);
  const d = smoothstep(threshold, threshold.add(0.22), n);
  // Full overcast becomes a continuous deck.
  const deck = smoothstep(0.82, 1.0, U.cloudCover);
  const horizonFade = smoothstep(0.0, 0.1, dir.y);
  return mix(d, float(0.92).add(n.mul(0.08)), deck).mul(horizonFade);
});

/** Clear-sky radiance along a unit direction, pre-exposed. */
export const skyGradient = Fn(([dir]: [N3]) => {
  const y = dir.y;
  const up = max(y, 0);
  const base = mix(U.horizonRadiance, U.zenithRadiance, pow(up, 0.45));
  const mu = max(dot(dir, U.sunDir), 0);
  const glow = U.sunGlowRadiance.mul(pow(mu, 6).mul(0.3).add(pow(mu, 60).mul(1.6)));
  const sunFlat = normalize(vec3(U.sunDir.x, 0.0001, U.sunDir.z));
  const dirFlat = normalize(vec3(dir.x, 0.0001, dir.z));
  const band = U.sunGlowRadiance.mul(pow(max(dot(dirFlat, sunFlat), 0), 3).mul(exp(up.mul(-7))).mul(0.55));
  // Below the horizon the probe sees the lit ground: the bounce light that fills beach shadows.
  const below = float(1).sub(smoothstep(-0.12, 0.0, y)); // GLSL smoothstep needs edge0 < edge1
  return mix(base.add(glow).add(band), U.groundRadiance, below);
});

/**
 * Full sky: gradient, stars, moon, optional sun disc, cloud deck, lightning.
 * `withSun` is 0 for the environment probe.
 */
export const skyRadiance = Fn(([dir, withSun]: [N3, Node<'float'>]) => {
  const up = max(dir.y, 0);
  // Stars: a sparse hashed grid on the sphere, twinkling, only where it is dark.
  const cell = floor(dir.mul(260));
  const h = hash(cell.x.add(cell.y.mul(419.0)).add(cell.z.mul(137.0)));
  const star = smoothstep(0.9965, 1.0, h).mul(sin(U.time.mul(h.mul(9)).add(h.mul(100))).mul(0.35).add(0.65));
  const stars = vec3(0.85, 0.9, 1.0).mul(star.mul(U.starBrightness).mul(smoothstep(0.02, 0.2, up)));
  // Moon, with a little mottling.
  const muMoon = dot(dir, U.moonDir);
  const moonDisc = smoothstep(MOON_DISC_COS, MOON_DISC_COS + 0.00002, muMoon);
  const mottle = float(0.82).add(hash(floor(dir.mul(2400)).x.add(floor(dir.mul(2400)).y.mul(31))).mul(0.18));
  const moon = U.moonRadiance.mul(moonDisc.mul(mottle)).add(U.moonRadiance.mul(0.0012).mul(pow(max(muMoon, 0), 40)));
  // Sun disc with limb darkening.
  const mu = dot(dir, U.sunDir);
  const disc = smoothstep(SUN_DISC_COS_OUTER, SUN_DISC_COS_INNER, mu);
  const clear = skyGradient(dir).add(stars).add(moon).add(U.sunDiscRadiance.mul(disc.mul(withSun)));
  // Cloud deck over everything above.
  const d = cloudDensity(dir);
  const silver = pow(max(mu, 0), 5).mul(float(1).sub(d)).mul(1.6);
  const lit = mix(U.cloudShade, U.cloudLit, clamp(float(1).sub(d.mul(0.75)).add(silver), 0, 2));
  const cloud = lit.add(U.cloudLit.mul(U.lightning.mul(4)));
  return mix(clear, cloud, d);
});

/** Fog / aerial-perspective colour for a view direction: the sky just above the horizon. */
export const hazeColour = Fn(([dir]: [N3]) => {
  const flat = normalize(vec3(dir.x, max(dir.y, 0).mul(0.25).add(0.02), dir.z));
  const g = skyGradient(flat);
  const overcast = mix(g, U.cloudShade.mul(1.1), smoothstep(0.6, 1.0, U.cloudCover));
  return overcast.add(U.cloudLit.mul(U.lightning.mul(1.5)));
});

/** The visible dome. Drawn first, never writes depth, never fogged. */
export function buildSkyDome(withSun: boolean): Mesh {
  const m = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  const dir = normalize(positionWorld.sub(cameraPosition));
  m.colorNode = skyRadiance(dir, float(withSun ? 1 : 0));
  const mesh = new Mesh(new SphereGeometry(1, 64, 32), m);
  mesh.scale.setScalar(4000);
  mesh.frustumCulled = false;
  // Under a reversed depth buffer the far plane is the near value: draw it before everything.
  mesh.renderOrder = -1000;
  mesh.name = withSun ? 'sky' : 'sky-probe';
  return mesh;
}
