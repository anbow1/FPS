import { describe, expect, it } from 'vitest';
import { tiltAngles, tiltStick, toScreen } from '../src/ui/tilt.ts';

// Tilt steering maths, without a phone: build the up vector in screen axes for a pose, check the stick.

const DEG = Math.PI / 180;
/** Up vector (screen axes) for a phone tilted back by `backDeg` and turned like a wheel by `wheelDeg` (right down +). */
function pose(backDeg: number, wheelDeg: number): { x: number; y: number; z: number } {
  const b = backDeg * DEG;
  const w = wheelDeg * DEG;
  return { x: -Math.sin(w) * Math.cos(b) * 9.81, y: Math.cos(w) * Math.cos(b) * 9.81, z: Math.sin(b) * 9.81 };
}

describe('tilt steering', () => {
  it('maps device axes to the landscape screen', () => {
    // Landscape, top of the phone to the left (angle 90): the device's right edge points up.
    expect(toScreen({ x: 9.81, y: 0, z: 0 }, 90).y).toBeCloseTo(9.81);
    // Landscape the other way (270): the device's left edge points up.
    expect(toScreen({ x: -9.81, y: 0, z: 0 }, 270).y).toBeCloseTo(9.81);
  });

  it('is neutral where calibrated and steers like a yoke from there', () => {
    const neutral = tiltAngles(pose(40, 0));
    expect(tiltStick(tiltAngles(pose(40, 0)), neutral)).toEqual({ x: 0, y: 0 });
    // Right side down: roll right.
    expect(tiltStick(tiltAngles(pose(40, 15)), neutral).x).toBeGreaterThan(0.3);
    expect(tiltStick(tiltAngles(pose(40, -15)), neutral).x).toBeLessThan(-0.3);
    // Top edge towards you (less tilted back): pull; away: push.
    expect(tiltStick(tiltAngles(pose(25, 0)), neutral).y).toBeGreaterThan(0.3);
    expect(tiltStick(tiltAngles(pose(55, 0)), neutral).y).toBeLessThan(-0.3);
    // A tremor inside the dead zone does nothing; full tilt saturates.
    expect(tiltStick(tiltAngles(pose(41, 1)), neutral)).toEqual({ x: 0, y: 0 });
    expect(tiltStick(tiltAngles(pose(40, 60)), neutral).x).toBe(1);
  });

  it('keeps the wheel and the lean apart', () => {
    // Turning the wheel does not move the nose.
    const neutral = tiltAngles(pose(40, 0));
    expect(tiltStick(tiltAngles(pose(40, 25)), neutral).y).toBe(0);
    // And the same turn gives the same roll however far back the phone leans.
    for (const back of [15, 40, 65]) {
      const n = tiltAngles(pose(back, 0));
      expect(tiltStick(tiltAngles(pose(back, 15)), n).x).toBeCloseTo(tiltStick(tiltAngles(pose(40, 15)), neutral).x, 5);
    }
  });
});
