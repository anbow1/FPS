import { abs, cameraPosition, clamp, cos, exp, float, floor, Fn, fract, If, length, log2, Loop, max, min, mix, normalize, positionWorld, pow, sign, sin, smoothstep, sqrt, tanh, texture, vec2, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { SHORE } from '../config.ts';
import { shoreSample } from './shoreField.ts';
import { laceMap } from './textures.ts';
import { U } from './uniforms.ts';

// Depth-aware shoreline waves, evaluated in the shaders from the baked field
// (shoreField.ts). Each wave m is an individual: its height comes from a set
// pattern (groups of ~7 with bigger ones in the middle), per-wave randomness
// and an along-shore variation, so waves peel along the beach instead of
// closing out in one line. In the shallows it grows by Green's law until its
// height reaches γ × depth, then breaks: the crest leans forward, whitewater
// forms, and the height is capped by the depth. At the beach it becomes a
// thin swash sheet that runs up the sand, slows, and drains back.
//
// Wave model after Tidewater's ShoreWaves (Dan Greenheck, MIT licence,
// github.com/dgreenheck/tidewater), rebuilt for a sheltered lagoon on phones:
// analytic Green's-law shoaling and elliptic orbits instead of a plunging
// lip, and an analytic wet-sand history instead of a GPU simulation.
//
// Phase: s = (t − T(x)) / P counts waves; the crest of wave m passes a point
// when s = m, so u = s − round(s) is −½…½ with 0 on the crest. Shoreward
// points see each crest later (larger T), so u < 0 is the front of the wave
// (still to come) and u > 0 its back (already passed).

const P = SHORE.periodS;
const OMEGA = (2 * Math.PI) / P;
const G = 9.81;
/** Depth (m) at which SHORE.amplitudeM is the wave's amplitude (Green's law reference). */
const REF_DEPTH_M = 6;
const LACE_TILE_M = 3.5;

const hash1 = (x: Node<'float'>): Node<'float'> => fract(sin(x.mul(127.1).add(311.7)).mul(43758.5453));

/** Slow along-shore phase wobble: fronts are never perfectly straight or in step. */
const wobble = (along: Node<'float'>): Node<'float'> => sin(along.mul(0.043)).mul(0.07).add(sin(along.mul(0.11).add(1.7)).mul(0.035));

/** Offshore amplitude (m) of wave m at along-shore position `along`, before exposure and shoaling. */
function waveAmp(m: Node<'float'>, along: Node<'float'>): Node<'float'> {
  const waveSet = abs(sin(m.mul(Math.PI / 7))).mul(0.6).add(0.55);
  const rnd = hash1(m).sub(0.5).mul(2);
  const warp = sin(along.mul(0.016).add(m.mul(0.9))).mul(1.6);
  const a1 = sin(along.mul(0.062).add(m.mul(1.7)).add(warp));
  const a2 = sin(along.mul(0.13).add(m.mul(4.1)).add(1.3).sub(warp.mul(0.7)));
  const alongV = a1.mul(0.6).add(a2.mul(0.4));
  return max(U.waveScale.mul(SHORE.amplitudeM).mul(waveSet).mul(float(1).add(rnd.mul(0.18)).add(alongV.mul(0.28))), 0.004);
}

/** Wavenumber at depth d (Eckart's approximation to the dispersion relation). */
function wavenumber(d: Node<'float'>): Node<'float'> {
  const k0 = (OMEGA * OMEGA) / G;
  return float(k0).div(sqrt(tanh(float(k0).mul(max(d, 0.05)))));
}

export interface ShorePhase {
  s: Node<'float'>;
  dir: Node<'vec2'>;
  exposure: Node<'float'>;
  along: Node<'float'>;
  /** Shoreline arrival time (s), carried onto the sand. */
  tShore: Node<'float'>;
}

export function shorePhase(xz: Node<'vec2'>): ShorePhase {
  const sh = shoreSample(xz);
  const exposure = length(sh.yz);
  const dir = sh.yz.div(max(exposure, 1e-4));
  const along = xz.dot(vec2(dir.y.negate(), dir.x));
  const s = U.time.sub(sh.x).div(P).add(wobble(along));
  return { s, dir, exposure, along, tShore: sh.w };
}

export interface ShoreState {
  /** Amplitude after shoaling and the depth cap (m). */
  amp: Node<'float'>;
  /** 0 → 1 as the wave passes its breaking point. */
  breaking: Node<'float'>;
  k: Node<'float'>;
}

/** Wave m's amplitude at depth d, shoaled (Green's law, A ∝ d^−¼) and capped at H = γ d. */
export function shoreState(m: Node<'float'>, along: Node<'float'>, exposure: Node<'float'>, d: Node<'float'>): ShoreState {
  const a0 = waveAmp(m, along).mul(clamp(exposure.mul(1.25), 0, 1));
  const shoaled = a0.mul(min(pow(float(REF_DEPTH_M).div(max(d, 0.15)), 0.25), 2.4));
  const cap = max(d, 0).mul(SHORE.breakerIndex * 0.5);
  const ratio = shoaled.div(max(cap, 1e-3));
  return { amp: min(shoaled, cap), breaking: smoothstep(0.9, 1.25, ratio), k: wavenumber(d) };
}

export interface ShoreSurface {
  /** World displacement of the water vertex (m). */
  disp: Node<'vec3'>;
  /** Surface slope dY/dX, dY/dZ, to add to the chop's. */
  slope: Node<'vec2'>;
  /** Crest height as a fraction of the amplitude (−1 trough … 1 crest). */
  crest: Node<'float'>;
  s: Node<'float'>;
  breaking: Node<'float'>;
  dir: Node<'vec2'>;
}

/**
 * The water surface: elliptic orbits (horizontal radius A / tanh(kd), flatter
 * and longer in the shallows), with the phase warped near breaking so the
 * front face steepens and the crest pitches forward.
 */
export function shoreSurface(xz: Node<'vec2'>, depth: Node<'float'>): ShoreSurface {
  const ph = shorePhase(xz);
  const m = floor(ph.s.add(0.5));
  const u = ph.s.sub(m);
  // Hand the height over between consecutive waves in the trough, so there is no step.
  const here = shoreState(m, ph.along, ph.exposure, depth);
  const next = shoreState(m.add(sign(u)), ph.along, ph.exposure, depth);
  const hand = smoothstep(0.32, 0.5, abs(u)).mul(0.5);
  const A = mix(here.amp, next.amp, hand);
  const b = mix(here.breaking, next.breaking, hand);
  const k = here.k;
  const lambda = float(2 * Math.PI).div(k);
  // Forward lean: g(u) = 2πu − β sin²(πu) runs faster on the front (u < 0), so the front
  // face steepens as the wave breaks. g' = 2π − βπ sin 2πu stays positive for β < 2.
  const beta = b.mul(1.2);
  const g = u.mul(2 * Math.PI).sub(beta.mul(pow(sin(u.mul(Math.PI)), 2)));
  const gPrime = float(2 * Math.PI).sub(beta.mul(Math.PI).mul(sin(u.mul(2 * Math.PI))));
  const horiz = min(A.div(max(tanh(k.mul(max(depth, 0.05))), 0.15)), float(0.9).div(k));
  const y = A.mul(cos(g));
  // Water behind the crest moves forward and water ahead of it back: the crest bunches up.
  const x = horiz.mul(sin(g));
  // Derivatives along the travel direction ξ: du/dξ = −1/λ.
  const dYdXi = A.mul(sin(g)).mul(gPrime).div(lambda);
  const dXdXi = float(1).sub(horiz.mul(cos(g)).mul(gPrime).div(lambda));
  const slopeXi = dYdXi.div(max(dXdXi, 0.05));
  // Fade in over the first metres of water; the sheet on the sand is drawn by the ground.
  const env = smoothstep(0.0, 0.08, depth);
  return {
    disp: vec3(ph.dir.x.mul(x), y, ph.dir.y.mul(x)).mul(env),
    slope: ph.dir.mul(slopeXi).mul(env),
    crest: cos(g).mul(smoothstep(0.02, 0.12, A)),
    s: ph.s,
    breaking: b.mul(env),
    dir: ph.dir,
  };
}

/** Lace coverage for a foam amount 0..1 at world position xz (dense mat → holes → strands). */
export function laceCover(xz: Node<'vec2'>, amount: Node<'float'>, salt: Node<'float'>, level?: Node<'float'>): Node<'float'> {
  const t = texture(laceMap(), xz.div(LACE_TILE_M).add(vec2(hash1(salt).mul(0.73), hash1(salt.add(3.1)).mul(0.41))));
  // Inside a branch WGSL forbids implicit-LOD sampling: callers there pass the mip level.
  const lace = level ? t.level(level) : t;
  const threshold = amount.mul(1.15).sub(lace.b.sub(0.5).mul(0.25));
  const cover = smoothstep(lace.r.sub(0.08), lace.r.add(0.08), threshold);
  // No foam means no strands: the mottling offset alone must never draw the net.
  return clamp(cover.add(lace.g.mul(smoothstep(0.1, 0.4, amount)).mul(0.5)), 0, 1).mul(smoothstep(0.03, 0.12, amount));
}

/**
 * Surf foam on the water: whitewater riding the crest of a breaking wave, and
 * the foam it leaves behind, fading over SHORE.foamLifeS and tearing into lace.
 * `s` is the continuous wave count (interpolated from the vertices).
 */
export function surfFoam(xz: Node<'vec2'>, s: Node<'float'>, breaking: Node<'float'>, dir: Node<'vec2'>): Node<'float'> {
  const m = floor(s.add(0.5));
  const u = s.sub(m);
  // Time since the crest of the latest wave passed this point.
  const age = fract(s).mul(P);
  const lastWave = floor(s);
  // The roller rides the crest and its front face (u slightly < 0).
  const roller = smoothstep(0.16, 0.0, abs(u.add(0.04))).mul(breaking);
  const trail = breaking.mul(exp(age.div(-SHORE.foamLifeS)));
  const amount = max(roller, trail.mul(0.6));
  // The foam drifts shoreward with the bore, and every wave leaves its own pattern.
  const drift = xz.sub(dir.mul(age.mul(0.35)));
  return laceCover(drift, amount, lastWave);
}

export interface Swash {
  /** Thickness of the swash sheet over the sand (m, 0 where dry). */
  sheet: Node<'float'>;
  /** Sand wetness from the recent waves' run-up, drying over SHORE.dryTimeS. */
  wet: Node<'float'>;
  /** Foam at the leading edge and streaks draining back (0..1). */
  foam: Node<'float'>;
  /** 1 while the sheet runs up, 0 while it drains. */
  uprush: Node<'float'>;
}

/** Vertical run-up (m above sea level) of the swash of a wave with offshore amplitude a0, τ = 0…1 of the period after it reached the shore. */
function runupAt(a0: Node<'float'>, tau: Node<'float'>): Node<'float'> {
  const rMax = a0.mul(SHORE.runupK);
  const su = clamp(tau.div(SHORE.swashUp), 0, 1);
  const sb = clamp(tau.sub(SHORE.swashUp).div(SHORE.swashDown), 0, 1);
  const up = float(1).sub(pow(float(1).sub(su), 1.5));
  const down = float(1).sub(pow(sb, 1.6));
  return tau.lessThan(SHORE.swashUp).select(up, down).mul(rMax).sub(0.02);
}

/**
 * The swash on the beach at a ground point `y` metres above sea level, and the
 * wet sand it leaves: wetness is the max over the last few waves of how long
 * ago each one's backwash uncovered this height, decayed over the drying time,
 * so the wet line follows the set's biggest run-ups and dries unevenly.
 * Built as a TSL Fn: the If/Loop/toVar inside need a function body. Returns
 * vec4(sheet, wet, foam, uprush); `lod` is the lace texture's mip level (no
 * implicit-LOD sampling inside the branch).
 */
const swashFn = Fn(([xzIn, yIn, lodIn]: [Node<'vec2'>, Node<'float'>, Node<'float'>]) => {
  const xz = xzIn;
  const y = yIn;
  const lod = lodIn;
  const sheet = float(0).toVar('swashSheet');
  const wet = float(0).toVar('swashWet');
  const foam = float(0).toVar('swashFoam');
  const uprush = float(0).toVar('swashUp');
  // Only the beach face, just above and below the waterline, can be reached.
  If(y.lessThan(U.waveScale.mul(SHORE.amplitudeM * 2.4 * SHORE.runupK * 1.6)).and(y.greaterThan(-0.4)), () => {
    const sh = shoreSample(xz);
    const exposure = length(sh.yz);
    const dir = sh.yz.div(max(exposure, 1e-4));
    const along = xz.dot(vec2(dir.y.negate(), dir.x));
    const ss = U.time.sub(sh.w).div(P).add(wobble(along));
    const ms = floor(ss);
    const tau = ss.sub(ms);
    // Amplitude as the wave arrives at the beach: shoaled to about 0.5 m depth.
    const arrive = (m: Node<'float'>): Node<'float'> => waveAmp(m, along).mul(clamp(exposure.mul(1.25), 0, 1)).mul(Math.pow(REF_DEPTH_M / 0.5, 0.25));
    // The front is lobed along the beach, differently for every wave.
    const lobes = (m: Node<'float'>): Node<'float'> => sin(along.mul(0.61).add(m.mul(2.3))).mul(0.5).add(sin(along.mul(1.73).add(m.mul(5.1))).mul(0.3)).add(sin(along.mul(4.3).add(m.mul(1.7))).mul(0.2));
    const a0 = arrive(ms);
    const rt = runupAt(a0, tau).add(lobes(ms).mul(a0.mul(0.25)));
    // The sheet and its foam live on the sand above the still waterline; below it the
    // water surface itself draws the waves.
    const aboveSea = smoothstep(-0.03, 0.03, y);
    const film = rt.sub(y);
    sheet.assign(max(film, 0).mul(0.35).mul(aboveSea));
    const up = tau.lessThan(SHORE.swashUp);
    uprush.assign(up.select(float(1), float(0)));
    // Leading-edge foam while running up; streaks along the flow while draining.
    const edge = smoothstep(0.0, 0.015, film).mul(float(1).sub(smoothstep(0.02, 0.07, film)));
    const edgeFoam = laceCover(xz.add(dir.mul(tau.mul(0.8))), edge.mul(up.select(float(0.95), float(0.35))), ms, lod);
    const streakUv = vec2(xz.dot(dir).mul(0.25), along.mul(1.6));
    const streaks = laceCover(streakUv, smoothstep(0.0, 0.05, film).mul(up.select(float(0), float(0.45))).mul(sb(tau)), ms.add(17), lod);
    foam.assign(max(edgeFoam, streaks).mul(aboveSea));

    // Wet sand: the most recent of the last six waves to have covered this height.
    const w = float(0).toVar('wetMax');
    const noiseK = texture(laceMap(), xz.div(9.0)).level(lod.sub(1.4).max(0)).b.mul(0.7).add(0.65);
    Loop(6, ({ i }) => {
      const j = float(i);
      const mj = ms.sub(j);
      const rMax = arrive(mj).mul(SHORE.runupK).add(lobes(mj).mul(arrive(mj).mul(0.25)));
      const reach = rMax.sub(y);
      // When the backwash uncovered y: invert down = 1 − sb^1.6 on the backwash branch.
      const sbAt = pow(clamp(float(1).sub(y.add(0.02).div(max(rMax, 1e-3))), 0, 1), 1 / 1.6);
      const uncovered = float(SHORE.swashUp).add(sbAt.mul(SHORE.swashDown));
      const since = tau.sub(uncovered).add(j).mul(P);
      const wj = exp(max(since, 0).negate().div(float(SHORE.dryTimeS).mul(noiseK)));
      w.assign(max(w, reach.greaterThan(0).select(wj, float(0))));
    });
    wet.assign(max(w, film.greaterThan(0).select(float(1), float(0))));
  });
  // Below the waterline the sand is always wet.
  return vec4(sheet, max(wet, smoothstep(0.03, -0.05, y)), foam, uprush);
});

/**
 * The swash on the beach at a ground point `y` metres above sea level, and the
 * wet sand it leaves (see swashFn).
 */
export function swash(xz: Node<'vec2'>, y: Node<'float'>): Swash {
  // Mip level of the 3.5 m lace tile (512 px) from the viewing distance: ~1 texel per pixel.
  const dist = positionWorld.sub(cameraPosition).length();
  const lod = log2(dist.mul(0.0028).max(1e-3).mul(512 / LACE_TILE_M)).clamp(0, 9);
  const v = swashFn(xz, y, lod).toVar('swash');
  return { sheet: v.x, wet: v.y, foam: v.z, uprush: v.w };
}

/** Backwash progress 0..1 for τ (0 while running up). */
function sb(tau: Node<'float'>): Node<'float'> {
  return clamp(tau.sub(SHORE.swashUp).div(SHORE.swashDown), 0, 1);
}

/** Surface normal of the swash sheet's water (flat, gently tilted down the beach). */
export function sheetNormal(dir: Node<'vec2'>): Node<'vec3'> {
  return normalize(vec3(dir.x.mul(-0.05), 1, dir.y.mul(-0.05)));
}
