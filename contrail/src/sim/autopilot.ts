import { Vec3 } from '../core/vec.ts';
import type { Aircraft } from './aircraft.ts';
import type { PilotInput } from './controlLaws.ts';

// A flight director for the AI: turns "fly that way, at this speed, pulling up
// to this much G" into stick, pedals and throttle for the same control laws the
// player flies through — so the AI has exactly the player's aircraft, never
// more (brief: "no cheating on thrust or turn rate").
//
// It builds the acceleration it wants (towards the desired direction, plus 1 G
// against gravity), rolls the lift vector onto it, and pulls the load factor it
// needs once the lift vector is close; throttle holds the commanded speed, with
// reheat when far below it.

const GRAVITY = 9.81;

export interface SteerCommand {
  /** World direction to fly towards (need not be normalised). */
  direction: Vec3;
  /** Wanted true airspeed (m/s). */
  speedMs: number;
  /** Load-factor ceiling for this manoeuvre (G). */
  maxG: number;
  /** How hard to turn towards the direction: turn rate per radian of error (1/s). */
  gain?: number;
}

const tmpFwd = new Vec3();
const tmpUp = new Vec3();
const tmpRight = new Vec3();
const tmpWant = new Vec3();

export function steer(ac: Aircraft, cmd: SteerCommand, out: PilotInput): PilotInput {
  const v = Math.max(ac.speedMs, 50);
  const vel = ac.velocity.clone().normalize();
  const dir = cmd.direction.clone().normalize();
  // Wanted acceleration across the flight path: turn towards the direction at a rate ∝ the angle.
  const angle = Math.acos(Math.max(-1, Math.min(1, vel.dot(dir))));
  const across = dir.clone().addScaled(vel, -vel.dot(dir));
  if (across.length() < 1e-4) {
    // Straight behind: pick the lift vector's current side so the turn starts at once.
    across.copy(ac.orientation.rotate(tmpUp.set(0, 1, 0)));
  }
  across.normalize();
  const turnRate = Math.min(angle * (cmd.gain ?? 1.6), 1.2);
  tmpWant.copy(across).scale(turnRate * v);
  // Plus 1 G up to hold the flight path against gravity.
  tmpWant.y += GRAVITY;
  // Load factor wanted, and the lift direction (perpendicular to the velocity).
  tmpWant.addScaled(vel, -tmpWant.dot(vel));
  const gWanted = Math.min(cmd.maxG, tmpWant.length() / GRAVITY);
  const liftDir = tmpWant.normalize();
  // Body axes.
  ac.orientation.rotate(tmpFwd.set(0, 0, -1));
  ac.orientation.rotate(tmpUp.set(0, 1, 0));
  ac.orientation.rotate(tmpRight.set(1, 0, 0));
  // Roll error: the lift direction's angle around the nose from the body up axis.
  const rollErr = Math.atan2(liftDir.dot(tmpRight), liftDir.dot(tmpUp));
  out.roll = Math.max(-1, Math.min(1, rollErr * 2.2));
  // Pull only as the lift vector comes round; push to a gentle 0.5 G if it is upside down.
  const aligned = Math.cos(Math.min(Math.abs(rollErr), Math.PI / 2));
  const g = Math.abs(rollErr) > Math.PI / 2 ? 0.5 : 1 + (gWanted - 1) * aligned;
  const gMax = ac.cfg.limiter.gMax;
  const gMin = ac.cfg.limiter.gMin;
  out.pitch = g >= 1 ? Math.min(1, (g - 1) / (gMax - 1)) : Math.max(-1, (g - 1) / (1 - gMin));
  out.yaw = 0;
  // Throttle: proportional on the speed error, reheat when well below.
  const err = cmd.speedMs - ac.speedMs;
  out.throttle = Math.max(0.25, Math.min(1.25, 0.78 + err * 0.012));
  out.limiterRelaxed = false;
  out.brake = false;
  return out;
}
