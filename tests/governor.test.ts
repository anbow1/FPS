import { describe, expect, it } from 'vitest';
import { FrameGovernor } from '../src/render/governor';
import type { Pipeline } from '../src/render/pipeline';

function fake() {
  const p = { aoAllowed: true, renderScale: 1, changes: 0, setRenderScale(s: number) { if (s !== this.renderScale) this.changes++; this.renderScale = s; } };
  const gov = new FrameGovernor(p as unknown as Pipeline, () => {});
  const run = (fps: number, seconds: number) => { for (let t = 0; t < seconds; t += 1 / fps) gov.update(1 / fps); };
  return { p, gov, run };
}

describe('frame governor', () => {
  it('leaves a 60 fps game alone', () => {
    const { p, gov, run } = fake();
    run(60, 60);
    expect(gov.level).toBe(0);
    expect(p.aoAllowed).toBe(true);
    expect(p.renderScale).toBe(1);
  });

  it('drops AO first, then resolution, when frames are slow', () => {
    const { p, gov, run } = fake();
    run(40, 3.6);
    expect(gov.level).toBe(1);
    expect(p.aoAllowed).toBe(false);
    expect(p.renderScale).toBe(1);
    run(40, 20);
    expect(p.renderScale).toBeLessThan(1);
  });

  it('reacts to judder even when most frames are on time', () => {
    const { gov } = fake();
    // 35 % of frames take two vsync intervals
    for (let i = 0; i < 600; i++) gov.update(i % 20 < 7 ? 2 / 60 : 1 / 60);
    expect(gov.level).toBeGreaterThan(0);
  });

  it('ignores a single hitch', () => {
    const { gov } = fake();
    for (let i = 0; i < 600; i++) gov.update(i === 300 ? 0.2 : 1 / 60);
    expect(gov.level).toBe(0);
  });

  it('recovers when the load goes away, without oscillating', () => {
    const { p, gov, run } = fake();
    run(40, 10);
    const low = gov.level;
    expect(low).toBeGreaterThan(1);
    run(60, 120);
    expect(gov.level).toBeLessThan(low);
    // a device that can only just hold a level must not bounce between two
    const before = p.changes;
    for (let k = 0; k < 20; k++) {
      run(gov.level === 0 ? 45 : 60, 6);
    }
    expect(p.changes - before).toBeLessThan(8);
  });
});
