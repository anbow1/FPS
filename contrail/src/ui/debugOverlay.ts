import { PHYSICS } from '../config.ts';
import type { Aircraft } from '../sim/aircraft.ts';
import type { PilotInput } from '../sim/controlLaws.ts';
import { greyOut } from '../sim/gTolerance.ts';

// Text half of the milestone-1 debug overlay: every number the flight model
// runs on, so it can be tuned by watching (brief: "a debug overlay of every
// force"). Toggled with H.

const DEG = 180 / Math.PI;
const KN = 1 / 1000;

export class DebugOverlay {
  private readonly el: HTMLPreElement;
  visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.className = 'debug';
    parent.appendChild(this.el);
  }

  update(ac: Aircraft, input: PilotInput, extra: string): void {
    this.el.style.display = this.visible ? 'block' : 'none';
    if (!this.visible) return;
    const f = ac.forces;
    const len = (v: { x: number; y: number; z: number }): number => Math.hypot(v.x, v.y, v.z) * KN;
    const climb = ac.velocity.y;
    this.el.textContent = [
      `${ac.cfg.name}   mass ${ac.massKg.toFixed(0)} kg   fuel ${ac.fuelKg.toFixed(0)} kg (${(ac.engine.fuelFlowKgS).toFixed(2)} kg/s)`,
      `TAS ${ac.speedMs.toFixed(0)} m/s  M ${ac.mach.toFixed(2)}  alt ${ac.position.y.toFixed(0)} m  climb ${climb.toFixed(0)} m/s  q ${(ac.dynamicPressurePa * KN).toFixed(1)} kPa  ρ ${ac.air.densityKgM3.toFixed(3)}`,
      `AoA ${(ac.alphaRad * DEG).toFixed(1)}°  β ${(ac.betaRad * DEG).toFixed(1)}°  G ${ac.loadFactor.toFixed(2)}  CL ${ac.coeff.lift.toFixed(2)}  CD ${ac.coeff.drag.toFixed(3)}  sep ${(ac.coeff.separation * 100).toFixed(0)} %`,
      `lift ${len(f.lift).toFixed(0)}  drag ${len(f.drag).toFixed(0)}  side ${len(f.side).toFixed(0)}  thrust ${len(f.thrust).toFixed(0)}  weight ${len(f.weight).toFixed(0)} kN`,
      `core ${(ac.engine.core * 100).toFixed(0)} %  burner ${(ac.engine.burner * 100).toFixed(0)} %  throttle ${(input.throttle * 100).toFixed(0)} %`,
      `stick p ${input.pitch.toFixed(2)} r ${input.roll.toFixed(2)} y ${input.yaw.toFixed(2)}  pitch authority ${(ac.controls.pitchAuthority * 100).toFixed(0)} %  limiter ${input.limiterRelaxed ? 'RELAXED' : 'on'}${ac.controls.limiting ? ' (limiting)' : ''}${ac.overstressed ? '  OVERSTRESS' : ''}`,
      `rates p ${(-ac.angular.z * DEG).toFixed(0)} q ${(ac.angular.x * DEG).toFixed(0)} r ${(-ac.angular.y * DEG).toFixed(0)} °/s   G pool ${(ac.g.pool * 100).toFixed(0)} %  grey ${(greyOut(ac.g) * 100).toFixed(0)} %  red ${(ac.g.redOut * 100).toFixed(0)} %${ac.g.glocS > 0 ? '  G-LOC' : ''}`,
      `step ${(PHYSICS.stepSeconds * 1000).toFixed(1)} ms × ${PHYSICS.substeps} substeps   ${extra}`,
    ].join('\n');
  }
}
