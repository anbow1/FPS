import { AIRCRAFT, type AircraftConfig, type AircraftId, PHYSICS } from '../config.ts';
import { Quat } from '../core/quat.ts';
import { Vec3 } from '../core/vec.ts';
import { aeroCoefficients, type AeroCoefficients } from './aero.ts';
import { type AirState, atmosphereAt } from './atmosphere.ts';
import { controlMoments, type ControlMoments, type ControlState, naturalMoments, type PilotInput } from './controlLaws.ts';
import { createEngineState, type EngineState, stepEngine } from './engine.ts';
import { createGTolerance, type GTolerance, stepGTolerance } from './gTolerance.ts';

// A six-degree-of-freedom rigid body flown by forces and moments (brief: "forces,
// not tweens"). Body axes follow three.js: x right, y up, z aft (the nose points
// down −z). Each fixed step is split into substeps; per substep:
//   1. air-relative velocity in body axes → AoA, sideslip, Mach, dynamic pressure;
//   2. lift, drag and side force from aero.ts, thrust along the nose, gravity;
//   3. the control laws' moments plus the airframe's natural moments;
//   4. semi-implicit Euler: velocity, then position; angular velocity with the
//      gyroscopic term ω × Iω, then the orientation quaternion.
// Mass and inertia follow the fuel and stores on board.

export interface ForceDebug {
  /** World-frame forces of the last substep (N), for the debug overlay. */
  lift: Vec3;
  drag: Vec3;
  side: Vec3;
  thrust: Vec3;
  weight: Vec3;
}

export class Aircraft {
  readonly cfg: AircraftConfig;
  readonly position = new Vec3();
  /** World velocity (m/s). */
  readonly velocity = new Vec3();
  /** Body → world. */
  readonly orientation = new Quat();
  /** Body angular velocity (rad/s): x = pitch up, y = yaw left, z = roll left (three.js axes). */
  readonly angular = new Vec3();
  readonly prevPosition = new Vec3();
  readonly prevOrientation = new Quat();
  fuelKg: number;
  storesKg: number;
  readonly engine: EngineState = createEngineState();
  readonly g: GTolerance = createGTolerance();
  readonly air: AirState = { temperatureK: 288, pressurePa: 101325, densityKgM3: 1.225, speedOfSoundMs: 340 };
  readonly coeff: AeroCoefficients = { lift: 0, drag: 0, separation: 0 };
  readonly controls: ControlMoments = { pitch: 0, roll: 0, yaw: 0, pitchAuthority: 0, limiting: false };
  readonly forces: ForceDebug = { lift: new Vec3(), drag: new Vec3(), side: new Vec3(), thrust: new Vec3(), weight: new Vec3() };
  /** Telemetry of the last step. */
  speedMs = 0;
  mach = 0;
  alphaRad = 0;
  betaRad = 0;
  loadFactor = 1;
  dynamicPressurePa = 0;
  /** True when the relaxed limiter let the airframe past its design load. */
  overstressed = false;
  crashed = false;

  constructor(id: AircraftId, fuelFraction = 0.6, storesKg = 0) {
    this.cfg = AIRCRAFT[id];
    this.fuelKg = this.cfg.mass.internalFuelKg * fuelFraction;
    this.storesKg = storesKg;
  }

  get massKg(): number {
    return this.cfg.mass.emptyKg + this.fuelKg + this.storesKg;
  }

  /** Places the aircraft in level flight at `speedMs` heading `yawRad`, trimmed for 1 G. */
  placeInFlight(x: number, altitudeM: number, z: number, yawRad: number, speedMs: number): void {
    this.position.set(x, altitudeM, z);
    this.orientation.setFromYawPitchRoll(yawRad, 0, 0);
    this.velocity.set(-Math.sin(yawRad) * speedMs, 0, -Math.cos(yawRad) * speedMs);
    this.angular.set(0, 0, 0);
    this.engine.core = 0.85;
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
    this.crashed = false;
  }

  step(input: PilotInput, dtS: number, groundHeightM: number): void {
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
    if (this.crashed) return;
    const n = PHYSICS.substeps;
    const h = dtS / n;
    for (let i = 0; i < n; i++) this.substep(input, h);
    stepGTolerance(this.g, this.loadFactor, dtS);
    this.fuelKg = Math.max(0, this.fuelKg - this.engine.fuelFlowKgS * dtS);
    if (this.position.y < groundHeightM + 1.5) this.crashed = true;
  }

  private substep(input: PilotInput, h: number): void {
    const cfg = this.cfg;
    const m = this.massKg;
    atmosphereAt(this.position.y, this.air);
    // Air-relative velocity in body axes (still air for now).
    vb.copy(this.velocity);
    this.orientation.unrotate(vb);
    const V = Math.max(vb.length(), 0.1);
    const forward = -vb.z;
    // atan2 keeps the sign right in a tail-slide too (forward < 0).
    this.alphaRad = Math.atan2(-vb.y, forward);
    this.betaRad = Math.asin(clamp(vb.x / V, -1, 1));
    this.speedMs = V;
    this.mach = V / this.air.speedOfSoundMs;
    const q = 0.5 * this.air.densityKgM3 * V * V;
    this.dynamicPressurePa = q;
    const S = cfg.aero.wingAreaM2;

    stepEngine(cfg.engine, this.engine, input.throttle, this.air.densityKgM3, this.mach, this.fuelKg > 0, h);
    aeroCoefficients(cfg.aero, this.alphaRad, this.mach, this.coeff);

    // Forces in body axes.
    vHat.copy(vb).scale(1 / V);
    // Lift: perpendicular to the airflow, in the plane of the body's up axis.
    liftDir.set(0, 1, 0).addScaled(vHat, -vHat.y);
    if (liftDir.length() < 1e-6) liftDir.set(0, 0, -1);
    liftDir.normalize();
    sideDir.set(1, 0, 0).addScaled(vHat, -vHat.x);
    if (sideDir.length() < 1e-6) sideDir.set(1, 0, 0);
    sideDir.normalize();
    fLift.copy(liftDir).scale(this.coeff.lift * q * S);
    fDrag.copy(vHat).scale(-this.coeff.drag * q * S);
    fSide.copy(sideDir).scale(cfg.aero.cyBeta * this.betaRad * q * S);
    fThrust.set(0, 0, -this.engine.thrustN);
    // Load factor: specific force along the body's up axis, in G (what the pilot's seat feels).
    this.loadFactor = (fLift.y + fDrag.y + fSide.y + fThrust.y) / (m * PHYSICS.gravityMs2);

    // Moments.
    const ref = cfg.mass.referenceMassKg;
    const massScale = m / ref;
    inertia.roll = cfg.mass.inertiaRollKgM2 * massScale;
    inertia.pitch = cfg.mass.inertiaPitchKgM2 * massScale;
    inertia.yaw = cfg.mass.inertiaYawKgM2 * massScale;
    upW.set(0, 1, 0);
    this.orientation.unrotate(upW); // world up in body axes
    cs.speedMs = V;
    cs.dynamicPressurePa = q;
    cs.alphaRad = this.alphaRad;
    cs.betaRad = this.betaRad;
    cs.loadFactor = this.loadFactor;
    cs.upDotWorldUp = upW.y;
    // Coordinated turn: yaw rate g·sin(bank)/V about the body yaw axis.
    cs.coordinatedYawRateRadS = (PHYSICS.gravityMs2 * -upW.x) / Math.max(V, 30);
    cs.pitchRate = this.angular.x;
    cs.rollRate = -this.angular.z;
    cs.yawRate = -this.angular.y;
    cs.thrustN = this.engine.thrustN;
    cs.massKg = m;
    controlMoments(cfg, input, cs, inertia, this.controls);
    naturalMoments(cfg, cs, nat);
    const Mx = this.controls.pitch + nat.pitch;
    const Mz = -(this.controls.roll + nat.roll);
    const My = -(this.controls.yaw + nat.yaw);

    // Translate: body forces to world, plus gravity.
    total.copy(fLift).add(fDrag).add(fSide).add(fThrust);
    this.orientation.rotate(total);
    total.y -= m * PHYSICS.gravityMs2;
    this.velocity.addScaled(total, h / m);
    this.position.addScaled(this.velocity, h);

    // Rotate: Euler's equations in body axes, I·ω̇ = M − ω × Iω.
    const wx = this.angular.x;
    const wy = this.angular.y;
    const wz = this.angular.z;
    const Ix = inertia.pitch;
    const Iy = inertia.yaw;
    const Iz = inertia.roll;
    const ax = (Mx - (wy * Iz * wz - wz * Iy * wy)) / Ix;
    const ay = (My - (wz * Ix * wx - wx * Iz * wz)) / Iy;
    const az = (Mz - (wx * Iy * wy - wy * Ix * wx)) / Iz;
    this.angular.set(wx + ax * h, wy + ay * h, wz + az * h);
    this.orientation.integrateBodyRate(this.angular.x, this.angular.y, this.angular.z, h);
    this.overstressed = this.loadFactor > cfg.limiter.gMax + 0.5;

    // Debug: world-frame copies.
    this.forces.lift.copy(fLift);
    this.orientation.rotate(this.forces.lift);
    this.forces.drag.copy(fDrag);
    this.orientation.rotate(this.forces.drag);
    this.forces.side.copy(fSide);
    this.orientation.rotate(this.forces.side);
    this.forces.thrust.copy(fThrust);
    this.orientation.rotate(this.forces.thrust);
    this.forces.weight.set(0, -m * PHYSICS.gravityMs2, 0);
  }
}

// Scratch (rules §10: no allocation in the step).
const vb = new Vec3();
const vHat = new Vec3();
const liftDir = new Vec3();
const sideDir = new Vec3();
const fLift = new Vec3();
const fDrag = new Vec3();
const fSide = new Vec3();
const fThrust = new Vec3();
const total = new Vec3();
const upW = new Vec3();
const inertia = { roll: 1, pitch: 1, yaw: 1 };
const nat = { pitch: 0, roll: 0, yaw: 0 };
const cs: ControlState = {
  speedMs: 0,
  dynamicPressurePa: 0,
  alphaRad: 0,
  betaRad: 0,
  loadFactor: 1,
  upDotWorldUp: 1,
  coordinatedYawRateRadS: 0,
  pitchRate: 0,
  rollRate: 0,
  yawRate: 0,
  thrustN: 0,
  massKg: 1,
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
