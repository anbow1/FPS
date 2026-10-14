import { abs, cameraFar, cameraNear, cameraPosition, cameraViewMatrix, dot, exp, float, Fn, fract, length, max, min, nodeObject, perspectiveDepthToViewZ, positionWorld, pow, screenCoordinate, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { AdditiveBlending, BackSide, ConeGeometry, DepthTexture, FloatType, Mesh, MeshBasicNodeMaterial, type Node, type NodeBuilder, type Object3D, Vector3, ViewportDepthTextureNode } from 'three/webgpu';
import { lightColour } from './colour.ts';
import { U } from './uniforms.ts';

// Headlight beams in the air: the light a lamp throws, seen where the air
// scatters it back to the eye, after the landing lights cutting through the
// haze in the Halcyon seaplane scene (an AI-made three.js scene). A cone
// mesh is only a proxy for where a beam can be: its back faces give each
// pixel the far end of the view ray's path through it, the scene's depth
// cuts that path where something solid stands in front, and the fragment
// shader integrates the in-scattered light along it,
//   L = ∫ σ(y) · p(θ) · I(ω) / r² · e^(−σ t) dt,
// with I(ω) the lamp's candela in that direction (a low beam: wide, aimed
// a little down, with a sharp flat top), r the distance from the lamp, p a
// two-lobe Henyey–Greenstein phase (droplets throw most light forward, some
// straight back) and σ the air's scattering (the stage's fog, a humid
// tropical floor, much more in rain). In physical units it needs no fading
// by time of day: at noon a few nits vanish against the day, at night they
// are a bright fan. Samples bunch near the camera end (t ∝ u²), where a beam
// seen from the driver's seat is brightest, and jitter per pixel and frame;
// TRAA averages the grain.

const SAMPLES = 14;
/** Proxy cone: length (m) and half-angle (rad), wide enough for both lamps' beams. */
const LENGTH_M = 26;
const HALF_ANGLE = 0.46;
/** The proxy's apex sits this far behind the lamps (m) so their 0.57 m spacing stays inside it. */
const APEX_BACK_M = 0.7;
/** Humid tropical night air scatters even when clear (1/m); rain adds much more per unit of rain. */
const BASE_SCATTER = 0.0018;
const RAIN_SCATTER = 0.02;
const COLOUR_K = 3300;

function phaseHG(cosT: Node<'float'>, g: number): Node<'float'> {
  const d = float(1 + g * g).sub(cosT.mul(2 * g));
  return float((1 - g * g) / (4 * Math.PI)).div(pow(max(d, 1e-4), 1.5));
}

// A copy of the depth buffer in its own format (reversed depth is depth32float), as screenReflection.ts does.
let depthTex: DepthTexture | null = null;
function depthCopy(reversed: boolean): DepthTexture {
  if (!depthTex) {
    depthTex = new DepthTexture();
    if (reversed) depthTex.type = FloatType;
  }
  return depthTex;
}

export class HeadlightBeams {
  readonly mesh: Mesh;
  /** Lamp positions, beam axis and its right and up (world), and each lamp's intensity (cd, pre-exposed). */
  private readonly lampA = uniform(new Vector3());
  private readonly lampB = uniform(new Vector3());
  private readonly axis = uniform(new Vector3(0, 0, -1));
  private readonly right = uniform(new Vector3(1, 0, 0));
  private readonly up = uniform(new Vector3(0, 1, 0));
  private readonly candela = uniform(0);
  private readonly tmp = new Vector3();
  private readonly tmpB = new Vector3();

  /**
   * `lampA`/`lampB` are the two lamps in the parent's frame, `aim` the beam's direction there
   * (already pitched down); the proxy cone is placed in that frame and moves with the vehicle.
   */
  constructor(
    private readonly localA: Vector3,
    private readonly localB: Vector3,
    private readonly localAim: Vector3,
  ) {
    const radius = LENGTH_M * Math.tan(HALF_ANGLE);
    // Apex at the origin, opening along −Z, then turned onto the aim.
    const g = new ConeGeometry(radius, LENGTH_M, 24, 1, false).translate(0, -LENGTH_M / 2, 0).rotateX(Math.PI / 2);
    const m = new MeshBasicNodeMaterial({ name: 'headlight beams', transparent: true, depthWrite: false, depthTest: false, side: BackSide, blending: AdditiveBlending });
    m.colorNode = this.shader();
    this.mesh = new Mesh(g, m);
    this.mesh.name = 'headlight beams';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    const mid = localA.clone().add(localB).multiplyScalar(0.5);
    const aim = localAim.clone().normalize();
    this.mesh.position.copy(mid).addScaledVector(aim, -APEX_BACK_M);
    this.mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), aim);
  }

  /** After the parent has moved: the lamps and axis in world space, and the lamps' intensity (0 = off). */
  update(parent: Object3D, candelaPreExposed: number): void {
    parent.updateWorldMatrix(true, false);
    this.lampA.value.copy(this.localA).applyMatrix4(parent.matrixWorld);
    this.lampB.value.copy(this.localB).applyMatrix4(parent.matrixWorld);
    const a = this.tmp.copy(this.localAim).transformDirection(parent.matrixWorld);
    this.axis.value.copy(a);
    const r = this.tmpB.copy(this.localB).sub(this.localA).transformDirection(parent.matrixWorld);
    this.right.value.copy(r).addScaledVector(a, -r.dot(a)).normalize();
    this.up.value.crossVectors(this.right.value, a).normalize();
    this.candela.value = candelaPreExposed;
    // Off: shrink the proxy to nothing (no fragments, and no recompile as hiding it would cost).
    this.mesh.scale.setScalar(candelaPreExposed > 0 ? 1 : 1e-4);
  }

  private shader(): Node<'vec3'> {
    const { lampA, lampB, axis, right, up, candela } = this;
    return Fn((_: unknown, builder: NodeBuilder) => {
      const ro = cameraPosition;
      const toFrag = positionWorld.sub(ro);
      const tFrag = length(toFrag);
      const rd = toFrag.div(tFrag);
      // Where the view ray meets the opaque scene: the beam ends there.
      const sceneDepth = nodeObject(new ViewportDepthTextureNode(screenUV, null, depthCopy(builder.renderer.reversedDepthBuffer === true)));
      const sceneViewZ = perspectiveDepthToViewZ(sceneDepth.sample(screenUV).x, cameraNear, cameraFar);
      const fragViewZ = cameraViewMatrix.mul(vec4(positionWorld, 1)).z;
      const tEnd = tFrag.mul(min(sceneViewZ.div(min(fragViewZ, -1e-3)), 1));
      // Start no further back than the proxy's widest cross-section allows (with a margin).
      const exitAlong = max(dot(positionWorld.sub(lampA), axis), 0.5);
      const sinA = length(rd.sub(axis.mul(dot(rd, axis)))).max(0.05);
      const chord = exitAlong.mul(2 * Math.tan(HALF_ANGLE)).div(sinA).add(1);
      const tStart = max(tEnd.sub(chord), 0.05);
      const span = max(tEnd.sub(tStart), 0);
      // Per-pixel, per-frame jitter (interleaved gradient noise).
      const ign = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy.add(U.time.mul(60 * 5.588238)), vec2(0.06711056, 0.00583715)))));
      const sigma0 = U.fogDensity.add(BASE_SCATTER).add(U.rain.mul(RAIN_SCATTER));
      let sum: Node<'float'> = float(0);
      for (let i = 0; i < SAMPLES; i++) {
        const u = ign.add(i).div(SAMPLES);
        const t = tStart.add(span.mul(u.mul(u)));
        const dt = span.mul(u.mul(2 / SAMPLES));
        const p = ro.add(rd.mul(t));
        const sigma = sigma0.mul(exp(U.fogFalloff.mul(max(p.y, 0)).negate()));
        let lit: Node<'float'> = float(0);
        for (const lamp of [lampA, lampB]) {
          const v = p.sub(lamp);
          const r2 = max(dot(v, v), 0.04);
          const along = dot(v, axis);
          const az = max(along, 1e-3);
          // Low beam: ±24° wide, a sharp flat top just above the axis, softer below; nothing behind the lamp.
          const ax = abs(dot(v, right)).div(az);
          const ay = dot(v, up).div(az);
          const shape = smoothstep(0.42, 0.16, ax)
            .mul(smoothstep(0.035, 0.0, ay))
            .mul(smoothstep(-0.32, -0.1, ay))
            .mul(smoothstep(0.0, 0.25, along))
            .mul(smoothstep(LENGTH_M, LENGTH_M * 0.55, along));
          const cosT = dot(v.div(r2.sqrt()), rd.negate());
          const phase = phaseHG(cosT, 0.7).mul(0.8).add(phaseHG(cosT, -0.3).mul(0.2));
          lit = lit.add(shape.mul(phase).div(r2));
        }
        sum = sum.add(lit.mul(sigma).mul(exp(sigma.mul(t).negate())).mul(dt));
      }
      const c = lightColour(COLOUR_K);
      return vec3(c.r, c.g, c.b).mul(candela).mul(sum);
    })() as Node<'vec3'>;
  }
}
