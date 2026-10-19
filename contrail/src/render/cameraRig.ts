import { type PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

// Cameras (brief: cockpit, chase, free orbit, padlock, missile cam). The chase
// camera hangs on a damped spring arm behind the jet and follows its attitude
// with a lag, so manoeuvres read; the cockpit camera sits at the pilot's eye
// and the head sags under G; the orbit camera turns round the jet with the
// mouse; the padlock camera keeps the pilot's head turned to the tracked
// target (the head can turn ~160° either way, no further); the missile camera
// rides behind the last missile launched until it is gone. The panel camera
// is the cockpit's with the head bowed to the panel and a wider eye: the
// attitude ball, the radar and the hands on the stick and the throttle.

export type CameraMode = 'chase' | 'cockpit' | 'panel' | 'orbit' | 'padlock' | 'missile';
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'cockpit', 'panel', 'orbit', 'padlock', 'missile'];

/** What the padlock and missile cameras look at, when there is something. */
export interface CameraFocus {
  padlock: Vector3 | null;
  missile: { position: Vector3; velocity: Vector3 } | null;
}

const CHASE_ATTITUDE_RATE = 5; // 1/s, tuned by hand: lag enough to see the roll, not so much it feels loose
const DEG = Math.PI / 180;
const COCKPIT_LOOK_DOWN_RAD = 11 * DEG;
/** Looking down at the panel: 36° down and 80° of view take in the displays and both hands on the controls. */
const PANEL_LOOK_DOWN_RAD = 36 * DEG;
const PANEL_FOV_DEG = 80;
/** How fast the head turns between the two (1/s). */
const HEAD_RATE = 7;

export class CameraRig {
  mode: CameraMode = 'chase';
  /** Chase distance behind the jet (m), adjustable with the wheel in chase view. */
  chaseDistanceM = 22;
  orbitYawRad = 0.6;
  orbitPitchRad = 0.15;
  /** Orbit distance as a multiple of the chase distance (screenshots, a closer look). */
  orbitZoom = 1;
  private readonly smoothed = new Quaternion();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly look = new Vector3();
  private first = true;
  /** The head's bow and the eye's field in the seat, eased between the cockpit and panel views. */
  private headDownRad = COCKPIT_LOOK_DOWN_RAD;
  private headFovDeg = 70;

  constructor(private readonly camera: PerspectiveCamera) {}

  /** `jetPos` / `jetRot`: interpolated render transform; `eye`: pilot's eye in model space; `loadFactor` for the head. */
  update(jetPos: Vector3, jetRot: Quaternion, eye: [number, number, number], loadFactor: number, lengthM: number, dtS: number, focus: CameraFocus = { padlock: null, missile: null }): void {
    const cam = this.camera;
    if (this.mode === 'missile' && focus.missile) {
      // Behind and a little above the missile, looking along its flight.
      const v = this.tmp2.copy(focus.missile.velocity).normalize();
      cam.position.copy(focus.missile.position).addScaledVector(v, -7).add(this.tmp.set(0, 1.2, 0));
      this.look.copy(focus.missile.position).addScaledVector(v, 30);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      cam.fov = 55;
      cam.near = 0.2;
      cam.updateProjectionMatrix();
      return;
    }
    if (this.mode === 'padlock') {
      // From the eye towards the target; with nothing tracked, straight ahead.
      this.tmp.set(eye[0], eye[1], eye[2]).applyQuaternion(jetRot).add(jetPos);
      cam.position.copy(this.tmp);
      this.tmp2.set(0, 1, 0).applyQuaternion(jetRot);
      cam.up.copy(this.tmp2);
      if (focus.padlock) cam.lookAt(focus.padlock);
      else cam.quaternion.copy(jetRot);
      cam.fov = 70;
      cam.near = 0.05;
      cam.updateProjectionMatrix();
      return;
    }
    if (this.first) {
      this.smoothed.copy(jetRot);
      this.first = false;
    }
    this.smoothed.slerp(jetRot, 1 - Math.exp(-CHASE_ATTITUDE_RATE * dtS));
    if (this.mode === 'cockpit' || this.mode === 'panel') {
      // The head sinks a few centimetres per G and the view dips a little (tuned by hand).
      const sag = Math.max(-0.12, Math.min(0.08, -(loadFactor - 1) * 0.012));
      this.tmp.set(eye[0], eye[1] + sag, eye[2]).applyQuaternion(jetRot).add(jetPos);
      cam.position.copy(this.tmp);
      cam.quaternion.copy(jetRot);
      const panel = this.mode === 'panel';
      const k = 1 - Math.exp(-HEAD_RATE * dtS);
      this.headDownRad += ((panel ? PANEL_LOOK_DOWN_RAD : COCKPIT_LOOK_DOWN_RAD) - this.headDownRad) * k;
      this.headFovDeg += ((panel ? PANEL_FOV_DEG : 70) - this.headFovDeg) * k;
      // The default view looks 11° down, as simulators do: on a flat screen the whole panel — displays,
      // keypad, standby instruments — is then in view, while the over-the-nose line and the HUD stay in the
      // upper half. At 6° the panel was a dark strip under the glare shield.
      cam.rotateX(-this.headDownRad - Math.max(0, loadFactor - 1) * 0.15 * DEG);
      cam.fov = this.headFovDeg;
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
      const d = this.chaseDistanceM * 1.2 * this.orbitZoom;
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
