import { describe, expect, it } from 'vitest';
import { FrameGovernor } from '../src/render/perf.ts';

interface Step {
  shafts: boolean;
  scale: number;
}
const STEPS: Step[] = [
  { shafts: true, scale: 1 },
  { shafts: false, scale: 1 },
  { shafts: false, scale: 0.87 },
  { shafts: false, scale: 0.76 },
  { shafts: false, scale: 0.67 },
  { shafts: false, scale: 0.58 },
];

/** A device whose frame time is `baseMs` at full quality and scales with the pixel count below it. */
function device(baseMs: number, floorMs = 0) {
  let changes = 0;
  let current = STEPS[0] as Step;
  const gov = new FrameGovernor(STEPS, (s) => {
    changes++;
    current = s;
  });
  const frameMs = (): number => Math.max(floorMs, baseMs * (current.shafts ? 1 : 0.9) * current.scale * current.scale);
  const run = (seconds: number): void => {
    for (let t = 0; t < seconds; ) {
      const dt = frameMs() / 1000;
      gov.update(dt);
      t += dt;
    }
  };
  return { gov, run, changes: () => changes, step: () => current };
}

describe('frame governor', () => {
  it('leaves a 60 fps game alone', () => {
    const d = device(15);
    d.run(60);
    expect(d.gov.level).toBe(0);
    expect(d.changes()).toBe(0);
  });

  it('drops the shafts first, then resolution, when frames are slow', () => {
    const d = device(25);
    d.run(3.6);
    expect(d.step()).toEqual({ shafts: false, scale: 1 });
    d.run(30);
    expect(d.step().scale).toBeLessThan(1);
    expect(d.gov.level).toBeLessThan(STEPS.length - 1);
  });

  it('reacts to judder even when most frames are on time', () => {
    let deepest = 0;
    const gov = new FrameGovernor(STEPS, (_s, level) => {
      deepest = Math.max(deepest, level);
    });
    // 35 % of frames take two vsync intervals. It must try to help; since this judder does not
    // respond to image quality, it is then allowed to give the quality back.
    for (let i = 0; i < 600; i++) gov.update(i % 20 < 7 ? 2 / 60 : 1 / 60);
    expect(deepest).toBeGreaterThan(0);
  });

  it('ignores a single hitch', () => {
    const gov = new FrameGovernor(STEPS, () => {});
    for (let i = 0; i < 600; i++) gov.update(i === 300 ? 0.2 : 1 / 60);
    expect(gov.level).toBe(0);
  });

  it('undoes a step that bought nothing (a display capped at 30 Hz)', () => {
    const d = device(10, 33.3);
    d.run(20);
    // It may try once, but must come back to full quality and stay there.
    expect(d.gov.level).toBe(0);
    const before = d.changes();
    d.run(40);
    expect(d.changes() - before).toBe(0);
  });

  it('recovers when the load goes away, without oscillating', () => {
    let load = 30;
    let changes = 0;
    let current = STEPS[0] as Step;
    const gov = new FrameGovernor(STEPS, (s) => {
      changes++;
      current = s;
    });
    const run = (seconds: number): void => {
      for (let t = 0; t < seconds; ) {
        const dt = (load * current.scale * current.scale) / 1000;
        gov.update(dt);
        t += dt;
      }
    };
    run(15);
    const low = gov.level;
    expect(low).toBeGreaterThan(1);
    load = 12;
    run(120);
    expect(gov.level).toBeLessThan(low);
    // A device that can only just hold a level must not bounce between two.
    load = 17.5;
    const before = changes;
    run(120);
    expect(changes - before).toBeLessThan(8);
  });

  it('stays at full quality while disabled', () => {
    const d = device(40);
    d.gov.enabled = false;
    d.run(20);
    expect(d.gov.level).toBe(0);
  });
});
