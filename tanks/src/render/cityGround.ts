import { abs, clamp, float, floor, fract, max, min, mix, mod, pow, select, smoothstep, sqrt, texture, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { CITY } from '../config';
import { PITCH_X, PITCH_Z, RING_REACH_M } from '../world/cityPlan';
import { kelvinToLinear } from './lighting';
import { hash12, vnoise2 } from './nodes';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** The town's blocks for the shader (cityPlan.blockTexels: R streets round it, G paved square). */
export function makeBlockTexture(texels: Uint8Array): THREE.DataTexture {
  const t = new THREE.DataTexture(texels, CITY.blocksX, CITY.blocksZ, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export interface Paving {
  /** 0 … 1: how much of this ground is paved (carriageway, pavement or square). */
  mask: F;
  colour: V3;
  rough: F;
  /** Tilt of the shading normal in the ground plane (kerb faces, joints). */
  tilt: V2;
  /** Extra heat for the thermal sight (sun-warmed asphalt). */
  heat: F;
  /** Illuminance from the street lamps (lx per cd of lamp intensity: multiply by the lamps' cd). */
  lampLux: F;
}

const lampTint = kelvinToLinear(CITY.lampColourK);
/** The street lamps' colour (linear RGB, luminance 1). */
export const LAMP_COLOUR = vec3(lampTint.r, lampTint.g, lampTint.b);

/**
 * Paving of the town, analytic from the grid (so kerbs, lines and crossings stay sharp at any
 * distance the heightfield's 2 m texels could not): asphalt carriageways with worn wheel tracks,
 * centre lines (dashed on streets, double on avenues), zebra crossings before every junction,
 * pavements of 50 cm concrete slabs with a granite kerb whose face catches the light, and granite
 * setts on the square. Blocks without streets (the lake shore) come from the block texture. Same
 * rules as cityPlan.surfaceAt and cityPlan.placeLamps.
 */
export function cityPaving(wp: V2, footprintM: F, blocks: THREE.DataTexture, fine: F, mid: F, rain: F): Paving {
  const X0 = CITY.x0M;
  const Z0 = CITY.z0M;
  const NX = CITY.blocksX;
  const NZ = CITY.blocksZ;
  const qx = wp.x.sub(X0).div(PITCH_X);
  const qz = wp.y.sub(Z0).div(PITCH_Z);
  const kx = clamp(floor(qx.add(0.5)), 0, NX);
  const kz = clamp(floor(qz.add(0.5)), 0, NZ);
  const ix = clamp(floor(qx), 0, NX - 1);
  const jz = clamp(floor(qz), 0, NZ - 1);
  const block = (i: F, j: F) => texture(blocks, vec2(clamp(i, 0, NX - 1).add(0.5).div(NX), clamp(j, 0, NZ - 1).add(0.5).div(NZ))).level(float(0));
  const inside = wp.x
    .greaterThan(X0 - RING_REACH_M)
    .and(wp.x.lessThan(CITY.x1M + RING_REACH_M))
    .and(wp.y.greaterThan(Z0 - RING_REACH_M))
    .and(wp.y.lessThan(CITY.z1M + RING_REACH_M));
  const inRect = wp.x.greaterThan(X0).and(wp.x.lessThan(CITY.x1M)).and(wp.y.greaterThan(Z0)).and(wp.y.lessThan(CITY.z1M));
  const lineXk = kx.mul(PITCH_X).add(X0);
  const lineZk = kz.mul(PITCH_Z).add(Z0);
  const sx = wp.x.sub(lineXk);
  const sz = wp.y.sub(lineZk);
  const dx = abs(sx);
  const dz = abs(sz);
  const avX = mod(kx, CITY.avenueEveryX).lessThan(0.5);
  const avZ = mod(kz, CITY.avenueEveryZ).lessThan(0.5);
  const hX = select(avX, float(CITY.avenueHalfM), float(CITY.streetHalfM));
  const wX = select(avX, float(CITY.avenueWalkM), float(CITY.streetWalkM));
  const hZ = select(avZ, float(CITY.avenueHalfM), float(CITY.streetHalfM));
  const wZ = select(avZ, float(CITY.avenueWalkM), float(CITY.streetWalkM));
  const actX = max(block(kx.sub(1), jz).r, block(kx, jz).r);
  const actZ = max(block(ix, kz.sub(1)).r, block(ix, kz).r);
  const e = max(footprintM, 0.01);
  const edge = (half: F, d: F) => float(1).sub(smoothstep(half.sub(e), half.add(e), d));
  const carX = edge(hX, dx).mul(actX);
  const carZ = edge(hZ, dz).mul(actZ);
  const walkX = edge(hX.add(wX), dx).mul(actX);
  const walkZ = edge(hZ.add(wZ), dz).mul(actZ);
  const asphalt = max(carX, carZ);
  const walk = max(walkX, walkZ).mul(float(1).sub(asphalt));
  const square = block(ix, jz).g.mul(select(inRect, float(1), float(0))).mul(float(1).sub(asphalt).sub(walk).max(0));
  const inF = select(inside, float(1), float(0));
  const mask = clamp(asphalt.add(walk).add(square), 0, 1).mul(inF);

  // --- carriageway: aggregate, patched repairs, polished wheel tracks
  const patch = smoothstep(0.66, 0.7, mid);
  const along = (half: F, d: F) => abs(abs(d).sub(half.mul(0.5))).lessThan(0.45);
  const tracks = select(along(hX, dx).and(carX.greaterThan(0.5)).or(along(hZ, dz).and(carZ.greaterThan(0.5))), float(1), float(0));
  // Weathered asphalt (sheet: fresh 0.04, aged grey 0.08–0.12) with wear at two scales the street's own
  // noise does not have: oil-dark and sun-bleached stretches ~25 m long and scuffs ~3 m across. A uniform
  // near-black carriageway read as a flat strip from the commander's hatch (screenshot tour).
  const wear = vnoise2(wp.div(25)).mul(0.6).add(vnoise2(wp.div(3).add(7.3)).mul(0.4));
  const asphaltCol = vec3(0.06, 0.06, 0.062)
    .mul(fine.mul(0.3).add(0.85))
    .mul(wear.mul(0.32).add(0.84))
    .mul(mix(float(1), float(0.72), patch))
    .mul(mix(float(1), float(1.15), tracks));
  // markings: not inside a junction; the zebra sits on each approach just outside it
  const junctionX = dz.lessThan(hZ.add(wZ)).and(actZ.greaterThan(0.5));
  const junctionZ = dx.lessThan(hX.add(wX)).and(actX.greaterThan(0.5));
  const dash = (s: F) => fract(s.div(9)).lessThan(0.36);
  const centreX = select(avX, abs(dx.sub(0.16)).lessThan(0.06), dx.lessThan(0.06).and(dash(wp.y)));
  const centreZ = select(avZ, abs(dz.sub(0.16)).lessThan(0.06), dz.lessThan(0.06).and(dash(wp.x)));
  const zebraBandX = abs(dz.sub(hZ.add(wZ).add(2.6))).lessThan(2).and(actZ.greaterThan(0.5)).and(dx.lessThan(hX.sub(0.4)));
  const zebraBandZ = abs(dx.sub(hX.add(wX).add(2.6))).lessThan(2).and(actX.greaterThan(0.5)).and(dz.lessThan(hZ.sub(0.4)));
  const zebraX = zebraBandX.and(fract(sx.div(1.0)).lessThan(0.5));
  const zebraZ = zebraBandZ.and(fract(sz.div(1.0)).lessThan(0.5));
  const lineX = centreX.and(junctionX.not()).and(carX.greaterThan(0.5)).or(zebraX.and(carX.greaterThan(0.5)));
  const lineZ = centreZ.and(junctionZ.not()).and(carZ.greaterThan(0.5)).or(zebraZ.and(carZ.greaterThan(0.5)));
  // worn paint: thin where the wheels run, gone in patches; faded out before it aliases
  const paint = select(lineX.or(lineZ), float(1), float(0)).mul(smoothstep(0.2, 0.5, fine.add(0.25))).mul(float(1).sub(smoothstep(0.03, 0.09, footprintM)));
  const carCol = mix(asphaltCol, vec3(0.6, 0.6, 0.56), paint.mul(0.9));
  const carRough = mix(mix(float(0.9), float(0.78), tracks).sub(wear.sub(0.5).mul(0.16)), float(0.6), paint);

  // --- pavement: 50 cm slabs, a 30 cm granite kerb at the carriageway
  const slab = wp.div(0.5);
  const fs = fract(slab);
  const joint = min(min(fs.x, float(1).sub(fs.x)), min(fs.y, float(1).sub(fs.y))).lessThan(0.03);
  const slabCol = vec3(0.24, 0.235, 0.225).mul(hash12(floor(slab)).mul(0.2).add(0.9)).mul(fine.mul(0.15).add(0.92));
  const kerbX = dx.greaterThan(hX).and(dx.lessThan(hX.add(0.3))).and(actX.greaterThan(0.5)).and(junctionX.not());
  const kerbZ = dz.greaterThan(hZ).and(dz.lessThan(hZ.add(0.3))).and(actZ.greaterThan(0.5)).and(junctionZ.not());
  const kerb = kerbX.or(kerbZ);
  const jointAA = float(1).sub(smoothstep(0.015, 0.05, footprintM));
  const walkCol = select(kerb, vec3(0.3, 0.3, 0.29).mul(fine.mul(0.2).add(0.9)), mix(slabCol, slabCol.mul(0.55), select(joint, jointAA, float(0))));
  // the kerb's 12 cm face, toward the carriageway
  const faceX = dx.greaterThan(hX.sub(0.02)).and(dx.lessThan(hX.add(0.1))).and(actX.greaterThan(0.5));
  const faceZ = dz.greaterThan(hZ.sub(0.02)).and(dz.lessThan(hZ.add(0.1))).and(actZ.greaterThan(0.5));
  const signX = select(sx.greaterThan(0), float(-1), float(1));
  const signZ = select(sz.greaterThan(0), float(-1), float(1));
  const kerbTilt = vec2(select(faceX, signX.mul(0.8), float(0)), select(faceZ, signZ.mul(0.8), float(0))).mul(float(1).sub(smoothstep(0.03, 0.1, footprintM)));

  // --- the square: granite setts in rows
  const sett = vec2(wp.x.div(0.12).add(mod(floor(wp.y.div(0.1)), 2).mul(0.5)), wp.y.div(0.1));
  const ff = fract(sett);
  const settJoint = min(min(ff.x, float(1).sub(ff.x)), min(ff.y, float(1).sub(ff.y))).lessThan(0.08);
  const settCol = vec3(0.17, 0.165, 0.16).mul(hash12(floor(sett)).mul(0.35).add(0.8));
  const sqCol = mix(settCol, settCol.mul(0.5), select(settJoint, float(1).sub(smoothstep(0.005, 0.02, footprintM)), float(0)));

  const wSum = max(asphalt.add(walk).add(square), 1e-4);
  const dryCol = carCol.mul(asphalt).add(walkCol.mul(walk)).add(sqCol.mul(square)).div(wSum);
  const dryRough = carRough.mul(asphalt).add(float(0.85).mul(walk)).add(float(0.8).mul(square)).div(wSum);
  // Rain: paving darkens and turns glossy, water films the asphalt
  const colour = dryCol.mul(mix(float(1), float(0.7), rain));
  const rough = mix(dryRough, max(dryRough.mul(0.3), 0.08), rain);
  const heat = asphalt.mul(0.05).add(walk.mul(0.02));

  // --- street lamps' light: the lamps nearest along each of the two nearest streets, both kerbs
  const H = CITY.lampHeightM;
  const S = CITY.lampSpacingM;
  const lampAt = (dxL: F, dzL: F): F => {
    const d2 = dxL.mul(dxL).add(dzL.mul(dzL)).add(H * H);
    const cosT = float(H).div(sqrt(d2));
    // I(θ) = I0·cos^0.6 θ (a wide street optic), E = I(θ)·cos θ / d²
    return pow(cosT, 1.6).div(d2);
  };
  const skipped = (s: F, origin: number, pitch: number, n: number, avEvery: number): F => {
    const k = clamp(floor(s.sub(origin).div(pitch).add(0.5)), 0, n);
    const av = mod(k, avEvery).lessThan(0.5);
    const reach = select(av, float(CITY.avenueHalfM + CITY.avenueWalkM), float(CITY.streetHalfM + CITY.streetWalkM)).add(3);
    return select(abs(s.sub(k.mul(pitch).add(origin))).lessThan(reach), float(0), float(1));
  };
  // lamps on the x-line (street along z)
  const mz = floor(wp.y.sub(Z0).div(S));
  const z1 = mz.add(0.5).mul(S).add(Z0);
  const z2 = z1.add(select(wp.y.greaterThan(z1), float(S), float(-S)));
  const offX = hX.add(0.6);
  let lux: F = float(0);
  for (const zc of [z1, z2]) {
    const on = skipped(zc, Z0, PITCH_Z, NZ, CITY.avenueEveryZ).mul(actX);
    lux = lux.add(lampAt(sx.sub(offX), wp.y.sub(zc)).add(lampAt(sx.add(offX), wp.y.sub(zc))).mul(on));
  }
  const mx = floor(wp.x.sub(X0).div(S));
  const x1 = mx.add(0.5).mul(S).add(X0);
  const x2 = x1.add(select(wp.x.greaterThan(x1), float(S), float(-S)));
  const offZ = hZ.add(0.6);
  for (const xc of [x1, x2]) {
    const on = skipped(xc, X0, PITCH_X, NX, CITY.avenueEveryX).mul(actZ);
    lux = lux.add(lampAt(sz.sub(offZ), wp.x.sub(xc)).add(lampAt(sz.add(offZ), wp.x.sub(xc))).mul(on));
  }
  const lampLux = lux.mul(inF);
  return { mask, colour, rough, tilt: kerbTilt, heat, lampLux };
}

