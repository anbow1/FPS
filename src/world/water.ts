import * as THREE from 'three';
import { HEIGHT_CELL, WATER_LEVEL, WORLD_SIZE } from '../config';
import type { Lighting } from '../render/lighting';
import { OceanFFT } from '../render/ocean';
import { linear, PBR } from '../render/palette';
import { G } from '../render/shaderPatch';
import type { NoiseSet } from '../render/textures';
import type { Heightfield } from './heightfield';
import { LAKES } from './layout';

/**
 * Lake water in the spirit of "Clearwater" (Aurélien, MIT): FFT wind waves, exact dielectric
 * Fresnel, Beckmann sun glints widened by the slope variance of the wave mip chain (LEAN), and a
 * refracted view of the lake bed traced through the real terrain height with Beer–Lambert
 * absorption and in-scattering. Caustics come from first-order lensing: the divergence of the
 * surface slope where the sun ray entered focuses or spreads the light on the bed.
 *
 * Water optics follow the material sheet: river tint #3E5A4C, attenuation distance 1.5 m, IOR 1.33.
 */
export class Water {
  readonly group = new THREE.Group();
  private readonly ocean: OceanFFT;
  private readonly material: THREE.ShaderMaterial;

  constructor(renderer: THREE.WebGLRenderer, hf: Heightfield, noise: NoiseSet, lighting: Lighting, detail: 'high' | 'low') {
    this.ocean = new OceanFFT(renderer, {
      n: detail === 'high' ? 256 : 128,
      size: 22,
      peakWavelength: 2.4,
      targetSlope: 0.085,
      wind: [G.uWind.value.x, G.uWind.value.y],
    });
    const heightTex = makeHeightTexture(hf);
    // Beer–Lambert with the sheet's river tint. The sheet's 1.5 m attenuation is for a murky river;
    // these upland lakes are clearer, so the same tint is reached after 3.2 m.
    const tint = linear(PBR.water.color);
    const sigT = new THREE.Vector3(-Math.log(tint.r), -Math.log(tint.g), -Math.log(tint.b)).divideScalar(3.2);
    const sigS = sigT.clone().multiply(new THREE.Vector3(0.06, 0.16, 0.12));
    const sky = lighting.sky.material.uniforms;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      defines: { CAUSTICS: detail === 'high' ? 1 : 0 },
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uSurf: { value: null },
          uL: { value: this.ocean.size },
          tHeight: { value: heightTex },
          tNoise: { value: noise.texture },
          uWorld: { value: new THREE.Vector2(WORLD_SIZE / 2, WORLD_SIZE + HEIGHT_CELL) },
          uWater: { value: WATER_LEVEL },
          uSigT: { value: sigT },
          uSigS: { value: sigS },
          cMud: { value: linear(PBR.mudWet.color) },
          cSand: { value: linear(PBR.sand.color) },
          cRock: { value: linear(PBR.rock.color) },
          cShore: { value: linear(PBR.pineFoliage.color) },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        out vec3 vWPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        #include <common>
        #include <fog_pars_fragment>
        in vec3 vWPos;
        uniform sampler2D uSurf, tHeight, tNoise;
        uniform float uL, uWater, uTime, uThermal, uHaze;
        uniform vec2 uWorld;
        uniform vec3 uSigT, uSigS, cMud, cSand, cRock, cShore;
        uniform vec3 uSun, uZenith, uHorizon, uGround, uGlow, uSunBeam, uAmb;
        const float IOR = 1.333;

        float fres(float ci, float n) {
          ci = clamp(ci, 0.0, 1.0);
          float st2 = (1.0 - ci * ci) / (n * n);
          if (st2 >= 1.0) return 1.0;
          float ct = sqrt(1.0 - st2);
          float rs = (ci - n * ct) / (ci + n * ct), rp = (n * ci - ct) / (n * ci + ct);
          return 0.5 * (rs * rs + rp * rp);
        }
        // same analytic sky as the dome, without the disk (glints handle the sun)
        vec3 skyCol(vec3 d) {
          float h = d.y;
          vec3 c = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), mix(0.45, 0.9, uHaze)));
          float mu = dot(d, uSun);
          float g = mix(0.76, 0.6, uHaze);
          c += uGlow * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.08 * (0.35 + exp(-abs(h) * mix(9.0, 3.0, uHaze)));
          return c;
        }
        float terrainH(vec2 xz) { return texture(tHeight, (xz + uWorld.x) / uWorld.y).r; }
        vec4 surf(vec2 xz) { return texture(uSurf, xz / uL); }
        const mat2 M = mat2(0.8, -0.6, 0.6, 0.8);
        vec2 slopeAt(vec2 xz) {
          vec2 a = texture(uSurf, xz / uL).yz;
          vec2 b = texture(uSurf, (M * xz) / (uL * 0.41) + 0.37).yz;
          return a + 0.12 * (transpose(M) * b);
        }

        void main() {
          vec3 P = vWPos;
          vec3 toCam = cameraPosition - P;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          vec3 wd = -V;
          float depthHere = uWater - terrainH(P.xz);
          if (depthHere < -0.05) discard;

          // ---- wave normal: two FFT layers + a close-up chop layer; variance from the mips (LEAN)
          vec4 A = texture(uSurf, P.xz / uL);
          vec4 B = texture(uSurf, (M * P.xz) / (uL * 0.41) + 0.37);
          vec2 slope = A.yz + 0.12 * (transpose(M) * B.yz);
          const mat2 M2 = mat2(0.28, 0.96, -0.96, 0.28);
          vec4 Cm = texture(uSurf, (M2 * P.xz) / (uL * 0.13) + 0.71);
          slope += 0.13 * exp(-dist * 0.05) * (transpose(M2) * Cm.yz);
          float var = max(A.w - dot(A.yz, A.yz), 0.0) + 0.0144 * max(B.w - dot(B.yz, B.yz), 0.0);
          // shallow margins are calmer
          slope *= smoothstep(0.0, 0.8, depthHere) * 0.7 + 0.3;
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
          float nv = dot(n, V);
          if (nv < 0.02) { n = normalize(n + V * (0.02 - nv)); nv = dot(n, V); }
          float F = fres(nv, IOR);

          // ---- reflection: sky, with the dark treeline of the far shore mirrored near the horizon
          vec3 rr = reflect(wd, n); rr.y = abs(rr.y);
          vec3 refl = skyCol(rr);
          float shore = smoothstep(0.1, 0.012, rr.y);
          refl = mix(refl, cShore * (uAmb * 1.3 + uSunBeam * 0.08), shore * 0.85);

          // ---- sun glint: Beckmann, roughness widened by slope variance
          float a2 = 0.00025 + 1.1 * var;
          vec3 h = normalize(V + uSun);
          float nh = max(dot(n, h), 0.0), nl = max(dot(n, uSun), 0.0);
          float c2 = max(nh * nh, 1e-4);
          float D = exp(-((1.0 - c2) / c2) / a2) / (PI * a2 * c2 * c2);
          float Vis = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2) + 1e-5);
          vec3 spec = uSunBeam * min(D * Vis * fres(max(dot(h, V), 0.0), IOR) * nl, 14.0);

          // ---- refraction: march the transmitted ray to the terrain under the lake
          vec3 tr = refract(wd, n, 1.0 / IOR);
          float s = max(depthHere, 0.02) / max(-tr.y, 0.05);
          vec3 FP = P + tr * s;
          for (int i = 0; i < 3; i++) {
            float fy = terrainH(FP.xz);
            s = max((fy - P.y) / tr.y, 0.0);
            FP = P + tr * s;
          }
          float bedDepth = max(uWater - FP.y, 0.0);
          // lake bed: wet mud with sandy, stony patches
          vec4 nz = texture(tNoise, FP.xz / 9.0);
          float fine = texture(tNoise, FP.xz / 1.7).b;
          vec3 alb = mix(cMud * 1.25, mix(cSand, cRock, 0.4) * 0.55, smoothstep(0.45, 0.7, nz.g + (fine - 0.5) * 0.3));
          alb *= 0.75 + 0.5 * fine;

          vec3 sunT = refract(-uSun, vec3(0.0, 1.0, 0.0), 1.0 / IOR);
          float Ts = 1.0 - fres(max(uSun.y, 0.0), IOR);
          float caus = 1.0;
          #if CAUSTICS
            // light entering at S was bent by the local wave lens; convergence brightens the bed
            vec2 S = FP.xz - sunT.xz * bedDepth / (-sunT.y);
            float e = 0.06;
            float div = (slopeAt(S + vec2(e, 0.0)).x - slopeAt(S - vec2(e, 0.0)).x + slopeAt(S + vec2(0.0, e)).y - slopeAt(S - vec2(0.0, e)).y) / (2.0 * e);
            caus = clamp(1.0 / (1.0 + 0.55 * bedDepth * div), 0.25, 6.0);
            caus = pow(caus, 1.6);
          #endif
          vec3 Esun = uSunBeam * Ts * exp(-uSigT * bedDepth / max(-sunT.y, 0.1)) * max(-sunT.y, 0.0) * caus;
          vec3 Esky = uAmb * PI * exp(-(uSigT - 0.6 * uSigS) * bedDepth * 1.2);
          vec3 Lbed = alb / PI * (Esun + Esky);
          vec3 Tv = exp(-uSigT * s);
          float cosS = dot(sunT, -tr);
          float g = 0.75;
          float ph = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * cosS, 1.5));
          vec3 Lmid = uSunBeam * Ts * exp(-uSigT * bedDepth * 0.5 / max(-sunT.y, 0.1)) * (ph + 0.08) + uAmb * 0.8;
          vec3 Lin = uSigS / uSigT * Lmid * (1.0 - Tv) * 1.4;
          vec3 under = Lbed * Tv + Lin;

          vec3 col = F * refl + (1.0 - F) * under + spec;
          // fade into the terrain mesh at the waterline
          float alpha = smoothstep(0.0, 0.25, depthHere);
          col = mix(col, vec3(0.01), uThermal);
          gl_FragColor = vec4(col, alpha);
          #include <fog_fragment>
        }`,
    });
    const u = this.material.uniforms;
    u.uSurf!.value = this.ocean.surface.texture;
    u.uTime = G.uTime;
    u.uThermal = G.uThermal;
    for (const k of ['uSun', 'uZenith', 'uHorizon', 'uGround', 'uGlow', 'uHaze'] as const) u[k] = sky[k]!;
    u.uSunBeam = { value: lighting.sunColor };
    u.uAmb = { value: lighting.ambient };

    for (const l of LAKES) {
      const g = new THREE.CircleGeometry(l.r * 1.4, 96);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.material);
      m.position.set(l.x, WATER_LEVEL, l.z);
      m.renderOrder = 1;
      this.group.add(m);
    }
  }

  update(renderer: THREE.WebGLRenderer, time: number, camera: THREE.Vector3): void {
    // no need to run the FFT when no lake is anywhere near the view
    let near = false;
    for (const l of LAKES) if (Math.hypot(camera.x - l.x, camera.z - l.z) < l.r + 900) near = true;
    if (near) this.ocean.update(renderer, time);
  }
}

/** Terrain heights as a half-float texture so the water shader can trace its own lake bed. */
function makeHeightTexture(hf: Heightfield): THREE.DataTexture {
  const n = hf.n;
  const data = new Uint16Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = THREE.DataUtils.toHalfFloat(hf.heights[i]!);
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
