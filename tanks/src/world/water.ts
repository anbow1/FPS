import * as THREE from 'three/webgpu';
import { abs, cameraPosition, clamp, Discard, dot, exp, float, Fn, fwidth, If, length, max, min, mix, normalize, positionWorld, pow, property, reflect, refract, select, sin, smoothstep, sqrt, texture, uniform, vec2, vec3 } from 'three/tsl';
import { cloudShadow } from '../render/atmosphere';
import { HEIGHT_CELL, WATER_LEVEL, WORLD_SIZE } from '../config';
import type { Lighting } from '../render/lighting';
import { OceanFFT } from '../render/ocean';
import { RippleField } from '../render/rippleField';
import { linear, PBR } from '../render/palette';
import { G, vnoise2 } from '../render/nodes';
import { screenReflection } from '../render/screenReflection';
import { waveWarp } from '../render/waveWarp';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
import type { NoiseSet } from '../render/textures';
import type { Heightfield } from './heightfield';
import { LAKES } from './layout';
import { hyp2 } from '../core/mathx';

/**
 * Lake water in the spirit of "Clearwater" (Aurélien, MIT): FFT wind waves, exact dielectric
 * Fresnel, Beckmann sun glints widened by the slope variance of the wave mip chain (LEAN), and a
 * refracted view of the lake bed traced through the real terrain height with Beer–Lambert
 * absorption and in-scattering. Caustics come from first-order lensing: the divergence of the
 * surface slope where the sun ray entered focuses or spreads the light on the bed.
 *
 * Shoreline foam is adapted from "WaterCuda" (SamG-Coder, MIT).
 *
 * Water optics follow the material sheet: river tint #3E5A4C, attenuation distance 1.5 m, IOR 1.33.
 */
export class Water {
  readonly group = new THREE.Group();
  /** Bow waves of wading hulls and rings from shells, round the camera (rippleField.ts). */
  readonly ripples: RippleField;
  private readonly ocean: OceanFFT;
  private readonly material: THREE.MeshBasicNodeMaterial;

  constructor(hf: Heightfield, noise: NoiseSet, lighting: Lighting, detail: 'high' | 'low') {
    this.ocean = new OceanFFT({
      n: detail === 'high' ? 256 : 128,
      size: 22,
      peakWavelength: 2.4,
      targetSlope: 0.085,
      wind: [G.uWind.value.x, G.uWind.value.y],
    });
    this.ripples = new RippleField({
      cells: detail === 'high' ? 128 : 96,
      cellM: 0.5,
      speedMps: 2.4,
      lifeS: 3,
      isWater: (x, z) => hf.heightAt(x, z) < WATER_LEVEL - 0.05,
    });
    const ripples = this.ripples;
    const heightTex = makeHeightTexture(hf);
    // Beer–Lambert with the sheet's river tint. The sheet's 1.5 m attenuation is for a murky river;
    // these upland lakes are clearer, so the same tint is reached after 3.2 m.
    const tint = linear(PBR.water.color);
    const sigTv = new THREE.Vector3(-Math.log(tint.r), -Math.log(tint.g), -Math.log(tint.b)).divideScalar(3.2);
    const sigSv = sigTv.clone().multiply(new THREE.Vector3(0.06, 0.16, 0.12));
    const sigT = vec3(sigTv.x, sigTv.y, sigTv.z);
    const sigS = vec3(sigSv.x, sigSv.y, sigSv.z);
    const c3 = (c: THREE.Color) => vec3(c.r, c.g, c.b);
    const cMud = c3(linear(PBR.mudWet.color));
    const cSand = c3(linear(PBR.sand.color));
    const cRock = c3(linear(PBR.rock.color));
    const cShore = c3(linear(PBR.pineFoliage.color));
    const L = this.ocean.size;
    const surfTex = this.ocean.surface.texture;
    const sky = lighting.skyU;
    const sunBeam = uniform(lighting.sunColor);
    const amb = uniform(lighting.ambient);
    const world = vec2(WORLD_SIZE / 2, WORLD_SIZE + HEIGHT_CELL);
    const IOR = 1.333;
    const caustics = detail === 'high';

    const fres = (ci0: F, n: number): F => {
      const ci = clamp(ci0, 0, 1);
      const st2 = float(1).sub(ci.mul(ci)).div(n * n);
      const ct = sqrt(max(float(1).sub(st2), 0));
      const rs = ci.sub(ct.mul(n)).div(ci.add(ct.mul(n)));
      const rp = ci.mul(n).sub(ct).div(ci.mul(n).add(ct));
      return select(st2.greaterThanEqual(1), float(1), rs.mul(rs).add(rp.mul(rp)).mul(0.5));
    };
    // same analytic sky as the dome, without the disk (glints handle the sun)
    const skyCol = (d: V3): V3 => {
      const h = d.y;
      const c = mix(sky.horizon, sky.zenith, pow(clamp(h, 0, 1), mix(0.45, 0.9, sky.haze)));
      const mu = dot(d, sky.sun);
      const g = mix(0.76, 0.6, sky.haze);
      const mie = float(1).sub(g.mul(g)).div(pow(float(1).add(g.mul(g)).sub(g.mul(2).mul(mu)), 1.5)).mul(0.08);
      return c.add(sky.glow.mul(mie).mul(exp(abs(h).negate().mul(mix(9, 3, sky.haze))).add(0.35)));
    };
    const terrainH = (xz: V2): F => texture(heightTex, xz.add(world.x).div(world.y)).r;
    // two FFT layers at different scales and a rotation, so the patch never tiles visibly
    const rot = (p: V2, c: number, s: number): V2 => vec2(p.x.mul(c).add(p.y.mul(s)), p.x.mul(-s).add(p.y.mul(c)));
    const rotT = (p: V2, c: number, s: number): V2 => vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
    // Every patch lookup goes through one smooth domain warp (waveWarp.ts, after ClearWater6.1):
    // the 22 m patch shows no period across a lake; slopes return through the warp's Jacobian.
    const warpOf = (xz: V2) => waveWarp(xz, L * 4, L * 0.7, 23);
    const slopeAt = (xz: V2): V2 => {
      const w = warpOf(xz);
      const a = texture(surfTex, w.lookup.div(L)).yz;
      const b = texture(surfTex, rot(w.lookup, 0.8, 0.6).div(L * 0.41).add(0.37)).yz;
      return w.slope(a.add(rotT(b, 0.8, 0.6).mul(0.12)));
    };
    const fpWeight = (fp: F, wl: number): F => float(1).sub(smoothstep(0.25 * wl, wl, fp));
    // Shoreline wash after WaterCuda (SamG-Coder, MIT): wave fronts anchored to the depth contour,
    // lacy breakup, trailing backwash and a thin contact line at the waterline.
    const shoreFoam = (p: V2, depth: F, fp: F, t: F): F => {
      const wb = fpWeight(fp, 4);
      const wf = fpWeight(fp, 1);
      const broad = vnoise2(p.add(vec2(t.mul(0.32), t.mul(-0.13))).div(4)).sub(0.5).mul(wb).add(0.5);
      const fine = vnoise2(p.add(vec2(t.mul(-0.18), t.mul(0.24)))).sub(0.5).mul(wf).add(0.5);
      // lake banks here are steep, so the wash band is scaled to ~2.5 m of depth
      const shore = float(1).sub(smoothstep(0.5, 2.5, depth));
      const phase = depth.mul(1.3).add(t.mul(1.22)).add(broad.sub(0.5).mul(2.3));
      const front = pow(clamp(sin(phase).mul(0.5).add(0.5), 0, 1), 10);
      const backwash = pow(clamp(sin(phase.sub(1.05)).mul(0.5).add(0.5), 0, 1), 3).mul(0.32);
      const lace = smoothstep(0.25, 0.69, broad.mul(0.58).add(fine.mul(0.42)));
      const wash = mix(float(0.13), front.add(backwash).mul(lace), wb);
      const contact = float(1).sub(smoothstep(0.03, 0.6, depth)).mul(fine.mul(0.45).add(0.3));
      return clamp(shore.mul(wash).mul(0.85).add(contact), 0, 1);
    };

    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: true });
    m.name = 'lake';
    const alphaOut = property('float', 'tkWaterAlpha');
    m.colorNode = Fn(() => {
      const P = positionWorld;
      // drifting cloud shadows dim the glint and the sunlit bed
      const sunB = sunBeam.mul(cloudShadow(P));
      const toCam = cameraPosition.sub(P);
      const dist = length(toCam);
      const V = toCam.div(dist);
      const wd = V.negate();
      const depthHere = float(WATER_LEVEL).sub(terrainH(P.xz));
      If(depthHere.lessThan(-0.05), () => {
        Discard();
      });

      // ---- wave normal: two FFT layers + a close-up chop layer; variance from the mips (LEAN)
      const warp = warpOf(P.xz);
      const Q = warp.lookup;
      const A = texture(surfTex, Q.div(L));
      const B = texture(surfTex, rot(Q, 0.8, 0.6).div(L * 0.41).add(0.37));
      const Cm = texture(surfTex, rot(Q, 0.28, -0.96).div(L * 0.13).add(0.71));
      const slope0 = warp.slope(A.yz.add(rotT(B.yz, 0.8, 0.6).mul(0.12)).add(rotT(Cm.yz, 0.28, -0.96).mul(exp(dist.mul(-0.05)).mul(0.13))));
      const variance = max(A.w.sub(dot(A.yz, A.yz)), 0).add(max(B.w.sub(dot(B.yz, B.yz)), 0).mul(0.0144));
      // shallow margins are calmer
      const rip = ripples.sample(P.xz);
      const slope = slope0.mul(smoothstep(0, 0.8, depthHere).mul(0.7).add(0.3)).add(rip.xy);
      const n0 = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
      const nv0 = dot(n0, V);
      const n = select(nv0.lessThan(0.02), normalize(n0.add(V.mul(float(0.02).sub(nv0)))), n0).toVar();
      const nv = dot(n, V);
      const F = fres(nv, IOR);

      // ---- reflection: sky, with the dark treeline of the far shore mirrored near the horizon
      const rr0 = reflect(wd, n);
      const rr = vec3(rr0.x, abs(rr0.y), rr0.z);
      const shoreK = float(1).sub(smoothstep(0.012, 0.1, rr.y));
      let refl: V3 = mix(skyCol(rr), cShore.mul(amb.mul(1.3).add(sunB.mul(0.08))), shoreK.mul(0.85));
      // On High the real far shore, trees and tanks are mirrored where the screen holds them
      // (screenReflection.ts); the painted treeline above stays as the fallback.
      if (detail === 'high') {
        const ssr = screenReflection(P, normalize(vec3(rr.x, max(rr.y, 0.004), rr.z)));
        refl = mix(refl, ssr.colour, ssr.weight);
      }

      // ---- sun glint: Beckmann, roughness widened by slope variance
      const a2 = variance.mul(1.1).add(0.00025);
      const h = normalize(V.add(sky.sun));
      const nh = max(dot(n, h), 0);
      const nl = max(dot(n, sky.sun), 0);
      const c2 = max(nh.mul(nh), 1e-4);
      const D = exp(float(1).sub(c2).div(c2).div(a2).negate()).div(a2.mul(Math.PI).mul(c2).mul(c2));
      const Vis = float(0.5).div(nl.mul(sqrt(nv.mul(nv).mul(float(1).sub(a2)).add(a2))).add(nv.mul(sqrt(nl.mul(nl).mul(float(1).sub(a2)).add(a2)))).add(1e-5));
      const spec = sunB.mul(min(D.mul(Vis).mul(fres(max(dot(h, V), 0), IOR)).mul(nl), 14));

      // ---- refraction: march the transmitted ray to the terrain under the lake
      const tr = refract(wd, n, 1 / IOR);
      const s = max(depthHere, 0.02).div(max(tr.y.negate(), 0.05)).toVar();
      for (let i = 0; i < 3; i++) {
        const fp0 = P.add(tr.mul(s));
        s.assign(max(terrainH(fp0.xz).sub(P.y).div(tr.y), 0));
      }
      const FP = P.add(tr.mul(s));
      const bedDepth = max(float(WATER_LEVEL).sub(FP.y), 0);
      // lake bed: wet mud with sandy, stony patches
      const nz = texture(noise.texture, FP.xz.div(9));
      const fineB = texture(noise.texture, FP.xz.div(1.7)).b;
      const alb = mix(cMud.mul(1.25), mix(cSand, cRock, 0.4).mul(0.55), smoothstep(0.45, 0.7, nz.g.add(fineB.sub(0.5).mul(0.3)))).mul(fineB.mul(0.5).add(0.75));

      const sunT = refract(sky.sun.negate(), vec3(0, 1, 0), 1 / IOR);
      const Ts = float(1).sub(fres(max(sky.sun.y, 0), IOR));
      let caus: F = float(1);
      if (caustics) {
        // light entering at S was bent by the local wave lens; convergence brightens the bed
        const S = FP.xz.sub(sunT.xz.mul(bedDepth).div(sunT.y.negate()));
        const e = 0.06;
        const div = slopeAt(S.add(vec2(e, 0))).x.sub(slopeAt(S.sub(vec2(e, 0))).x).add(slopeAt(S.add(vec2(0, e))).y).sub(slopeAt(S.sub(vec2(0, e))).y).div(2 * e);
        caus = pow(clamp(float(1).div(bedDepth.mul(div).mul(0.55).add(1)), 0.25, 6), 1.6);
      }
      const Esun = sunB.mul(Ts).mul(exp(sigT.mul(bedDepth).div(max(sunT.y.negate(), 0.1)).negate())).mul(max(sunT.y.negate(), 0)).mul(caus);
      const Esky = amb.mul(Math.PI).mul(exp(sigT.sub(sigS.mul(0.6)).mul(bedDepth).mul(1.2).negate()));
      const Lbed = alb.div(Math.PI).mul(Esun.add(Esky));
      const Tv = exp(sigT.mul(s).negate());
      const cosS = dot(sunT, tr.negate());
      const g = 0.75;
      const ph = float(1 - g * g).div(pow(float(1 + g * g).sub(cosS.mul(2 * g)), 1.5).mul(4 * Math.PI));
      const Lmid = sunB.mul(Ts).mul(exp(sigT.mul(bedDepth).mul(0.5).div(max(sunT.y.negate(), 0.1)).negate())).mul(ph.add(0.08)).add(amb.mul(0.8));
      const Lin = sigS.div(sigT).mul(Lmid).mul(vec3(1).sub(Tv)).mul(1.4);
      const under = Lbed.mul(Tv).add(Lin);

      const col = refl.mul(F).add(under.mul(float(1).sub(F))).add(spec);
      // shoreline foam, lit like a rough white diffuse layer
      const fp = max(length(fwidth(P.xz)), 1e-3);
      // churned white water where a shell went in or a hull is pushing through
      const foam = max(shoreFoam(P.xz, max(depthHere, 0), fp, G.uTime), smoothstep(0.35, 1, rip.z).mul(0.7));
      const foamCol = sunB.mul(max(sky.sun.y, 0)).add(amb.mul(Math.PI)).div(Math.PI).mul(0.75);
      // fade into the terrain mesh at the waterline
      alphaOut.assign(max(smoothstep(0, 0.25, depthHere), foam.mul(0.9)));
      return mix(mix(col, foamCol, foam), vec3(0.01), G.uThermal);
    })();
    m.opacityNode = alphaOut;
    this.material = m;

    for (const l of LAKES) {
      const geo = new THREE.CircleGeometry(l.r * 1.4, 96);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(l.x, WATER_LEVEL, l.z);
      mesh.renderOrder = 1;
      this.group.add(mesh);
    }
  }

  /** The FFT's offscreen targets (the per-pass GPU timer files them under "water"). */
  get targets(): THREE.RenderTarget[] {
    return this.ocean.targets;
  }

  /** Run the FFT once at load so its pipelines and targets exist before the first lake comes near. */
  warmup(renderer: THREE.WebGPURenderer): void {
    this.ocean.update(renderer, 0);
  }

  update(renderer: THREE.WebGPURenderer, time: number, camera: THREE.Vector3, dt: number): void {
    // no need to run the FFT when no lake is anywhere near the view
    let near = false;
    for (const l of LAKES) if (hyp2(camera.x - l.x, camera.z - l.z) < l.r + 900) near = true;
    if (near) {
      this.ocean.update(renderer, time);
      this.ripples.update(dt, camera.x, camera.z);
    }
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
