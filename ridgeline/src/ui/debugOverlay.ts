import { PHYSICS } from '../config.ts';
import type { Helicopter, HeliInput } from '../sim/helicopter.ts';

// The flight model's state as text, for tuning by watching (brief: "Debug
// overlay showing collective, cyclic, pedal, rotor RPM, torque, disc tilt,
// airspeed, vertical speed and the current lift regime. Keep it in the shipped
// build behind a key"). Toggled with H.

const DEG = 180 / Math.PI;

export class DebugOverlay {
  private readonly el: HTMLPreElement;
  visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.className = 'debug';
    parent.appendChild(this.el);
  }

  update(h: Helicopter, pilot: HeliInput, extra: string): void {
    this.el.style.display = this.visible ? 'block' : 'none';
    if (!this.visible) return;
    const r = h.rotor;
    const a = h.applied;
    const pct = (x: number): string => `${(x * 100).toFixed(0).padStart(3)} %`;
    this.el.textContent = [
      `${h.cfg.name}   mass ${h.massKg.toFixed(0)} kg   fuel ${h.fuelKg.toFixed(0)} kg (${(h.engine.fuelFlowKgS * 3600).toFixed(0)} kg/h)   ρ ${h.air.densityKgM3.toFixed(3)}`,
      `regime ${h.regime.toUpperCase()}   TAS ${h.airspeedMs.toFixed(1)} m/s   VS ${h.verticalSpeedMs.toFixed(1)} m/s   RA ${h.radarAltitudeM.toFixed(1)} m   alt ${h.position.y.toFixed(0)} m`,
      `collective ${pct(pilot.collective)}   cyclic x ${pilot.cyclicX.toFixed(2)} y ${pilot.cyclicY.toFixed(2)}   pedal ${pilot.pedal.toFixed(2)}   (applied ${a.cyclicX.toFixed(2)} ${a.cyclicY.toFixed(2)} ${a.pedal.toFixed(2)})`,
      `rotor ${h.rpmPct.toFixed(1)} %   torque ${h.torquePct.toFixed(0)} %   power ${(r.powerW / 1000).toFixed(0)} kW   engines ${(h.engine.powerW / 1000).toFixed(0)} kW ${h.engine.running ? '' : '(OUT)'}`,
      `thrust ${(r.thrustN / 1000).toFixed(1)} kN   weight ${((h.massKg * PHYSICS.gravityMs2) / 1000).toFixed(1)} kN   tail ${(r.tailThrustN / 1000).toFixed(2)} kN   μ ${r.mu.toFixed(3)}   CT/σ ${r.ctSigma.toFixed(3)}   λi ${r.lambdaI.toFixed(4)}`,
      `disc tilt fwd ${(r.tiltFwdRad * DEG).toFixed(1)}° right ${(r.tiltRightRad * DEG).toFixed(1)}°   ground effect ${pct(r.groundEffect)}   ETL ${pct(r.translational)}   VRS ${pct(r.vortexRing)}   stall ${pct(r.bladeStall)}`,
      `rates p ${(-h.angular.z * DEG).toFixed(0)} q ${(h.angular.x * DEG).toFixed(0)} r ${(-h.angular.y * DEG).toFixed(0)} °/s   SAS ${pilot.sas ? 'on' : 'OFF'}   vibration ${pct(h.vibration)}`,
      `step ${(PHYSICS.stepSeconds * 1000).toFixed(1)} ms × ${PHYSICS.substeps} substeps   ${extra}`,
    ].join('\n');
  }
}
