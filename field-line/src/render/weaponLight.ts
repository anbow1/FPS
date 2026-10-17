import { cameraFar, cameraNear, cameraPosition, cameraViewMatrix, dot, exp, float, Fn, fract, length, max, min, nodeObject, perspectiveDepthToViewZ, positionWorld, pow, screenCoordinate, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { AdditiveBlending, BackSide, ConeGeometry, DepthTexture, FloatType, Mesh, MeshBasicNodeMaterial, type Node, type NodeBuilder, type PerspectiveCamera, type Scene, SpotLight, Vector3, ViewportDepthTextureNode } from 'three/webgpu';
import { lightColour } from './colour.ts';

// The light on the weapon, after the bodycam shooter "Block 17" (an AI-made
// browser game): in a dark building the weapon light is the scene — a hot
// spot with a soft spill, hard shadows thrown from the muzzle, and the beam
// itself hanging in the dust. A tactical light of ~1000 lm puts some 22 000 cd
// in its hot spot; in physical units it needs no tuning per time of day: at
// noon it barely shows, at night or indoors it carries the picture.
//
// The light is always in the scene (intensity 0 when off): adding or removing
// a light, or toggling its shadow, changes every material's lighting and
// recompiles them all, a hitch of seconds (playbook §8.3). Off, its shadow
// camera shrinks to nothing so the shadow pass draws nothing.
//
// The beam in the air is the lagoon jeep's headlight-beam integrator
// (castaway-lagoon render/lightBeams.ts) for one round lamp: a back-faced cone
// proxy, the view ray clipped by a copy of the scene depth, in-scattered light
// summed along it with a two-lobe Henyey–Greenstein phase.

const PEAK_CD = 22000;
const COLOUR_K = 5600;
/** three's cone: full intensity inside (1 − penumbra) of the angle, a soft edge out to it. */
const CONE_RAD = 0.36;
const PENUMBRA = 0.78;
const RANGE_M = 60;
/** Camera-space position of the lamp on the rail (m): right, down, ahead of the eye. */
const MOUNT = new Vector3(0.11, -0.11, -0.45);

// Beam integrator.
const SAMPLES = 12;
const BEAM_LENGTH_M = 28;
const BEAM_HALF_ANGLE = 0.4;
/** Air always holds some dust (1/m); rooms more (stirred, unventilated); rain much more. */
const BASE_SCATTER = 0.0012;

function phaseHG(cosT: Node<'float'>, g: number): Node<'float'> {
  const d = float(1 + g * g).sub(cosT.mul(2 * g));
  return float((1 - g * g) / (4 * Math.PI)).div(pow(max(d, 1e-4), 1.5));
}

let depthTex: DepthTexture | null = null;
function depthCopy(reversed: boolean): DepthTexture {
  if (!depthTex) {
    depthTex = new DepthTexture();
    // Reversed depth is depth32float: the copy must match its format (screenReflection.ts does the same).
    if (reversed) depthTex.type = FloatType;
  }
  return depthTex;
}

export class WeaponLight {
  readonly light: SpotLight;
  readonly beam: Mesh;
  private readonly lamp = uniform(new Vector3());
  private readonly axis = uniform(new Vector3(0, 0, -1));
  private readonly candela = uniform(0);
  private readonly scatter = uniform(BASE_SCATTER);
  private readonly time = uniform(0);
  private readonly fwd = new Vector3();
  private readonly shadows: boolean;

  constructor(scene: Scene, quality: 'high' | 'low') {
    const c = lightColour(COLOUR_K);
    this.light = new SpotLight(0xffffff, 0, RANGE_M, CONE_RAD, PENUMBRA, 2);
    this.light.color.setRGB(c.r, c.g, c.b);
    this.light.name = 'weapon light';
    this.shadows = quality === 'high';
    // Shadow on High only, set once and never toggled (see above); a small map — the cone is narrow.
    this.light.castShadow = this.shadows;
    this.light.shadow.mapSize.set(1024, 1024);
    this.light.shadow.camera.near = 0.25;
    this.light.shadow.camera.far = RANGE_M;
    this.light.shadow.bias = -0.0002;
    this.light.shadow.normalBias = 0.02;
    scene.add(this.light, this.light.target);

    const radius = BEAM_LENGTH_M * Math.tan(BEAM_HALF_ANGLE);
    const g = new ConeGeometry(radius, BEAM_LENGTH_M, 24, 1, false).translate(0, -BEAM_LENGTH_M / 2, 0).rotateX(Math.PI / 2);
    const m = new MeshBasicNodeMaterial({ name: 'weapon light beam', transparent: true, depthWrite: false, depthTest: false, side: BackSide, blending: AdditiveBlending });
    // colorNode, not fragmentNode: the scene pass writes a velocity target too (MRT).
    m.colorNode = this.shader();
    this.beam = new Mesh(g, m);
    this.beam.name = 'weapon light beam';
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 5;
    scene.add(this.beam);
  }

  /**
   * Each frame, after the camera has moved: `on` from the player's toggle, `preExposure` for the lamp's
   * physical intensity, `scatterPerM` the air's scattering (fog, rain, indoor dust).
   */
  update(cam: PerspectiveCamera, on: boolean, preExposure: number, scatterPerM: number, timeS: number): void {
    const lamp = this.lamp.value.copy(MOUNT).applyMatrix4(cam.matrixWorld);
    const fwd = this.fwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
    this.axis.value.copy(fwd);
    this.light.position.copy(lamp);
    this.light.target.position.copy(lamp).addScaledVector(fwd, 10);
    this.light.target.updateMatrixWorld();
    const cd = on ? PEAK_CD * preExposure : 0;
    this.light.intensity = cd;
    // Off: a shadow frustum of a few centimetres culls every caster, so its pass draws nothing.
    if (this.shadows) {
      const far = on ? RANGE_M : 0.3;
      if (this.light.shadow.camera.far !== far) {
        this.light.shadow.camera.far = far;
        this.light.shadow.camera.updateProjectionMatrix();
      }
    }
    this.candela.value = cd;
    this.scatter.value = scatterPerM;
    this.time.value = timeS;
    // The beam's proxy cone at the lamp, along the aim; shrunk to nothing when off (no fragments, no recompile).
    this.beam.position.copy(lamp);
    this.beam.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), fwd);
    this.beam.scale.setScalar(on ? 1 : 1e-4);
  }

  private shader(): Node<'vec3'> {
    const { lamp, axis, candela, scatter, time } = this;
    return Fn((_: unknown, builder: NodeBuilder) => {
      const ro = cameraPosition;
      const toFrag = positionWorld.sub(ro);
      const tFrag = length(toFrag);
      const rd = toFrag.div(tFrag);
      const sceneDepth = nodeObject(new ViewportDepthTextureNode(screenUV, null, depthCopy(builder.renderer.reversedDepthBuffer === true)));
      const sceneViewZ = perspectiveDepthToViewZ(sceneDepth.sample(screenUV).x, cameraNear, cameraFar);
      const fragViewZ = cameraViewMatrix.mul(vec4(positionWorld, 1)).z;
      const tEnd = tFrag.mul(min(sceneViewZ.div(min(fragViewZ, -1e-3)), 1));
      // The lamp is half a metre in front of the eye. Within the first ~0.7 m its beam is only a few
      // centimetres across and sends almost nothing back toward the eye; as a point source there, I / r²
      // blew the middle of the picture out to white. Start past it.
      const tStart = float(0.7);
      const span = max(tEnd.sub(tStart), 0);
      const ign = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy.add(time.mul(60 * 5.588238)), vec2(0.06711056, 0.00583715)))));
      let sum: Node<'float'> = float(0);
      for (let i = 0; i < SAMPLES; i++) {
        const u = ign.add(i).div(SAMPLES);
        const t = tStart.add(span.mul(u.mul(u)));
        const dt = span.mul(u.mul(2 / SAMPLES));
        const v = ro.add(rd.mul(t)).sub(lamp);
        const r2 = max(dot(v, v), 0.36);
        const along = max(dot(v, axis), 1e-3);
        // Off-axis angle (as a tangent): a tight hot spot and a wide, faint spill, as a reflector throws.
        const off = length(v.sub(axis.mul(along))).div(along);
        // (The spill carries a few per cent of the hot spot's intensity: more, and it hung as a glowing bank.)
        const shape = exp(off.div(0.075).mul(off.div(0.075)).negate()).add(smoothstep(0.42, 0.16, off).mul(0.035)).mul(smoothstep(0.3, 1.5, along));
        const cosT = dot(v.div(r2.sqrt()), rd.negate());
        // Mostly forward (the eye is behind the lamp and sees the beam from the side or from behind).
        const phase = phaseHG(cosT, 0.75).mul(0.9).add(phaseHG(cosT, -0.3).mul(0.1));
        sum = sum.add(shape.mul(phase).div(r2).mul(scatter).mul(exp(scatter.mul(t).negate())).mul(dt));
      }
      const c = lightColour(COLOUR_K);
      return vec3(c.r, c.g, c.b).mul(candela).mul(sum);
    })() as Node<'vec3'>;
  }
}
