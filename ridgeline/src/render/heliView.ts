import { Quaternion, type Scene, Vector3 } from 'three/webgpu';
import type { HeliId } from '../config.ts';
import type { Helicopter } from '../sim/helicopter.ts';
import { buildHeli, type HeliModel } from './heliModel.ts';

// A helicopter on screen: the model placed at the simulation state interpolated
// between fixed steps (rules §3), the disc tilted by the flapping state, and the
// rotors turned by their own speed — integrated per rendered frame, so the blade
// smear always matches the frame's real exposure.

/** Tail rotor speed over main rotor speed (a fixed gearbox ratio). */
const TAIL_RATIO = 4.7;

export class HeliView {
  readonly model: HeliModel;
  readonly renderPos = new Vector3();
  readonly renderRot = new Quaternion();
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();
  private angle = 0;
  private tail = 0;

  constructor(id: HeliId, scene: Scene) {
    this.model = buildHeli(id);
    scene.add(this.model.root);
  }

  /** Which seat the camera is in: that crew member is hidden and the canopy glass goes nearly clear. */
  setSeat(seat: 'pilot' | 'gunner' | null): void {
    const m = this.model;
    m.pilotFigure.visible = seat !== 'pilot';
    m.gunnerFigure.visible = seat !== 'gunner';
    m.glass.opacity = seat ? 0.1 : 0.6;
  }

  update(h: Helicopter, alpha: number, frameS: number, visible: boolean): void {
    const p = h.prevPosition;
    const c = h.position;
    this.renderPos.set(p.x + (c.x - p.x) * alpha, p.y + (c.y - p.y) * alpha, p.z + (c.z - p.z) * alpha);
    this.qa.set(h.prevOrientation.x, h.prevOrientation.y, h.prevOrientation.z, h.prevOrientation.w);
    this.qb.set(h.orientation.x, h.orientation.y, h.orientation.z, h.orientation.w);
    this.renderRot.slerpQuaternions(this.qa, this.qb, alpha);
    const m = this.model;
    m.root.visible = visible;
    m.root.position.copy(this.renderPos);
    m.root.quaternion.copy(this.renderRot);
    // Disc tilt (forward tilt = rotation about +x by −tilt; right tilt = rotation about +z by −tilt).
    m.rotor.rotation.set(-h.rotor.tiltFwdRad, 0, -h.rotor.tiltRightRad, 'XZY');
    const omega = h.rotor.omegaRadS;
    const dir = h.cfg.rotor.direction;
    const dt = Math.min(frameS, 0.1);
    this.angle = (this.angle + omega * dt) % (Math.PI * 2);
    this.tail = (this.tail + omega * TAIL_RATIO * dt) % (Math.PI * 2);
    // Blades on the CPU while they can be followed; the smear disc takes over from ~40 % rotor speed.
    const frac = omega / h.cfg.rotor.omegaRadS;
    const blend = Math.min(1, Math.max(0, (frac - 0.3) / 0.25));
    m.discBlend.value = blend;
    for (const mat of m.bladeMaterials) {
      mat.opacity = 1 - blend;
      mat.visible = blend < 0.999;
    }
    m.bladeHub.rotation.y = this.angle * dir;
    m.tailHub.rotation.y = this.tail;
    m.rotorAngle.value = this.angle;
    m.tailAngle.value = this.tail;
    // The exposure: one frame's sweep (at least a few degrees so a still frame still shows motion).
    m.rotorSmear.value = Math.max(0.05, Math.min(Math.PI * 0.45, omega * dt));
    m.tailSmear.value = Math.max(0.05, Math.min(Math.PI * 0.8, omega * TAIL_RATIO * dt));
  }
}
