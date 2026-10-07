import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat.ts';
import { Vec3 } from '../src/core/vec.ts';
import { AIRCRAFT } from '../src/config.ts';
import { RADAR, Radar, type RadarBody, WarningReceiver } from '../src/sim/radar.ts';

const flat = (): number => 0;

/** A body at (x, y, z) heading `yawRad` (0 = north, −z) at `speed`. */
function body(id: number, x: number, y: number, z: number, yawRad: number, speed: number, kind: 'wraith' | 'talon'): RadarBody {
  const q = new Quat().setFromYawPitchRoll(yawRad, 0, 0);
  const v = q.rotate(new Vec3(0, 0, -speed));
  return { id, position: new Vec3(x, y, z), velocity: v, orientation: q, signatureFront: AIRCRAFT[kind].signatureFront, signatureSide: AIRCRAFT[kind].signatureSide, alive: true };
}

/** Runs a radar at the origin, pointing north at 6 km, for `seconds`; returns whether it held a contact. */
function detects(target: RadarBody, seconds = 6, ownY = 6000): boolean {
  const r = new Radar(RADAR.talon);
  const own = new Vec3(0, ownY, 0);
  const rot = new Quat().setFromYawPitchRoll(0, 0, 0);
  const vel = new Vec3(0, 0, -250);
  // Aim the antenna at the target's elevation, as a pilot would.
  r.antennaElRad = Math.atan2(target.position.y - ownY, Math.hypot(target.position.x, target.position.z));
  for (let t = 0; t < seconds; t += 1 / 60) r.step(1 / 60, t, own, vel, rot, [target], flat);
  return r.contacts.has(target.id);
}

describe('radar', () => {
  it('sees the stealth type nose-on much later than from the side', () => {
    // Nose-on: the target flies south towards the radar.
    expect(detects(body(1, 0, 6000, -60_000, Math.PI, 250, 'wraith'))).toBe(false);
    expect(detects(body(1, 0, 6000, -25_000, Math.PI, 250, 'wraith'))).toBe(true);
    // Side-on at 60 km: seen.
    expect(detects(body(1, 0, 6000, -60_000, Math.PI / 2, 250, 'wraith'))).toBe(true);
    // A conventional fighter nose-on at 60 km: seen.
    expect(detects(body(1, 0, 6000, -60_000, Math.PI, 250, 'talon'))).toBe(true);
  });

  it('loses a target that notches against the ground, not one above the horizon', () => {
    // Crossing at right angles, 1000 m below the radar's altitude: notched.
    expect(detects(body(2, 0, 1000, -20_000, Math.PI / 2, 250, 'talon'))).toBe(false);
    // Same crossing, but above the radar (sky behind): seen.
    expect(detects(body(2, 0, 9000, -20_000, Math.PI / 2, 250, 'talon'))).toBe(true);
  });

  it('cannot see through a ridge', () => {
    const ridge = (_x: number, z: number): number => (z < -9000 && z > -11_000 ? 3000 : 0);
    const r = new Radar(RADAR.talon);
    const target = body(3, 0, 500, -20_000, Math.PI, 200, 'talon');
    for (let t = 0; t < 6; t += 1 / 60) r.step(1 / 60, t, new Vec3(0, 600, 0), new Vec3(0, 0, -200), new Quat(), [target], ridge);
    expect(r.contacts.size).toBe(0);
  });

  it('locks after its acquisition time and drops the lock when the target leaves the gimbal', () => {
    const r = new Radar(RADAR.talon);
    const own = new Vec3(0, 6000, 0);
    const rot = new Quat();
    const vel = new Vec3(0, 0, -250);
    const target = body(4, 0, 6000, -30_000, Math.PI, 250, 'talon');
    let t = 0;
    for (; t < 3; t += 1 / 60) r.step(1 / 60, t, own, vel, rot, [target], flat);
    r.designate();
    expect(r.mode).toBe('stt');
    for (let k = 0; k < 60; k++, t += 1 / 60) r.step(1 / 60, t, own, vel, rot, [target], flat);
    expect(r.locked).toBe(false);
    for (let k = 0; k < 40; k++, t += 1 / 60) r.step(1 / 60, t, own, vel, rot, [target], flat);
    expect(r.locked).toBe(true);
    // The radar's own aircraft turns its tail to the target.
    rot.setFromYawPitchRoll(Math.PI, 0, 0);
    for (let k = 0; k < 120; k++, t += 1 / 60) r.step(1 / 60, t, own, vel, rot, [target], flat);
    expect(r.locked).toBe(false);
  });

  it('warns of a track over a search from the same emitter', () => {
    const rwr = new WarningReceiver();
    const own = new Vec3();
    const rot = new Quat();
    rwr.paint(9, 'search', new Vec3(1000, 0, 0), own, rot, 0);
    expect(rwr.worst).toBe('search');
    expect(rwr.threats.get(9)!.bearingRad).toBeCloseTo(Math.PI / 2, 3);
    rwr.paint(9, 'track', new Vec3(1000, 0, 0), own, rot, 1);
    expect(rwr.worst).toBe('track');
    rwr.step(3);
    expect(rwr.worst).toBe(null);
  });
});
