import { cameraFar, cameraNear, cameraProjectionMatrix, cameraViewMatrix, float, Fn, If, max, min, nodeObject, perspectiveDepthToViewZ, screenUV, select, smoothstep, uniform, vec2, vec4, viewportSharedTexture } from 'three/tsl';
import { DepthTexture, FloatType, type Node, type NodeBuilder, ViewportDepthTextureNode } from 'three/webgpu';

// Screen-space reflection for a water surface drawn after the opaque scene,
// shared file for file by the games (docs/graphics-playbook.md §7.12). The sky
// alone is a poor mirror: at the grazing angles where Fresnel makes water
// most reflective, palms, rocks, boats and the far hills belong in it. The
// reflected ray is marched in world space with geometrically growing steps
// (fine near the surface, long towards the horizon), each point projected to
// the screen and compared with the opaque scene's depth; a hit is refined by
// bisection (and dropped if the refined point does not lie on the scene's
// surface) and the scene colour there is the reflection. What the screen
// does not hold (off its edges, behind the camera, the sky) is left to the
// caller's own sky reflection, faded in over the last tenth of the screen.
//
// The march is unrolled with no early exit: WGSL only allows implicit-LOD
// sampling in uniform control flow, and the depth reads here need no mips
// anyway. Cost is STEPS + REFINE depth reads per water pixel, so the games
// use it on High only, and their frame governors switch it off through
// `screenReflectionOn` (a uniform branch: no recompile) before they lower the
// resolution.

/** 1 = march, 0 = skip (the caller's sky reflection only). Set by the frame governor. */
export const screenReflectionOn = uniform(1);

const STEPS = 20;
const REFINE = 4;
/** First step (m) and growth per step: 20 steps reach about 350 m. */
const FIRST_STEP_M = 0.3;
const GROWTH = 1.45;

export interface ScreenReflection {
  /** Scene radiance at the hit (pre-exposed, as the viewport texture holds it). */
  colour: Node<'vec3'>;
  /** 0–1: how much of the reflection the screen can supply. */
  weight: Node<'float'>;
}

// The copy of the depth buffer must match its format: three's shared viewport depth copy is
// depth24plus, but a reversed depth buffer is depth32float, and the copy then fails every frame.
const depthCopies = new Map<boolean, DepthTexture>();
function depthCopy(reversed: boolean): DepthTexture {
  let t = depthCopies.get(reversed);
  if (!t) {
    t = new DepthTexture();
    if (reversed) t.type = FloatType;
    depthCopies.set(reversed, t);
  }
  return t;
}

const marchFn = Fn(([originIn, dirIn]: [Node<'vec3'>, Node<'vec3'>], builder: NodeBuilder) => {
  const origin = originIn;
  const dir = dirIn;
  // One base node, sampled through clones: each viewport texture node keeps its own copy of the
  // framebuffer, so separate nodes would mean one copy and one texture binding per step (and
  // 24 bindings break WebGPU's limit of 16), while `.sample()` clones share the base's copy.
  const sceneDepth = nodeObject(new ViewportDepthTextureNode(screenUV, null, depthCopy(builder.renderer.reversedDepthBuffer === true)));
  const project = (t: Node<'float'>): { uv: Node<'vec2'>; rayDist: Node<'float'>; sceneDist: Node<'float'>; behindCamera: Node<'bool'> } => {
    const view = cameraViewMatrix.mul(vec4(origin.add(dir.mul(t)), 1));
    const clip = cameraProjectionMatrix.mul(view);
    const ndc = clip.xy.div(max(clip.w, 1e-4));
    const uv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
    const depth = sceneDepth.sample(uv.clamp(0, 1)).x;
    return { uv, rayDist: view.z.negate(), sceneDist: perspectiveDepthToViewZ(depth, cameraNear, cameraFar).negate(), behindCamera: view.z.greaterThanEqual(0) };
  };
  const found = float(0).toVar('ssrFound');
  const lo = float(0).toVar('ssrLo');
  const hi = float(0).toVar('ssrHi');
  let tPrev = 0;
  let t = FIRST_STEP_M;
  for (let i = 0; i < STEPS; i++) {
    const s = project(float(t));
    const inside = s.uv.x.greaterThan(0).and(s.uv.x.lessThan(1)).and(s.uv.y.greaterThan(0)).and(s.uv.y.lessThan(1)).and(s.behindCamera.not());
    // Behind the scene by less than a thickness that grows with the step: a hit. Further behind,
    // the ray passed behind a foreground object and must not pick up its colour.
    const thickness = Math.max(0.5, (t - tPrev) * 1.2);
    const hit = inside.and(s.rayDist.greaterThan(s.sceneDist)).and(s.rayDist.sub(s.sceneDist).lessThan(thickness));
    // TSL runs the If body later, when the shader is built: capture this step's bounds now, or
    // every branch would read the loop's final values.
    const stepStart = tPrev;
    const stepEnd = t;
    If(hit.and(found.equal(0)), () => {
      found.assign(1);
      lo.assign(stepStart);
      hi.assign(stepEnd);
    });
    tPrev = t;
    t *= GROWTH;
  }
  // Bisection between the last point in front of the scene and the first behind it.
  for (let i = 0; i < REFINE; i++) {
    // `mid` and `behind` are frozen in variables: as plain expressions they would be re-read
    // after `hi` changes, and the second assignment would use the new midpoint.
    const mid = lo.add(hi).mul(0.5).toVar(`ssrMid${i}`);
    const s = project(mid);
    const behind = s.rayDist.greaterThan(s.sceneDist).toVar(`ssrBehind${i}`);
    hi.assign(select(behind, mid, hi));
    lo.assign(select(behind, lo, mid));
  }
  // A true intersection converges onto the surface: ray and scene depth meet. Where the ray only
  // passed behind a foreground edge, bisection converges onto the depth discontinuity instead
  // and the gap stays wide.
  const end = project(hi);
  const gap = end.rayDist.sub(end.sceneDist).abs();
  const meets = float(1).sub(smoothstep(hi.sub(lo).mul(1.2).add(0.1), hi.sub(lo).mul(2.4).add(0.2), gap));
  const edge = min(min(end.uv.x, float(1).sub(end.uv.x)), min(end.uv.y, float(1).sub(end.uv.y)));
  const weight = found.mul(meets).mul(smoothstep(0, 0.1, edge));
  return vec4(end.uv.clamp(0, 1), weight, 0);
});

const reflectFn = Fn(([originIn, dirIn]: [Node<'vec3'>, Node<'vec3'>]) => {
  const r = vec4(0.5, 0.5, 0, 0).toVar('ssr');
  // A branch on a uniform keeps the control flow uniform, so the samples inside stay legal.
  If(screenReflectionOn.greaterThan(0.5), () => {
    r.assign(marchFn(originIn, dirIn));
  });
  return r;
});

/** Reflection of the opaque scene along `dir` (world, unit) from world point `origin`. */
export function screenReflection(origin: Node<'vec3'>, dir: Node<'vec3'>): ScreenReflection {
  const hit = screenReflectionHit(origin, dir);
  return { colour: viewportSharedTexture(hit.uv).rgb, weight: hit.weight };
}

/**
 * Where the reflected ray meets the opaque scene on screen (`uv`) and how far that can be trusted
 * (`weight`), for callers that sample the scene there themselves — e.g. several taps along the
 * screen's vertical for the stretched reflections of a wet road.
 */
export function screenReflectionHit(origin: Node<'vec3'>, dir: Node<'vec3'>): { uv: Node<'vec2'>; weight: Node<'float'> } {
  const r = reflectFn(origin, dir);
  return { uv: r.xy, weight: r.z };
}
