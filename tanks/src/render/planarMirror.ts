import { HalfFloatType, type Object3D, PerspectiveCamera, Plane, RenderTarget, type Scene, Vector2, Vector3, Vector4, type WebGPURenderer } from 'three/webgpu';

// A planar mirror for calm water: the scene drawn once more from the camera
// reflected in the water plane, into a target the water shader samples at its
// own screen position (mirrored in x, as the reflected camera's image is).
//
// three's reflector() could not be used: rendered from inside the MRT scene
// pass it drew nothing on the WebGL2 backend, and its oblique near plane is
// derived for a standard depth range, while this renderer's depth buffer is
// reversed. So the mirror renders on its own before the frame, and the near
// plane is moved onto the water with the reversed-depth form of Lengyel's
// oblique frustum: row 3 of the projection becomes row4 − a·C, so that the
// near test (z_c ≤ w_c) reads a·(C·v) ≥ 0 — the visible side of the plane —
// with `a` chosen to keep the far plane through the frustum's far corner.

export class PlanarMirror {
  readonly target: RenderTarget;
  readonly camera = new PerspectiveCamera();
  /** Fraction of the drawing buffer's resolution. */
  scale: number;
  private readonly plane = new Plane();
  private readonly size = new Vector2();
  private readonly n = new Vector3(0, 1, 0);
  private readonly p = new Vector3();
  private readonly look = new Vector3();
  private readonly up = new Vector3();
  private readonly c = new Vector4();
  private readonly q = new Vector4();

  constructor(
    private readonly heightM: number,
    scale: number,
  ) {
    this.scale = scale;
    this.target = new RenderTarget(1, 1, { type: HalfFloatType });
    this.target.texture.name = 'water mirror';
  }

  /** Renders the reflection of `scene` seen from `camera` (call before the frame, outside any pass). */
  render(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x * this.scale));
    const h = Math.max(1, Math.floor(this.size.y * this.scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    const v = this.camera;
    v.copy(camera, false);
    camera.updateMatrixWorld();
    // the eye, the point it looks at and its up, reflected in the plane y = height
    this.p.setFromMatrixPosition(camera.matrixWorld);
    this.look.set(0, 0, -1).transformDirection(camera.matrixWorld).add(this.p);
    this.up.set(0, 1, 0).transformDirection(camera.matrixWorld);
    const H = this.heightM;
    v.position.set(this.p.x, 2 * H - this.p.y, this.p.z);
    v.up.set(this.up.x, -this.up.y, this.up.z);
    v.lookAt(this.look.x, 2 * H - this.look.y, this.look.z);
    v.updateMatrixWorld();
    v.projectionMatrix.copy(camera.projectionMatrix);

    // the water plane in the reflected camera's view space, as (n, d) with n·v + d > 0 above it
    this.plane.setFromNormalAndCoplanarPoint(this.n, this.p.set(0, H, 0)).applyMatrix4(v.matrixWorldInverse);
    this.c.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const e = v.projectionMatrix.elements;
    // the far corner of the frustum on the plane's side (reversed depth: far is NDC z = 0)
    this.q.set(Math.sign(this.c.x), Math.sign(this.c.y), 0, 1).applyMatrix4(v.projectionMatrixInverse.copy(v.projectionMatrix).invert());
    const row4q = e[3]! * this.q.x + e[7]! * this.q.y + e[11]! * this.q.z + e[15]! * this.q.w;
    const a = row4q / this.c.dot(this.q);
    e[2] = e[3]! - a * this.c.x;
    e[6] = e[7]! - a * this.c.y;
    e[10] = e[11]! - a * this.c.z;
    e[14] = e[15]! - a * this.c.w;
    v.projectionMatrixInverse.copy(v.projectionMatrix).invert();

    const previous = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    renderer.setMRT(null);
    renderer.setRenderTarget(this.target);
    renderer.render(scene, v);
    renderer.setRenderTarget(previous);
    renderer.setMRT(previousMrt);
  }
}

/** Hides objects for the length of `draw` (the water itself, grass the mirror need not show). */
export function withHidden(objects: readonly Object3D[], draw: () => void): void {
  const was = objects.map((o) => o.visible);
  for (const o of objects) o.visible = false;
  try {
    draw();
  } finally {
    objects.forEach((o, k) => (o.visible = was[k]!));
  }
}
