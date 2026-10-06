import { type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

// Cameras (brief: cockpit, chase, free orbit; padlock and missile cam arrive
// with the radar and the weapons). The chase camera hangs on a damped spring
// arm behind the jet and follows its attitude with a lag, so manoeuvres read;
// the cockpit camera sits at the pilot's eye and the head sags under G; the
// orbit camera turns round the jet with the mouse.

export type CameraMode = 'chase' | 'cockpit' | 'orbit';
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'cockpit', 'orbit'];

const CHASE_ATTITUDE_RATE = 5; // 1/s, tuned by hand: lag enough to see the roll, not so much it feels loose
const DEG = Math.PI / 180;

export class CameraRig {
  mode: CameraMode = 'chase';
  /** Chase distance behind the jet (m), adjustable with the wheel in chase view. */
  chaseDistanceM = 22;
  orbitYawRad = 0.6;
  orbitPitchRad = 0.15;
  private readonly smoothed = new Quaternion();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly look = new Vector3();
  private first = true;

  constructor(private readonly camera: PerspectiveCamera) {}

  /** `jetPos` / `jetRot`: interpolated render transform; `eye`: pilot's eye in model space; `loadFactor` for the head. */
  update(jetPos: Vector3, jetRot: Quaternion, eye: [number, number, number], loadFactor: number, lengthM: number, dtS: number): void {
    const cam = this.camera;
    if (this.first) {
      this.smoothed.copy(jetRot);
      this.first = false;
    }
    this.smoothed.slerp(jetRot, 1 - Math.exp(-CHASE_ATTITUDE_RATE * dtS));
    if (this.mode === 'cockpit') {
      // The head sinks a few centimetres per G and the view dips a little (tuned by hand).
      const sag = Math.max(-0.12, Math.min(0.08, -(loadFactor - 1) * 0.012));
      this.tmp.set(eye[0], eye[1] + sag, eye[2]).applyQuaternion(jetRot).add(jetPos);
      cam.position.copy(this.tmp);
      cam.quaternion.copy(jetRot);
      cam.rotateX(-Math.max(0, loadFactor - 1) * 0.15 * DEG);
      cam.fov = 70;
      cam.near = 0.05;
    } else if (this.mode === 'chase') {
      const d = Math.max(this.chaseDistanceM, lengthM * 0.9);
      this.tmp.set(0, d * 0.16, d).applyQuaternion(this.smoothed).add(jetPos);
      cam.position.copy(this.tmp);
      this.look.set(0, d * 0.05, -lengthM).applyQuaternion(this.smoothed).add(jetPos);
      this.tmp2.set(0, 1, 0).applyQuaternion(this.smoothed);
      cam.up.copy(this.tmp2);
      cam.lookAt(this.look);
      cam.fov = 60;
      cam.near = 0.5;
    } else {
      const d = this.chaseDistanceM * 1.2;
      this.tmp.set(Math.sin(this.orbitYawRad) * Math.cos(this.orbitPitchRad), Math.sin(this.orbitPitchRad), Math.cos(this.orbitYawRad) * Math.cos(this.orbitPitchRad)).multiplyScalar(d).add(jetPos);
      cam.position.copy(this.tmp);
      cam.up.set(0, 1, 0);
      cam.lookAt(jetPos);
      cam.fov = 55;
      cam.near = 0.5;
    }
    cam.updateProjectionMatrix();
  }

  orbit(dxPx: number, dyPx: number): void {
    this.orbitYawRad -= dxPx * 0.005;
    this.orbitPitchRad = Math.max(-1.4, Math.min(1.4, this.orbitPitchRad + dyPx * 0.005));
  }

  next(): void {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length] ?? 'chase';
  }
}
