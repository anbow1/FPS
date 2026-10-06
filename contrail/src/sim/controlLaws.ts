import type { AircraftConfig } from '../config.ts';

// Fly-by-wire control laws, by dynamic inversion: each axis turns the pilot's
// stick into a wanted angular acceleration, subtracts what the airframe's own
// aerodynamics already supply, and asks the control surfaces (and the
// vectoring nozzles, where fitted) for the rest — clamped to what they can
// actually produce at this dynamic pressure. So the controls go soft at low
// speed and stiff at high speed by themselves, and the limiter is a ceiling on
// the command, not a fudge on the response.
//
//   pitch: stick → load-factor command (−3 … +9 G hands-off 1 G), capped by
//          the AoA limit and a pitch-rate ceiling;
//   roll:  stick → roll-rate command, washed out at high AoA;
//   yaw:   pedals → sideslip command plus turn coordination.
//
// Gains tuned by hand at 60 Hz × 4 substeps: crisp, no overshoot past the
// limits at corner speed.

export interface PilotInput {
  /** −1 … 1, positive = pull (nose up). */
  pitch: number;
  /** −1 … 1, positive = roll right. */
  roll: number;
  /** −1 … 1, positive = nose right. */
  yaw: number;
  /** 0 … 1 dry, 1 … 1.25 afterburner. */
  throttle: number;
  /** Relaxes the G and AoA limits (overstress possible). */
  limiterRelaxed: boolean;
}

export function neutralInput(): PilotInput {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, limiterRelaxed: false };
}

/** What the control laws see of the flight state (body axes: x right, y up, z aft). */
export interface ControlState {
  speedMs: number;
  dynamicPressurePa: number;
  alphaRad: number;
  betaRad: number;
  /** Load factor along the body's up axis (G). */
  loadFactor: number;
  /** cos of the angle between the body up axis and world up: the 1 G share the pitch law must hold. */
  upDotWorldUp: number;
  /** Bank-induced turn rate the yaw law coordinates to (rad/s). */
  coordinatedYawRateRadS: number;
  /** Body rates: pitch (nose up +), roll (right +), yaw (nose right +), rad/s. */
  pitchRate: number;
  rollRate: number;
  yawRate: number;
  thrustN: number;
  massKg: number;
}

/** Control moments the laws ask for, in the same pitch/roll/yaw sense as the rates (N·m). */
export interface ControlMoments {
  pitch: number;
  roll: number;
  yaw: number;
  /** Fraction of the available pitch authority in use (0 … 1), for the debug overlay. */
  pitchAuthority: number;
  /** The command was clipped by the AoA or G limit this step. */
  limiting: boolean;
}

const GRAVITY = 9.81;
const K_LOAD = 1.6; // rad/s per G of load-factor error, fed into the pitch-rate command
const K_PITCH = 7; // 1/s, pitch-rate loop
const K_ALPHA = 5; // 1/s, AoA limiter
const K_ROLL = 9; // 1/s, roll-rate loop
const K_YAW = 5; // 1/s, yaw-rate loop
const K_BETA = 6; // 1/s², sideslip loop
const MAX_SIDESLIP_RAD = (8 * Math.PI) / 180;
const MIN_AOA_RAD = (-15 * Math.PI) / 180;

/**
 * Natural aerodynamic moments of the airframe (pitch, roll, yaw senses as above):
 * static stability, damping and dihedral. The control laws subtract these.
 */
export function naturalMoments(cfg: AircraftConfig, s: ControlState, out: { pitch: number; roll: number; yaw: number }): void {
  const a = cfg.aero;
  const qS = s.dynamicPressurePa * a.wingAreaM2;
  const v = Math.max(s.speedMs, 1);
  const alpha = clamp(s.alphaRad, -0.6, 0.6); // stability derivatives stop meaning much in deep stall
  out.pitch = qS * a.chordM * (a.cmAlpha * alpha + a.cmq * ((s.pitchRate * a.chordM) / (2 * v)));
  out.roll = qS * a.spanM * (a.clp * ((s.rollRate * a.spanM) / (2 * v)) + a.clBeta * s.betaRad);
  out.yaw = qS * a.spanM * (a.cnBeta * s.betaRad + a.cnr * ((s.yawRate * a.spanM) / (2 * v)));
}

const natural = { pitch: 0, roll: 0, yaw: 0 };

export function controlMoments(cfg: AircraftConfig, input: PilotInput, s: ControlState, inertia: { roll: number; pitch: number; yaw: number }, out: ControlMoments): void {
  const lim = cfg.limiter;
  const a = cfg.aero;
  const qS = s.dynamicPressurePa * a.wingAreaM2;
  const v = Math.max(s.speedMs, 20);
  naturalMoments(cfg, s, natural);
  const gMax = input.limiterRelaxed ? lim.relaxedGMax : lim.gMax;
  const aoaMax = input.limiterRelaxed ? lim.relaxedAoaMaxRad : lim.aoaMaxRad;

  // ---- pitch
  const stick = clamp(input.pitch, -1, 1);
  const gCmd = stick >= 0 ? 1 + stick * (gMax - 1) : 1 + -stick * (lim.gMin - 1);
  // Steady pitch rate for that load factor in this attitude, plus a correction on the error.
  let qCmd = (GRAVITY * (gCmd - s.upDotWorldUp)) / v + K_LOAD * ((gCmd - s.loadFactor) * GRAVITY) / v;
  qCmd = clamp(qCmd, -lim.pitchRateMaxRadS, lim.pitchRateMaxRadS);
  let limiting = false;
  const alphaCeiling = K_ALPHA * (aoaMax - s.alphaRad);
  if (qCmd > alphaCeiling) {
    qCmd = alphaCeiling;
    limiting = true;
  }
  const alphaFloor = K_ALPHA * (MIN_AOA_RAD - s.alphaRad);
  if (qCmd < alphaFloor) {
    qCmd = alphaFloor;
    limiting = true;
  }
  if (s.loadFactor > gMax && qCmd > s.pitchRate) limiting = true;
  const vectorMoment = cfg.engine.vectorRad > 0 ? s.thrustN * Math.sin(cfg.engine.vectorRad) * cfg.engine.vectorArmM : 0;
  const pitchAvail = qS * a.chordM * a.cmControl + vectorMoment;
  const pitchWanted = inertia.pitch * K_PITCH * (qCmd - s.pitchRate) - natural.pitch;
  out.pitch = clamp(pitchWanted, -pitchAvail, pitchAvail);
  out.pitchAuthority = pitchAvail > 0 ? Math.min(1, Math.abs(pitchWanted) / pitchAvail) : 1;

  // ---- roll: full rate at low AoA, washed out toward the AoA limit (departure resistance).
  const rollWash = 1 - 0.65 * clamp(s.alphaRad / Math.max(aoaMax, 0.1), 0, 1);
  const pCmd = clamp(input.roll, -1, 1) * lim.rollRateMaxRadS * rollWash;
  const rollAvail = qS * a.spanM * a.clControl + vectorMoment * 0.15;
  out.roll = clamp(inertia.roll * K_ROLL * (pCmd - s.rollRate) - natural.roll, -rollAvail, rollAvail);

  // ---- yaw: pedals command sideslip; the bank's turn rate is coordinated automatically.
  const betaCmd = clamp(input.yaw, -1, 1) * MAX_SIDESLIP_RAD;
  const yawAccel = K_YAW * (s.coordinatedYawRateRadS - s.yawRate) + K_BETA * (s.betaRad - betaCmd);
  const yawAvail = qS * a.spanM * a.cnControl + vectorMoment * 0.6;
  out.yaw = clamp(inertia.yaw * yawAccel - natural.yaw, -yawAvail, yawAvail);
  out.limiting = limiting;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
