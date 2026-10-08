import { describe, expect, it } from 'vitest';
import { PilotControls } from '../src/app/pilot.ts';
import type { Action, Input } from '../src/core/input.ts';

// The keyboard layout as the player reads it: W nose down, A/D turn, Q/E
// rotate, Shift/Ctrl climb/descend with the height held in between.

function fakeKeys(): { input: Input; down: Set<Action>; tap: Set<Action> } {
  const down = new Set<Action>();
  const tap = new Set<Action>();
  const input = {
    held: (a: Action) => down.has(a),
    pressed: (a: Action) => tap.has(a),
    takeMouseDelta: (out: { dx: number; dy: number }) => {
      out.dx = 0;
      out.dy = 0;
    },
  } as unknown as Input;
  return { input, down, tap };
}

function run(p: PilotControls, seconds: number, speedMs = 0): void {
  for (let t = 0; t < seconds; t += 1 / 60) p.update(1 / 60, speedMs);
}

describe('pilot keys', () => {
  it('pushes the nose down on W whatever the thumb-stick setting', () => {
    for (const invert of [false, true]) {
      const k = fakeKeys();
      const p = new PilotControls(k.input);
      p.invertPitch = invert;
      k.down.add('pitchDown');
      run(p, 1);
      expect(p.input.cyclicY).toBeLessThan(-0.9);
    }
  });

  it('turns on A: mostly a yaw in a hover, a bank at speed', () => {
    const k = fakeKeys();
    const p = new PilotControls(k.input);
    k.down.add('rollLeft');
    run(p, 1, 0);
    expect(p.input.pedal).toBeLessThan(-0.6);
    expect(Math.abs(p.input.cyclicX)).toBeLessThan(0.4);
    run(p, 1, 40);
    expect(Math.abs(p.input.pedal)).toBeLessThan(0.05);
    expect(p.input.cyclicX).toBeLessThan(-0.9);
  });

  it('gives the lever three levels with SAS: climb, hold, descend', () => {
    const k = fakeKeys();
    const p = new PilotControls(k.input);
    p.resetTrim(0);
    run(p, 0.1);
    expect(p.input.collective).toBe(0.5);
    k.down.add('collectiveUp');
    run(p, 0.1);
    expect(p.input.collective).toBe(1);
    k.down.delete('collectiveUp');
    run(p, 0.1);
    expect(p.input.collective).toBe(0.5);
    k.down.add('collectiveDown');
    run(p, 0.1);
    expect(p.input.collective).toBe(0);
  });
});
