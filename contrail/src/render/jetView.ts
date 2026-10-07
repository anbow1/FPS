import { Quaternion, type Scene, Vector3 } from 'three/webgpu';
import type { AircraftId } from '../config.ts';
import type { Aircraft } from '../sim/aircraft.ts';
import { atmosphereAt } from '../sim/atmosphere.ts';
import type { Atmosphere } from './atmosphere.ts';
import { buildJet, type JetModel, poseGear, poseSurfaces } from './jetModels.ts';
import { CONTRAIL, contrailStrength, Trails, VAPOUR, vapourStrength } from './trails.ts';

// One aircraft on screen — the player's or an opponent's: its model posed from
// the flight model (interpolated between fixed steps), its control surfaces,
// burner, heat and gear, and its contrails and wingtip vapour.

export interface JetViewFrame {
  alpha: number;
  frameS: number;
  clockS: number;
  eye: Vector3;
  humidity: number;
  highQuality: boolean;
}

export class JetView {
  readonly model: JetModel;
  readonly trails: Trails;
  readonly renderPos = new Vector3();
  readonly renderRot = new Quaternion();
  private readonly prevRot = new Quaternion();
  private readonly currRot = new Quaternion();
  private readonly emitters: Vector3[];
  private readonly strengths: number[];
  private readonly air = atmosphereAt(0);

  constructor(
    readonly id: AircraftId,
    scene: Scene,
    atmosphere: Atmosphere,
  ) {
    this.model = buildJet(id);
    scene.add(this.model.root);
    this.trails = new Trails(atmosphere, [...this.model.nozzles.map(() => ({ style: CONTRAIL })), ...this.model.wingtips.map(() => ({ style: VAPOUR }))]);
    scene.add(this.trails.mesh);
    this.emitters = [...this.model.nozzles, ...this.model.wingtips].map(() => new Vector3());
    this.strengths = this.emitters.map(() => 0);
  }

  /** Poses the model and its trails for this frame. */
  update(ac: Aircraft, f: JetViewFrame, visible: boolean): void {
    const p = ac.prevPosition;
    const c = ac.position;
    this.renderPos.set(p.x + (c.x - p.x) * f.alpha, p.y + (c.y - p.y) * f.alpha, p.z + (c.z - p.z) * f.alpha);
    const po = ac.prevOrientation;
    const co = ac.orientation;
    this.prevRot.set(po.x, po.y, po.z, po.w);
    this.currRot.set(co.x, co.y, co.z, co.w);
    this.renderRot.slerpQuaternions(this.prevRot, this.currRot, f.alpha);
    const model = this.model;
    model.root.position.copy(this.renderPos);
    model.root.quaternion.copy(this.renderRot);
    model.root.visible = visible;
    const authority = (m: number, a: number): number => (a > 0 ? m / a : 0);
    const aero = ac.cfg.aero;
    const qS = ac.dynamicPressurePa * aero.wingAreaM2;
    poseSurfaces(model, {
      pitch: authority(ac.controls.pitch, qS * aero.chordM * aero.cmControl + 1),
      roll: authority(ac.controls.roll, qS * aero.spanM * aero.clControl + 1),
      yaw: authority(ac.controls.yaw, qS * aero.spanM * aero.clControl + 1),
      alphaRad: ac.alphaRad,
      gearDown: ac.gear.position > 0.5,
    });
    model.burner.value = ac.crashed ? 0 : ac.engine.burner;
    model.heat.value = ac.crashed ? 0 : Math.min(1, ac.engine.core * 0.7 + ac.engine.burner * 0.6);
    for (const m of model.shimmer) m.visible = f.highQuality && visible;
    poseGear(model, ac.gear.position, ac.gear.compression);
    // Trails: emitter positions from the rendered transform; contrails a little behind the nozzle.
    model.root.updateMatrixWorld();
    atmosphereAt(this.renderPos.y, this.air);
    const thrust = Math.min(1, ac.engine.core + ac.engine.burner * 0.5);
    const nN = model.nozzles.length;
    [...model.nozzles, ...model.wingtips].forEach(([x, y, z], k) => {
      this.emitters[k]!.set(x, y, k < nN ? z + 2 : z);
      model.root.localToWorld(this.emitters[k]!);
      this.strengths[k] = ac.crashed ? 0 : k < nN ? contrailStrength(this.air.temperatureK, f.humidity, thrust) : vapourStrength(ac.loadFactor, ac.speedMs, this.renderPos.y, f.humidity);
    });
    this.trails.update(f.clockS, this.emitters, this.strengths, f.eye);
  }

  reset(): void {
    this.trails.clear();
  }
}
