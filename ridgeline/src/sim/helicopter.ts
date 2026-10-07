import { type HeliConfig, PHYSICS } from '../config.ts';
import { Quat } from '../core/quat.ts';
import { clamp, smoothstep, Vec3 } from '../core/vec.ts';
import { type AirState, atmosphereAt } from './atmosphere.ts';

// A helicopter built from its rotor (brief: "not a plane with vertical thrust").
//
// Main rotor: thrust from blade-element theory with uniform inflow,
//   CT = σa/2 · [θ₇₅ (1/3 + μ²/2) − λ/2],
// and the inflow from momentum theory (Glauert), λ = λc + λi with
//   λi = CT / (2 √(μ² + λ²)),
// solved by relaxation each substep. Everything the brief asks for falls out of
// that pair, or sits on top of it:
//   translational lift  as μ grows the induced inflow collapses, so the same
//                       collective makes more thrust — the surge out of a hover;
//   ground effect       Cheeseman–Bennett: λi × (1 − (R/4z)²) near the ground,
//                       fading with speed as the wake blows clear;
//   power and torque    P = κ·T·vi + T·vc + profile power (1 + 4.65 μ²); the
//                       engines hold rotor speed through a governor, the rotor
//                       has inertia, so a snatched collective droops the RPM;
//   autorotation        with the engines off, air coming up through the disc
//                       (λ < 0) drives the rotor instead of braking it;
//   vortex ring state   momentum theory has no answer there: an empirical
//                       thrust loss and rocking when sinking at 0.3–1.6 × the
//                       hover induced velocity with little forward speed — and
//                       worse with more collective, so the cure is forward cyclic;
//   blade stall         the retreating blade stalls past ~μ 0.35 (less when
//                       heavily loaded): thrust loss, pitch-up, a roll towards
//                       the retreating side, and vibration first.
// The disc tilts with cyclic through a first-order flapping lag, blows back
// with speed (speed stability), and stays put in space for a moment when the
// body rotates — that lag is the rotor's damping. Its thrust acts at the hub
// above the CG, plus a hub spring moment for the offset hinges.
//
// Tail rotor: thrust from pedal pitch, ∝ ρ Ω², pushing the tail against the
// main rotor's torque. Collective changes the torque, so the nose swings until
// the pedals follow — "the whole feel of the machine". Its thrust also pushes
// the whole aircraft sideways (the drift a hover needs a little cyclic for).
//
// Body axes are three.js': x right, y up, −z forward. Angular rates: x pitch up,
// y yaw left, z roll left.

export interface HeliInput {
  /** Collective lever 0…1. */
  collective: number;
  /** Cyclic, −1…1: x right, y pull (nose up). */
  cyclicX: number;
  cyclicY: number;
  /** Pedals −1 (left) … 1 (right). */
  pedal: number;
  /** Stability augmentation: rate damping in all three axes. */
  sas: boolean;
  engines: boolean;
  brake: boolean;
}

export function neutralHeliInput(): HeliInput {
  return { collective: 0, cyclicX: 0, cyclicY: 0, pedal: 0, sas: true, engines: true, brake: true };
}

export type LiftRegime = 'ground' | 'hover IGE' | 'hover OGE' | 'transition' | 'forward' | 'vortex ring' | 'blade stall' | 'autorotation';

export interface RotorState {
  omegaRadS: number;
  /** Disc tilt relative to the shaft (rad): forward (+ = thrust forward) and right. */
  tiltFwdRad: number;
  tiltRightRad: number;
  /** Induced inflow ratio, carried between substeps as the relaxation's start. */
  lambdaI: number;
  thrustN: number;
  /** Shaft torque the rotor demands (N·m) and the power (W). */
  torqueNm: number;
  powerW: number;
  /** Advance ratio μ, thrust coefficient over solidity. */
  mu: number;
  ctSigma: number;
  tailThrustN: number;
  /** 0…1 strengths of the effects, for the debug page, warnings and shake. */
  groundEffect: number;
  vortexRing: number;
  bladeStall: number;
  translational: number;
}

export interface EngineState {
  running: boolean;
  /** Power delivered to the transmission (W). */
  powerW: number;
  fuelFlowKgS: number;
}

const scratch = { v: new Vec3(), n: new Vec3(), f: new Vec3(), m: new Vec3(), r: new Vec3(), w: new Vec3(), t: new Vec3() };

export class Helicopter {
  readonly position = new Vec3();
  readonly velocity = new Vec3();
  readonly orientation = new Quat();
  /** Body angular velocity (rad/s): x pitch up, y yaw left, z roll left. */
  readonly angular = new Vec3();
  readonly prevPosition = new Vec3();
  readonly prevOrientation = new Quat();
  readonly rotor: RotorState;
  readonly engine: EngineState = { running: true, powerW: 0, fuelFlowKgS: 0 };
  readonly air: AirState = { temperatureK: 288, pressurePa: 101_325, densityKgM3: 1.225, speedOfSoundMs: 340 };
  fuelKg: number;
  storesKg: number;
  /** Controls as the rotor sees them (after the stability augmentation). */
  readonly applied: HeliInput = neutralHeliInput();
  // Telemetry of the last step.
  airspeedMs = 0;
  verticalSpeedMs = 0;
  /** Height of the wheels above the ground below (m). */
  radarAltitudeM = 0;
  regime: LiftRegime = 'ground';
  /** 0…1 airframe vibration (blade stall, vortex ring, translational buffet) for the camera and the warnings. */
  vibration = 0;
  /** Torque as a percentage of the transmission rating, rotor speed as a percentage of 100 %. */
  torquePct = 0;
  rpmPct = 100;
  onGround = true;
  crashed = false;
  /** Vertical speed at the last touchdown (m/s, positive down). */
  touchdownSinkMs = 0;
  private wasOnGround = true;
  private shakePhase = 0;

  constructor(readonly cfg: HeliConfig) {
    this.fuelKg = cfg.fuelKg;
    this.storesKg = cfg.storesKg;
    this.rotor = {
      omegaRadS: cfg.rotor.omegaRadS,
      tiltFwdRad: 0,
      tiltRightRad: 0,
      lambdaI: 0.05,
      thrustN: 0,
      torqueNm: 0,
      powerW: 0,
      mu: 0,
      ctSigma: 0,
      tailThrustN: 0,
      groundEffect: 0,
      vortexRing: 0,
      bladeStall: 0,
      translational: 0,
    };
  }

  get massKg(): number {
    return this.cfg.emptyMassKg + this.fuelKg + this.storesKg;
  }

  get solidity(): number {
    const r = this.cfg.rotor;
    return (r.blades * r.chordM) / (Math.PI * r.radiusM);
  }

  get discAreaM2(): number {
    return Math.PI * this.cfg.rotor.radiusM ** 2;
  }

  /** Parked on the ground at (x, z) facing `yawRad`, engines at flight idle, rotor at 100 %. */
  placeOnGround(x: number, z: number, yawRad: number, groundY: number): void {
    const lowest = Math.min(...this.cfg.wheels.map((w) => w[1]));
    this.position.set(x, groundY - lowest + 0.02, z);
    this.orientation.setFromYawPitchRoll(yawRad, 0, 0);
    this.reset();
    this.onGround = this.wasOnGround = true;
  }

  /** In a steady hover or flight at `altitudeM` with the given speed along the heading. */
  placeInFlight(x: number, altitudeM: number, z: number, yawRad: number, speedMs: number): void {
    this.position.set(x, altitudeM, z);
    this.orientation.setFromYawPitchRoll(yawRad, 0, 0);
    this.reset();
    this.velocity.set(-Math.sin(yawRad) * speedMs, 0, -Math.cos(yawRad) * speedMs);
    this.onGround = this.wasOnGround = false;
  }

  private reset(): void {
    this.velocity.set(0, 0, 0);
    this.angular.set(0, 0, 0);
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
    this.rotor.omegaRadS = this.cfg.rotor.omegaRadS;
    this.rotor.tiltFwdRad = this.rotor.tiltRightRad = 0;
    this.rotor.lambdaI = 0.05;
    this.engine.running = true;
    this.engine.powerW = 0;
    this.crashed = false;
  }

  /** One fixed step: `groundAt(x, z)` gives the surface height (terrain or water). */
  step(input: HeliInput, groundAt: (x: number, z: number) => number, dtS = PHYSICS.stepSeconds): void {
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
    if (this.crashed) return;
    const h = dtS / PHYSICS.substeps;
    for (let i = 0; i < PHYSICS.substeps; i++) this.substep(input, groundAt, h);
    // Telemetry.
    this.airspeedMs = this.velocity.length();
    this.verticalSpeedMs = this.velocity.y;
    const lowest = Math.min(...this.cfg.wheels.map((w) => w[1]));
    this.radarAltitudeM = Math.max(0, this.position.y + lowest - groundAt(this.position.x, this.position.z));
    this.rpmPct = (this.rotor.omegaRadS / this.cfg.rotor.omegaRadS) * 100;
    const q100 = this.cfg.transmissionW / this.cfg.rotor.omegaRadS;
    this.torquePct = (Math.max(0, this.rotor.torqueNm) / q100) * 100;
    const r = this.rotor;
    this.regime = this.onGround
      ? 'ground'
      : !this.engine.running && r.omegaRadS > 0.5 * this.cfg.rotor.omegaRadS
        ? 'autorotation'
        : r.bladeStall > 0.3
          ? 'blade stall'
          : r.vortexRing > 0.3
            ? 'vortex ring'
            : this.airspeedMs < 8
              ? r.groundEffect > 0.1
                ? 'hover IGE'
                : 'hover OGE'
              : this.airspeedMs < 20
                ? 'transition'
                : 'forward';
  }

  private substep(input: HeliInput, groundAt: (x: number, z: number) => number, h: number): void {
    const cfg = this.cfg;
    const rc = cfg.rotor;
    const r = this.rotor;
    const q = this.orientation;
    const w = this.angular;
    atmosphereAt(this.position.y, this.air);
    const rho = this.air.densityKgM3;
    const m = this.massKg;

    // ---- stability augmentation: rate damping with limited authority, summed into the controls
    const a = this.applied;
    Object.assign(a, input);
    if (input.sas) {
      a.cyclicY = input.cyclicY - clamp(w.x * 0.9, -0.18, 0.18);
      a.cyclicX = input.cyclicX + clamp(w.z * 0.5, -0.18, 0.18);
      a.pedal = input.pedal + clamp(w.y * 1.6, -0.3, 0.3);
    }
    a.cyclicX = clamp(a.cyclicX, -1, 1);
    a.cyclicY = clamp(a.cyclicY, -1, 1);
    a.pedal = clamp(a.pedal, -1, 1);

    // ---- air velocity at the hub in body axes (the aircraft's velocity through still air)
    const vb = q.unrotate(scratch.v.copy(this.velocity));
    const R = rc.radiusM;
    const tip = r.omegaRadS * R;
    const sigma = this.solidity;
    const A = this.discAreaM2;

    // ---- flapping: the disc chases the stick, blows back with speed, lags the body's rotation
    const theta = rc.collectiveMinRad + clamp(a.collective, 0, 1) * (rc.collectiveMaxRad - rc.collectiveMinRad);
    const muFwd = -vb.z / Math.max(tip, 1);
    const muSide = vb.x / Math.max(tip, 1);
    const lambdaPrev = r.lambdaI;
    // Blowback a₁ ≈ 2μ(4θ/3 − λ) / (1 − μ²/2): the advancing blade's extra lift flaps the disc back (and away from a sideways wind).
    const blow = (mu: number): number => (2 * mu * ((4 * theta) / 3 - lambdaPrev)) / (1 - (mu * mu) / 2);
    const targetFwd = -a.cyclicY * rc.cyclicLongRad - blow(muFwd);
    const targetRight = a.cyclicX * rc.cyclicLatRad - blow(muSide);
    const omegaFrac = r.omegaRadS / rc.omegaRadS;
    // A slow rotor flaps sluggishly (the restoring centrifugal stiffness goes with Ω²).
    const lag = rc.flapLagS / Math.max(0.3, omegaFrac);
    r.tiltFwdRad += ((targetFwd - r.tiltFwdRad) / lag + w.x) * h;
    r.tiltRightRad += ((targetRight - r.tiltRightRad) / lag + w.z) * h;
    r.tiltFwdRad = clamp(r.tiltFwdRad, -0.3, 0.3);
    r.tiltRightRad = clamp(r.tiltRightRad, -0.3, 0.3);
    const n = scratch.n.set(Math.tan(r.tiltRightRad), 1, -Math.tan(r.tiltFwdRad)).normalize();

    // ---- inflow and thrust
    const vn = vb.dot(n); // + when air passes down through the disc (climbing, or a forward-tilted disc moving forward)
    const vInPlane = Math.sqrt(Math.max(0, vb.dot(vb) - vn * vn));
    const mu = vInPlane / Math.max(tip, 1);
    const lambdaC = vn / Math.max(tip, 1);
    // Ground effect from the hub height over the surface below it (water counts).
    const hub = q.rotate(scratch.r.set(0, rc.hubHeightM, 0)).add(this.position);
    const z = Math.max(0.1, hub.y - groundAt(hub.x, hub.z));
    const vh0 = Math.sqrt((m * PHYSICS.gravityMs2) / (2 * rho * A));
    const geRaw = z < 4 * R ? Math.min(0.42, (R / (4 * Math.max(z, R / 4))) ** 2) : 0;
    const ge = geRaw / (1 + (vInPlane / (1.2 * vh0)) ** 2);
    const lambdaH = Math.sqrt(Math.max(1e-6, (m * PHYSICS.gravityMs2) / (rho * A * tip * tip)) / 2);
    let li = r.lambdaI;
    let ct = 0;
    for (let k = 0; k < 6; k++) {
      ct = ((sigma * rc.liftSlope) / 2) * (theta * (1 / 3 + (mu * mu) / 2) - (lambdaC + li) / 2);
      const lam = lambdaC + li;
      // The floor stands in for momentum theory's breakdown near λ = 0 (the vortex ring region has its own model below).
      const denom = 2 * Math.max(Math.sqrt(mu * mu + lam * lam), 0.6 * lambdaH);
      const target = (Math.max(ct, 0) / denom) * (1 - ge);
      li += (target - li) * 0.5;
    }
    r.lambdaI = li;
    const lambda = lambdaC + li;
    let thrust = ct * rho * A * tip * tip;

    // ---- vortex ring state: sinking into the own wake at low speed
    const vh = Math.max(4, li * tip);
    const sink = -vn / vh0;
    const vrs = smoothstep(0.25, 0.6, sink) * (1 - smoothstep(1.2, 1.7, sink)) * (1 - smoothstep(0.35, 0.8, vInPlane / vh0));
    r.vortexRing = vrs;
    // Worse with power: more collective feeds the recirculating ring.
    thrust *= 1 - vrs * (0.22 + 0.25 * clamp(a.collective, 0, 1));

    // ---- retreating blade stall
    r.ctSigma = ct / sigma;
    const muStall = 0.36 - 1.6 * Math.max(0, r.ctSigma - 0.08);
    const rbs = smoothstep(muStall - 0.03, muStall + 0.05, mu);
    r.bladeStall = rbs;
    thrust *= 1 - 0.25 * rbs;
    r.thrustN = Math.max(0, thrust);
    r.mu = mu;
    r.groundEffect = ge;
    r.translational = smoothstep(0.4, 1.4, vInPlane / vh0);

    // ---- power: induced (with the climb term inside λ) + profile; stall and the ring cost more
    const P0 = ((sigma * rc.cd0) / 8) * (1 + 4.65 * mu * mu) * rho * A * tip ** 3 * (1 + 1.5 * rbs);
    const Pi = rc.inducedFactor * r.thrustN * li * tip + r.thrustN * lambdaC * tip;
    const Pmain = Pi + P0 + vrs * 0.15 * r.thrustN * vh;

    // ---- tail rotor: pedal pitch → thrust ∝ ρΩ²; it needs power too (momentum theory, ×1.2)
    const t = cfg.tail;
    const pitch = t.pitchLeft + ((a.pedal + 1) / 2) * (t.pitchRight - t.pitchLeft);
    const tailT = t.maxThrustN * pitch * (rho / 1.225) * omegaFrac * omegaFrac;
    r.tailThrustN = tailT;
    const Atr = Math.PI * t.radiusM ** 2;
    const Ptail = (1.2 * Math.abs(tailT) ** 1.5) / Math.sqrt(2 * rho * Atr) + 0.02 * Pmain;

    const Preq = Pmain + Ptail;
    r.powerW = Preq;
    r.torqueNm = Pmain / Math.max(r.omegaRadS, 1);

    // ---- engines and governor: feed-forward on demand plus a proportional trim on rotor speed
    const e = this.engine;
    e.running = input.engines && this.fuelKg > 0;
    const available = e.running ? cfg.engines * cfg.enginePowerW * Math.pow(rho / 1.225, 0.8) : 0;
    const govTarget = clamp(Preq + (rc.omegaRadS - r.omegaRadS) * rc.inertiaKgM2 * rc.omegaRadS * 2.5, 0, available);
    e.powerW += (govTarget - e.powerW) * Math.min(1, h / cfg.engineLagS);
    if (!e.running) e.powerW = Math.max(0, e.powerW - cfg.engines * cfg.enginePowerW * h * 2);
    e.fuelFlowKgS = e.running ? (e.powerW + 0.08 * available) * cfg.sfcKgJ : 0;
    this.fuelKg = Math.max(0, this.fuelKg - e.fuelFlowKgS * h);
    // Rotor speed: the imbalance of power over the rotor's angular momentum. Autorotation is Pmain < 0.
    r.omegaRadS += ((e.powerW - Preq - 15_000) / (rc.inertiaKgM2 * Math.max(r.omegaRadS, 3))) * h;
    r.omegaRadS = clamp(r.omegaRadS, 0, rc.omegaRadS * 1.25);
    void lambda;

    // ---- forces and moments in body axes
    const F = scratch.f.set(0, 0, 0);
    const M = scratch.m.set(0, 0, 0);
    const addForceAt = (fx: number, fy: number, fz: number, px: number, py: number, pz: number): void => {
      F.x += fx;
      F.y += fy;
      F.z += fz;
      M.x += py * fz - pz * fy;
      M.y += pz * fx - px * fz;
      M.z += px * fy - py * fx;
    };
    addForceAt(n.x * r.thrustN, n.y * r.thrustN, n.z * r.thrustN, 0, rc.hubHeightM, 0);
    // Offset hinges: a moment straight from the disc tilt (nose-down for a forward tilt, roll towards the tilt).
    const hubK = rc.hubStiffnessNmRad * omegaFrac * omegaFrac;
    M.x -= hubK * r.tiltFwdRad;
    M.z -= hubK * r.tiltRightRad;
    // Torque reaction on the airframe, against the rotor's turning (CCW rotor → nose right).
    M.y -= rc.direction * r.torqueNm;
    // Blade stall: pitch-up and a roll towards the retreating side.
    M.x += rbs * 0.3 * r.thrustN * 0.6;
    M.z += rc.direction * rbs * 0.3 * r.thrustN * 0.8;
    // Vortex ring: the disc rocks as the wake recirculates.
    this.shakePhase += h * 9;
    const rock = vrs * 0.08 * r.thrustN;
    M.x += rock * Math.sin(this.shakePhase * 1.3) * 0.8;
    M.z += rock * Math.sin(this.shakePhase * 0.9 + 1.7);
    addForceAt(tailT, 0, 0, 0, t.heightM, t.armM);

    // Fuselage drag (flat-plate areas per body axis) — the vertical one includes the rotor wash on the airframe.
    const [fxA, fyA, fzA] = cfg.dragAreaM2;
    F.x -= 0.5 * rho * fxA * vb.x * Math.abs(vb.x);
    F.y -= 0.5 * rho * fyA * vb.y * Math.abs(vb.y);
    F.z -= 0.5 * rho * fzA * vb.z * Math.abs(vb.z);
    // Fin: side lift against sideslip (weathervane), plus camber that unloads the tail rotor at speed.
    const fwd = Math.max(0, -vb.z);
    const qFin = 0.5 * rho * (fwd * fwd + vb.x * vb.x);
    const beta = Math.atan2(vb.x, Math.max(fwd, 1));
    const finLift = qFin * cfg.finAreaM2 * (-3.5 * clamp(beta, -0.5, 0.5) + cfg.finCamber * smoothstep(10, 40, fwd));
    addForceAt(finLift, 0, 0, 0, 1.2, cfg.finArmM);
    // Stabilator: pitch stiffness with angle of attack at speed.
    const alpha = Math.atan2(-vb.y, Math.max(fwd, 1));
    const stabLift = qFin * cfg.stabAreaM2 * 3.5 * clamp(alpha, -0.4, 0.4) * smoothstep(8, 30, fwd);
    addForceAt(0, stabLift, 0, 0, 0, cfg.stabArmM);
    // Aerodynamic rate damping of the airframe itself (small next to the rotor's).
    M.x -= w.x * 2500 * (1 + fwd * 0.05);
    M.y -= w.y * 9000 * (1 + fwd * 0.08);
    M.z -= w.z * 1500;

    // ---- gear: spring-damper wheels, rolling fore-aft, gripping sideways
    let onGround = false;
    for (const [wx, wy, wz] of cfg.wheels) {
      const pw = q.rotate(scratch.w.set(wx, wy, wz)).add(this.position);
      const g = groundAt(pw.x, pw.z);
      const pen = g - pw.y;
      if (pen <= 0) continue;
      onGround = true;
      // Velocity of the wheel: v + ω × r (world), into body axes.
      const rw = scratch.t.set(wx, wy, wz);
      const vwx = vb.x + (w.y * rw.z - w.z * rw.y);
      const vwy = vb.y + (w.z * rw.x - w.x * rw.z);
      const vwz = vb.z + (w.x * rw.y - w.y * rw.x);
      const up = q.unrotate(scratch.r.set(0, 1, 0));
      const vUp = vwx * up.x + vwy * up.y + vwz * up.z;
      const N = Math.max(0, cfg.gearStiffnessNm * pen - cfg.gearDampingNsM * vUp);
      if (pen > 0.6 || (vUp < -6 && pen > 0.05)) this.crash();
      const grip = (v: number, mu2: number): number => -mu2 * N * clamp(v / 0.4, -1, 1);
      const roll = input.brake ? 0.6 : 0.06;
      addForceAt(up.x * N + grip(vwx, 0.7), up.y * N, up.z * N + grip(vwz, roll), wx, wy, wz);
      if (!this.wasOnGround) this.touchdownSinkMs = -this.velocity.y;
    }
    this.onGround = onGround;
    this.wasOnGround = onGround;
    // Rotor strike: the disc edge below the surface.
    for (const [dx, dz] of [
      [R, 0],
      [-R, 0],
      [0, -R],
    ] as const) {
      const p = q.rotate(scratch.w.set(dx, rc.hubHeightM, dz)).add(this.position);
      if (p.y < groundAt(p.x, p.z) && r.omegaRadS > 5) this.crash();
    }

    // ---- integrate: forces to world, gravity, Euler's rigid-body equations for the rates
    const Fw = q.rotate(F);
    this.velocity.x += (Fw.x / m) * h;
    this.velocity.y += (Fw.y / m - PHYSICS.gravityMs2) * h;
    this.velocity.z += (Fw.z / m) * h;
    this.position.addScaled(this.velocity, h);
    const [Ix, Iy, Iz] = cfg.inertiaKgM2;
    const gx = (Iz - Iy) * w.y * w.z;
    const gy = (Ix - Iz) * w.z * w.x;
    const gz = (Iy - Ix) * w.x * w.y;
    w.x += ((M.x - gx) / Ix) * h;
    w.y += ((M.y - gy) / Iy) * h;
    w.z += ((M.z - gz) / Iz) * h;
    q.integrateBodyRate(w.x, w.y, w.z, h);

    this.vibration = clamp(Math.max(rbs, vrs, 0.25 * r.translational * (1 - r.translational) * 4 * 0.5), 0, 1);
  }

  crash(): void {
    this.crashed = true;
    this.velocity.set(0, 0, 0);
    this.angular.set(0, 0, 0);
  }
}
