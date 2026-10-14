import { cameraPosition, clamp, cos, dot, frontFacing, fwidth, select, exp, float, length, max, min, mix, normalize, positionLocal, positionWorld, pow, modelPosition, reflect, screenUV, sin, smoothstep, sqrt, texture, varying, vec2, vec3, viewportSharedTexture } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DataTexture, DataUtils, DoubleSide, HalfFloatType, LinearFilter, Mesh, MeshBasicNodeMaterial, type Node, RedFormat, type Vector3 } from 'three/webgpu';
import { OceanFFT } from './ocean.ts';
import { waveWarp } from './waveWarp.ts';
import { hexToLinear } from './colour.ts';
import { SHORE, WATER_LEVEL_M, WAVES } from '../config.ts';
import { SHORE_DOMAIN, seabedHeights } from './shoreField.ts';
import { screenReflection } from './screenReflection.ts';
import { skyRadiance } from './sky.ts';
import { causticFoamMap } from './textures.ts';
import { U } from './uniforms.ts';
import { rainRings, splashRipples, underwaterTint, wakeFoam } from './waterFx.ts';
import { laceCover, shoreSurface, surfFoam } from './shoreWaves.ts';
import { CAUSTIC_TILE_M, rippleSlope } from './caustics.ts';

// The lagoon and the sea beyond it. A radial grid follows the camera; Gerstner
// waves (GPU Gems 1, ch. 1) displace it, damped where the water is shallow.
// Shading is done by hand, not by a lit material, so every term is explicit:
//   refraction  the already-rendered floor, distorted by the surface normal,
//               attenuated by Beer–Lambert absorption along the path down and
//               back up (red dies first → turquoise over white sand, navy in
//               the deep), plus single-scattered sun and sky light;
//   reflection  the same analytic sky as the dome (clouds, sun, moon), with a
//               Schlick Fresnel for water (F0 = 0.02) and a glitter lobe;
//   foam        at the shoreline (lines running up the beach), on crests in a
//               storm, and around splashes;
//   ripples     from splashes and raindrops, perturbing the normal;
//   wind sea    a GPU FFT (ocean.ts) for the detail normals of deep water.

const DEPTH_MAP = { ...SHORE_DOMAIN, px: SHORE.res } as const;

export function buildWater(quality: 'high' | 'low'): { mesh: Mesh; depthMap: DataTexture; ocean: OceanFFT } {
  const depthMap = bakeDepthMap();
  const sea = WAVES.openSea;
  const dir = (sea.directionDeg * Math.PI) / 180;
  const ocean = new OceanFFT({
    n: quality === 'high' ? 256 : 128,
    size: sea.patchM,
    peakWavelength: sea.peakWavelengthM,
    targetSlope: sea.rmsSlope,
    wind: [Math.cos(dir), Math.sin(dir)],
  });
  const mesh = new Mesh(radialGrid(), waterMaterial(depthMap, ocean, quality));
  mesh.frustumCulled = false;
  mesh.name = 'water';
  mesh.renderOrder = 10;
  return { mesh, depthMap, ocean };
}

/** Floor height below sea level, half float, 1.2 m per texel (the heights are shared with the wave field). */
function bakeDepthMap(): DataTexture {
  const n = DEPTH_MAP.px;
  const heights = seabedHeights();
  const data = new Uint16Array(n * n);
  for (let k = 0; k < n * n; k++) data[k] = DataUtils.toHalfFloat(heights[k] as number);
  const t = new DataTexture(data, n, n, RedFormat, HalfFloatType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Concentric rings: 0.35 m apart near the eye, growing 4.5 % per ring out to 6 km. */
function radialGrid(): BufferGeometry {
  const radii: number[] = [0];
  let r = 0;
  while (r < 6000) {
    r = r < 22 ? r + 0.35 : r * 1.045;
    radii.push(Math.min(r, 6000));
  }
  const segs = 256;
  const pos: number[] = [0, 0, 0];
  for (let k = 1; k < radii.length; k++) {
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * (radii[k] as number), 0, Math.sin(a) * (radii[k] as number));
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let k = 1; k < radii.length - 1; k++) {
    const a0 = 1 + (k - 1) * segs;
    const b0 = 1 + k * segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

/** Where the grid is centred: snapped to the finest ring spacing so it never swims. */
export function placeWater(mesh: Mesh, eye: Vector3): void {
  mesh.position.set(Math.round(eye.x / 0.35) * 0.35, WATER_LEVEL_M, Math.round(eye.z / 0.35) * 0.35);
}

function waterMaterial(depthMap: DataTexture, ocean: OceanFFT, quality: 'high' | 'low'): MeshBasicNodeMaterial {
  // Double-sided: a swimmer sees the surface from below (Snell's window).
  const m = new MeshBasicNodeMaterial({ name: 'water', transparent: true, depthWrite: true, side: DoubleSide });
  const cf = causticFoamMap();

  // ── Vertex: Gerstner displacement, damped in the shallows and at range.
  const baseXZ = positionLocal.xz.add(modelPosition.xz);
  const depthUv = baseXZ.sub(vec2(DEPTH_MAP.x0, DEPTH_MAP.z0)).div(DEPTH_MAP.sizeM);
  const inMap = depthUv.x.greaterThan(0).and(depthUv.x.lessThan(1)).and(depthUv.y.greaterThan(0)).and(depthUv.y.lessThan(1));
  const floorV = inMap.select(texture(depthMap, depthUv).level(float(0)).r, float(-40));
  const depthV = max(float(WATER_LEVEL_M).sub(floorV), 0);
  const range = length(positionLocal.xz);
  // Short wind chop everywhere; the long swell only beyond the baked shore field, where the
  // field's own depth-aware waves (shoreWaves.ts) do not reach. Their phases agree in deep water.
  const edgeDist = min(min(depthUv.x, float(1).sub(depthUv.x)), min(depthUv.y, float(1).sub(depthUv.y)));
  const outside = float(1).sub(smoothstep(0.0, 0.06, edgeDist));
  const chopAmp = U.waveScale.mul(smoothstep(0.05, 2.8, depthV)).mul(float(1).sub(smoothstep(250, 1400, range)));
  let dx: Node<'float'> = float(0);
  let dy: Node<'float'> = float(0);
  let dz: Node<'float'> = float(0);
  let nx: Node<'float'> = float(0);
  let nz: Node<'float'> = float(0);
  let ny: Node<'float'> = float(0);
  for (const w of WAVES.components) {
    const k = (2 * Math.PI) / w.wavelengthM;
    const omega = Math.sqrt(9.81 * k);
    const a = (w.directionDeg * Math.PI) / 180;
    const d = vec2(Math.cos(a), Math.sin(a));
    const phase = dot(d, baseXZ).mul(k).sub(U.time.mul(omega));
    const swell = w.wavelengthM >= 8;
    const A = chopAmp.mul(w.amplitudeM).mul(swell ? outside : float(1));
    const c = cos(phase);
    const s = sin(phase);
    dx = dx.add(A.mul(w.steepness).mul(d.x).mul(c));
    dz = dz.add(A.mul(w.steepness).mul(d.y).mul(c));
    dy = dy.add(A.mul(s));
    nx = nx.add(A.mul(k).mul(d.x).mul(c));
    nz = nz.add(A.mul(k).mul(d.y).mul(c));
    ny = ny.add(A.mul(k).mul(w.steepness).mul(s));
  }
  const shore = shoreSurface(baseXZ, depthV);
  const shoreK = float(1).sub(outside);
  m.positionNode = positionLocal.add(vec3(dx, dy, dz)).add(shore.disp.mul(shoreK));
  const vNormal = varying(normalize(vec3(nx.negate().sub(shore.slope.x.mul(shoreK)), float(1).sub(ny), nz.negate().sub(shore.slope.y.mul(shoreK)))), 'vWaveNormal');
  const vCrest = varying(max(dy.div(max(chopAmp.mul(0.2), 0.01)), shore.crest.mul(shoreK).mul(2)), 'vCrest');
  // The continuous wave count (not its wrapped phase) is what interpolates cleanly across a triangle.
  const vShoreS = varying(shore.s, 'vShoreS');
  const vBreak = varying(shore.breaking.mul(shoreK), 'vBreak');
  const vShoreDir = varying(shore.dir, 'vShoreDir');

  // ── Fragment.
  const p = positionWorld;
  const toEye = cameraPosition.sub(p);
  const dist = length(toEye);
  const V = toEye.div(dist);
  const uvD = p.xz.sub(vec2(DEPTH_MAP.x0, DEPTH_MAP.z0)).div(DEPTH_MAP.sizeM);
  const inside = uvD.x.greaterThan(0).and(uvD.x.lessThan(1)).and(uvD.y.greaterThan(0)).and(uvD.y.lessThan(1));
  const floorY = inside.select(texture(depthMap, uvD).r, float(-40));
  const depth = max(float(WATER_LEVEL_M).sub(floorY), 0);

  // Detail normals: two wind-driven scrolls, faded with distance against aliasing.
  const wind = U.wind;
  const windLen = length(wind).max(0.1);
  const flow = wind.div(windLen).mul(U.time);
  // Detail ripples: two wind-driven layers, the same ones the caustics are splatted from.
  const detail = rippleSlope(p.xz.div(CAUSTIC_TILE_M), false).div(dist.mul(0.012).add(1));
  const splash = splashRipples(p.xz);
  const rain = rainRings(p.xz).div(dist.mul(0.08).add(1));
  // Wind sea from the FFT (a height gradient, like the ripple field) over deep water; the tiled
  // ripples stay at half strength there for detail finer than the FFT grid.
  const L = WAVES.openSea.patchM;
  // Both copies are read through one smooth domain warp (waveWarp.ts), so the 64 m patch shows
  // no period even across the whole open sea; the slope goes back through the warp's Jacobian.
  const warp = waveWarp(p.xz, L * 4, L * 0.7, 17);
  const q = warp.lookup;
  const fftA = texture(ocean.surface.texture, q.div(L)).yz;
  const fftB = texture(ocean.surface.texture, vec2(q.x.mul(0.8).add(q.y.mul(0.6)), q.y.mul(0.8).sub(q.x.mul(0.6))).div(L * 0.41).add(0.37)).yz;
  const fft = warp.slope(fftA.add(vec2(fftB.x.mul(0.8).sub(fftB.y.mul(0.6)), fftB.x.mul(0.6).add(fftB.y.mul(0.8))).mul(0.12))).mul(sqrt(U.waveScale));
  const open = smoothstep(2.5, WAVES.openSea.fullDepthM, depth);
  const slope = detail.mul(float(1).sub(open.mul(0.5))).add(rain);
  // The ripple field and the FFT give height gradients: the normal leans against them.
  const grad = splash.xy.add(fft.mul(open));
  const N = normalize(vNormal.add(vec3(slope.x.sub(grad.x), 0, slope.y.negate().sub(grad.y))));

  const NdotV = clamp(dot(N, V), 0.001, 1);
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), float(5))));
  const R = reflect(V.negate(), N);
  const Rup = normalize(vec3(R.x, max(R.y, 0.004), R.z));
  // Glitter: a lobe of the sun (or moon) seen in the ripples, sharp where a pixel covers less
  // than one ripple and broader where it covers many (after ClearWater6.1 by SamG-Coder, MIT).
  // The amplitude scales with the exponent, so the lobe keeps its energy: far water shows a soft
  // sun path instead of single pixels flickering on and off.
  const footprintM = max(length(fwidth(p.xz)), 1e-4);
  const glintPower = mix(float(90), float(900), float(1).div(footprintM.mul(footprintM).mul(800).add(1)));
  const sunCos = max(dot(Rup, U.sunDir), 0);
  const glint = pow(sunCos, glintPower).mul(glintPower.mul(8 / 900)).add(pow(sunCos, 120).mul(0.35));
  const skyReflection = skyRadiance(Rup, float(1))
    .add(U.sunIrradiance.mul(glint).mul(float(1).sub(U.cloudCover.mul(0.9))))
    .add(U.moonRadiance.mul(pow(max(dot(Rup, U.moonDir), 0), 300).mul(0.02)));
  // On High the palms, rocks, boat and hills are mirrored too, where the screen holds them
  // (screenReflection.ts); the sky, sun and moon stay analytic behind them.
  let reflection: Node<'vec3'> = skyReflection;
  if (quality === 'high') {
    const ssr = screenReflection(p, Rup);
    reflection = mix(skyReflection, ssr.colour, ssr.weight);
  }

  // Refraction: the floor seen through the surface, distorted less where it is shallow.
  const distortion = N.xz.mul(0.045).mul(smoothstep(0.0, 1.5, depth)).div(dist.mul(0.02).add(1));
  const behind = viewportSharedTexture(screenUV.add(vec2(distortion.x, distortion.y.negate()))).rgb;
  // Path under water: down to the floor along the refracted ray, and the sunlight's own way down.
  const cosIn = sqrt(float(1).sub(float(1).sub(V.y.mul(V.y)).div(1.77)));
  const path = depth.div(max(cosIn, 0.15)).add(depth);
  const absorb = vec3(WAVES.absorptionPerM.r, WAVES.absorptionPerM.g, WAVES.absorptionPerM.b);
  const T = exp(absorb.mul(path).negate());
  const sc = hexToLinear(WAVES.scatterColour);
  const deep = hexToLinear(WAVES.deepColour);
  const ambient = U.sunIrradiance.mul(max(U.sunDir.y, 0)).add(U.skyIrradiance).div(Math.PI);
  const scatterTint = mix(vec3(sc.r, sc.g, sc.b), vec3(deep.r, deep.g, deep.b), smoothstep(2, 14, depth));
  const scatter = scatterTint.mul(ambient).mul(0.55).mul(float(1).sub(T.g));
  // Light through the backs of crests.
  const sss = vec3(sc.r, sc.g, sc.b).mul(U.sunIrradiance).mul(pow(max(dot(V, U.sunDir.negate().add(vec3(0, 0.3, 0)).normalize()), 0), 4)).mul(max(vCrest, 0)).mul(0.04);
  // Stirred-up sand makes the surf zone milkier.
  const underwater = mix(behind.mul(T).add(scatter).add(sss), vec3(0.55, 0.56, 0.5).mul(ambient), vBreak.mul(0.35));

  // Foam: whitewater and the lace it leaves behind breaking waves (shoreWaves.ts), a thin lacy
  // edge where the water meets the sand, wind whitecaps on the chop in a storm, and splashes.
  const foamTex = texture(cf, p.xz.div(2.2).add(flow.mul(0.01))).g;
  const surf = surfFoam(p.xz, vShoreS, vBreak, vShoreDir);
  const edgeLace = laceCover(p.xz, float(1).sub(smoothstep(0.01, 0.06, depth)).mul(0.3), float(0));
  const crestFoam = smoothstep(0.8, 1.6, vCrest).mul(smoothstep(1.3, 2.4, U.waveScale));
  // The boat's wake and old splashes (wakeFoam.ts): foam that lasts, torn into lace as it thins.
  // Its own lace offset and a finer scale, so a trail never repeats the surf's pattern.
  const wakeLace = laceCover(p.xz.mul(1.4).add(vec2(11.3, 4.7)), wakeFoam(p.xz).mul(0.85), float(5.3));
  const foam = clamp(max(max(surf, edgeLace), wakeLace).add(crestFoam.add(smoothstep(0.35, 1.0, splash.z)).mul(foamTex.mul(1.6))), 0, 1);

  const foamLight = U.sunIrradiance.mul(max(dot(N, U.sunDir), 0)).add(U.skyIrradiance).div(Math.PI).mul(0.8);

  const surface = mix(underwater, reflection, fresnel);
  // Right at the waterline the film is thin: fade the surface into the wet sand behind it.
  const edge = smoothstep(0.0, 0.05, depth);
  const above = mix(behind, mix(surface, foamLight, foam), edge);

  // From below: inside Snell's window (48.6° from the vertical) the sky refracted through the
  // surface, darkened by the Fresnel reflection back down; outside it total internal reflection
  // mirrors the water itself, which is the colour the underwater pass fades toward.
  const up = V.negate();
  const cosUp = clamp(dot(up, N), 0, 1);
  const sinT = sqrt(float(1).sub(cosUp.mul(cosUp))).mul(1.333);
  const tir = smoothstep(0.97, 1.0, sinT);
  const cosT = sqrt(max(float(1).sub(sinT.mul(sinT)), 0));
  const outDir = normalize(up.mul(1.333).add(N.mul(cosT.sub(cosUp.mul(1.333)))));
  const fresnelIn = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosT), float(5))));
  const skyIn = skyRadiance(normalize(vec3(outDir.x, max(outDir.y, 0.004), outDir.z)), float(1))
    .add(U.sunIrradiance.mul(pow(max(dot(outDir, U.sunDir), 0), 300).mul(2)));
  const tint = underwaterTint();
  const snell = mix(skyIn.mul(float(1).sub(fresnelIn)).add(tint.mul(fresnelIn)), tint, tir);
  const below = mix(snell, tint.mul(0.6).add(foamLight.mul(0.25)), foam);
  m.colorNode = select(frontFacing, above, below);
  m.opacityNode = float(1);
  return m;
}
