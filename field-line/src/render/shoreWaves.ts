import { abs, cameraPosition, clamp, cos, exp, float, floor, Fn, fract, If, length, log2, Loop, max, min, mix, positionWorld, pow, sign, sin, smoothstep, sqrt, tanh, texture, vec2, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { LAKE_WAVES } from '../config.ts';
import { type ShoreField, shoreSample } from './shoreField.ts';
import { W } from './waterUniforms.ts';
import { laceMap } from './waterPatterns.ts';

// Depth-aware waves on the lake, evaluated in the shaders from the baked field
// (shoreField.ts). Each wave m is an individual: its height comes from a set
// pattern, per-wave randomness and an along-shore variation, so waves never
// reach the shore as one straight line. In the shallows a wave grows by
// Green's law until its height reaches γ × depth, then breaks: the front
// steepens, a little whitewater forms and the height is capped by the depth.
// On the bank it becomes a thin swash sheet that runs up, slows and drains.
//
// Wave model after Tidewater's ShoreWaves (Dan Greenheck, MIT licence), via
// Castaway Lagoon's version (same maths, lake values, the field passed in).
//
// Phase: s = (t − T(x)) / P counts waves; the crest of wave m passes a point
// when s = m, so u = s − round(s) is −½…½ with 0 on the crest; shoreward
// points see each crest later, so u < 0 is the front of the wave.

const P = LAKE_WAVES.periodS;
const OMEGA = (2 * Math.PI) / P;
const G = 9.81;
/** Depth (m) at which W.amplitudeM is the wave's amplitude (Green's law reference). */
const REF_DEPTH_M = 1.2;
const LACE_TILE_M = 3.5;

const hash1 = (x: Node<'float'>): Node<'float'> => fract(sin(x.mul(127.1).add(311.7)).mul(43758.5453));
const wobble = (along: Node<'float'>): Node<'float'> => sin(along.mul(0.09)).mul(0.07).add(sin(along.mul(0.23).add(1.7)).mul(0.035));

function waveAmp(m: Node<'float'>, along: Node<'float'>): Node<'float'> {
  const waveSet = abs(sin(m.mul(Math.PI / 7))).mul(0.6).add(0.55);
  const rnd = hash1(m).sub(0.5).mul(2);
  const warp = sin(along.mul(0.03).add(m.mul(0.9))).mul(1.6);
  const a1 = sin(along.mul(0.12).add(m.mul(1.7)).add(warp));
  const a2 = sin(along.mul(0.26).add(m.mul(4.1)).add(1.3).sub(warp.mul(0.7)));
  const alongV = a1.mul(0.6).add(a2.mul(0.4));
  return max(W.amplitudeM.mul(waveSet).mul(float(1).add(rnd.mul(0.18)).add(alongV.mul(0.28))), 0.002);
}

function wavenumber(d: Node<'float'>): Node<'float'> {
  const k0 = (OMEGA * OMEGA) / G;
  return float(k0).div(sqrt(tanh(float(k0).mul(max(d, 0.03)))));
}

interface Phase {
  s: Node<'float'>;
  dir: Node<'vec2'>;
  exposure: Node<'float'>;
  along: Node<'float'>;
}

function phaseAt(field: ShoreField, xz: Node<'vec2'>): Phase {
  const sh = shoreSample(field, xz);
  const exposure = length(sh.yz);
  const dir = sh.yz.div(max(exposure, 1e-4));
  const along = xz.dot(vec2(dir.y.negate(), dir.x));
  return { s: W.time.sub(sh.x).div(P).add(wobble(along)), dir, exposure, along };
}

function shoreState(m: Node<'float'>, along: Node<'float'>, exposure: Node<'float'>, d: Node<'float'>): { amp: Node<'float'>; breaking: Node<'float'>; k: Node<'float'> } {
  const a0 = waveAmp(m, along).mul(exposure);
  const shoaled = a0.mul(min(pow(float(REF_DEPTH_M).div(max(d, 0.06)), 0.25), 2.2));
  const cap = max(d, 0).mul(LAKE_WAVES.breakerIndex * 0.5);
  return { amp: min(shoaled, cap), breaking: smoothstep(0.9, 1.25, shoaled.div(max(cap, 1e-3))), k: wavenumber(d) };
}

export interface ShoreSurface {
  disp: Node<'vec3'>;
  slope: Node<'vec2'>;
  crest: Node<'float'>;
  s: Node<'float'>;
  breaking: Node<'float'>;
  dir: Node<'vec2'>;
}

/** The water surface over depth d: elliptic orbits, crests bunched, fronts steepening as they break. */
export function shoreSurface(field: ShoreField, xz: Node<'vec2'>, depth: Node<'float'>): ShoreSurface {
  const ph = phaseAt(field, xz);
  const m = floor(ph.s.add(0.5));
  const u = ph.s.sub(m);
  const here = shoreState(m, ph.along, ph.exposure, depth);
  const next = shoreState(m.add(sign(u)), ph.along, ph.exposure, depth);
  const hand = smoothstep(0.32, 0.5, abs(u)).mul(0.5);
  const A = mix(here.amp, next.amp, hand);
  const b = mix(here.breaking, next.breaking, hand);
  const k = here.k;
  const lambda = float(2 * Math.PI).div(k);
  const beta = b.mul(1.2);
  const g = u.mul(2 * Math.PI).sub(beta.mul(pow(sin(u.mul(Math.PI)), 2)));
  const gPrime = float(2 * Math.PI).sub(beta.mul(Math.PI).mul(sin(u.mul(2 * Math.PI))));
  const horiz = min(A.div(max(tanh(k.mul(max(depth, 0.03))), 0.15)), float(0.9).div(k));
  const y = A.mul(cos(g));
  const x = horiz.mul(sin(g));
  const dYdXi = A.mul(sin(g)).mul(gPrime).div(lambda);
  const dXdXi = float(1).sub(horiz.mul(cos(g)).mul(gPrime).div(lambda));
  const slopeXi = dYdXi.div(max(dXdXi, 0.05));
  const env = smoothstep(0.0, 0.05, depth);
  return {
    disp: vec3(ph.dir.x.mul(x), y, ph.dir.y.mul(x)).mul(env),
    slope: ph.dir.mul(slopeXi).mul(env),
    crest: cos(g).mul(smoothstep(0.01, 0.05, A)),
    s: ph.s,
    breaking: b.mul(env),
    dir: ph.dir,
  };
}

/** Lace coverage for a foam amount 0..1 (dense mat → holes → strands); `level` inside branches (WGSL). */
export function laceCover(xz: Node<'vec2'>, amount: Node<'float'>, salt: Node<'float'>, level?: Node<'float'>): Node<'float'> {
  const t = texture(laceMap(), xz.div(LACE_TILE_M).add(vec2(hash1(salt).mul(0.73), hash1(salt.add(3.1)).mul(0.41))));
  const lace = level ? t.level(level) : t;
  const threshold = amount.mul(1.15).sub(lace.b.sub(0.5).mul(0.25));
  const cover = smoothstep(lace.r.sub(0.08), lace.r.add(0.08), threshold);
  // No foam means no strands: the mottling offset alone must never draw the net.
  return clamp(cover.add(lace.g.mul(smoothstep(0.1, 0.4, amount)).mul(0.5)), 0, 1).mul(smoothstep(0.03, 0.12, amount));
}

/** Whitewater on breaking crests and the foam they leave, fading over LAKE_WAVES.foamLifeS. */
export function surfFoam(xz: Node<'vec2'>, s: Node<'float'>, breaking: Node<'float'>, dir: Node<'vec2'>): Node<'float'> {
  const m = floor(s.add(0.5));
  const u = s.sub(m);
  const age = fract(s).mul(P);
  const roller = smoothstep(0.16, 0.0, abs(u.add(0.04))).mul(breaking);
  const trail = breaking.mul(exp(age.div(-LAKE_WAVES.foamLifeS)));
  return laceCover(xz.sub(dir.mul(age.mul(0.25))), max(roller, trail.mul(0.6)), floor(s));
}

export interface Swash {
  sheet: Node<'float'>;
  wet: Node<'float'>;
  foam: Node<'float'>;
}

function runupAt(a0: Node<'float'>, tau: Node<'float'>): Node<'float'> {
  const rMax = a0.mul(LAKE_WAVES.runupK);
  const su = clamp(tau.div(LAKE_WAVES.swashUp), 0, 1);
  const sb = clamp(tau.sub(LAKE_WAVES.swashUp).div(LAKE_WAVES.swashDown), 0, 1);
  const up = float(1).sub(pow(float(1).sub(su), 1.5));
  const down = float(1).sub(pow(sb, 1.6));
  return tau.lessThan(LAKE_WAVES.swashUp).select(up, down).mul(rMax).sub(0.005);
}

/**
 * Swash on the bank at a ground point `y` metres above the still water, and
 * the wet ground it leaves: wetness is the max over the last six waves of how
 * long ago each one's backwash uncovered this height, decayed over the drying
 * time. A TSL Fn (If/Loop inside); returns vec4(sheet, wet, foam, 0).
 */
function swashFn(field: ShoreField) {
  return Fn(([xz, y, lod]: [Node<'vec2'>, Node<'float'>, Node<'float'>]) => {
    const sheet = float(0).toVar('swashSheet');
    const wet = float(0).toVar('swashWet');
    const foam = float(0).toVar('swashFoam');
    If(y.lessThan(W.amplitudeM.mul(2.2 * LAKE_WAVES.runupK * 1.6).add(0.02)).and(y.greaterThan(-0.3)), () => {
      const sh = shoreSample(field, xz);
      const exposure = length(sh.yz);
      const dir = sh.yz.div(max(exposure, 1e-4));
      const along = xz.dot(vec2(dir.y.negate(), dir.x));
      const ss = W.time.sub(sh.w).div(P).add(wobble(along));
      const ms = floor(ss);
      const tau = ss.sub(ms);
      const arrive = (m: Node<'float'>): Node<'float'> => waveAmp(m, along).mul(exposure).mul(Math.pow(REF_DEPTH_M / 0.15, 0.25));
      const lobes = (m: Node<'float'>): Node<'float'> => sin(along.mul(0.9).add(m.mul(2.3))).mul(0.5).add(sin(along.mul(2.6).add(m.mul(5.1))).mul(0.3)).add(sin(along.mul(6.1).add(m.mul(1.7))).mul(0.2));
      const aboveWater = smoothstep(-0.02, 0.02, y);
      const a0 = arrive(ms);
      const film = runupAt(a0, tau).add(lobes(ms).mul(a0.mul(0.25))).sub(y);
      sheet.assign(max(film, 0).mul(0.35).mul(aboveWater));
      const up = tau.lessThan(LAKE_WAVES.swashUp);
      const edge = smoothstep(0.0, 0.004, film).mul(float(1).sub(smoothstep(0.006, 0.02, film)));
      foam.assign(laceCover(xz.add(dir.mul(tau.mul(0.4))), edge.mul(up.select(float(0.55), float(0.2))), ms, lod).mul(aboveWater));
      const w = float(0).toVar('wetMax');
      const noiseK = texture(laceMap(), xz.div(9.0)).level(lod.sub(1.4).max(0)).b.mul(0.7).add(0.65);
      Loop(6, ({ i }) => {
        const j = float(i);
        const mj = ms.sub(j);
        const rMax = arrive(mj).mul(LAKE_WAVES.runupK).add(lobes(mj).mul(arrive(mj).mul(0.25)));
        const sbAt = pow(clamp(float(1).sub(y.add(0.005).div(max(rMax, 1e-3))), 0, 1), 1 / 1.6);
        const uncovered = float(LAKE_WAVES.swashUp).add(sbAt.mul(LAKE_WAVES.swashDown));
        const since = tau.sub(uncovered).add(j).mul(P);
        const wj = exp(max(since, 0).negate().div(float(LAKE_WAVES.dryTimeS).mul(noiseK)));
        w.assign(max(w, rMax.sub(y).greaterThan(0).select(wj, float(0))));
      });
      wet.assign(max(w, film.greaterThan(0).select(float(1), float(0))));
    });
    return vec4(sheet, max(wet, smoothstep(0.02, -0.03, y)), foam, 0);
  });
}

/** The swash and wet ground at world xz, `y` metres above the still water. */
export function swash(field: ShoreField, xz: Node<'vec2'>, y: Node<'float'>): Swash {
  const dist = positionWorld.sub(cameraPosition).length();
  const lod = log2(dist.mul(0.0028).max(1e-3).mul(512 / LACE_TILE_M)).clamp(0, 9);
  const v = swashFn(field)(xz, y, lod).toVar('swash');
  return { sheet: v.x, wet: v.y, foam: v.z };
}
