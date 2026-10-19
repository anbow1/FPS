import { cameraPosition, cross, dot, exp, float, length, materialOpacity, max, min, mix, modelNormalMatrix, modelWorldMatrix, normalize, normalLocal, positionLocal, positionWorld, pow, select, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, type MeshPhysicalNodeMaterial, type Node, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector3 } from 'three/webgpu';

// Hairline scratches in the canopy's acrylic, which catch the sun the way a
// real one does from the seat: in arcs round the sun, and as a glow of every
// scratch at once looking toward it. A scratch is a thin cylinder: light
// along −L leaves it on a cone about its axis T with T·out = T·(−L), so the
// eye at V sees it only where T·(V + L) = 0. Over a pane the scratches that
// meet that lie across the line toward the sun's highlight — the swirl of
// concentric arcs. Looking at the sun, V ≈ −L and every scratch meets it.
//
// The scratches are baked once into a tileable map: coverage, and the
// direction as a double angle (a scratch has no head or tail) weighted by
// coverage, so the mips average to the dominant direction where they blur.

/** Sunlight on the glass, colour × illuminance in the scene's pre-exposed units; zero while the sun is hidden. */
export const scratchSun = uniform(new Vector3());
/** Unit direction toward the sun, world. */
export const scratchSunDir = uniform(new Vector3(0, 1, 0));

/** One repeat of the scratch map on the glass (m). */
const TILE_M = 0.35;
const RES = 1024;
/** Width of the cone condition, T·(V + L): sharper is a thinner arc. */
const SIGMA = 0.045;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function bake(): DataTexture {
  const cov = new Float32Array(RES * RES);
  const c2 = new Float32Array(RES * RES);
  const s2 = new Float32Array(RES * RES);
  const r = rng(7331);
  const wrap = (i: number): number => ((i % RES) + RES) % RES;
  const deposit = (x: number, y: number, angle: number, depth: number): void => {
    const k = wrap(Math.floor(y)) * RES + wrap(Math.floor(x));
    if (depth <= (cov[k] as number)) return;
    cov[k] = depth;
    c2[k] = Math.cos(2 * angle);
    s2[k] = Math.sin(2 * angle);
  };
  // Straight hairlines from grit, 7 mm to 9 cm (a texel is 0.34 mm); a few deeper ones. A canopy that is
  // looked after has a couple of thousand to the square metre — at seven thousand it read as hail.
  for (let i = 0; i < 240; i++) {
    const x0 = r() * RES;
    const y0 = r() * RES;
    const a = r() * Math.PI;
    const len = 20 + r() ** 2 * 250;
    const depth = 0.25 + r() ** 3 * 0.75;
    for (let t = 0; t < len; t += 0.4) deposit(x0 + Math.cos(a) * t, y0 + Math.sin(a) * t, a, depth);
  }
  // Wiping swirls: arcs of a cloth's circles, 3–20 cm across, fainter.
  for (let i = 0; i < 80; i++) {
    const cx = r() * RES;
    const cy = r() * RES;
    const rad = 90 + r() * 500;
    const a0 = r() * Math.PI * 2;
    const span = (40 + r() * 320) / rad;
    const depth = 0.2 + r() * 0.35;
    for (let t = 0; t < span; t += 0.4 / rad) {
      const a = a0 + t;
      deposit(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, a + Math.PI / 2, depth);
    }
  }
  const data = new Uint8Array(RES * RES * 4);
  for (let k = 0; k < RES * RES; k++) {
    const c = cov[k] as number;
    data[k * 4] = Math.round(c * 255);
    data[k * 4 + 1] = Math.round((0.5 + 0.5 * c * (c2[k] as number)) * 255);
    data[k * 4 + 2] = Math.round((0.5 + 0.5 * c * (s2[k] as number)) * 255);
    data[k * 4 + 3] = 255;
  }
  const t = new DataTexture(data, RES, RES, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

let map: DataTexture | null = null;

/** Adds the scratches to a canopy glass material: an emissive glint and the opacity it needs to show. */
export function addCanopyScratches(m: MeshPhysicalNodeMaterial): void {
  map ??= bake();
  const n = normalize(normalLocal);
  // A frame on the pane from a fixed axis, the model's forward, or its up on panes facing along it.
  const ref = select(n.z.abs().greaterThan(0.85), vec3(0, 1, 0), vec3(0, 0, -1));
  const t1 = normalize(ref.sub(n.mul(dot(ref, n))));
  const t2 = cross(n, t1);
  const s = texture(map, vec2(dot(positionLocal, t1), dot(positionLocal, t2)).div(TILE_M));
  const cover = s.r;
  // The double angle back to a direction on the pane (either sign of it: a scratch has no head).
  const d2 = s.gb.sub(0.5).mul(2);
  const u = d2.div(max(length(d2), 1e-4));
  const cosA = sqrt(max(u.x.add(1).mul(0.5), 0));
  const sinA = sqrt(max(float(1).sub(u.x).mul(0.5), 0)).mul(select(u.y.lessThan(0), float(-1), float(1)));
  const T = normalize(modelWorldMatrix.mul(vec4(t1.mul(cosA).add(t2.mul(sinA)), 0)).xyz);
  const V = normalize(cameraPosition.sub(positionWorld));
  const L = scratchSunDir;
  const k = dot(T, V).add(dot(T, L));
  const glint = exp(k.mul(k).div(-2 * SIGMA * SIGMA));
  // Most of a scratch's light goes on near the sun's own direction (forward scattering): looking toward the
  // sun the canopy lights up, elsewhere only the odd arc. Only where the sun falls on the pane's outside.
  const outward = normalize(modelNormalMatrix.mul(normalLocal));
  const lit = smoothstep(-0.02, 0.12, dot(outward, L));
  const forward = mix(float(0.04), float(1.2), pow(max(dot(V, L).negate(), 0), 8));
  const w = cover.mul(glint).mul(lit).mul(forward) as Node<'float'>;
  // Over a near-clear glass: the glint added on top of what is seen through it, whatever the opacity.
  const base = (m.opacityNode as Node<'float'> | null) ?? materialOpacity;
  const extra = min(w.mul(0.5), 0.5);
  const opacity = base.add(extra);
  m.opacityNode = opacity;
  // A scratch reflects a few per cent and is narrower than a pixel: a fraction of the sun's light, not all of it.
  m.emissiveNode = scratchSun.mul(w.mul(0.15)).div(max(opacity, 0.05));
}
