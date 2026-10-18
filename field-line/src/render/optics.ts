import { abs, cameraPosition, cross, float, fract, length, max, min, positionGeometry, positionWorld, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import { HalfFloatType, MeshBasicNodeMaterial, type Node, PerspectiveCamera, type Quaternion, RenderTarget, type Scene, Vector2, Vector3, type WebGPURenderer } from 'three/webgpu';
import { CAMERA, SCOPE } from '../config.ts';

// Real optics, not screen overlays (brief).
//
// Red dot: the dot is drawn on the optic's rear glass wherever the view ray
// from the eye is within the dot's angular radius of the optic's axis. That is
// what a collimated sight does: the dot sits at infinity, shifts with head
// position exactly as parallax says, and vanishes off the edge of the glass.
//
// Scope: a second camera renders the magnified view into its own target, shown
// on the ocular lens with a first-focal-plane mil-dot reticle (holdover in mil
// stays true at 4× and 10×), a black shadow ring, and an exit-pupil penalty
// that closes the picture when the eye leaves the axis (moving, not settled).

export class RedDot {
  readonly axis = uniform(new Vector3(0, 0, -1));
  // Pre-exposed HDR: bright enough to read against a sunlit wall, short of where ACES bleaches red to pink.
  readonly brightness = uniform(1);
  /** Angle one screen pixel covers; the dot is never drawn smaller than ~3 px across. */
  readonly pixelAngleRad = uniform(0.001);
  readonly material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });

  constructor() {
    const viewDir = positionWorld.sub(cameraPosition).normalize();
    // sin(angle) via the cross product: acos loses the angle to float rounding near 0.
    const sinAngle = length(cross(viewDir, this.axis));
    const facing = viewDir.dot(this.axis).greaterThan(0);
    // A 2 MOA dot is 0.58 mrad: under one pixel on a 70° view, so a screen cannot show it at true size.
    // At 1 px (the old floor) the dot drowned in the glass at noon. An eye sees a 2 MOA dot as a crisp
    // point with a little flare round it: a core of ~3 px and a faint halo three times as wide.
    const r = max(float(SCOPE.redDotRadiusRad), this.pixelAngleRad.mul(1.5));
    const front = facing.select(float(1), float(0));
    const core = float(1).sub(smoothstep(r.mul(0.55), r, sinAngle));
    const halo = float(1).sub(smoothstep(r, r.mul(3), sinAngle)).mul(0.22);
    const dot = max(core, halo).mul(front);
    // Pre-exposed HDR red: sits a few stops over a sunlit wall so it reads at noon.
    this.material.colorNode = vec3(1.0, 0.06, 0.03).mul(this.brightness).mul(dot).add(vec3(0.02, 0.03, 0.05));
    this.material.opacityNode = dot.mul(0.9).add(0.08);
  }
}

export class Scope {
  readonly camera: PerspectiveCamera;
  readonly target: RenderTarget;
  readonly material = new MeshBasicNodeMaterial();
  /** Eye offset from the optical axis, in ocular radii (0 = centred). */
  readonly eyeOffset = uniform(new Vector2());
  /** 0 = eye away from the scope (dark), 1 = settled behind it. */
  readonly settle = uniform(0);
  private readonly fovMrad = uniform(20);
  magnification = 4;
  private readonly apparentFovRad: number;

  constructor(ocularRadiusM: number, sidePx: number) {
    // Apparent field of the eyepiece, seen from the eye-relief distance.
    this.apparentFovRad = 2 * Math.atan(ocularRadiusM / SCOPE.eyeReliefM);
    this.camera = new PerspectiveCamera(10, 1, 0.5, CAMERA.farM);
    this.camera.layers.set(0); // world only: never the viewmodel
    this.target = new RenderTarget(sidePx, sidePx, { type: HalfFloatType });
    this.target.texture.name = 'scopeView';

    const radius = ocularRadiusM;
    // Lens-plane coordinates in ocular radii, from the undeformed disc geometry.
    const p = positionGeometry.xy.div(radius);
    // Texel row 0 of a render target is the top of its image on both backends (three flips WebGL
    // reads to match WebGPU), so v runs downward: v = 0.5 − y/2, or the picture is upside down.
    const uv = vec2(p.x.mul(0.5).add(0.5), float(0.5).sub(p.y.mul(0.5)));
    const image = texture(this.target.texture, uv).rgb;
    const mils = p.mul(this.fovMrad.mul(0.5)); // x right, y up, in mrad
    const reticle = milDot(mils);
    // Shadow ring and exit pupil: the picture shrinks toward the side the eye has left.
    const r = length(p.sub(this.eyeOffset.mul(1.4)));
    const edge = float(1).sub(smoothstep(0.86, 0.98, length(p)));
    const pupil = float(1).sub(smoothstep(this.settle.mul(0.75).add(0.1), this.settle.mul(0.85).add(0.2), r));
    this.material.colorNode = image.mul(reticle).mul(edge).mul(pupil);
  }

  /** Field of view follows magnification: true field = apparent field / magnification. */
  setMagnification(mag: number): void {
    this.magnification = mag;
    const trueFov = this.apparentFovRad / mag;
    this.camera.fov = (trueFov * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
    this.fovMrad.value = trueFov * 1000;
  }

  /** Renders the magnified view from the eye along the scope's own axis (it recoils with the rifle). */
  render(renderer: WebGPURenderer, scene: Scene, eye: Vector3, orientation: Quaternion): void {
    this.camera.position.copy(eye);
    this.camera.quaternion.copy(orientation);
    this.camera.updateMatrixWorld();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
  }
}

/**
 * Mil-dot reticle in the first focal plane: fine cross-hair to ±10 mil with a
 * dot every mil (0.25 mil diameter), heavy posts beyond. Returns a multiplier
 * for the image: 0 on the (black) reticle, 1 elsewhere.
 */
function milDot(m: Node<'vec2'>) {
  const ax = abs(m.x);
  const ay = abs(m.y);
  const thin = float(0.035);
  const post = float(0.2);
  const inner = max(ax, ay).lessThan(10);
  const onH = ay.lessThan(inner.select(thin, post));
  const onV = ax.lessThan(inner.select(thin, post));
  const nearestX = abs(fract(m.x.add(0.5)).sub(0.5));
  const nearestY = abs(fract(m.y.add(0.5)).sub(0.5));
  const dotR = float(0.125);
  const dotH = length(vec2(nearestX, ay)).lessThan(dotR).and(ax.lessThan(10.2));
  const dotV = length(vec2(ax, nearestY)).lessThan(dotR).and(ay.lessThan(10.2));
  const ink = onH.or(onV).or(dotH).or(dotV).and(min(ax, ay).lessThan(0.3));
  return ink.select(float(0), float(1));
}
