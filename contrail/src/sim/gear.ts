import { type AircraftConfig, PHYSICS } from '../config.ts';
import type { Quat } from '../core/quat.ts';
import { Vec3 } from '../core/vec.ts';

// Landing gear: each leg is a spring-damper strut along the body's down axis
// with a wheel at its foot (rules §3: real mass, forces, no vehicle helper).
// Spring rates come from each leg's share of the weight and the static
// compression; damping from a damping ratio. The tyres roll with a small
// resistance, brake on the mains, resist side-slip, and the nose wheel steers
// with the pedals at taxi speed. A touchdown faster than the gear's sink-rate
// limit collapses it; a wingtip, the nose or the tail touching the ground is
// a crash.

export interface GearState {
  /** 1 = down and locked, 0 = up; moves at 1 / cycleS. */
  position: number;
  target: 0 | 1;
  /** Strut compression per leg (m), for the render and the overlay. */
  compression: number[];
  /** Any wheel carrying load this step. */
  weightOnWheels: boolean;
  /** Sink rate at the last touchdown (m/s), for the landing score. */
  touchdownSinkMs: number;
  /** Set on the step a wheel first touched after being airborne. */
  justTouchedDown: boolean;
  collapsed: boolean;
}

export function createGearState(legs: number, down: boolean): GearState {
  return { position: down ? 1 : 0, target: down ? 1 : 0, compression: new Array<number>(legs).fill(0), weightOnWheels: false, touchdownSinkMs: 0, justTouchedDown: false, collapsed: false };
}

export interface GearInputs {
  brake: boolean;
  /** Pedal −1…1 for nose-wheel steering. */
  steer: number;
}

const ROLLING = 0.018; // rolling resistance coefficient of a fighter tyre on concrete (typical 0.015–0.02)
const BRAKE = 0.45; // braking friction coefficient on dry concrete, anti-skid limited
const LATERAL = 0.8; // tyre side-force coefficient at full slip
const HARD_STOP = 5e6; // N/m once a strut bottoms out

const attach = new Vec3();
const wheel = new Vec3();
const arm = new Vec3();
const pointVel = new Vec3();
const fwd = new Vec3();
const side = new Vec3();
const force = new Vec3();
const torque = new Vec3();

/**
 * Adds the gear's world-frame force to `forceOut` and its body-frame moment to
 * `momentOut` for this substep. `groundAt` is the terrain height function.
 */
export function gearForces(
  cfg: AircraftConfig,
  state: GearState,
  position: Vec3,
  velocity: Vec3,
  orientation: Quat,
  angular: Vec3,
  massKg: number,
  inputs: GearInputs,
  groundAt: (x: number, z: number) => number,
  forceOut: Vec3,
  momentOut: Vec3,
): void {
  const g = cfg.gear;
  let loaded = false;
  if (state.position < 0.999 || state.collapsed) {
    state.compression.fill(0);
    state.weightOnWheels = false;
    return;
  }
  for (let i = 0; i < g.legs.length; i++) {
    const leg = g.legs[i]!;
    const k = (leg.loadShare * cfg.mass.referenceMassKg * PHYSICS.gravityMs2) / g.staticCompressionM;
    const c = 2 * g.dampingRatio * Math.sqrt(k * leg.loadShare * massKg);
    // Wheel at full extension, in world.
    wheel.set(leg.x, leg.y - leg.travelM, leg.z);
    arm.copy(wheel);
    orientation.rotate(arm);
    attach.copy(arm).add(position);
    const ground = groundAt(attach.x, attach.z);
    const depth = ground - attach.y;
    if (depth <= 0) {
      state.compression[i] = 0;
      continue;
    }
    // Velocity of the wheel point: v + ω × r (ω in body, so rotate the cross product).
    pointVel.copy(wheel);
    torque.cross(angular, pointVel);
    orientation.rotate(torque);
    pointVel.copy(velocity).add(torque);
    if (!state.weightOnWheels && !loaded) {
      state.touchdownSinkMs = Math.max(0, -pointVel.y);
      state.justTouchedDown = true;
      if (state.touchdownSinkMs > g.maxSinkMs) {
        state.collapsed = true;
        return;
      }
    }
    const compression = Math.min(depth, leg.travelM);
    state.compression[i] = compression;
    let normal = k * compression - c * pointVel.y;
    if (depth > leg.travelM) normal += HARD_STOP * (depth - leg.travelM);
    normal = Math.max(0, normal);
    if (normal > 0) loaded = true;
    // Wheel axes on the ground plane: forward along the nose, steered on the nose leg.
    fwd.set(0, 0, -1);
    orientation.rotate(fwd);
    fwd.y = 0;
    if (fwd.length() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    if (leg.nose) {
      const a = inputs.steer * g.steerRad * (1 - Math.min(1, Math.max(0, (Math.hypot(velocity.x, velocity.z) - 15) / 25)));
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      fwd.set(fwd.x * ca + fwd.z * sa, 0, -fwd.x * sa + fwd.z * ca);
    }
    side.set(-fwd.z, 0, fwd.x);
    const vf = pointVel.dot(fwd);
    const vs = pointVel.dot(side);
    const mu = ROLLING + (inputs.brake && !leg.nose ? BRAKE : 0);
    const fRoll = -clamp(vf / 0.5, -1, 1) * mu * normal;
    const fSide = -clamp(vs / 0.3, -1, 1) * LATERAL * normal;
    force.set(fwd.x * fRoll + side.x * fSide, normal, fwd.z * fRoll + side.z * fSide);
    forceOut.add(force);
    // Moment about the centre of mass, back into body axes.
    torque.cross(arm, force);
    orientation.unrotate(torque);
    momentOut.add(torque);
  }
  state.weightOnWheels = loaded;
}

/** Moves the gear towards its target (blocked while the wheels carry weight). */
export function stepGearCycle(cfg: AircraftConfig, state: GearState, dtS: number): void {
  if (state.weightOnWheels) state.target = 1;
  const rate = dtS / cfg.gear.cycleS;
  state.position += Math.sign(state.target - state.position) * Math.min(Math.abs(state.target - state.position), rate);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
