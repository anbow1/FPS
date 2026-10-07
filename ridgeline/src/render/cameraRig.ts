import { type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

// Cameras (brief: cockpit pilot and gunner, exterior chase, orbit). The chase
// camera hangs on a damped spring arm behind and above, following the heading
// (not the roll: a helicopter's attitude changes constantly and the view should
// not slosh with every cyclic input) and pushed up out of the ground when the
// arm would go through a ridge. The cockpit cameras sit at the crew's eyes and
// shake with the airframe's vibration. The orbit camera turns round the
// aircraft with the mouse or a finger.

export type CameraMode = 'chase' | 'cockpit' | 'gunner' | 'orbit';
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'cockpit', 'gunner', 'orbit'];

const DEG = Math.PI / 180;

export class CameraRig {
  mode: CameraMode = 'chase';
  chaseDistanceM = 24;
  orbitYawRad = 0.7;
  orbitPitchRad = 0.2;
  orbitZoom = 1;
  /** Head look (cockpit seats) or a swing of the chase arm, from a touch drag; it eases back when let go. */
  lookYawRad = 0;
  lookPitchRad = 0;
  private lookIdleS = 0;
  private yaw = 0;
  private pitch = 0;
  private readonly arm = new Vector3();
  private readonly tmp = new Vector3();
  private readonly look = new Vector3();
  private readonly q = new Quaternion();
  private first = true;
  private shakeT = 0;

  constructor(private readonly camera: PerspectiveCamera) {}

  /**
   * `pos` / `rot`: the helicopter's interpolated render transform; `eyes`: pilot and gunner eye points in body
   * axes; `vibration` 0…1 shakes the cockpit views; `groundAt` keeps the chase camera out of the terrain.
   */
  update(pos: Vector3, rot: Quaternion, eyes: { pilot: [number, number, number]; gunner: [number, number, number] }, vibration: number, lengthM: number, dtS: number, groundAt: (x: number, z: number) => number): void {
    const cam = this.camera;
    // Heading and pitch of the airframe.
    const fwd = this.tmp.set(0, 0, -1).applyQuaternion(rot);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    if (this.first) {
      this.yaw = yaw;
      this.pitch = pitch;
      this.first = false;
    }
    let dy = yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const k = 1 - Math.exp(-3 * dtS);
    this.yaw += dy * k;
    this.pitch += (pitch * 0.4 - this.pitch) * k;
    this.shakeT += dtS;
    if (this.mode === 'cockpit' || this.mode === 'gunner') {
      const e = this.mode === 'cockpit' ? eyes.pilot : eyes.gunner;
      cam.position.set(e[0], e[1], e[2]).applyQuaternion(rot).add(pos);
      cam.quaternion.copy(rot);
      // Airframe vibration: a few hertz of small rotations, growing with the vibration level.
      const a = vibration * 0.6 * DEG + 0.04 * DEG;
      this.q.setFromAxisAngle(this.tmp.set(1, 0, 0), Math.sin(this.shakeT * 31) * a);
      cam.quaternion.multiply(this.q);
      this.q.setFromAxisAngle(this.tmp.set(0, 0, 1), Math.sin(this.shakeT * 23 + 1) * a);
      cam.quaternion.multiply(this.q);
      // The gunner looks a little down, towards the ground the sensor works on.
      if (this.mode === 'gunner') cam.rotateX(-8 * DEG);
      // The pilot's default view looks a little down, so the displays are in the picture.
      else cam.rotateX(-7 * DEG);
      cam.rotateY(this.lookYawRad);
      cam.rotateX(this.lookPitchRad);
      cam.fov = this.mode === 'gunner' ? 60 : 75;
      cam.near = 0.05;
    } else if (this.mode === 'chase') {
      const d = Math.max(this.chaseDistanceM, lengthM * 1.3);
      const p = Math.max(-1.2, Math.min(0.5, this.pitch - 0.22 + this.lookPitchRad * 0.7));
      const ay = this.yaw + this.lookYawRad;
      this.arm.set(Math.sin(ay) * Math.cos(p), -Math.sin(p), Math.cos(ay) * Math.cos(p)).multiplyScalar(d);
      cam.position.copy(pos).add(this.arm);
      // Keep the camera above the ground (and the look point clear of it).
      const g = groundAt(cam.position.x, cam.position.z) + 1.5;
      if (cam.position.y < g) cam.position.y = g;
      this.look
        .set(-Math.sin(ay), 0, -Math.cos(ay))
        .multiplyScalar(lengthM * 0.6)
        .add(pos);
      this.look.y += 1.2;
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      cam.fov = 60;
      cam.near = 0.3;
    } else {
      const d = this.chaseDistanceM * 1.1 * this.orbitZoom;
      cam.position
        .set(Math.sin(this.orbitYawRad) * Math.cos(this.orbitPitchRad), Math.sin(this.orbitPitchRad), Math.cos(this.orbitYawRad) * Math.cos(this.orbitPitchRad))
        .multiplyScalar(d)
        .add(pos);
      const g = groundAt(cam.position.x, cam.position.z) + 1;
      if (cam.position.y < g) cam.position.y = g;
      cam.up.set(0, 1, 0);
      cam.lookAt(pos);
      cam.fov = 55;
      cam.near = 0.3;
    }
    cam.updateProjectionMatrix();
  }

  /** A look drag (px); `dtS` lets the view ease back to straight ahead a couple of seconds after it stops. */
  lookBy(dxPx: number, dyPx: number, dtS: number): void {
    if (dxPx !== 0 || dyPx !== 0) {
      this.lookYawRad = Math.max(-2.2, Math.min(2.2, this.lookYawRad - dxPx * 0.004));
      this.lookPitchRad = Math.max(-1.0, Math.min(0.6, this.lookPitchRad - dyPx * 0.004));
      this.lookIdleS = 0;
      return;
    }
    this.lookIdleS += dtS;
    if (this.lookIdleS > 2.5) {
      const k = Math.exp(-1.5 * dtS);
      this.lookYawRad *= k;
      this.lookPitchRad *= k;
    }
  }

  orbit(dxPx: number, dyPx: number): void {
    this.orbitYawRad -= dxPx * 0.005;
    this.orbitPitchRad = Math.max(-1.2, Math.min(1.4, this.orbitPitchRad + dyPx * 0.005));
  }

  next(): void {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length] ?? 'chase';
  }
}
